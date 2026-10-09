/**
 * 背景子代理的冷復活（[#1271](https://github.com/DemianLi/nexus-agent/issues/1271)）：載體這一層。
 *
 * 用**記憶體裡的假存放處**（`ColdChildStore`）把「重啟之前派出的」湊出來：root 日誌上有 `subagent/catalog`，子日誌上有
 * `subagent/descriptor`。這一檔問的是 host 怎麼用存放處——什麼時候讀、什麼時候接、名額在哪裡佔、失敗時租約放不放。
 * 真的落盤、真的重開一台的端到端在 `background-cold-e2e.test.ts`。
 */

import { SessionRegistry, appendSubagentCatalog, appendSubagentDescriptor } from '@nexus/core';
import type { SessionEvent, SessionLog } from '@nexus/core';
import { describe, expect, it } from 'vitest';

import type { ColdChildStore, ColdInspection } from './background-cold.js';
import { inspectionOf } from './background-cold.js';
import { BackgroundSubagentError, BackgroundSubagentHost } from './background-subagents.js';
import type {
  BackgroundAgent,
  BackgroundSubagentStatus,
  ModelChoice,
} from './background-subagents.js';

const ROOT = 'root-1';

/** 假的一份「上一個行程留下的」子日誌：事件加一個記得有沒有被放掉的把手。 */
interface ColdFixture {
  readonly runId: string;
  readonly events: readonly SessionEvent[];
  readonly parent?: string;
  closed: number;
}

/** 造一份子日誌的事件：有身分（`descriptor`）、一輪對話。 */
function childEvents(
  runId: string,
  options: {
    readonly descriptor?: { subagent: string; model?: string; effort?: string } | 'none';
    readonly text?: string;
  } = {},
): readonly SessionEvent[] {
  const registry = new SessionRegistry(ROOT);
  const log = registry.open({ kind: 'subagent', runId });
  const descriptor = options.descriptor ?? { subagent: 'worker' };
  if (descriptor !== 'none') appendSubagentDescriptor(log, descriptor);
  log.append('turn/start', { kind: 'message', text: options.text ?? '第一句' });
  log.append('turn/end', {});
  return log.events;
}

/** root 日誌上派過這些子代理（`subagent/catalog`），給 host 當 `rootSeed`。 */
function rootWithCatalog(
  runIds: readonly string[],
  mode: 'continuable' | 'one-shot' = 'continuable',
) {
  const registry = new SessionRegistry(ROOT);
  runIds.forEach((runId, index) => {
    registry.root.append('turn/start', { kind: 'message', text: `派 ${runId}` });
    registry.root.append('tool/call', {
      callId: `call-${index}`,
      name: 'subagent',
      args: {},
    } as never);
    appendSubagentCatalog(registry.root, {
      childId: `${ROOT}/${runId}`,
      callId: `call-${index}`,
      mode,
    });
    registry.root.append('turn/end', {});
  });
  return registry.root.events;
}

/** 假存放處：記下誰被冷讀、誰被接回來、誰的對話被灌回去、誰的把手被放掉。 */
function fakeStore(fixtures: readonly ColdFixture[]) {
  const byChild = new Map(fixtures.map((fixture) => [`${ROOT}/${fixture.runId}`, fixture]));
  const calls = {
    inspect: [] as string[],
    resume: [] as string[],
    restore: [] as { threadId: string; events: readonly SessionEvent[] }[],
  };
  const failures = {
    resume: undefined as Error | undefined,
    restore: undefined as Error | undefined,
    slowResume: undefined as Promise<void> | undefined,
  };
  const store: ColdChildStore = {
    inspect: (childId): Promise<ColdInspection> => {
      calls.inspect.push(childId);
      const fixture = byChild.get(childId);
      return Promise.resolve(
        fixture === undefined
          ? { kind: 'unresumable', reason: '日誌檔不在了' }
          : inspectionOf(fixture.events),
      );
    },
    resume: async (childId) => {
      calls.resume.push(childId);
      if (failures.slowResume !== undefined) await failures.slowResume;
      if (failures.resume !== undefined) throw failures.resume;
      const fixture = byChild.get(childId)!;
      return {
        header: { id: childId, parentSession: fixture.parent ?? ROOT } as never,
        events: fixture.events,
        stored: {
          close: () => {
            fixture.closed += 1;
            return Promise.resolve();
          },
        } as never,
        inspection: inspectionOf(fixture.events),
      };
    },
    restore: (_agent, threadId, events) => {
      calls.restore.push({ threadId, events });
      if (failures.restore !== undefined) return Promise.reject(failures.restore);
      return Promise.resolve({ kind: 'replayed', messages: [] } as never);
    },
  };
  return { store, calls, failures, fixtures: byChild };
}

