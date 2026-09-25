/**
 * **送出佇列放在 server 上**——[#637](https://github.com/DemianLi/nexus-agent/issues/637) 的驗收。
 *
 * 照 dsh 的收件匣（`packages/core/agent-loop/src/inbox.ts`，`477b4f4`）：人送出的話一律先進佇列，每一次變動在日誌上
 * 落一顆 `inbox/spliced`，一輪開始時領一件。按停止之後排著的停住，下一次送出才喚醒；重啟之後從日誌折回來、停住。
 *
 * 三層：
 *
 * - **假的 agent**：日誌上 splice 的形狀與先後、推送、改刪、停住與喚醒、重啟、收線。只有它排得出「停止撞上核准點」
 *   這種先後。
 * - **真的組裝**：停在核准點時送的那句要等核准答完才跑，模型讀到的是核准後的真結果。
 * - **wire**：`run.start` 回的 `run_id` 就是那一件的 id、停在核准點時也收、`queue.update` 的三種錯誤。
 *
 * 讀日誌的那幾個（goal 續行、不變量、歷史切頁）在 `send-queue-readers.test.ts`。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel` 或假 agent。
 */

import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { SessionLog } from '@nexus/core';
import type { InboxSplice, PluginEntry, SessionEvent } from '@nexus/core';
import type { Event, InboxPayload } from '@nexus/wire';
import { createWireClient, INBOX, QUEUE_UPDATE_METHOD } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { historyPage } from './conversation-history.js';
import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { WireHandler } from './wire-handler.js';

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** 日誌上一輪一輪的邊界與佇列的變動，照順序。 */
function marks(events: readonly SessionEvent[]): string[] {
  return events.flatMap((event) => {
    switch (event.type) {
      case 'turn/start': {
        const data = event.data as { kind: string; text?: string };
        return [`start:${data.kind}${data.text === undefined ? '' : `:${data.text}`}`];
      }
      case 'turn/end':
        return [event.data.reason?.kind === 'aborted' ? 'end:aborted' : 'end'];
      case 'turn/failed':
        return ['failed'];
      case 'inbox/spliced': {
        const splice = event.data;
        const inserted = splice.inserted.map((item) => item.text).join(',');
        if (splice.removedCount === undefined) return [`insert:${inserted}`];
        if (splice.outcome !== 'canceled') return ['claim'];
        return [inserted === '' ? 'remove' : `edit:${inserted}`];
      }
      default:
        return [];
    }
  });
}

function splices(events: readonly SessionEvent[]): InboxSplice[] {
  return events.flatMap((event) => (event.type === 'inbox/spliced' ? [event.data] : []));
}

/** 下行收到的佇列推送。 */
function inboxPushes(frames: readonly Event[]): InboxPayload[] {
  return frames.flatMap((frame) => {
    const data = frame.params.data as { name?: unknown; payload?: unknown } | null;
    return frame.method === 'custom' && data?.name === INBOX ? [data.payload as InboxPayload] : [];
  });
}

const COMPLETED = {
  type: 'event',
  seq: 0,
  method: 'lifecycle',
  params: { namespace: [], timestamp: 0, data: { event: 'completed', graph_name: 'root' } },
};

/** 那一輪模型開始講話的那一顆——用來量「開跑的推送比那一輪的任何 frame 早」。 */
function replyStart(runId: string) {
  return {
    type: 'event',
    seq: 0,
    method: 'messages',
    params: {
      namespace: [],
      timestamp: 0,
      data: { event: 'message-start', role: 'ai', run_id: runId, id: runId },
    },
  };
}

