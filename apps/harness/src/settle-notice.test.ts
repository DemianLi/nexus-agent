/**
 * 背景子代理結算的通知怎麼到主對話（[#840](https://github.com/DemianLi/nexus-agent/issues/840)），pump 這一側。
 *
 * 照 dsh 的 `notifySettlement`（`subagent/src/continuation-activation.ts`，`477b4f4`）分三種：閒著→排下一輪並叫醒、
 * 忙著→插話、這條 thread 已經收了→不喚醒。**每一種都不能被讀成人話**：`turn/start` 的 `kind` 與 `user/message` 的
 * `source` 都不是 `message`／`user`，`hasDirectHumanTurn` 因此不給直接人類授權（#152 的底線）。
 *
 * **零憑證、零外部連線**：假 agent。
 */

import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import {
  SessionLog,
  STEP_INBOX_CONFIG_KEY,
  TURN_CANCEL_CONFIG_KEY,
  toLoggedMessage,
} from '@nexus/core';
import type { SessionEvent, StepInbox, SubagentSettleReason } from '@nexus/core';
import { hasDirectHumanTurn } from '@nexus/plugin-goal';
import type { Event, InboxPayload, WireSettleReason } from '@nexus/wire';
import {
  emptyConversation,
  encodeSessionReferenceUri,
  INBOX,
  reduceAll,
  SETTLE_REASONS,
} from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { historyPage } from './conversation-history.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const NOTICE = {
  text: 'Background subagent bg-1 finished and will do no further work unless you send it more.\n\nIts closing message:\n找到三個檔案',
  summary: 'Background subagent bg-1 finished and will do no further work unless you send it more.',
  reason: 'completed' as const,
  senderSessionId: 'settle-root/bg-1',
};

const COMPLETED = {
  type: 'event',
  seq: 0,
  method: 'lifecycle',
  params: { namespace: [], timestamp: 0, data: { event: 'completed', graph_name: 'root' } },
};

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

interface Step {
  /** 領插話之前先等這道門（這一段停在「跑著、還沒到工具邊界」）。 */
  readonly holdBeforeClaim?: Promise<void>;
  /** 收尾前等這道門；`abortable` 時中止訊號一舉就拋。 */
  readonly hold?: Promise<void>;
  readonly abortable?: boolean;
}

/**
 * 照腳本跑的假 agent：記下每一輪收到的第一則訊息，與這一輪領到的插話。
 * 領插話的口只有 pump 掛了載體（`stepInbox: true`）才有。
 */