function fixture(runId: string, events = childEvents(runId)): ColdFixture {
  return { runId, events, closed: 0 };
}

/** 假 agent：記下每一輪收到的字。 */
function fakeAgent() {
  const seen: string[] = [];
  const agent: BackgroundAgent = {
    streamEvents(input) {
      seen.push(String((input as { messages: { content: unknown }[] }).messages.at(-1)?.content));
      return Promise.resolve((async function* () {})() as never);
    },
    updateState: () => Promise.resolve(undefined),
  };
  return { agent, seen };
}

function make(
  runIds: readonly string[],
  fixtures: readonly ColdFixture[],
  options: { maxActive?: number; mode?: 'continuable' | 'one-shot' } = {},
) {
  const fake = fakeStore(fixtures);
  const sessions = new SessionRegistry(ROOT, { rootSeed: rootWithCatalog(runIds, options.mode) });
  const statuses: (readonly BackgroundSubagentStatus[])[] = [];
  const compiled: { subagent: string; choice?: ModelChoice }[] = [];
  const worker = fakeAgent();
  const host = new BackgroundSubagentHost({
    sessions,
    compile: (subagent, choice) => {
      compiled.push({ subagent, ...(choice !== undefined && { choice }) });
      return worker.agent;
    },
    cold: fake.store,
    ...(options.maxActive !== undefined && { maxActive: options.maxActive }),
    onStatus: (items) => statuses.push(items),
  });
  return { host, sessions, statuses, compiled, worker, ...fake };
}

const subagentLog = (sessions: SessionRegistry, runId: string): SessionLog | undefined =>
  sessions.get({ kind: 'subagent', runId });

describe('冷讀：列出不復活任何一個', () => {
  it('叫得醒的列為 idle、排在前面；叫不醒的（舊日誌）列出來附原因，但不在現況快照裡', async () => {
    const m = make(
      ['bg-old', 'bg-new'],
      [fixture('bg-new'), fixture('bg-old', childEvents('bg-old', { descriptor: 'none' }))],
    );
    // 掃完才送第一份現況：先送空的會讓叫得醒的被畫成收線。
    await m.host.resume('bg-nothing');
    expect(m.statuses).toEqual([[{ runId: 'bg-new', status: 'idle' }]]);
    expect(m.host.list()).toEqual([
      {
        runId: 'bg-old',
        label: 'unknown',
        status: 'inactive',
        note: expect.stringContaining('subagent/descriptor'),
      },
      { runId: 'bg-new', label: 'worker', status: 'inactive' },
    ]);
    expect(m.calls.resume).toEqual([]);
    expect(m.calls.restore).toEqual([]);
    expect(subagentLog(m.sessions, 'bg-new')).toBeUndefined();
    await m.host.close();
  });

  it('沒有要讀的（root 日誌上沒有 continuable 目錄）：現況同步送一份空的，不多一拍', () => {
    const m = make([], []);
    expect(m.statuses).toEqual([[]]);
    expect(m.calls.inspect).toEqual([]);
    return m.host.close();
  });

  it('one-shot 的目錄不讀：前景子代理沒有可以叫醒的', async () => {
    const m = make(['bg-fg'], [fixture('bg-fg')], { mode: 'one-shot' });
    await m.host.resume('bg-fg');
    expect(m.calls.inspect).toEqual([]);
    expect(m.host.list()).toEqual([]);
    await m.host.close();
  });

  it('不是 bg- 編號、或不在這個 root 底下的目錄不讀', async () => {
    const registry = new SessionRegistry(ROOT);
    registry.root.append('turn/start', { kind: 'message', text: '派' });
    appendSubagentCatalog(registry.root, {
      childId: `${ROOT}/task-1`,
      callId: 'a',
      mode: 'continuable',
    });
    appendSubagentCatalog(registry.root, {
      childId: 'other/bg-x',
      callId: 'b',
      mode: 'continuable',
    });
    const fake = fakeStore([]);
    const host = new BackgroundSubagentHost({
      sessions: new SessionRegistry(ROOT, { rootSeed: registry.root.events }),
      compile: () => fakeAgent().agent,
      cold: fake.store,
    });
    await host.resume('bg-x');
    expect(fake.calls.inspect).toEqual([]);
    await host.close();
  });

  it('interrupt 對冷的是 no-op：不復活、不讀檔', async () => {
    const m = make(['bg-1'], [fixture('bg-1')]);
    await m.host.resume('bg-1').catch(() => undefined);
    // 這裡的 resume 會真的叫醒；interrupt 的對照另開一份。
    const cold = make(['bg-2'], [fixture('bg-2')]);
    expect(cold.host.interrupt('bg-2')).toBe(false);
    expect(cold.calls.resume).toEqual([]);
    await m.host.close();
    await cold.host.close();
  });
});

