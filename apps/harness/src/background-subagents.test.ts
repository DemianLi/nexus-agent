/**
 * 背景子代理的拉起載體（[#829](https://github.com/DemianLi/nexus-agent/issues/829)）。
 *
 * 兩層：
 *
 * - **假 agent**：排程（各自串行、彼此並行）、`configurable` 只有明確的鍵、載體的環境不跟呼叫端走、日誌上的輪次、
 *   `enter` 的接法、錯誤邊界。這些不需要模型。
 * - **真組裝＋假模型**：第二輪看得到第一輪、root 按停止背景照跑完、工具本體拋錯不漏 rejection（v3 串流的孤兒 promise）。
 *   探針 `subagent-background-probe.test.ts` 量過的那幾條，這裡翻成對產品出口的正面驗收。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry } from '@nexus/core';
import {
  BACKGROUND_SESSION_CONFIG_KEY,
  SessionRegistry,
  TURN_CANCEL_CONFIG_KEY,
} from '@nexus/core';
import { SandboxModeController } from '@nexus/plugin-sandbox-policy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { BackgroundSubagentHost } from './background-subagents.js';
import type { BackgroundAgent } from './background-subagents.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const OVERLOADED = 'Service temporarily overloaded';

let unhandled: unknown[] = [];
const recordUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
beforeEach(() => {
  unhandled = [];
  process.on('unhandledRejection', recordUnhandled);
});
afterEach(() => {
  process.off('unhandledRejection', recordUnhandled);
});

/** 未處理的 rejection 在 microtask 排空之後才報，等一拍再數。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

/** 一顆手動開的閘門。 */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

const types = (log: { readonly events: readonly { readonly type: string }[] }) =>
  log.events.map((event) => event.type).filter((type) => type.startsWith('turn/'));

// ───────────────────────────── 假 agent ─────────────────────────────