function fakeAgent(steps: readonly Step[] = []) {
  const inputs: string[] = [];
  const claimed: BaseMessage[][] = [];
  let call = 0;
  const agent = {
    streamEvents: async (
      input: { messages?: BaseMessage[] },
      config: { configurable: Record<string, unknown> },
    ) => {
      const step = steps[call] ?? {};
      call += 1;
      inputs.push(input.messages?.[0]?.text ?? '');
      const inbox = config.configurable[STEP_INBOX_CONFIG_KEY] as StepInbox | undefined;
      const signal = config.configurable[TURN_CANCEL_CONFIG_KEY] as AbortSignal | undefined;
      return (async function* () {
        if (step.holdBeforeClaim !== undefined) await step.holdBeforeClaim;
        if (inbox !== undefined) {
          claimed.push([...(await inbox.claim())]);
          for (;;) {
            const finished = await inbox.finish();
            claimed.push([...finished]);
            if (finished.length === 0) break;
          }
        }
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
  return { agent: agent as unknown as PumpAgent, inputs, claimed };
}

function open(
  agent: PumpAgent,
  options: {
    readonly stepInbox?: boolean;
    readonly seed?: readonly SessionEvent[];
    readonly warn?: (message: string) => void;
  } = {},
) {
  const pump = new ThreadPump(
    agent,
    'settle-root',
    undefined,
    options.seed,
    undefined,
    undefined,
    options.warn,
    options.stepInbox ?? false,
  );
  const frames: Event[] = [];
  const line = new AbortController();
  const stream = pump.subscribe(['messages', 'tools', 'lifecycle', 'input', 'custom'], line.signal);
  const draining = (async () => {
    for await (const frame of stream) frames.push(frame);
  })();
  return {
    pump,
    frames,
    close: async () => {
      pump.close();
      line.abort();
      await draining;
    },
  };
}

/** 開輪與領走的先後，照日誌。 */
function marks(events: readonly SessionEvent[]): string[] {
  return events.flatMap((event) => {
    switch (event.type) {
      case 'turn/start':
        return [`start:${event.data.kind}`];
      case 'turn/end':
        return [event.data.reason?.kind === 'aborted' ? 'end:aborted' : 'end'];
      case 'inbox/spliced': {
        const splice = event.data;
        const what = splice.inserted.map((item) => item.source.kind).join(',');
        if (splice.removedCount === undefined) return [`insert:${splice.target}:${what}`];
        return [`claim:${splice.target}`];
      }
      case 'user/message':
        return [`user-message:${event.data.source.kind}`];
      default:
        return [];
    }
  });
}

const inboxPushes = (frames: readonly Event[]): InboxPayload[] =>
  frames.flatMap((frame) => {
    const data = frame.params.data as { name?: unknown; payload?: unknown } | null;
    return frame.method === 'custom' && data?.name === INBOX ? [data.payload as InboxPayload] : [];
  });

describe('主對話閒著：叫醒它開一輪', () => {
  it('排進 next-turn、開一輪、領走；turn/start 是 subagent-settled，模型收到的字與日誌是同一份', async () => {
    const { agent, inputs } = fakeAgent();
    const run = open(agent);
    try {
      run.pump.notifySettled(NOTICE);
      await run.pump.whenIdle();
      expect(marks(run.pump.sessionLog.events)).toEqual([
        'insert:next-turn:subagent-settled',
        'start:subagent-settled',
        'claim:next-turn',
        'end',
      ]);
      const start = run.pump.sessionLog.events.find((event) => event.type === 'turn/start');
      expect(start?.data).toEqual({ kind: 'subagent-settled', ...NOTICE });
      expect(inputs).toEqual([NOTICE.text]);
    } finally {
      await run.close();
    }
  });

  it('這一輪不是人話：hasDirectHumanTurn 為假，即使更早有過人的話', async () => {
    const { agent } = fakeAgent();
    const run = open(agent);
    try {
      await run.pump.submit({ kind: 'message', text: '嗨' });
      await run.pump.whenIdle();
      expect(hasDirectHumanTurn(run.pump.sessionLog.events)).toBe(true);
      run.pump.notifySettled(NOTICE);
      await run.pump.whenIdle();
      expect(hasDirectHumanTurn(run.pump.sessionLog.events)).toBe(false);
    } finally {
      await run.close();
    }
  });

  it('不寫退回標題：通知那一輪的字不是使用者打的', async () => {
    const { agent } = fakeAgent();
    const run = open(agent);
    try {
      run.pump.notifySettled(NOTICE);
      await run.pump.whenIdle();
      expect(run.pump.sessionLog.events.some((event) => event.type === 'session/title')).toBe(
        false,
      );
    } finally {
      await run.close();
    }
  });
});

describe('主對話正跑著', () => {
  it('收插話（載體掛著）：排進 next-step，這一輪下一步領走、不開新的一輪；user/message 的來源不是 user', async () => {
    const hold = gate();
    const { agent, inputs, claimed } = fakeAgent([{ holdBeforeClaim: hold.opened }]);
    const run = open(agent, { stepInbox: true });
    try {
      const first = run.pump.submit({ kind: 'message', text: 'A' });
      await until(() => inputs.length === 1);
      run.pump.notifySettled(NOTICE);
      expect(run.pump.nextStep.map((item) => item.source.kind)).toEqual(['subagent-settled']);
      expect(run.pump.inbox).toEqual([]);
      hold.open();
      await first;
      await run.pump.whenIdle();

      expect(marks(run.pump.sessionLog.events)).toEqual([
        'insert:next-turn:user',
        'start:message',
        'claim:next-turn',
        'insert:next-step:subagent-settled',
        'claim:next-step',
        'user-message:subagent-settled',
        'end',
      ]);
      expect(inputs).toEqual(['A']);
      expect(claimed[0]?.map((message) => message.text)).toEqual([NOTICE.text]);
      const message = run.pump.sessionLog.events.find((event) => event.type === 'user/message');
      expect(message?.data.source).toEqual({
        kind: 'subagent-settled',
        form: 'notice',
        summary: NOTICE.summary,
        reason: 'completed',
        senderSessionId: NOTICE.senderSessionId,
      });
      // 這一輪是人開的，人仍在這條鏈後面；通知本身不替它背書也不替它撤銷。
      expect(hasDirectHumanTurn(run.pump.sessionLog.events)).toBe(true);
    } finally {
      await run.close();
    }
  });

  it('通知的插話不算人：續行式的機器輪次裡只有通知的話，拿不到直接人類授權', async () => {
    const hold = gate();
    const { agent, inputs } = fakeAgent([{ holdBeforeClaim: hold.opened }]);
    const run = open(agent, { stepInbox: true });
    try {
      // 用通知自己開的一輪（不是人開的）：跑著的時候再來一則通知走插話。
      run.pump.notifySettled({ ...NOTICE, senderSessionId: 'settle-root/bg-1' });
      await until(() => inputs.length === 1);
      run.pump.notifySettled({ ...NOTICE, senderSessionId: 'settle-root/bg-2' });
      hold.open();
      await run.pump.whenIdle();
      expect(marks(run.pump.sessionLog.events)).toContain('user-message:subagent-settled');
      expect(hasDirectHumanTurn(run.pump.sessionLog.events)).toBe(false);
    } finally {
      await run.close();
    }
  });

  it('通知裡長得像會話網址的字不解引用：那是子代理寫的，不是使用者的 @', async () => {
    const hold = gate();
    const { agent, inputs, claimed } = fakeAgent([{ holdBeforeClaim: hold.opened }]);
    const warnings: string[] = [];
    const run = open(agent, { stepInbox: true, warn: (message) => warnings.push(message) });
    try {
      const mention = `@[別條](${encodeSessionReferenceUri('other-thread')})`;
      const first = run.pump.submit({ kind: 'message', text: 'A' });
      await until(() => inputs.length === 1);
      run.pump.notifySettled({ ...NOTICE, text: `${NOTICE.text}\n${mention}` });
      hold.open();
      await first;
      await run.pump.whenIdle();
      expect(claimed[0]?.map((message) => message.text)).toEqual([`${NOTICE.text}\n${mention}`]);
      // 走了解析的話，這條 thread 沒接讀會話的載體，會講一聲「沒有展開」。
      expect(warnings).toEqual([]);
    } finally {
      await run.close();
    }
  });

  it('不收插話（沒掛載體）：退成排隊，排在已排著的後面，各自成一輪', async () => {
    const hold = gate();
    const { agent, inputs } = fakeAgent([{ hold: hold.opened }]);
    const run = open(agent, { stepInbox: false });
    try {
      const first = run.pump.submit({ kind: 'message', text: 'A', id: 'a' });
      await until(() => inputs.length === 1);
      void run.pump.submit({ kind: 'message', text: 'B', id: 'b' }).catch(() => undefined);
      run.pump.notifySettled(NOTICE);
      expect(run.pump.nextStep).toEqual([]);
      expect(run.pump.inbox.map((item) => item.source.kind)).toEqual(['user', 'subagent-settled']);
      hold.open();
      await first;
      await run.pump.whenIdle();
      expect(inputs).toEqual(['A', 'B', NOTICE.text]);
      expect(marks(run.pump.sessionLog.events).filter((mark) => mark.startsWith('start:'))).toEqual(
        ['start:message', 'start:message', 'start:subagent-settled'],
      );
    } finally {
      await run.close();
    }
  });
});

describe('不喚醒', () => {
  it('按了停止之後停住的佇列：通知排在後面、不放行——要等人下一次送出', async () => {
    const hold = gate();
    const { agent, inputs } = fakeAgent([{ hold: hold.opened, abortable: true }]);
    const run = open(agent);
    try {
      const first = run.pump.submit({ kind: 'message', text: 'A', id: 'a' });
      await until(() => inputs.length === 1);
      void run.pump.submit({ kind: 'message', text: 'B', id: 'b' }).catch(() => undefined);
      expect(run.pump.cancel()).toBe('run');
      await first;
      await run.pump.whenIdle();
      run.pump.notifySettled(NOTICE);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(inputs).toEqual(['A']);
      expect(run.pump.inbox.map((item) => item.source.kind)).toEqual(['user', 'subagent-settled']);
      // 人下一次送出才放行，照 FIFO：B、通知、C。
      await run.pump.submit({ kind: 'message', text: 'C', id: 'c' });
      await run.pump.whenIdle();
      expect(inputs).toEqual(['A', 'B', NOTICE.text, 'C']);
    } finally {
      await run.close();
    }
  });

  it('停止時沒有東西停住：通知照常叫醒閒著的主對話（dsh：喚醒 idle 的 agent 是開一輪）', async () => {
    const hold = gate();
    const { agent, inputs } = fakeAgent([{ hold: hold.opened, abortable: true }]);
    const run = open(agent);
    try {
      const first = run.pump.submit({ kind: 'message', text: 'A', id: 'a' });
      await until(() => inputs.length === 1);
      expect(run.pump.cancel()).toBe('run');
      await first;
      await run.pump.whenIdle();
      run.pump.notifySettled(NOTICE);
      await run.pump.whenIdle();
      expect(inputs).toEqual(['A', NOTICE.text]);
    } finally {
      await run.close();
    }
  });

  it('這條 thread 已經收了：只落進佇列，不排程、不開輪、不拋；重開之後折回來是停住的', async () => {
    const { agent, inputs } = fakeAgent();
    const run = open(agent);
    run.pump.close();
    expect(() => run.pump.notifySettled(NOTICE)).not.toThrow();
    await run.close();
    expect(inputs).toEqual([]);
    expect(marks(run.pump.sessionLog.events)).toEqual(['insert:next-turn:subagent-settled']);

    // 重開：日誌折回來，佇列裡有那一件、停住不自己開跑。
    const reopened = fakeAgent();
    const seed = run.pump.sessionLog.events;
    const again = open(reopened.agent, { seed });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(reopened.inputs).toEqual([]);
      expect(again.pump.inbox.map((item) => item.source.kind)).toEqual(['subagent-settled']);
    } finally {
      await again.close();
    }
  });
});

describe('上線與歷史：不畫人的泡泡', () => {
  it('佇列的推送帶來源，領走那一顆的 claimed 也帶；畫面折出來沒有人的泡泡', async () => {
    const { agent } = fakeAgent();
    const run = open(agent);
    try {
      await run.pump.submit({ kind: 'message', text: '嗨', id: 'h1' });
      await run.pump.whenIdle();
      run.pump.notifySettled(NOTICE);
      await run.pump.whenIdle();
      const pushes = inboxPushes(run.frames);
      const inserted = pushes.find((push) =>
        push.items.some((item) => item.source.kind !== 'user'),
      );
      expect(inserted?.items[0]?.source).toEqual({ kind: 'subagent-settled', reason: 'completed' });
      const claim = pushes.find((push) => push.claimed?.source !== undefined);
      expect(claim?.claimed?.source).toEqual({ kind: 'subagent-settled', reason: 'completed' });
      // 人的那一顆 claimed 不帶 source（沒帶就是人，舊的一側照舊）。
      expect(pushes.find((push) => push.claimed?.id === 'h1')?.claimed).not.toHaveProperty(
        'source',
      );

      const state = reduceAll(emptyConversation(), run.frames);
      const humans = state.entries.filter((entry) => entry.kind === 'human');
      expect(humans.map((entry) => entry.text)).toEqual(['嗨']);
      expect(state.inbox).toEqual([]);
    } finally {
      await run.close();
    }
  });

  it('歷史重播：通知那一輪是一輪的開頭，但不畫人的泡泡；插話領走的那則也不畫', async () => {
    const log = new SessionLog('history');
    log.append('turn/start', { kind: 'message', text: '嗨' });
    log.append('turn/end', {});
    log.append('turn/start', { kind: 'subagent-settled', ...NOTICE });
    log.append('user/message', {
      message: toLoggedMessage(new HumanMessage(NOTICE.text)),
      source: {
        kind: 'subagent-settled',
        form: 'notice',
        summary: NOTICE.summary,
        senderSessionId: NOTICE.senderSessionId,
      },
    });
    log.append('turn/end', {});
    const humans = historyPage(log.events).events.filter(
      (frame) =>
        frame.method === 'messages' && (frame.params.data as { role?: string }).role === 'human',
    );
    expect(humans).toHaveLength(1);
  });
});

describe('通知長成畫面上的一格，即時與歷史一致（#851）', () => {
  /** 折出來的畫面，只留判別欄：id 兩邊本來就不同（即時 `inbox:<id>`、歷史 `history-<seq>`）。 */
  const shape = (frames: readonly Event[]) =>
    reduceAll(emptyConversation(), frames).entries.map((entry) =>
      entry.kind === 'notice' ? `notice:${entry.source}` : entry.kind,
    );

  it('叫醒閒著的主對話：人的話、通知，重新整理後同一個順序', async () => {
    const { agent } = fakeAgent();
    const run = open(agent);
    try {
      await run.pump.submit({ kind: 'message', text: '嗨', id: 'h1' });
      await run.pump.whenIdle();
      run.pump.notifySettled(NOTICE);
      await run.pump.whenIdle();
      const live = shape(run.frames);
      expect(live).toEqual(['human', 'notice:subagent-settled']);
      expect(shape(historyPage(run.pump.sessionLog.events).events)).toEqual(live);
      // 即時那格的 id 跟排著時那一行是同一個 key（`inbox:<件的 id>`）。
      const entry = reduceAll(emptyConversation(), run.frames).entries.at(-1);
      expect(entry).toMatchObject({ kind: 'notice', inboxId: expect.any(String) });
      expect(entry?.id).toBe(`inbox:${(entry as { inboxId: string }).inboxId}`);
    } finally {
      await run.close();
    }
  });

  it('輪中插進來的通知：落在那一輪裡插進來的那一刻，歷史同一個順序', async () => {
    const hold = gate();
    const { agent, inputs } = fakeAgent([{ holdBeforeClaim: hold.opened }]);
    const run = open(agent, { stepInbox: true });
    try {
      const first = run.pump.submit({ kind: 'message', text: 'A', id: 'a' });
      await until(() => inputs.length === 1);
      run.pump.notifySettled(NOTICE);
      hold.open();
      await first;
      await run.pump.whenIdle();
      const live = shape(run.frames);
      expect(live).toEqual(['human', 'notice:subagent-settled']);
      expect(shape(historyPage(run.pump.sessionLog.events).events)).toEqual(live);
    } finally {
      await run.close();
    }
  });
});

describe('通知帶上怎麼收的，即時、排隊中與歷史一致（#884）', () => {
  const REASONS = ['completed', 'aborted', 'max-tokens', 'error'] as const;
  const noticeReasons = (frames: readonly Event[]) =>
    reduceAll(emptyConversation(), frames).entries.flatMap((entry) =>
      entry.kind === 'notice' ? [entry.reason ?? 'none'] : [],
    );

  it.each(REASONS)('%s：叫醒閒著的主對話，即時與歷史都長出這個原因', async (reason) => {
    const { agent } = fakeAgent();
    const run = open(agent);
    try {
      run.pump.notifySettled({ ...NOTICE, reason });
      await run.pump.whenIdle();
      expect(noticeReasons(run.frames)).toEqual([reason]);
      expect(noticeReasons(historyPage(run.pump.sessionLog.events).events)).toEqual([reason]);
      const start = run.pump.sessionLog.events.find((event) => event.type === 'turn/start');
      expect(start?.data).toMatchObject({ kind: 'subagent-settled', reason });
    } finally {
      await run.close();
    }
  });

  it.each(REASONS)('%s：輪中插進來，即時與歷史都長出這個原因', async (reason) => {
    const hold = gate();
    const { agent, inputs } = fakeAgent([{ holdBeforeClaim: hold.opened }]);
    const run = open(agent, { stepInbox: true });
    try {
      const first = run.pump.submit({ kind: 'message', text: 'A', id: 'a' });
      await until(() => inputs.length === 1);
      run.pump.notifySettled({ ...NOTICE, reason });
      hold.open();
      await first;
      await run.pump.whenIdle();
      expect(noticeReasons(run.frames)).toEqual([reason]);
      expect(noticeReasons(historyPage(run.pump.sessionLog.events).events)).toEqual([reason]);
      const message = run.pump.sessionLog.events.find((event) => event.type === 'user/message');
      expect(message?.data.source).toMatchObject({ kind: 'subagent-settled', reason });
    } finally {
      await run.close();
    }
  });

  it('排隊中那一行也帶原因，領走之後同一格換成正式的通知、原因不變', async () => {
    const hold = gate();
    const { agent, inputs } = fakeAgent([{ hold: hold.opened }]);
    const run = open(agent, { stepInbox: false });
    try {
      const first = run.pump.submit({ kind: 'message', text: 'A', id: 'a' });
      await until(() => inputs.length === 1);
      run.pump.notifySettled({ ...NOTICE, reason: 'aborted' });
      await until(() => reduceAll(emptyConversation(), run.frames).inbox.length > 0);
      const queued = reduceAll(emptyConversation(), run.frames).inbox;
      expect(queued.map((item) => item.source)).toEqual([
        { kind: 'subagent-settled', reason: 'aborted' },
      ]);
      hold.open();
      await first;
      await run.pump.whenIdle();
      const state = reduceAll(emptyConversation(), run.frames);
      expect(state.inbox).toEqual([]);
      expect(noticeReasons(run.frames)).toEqual(['aborted']);
    } finally {
      await run.close();
    }
  });

  it('舊日誌（沒有 reason）：歷史長出沒有原因的通知，不假裝成完成', () => {
    const log = new SessionLog('legacy');
    log.append('turn/start', {
      kind: 'subagent-settled',
      text: NOTICE.text,
      summary: NOTICE.summary,
      senderSessionId: NOTICE.senderSessionId,
    });
    log.append('turn/end', {});
    expect(noticeReasons(historyPage(log.events).events)).toEqual(['none']);
  });

  it('認不得的原因（壞資料、未來的值）當作沒有，不原樣畫上去', () => {
    const frames: Event[] = [
      {
        type: 'event',
        seq: 0,
        method: 'custom',
        params: {
          namespace: [],
          timestamp: 0,
          data: { name: 'subagent/settle-notice', payload: { id: 'x', reason: 'exploded' } },
        },
      },
    ];
    expect(noticeReasons(frames)).toEqual(['none']);
  });

  it('wire 的原因列舉與 core 的 SubagentSettleReason 是同一組', () => {
    // 兩個方向都釘：任何一邊加或減一個成員，這一行編不過。
    const fromWire: readonly SubagentSettleReason[] = SETTLE_REASONS;
    const fromCore: readonly WireSettleReason[] = [
      'completed',
      'aborted',
      'max-tokens',
      'error',
    ] satisfies readonly SubagentSettleReason[];
    expect([...fromWire].sort()).toEqual([...fromCore].sort());
    const exhaustive = (reason: SubagentSettleReason): WireSettleReason => reason;
    expect(REASONS.map(exhaustive)).toEqual([...REASONS]);
  });
});

describe('子代理寄來的話長成畫面上的一格，即時與歷史一致（#863）', () => {
  const SENDER = 'settle-root/bg-7';
  const WORDS = '三個檔案都看過了，結論在 notes.md';
  const FULL = `Agent ${SENDER} sent a message: ${WORDS}`;

  /** 折出來的畫面，只留判別欄與內容：id 兩邊本來就不同。 */
  const shape = (frames: readonly Event[]) =>
    reduceAll(emptyConversation(), frames).entries.map((entry) =>
      entry.kind === 'agent-message'
        ? `agent-message:${entry.runId}:${entry.senderSessionId}:${entry.text}`
        : entry.kind,
    );

  it('叫醒閒著的主對話：畫面拿到拿掉英文前綴的話與寄件人編號，重新整理後同一個順序', async () => {
    const { agent } = fakeAgent();
    const run = open(agent);
    try {
      await run.pump.submit({ kind: 'message', text: '嗨', id: 'h1' });
      await run.pump.whenIdle();
      run.pump.receiveAgentMessage({ text: FULL, senderSessionId: SENDER });
      await run.pump.whenIdle();
      const live = shape(run.frames);
      expect(live).toEqual(['human', `agent-message:bg-7:${SENDER}:${WORDS}`]);
      expect(shape(historyPage(run.pump.sessionLog.events).events)).toEqual(live);
      // 即時那格的 id 跟排著時那一行是同一個 key；不是人的泡泡。
      const entry = reduceAll(emptyConversation(), run.frames).entries.at(-1);
      expect(entry).toMatchObject({ kind: 'agent-message', inboxId: expect.any(String) });
      expect(entry?.id).toBe(`inbox:${(entry as { inboxId: string }).inboxId}`);
      // 線上的 claimed 帶寄件人；模型收到的整段字仍含前綴（日誌是同一份）。
      const claim = inboxPushes(run.frames).find((push) => push.claimed?.source !== undefined);
      expect(claim?.claimed).toMatchObject({
        text: WORDS,
        source: { kind: 'agent-message', senderSessionId: SENDER, runId: 'bg-7' },
      });
      const start = run.pump.sessionLog.events.findLast((event) => event.type === 'turn/start');
      expect(start?.data).toMatchObject({ kind: 'agent-message', text: FULL });
    } finally {
      await run.close();
    }
  });

  it('輪中插進來的話：落在插進來的那一刻，歷史同一個順序', async () => {
    const hold = gate();
    const { agent, inputs } = fakeAgent([{ holdBeforeClaim: hold.opened }]);
    const run = open(agent, { stepInbox: true });
    try {
      const first = run.pump.submit({ kind: 'message', text: 'A', id: 'a' });
      await until(() => inputs.length === 1);
      run.pump.receiveAgentMessage({ text: FULL, senderSessionId: SENDER });
      hold.open();
      await first;
      await run.pump.whenIdle();
      const live = shape(run.frames);
      expect(live).toEqual(['human', `agent-message:bg-7:${SENDER}:${WORDS}`]);
      expect(shape(historyPage(run.pump.sessionLog.events).events)).toEqual(live);
    } finally {
      await run.close();
    }
  });

  it('排著的清單裡這一件的字也拿掉前綴，來源只有判別欄', async () => {
    const hold = gate();
    const { agent, inputs } = fakeAgent([{ holdBeforeClaim: hold.opened }]);
    const run = open(agent, { stepInbox: true });
    try {
      const first = run.pump.submit({ kind: 'message', text: 'A', id: 'a' });
      await until(() => inputs.length === 1);
      run.pump.receiveAgentMessage({ text: FULL, senderSessionId: SENDER });
      await until(() => inboxPushes(run.frames).some((push) => (push.nextStep ?? []).length > 0));
      const queued = inboxPushes(run.frames).find((push) => (push.nextStep ?? []).length > 0);
      expect(queued?.nextStep?.[0]).toMatchObject({
        text: WORDS,
        source: { kind: 'agent-message' },
      });
      hold.open();
      await first;
      await run.pump.whenIdle();
    } finally {
      await run.close();
    }
  });

  it('不是這個寄件人的前綴就原樣給（不猜）', async () => {
    const { agent } = fakeAgent();
    const run = open(agent);
    try {
      run.pump.receiveAgentMessage({
        text: 'Agent other sent a message: 嗨',
        senderSessionId: SENDER,
      });
      await run.pump.whenIdle();
      const entry = reduceAll(emptyConversation(), run.frames).entries.at(-1);
      expect(entry).toMatchObject({
        kind: 'agent-message',
        text: 'Agent other sent a message: 嗨',
      });
    } finally {
      await run.close();
    }
  });
});
