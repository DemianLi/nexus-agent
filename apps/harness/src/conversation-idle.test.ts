/**
 * 對話行程回報閒置（[#2338](https://github.com/DemianLi/nexus-agent/issues/2338)，設計 `.docs/supervisor-1947-design-2026-11-03.md` §7-2）：**真的 wire handler＋真的最小 agent**（`idle-eviction.fixture.ts`，
 * 與 #1484 的逐出測試同一個測試台），接上真的控制面，監督行程那一側讀 stdout 的框。handler 不開逐出（對話行程不傳 `idleEvictMs`），
 * 什麼時候收由監督行程決定。
 *
 * - **閒置條件**：`isIdle` 的每一條各一個情境，條件成立時送 `busy`、不送 `idle`；放掉之後才送 `idle`。
 * - **全域下行**：前台一直掛著 `/threads/feed` 時照樣回報閒置、`drain` 照樣回 `drained`；掛的是這條 thread 自己的下行就不閒。
 * - **只放一條 thread**：別的 threadId、分叉出來的子 thread 都回 `thread_not_bound`。
 * - **一輪**：`turn(begin)`／`turn(end)` 對到 root 日誌的 `turn/start`／`turn/end`。
 */

import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { THREAD_NOT_BOUND } from '@nexus/wire';
import type { PromptAttachment } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { AttachmentStore, attachmentsRootOf } from './attachment-store.js';
import { ConversationControl } from './conversation-control.js';
import { foldTurn, loopbackRequest } from './fixtures.js';
import type { GoalDriverPort } from './goal-driver.js';
import {
  BASE,
  DANGER_SCRIPT,
  finishHeldRun,
  gate,
  JSON_HEADERS,
  openLine,
  PLAIN_SCRIPT,
  rig,
  runThenStop,
  startHeldRun,
  T,
  touch,
  until,
} from './idle-eviction.fixture.js';
import type { Rig } from './idle-eviction.fixture.js';
import { PNG_7X5 } from './image-fixtures.js';
import {
  decodeConversationReport,
  encodeConversationCommand,
  frame,
  takeFrames,
} from './supervisor-protocol.js';
import type { ConversationCommand, ConversationReport } from './supervisor-protocol.js';
import type { WireHandlerOptions } from './wire-handler.js';

interface Process {
  readonly r: Rig;
  readonly control: ConversationControl;
  /** stdout 上到目前為止的回報；呼叫一次就清掉。 */
  reports(): ConversationReport[];
  /** 同 {@link reports}，但略過一輪的邊緣與心跳，只留閒置與收尾相關的。 */
  idleReports(): ConversationReport[];
  send(command: ConversationCommand): Promise<void>;
}

let running: Process[] = [];

afterEach(async () => {
  for (const { r, control } of running) {
    control.close();
    r.probe.hold.open();
    r.probe.slash.open();
    await r.handler.close();
  }
  running = [];
});

/** 讓 stream 的 'data' 與 handler 的收尾跑完。 */
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 起一個綁著 `t1` 的對話行程：handler 只認 `t1`、不開逐出，一輪的邊緣接到控制面。回來時已收過 `ready` 與 `bound`、也收過第一次 `idle`。
 *
 * @param before - 綁之前對測試台做的事（例如 `t1` 的組裝要多掛什麼）。
 */
async function conversation(
  options: Partial<WireHandlerOptions> = {},
  before: (r: Rig) => void = () => undefined,
): Promise<Process> {
  const input = new PassThrough();
  const output = new PassThrough();
  let pending: Buffer = Buffer.alloc(0);
  output.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
  });
  const holder: { control?: ConversationControl } = {};
  const r = rig({
    idleEvictMs: undefined,
    boundThread: () => holder.control?.boundThread,
    onTurn: (threadId, phase) => holder.control?.turn(threadId, phase),
    ...options,
  });
  before(r);
  const control = (holder.control = new ConversationControl({
    input,
    output,
    handler: r.handler,
    now: () => r.clock,
    pollMs: 3_600_000,
    heartbeatMs: 3_600_000,
    onEnd: () => undefined,
    warn: () => undefined,
  }));
  const process: Process = {
    r,
    control,
    reports: () => {
      const { frames, rest } = takeFrames(pending);
      pending = rest;
      return frames.map(decodeConversationReport);
    },
    idleReports: () =>
      process.reports().filter(({ type }) => type !== 'turn' && type !== 'heartbeat'),
    send: async (command) => {
      input.write(frame(encodeConversationCommand(command)));
      await settle();
    },
  };
  running.push(process);
  control.ready();
  await process.send({ type: 'bind', threadId: 't1' });
  await until(() => r.created.length === 1);
  await settle(10);
  r.advance(T);
  control.checkIdle();
  expect(process.reports()).toEqual([
    { type: 'ready' },
    { type: 'bound', threadId: 't1' },
    { type: 'idle', idleMs: T },
  ]);
  return process;
}