describe('載體本身（假 agent）', () => {
  const als = new AsyncLocalStorage<{ readonly from: string }>();

  /** 假 agent：記下每一輪的 configurable 與當下的 ALS，再交給腳本。 */
  function fakeAgent(script: (text: string) => Promise<void> | void = () => undefined) {
    const seen: { configurable: Record<string, unknown>; store: unknown; text: string }[] = [];
    const agent: BackgroundAgent = {
      async streamEvents(input, config) {
        const text = String(
          (input as { messages: { content: unknown }[] }).messages.at(-1)?.content,
        );
        seen.push({ configurable: { ...config.configurable }, store: als.getStore(), text });
        await script(text);
        return (async function* () {})() as never;
      },
    };
    return { agent, seen };
  }

  function make(agentFor: (subagent: string) => BackgroundAgent, maxActive?: number) {
    const sessions = new SessionRegistry('root-1');
    const host = new BackgroundSubagentHost({
      sessions,
      compile: agentFor,
      ...(maxActive !== undefined && { maxActive }),
    });
    return { sessions, host };
  }

  it('configurable 只有明確的鍵：thread_id 是子代理自己的日誌 id，加上身分鍵，沒有 root 的中止訊號', async () => {
    const { agent, seen } = fakeAgent();
    const { host } = make(() => agent);
    expect(await host.submit({ runId: 'bg-1', subagent: 'worker', text: '第一句' })).toEqual({
      ok: true,
    });
    expect(seen[0]?.configurable).toEqual({
      thread_id: 'root-1/bg-1',
      [BACKGROUND_SESSION_CONFIG_KEY]: 'bg-1',
      // 這一輪自己的中止訊號（`interrupt` 舉的那個，#838），不是 root 的。
      [TURN_CANCEL_CONFIG_KEY]: expect.any(AbortSignal),
    });
    await host.close();
  });

  it('載體的環境不跟呼叫端走：在別人的 ALS 環境裡 submit，被拉起的那一輪看不到它', async () => {
    const { agent, seen } = fakeAgent();
    const { host } = make(() => agent);
    await als.run({ from: 'root 的工具呼叫' }, () =>
      host.submit({ runId: 'bg-1', subagent: 'worker', text: '第一句' }),
    );
    expect(seen[0]?.store).toBeUndefined();
    await host.close();
  });

  it('對照組：載體若是在別人的環境裡建的，環境就漏進每一輪——所以它必須在組裝點建', async () => {
    const { agent, seen } = fakeAgent();
    const built = als.run({ from: '建構時的環境' }, () => make(() => agent));
    await built.host.submit({ runId: 'bg-1', subagent: 'worker', text: '第一句' });
    expect(seen[0]?.store).toEqual({ from: '建構時的環境' });
    await built.host.close();
  });

  it('日誌：輪次成對寫在子代理自己的日誌，root 的日誌沒有', async () => {
    const { agent } = fakeAgent();
    const { host, sessions } = make(() => agent);
    await host.submit({ runId: 'bg-1', subagent: 'worker', text: '第一句' });
    await host.submit({ runId: 'bg-1', subagent: 'worker', text: '第二句' });
    const log = sessions.get({ kind: 'subagent', runId: 'bg-1' });
    expect(log?.sessionId).toBe('root-1/bg-1');
    expect(types(log!)).toEqual(['turn/start', 'turn/end', 'turn/start', 'turn/end']);
    expect(
      log!.events.filter((event) => event.type === 'turn/start').map((event) => event.data),
    ).toEqual([
      { kind: 'message', text: '第一句' },
      { kind: 'message', text: '第二句' },
    ]);
    expect(types(sessions.root)).toEqual([]);
    await host.close();
  });

  it('同一個背景子代理一次一輪、後到的排隊；不同的彼此並行', async () => {
    const holdA = gate();
    const started: string[] = [];
    const { agent } = fakeAgent(async (text) => {
      started.push(text);
      if (text === 'A1') await holdA.opened;
    });
    const { host } = make(() => agent);
    const a1 = host.submit({ runId: 'a', subagent: 'worker', text: 'A1' });
    const a2 = host.submit({ runId: 'a', subagent: 'worker', text: 'A2' });
    const b1 = host.submit({ runId: 'b', subagent: 'worker', text: 'B1' });
    await b1;
    // a 的第一輪還卡著：b 已經跑完，a 的第二輪還沒開始。
    expect(started).toEqual(['A1', 'B1']);
    holdA.open();
    await Promise.all([a1, a2]);
    expect(started).toEqual(['A1', 'B1', 'A2']);
    await host.close();
  });

  it('串流拋錯與迭代中途拋錯都記成 turn/failed，下場是回傳值、不 reject、不漏 rejection', async () => {
    const midStream: BackgroundAgent = {
      async streamEvents() {
        return (async function* () {
          yield 1;
          throw new Error('串流中途炸了');
        })() as never;
      },
    };
    const atOpen: BackgroundAgent = {
      streamEvents: () => Promise.reject(new Error(OVERLOADED)),
    };
    const { host, sessions } = make((name) => (name === 'mid' ? midStream : atOpen));
    expect(await host.submit({ runId: 'm', subagent: 'mid', text: '句' })).toEqual({
      ok: false,
      error: '串流中途炸了',
    });
    expect(await host.submit({ runId: 'o', subagent: 'open', text: '句' })).toEqual({
      ok: false,
      error: OVERLOADED,
    });
    const failed = (runId: string) =>
      sessions
        .get({ kind: 'subagent', runId })!
        .events.filter((event) => event.type === 'turn/failed')
        .map((event) => event.data);
    expect(failed('m')).toEqual([{ message: '串流中途炸了' }]);
    expect(failed('o')).toEqual([{ message: OVERLOADED }]);
    // 失敗的一輪不會卡住同一個子代理的下一輪。
    expect(await host.submit({ runId: 'o', subagent: 'open', text: '再一句' })).toMatchObject({
      ok: false,
    });
    await settle();
    expect(unhandled.map(String)).toEqual([]);
    await host.close();
  });

  it('編圖失敗（例如 profile 會動子代理的組成）也是這一輪的失敗，不往外拋', async () => {
    const { host, sessions } = make(() => {
      throw new Error('這個模型的 harness profile 會動子代理的組成');
    });
    expect(await host.submit({ runId: 'bg-1', subagent: 'worker', text: '句' })).toEqual({
      ok: false,
      error: '這個模型的 harness profile 會動子代理的組成',
    });
    expect(types(sessions.get({ kind: 'subagent', runId: 'bg-1' })!)).toEqual([
      'turn/start',
      'turn/failed',
    ]);
    await host.close();
  });

  it('enter 拿到的是這個子代理自己的日誌，整輪在它裡面跑；它拋錯就是這一輪失敗、圖沒被叫', async () => {
    const { agent, seen } = fakeAgent();
    const entered: string[] = [];
    const sessions = new SessionRegistry('root-1');
    const host = new BackgroundSubagentHost({
      sessions,
      compile: () => agent,
      enter: (log, run) => {
        entered.push(log.sessionId);
        if (log.sessionId.endsWith('/refused')) throw new Error('日誌上沒有委派那一格');
        return als.run({ from: 'enter' }, run);
      },
    });
    await host.submit({ runId: 'bg-1', subagent: 'worker', text: '句' });
    expect(seen[0]?.store).toEqual({ from: 'enter' });
    expect(await host.submit({ runId: 'refused', subagent: 'worker', text: '句' })).toEqual({
      ok: false,
      error: '日誌上沒有委派那一格',
    });
    expect(entered).toEqual(['root-1/bg-1', 'root-1/refused']);
    expect(seen).toHaveLength(1);
    await host.close();
  });

  it('接上沙箱控制器的 delegateFromLog：被叫醒的那一輪讀到委派那一格，root 之後放寬也不變', async () => {
    const controller = new SandboxModeController('workspace-write');
    const sessions = new SessionRegistry('root-1');
    const modes: string[] = [];
    const agent: BackgroundAgent = {
      async streamEvents() {
        modes.push(controller.current);
        return (async function* () {})() as never;
      },
    };
    const host = new BackgroundSubagentHost({
      sessions,
      compile: () => agent,
      enter: (log, run) => controller.delegateFromLog(log, run),
    });
    // 委派那一刻由沙箱 plugin 記進子代理日誌（卡 5 接線）；這裡直接寫。
    sessions
      .open({ kind: 'subagent', runId: 'bg-1' })
      .append('sandbox/mode', { mode: 'read-only', source: 'delegation' });
    controller.switchTo('workspace-write');
    await host.submit({ runId: 'bg-1', subagent: 'worker', text: '第一句' });
    controller.switchTo('danger-full-access');
    await host.submit({ runId: 'bg-1', subagent: 'worker', text: '第二句' });
    expect(modes).toEqual(['read-only', 'read-only']);
    await host.close();
  });

  it('start：同步回編號並開好日誌（收件匣接受那一刻），編號不重複；編不出圖當場拋、不留日誌', async () => {
    const { agent } = fakeAgent();
    const { host, sessions } = make((name) => {
      if (name === 'missing') throw new Error('沒有 "missing" 這個子代理');
      return agent;
    });
    const first = host.start({ subagent: 'worker', text: '句' });
    // 同步：回來的當下日誌已經在，不必等迴圈。
    expect(first.runId).toMatch(/^bg-[0-9a-f]{12}$/);
    expect(sessions.get({ kind: 'subagent', runId: first.runId })).toBeDefined();
    const second = host.start({ subagent: 'worker', text: '句' });
    expect(second.runId).not.toBe(first.runId);
    expect(() => host.start({ subagent: 'missing', text: '句' })).toThrow('沒有 "missing"');
    expect(sessions.list()).toHaveLength(3); // root＋兩個
    expect(await first.outcome).toEqual({ ok: true });
    expect(await second.outcome).toEqual({ ok: true });
    await host.close();
    expect(() => host.start({ subagent: 'worker', text: '句' })).toThrow('已經關閉');
  });

  it('list：依派出先後列出每一個，跑著的是 running、其餘 inactive；別的 host 的不在裡面', async () => {
    const hold = gate();
    const { agent } = fakeAgent(async (text) => (text === '慢' ? hold.opened : undefined));
    const mine = make((name) => (name === 'other' ? fakeAgent().agent : agent));
    const theirs = make(() => agent);
    expect(mine.host.list()).toEqual([]);
    const slow = mine.host.start({ subagent: 'worker', text: '慢' });
    const quick = mine.host.start({ subagent: 'other', text: '快' });
    theirs.host.start({ subagent: 'worker', text: '別人的' });
    await quick.outcome;
    expect(mine.host.list()).toEqual([
      { runId: slow.runId, label: 'worker', status: 'running' },
      { runId: quick.runId, label: 'other', status: 'inactive' },
    ]);
    hold.open();
    await slow.outcome;
    expect(mine.host.list().map((row) => row.status)).toEqual(['inactive', 'inactive']);
    await Promise.all([mine.host.close(), theirs.host.close()]);
  });

  describe('interrupt（#838）', () => {
    /** 假 agent：腳本拿到這一輪的中止訊號，可以等它舉起來再收。 */
    function abortable(script: (text: string, signal: AbortSignal) => Promise<void> | void) {
      const agent: BackgroundAgent = {
        async streamEvents(input, config) {
          const text = String(
            (input as { messages: { content: unknown }[] }).messages.at(-1)?.content,
          );
          const signal = config.configurable?.[TURN_CANCEL_CONFIG_KEY] as AbortSignal;
          await script(text, signal);
          return (async function* () {})() as never;
        },
      };
      return agent;
    }
    const waitAbort = (signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });

    it('每一輪自己的中止訊號進 configurable；只舉那一輪的，收成 aborted/parent，不是 turn/failed', async () => {
      const entered = gate();
      const agent = abortable(async (text, signal) => {
        if (text === '慢') {
          entered.open();
          await waitAbort(signal);
        }
      });
      const { host, sessions } = make(() => agent);
      const slow = host.start({ subagent: 'worker', text: '慢' });
      const other = host.start({ subagent: 'worker', text: '快' });
      await entered.opened;
      expect(host.interrupt(slow.runId)).toBe(true);
      expect(await slow.outcome).toEqual({ ok: true });
      expect(await other.outcome).toEqual({ ok: true });
      const slowLog = sessions.get({ kind: 'subagent', runId: slow.runId })!;
      expect(slowLog.events.find((event) => event.type === 'turn/end')?.data).toEqual({
        reason: { kind: 'aborted', cause: { kind: 'parent' } },
      });
      // 別的子代理那一輪不受影響。
      const otherLog = sessions.get({ kind: 'subagent', runId: other.runId })!;
      expect(otherLog.events.find((event) => event.type === 'turn/end')?.data).toEqual({});
      await host.close();
    });

    it('不存在的、已結算的編號：被接受的 no-op（回 false），什麼都沒發生', async () => {
      const { agent } = fakeAgent();
      const { host, sessions } = make(() => agent);
      expect(host.interrupt('bg-nobody')).toBe(false);
      const done = host.start({ subagent: 'worker', text: '句' });
      await done.outcome;
      expect(host.interrupt(done.runId)).toBe(false);
      const log = sessions.get({ kind: 'subagent', runId: done.runId })!;
      expect(types(log)).toEqual(['turn/start', 'turn/end']);
      expect(log.events.find((event) => event.type === 'turn/end')?.data).toEqual({});
      await host.close();
    });

    it('排著還沒領走的輪次不丟：中斷之後暫停，下一次 submit 才恢復（排在前面的先跑）', async () => {
      const entered = gate();
      const order: string[] = [];
      const agent = abortable(async (text, signal) => {
        order.push(text);
        if (text === 'A1') {
          entered.open();
          await waitAbort(signal);
        }
      });
      const { host } = make(() => agent);
      const first = host.start({ subagent: 'worker', text: 'A1' });
      const queued = host.submit({ runId: first.runId, subagent: 'worker', text: 'A2' });
      await entered.opened;
      host.interrupt(first.runId);
      await first.outcome;
      await settle();
      // 暫停：A2 沒有被丟，也沒有開跑。
      expect(order).toEqual(['A1']);
      const resumed = host.submit({ runId: first.runId, subagent: 'worker', text: 'A3' });
      expect(await queued).toEqual({ ok: true });
      expect(await resumed).toEqual({ ok: true });
      expect(order).toEqual(['A1', 'A2', 'A3']);
      await host.close();
    });

    it('暫停中就關閉：排著的輪次當作沒跑成交出去，close() 不會永遠等', async () => {
      const entered = gate();
      const agent = abortable(async (text, signal) => {
        if (text === 'A1') {
          entered.open();
          await waitAbort(signal);
        }
      });
      const { host, sessions } = make(() => agent);
      const first = host.start({ subagent: 'worker', text: 'A1' });
      const queued = host.submit({ runId: first.runId, subagent: 'worker', text: 'A2' });
      await entered.opened;
      host.interrupt(first.runId);
      await first.outcome;
      await host.close();
      expect(await queued).toMatchObject({ ok: false });
      expect(types(sessions.get({ kind: 'subagent', runId: first.runId })!)).toEqual([
        'turn/start',
        'turn/end',
      ]);
    });

    it('root 按停止（root 的訊號）不連帶：configurable 裡的中止訊號是這一輪自己的，不是別人的', async () => {
      const signals: AbortSignal[] = [];
      const agent = abortable((_text, signal) => void signals.push(signal));
      const { host } = make(() => agent);
      const root = new AbortController();
      await als.run({ from: 'root' }, () =>
        host.submit({ runId: 'bg-1', subagent: 'worker', text: '句' }),
      );
      root.abort();
      expect(signals[0]?.aborted).toBe(false);
      await host.close();
    });
  });

  describe('send（#839）', () => {
    it('對閒著的子代理送話：開新的一輪，模型看到 dsh 的前綴，日誌是 agent-message（記寄件人）而不是 message', async () => {
      const { agent, seen } = fakeAgent();
      const { host, sessions } = make(() => agent);
      const first = host.start({ subagent: 'worker', text: '第一句' });
      await first.outcome;
      expect(await host.send({ runId: first.runId, message: '再查一下 B' })).toEqual({ ok: true });
      expect(seen.map((row) => row.text)).toEqual([
        '第一句',
        'Agent root-1 sent a message: 再查一下 B',
      ]);
      const log = sessions.get({ kind: 'subagent', runId: first.runId })!;
      expect(
        log.events.filter((event) => event.type === 'turn/start').map((event) => event.data),
      ).toEqual([
        { kind: 'message', text: '第一句' },
        {
          kind: 'agent-message',
          text: 'Agent root-1 sent a message: 再查一下 B',
          senderSessionId: 'root-1',
        },
      ]);
      expect(types(log)).toEqual(['turn/start', 'turn/end', 'turn/start', 'turn/end']);
      await host.close();
    });

    it('對正在跑的子代理送話：排成它的下一輪，不插進當下那一輪', async () => {
      const hold = gate();
      const order: string[] = [];
      const { agent } = fakeAgent(async (text) => {
        order.push(text);
        if (text === '第一句') await hold.opened;
      });
      const { host } = make(() => agent);
      const first = host.start({ subagent: 'worker', text: '第一句' });
      const sent = host.send({ runId: first.runId, message: '補一句' });
      await settle();
      expect(order).toEqual(['第一句']);
      hold.open();
      expect(await sent).toEqual({ ok: true });
      expect(order).toEqual(['第一句', 'Agent root-1 sent a message: 補一句']);
      await host.close();
    });

    it('沒有這個編號、host 已關閉：同步拋並說明原因，不寫任何日誌', async () => {
      const { agent } = fakeAgent();
      const { host, sessions } = make(() => agent);
      expect(() => host.send({ runId: 'bg-nobody', message: '喂' })).toThrow('沒有編號 bg-nobody');
      expect(sessions.list()).toHaveLength(1);
      const first = host.start({ subagent: 'worker', text: '句' });
      await first.outcome;
      await host.close();
      expect(() => host.send({ runId: first.runId, message: '喂' })).toThrow('已經關閉');
    });

    it('被中斷後暫停的佇列：送話喚醒它，排在前面的輪次先跑（#838 的恢復路徑）', async () => {
      const entered = gate();
      const order: string[] = [];
      const agent: BackgroundAgent = {
        async streamEvents(input, config) {
          const text = String(
            (input as { messages: { content: unknown }[] }).messages.at(-1)?.content,
          );
          order.push(text);
          const signal = config.configurable?.[TURN_CANCEL_CONFIG_KEY] as AbortSignal;
          if (text === 'A1') {
            entered.open();
            await new Promise<void>((resolve) =>
              signal.addEventListener('abort', () => resolve(), { once: true }),
            );
          }
          return (async function* () {})() as never;
        },
      };
      const { host } = make(() => agent);
      const first = host.start({ subagent: 'worker', text: 'A1' });
      const queued = host.submit({ runId: first.runId, subagent: 'worker', text: 'A2' });
      await entered.opened;
      host.interrupt(first.runId);
      await first.outcome;
      await settle();
      expect(order).toEqual(['A1']);
      const woke = host.send({ runId: first.runId, message: '接著做' });
      expect(await queued).toEqual({ ok: true });
      expect(await woke).toEqual({ ok: true });
      expect(order).toEqual(['A1', 'A2', 'Agent root-1 sent a message: 接著做']);
      await host.close();
    });

    it('已結算而名額滿了：同步拒絕（同並存上限）', async () => {
      const hold = gate();
      const { agent } = fakeAgent(async (text) => (text === '佔位' ? hold.opened : undefined));
      const { host } = make(() => agent, 1);
      const settled = host.start({ subagent: 'worker', text: '先做完' });
      await settled.outcome;
      const holder = host.start({ subagent: 'worker', text: '佔位' });
      expect(() => host.send({ runId: settled.runId, message: '再來' })).toThrow('並存上限 1');
      hold.open();
      await holder.outcome;
      await host.close();
    });
  });

  describe('並存上限（#836）', () => {
    it('預設 8：第 9 個被拒絕、指名上限與現況，而且沒有編號、沒有日誌；前 8 個不受影響', async () => {
      const hold = gate();
      const { agent } = fakeAgent(async () => hold.opened);
      const { host, sessions } = make(() => agent);
      const started = Array.from({ length: 8 }, () =>
        host.start({ subagent: 'worker', text: '句' }),
      );
      expect(() => host.start({ subagent: 'worker', text: '句' })).toThrow(
        '背景子代理已達並存上限 8（現在有 8 個在跑）',
      );
      expect(sessions.list()).toHaveLength(9); // root＋8
      hold.open();
      for (const one of started) expect(await one.outcome).toEqual({ ok: true });
      await host.close();
    });

    it('其中一個結算（跑完且沒有排著的輪次）就讓出名額；跑完之前不讓', async () => {
      const holds = [gate(), gate()];
      let n = 0;
      const { agent } = fakeAgent(async () => holds[n++]?.opened);
      const { host } = make(() => agent, 2);
      const first = host.start({ subagent: 'worker', text: 'A' });
      const second = host.start({ subagent: 'worker', text: 'B' });
      expect(() => host.start({ subagent: 'worker', text: 'C' })).toThrow('並存上限 2');
      holds[0]?.open();
      await first.outcome;
      const third = host.start({ subagent: 'worker', text: 'C' });
      expect(third.runId).not.toBe(first.runId);
      holds[1]?.open();
      await Promise.all([second.outcome, third.outcome]);
      await host.close();
    });

    it('已存活的再收一句話不佔新的一格（排在它後面的輪次），滿了也收得進去', async () => {
      const hold = gate();
      const { agent } = fakeAgent(async () => hold.opened);
      const { host } = make(() => agent, 1);
      const only = host.start({ subagent: 'worker', text: '第一句' });
      const followUp = host.submit({ runId: only.runId, subagent: 'worker', text: '第二句' });
      hold.open();
      expect(await only.outcome).toEqual({ ok: true });
      expect(await followUp).toEqual({ ok: true });
      await host.close();
    });

    it('已結算的編號再收一句話要重新佔一格：滿了就被拒絕（不拋、不寫 turn/start）', async () => {
      const hold = gate();
      const { agent } = fakeAgent(async (text) => (text === '佔位' ? hold.opened : undefined));
      const { host, sessions } = make(() => agent, 1);
      const settled = host.start({ subagent: 'worker', text: '先做完' });
      await settled.outcome;
      const holder = host.start({ subagent: 'worker', text: '佔位' });
      const refused = await host.submit({
        runId: settled.runId,
        subagent: 'worker',
        text: '再來',
      });
      expect(refused).toMatchObject({ ok: false });
      expect((refused as { error: string }).error).toContain('並存上限 1');
      const log = sessions.get({ kind: 'subagent', runId: settled.runId });
      expect(types(log!)).toEqual(['turn/start', 'turn/end']);
      hold.open();
      await holder.outcome;
      // 名額讓出來之後就收得進去。
      expect(await host.submit({ runId: settled.runId, subagent: 'worker', text: '再來' })).toEqual(
        { ok: true },
      );
      await host.close();
    });

    it('每個主對話各算各的：兩個 host（兩個 root）互不占用名額', async () => {
      const hold = gate();
      const { agent } = fakeAgent(async () => hold.opened);
      const a = make(() => agent, 1);
      const b = make(() => agent, 1);
      const inA = a.host.start({ subagent: 'worker', text: '句' });
      const inB = b.host.start({ subagent: 'worker', text: '句' });
      expect(() => a.host.start({ subagent: 'worker', text: '句' })).toThrow('並存上限 1');
      hold.open();
      await Promise.all([inA.outcome, inB.outcome]);
      await Promise.all([a.host.close(), b.host.close()]);
    });

    it('上限要是 ≥ 1 的整數', () => {
      for (const bad of [0, -1, 1.5, Number.NaN]) {
        expect(() => make(() => fakeAgent().agent, bad)).toThrow('≥ 1 的整數');
      }
    });
  });

  it('同一個編號不能換子代理；關閉之後不收新的輪，但排著的與進行中的會收完', async () => {
    const hold = gate();
    const { agent } = fakeAgent(async () => hold.opened);
    const { host, sessions } = make(() => agent);
    const first = host.submit({ runId: 'bg-1', subagent: 'worker', text: '句' });
    expect(await host.submit({ runId: 'bg-1', subagent: 'other', text: '句' })).toMatchObject({
      ok: false,
    });
    const closing = host.close();
    expect(await host.submit({ runId: 'bg-2', subagent: 'worker', text: '句' })).toMatchObject({
      ok: false,
    });
    hold.open();
    expect(await first).toEqual({ ok: true });
    await closing;
    expect(types(sessions.get({ kind: 'subagent', runId: 'bg-1' })!)).toEqual([
      'turn/start',
      'turn/end',
    ]);
    // 被拒的沒有留下日誌。
    expect(sessions.get({ kind: 'subagent', runId: 'bg-2' })).toBeUndefined();
  });
});