function interruptFrame(id: string) {
  return {
    type: 'event',
    seq: 0,
    method: 'updates',
    params: {
      namespace: [],
      timestamp: 0,
      node: '__interrupt__',
      data: { values: [{ id, value: { actionRequests: [{ name: 'danger', args: {} }] } }] },
    },
  };
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

interface Step {
  /** 開頭先吐一顆中斷。 */
  readonly interrupt?: string;
  /** 收尾前等這道門。 */
  readonly hold?: Promise<void>;
  /** 等門時看中止訊號：觸發了就拋，像被切斷的模型請求。 */
  readonly abortable?: boolean;
}

/**
 * 照腳本跑的假 agent。每一輪吐一顆 `message-start`（`run_id` 是第幾輪），再照那一步排的收尾；沒排到的直接收尾。
 */
function scriptedAgent(steps: readonly Step[] = []) {
  let call = 0;
  const agent = {
    streamEvents: async (_input: unknown, config: { configurable: Record<string, unknown> }) => {
      const step = steps[call] ?? {};
      call += 1;
      const signal = Object.values(config.configurable).find(
        (value): value is AbortSignal => value instanceof AbortSignal,
      );
      const index = call;
      return (async function* () {
        yield replyStart(`reply-${index}`);
        if (step.interrupt !== undefined) yield interruptFrame(step.interrupt);
        if (step.hold !== undefined) {
          if (step.abortable === true && signal !== undefined) {
            await Promise.race([
              step.hold,
              new Promise<void>((_, reject) =>
                signal.addEventListener('abort', () => reject(new Error('被切斷了')), {
                  once: true,
                }),
              ),
            ]);
          } else {
            await step.hold;
          }
        }
        yield COMPLETED;
      })();
    },
    getState: async () => ({ values: {} }),
    updateState: async () => ({}),
  };
  return agent as unknown as PumpAgent;
}

/** 一個 pump 加一條訂了全部 channel 的下行。 */
function open(agent: PumpAgent, seed?: readonly SessionEvent[]) {
  const pump = new ThreadPump(agent, 'queue-root', undefined, seed);
  const frames: Event[] = [];
  const line = new AbortController();
  const stream = pump.subscribe(['messages', 'tools', 'lifecycle', 'input', 'custom'], line.signal);
  const draining = (async () => {
    for await (const frame of stream) frames.push(frame);
  })();
  return {
    pump,
    frames,
    marks: () => marks(pump.sessionLog.events),
    close: async () => {
      pump.close();
      line.abort();
      await draining;
    },
  };
}

const approve = (interruptId: string) =>
  ({ kind: 'resume', interruptId, response: { decisions: [{ type: 'approve' }] } }) as const;

describe('送出與領走', () => {
  it('閒著時送一句也走佇列：先插入、開跑時領走，推送兩顆，帶 claimed 的那顆早於那一輪的任何 frame', async () => {
    const run = open(scriptedAgent());
    try {
      await run.pump.submit({ kind: 'message', text: '嗨', id: 'item-1' });
      await run.pump.whenIdle();

      expect(run.marks()).toEqual(['insert:嗨', 'start:message:嗨', 'claim', 'end']);
      expect(splices(run.pump.sessionLog.events)).toEqual([
        {
          target: 'next-turn',
          start: 0,
          inserted: [{ id: 'item-1', text: '嗨', source: { kind: 'user' } }],
        },
        { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
      ]);
      expect(inboxPushes(run.frames)).toEqual([
        { items: [{ id: 'item-1', text: '嗨', source: { kind: 'user' } }] },
        { items: [], claimed: { id: 'item-1', text: '嗨' } },
      ]);
      const claimedAt = run.frames.findIndex(
        (frame) => frame.method === 'custom' && inboxPushes([frame])[0]?.claimed !== undefined,
      );
      const replyAt = run.frames.findIndex((frame) => frame.method === 'messages');
      expect(claimedAt).toBeGreaterThanOrEqual(0);
      expect(claimedAt).toBeLessThan(replyAt);
      expect(run.pump.inbox).toEqual([]);
    } finally {
      await run.close();
    }
  });

  it('跑著時送兩句：各插一顆、依序各開一輪，開跑時各領一顆，清單推成空的', async () => {
    const hold = gate();
    const run = open(scriptedAgent([{ hold: hold.opened }]));
    try {
      const first = run.pump.submit({ kind: 'message', text: 'A', id: 'a' });
      await until(() => run.pump.inbox.length === 0 && run.marks().includes('start:message:A'));
      const second = run.pump.submit({ kind: 'message', text: 'B', id: 'b' });
      const third = run.pump.submit({ kind: 'message', text: 'C', id: 'c' });
      expect(run.pump.inbox.map((item) => item.id)).toEqual(['b', 'c']);
      hold.open();
      await Promise.all([first, second, third]);
      await run.pump.whenIdle();

      expect(run.marks()).toEqual([
        'insert:A',
        'start:message:A',
        'claim',
        'insert:B',
        'insert:C',
        'end',
        'start:message:B',
        'claim',
        'end',
        'start:message:C',
        'claim',
        'end',
      ]);
      const pushes = inboxPushes(run.frames);
      expect(pushes.map((push) => push.items.map((item) => item.id))).toEqual([
        ['a'],
        [],
        ['b'],
        ['b', 'c'],
        ['c'],
        [],
      ]);
      expect(pushes.map((push) => push.claimed?.id)).toEqual([
        undefined,
        'a',
        undefined,
        undefined,
        'b',
        'c',
      ]);
    } finally {
      await run.close();
    }
  });

  it('沒給 id 的也有 id：每一件各自一個', async () => {
    const hold = gate();
    const run = open(scriptedAgent([{ hold: hold.opened }]));
    try {
      const first = run.pump.submit({ kind: 'message', text: 'A' });
      const second = run.pump.submit({ kind: 'message', text: 'B' });
      const ids = run.pump.inbox.map((item) => item.id);
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
      hold.open();
      await Promise.all([first, second]);
    } finally {
      await run.close();
    }
  });
});

describe('改與刪', () => {
  it('改：id 與位置不變，開跑時用的是改過的文字', async () => {
    const hold = gate();
    const run = open(scriptedAgent([{ hold: hold.opened }]));
    try {
      const first = run.pump.submit({ kind: 'message', text: 'A', id: 'a' });
      await until(() => run.marks().includes('start:message:A'));
      const second = run.pump.submit({ kind: 'message', text: 'B', id: 'b' });
      const third = run.pump.submit({ kind: 'message', text: 'C', id: 'c' });

      expect(run.pump.updateQueue('b', { kind: 'edit', text: 'B 改過' })).toBe('updated');
      expect(run.pump.inbox.map((item) => [item.id, item.text])).toEqual([
        ['b', 'B 改過'],
        ['c', 'C'],
      ]);
      expect(splices(run.pump.sessionLog.events).at(-1)).toEqual({
        target: 'next-turn',
        start: 0,
        removedCount: 1,
        inserted: [{ id: 'b', text: 'B 改過', source: { kind: 'user' } }],
        outcome: 'canceled',
      });
      hold.open();
      await Promise.all([first, second, third]);
      await run.pump.whenIdle();

      expect(run.marks().filter((mark) => mark.startsWith('start:'))).toEqual([
        'start:message:A',
        'start:message:B 改過',
        'start:message:C',
      ]);
      // 開跑那一顆推送帶的是改過的文字：畫面據它畫人的泡泡。
      expect(inboxPushes(run.frames).find((push) => push.claimed?.id === 'b')?.claimed).toEqual({
        id: 'b',
        text: 'B 改過',
      });
    } finally {
      await run.close();
    }
  });

  it('刪：它不會跑，送出它的 promise 照樣有結果', async () => {
    const hold = gate();
    const run = open(scriptedAgent([{ hold: hold.opened }]));
    try {
      const first = run.pump.submit({ kind: 'message', text: 'A', id: 'a' });
      await until(() => run.marks().includes('start:message:A'));
      const second = run.pump.submit({ kind: 'message', text: 'B', id: 'b' });
      const third = run.pump.submit({ kind: 'message', text: 'C', id: 'c' });

      expect(run.pump.updateQueue('b', { kind: 'remove' })).toBe('updated');
      expect(splices(run.pump.sessionLog.events).at(-1)).toEqual({
        target: 'next-turn',
        start: 0,
        removedCount: 1,
        inserted: [],
        outcome: 'canceled',
      });
      expect(inboxPushes(run.frames).at(-1)).toEqual({
        items: [{ id: 'c', text: 'C', source: { kind: 'user' } }],
      });
      hold.open();
      await Promise.all([first, second, third]);
      await run.pump.whenIdle();
      expect(run.marks().filter((mark) => mark.startsWith('start:'))).toEqual([
        'start:message:A',
        'start:message:C',
      ]);
    } finally {
      await run.close();
    }
  });

  it('已經開跑、已經刪掉、從沒有過的：都回 not-found，日誌不動', async () => {
    const hold = gate();
    const run = open(scriptedAgent([{ hold: hold.opened }]));
    try {
      const first = run.pump.submit({ kind: 'message', text: 'A', id: 'a' });
      await until(() => run.marks().includes('start:message:A'));
      const second = run.pump.submit({ kind: 'message', text: 'B', id: 'b' });
      expect(run.pump.updateQueue('b', { kind: 'remove' })).toBe('updated');
      const before = run.pump.sessionLog.length;

      expect(run.pump.updateQueue('a', { kind: 'edit', text: '改開跑的' })).toBe('not-found');
      expect(run.pump.updateQueue('a', { kind: 'remove' })).toBe('not-found');
      expect(run.pump.updateQueue('b', { kind: 'remove' })).toBe('not-found');
      expect(run.pump.updateQueue('nope', { kind: 'remove' })).toBe('not-found');
      expect(run.pump.sessionLog.length).toBe(before);
      hold.open();
      await Promise.all([first, second]);
    } finally {
      await run.close();
    }
  });
});

describe('按停止之後：排著的停住，下一次送出才喚醒', () => {
  it('跑著時按停止：兩件停住、running 是 false；再送一句，三件照 FIFO 跑完', async () => {
    const hold = gate();
    const run = open(scriptedAgent([{ hold: hold.opened, abortable: true }]));
    try {
      const first = run.pump.submit({ kind: 'message', text: 'A', id: 'a' });
      await until(() => run.marks().includes('start:message:A'));
      void run.pump.submit({ kind: 'message', text: 'B', id: 'b' });
      void run.pump.submit({ kind: 'message', text: 'C', id: 'c' });

      expect(run.pump.cancel()).toBe('run');
      await first;
      await run.pump.whenIdle();

      expect(run.marks()).toEqual([
        'insert:A',
        'start:message:A',
        'claim',
        'insert:B',
        'insert:C',
        'end:aborted',
      ]);
      expect(run.pump.running).toBe(false);
      expect(run.pump.awaitingInput).toBe(false);
      expect(run.pump.inbox.map((item) => item.id)).toEqual(['b', 'c']);

      await run.pump.submit({ kind: 'message', text: 'D', id: 'd' });
      await run.pump.whenIdle();
      expect(
        run.marks().filter((mark) => mark.startsWith('start:') || mark.startsWith('end')),
      ).toEqual([
        'start:message:A',
        'end:aborted',
        'start:message:B',
        'end',
        'start:message:C',
        'end',
        'start:message:D',
        'end',
      ]);
      expect(run.pump.inbox).toEqual([]);
      expect(run.pump.running).toBe(false);
    } finally {
      await run.close();
    }
  });

  it('停住時改與刪照收：改過的照改過的跑，刪掉的不跑', async () => {
    const hold = gate();
    const run = open(scriptedAgent([{ hold: hold.opened, abortable: true }]));
    try {
      const first = run.pump.submit({ kind: 'message', text: 'A', id: 'a' });
      await until(() => run.marks().includes('start:message:A'));
      void run.pump.submit({ kind: 'message', text: 'B', id: 'b' });
      void run.pump.submit({ kind: 'message', text: 'C', id: 'c' });
      run.pump.cancel();
      await first;
      await run.pump.whenIdle();

      expect(run.pump.updateQueue('b', { kind: 'edit', text: 'B2' })).toBe('updated');
      expect(run.pump.updateQueue('c', { kind: 'remove' })).toBe('updated');
      expect(run.pump.running).toBe(false);

      await run.pump.submit({ kind: 'message', text: 'D', id: 'd' });
      await run.pump.whenIdle();
      expect(run.marks().filter((mark) => mark.startsWith('start:'))).toEqual([
        'start:message:A',
        'start:message:B2',
        'start:message:D',
      ]);
    } finally {
      await run.close();
    }
  });

  it('按了停止、那一輪還沒收尾就又送一句：那一句喚醒排著的，全部照 FIFO 跑', async () => {
    const hold = gate();
    const run = open(scriptedAgent([{ hold: hold.opened }]));
    try {
      const first = run.pump.submit({ kind: 'message', text: 'A', id: 'a' });
      await until(() => run.marks().includes('start:message:A'));
      void run.pump.submit({ kind: 'message', text: 'B', id: 'b' });
      expect(run.pump.cancel()).toBe('run');
      // 那一輪還在跑（假 agent 不看訊號，等門）：這時送的一句就是「下一次送出」。
      const late = run.pump.submit({ kind: 'message', text: 'C', id: 'c' });
      hold.open();
      await first;
      await late;
      await run.pump.whenIdle();
      expect(run.marks().filter((mark) => mark.startsWith('start:'))).toEqual([
        'start:message:A',
        'start:message:B',
        'start:message:C',
      ]);
    } finally {
      await run.close();
    }
  });

  it('停止撞上核准點：那一輪照常停在核准點，排著的是在等核准，不是停住', async () => {
    const hold = gate();
    const run = open(scriptedAgent([{ interrupt: 'i1', hold: hold.opened }]));
    try {
      const first = run.pump.submit({ kind: 'message', text: 'A', id: 'a' });
      await until(() => run.pump.awaitingInput);
      const second = run.pump.submit({ kind: 'message', text: 'B', id: 'b' });
      // 那一輪還在跑（還沒收尾），按停止中止的是它；它接著照常停在核准點，不落 aborted。
      expect(run.pump.cancel()).toBe('run');
      hold.open();
      await first;
      expect(run.marks()).toEqual(['insert:A', 'start:message:A', 'claim', 'insert:B', 'end']);
      expect(run.pump.awaitingInput).toBe(true);
      // 同 #629 那張表：停在核准點時排著的算在飛。
      expect(run.pump.running).toBe(true);

      await run.pump.submit(approve('i1'));
      await second;
      await run.pump.whenIdle();
      expect(run.marks().filter((mark) => mark.startsWith('start:'))).toEqual([
        'start:message:A',
        'start:resume',
        'start:message:B',
      ]);
    } finally {
      await run.close();
    }
  });

  it('停在核准點時按停止（收回）：收回那一輪收掉，排著的停住；再送一句才照 FIFO 跑', async () => {
    const run = open(scriptedAgent([{ interrupt: 'i1' }]));
    try {
      await run.pump.submit({ kind: 'message', text: 'A', id: 'a' });
      expect(run.pump.awaitingInput).toBe(true);
      // 停在核准點時也收（#637 的 Q4）：排著、停住等核准。
      void run.pump.submit({ kind: 'message', text: 'B', id: 'b' });
      expect(run.pump.running).toBe(true);

      expect(run.pump.cancel()).toBe('withdrawn');
      await run.pump.whenIdle();
      expect(run.marks()).toEqual([
        'insert:A',
        'start:message:A',
        'claim',
        'end',
        'insert:B',
        'start:resume',
        'end:aborted',
      ]);
      expect(run.pump.running).toBe(false);
      expect(run.pump.awaitingInput).toBe(false);
      expect(run.pump.inbox.map((item) => item.id)).toEqual(['b']);

      await run.pump.submit({ kind: 'message', text: 'C', id: 'c' });
      await run.pump.whenIdle();
      expect(run.marks().filter((mark) => mark.startsWith('start:'))).toEqual([
        'start:message:A',
        'start:resume',
        'start:message:B',
        'start:message:C',
      ]);
    } finally {
      await run.close();
    }
  });

  it('停住時收線：送出它們的 promise reject，不再算在飛', async () => {
    const hold = gate();
    const run = open(scriptedAgent([{ hold: hold.opened, abortable: true }]));
    try {
      const first = run.pump.submit({ kind: 'message', text: 'A', id: 'a' });
      await until(() => run.marks().includes('start:message:A'));
      const second = run.pump.submit({ kind: 'message', text: 'B', id: 'b' });
      run.pump.cancel();
      await first;
      await run.pump.whenIdle();
      run.pump.close();
      await expect(second).rejects.toThrow('這條 thread 已經收掉了');
      expect(run.pump.running).toBe(false);
      // 收線不動日誌：佇列是耐久的，重啟之後接回來。
      expect(run.pump.inbox.map((item) => item.id)).toEqual(['b']);
    } finally {
      await run.close();
    }
  });
});

/** 一份上一個行程留下的日誌：一輪跑完，後面排著兩件。 */
function seedWithQueued(): readonly SessionEvent[] {
  const log = new SessionLog('queue-root');
  const item = (id: string, text: string) => ({ id, text, source: { kind: 'user' as const } });
  log.append('inbox/spliced', { target: 'next-turn', start: 0, inserted: [item('x', 'X')] });
  log.append('turn/start', { kind: 'message', text: 'X' });
  log.append('inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
  log.append('inbox/spliced', { target: 'next-turn', start: 0, inserted: [item('b', 'B')] });
  log.append('inbox/spliced', { target: 'next-turn', start: 1, inserted: [item('c', 'C')] });
  return log.events;
}

describe('重啟：佇列從日誌折回來、停住', () => {
  it('接回來的兩件列得出、不自己開跑；送一句之後三件照 FIFO 跑', async () => {
    const run = open(scriptedAgent(), seedWithQueued());
    try {
      expect(run.pump.inbox.map((item) => item.id)).toEqual(['b', 'c']);
      expect(run.pump.running).toBe(false);
      await run.pump.whenIdle();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(run.marks().filter((mark) => mark.startsWith('start:'))).toEqual(['start:message:X']);
      // 接回來那一刻不推：那一段的值由歷史送，同會話累計。
      expect(inboxPushes(run.frames)).toEqual([]);

      await run.pump.submit({ kind: 'message', text: 'D', id: 'd' });
      await run.pump.whenIdle();
      expect(run.marks().filter((mark) => mark.startsWith('start:'))).toEqual([
        'start:message:X',
        'start:message:B',
        'start:message:C',
        'start:message:D',
      ]);
      expect(run.pump.inbox).toEqual([]);
    } finally {
      await run.close();
    }
  });

  it('接回來、還停著就收線：不會變成沒人接的 rejection', async () => {
    const run = open(scriptedAgent(), seedWithQueued());
    await run.close();
    // vitest 對沒人接的 rejection 會讓整個檔案紅；等一個 tick 讓它有機會冒出來。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(run.pump.running).toBe(false);
  });

  it('接回來的佇列改得動：改過的照改過的跑', async () => {
    const run = open(scriptedAgent(), seedWithQueued());
    try {
      expect(run.pump.updateQueue('c', { kind: 'edit', text: 'C2' })).toBe('updated');
      expect(run.pump.updateQueue('b', { kind: 'remove' })).toBe('updated');
      await run.pump.submit({ kind: 'message', text: 'D', id: 'd' });
      await run.pump.whenIdle();
      expect(run.marks().filter((mark) => mark.startsWith('start:'))).toEqual([
        'start:message:X',
        'start:message:C2',
        'start:message:D',
      ]);
    } finally {
      await run.close();
    }
  });
});

describe('歷史帶的是目前的清單', () => {
  it('跟即時推的最後一顆一樣（不帶 claimed）', async () => {
    const hold = gate();
    const run = open(scriptedAgent([{ hold: hold.opened }]));
    try {
      const first = run.pump.submit({ kind: 'message', text: 'A', id: 'a' });
      await until(() => run.marks().includes('start:message:A'));
      void run.pump.submit({ kind: 'message', text: 'B', id: 'b' });
      void run.pump.submit({ kind: 'message', text: 'C', id: 'c' });
      run.pump.cancel();
      hold.open();
      await first;
      await run.pump.whenIdle();
      const page = historyPage(run.pump.sessionLog.events);
      const pushed = inboxPushes(page.events);
      expect(pushed).toEqual([{ items: inboxPushes(run.frames).at(-1)!.items }]);
      expect(pushed[0]!.items.map((item) => item.id)).toEqual(['b', 'c']);
    } finally {
      await run.close();
    }
  });

  it('在最新一頁之外插進來的，最新一頁照樣帶得出', () => {
    const log = new SessionLog('paged');
    const item = (id: string) => ({ id, text: id, source: { kind: 'user' as const } });
    log.append('inbox/spliced', { target: 'next-turn', start: 0, inserted: [item('b')] });
    log.append('inbox/spliced', { target: 'next-turn', start: 1, inserted: [item('c')] });
    log.append('turn/start', { kind: 'message', text: '前一輪' });
    log.append('turn/end', {});
    log.append('turn/start', { kind: 'message', text: '最後一輪' });
    log.append('turn/end', {});
    const last = historyPage(log.events, { maxMessages: 1 });
    expect(last.firstSeq).toBe(4);
    expect(inboxPushes(last.events)).toEqual([{ items: [item('b'), item('c')] }]);
    // 較舊的那一頁不帶：畫面往上捲時才抓它，那時即時的推送早就換過清單了，帶的話會把新的蓋回舊的。
    const older = historyPage(log.events, { maxMessages: 1, beforeSeq: 4 });
    expect(older.firstSeq).toBe(2);
    expect(inboxPushes(older.events)).toEqual([]);
  });

  it('清空了也送（空的），一顆變動都沒有就不送', async () => {
    const run = open(scriptedAgent());
    try {
      await run.pump.submit({ kind: 'message', text: 'A', id: 'a' });
      await run.pump.whenIdle();
      expect(inboxPushes(historyPage(run.pump.sessionLog.events).events)).toEqual([{ items: [] }]);

      const bare = new SessionLog('bare');
      bare.append('turn/start', { kind: 'message', text: '舊日誌' });
      bare.append('turn/end', {});
      expect(inboxPushes(historyPage(bare.events).events)).toEqual([]);
    } finally {
      await run.close();
    }
  });
});

describe('真的組裝：停在核准點時送出的那句', () => {
  function toolsPlugin(probe: { danger: number }): PluginEntry {
    return {
      plugin: {
        name: 'queue-tools',
        apply(registry) {
          registry.tools.register(
            tool(
              () => {
                probe.danger += 1;
                return '危險的事做完了';
              },
              { name: 'danger', description: '要核准。', schema: z.object({}) },
            ),
          );
          registry.approvals.gate((exec, next) =>
            exec.name === 'danger' ? { kind: 'ask', reason: '危險' } : next(),
          );
        },
      },
    };
  }

  it('收下、停住；核准之後那一輪收尾，才跑它，模型讀到的是真結果', async () => {
    const probe = { danger: 0 };
    const model = new ScriptedChatModel({
      turns: [
        { content: '做危險的。', toolCalls: [{ name: 'danger', args: {} }] },
        { content: '第一輪收尾。' },
        { content: '第二句的回覆。' },
      ],
    });
    const built = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      plugins: [toolsPlugin(probe)],
    });
    const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'queue-real');
    const detach = built.attachSession(pump.sessions);
    try {
      await pump.submit({ kind: 'message', text: '第一句' });
      expect(pump.awaitingInput).toBe(true);
      const second = pump.submit({ kind: 'message', text: '第二句' });
      expect(pump.running).toBe(true);
      await pump.whenIdle();
      expect(model.prompts).toHaveLength(1);

      const [pending] = pump.pendings;
      await pump.submit(approve(pending!.interruptId));
      await second;
      await pump.whenIdle();
      expect(probe.danger).toBe(1);
      expect(marks(pump.sessionLog.events)).toEqual([
        'insert:第一句',
        'start:message:第一句',
        'claim',
        'end',
        'insert:第二句',
        'start:resume',
        'end',
        'start:message:第二句',
        'claim',
        'end',
      ]);
      const seen = (model.prompts[2] ?? []).map((message) => message.text).join('\n');
      expect(seen).toContain('危險的事做完了');
      expect(seen).not.toContain('another message came in');
    } finally {
      pump.close();
      detach();
      await built.dispose();
    }
  }, 20000);
});

