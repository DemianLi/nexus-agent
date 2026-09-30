/**
 * 背景子代理用 `send_message` 寫給主對話的話怎麼到主對話（[#849](https://github.com/DemianLi/nexus-agent/issues/849)），
 * pump 這一側。投遞同結算通知（`settle-notice.test.ts`）：閒著→排下一輪並叫醒、忙著→插話、已收線→不喚醒；
 * 差別只在來源是 `agent-message`。**那是 agent 寫的話，不是人說的**：`hasDirectHumanTurn` 因此不給直接人類授權。
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
import type { SessionEvent, StepInbox } from '@nexus/core';
import { hasDirectHumanTurn } from '@nexus/plugin-goal';
import type { Event, InboxPayload } from '@nexus/wire';
import { emptyConversation, encodeSessionReferenceUri, INBOX, reduceAll } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { historyPage } from './conversation-history.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const MESSAGE = {
  text: 'Agent settle-root/bg-1 sent a message: 入口在 A',
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
  it('排進 next-turn、開一輪、領走；turn/start 是 agent-message，模型收到的字與日誌是同一份', async () => {
    const { agent, inputs } = fakeAgent();
    const run = open(agent);
    try {
      run.pump.receiveAgentMessage(MESSAGE);
      await run.pump.whenIdle();
      expect(marks(run.pump.sessionLog.events)).toEqual([
        'insert:next-turn:agent-message',
        'start:agent-message',
        'claim:next-turn',
        'end',
      ]);
      const start = run.pump.sessionLog.events.find((event) => event.type === 'turn/start');
      expect(start?.data).toEqual({ kind: 'agent-message', ...MESSAGE });
      expect(inputs).toEqual([MESSAGE.text]);
    } finally {
      await run.close();
    }
  });

  it('這一輪不是人話：hasDirectHumanTurn 為假，即使更早有過人的話；也不寫退回標題', async () => {
    const { agent } = fakeAgent();
    const run = open(agent);
    try {
      await run.pump.submit({ kind: 'message', text: '嗨' });
      await run.pump.whenIdle();
      expect(hasDirectHumanTurn(run.pump.sessionLog.events)).toBe(true);
      run.pump.receiveAgentMessage(MESSAGE);
      await run.pump.whenIdle();
      expect(hasDirectHumanTurn(run.pump.sessionLog.events)).toBe(false);
      expect(
        run.pump.sessionLog.events.filter((event) => event.type === 'session/title'),
      ).toHaveLength(1);
    } finally {
      await run.close();
    }
  });
});

describe('主對話正跑著', () => {
  it('收插話（載體掛著）：排進 next-step，這一輪下一步領走；user/message 的來源是 agent-message／relay', async () => {
    const hold = gate();
    const { agent, inputs, claimed } = fakeAgent([{ holdBeforeClaim: hold.opened }]);
    const run = open(agent, { stepInbox: true });
    try {
      const first = run.pump.submit({ kind: 'message', text: 'A' });
      await until(() => inputs.length === 1);
      run.pump.receiveAgentMessage(MESSAGE);
      expect(run.pump.nextStep.map((item) => item.source.kind)).toEqual(['agent-message']);
      expect(run.pump.inbox).toEqual([]);
      hold.open();
      await first;
      await run.pump.whenIdle();

      expect(marks(run.pump.sessionLog.events)).toEqual([
        'insert:next-turn:user',
        'start:message',
        'claim:next-turn',
        'insert:next-step:agent-message',
        'claim:next-step',
        'user-message:agent-message',
        'end',
      ]);
      expect(claimed[0]?.map((message) => message.text)).toEqual([MESSAGE.text]);
      const message = run.pump.sessionLog.events.find((event) => event.type === 'user/message');
      expect(message?.data.source).toEqual({
        kind: 'agent-message',
        form: 'relay',
        senderSessionId: MESSAGE.senderSessionId,
      });
      expect(hasDirectHumanTurn(run.pump.sessionLog.events)).toBe(true);
    } finally {
      await run.close();
    }
  });

  it('機器輪次裡插進來的話不算人：拿不到直接人類授權；長得像會話網址的字也不解引用', async () => {
    const hold = gate();
    const { agent, inputs, claimed } = fakeAgent([{ holdBeforeClaim: hold.opened }]);
    const warnings: string[] = [];
    const run = open(agent, { stepInbox: true, warn: (message) => warnings.push(message) });
    try {
      const mention = `@[別條](${encodeSessionReferenceUri('other-thread')})`;
      run.pump.receiveAgentMessage({ ...MESSAGE, senderSessionId: 'settle-root/bg-1' });
      await until(() => inputs.length === 1);
      run.pump.receiveAgentMessage({
        text: `${MESSAGE.text}\n${mention}`,
        senderSessionId: 'settle-root/bg-2',
      });
      hold.open();
      await run.pump.whenIdle();
      expect(claimed[0]?.map((message) => message.text)).toEqual([`${MESSAGE.text}\n${mention}`]);
      expect(warnings).toEqual([]);
      expect(hasDirectHumanTurn(run.pump.sessionLog.events)).toBe(false);
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
      run.pump.receiveAgentMessage(MESSAGE);
      expect(run.pump.nextStep).toEqual([]);
      expect(run.pump.inbox.map((item) => item.source.kind)).toEqual(['user', 'agent-message']);
      hold.open();
      await first;
      await run.pump.whenIdle();
      expect(inputs).toEqual(['A', 'B', MESSAGE.text]);
    } finally {
      await run.close();
    }
  });
});

describe('不喚醒', () => {
  it('這條 thread 已經收了：只落進佇列，不排程、不開輪、不拋；重開之後停住不自己開跑', async () => {
    const { agent, inputs } = fakeAgent();
    const run = open(agent);
    run.pump.close();
    expect(() => run.pump.receiveAgentMessage(MESSAGE)).not.toThrow();
    await run.close();
    expect(inputs).toEqual([]);
    expect(marks(run.pump.sessionLog.events)).toEqual(['insert:next-turn:agent-message']);

    const reopened = fakeAgent();
    const again = open(reopened.agent, { seed: run.pump.sessionLog.events });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(reopened.inputs).toEqual([]);
      expect(again.pump.inbox.map((item) => item.source.kind)).toEqual(['agent-message']);
    } finally {
      await again.close();
    }
  });
});

describe('上線與歷史：不畫人的泡泡', () => {
  it('佇列的推送與領走都帶來源；畫面折出來沒有人的泡泡', async () => {
    const { agent } = fakeAgent();
    const run = open(agent);
    try {
      await run.pump.submit({ kind: 'message', text: '嗨', id: 'h1' });
      await run.pump.whenIdle();
      run.pump.receiveAgentMessage(MESSAGE);
      await run.pump.whenIdle();
      const pushes = inboxPushes(run.frames);
      const inserted = pushes.find((push) =>
        push.items.some((item) => item.source.kind !== 'user'),
      );
      expect(inserted?.items[0]?.source).toEqual({ kind: 'agent-message' });
      const claim = pushes.find((push) => push.claimed?.source !== undefined);
      expect(claim?.claimed?.source).toEqual({ kind: 'agent-message' });
      const state = reduceAll(emptyConversation(), run.frames);
      expect(state.entries.filter((entry) => entry.kind === 'human').map((e) => e.text)).toEqual([
        '嗨',
      ]);
      expect(state.inbox).toEqual([]);
    } finally {
      await run.close();
    }
  });

  it('歷史重播：agent-message 的輪次與插話都不畫人的泡泡', async () => {
    const log = new SessionLog('history');
    log.append('turn/start', { kind: 'message', text: '嗨' });
    log.append('turn/end', {});
    log.append('turn/start', { kind: 'agent-message', ...MESSAGE });
    log.append('user/message', {
      message: toLoggedMessage(new HumanMessage(MESSAGE.text)),
      source: { kind: 'agent-message', form: 'relay', senderSessionId: MESSAGE.senderSessionId },
    });
    log.append('turn/end', {});
    const humans = historyPage(log.events).events.filter(
      (frame) =>
        frame.method === 'messages' && (frame.params.data as { role?: string }).role === 'human',
    );
    expect(humans).toHaveLength(1);
  });
});
