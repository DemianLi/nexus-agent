/**
 * 背景子代理的冷復活，端到端（[#1271](https://github.com/DemianLi/nexus-agent/issues/1271)，缺口源自
 * [#737](https://github.com/DemianLi/nexus-agent/issues/737)）。
 *
 * **全走產品組裝**：`createNexusAgent`＋腳本模型＋`ThreadPump`＋`attachSession`＋真的 JSONL 存放處。第一個行程派兩個背景子代理、
 * 跑到 idle、整個收掉；第二個行程用**全新的** `MemorySaver` 與模型（存檔點不落盤，所以第二個行程的圖 state 是空的）從同一個目錄
 * 接回 root，再對舊編號送話。要證明的是：
 *
 * - 送話把冷的叫醒，它看得到重啟之前的對話（模型這一次收到的 prompt 以**重啟之前那一份為前綴**，工具結果逐字相同）；
 * - 列出與現況不復活任何一個，現況第一份就含叫得醒的（沒有先送空的）；
 * - 名額在重建之前佔：滿了拒絕、沒去握租約；
 * - 舊日誌沒有身分：不擋啟動，列出來附原因，送話回找不到並說明；
 * - 模型自己用 `send_message` 也叫得醒；
 * - 日誌往原檔續寫：`seq` 連續、`subagent/descriptor` 只有一顆、中間只有一顆 `session/end-seed`。
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NativeAgent } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BackgroundSubagentError } from './background-subagents.js';
import {
  ROOT,
  SEND_MESSAGE_TURN,
  boot,
  conversation,
  firstProcess,
  openStore,
  setupWorld,
  teardownWorld,
  until,
  world,
} from './background-cold.fixture.js';

beforeEach(setupWorld);
afterEach(teardownWorld);

describe('重啟之後送話叫醒背景子代理', () => {
  /**
   * native 明寫一遍（#2360）：沒有 checkpointer，叫醒的子代理只能從日誌灌回。`seedThread` 只收快取是空的 thread（不是空的就拋），
   * 所以「叫醒時呼叫了它、沒拋」就是「快取是空的、對話只從日誌來」；prompt 以重啟之前那一份為前綴，證明灌回的就是那一份。
   */
  it.each(['langgraph', 'native'] as const)(
    'wire 路徑（%s）：列出不復活、現況第一份就含叫得醒的、送話叫醒、看得到重啟之前的對話、日誌往原檔續寫',
    async (agentLoop) => {
      const { a, b } = await firstProcess(agentLoop);
      // 重啟之前那一份對話是真的有東西：任務、工具呼叫、工具結果、結語。
      expect(a.before.map((message) => message.type)).toEqual(['human', 'ai', 'tool']);

      const seeded = vi.spyOn(NativeAgent.prototype, 'seedThread');
      const second = await boot({
        rootTurns: [{ content: '根' }],
        turnsFor: (name) => [{ content: `${name} 醒來答覆` }],
        resume: true,
        agentLoop,
      });
      try {
        const background = second.detach.background!;
        // 還沒送話：沒有任何子代理的模型被叫過、子日誌沒有在註冊表上。
        expect(second.models['worker-a'].prompts).toEqual([]);
        expect(second.pump.sessions.get({ kind: 'subagent', runId: a.runId })).toBeUndefined();

        await background.sendFromUser(a.runId, '重啟後的話');
        await until(
          () =>
            second.pump.sessions
              .get({ kind: 'subagent', runId: a.runId })
              ?.events.filter((event) => event.type === 'turn/end').length === 2,
        );
        // 現況第一份就含兩個叫得醒的（掃完才送），舊版寫的那個不在裡面。
        expect(second.statuses[0]).toEqual([
          { runId: a.runId, status: 'idle' },
          { runId: b.runId, status: 'idle' },
        ]);
        // 看得到重啟之前的對話：以重啟之前那一份為前綴，工具結果逐字相同；後面接上新的一句。
        const prompt = conversation(second.models['worker-a'].lastPrompt);
        expect(prompt.slice(0, a.before.length)).toEqual(a.before);
        expect(prompt.slice(a.before.length).map((message) => message.type)).toEqual([
          'ai',
          'human',
        ]);
        expect(prompt.at(-1)).toEqual({ type: 'human', content: '重啟後的話' });
        // 另一個還是冷的，沒被碰。
        expect(second.models['worker-b'].prompts).toEqual([]);
        if (agentLoop === 'native') {
          const children = seeded.mock.calls.filter(([config]) =>
            String(config.configurable?.['thread_id']).includes(a.runId),
          );
          expect(children).toHaveLength(1);
          expect(seeded.mock.results.every((result) => result.type === 'return')).toBe(true);
        } else {
          expect(seeded).not.toHaveBeenCalled();
        }
        seeded.mockRestore();

        // 日誌往原檔續寫，seq 連續；身分只有一顆；中間只有一顆 end-seed；新的一輪接在後面。
        await second.shutdown();
        const store = openStore();
        const events = await (await store.open(`${ROOT}/${a.runId}`, 'read')).read();
        expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
        const types = events.map((event) => event.type);
        expect(types.filter((type) => type === 'subagent/descriptor')).toHaveLength(1);
        expect(types.filter((type) => type === 'session/end-seed')).toHaveLength(1);
        // 重啟之前的一輪在 end-seed 前面，重啟之後的一輪在後面。
        const seedAt = types.indexOf('session/end-seed');
        expect(types.slice(0, seedAt).filter((type) => type === 'turn/start')).toHaveLength(1);
        expect(types.slice(seedAt + 1).filter((type) => type === 'turn/start')).toHaveLength(1);
        expect(types.at(-1)).toBe('turn/end');
      } finally {
        await second.shutdown().catch(() => undefined);
      }
    },
    30000,
  );

  it('名額在重建之前佔：滿了拒絕、騰出來就叫得醒', async () => {
    const { a, b } = await firstProcess();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const second = await boot({
      rootTurns: [{ content: '根' }],
      turnsFor: (name) =>
        name === 'worker-a'
          ? [
              { content: '', toolCalls: [{ name: 'hold', id: 'hold-call', args: {} }] },
              { content: 'a 醒來答覆' },
            ]
          : [{ content: 'b 醒來答覆' }],
      resume: true,
      maxActive: 1,
      hold,
    });
    try {
      const background = second.detach.background!;
      await background.sendFromUser(a.runId, '甲先醒');
      await until(() => second.models['worker-a'].prompts.length > 0);
      // a 卡在 hold 上佔著唯一的名額：b 叫不醒，而且根本沒去握它的租約（日誌沒開在註冊表上）。
      await expect(background.sendFromUser(b.runId, '乙也要醒')).rejects.toMatchObject({
        name: 'BackgroundSubagentError',
        code: 'at-capacity',
      });
      expect(second.pump.sessions.get({ kind: 'subagent', runId: b.runId })).toBeUndefined();
      // 租約沒被佔：另一個把手現在拿得到 b 的寫入權。
      const probe = openStore();
      await (await probe.resume(`${ROOT}/${b.runId}`)).stored.close();

      release();
      await until(
        () =>
          second.pump.sessions
            .get({ kind: 'subagent', runId: a.runId })!
            .events.filter((event) => event.type === 'turn/end').length === 2,
      );
      await until(
        () => second.statuses.at(-1)?.find((s) => s.runId === a.runId)?.status === 'idle',
      );
      await background.sendFromUser(b.runId, '乙現在可以了');
      await until(() => second.models['worker-b'].prompts.length > 0);
    } finally {
      release();
      await second.shutdown();
    }
  }, 30000);

  it('舊日誌沒有身分：不擋啟動；列出來附原因；送話回找不到並說明；現況裡沒有它', async () => {
    const { a } = await firstProcess();
    const second = await boot({
      rootTurns: [{ content: '根' }],
      turnsFor: (name) => [{ content: `${name} 醒來答覆` }],
      resume: true,
    });
    try {
      const background = second.detach.background!;
      await expect(background.sendFromUser('bg-legacy000000', '醒醒')).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof BackgroundSubagentError &&
          error.code === 'not-found' &&
          error.message.includes('叫不醒') &&
          error.message.includes('subagent/descriptor'),
      );
      expect(second.statuses[0]?.map((item) => item.runId)).toEqual([a.runId, expect.any(String)]);
      expect(second.statuses[0]?.some((item) => item.runId === 'bg-legacy000000')).toBe(false);
    } finally {
      await second.shutdown();
    }
  }, 30000);

  it('模型用 send_message 也叫得醒', async () => {
    const { a } = await firstProcess();
    const second = await boot({
      rootTurns: [SEND_MESSAGE_TURN(a.runId), { content: '根收尾' }],
      turnsFor: (name) => [{ content: `${name} 醒來答覆` }],
      resume: true,
    });
    try {
      await second.pump.submit({ kind: 'message', text: '叫 a 起來' });
      await second.pump.whenIdle();
      await until(() => second.models['worker-a'].prompts.length > 0);
      const prompt = conversation(second.models['worker-a'].lastPrompt);
      expect(prompt.slice(0, a.before.length)).toEqual(a.before);
      // 模型寫的話帶 dsh 的前綴，不是人說的原文。
      expect(String(prompt.at(-1)?.content)).toMatch(/sent a message: 模型叫醒$/);
    } finally {
      await second.shutdown();
    }
  }, 30000);
});