describe('wire', () => {
  const opened: WireHandler[] = [];
  afterEach(async () => {
    for (const handler of opened.splice(0)) await handler.close();
  });

  function wire(agent: PumpAgent) {
    let pumpLog: (() => readonly SessionEvent[]) | undefined;
    const handler = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      createAgent: async () => ({
        agent,
        commands: emptyCommandPoint(),
        dispose: async () => {},
        attachSession: (sessions) => {
          pumpLog = () => sessions.root.events;
          return () => {};
        },
      }),
    });
    opened.push(handler);
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) =>
      handler.handle(loopbackRequest(input as string, init));
    const client = createWireClient({ baseUrl: 'http://queue.test', fetch });
    let nextId = 1;
    /** `queue.update`：client 還沒有這個方法（web 的 QueueDock 那張才加），直接打路徑。 */
    const queueUpdate = async (thread: string, params: unknown) => {
      const response = await fetch(
        `http://queue.test/threads/${thread}/commands/${QUEUE_UPDATE_METHOD}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: nextId++, method: QUEUE_UPDATE_METHOD, params }),
        },
      );
      return (await response.json()) as Record<string, unknown>;
    };
    return { client, queueUpdate, log: () => pumpLog?.() ?? [] };
  }

  it('run.start 回的 run_id 就是那一件的 id；停在核准點時也收', async () => {
    const hold = gate();
    const { client, log } = wire(scriptedAgent([{ interrupt: 'i1', hold: hold.opened }]));
    const thread = 'queue-wire';
    const first = await client.runStart(thread, '第一句');
    expect(first.type).toBe('success');
    const firstId = (first as { result: { run_id: string } }).result.run_id;
    await until(() => log().some((event) => event.type === 'interrupt/raised'));
    hold.open();
    await until(() => log().some((event) => event.type === 'turn/end'));

    // 停在核准點時送出：照 dsh 收下、排著（#637 的 Q4）。
    const second = await client.runStart(thread, '第二句');
    expect(second.type).toBe('success');
    const secondId = (second as { result: { run_id: string } }).result.run_id;
    const inserted = splices(log()).flatMap((splice) => splice.inserted.map((item) => item.id));
    expect(inserted).toEqual([firstId, secondId]);
  });

  it('queue.update：改、刪回受理；不在隊裡回 queue_item_not_found；空白回 invalid_argument；steer 回 not_supported', async () => {
    const { client, queueUpdate, log } = wire(scriptedAgent([{ interrupt: 'i1' }]));
    const thread = 'queue-update';
    await client.runStart(thread, '第一句');
    await until(() => log().some((event) => event.type === 'turn/end'));
    const queued = await client.runStart(thread, '第二句');
    const id = (queued as { result: { run_id: string } }).result.run_id;

    expect(
      await queueUpdate(thread, { item_id: id, action: { kind: 'edit', text: '改過' } }),
    ).toEqual({ type: 'success', id: expect.any(Number), result: { accepted: true } });
    expect(
      await queueUpdate(thread, { item_id: id, action: { kind: 'edit', text: '  ' } }),
    ).toMatchObject({ type: 'error', error: 'invalid_argument' });
    expect(await queueUpdate(thread, { item_id: id, action: { kind: 'steer' } })).toMatchObject({
      type: 'error',
      error: 'not_supported',
    });
    expect(await queueUpdate(thread, { item_id: id, action: { kind: 'remove' } })).toMatchObject({
      type: 'success',
      result: { accepted: true },
    });
    expect(await queueUpdate(thread, { item_id: id, action: { kind: 'remove' } })).toMatchObject({
      type: 'error',
      error: 'queue_item_not_found',
    });
    expect(
      await queueUpdate(thread, { item_id: 'nope', action: { kind: 'edit', text: 'x' } }),
    ).toMatchObject({ type: 'error', error: 'queue_item_not_found' });
    expect(await queueUpdate(thread, { action: { kind: 'remove' } })).toMatchObject({
      type: 'error',
      error: 'invalid_argument',
    });
    expect(marks(log())).toEqual([
      'insert:第一句',
      'start:message:第一句',
      'claim',
      'end',
      'insert:第二句',
      'edit:改過',
      'remove',
    ]);
  });

  it('run.cancel 之後排著的停住；GET 不到的 thread 上改刪回 queue_item_not_found', async () => {
    const hold = gate();
    const { client, queueUpdate, log } = wire(
      scriptedAgent([{ hold: hold.opened, abortable: true }]),
    );
    const thread = 'queue-cancel';
    await client.runStart(thread, 'A');
    await until(() => log().some((event) => event.type === 'turn/start'));
    await client.runStart(thread, 'B');
    await client.runCancel(thread);
    await until(() => log().some((event) => event.type === 'turn/end'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(marks(log())).toEqual([
      'insert:A',
      'start:message:A',
      'claim',
      'insert:B',
      'end:aborted',
    ]);
    expect(
      await queueUpdate('never-opened', { item_id: 'x', action: { kind: 'remove' } }),
    ).toMatchObject({ type: 'error', error: 'queue_item_not_found' });
  });
});