/**
 * 條件成立的期間送 `busy`、之後不管過多久都不送 `idle`；放掉之後才送 `idle`，而且從放掉那一刻算（`idleMs` 是 0）。
 *
 * @param release - 放掉那個條件。
 */
async function expectBusyUntil(p: Process, release: () => Promise<void> | void): Promise<void> {
  p.control.checkIdle();
  expect(p.idleReports()).toEqual([{ type: 'busy' }]);
  p.r.advance(T * 10);
  p.control.checkIdle();
  expect(p.idleReports()).toEqual([]);
  await release();
  // 放掉條件之後 pump 的收尾是非同步的，同 `idle-eviction.test.ts`。
  await settle(50);
  p.control.checkIdle();
  expect(p.idleReports()).toEqual([{ type: 'idle', idleMs: 0 }]);
}

describe('閒置條件：條件成立就不回報閒置（isIdle 逐條）', () => {
  it('有一輪在跑（running）', async () => {
    const p = await conversation();
    await startHeldRun(p.r, 't1');
    await expectBusyUntil(p, () => finishHeldRun(p.r, 't1'));
  });

  it('停在核准點（awaitingInput）', async () => {
    const p = await conversation({}, (r) => r.extras.set('t1', { script: DANGER_SCRIPT }));
    const line = await openLine(p.r, 't1');
    await p.r.client.runStart('t1', '要核准的事');
    await foldTurn(line.events);
    await line.close();
    await expectBusyUntil(p, async () => {
      await p.r.client.runCancel('t1');
    });
  });

  it('送出佇列裡還有東西（inbox）', async () => {
    const p = await conversation({}, (r) => r.extras.set('t1', { script: DANGER_SCRIPT }));
    const line = await openLine(p.r, 't1');
    await p.r.client.runStart('t1', '要核准的事');
    await foldTurn(line.events);
    // 停在核准點時再送一句，接著按停止：中斷收回、佇列停住，只剩「佇列不空」。
    await p.r.client.runStart('t1', '排著的一句');
    await p.r.client.runCancel('t1');
    await line.close();
    await settle(50);
    p.control.checkIdle();
    expect(p.idleReports()).toEqual([{ type: 'busy' }]);
    p.r.advance(T * 10);
    p.control.checkIdle();
    expect(p.idleReports()).toEqual([]);
  });

  it('按停止之後留在 next-step 的插話（nextStep）；沒有插話的對照照樣回報閒置', async () => {
    const control = await conversation();
    await runThenStop(control.r, 't1', false);
    await settle(50);
    control.control.checkIdle();
    // 跑的期間沒問過，所以沒有 `busy`；最後活動時間往前推了，再送一次 `idle`、從現在算。
    expect(control.idleReports()).toEqual([{ type: 'idle', idleMs: 0 }]);

    const p = await conversation();
    await runThenStop(p.r, 't1', true);
    await settle(50);
    p.control.checkIdle();
    expect(p.idleReports()).toEqual([{ type: 'busy' }]);
    p.r.advance(T * 10);
    p.control.checkIdle();
    expect(p.idleReports()).toEqual([]);
  });

  it('這條 thread 自己的下行掛著（subscriberCount）', async () => {
    const p = await conversation();
    const line = await openLine(p.r, 't1');
    await expectBusyUntil(p, () => line.close());
  });

  it('背景子代理還有在途的工作（background.quiescent）', async () => {
    let quiescent = true;
    const p = await conversation({}, (r) =>
      r.extras.set('t1', {
        background: {
          sendFromUser: () => Promise.resolve(),
          interrupt: () => false,
          hasRunning: () => false,
          interruptAll: () => 0,
          quiescent: () => quiescent,
          whenChildrenSettled: () => Promise.resolve(false),
        },
      }),
    );
    quiescent = false;
    await expectBusyUntil(p, () => {
      quiescent = true;
    });
  });

  it('目標 active 且 armed（goalArmed）', async () => {
    let activation: 'armed' | 'disarmed' = 'disarmed';
    const port = {
      goal: () => ({ phase: 'active', activation }),
      block: () => undefined,
      pause: () => undefined,
      disarm: () => undefined,
      flush: () => Promise.resolve(),
      warn: () => undefined,
    } as unknown as GoalDriverPort;
    const p = await conversation({}, (r) => r.extras.set('t1', { goalDriver: port }));
    activation = 'armed';
    await expectBusyUntil(p, () => {
      activation = 'disarmed';
    });
  });

  it('續行排程有一次在飛（goalRoundInFlight）：一輪剛落定、排程器卡在耐久檢查點', async () => {
    // 授權讀數（`armed`）回假，`goalArmed` 不擋；`goal()` 仍是 active＋armed，排程器才會走到 `flush()`。
    let phase: 'active' | 'paused' = 'active';
    let flushing = false;
    const checkpoint = gate();
    const port = {
      goal: () => ({
        id: 'g1',
        revision: 1,
        objective: '做完',
        phase,
        activation: 'armed',
        roundsStarted: 0,
        maxGoalRounds: 5,
      }),
      armed: () => false,
      block: () => undefined,
      pause: () => undefined,
      disarm: () => undefined,
      flush: async () => {
        flushing = true;
        await checkpoint.promise;
      },
      warn: () => undefined,
    } as unknown as GoalDriverPort;
    const p = await conversation({}, (r) =>
      r.extras.set('t1', { script: PLAIN_SCRIPT, goalDriver: port }),
    );
    const line = await openLine(p.r, 't1');
    await p.r.client.runStart('t1', '一句');
    await foldTurn(line.events);
    await line.close();
    await until(() => flushing);
    await expectBusyUntil(p, () => {
      // 放行時目標已經不是 active：排程器複查之後不排下一輪。
      phase = 'paused';
      checkpoint.open();
    });
  });

  it('LLM 標題有一次在飛（titleBusy）', async () => {
    let busy = false;
    const p = await conversation({}, (r) =>
      r.extras.set('t1', {
        attachTitle: () => Object.assign(() => Promise.resolve(), { busy: () => busy }),
      }),
    );
    busy = true;
    await expectBusyUntil(p, () => {
      busy = false;
    });
  });

  it('斜線命令在跑（slashInFlight）', async () => {
    const p = await conversation();
    const slash = p.r.client.slashRun('t1', '/slow');
    await until(() => p.r.probe.slashEntered === 1);
    await expectBusyUntil(p, async () => {
      p.r.probe.slash.open();
      expect(await slash).toMatchObject({ kind: 'success' });
    });
  });

  it('有請求握著這條 thread（httpInFlight）', async () => {
    const p = await conversation();
    let push: (chunk: Uint8Array) => void = () => undefined;
    let finish: () => void = () => undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => controller.enqueue(chunk);
        finish = () => controller.close();
      },
    });
    const pending = p.r.handler.handle(
      loopbackRequest(`${BASE}/threads/t1/commands/subagent.list`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body,
        duplex: 'half',
      }),
    );
    await expectBusyUntil(p, async () => {
      push(new TextEncoder().encode(JSON.stringify({ id: 1, method: 'subagent.list' })));
      finish();
      await pending;
    });
  });

  it('run.start 卡在存附件的 await 裡（promptRequestsInFlight 與請求計數）', async () => {
    const home = await mkdtemp(join('/var/tmp', 'nexus-conv-idle-'));
    try {
      const saving = gate();
      let entered = false;
      class SlowStore extends AttachmentStore {
        override async saveImages(
          inputs: Parameters<AttachmentStore['saveImages']>[0],
        ): ReturnType<AttachmentStore['saveImages']> {
          entered = true;
          await saving.promise;
          return super.saveImages(inputs);
        }
      }
      const p = await conversation({ attachments: new SlowStore(attachmentsRootOf(home)) }, (r) =>
        r.extras.set('t1', { script: PLAIN_SCRIPT }),
      );
      const image: PromptAttachment = {
        type: 'image',
        mediaType: 'image/png',
        data: PNG_7X5,
        name: 's.png',
      };
      const started = p.r.client.runStart('t1', '這句話不能不見', { attachments: [image] });
      await until(() => entered);
      p.control.checkIdle();
      expect(p.idleReports()).toEqual([{ type: 'busy' }]);
      p.r.advance(T * 10);
      p.control.checkIdle();
      expect(p.idleReports()).toEqual([]);
      saving.open();
      expect((await started).type).toBe('success');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('全域下行（設計 §3-2）', () => {
  it('前台一直掛著 /threads/feed：照樣回報閒置、drain 回 drained', async () => {
    const p = await conversation({}, (r) => r.extras.set('t1', { script: PLAIN_SCRIPT }));
    const controller = new AbortController();
    const feed = await p.r.client.openThreadFeed(controller.signal);
    let seen = 0;
    const reading = (async () => {
      try {
        for await (const _ of feed) seen += 1;
      } catch {
        // 中止就是這樣結束的。
      }
    })();
    try {
      // 這條 thread 跑一輪，feed 上看得到它的狀態變化。
      const line = await openLine(p.r, 't1');
      await p.r.client.runStart('t1', '一句');
      await foldTurn(line.events);
      await line.close();
      await until(() => seen > 0);
      p.reports();
      p.r.advance(T);
      p.control.checkIdle();
      expect(p.idleReports()).toEqual([{ type: 'idle', idleMs: T }]);
      await p.send({ type: 'drain' });
      expect(p.idleReports()).toEqual([{ type: 'drained' }]);
    } finally {
      controller.abort();
      await reading;
    }
  });

  it('掛的是這條 thread 自己的下行：drain 回 busy、照收', async () => {
    const p = await conversation();
    const line = await openLine(p.r, 't1');
    await p.send({ type: 'drain' });
    expect(p.idleReports()).toEqual([{ type: 'busy' }]);
    expect((await p.r.client.runStart('t1', '還收')).type).toBe('success');
    await line.close();
  });
});

describe('只放一條 thread', () => {
  it('路徑帶別的 threadId：回 thread_not_bound，不建 agent', async () => {
    const p = await conversation();
    const outcome = await touch(p.r, 't2');
    expect(outcome).toMatchObject({ type: 'error', error: THREAD_NOT_BOUND });
    expect(outcome.message).toContain('只放 thread "t1"');
    expect(p.r.created).toEqual(['t1']);
  });

  it('還沒綁：任何 threadId 都回 thread_not_bound', async () => {
    const r = rig({ idleEvictMs: undefined, boundThread: () => undefined });
    running.push({
      r,
      control: new ConversationControl({
        input: new PassThrough(),
        output: new PassThrough(),
        handler: r.handler,
        now: () => r.clock,
        pollMs: 3_600_000,
        heartbeatMs: 3_600_000,
        onEnd: () => undefined,
        warn: () => undefined,
      }),
      reports: () => [],
      idleReports: () => [],
      send: async () => undefined,
    });
    expect(await touch(r, 't1')).toMatchObject({ type: 'error', error: THREAD_NOT_BOUND });
    expect(r.created).toEqual([]);
  });
});

describe('一輪的邊緣', () => {
  it('turn(begin) 與 turn(end) 對到 root 日誌的一輪', async () => {
    const p = await conversation({}, (r) => r.extras.set('t1', { script: PLAIN_SCRIPT }));
    const line = await openLine(p.r, 't1');
    await p.r.client.runStart('t1', '一句');
    await foldTurn(line.events);
    await line.close();
    expect(p.reports()).toEqual([
      { type: 'turn', phase: 'begin' },
      { type: 'turn', phase: 'end' },
    ]);
  });
});

describe('綁一條磁碟上還沒有的 thread（#2341）', () => {
  it('不先建、從綁定起算閒著；第一個請求才照它的路由建', async () => {
    const r = rig({ idleEvictMs: undefined, storedAccess: async () => undefined });
    running.push({ r, control: { close: () => undefined } } as unknown as Process);
    const boundAt = r.clock;
    await r.handler.open('t1');
    expect(r.created).toEqual([]);
    r.advance(T);
    expect(r.handler.idleState('t1')).toEqual({ idle: true, lastActiveAt: boundAt });
    await touch(r, 't1');
    expect(r.created).toHaveLength(1);
    expect(r.handler.idleState('t1')?.lastActiveAt).not.toBe(boundAt);
  });

  it('還沒建的時候有請求握著（httpInFlight）：不算閒著', async () => {
    const r = rig({ idleEvictMs: undefined, storedAccess: async () => undefined });
    running.push({ r, control: { close: () => undefined } } as unknown as Process);
    await r.handler.open('t1');
    r.advance(T);
    let finish: () => void = () => undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        finish = () => {
          controller.enqueue(
            new TextEncoder().encode(JSON.stringify({ id: 1, method: 'subagent.list' })),
          );
          controller.close();
        };
      },
    });
    const pending = r.handler.handle(
      loopbackRequest(`${BASE}/threads/t1/commands/subagent.list`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body,
        duplex: 'half',
      }),
    );
    await settle(10);
    expect(r.created).toEqual([]);
    expect(r.handler.idleState('t1')).toMatchObject({ idle: false });
    finish();
    await pending;
    expect(r.handler.idleState('t1')).toMatchObject({ idle: true });
  });

  it('磁碟上有的照樣先建', async () => {
    const r = rig({ idleEvictMs: undefined, storedAccess: async () => ({ profile: 'full' }) });
    running.push({ r, control: { close: () => undefined } } as unknown as Process);
    await r.handler.open('t1');
    expect(r.created).toHaveLength(1);
  });
});