/**
 * 子代理的歷史從日誌推（`log`，[#2751](https://github.com/DemianLi/nexus-agent/issues/2751)）：背景子代理冷復活之後的那一輪。
 *
 * 推得回的日誌：跟 `state` 下一樣叫得醒、看得到重啟之前的對話。推不回的日誌：`state` 以空對話繼續（對照），
 * `log` 下那一輪失敗、模型沒被叫、錯誤訊息講「這個子代理」與出路，與 root 一樣不退回 state。
 */
describe('背景子代理冷復活：history-source=log', () => {
  /** 把子日誌上的 `assistant/message` 改成不進模型的型別：模型「跑過」卻沒有回覆，推不回（`reply-missing`）。 */
  async function breakChildLog(runId: string): Promise<void> {
    const directory = world.storeDirectory!;
    const file = (await readdir(directory, { recursive: true })).find(
      (name) => name.includes(runId) && name.endsWith('.jsonl'),
    );
    if (file === undefined) throw new Error(`找不到 ${runId} 的日誌檔`);
    const path = join(directory, file);
    const text = await readFile(path, 'utf8');
    expect(text).toContain('"type":"assistant/message"');
    await writeFile(
      path,
      text.replaceAll('"type":"assistant/message"', '"type":"context/measure"'),
    );
  }

  it.each(['langgraph', 'native'] as const)(
    '推得回（%s）：log 下送話叫醒，看得到重啟之前的對話',
    async (agentLoop) => {
      const { a } = await firstProcess(agentLoop, 'log');
      const second = await boot({
        rootTurns: [{ content: '根' }],
        turnsFor: (name) => [{ content: `${name} 醒來答覆` }],
        resume: true,
        agentLoop,
        historySource: 'log',
      });
      try {
        await second.detach.background!.sendFromUser(a.runId, '重啟後的話');
        await until(
          () =>
            second.pump.sessions
              .get({ kind: 'subagent', runId: a.runId })
              ?.events.filter((event) => event.type === 'turn/end').length === 2,
        );
        const prompt = conversation(second.models['worker-a'].lastPrompt);
        expect(prompt.slice(0, a.before.length)).toEqual(a.before);
        expect(prompt.at(-1)).toEqual({ type: 'human', content: '重啟後的話' });
      } finally {
        await second.shutdown().catch(() => undefined);
      }
    },
    30000,
  );

  it.each(['langgraph', 'native'] as const)(
    '推不回（%s）：state 以空對話繼續（對照）；log 下那一輪失敗、模型沒被叫、訊息講子代理與出路',
    async (agentLoop) => {
      for (const historySource of ['state', 'log'] as const) {
        // 每一輪各自一份全新的日誌目錄：前一輪的續寫不能留在這一輪的日誌上。
        world.storeDirectory = undefined;
        const { a } = await firstProcess(agentLoop, 'log');
        await breakChildLog(a.runId);
        const second = await boot({
          rootTurns: [{ content: '根' }],
          turnsFor: (name) => [{ content: `${name} 醒來答覆` }],
          resume: true,
          agentLoop,
          historySource,
        });
        try {
          await second.detach
            .background!.sendFromUser(a.runId, '重啟後的話')
            .catch(() => undefined);
          const child = () => second.pump.sessions.get({ kind: 'subagent', runId: a.runId });
          // 重啟之前那一輪的 `turn/end` 已經在日誌上：等的是重啟之後這一輪的結局。
          await until(() => {
            const seen = child()?.events ?? [];
            return (
              seen.filter((event) => event.type === 'turn/end').length >= 2 ||
              seen.some((event) => event.type === 'turn/failed')
            );
          });
          const events = child()!.events;
          if (historySource === 'state') {
            // `state`：空對話繼續，模型只收到這一句。
            expect(second.models['worker-a'].prompts).toHaveLength(1);
            expect(conversation(second.models['worker-a'].lastPrompt)).toEqual([
              { type: 'human', content: '重啟後的話' },
            ]);
            expect(events.some((event) => event.type === 'turn/failed')).toBe(false);
          } else {
            expect(second.models['worker-a'].prompts).toEqual([]);
            const failed = events.find((event) => event.type === 'turn/failed');
            expect(JSON.stringify(failed?.data)).toContain('這個子代理的日誌推不回它的模型歷史');
            expect(JSON.stringify(failed?.data)).toContain('source: state');
          }
        } finally {
          await second.shutdown().catch(() => undefined);
        }
      }
    },
    30000,
  );
});