describe('叫醒：送話才接回來', () => {
  it('control.sendFromUser 把冷的接回來再投遞：日誌以舊事件為 seed、圖按日誌上的身分編、對話灌回去、那一輪照常跑', async () => {
    const m = make(['bg-1'], [fixture('bg-1', childEvents('bg-1', { text: '重啟前的任務' }))]);
    await m.host.control.sendFromUser('bg-1', '重啟後的話');
    await m.host.idle();
    expect(m.calls.resume).toEqual([`${ROOT}/bg-1`]);
    expect(m.calls.restore).toHaveLength(1);
    expect(m.calls.restore[0]!.threadId).toBe(`${ROOT}/bg-1`);
    expect(m.compiled).toEqual([{ subagent: 'worker' }]);
    expect(m.worker.seen).toEqual(['重啟後的話']);
    const log = subagentLog(m.sessions, 'bg-1')!;
    // 舊的在前、新的一輪接在後面（seed 之後補一顆 `session/end-seed`）。
    const types = log.events.map((event) => event.type);
    expect(types.slice(0, 4)).toEqual([
      'subagent/descriptor',
      'turn/start',
      'turn/end',
      'session/end-seed',
    ]);
    expect(types.slice(4)).toEqual(['turn/start', 'turn/end']);
    // 現在是常駐的：列表搬到後面、不再是冷的。
    expect(m.host.list()).toEqual([{ runId: 'bg-1', label: 'worker', status: 'inactive' }]);
    await m.host.close();
  });

  it('身分帶模型與推理等級：按它編圖，之後每一輪都沿用', async () => {
    const m = make(
      ['bg-1'],
      [
        fixture(
          'bg-1',
          childEvents('bg-1', {
            descriptor: { subagent: 'worker', model: 'm-big', effort: 'high' },
          }),
        ),
      ],
    );
    await m.host.control.sendFromUser('bg-1', '話');
    await m.host.idle();
    expect(m.compiled).toEqual([
      { subagent: 'worker', choice: { model: 'm-big', effort: 'high' } },
    ]);
    // 同一個編號不能換模型（既有規矩，叫醒之後仍然成立）。
    expect(
      await m.host.submit({
        runId: 'bg-1',
        subagent: 'worker',
        text: '換',
        choice: { model: 'x' },
      }),
    ).toEqual({
      ok: false,
      error: expect.stringContaining('不能換成'),
    });
    await m.host.close();
  });

  it('叫醒過的不再接第二次；併發的兩句話共用同一次叫醒', async () => {
    const m = make(['bg-1'], [fixture('bg-1')]);
    await Promise.all([
      m.host.control.sendFromUser('bg-1', '甲'),
      m.host.control.sendFromUser('bg-1', '乙'),
    ]);
    await m.host.control.sendFromUser('bg-1', '丙');
    await m.host.idle();
    expect(m.calls.resume).toEqual([`${ROOT}/bg-1`]);
    // 三句話都投遞了；先後是載體既有的排程規矩（沒領走的插話退回時排在前面），不是這一張的事，所以不比順序。
    expect([...m.worker.seen].sort()).toEqual(['丙', '乙', '甲']);
    await m.host.close();
  });

  it('現況：叫醒期間算存活（list 顯示 running），之後回 idle', async () => {
    const m = make(['bg-1'], [fixture('bg-1')]);
    let release!: () => void;
    m.failures.slowResume = new Promise<void>((resolve) => (release = resolve));
    const sent = m.host.control.sendFromUser('bg-1', '話');
    await new Promise((resolve) => setImmediate(resolve));
    expect(m.host.list()[0]).toMatchObject({ runId: 'bg-1', status: 'running' });
    release();
    await sent;
    await m.host.idle();
    expect(m.host.statuses()).toEqual([{ runId: 'bg-1', status: 'idle' }]);
    await m.host.close();
  });

  it('叫不醒的（舊日誌沒有身分）：not-found，訊息說明原因；沒有去接它', async () => {
    const m = make(['bg-old'], [fixture('bg-old', childEvents('bg-old', { descriptor: 'none' }))]);
    await expect(m.host.control.sendFromUser('bg-old', '話')).rejects.toMatchObject({
      code: 'not-found',
      message: expect.stringMatching(/重啟之前派出的，叫不醒.*subagent\/descriptor/),
    });
    expect(m.calls.resume).toEqual([]);
    await m.host.close();
  });

  it('根本不認得的編號：照舊 not-found', async () => {
    const m = make(['bg-1'], [fixture('bg-1')]);
    await expect(m.host.control.sendFromUser('bg-nope', '話')).rejects.toMatchObject({
      code: 'not-found',
    });
    await m.host.close();
  });

  it('沒有存放處（沒落盤）：不認得重啟之前的，行為同改動之前', async () => {
    const sessions = new SessionRegistry(ROOT, { rootSeed: rootWithCatalog(['bg-1']) });
    const host = new BackgroundSubagentHost({ sessions, compile: () => fakeAgent().agent });
    expect(host.list()).toEqual([]);
    await expect(host.control.sendFromUser('bg-1', '話')).rejects.toMatchObject({
      code: 'not-found',
    });
    await host.close();
  });
});