// ───────────────────────────── 真組裝 ─────────────────────────────

describe('產品組裝上的背景子代理', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexus-bg-host-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const call = (name: string, args: Record<string, unknown>): ScriptedTurn => ({
    content: '',
    toolCalls: [{ name, args }],
  });
  const toolTexts = (messages: readonly BaseMessage[]) =>
    messages.filter((message) => message.getType() === 'tool').map((message) => message.text);
  const humanTexts = (messages: readonly BaseMessage[]) =>
    messages.filter((message) => message.getType() === 'human').map((message) => message.text);

  interface Wiring {
    host?: BackgroundSubagentHost;
    /** worker 的 `look` 工具看到的 configurable。 */
    looked: Record<string, unknown>[];
    startedBg: ReturnType<typeof gate>;
    bgRelease: ReturnType<typeof gate>;
    rootHold: ReturnType<typeof gate>;
    outcome?: Promise<unknown>;
  }

  /** 真組裝：root 有 `spawn_bg`（在工具本體裡呼叫 host，卡 5 的形狀），worker 有幾顆探測用的工具。 */
  async function assemble(turns: readonly ScriptedTurn[]) {
    const wiring: Wiring = {
      looked: [],
      startedBg: gate(),
      bgRelease: gate(),
      rootHold: gate(),
    };
    const plugin: PluginEntry = {
      plugin: {
        name: 'bg-host-test',
        apply(registry) {
          registry.tools.register(
            tool(
              async ({ text, hold }) => {
                wiring.outcome = wiring.host!.submit({ runId: 'bg-1', subagent: 'worker', text });
                if (hold) {
                  await wiring.startedBg.opened;
                  await wiring.rootHold.opened;
                } else {
                  await wiring.outcome;
                }
                return '已派出 bg-1';
              },
              {
                name: 'spawn_bg',
                description: '派一輪背景的活。',
                schema: z.object({ text: z.string(), hold: z.boolean().optional() }),
              },
            ),
          );
          registry.subagents.register({
            name: 'worker',
            description: '幹活的。',
            systemPrompt: '幹活。',
            tools: [
              tool(
                (_input, config) => {
                  wiring.looked.push({ ...(config.configurable as Record<string, unknown>) });
                  return '看過了';
                },
                { name: 'look', description: '看一眼。', schema: z.object({}) },
              ),
              tool(
                async () => {
                  wiring.startedBg.open();
                  await wiring.bgRelease.opened;
                  return '背景放行';
                },
                { name: 'hold_bg', description: '停住。', schema: z.object({}) },
              ),
              tool(
                () => {
                  throw new Error('工具本體炸了');
                },
                { name: 'boom_bg', description: '一律拋錯。', schema: z.object({}) },
              ),
            ],
          });
        },
      },
    };
    const model = new ScriptedChatModel({ turns });
    const built = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      plugins: [plugin],
      backend: new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' }),
    });
    const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'bg-host');
    const detach = built.attachSession(pump.sessions);
    // **在任何圖的環境之外建**：組裝點。
    wiring.host = new BackgroundSubagentHost({
      sessions: pump.sessions,
      compile: (name) =>
        built.compileSubagent(name, new MemorySaver()) as unknown as BackgroundAgent,
    });
    return {
      ...wiring,
      /** 展開複本拿不到後來才設的欄位。 */
      get outcome() {
        return wiring.outcome;
      },
      model,
      pump,
      close: async () => {
        await wiring.host!.close();
        detach();
        await built.dispose();
      },
    };
  }

  it('由 root 的工具呼叫拉起：configurable 乾淨，位址是背景子代理，工具結果進它自己的日誌；第二輪看得到第一輪', async () => {
    const run = await assemble([
      call('spawn_bg', { text: '第一輪的話' }),
      call('look', {}),
      { content: '背景一號' },
      { content: '根收尾' },
      call('spawn_bg', { text: '第二輪的話' }),
      call('look', {}),
      { content: '背景二號' },
      { content: '根收尾二' },
    ]);
    try {
      await run.pump.submit({ kind: 'message', text: '派' });
      await run.pump.whenIdle();
      await run.pump.submit({ kind: 'message', text: '再送' });
      await run.pump.whenIdle();
      await run.host!.idle();

      expect(run.looked).toHaveLength(2);
      for (const seen of run.looked) {
        // root 的插話收件匣沒有進背景圖；中止訊號是這一輪自己的，每一輪一個（下面比對兩輪不是同一個）。
        expect(seen[TURN_CANCEL_CONFIG_KEY]).toBeInstanceOf(AbortSignal);
        expect(seen['nexus_step_inbox']).toBeUndefined();
        expect(seen[BACKGROUND_SESSION_CONFIG_KEY]).toBe('bg-1');
        // 最上層的圖，命名空間只有一段。
        expect(String(seen['checkpoint_ns']).includes('|')).toBe(false);
      }
      expect(run.looked[0]?.[TURN_CANCEL_CONFIG_KEY]).not.toBe(
        run.looked[1]?.[TURN_CANCEL_CONFIG_KEY],
      );
      // 第二輪的模型呼叫看得到第一輪的話。
      const backgroundPrompts = run.model.prompts
        .map(humanTexts)
        .filter((texts) => texts.some((text) => text.endsWith('的話') && text !== '派'));
      expect(backgroundPrompts.at(-1)).toEqual(['第一輪的話', '第二輪的話']);

      const sessions = run.pump.sessions.list();
      const background = sessions.find((session) => session.address.kind === 'subagent')!;
      expect(background.log.sessionId).toBe(`${run.pump.sessions.root.sessionId}/bg-1`);
      expect(types(background.log)).toEqual(['turn/start', 'turn/end', 'turn/start', 'turn/end']);
      const results = (log: typeof background.log) =>
        log.events.filter((event) => event.type === 'tool/result').length;
      expect(results(background.log)).toBe(2);
      expect(results(run.pump.sessions.root)).toBe(2); // root 自己的兩次 spawn_bg
    } finally {
      await run.close();
    }
  });

  it('root 按停止：root 那一輪中止收尾，背景那一輪不受影響、照跑完', async () => {
    const run = await assemble([
      call('spawn_bg', { text: '背景的活', hold: true }),
      call('hold_bg', {}),
      { content: '背景完成' },
      { content: '根收尾' },
    ]);
    try {
      const submitted = run.pump.submit({ kind: 'message', text: '派' });
      await run.startedBg.opened;
      const before = run.model.prompts.length;
      expect(run.pump.cancel()).toBe('run');
      run.bgRelease.open();
      await settleUntil(async () => (await outcomeOf(run)) !== undefined);
      run.rootHold.open();
      await submitted;
      await run.pump.whenIdle();

      expect(await run.outcome).toEqual({ ok: true });
      // 背景在 root 停止之後還被叫了一次模型，並收到工具放行的結果。
      expect(
        run.model.prompts.slice(before).some((prompt) => toolTexts(prompt).includes('背景放行')),
      ).toBe(true);
      const background = run.pump.sessions.list().find((s) => s.address.kind === 'subagent')!;
      expect(background.log.events.filter((event) => event.type === 'turn/end')).toEqual([
        expect.objectContaining({ data: {} }),
      ]);
      // root 的那一輪是被中止收尾的。
      const rootEnd = run.pump.sessions.root.events.findLast((event) => event.type === 'turn/end');
      expect(rootEnd?.data).toEqual({ reason: { kind: 'aborted', cause: { kind: 'user' } } });
      await settle();
      expect(unhandled.map(String)).toEqual([]);
    } finally {
      await run.close();
    }
  });

  for (const [label, bgTurns, expected] of [
    [
      '模型呼叫拋錯',
      [{ content: '', error: OVERLOADED }],
      { outcome: { ok: false, error: OVERLOADED }, lastTurnEvent: 'turn/failed' },
    ],
    [
      '工具本體拋錯',
      [call('boom_bg', {}), { content: '背景收到錯誤了' }],
      { outcome: { ok: true }, lastTurnEvent: 'turn/end' },
    ],
  ] as const) {
    it(`${label}：行程不死、沒有未處理的 rejection（v3 串流的孤兒 promise 有標成已處理），root 照收尾`, async () => {
      const run = await assemble([
        call('spawn_bg', { text: '背景的活' }),
        ...bgTurns,
        { content: '根收尾' },
      ]);
      try {
        await run.pump.submit({ kind: 'message', text: '派' });
        await run.pump.whenIdle();
        await run.host!.idle();
        await settle();
        expect(await run.outcome).toEqual(expected.outcome);
        const background = run.pump.sessions.list().find((s) => s.address.kind === 'subagent')!;
        expect(types(background.log).at(-1)).toBe(expected.lastTurnEvent);
        expect(run.pump.sessions.root.events.at(-1)?.type).toBe('turn/end');
        expect(unhandled.map(String)).toEqual([]);
      } finally {
        await run.close();
      }
    });
  }

  /** 等到條件成立。 */
  async function settleUntil(predicate: () => Promise<boolean>, ms = 5000): Promise<void> {
    const start = Date.now();
    while (!(await predicate())) {
      if (Date.now() - start > ms) throw new Error('等太久了');
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  /** 背景那一輪收了沒：它的日誌上有 `turn/end`。 */
  async function outcomeOf(run: Awaited<ReturnType<typeof assemble>>) {
    const log = run.pump.sessions.list().find((s) => s.address.kind === 'subagent')?.log;
    return log?.events.find((event) => event.type === 'turn/end');
  }
});