describe('名額：在重建之前佔', () => {
  it('滿了就拒絕，而且沒去讀租約也沒灌對話', async () => {
    const m = make(['bg-cold'], [fixture('bg-cold')], { maxActive: 1 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const busy: BackgroundAgent = {
      streamEvents: async () => {
        await held;
        return (async function* () {})() as never;
      },
    };
    const sessions = m.sessions;
    const host = new BackgroundSubagentHost({
      sessions,
      compile: () => busy,
      cold: m.store,
      maxActive: 1,
    });
    host.start({ subagent: 'worker', text: '佔住唯一的名額' });
    await expect(host.control.sendFromUser('bg-cold', '話')).rejects.toMatchObject({
      code: 'at-capacity',
    });
    expect(m.calls.resume).toEqual([]);
    expect(m.calls.restore).toEqual([]);
    release();
    await host.idle();
    // 騰出名額之後同一個冷的就叫得醒。
    await host.control.sendFromUser('bg-cold', '話');
    await host.idle();
    expect(m.calls.resume).toEqual([`${ROOT}/bg-cold`]);
    await host.close();
    await m.host.close();
  });

  it('併發叫醒兩個冷的、名額只有一格：後到的被拒，不會兩個都接', async () => {
    const m = make(['bg-a', 'bg-b'], [fixture('bg-a'), fixture('bg-b')], { maxActive: 1 });
    let release!: () => void;
    m.failures.slowResume = new Promise<void>((resolve) => (release = resolve));
    const first = m.host.control.sendFromUser('bg-a', '甲');
    const second = m.host.control.sendFromUser('bg-b', '乙');
    await expect(second).rejects.toMatchObject({ code: 'at-capacity' });
    release();
    await first;
    await m.host.idle();
    expect(m.calls.resume).toEqual([`${ROOT}/bg-a`]);
    await m.host.close();
  });
});

describe('失敗：放掉租約、仍是冷的、可以再試', () => {
  it('接不回來（租約被握著等）：resume-failed，原因帶出來；之後再試成功', async () => {
    const m = make(['bg-1'], [fixture('bg-1')]);
    m.failures.resume = new Error('另一個行程握著寫入把手');
    await expect(m.host.control.sendFromUser('bg-1', '話')).rejects.toMatchObject({
      code: 'resume-failed',
      message: expect.stringContaining('另一個行程握著寫入把手'),
    });
    expect(m.host.statuses()).toEqual([{ runId: 'bg-1', status: 'idle' }]);
    m.failures.resume = undefined;
    await m.host.control.sendFromUser('bg-1', '再試');
    await m.host.idle();
    expect(m.worker.seen).toEqual(['再試']);
    await m.host.close();
  });

  it('對話灌不回去：放掉租約、日誌沒有被開在註冊表上、仍是冷的', async () => {
    const f = fixture('bg-1');
    const m = make(['bg-1'], [f]);
    m.failures.restore = new Error('updateState 炸了');
    await expect(m.host.control.sendFromUser('bg-1', '話')).rejects.toMatchObject({
      code: 'resume-failed',
      message: expect.stringContaining('updateState 炸了'),
    });
    expect(f.closed).toBe(1);
    expect(subagentLog(m.sessions, 'bg-1')).toBeUndefined();
    expect(m.worker.seen).toEqual([]);
    await m.host.close();
  });

  it('圖沒有 updateState（替身）：叫不醒，講得出原因', async () => {
    const f = fixture('bg-1');
    const fake = fakeStore([f]);
    const store: ColdChildStore = {
      ...fake.store,
      restore: (agent) =>
        agent.updateState === undefined
          ? Promise.reject(new Error('這張圖不能把對話灌回去'))
          : Promise.resolve({ kind: 'replayed', messages: [] } as never),
    };
    const host = new BackgroundSubagentHost({
      sessions: new SessionRegistry(ROOT, { rootSeed: rootWithCatalog(['bg-1']) }),
      compile: () => ({ streamEvents: () => Promise.reject(new Error('不該跑')) }),
      cold: store,
    });
    await expect(host.control.sendFromUser('bg-1', '話')).rejects.toBeInstanceOf(
      BackgroundSubagentError,
    );
    expect(f.closed).toBe(1);
    await host.close();
  });

  it('接回來的那份日誌身分變了（冷讀之後被改過）：以接回來的為準，壞了就放掉不叫', async () => {
    const f = fixture('bg-1');
    const m = make(['bg-1'], [f]);
    // 冷讀時是好的；接回來時（換成沒有身分的事件）已經叫不醒了。
    const original = m.store.resume;
    m.store.resume = async (childId, parentId) => {
      const resumed = await original(childId, parentId);
      return { ...resumed, inspection: { kind: 'unresumable', reason: '身分被改壞了' } };
    };
    await expect(m.host.control.sendFromUser('bg-1', '話')).rejects.toMatchObject({
      code: 'resume-failed',
      message: expect.stringContaining('身分被改壞了'),
    });
    expect(f.closed).toBe(1);
    await m.host.close();
  });

  it('叫醒到一半 host 關了：放掉租約，close 等它收完', async () => {
    const f = fixture('bg-1');
    const m = make(['bg-1'], [f]);
    let release!: () => void;
    m.failures.slowResume = new Promise<void>((resolve) => (release = resolve));
    const sent = m.host.control.sendFromUser('bg-1', '話');
    sent.catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    const closing = m.host.close();
    release();
    await closing;
    await expect(sent).rejects.toMatchObject({ code: 'closed' });
    expect(f.closed).toBe(1);
    expect(subagentLog(m.sessions, 'bg-1')).toBeUndefined();
  });
});

describe('派出：身分記在子代理自己的日誌', () => {
  it('start 在第一句話之前寫 subagent/descriptor，帶模型與推理等級', async () => {
    const sessions = new SessionRegistry(ROOT);
    const host = new BackgroundSubagentHost({
      sessions,
      compile: () => fakeAgent().agent,
    });
    const plain = host.start({ subagent: 'worker', text: '甲' });
    const chosen = host.start({
      subagent: 'reviewer',
      text: '乙',
      choice: { model: 'm-big', effort: 'high' },
    });
    await Promise.all([plain.outcome, chosen.outcome]);
    const descriptorOf = (runId: string) => {
      const events = subagentLog(sessions, runId)!.events;
      const at = events.findIndex((event) => event.type === 'subagent/descriptor');
      const turn = events.findIndex((event) => event.type === 'turn/start');
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThan(turn);
      return events[at]!.data;
    };
    expect(descriptorOf(plain.runId)).toEqual({
      version: 1,
      mode: 'continuable',
      subagent: 'worker',
    });
    expect(descriptorOf(chosen.runId)).toEqual({
      version: 1,
      mode: 'continuable',
      subagent: 'reviewer',
      model: 'm-big',
      effort: 'high',
    });
    await host.close();
  });
});

describe('inspectionOf', () => {
  it('四種下場各有說法', () => {
    expect(inspectionOf(childEvents('bg-1'))).toEqual({ kind: 'resumable', subagent: 'worker' });
    expect(inspectionOf(childEvents('bg-1', { descriptor: 'none' }))).toMatchObject({
      kind: 'unresumable',
      reason: expect.stringContaining('格式 44 以前'),
    });
    const wrongVersion = childEvents('bg-1').map((event) =>
      event.type === 'subagent/descriptor'
        ? ({
            ...event,
            data: { ...(event.data as object), version: 99 },
          } as unknown as SessionEvent)
        : event,
    );
    expect(inspectionOf(wrongVersion)).toMatchObject({
      kind: 'unresumable',
      reason: expect.stringContaining('99'),
    });
    const malformed = childEvents('bg-1').map((event) =>
      event.type === 'subagent/descriptor'
        ? ({ ...event, data: { ...(event.data as object), extra: 1 } } as unknown as SessionEvent)
        : event,
    );
    expect(inspectionOf(malformed)).toMatchObject({
      kind: 'unresumable',
      reason: expect.stringContaining('壞了'),
    });
  });
});
