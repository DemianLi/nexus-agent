/**
 * **插話**——[#710](https://github.com/DemianLi/nexus-agent/issues/710) 的驗收。
 *
 * 照 dsh（`packages/core/agent-loop/src/agent.ts`、`inbox.ts`，`477b4f4`）：一輪跑著時人插的話進 `next-step`，這一輪不停，
 * 下一次叫模型之前整條領走送進模型；模型說完了但還有插話時同一輪再叫一次模型。中止之後的插話進 `next-turn`；按停止時
 * 排著的插話留著，下一輪開頭領走。
 *
 * 三層：
 *
 * - **真的組裝**（`createNexusAgent({ stepInbox: true })`＋`ScriptedChatModel`）：模型真的讀到了什麼、一輪幾顆
 *   `turn/start`／`turn/end`、日誌的先後、推回模型等不等於 checkpoint。插話從工具本體或模型呼叫剛回來的那一刻送，
 *   那是「跑著的這一輪」唯一排得準的兩個時刻。
 * - **假 agent**：它照 `configurable` 裡的領取口 `claim`／`finish`，排得出「圖已經關窗、pump 還沒寫 `turn/end`」那一刻。
 * - **wire**：`run.start` 的 `mode`、`queue.update` 的 `steer`。
 *
 * **零憑證、零外部連線**。
 */

import { tool } from '@langchain/core/tools';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { replayConversation, STEP_INBOX_CONFIG_KEY, SessionLog } from '@nexus/core';
import type { InboxSplice, PluginEntry, SessionEvent, StepInbox } from '@nexus/core';
import type { Event, InboxPayload } from '@nexus/wire';
import { createWireClient, emptyConversation, INBOX, reduceAll } from '@nexus/wire';
import { createMiddleware } from 'langchain';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { historyPage } from './conversation-history.js';
import {
  emptyCommandPoint,
  loopbackRequest,
  shippedPlugins,
  TEST_BROWSER_AUTH,
} from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent, PumpInput } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { WireHandler } from './wire-handler.js';

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

const steer = (text: string, id: string): PumpInput => ({ kind: 'message', text, id, steer: true });

const approve = (interruptId: string): PumpInput => ({
  kind: 'resume',
  interruptId,
  response: { decisions: [{ type: 'approve' }] },
});

/**
 * 日誌的骨架：一輪的邊界、收件匣的變動（哪一條、做了什麼）、人插的話、模型呼叫與回覆，照順序。
 */
function marks(events: readonly SessionEvent[]): string[] {
  return events.flatMap((event) => {
    switch (event.type) {
      case 'turn/start': {
        const data = event.data as { kind: string; text?: string };
        return [`start:${data.kind}${data.text === undefined ? '' : `:${data.text}`}`];
      }
      case 'turn/end':
        return [event.data.reason?.kind === 'aborted' ? 'end:aborted' : 'end'];
      case 'inbox/spliced': {
        const { target, removedCount, inserted, outcome } = event.data;
        const list = target === 'next-step' ? 'step' : 'turn';
        const texts = inserted.map((item) => item.text).join(',');
        if (removedCount === undefined) return [`${list}+${texts}`];
        if (outcome !== 'canceled') return [`${list}:claim${removedCount}`];
        return [texts === '' ? `${list}:remove` : `${list}:edit:${texts}`];
      }
      case 'user/message':
        return event.data.source.kind === 'user'
          ? [`steer:${String(event.data.message.data.content)}`]
          : event.data.source.kind === 'plugin'
            ? [`injected:${event.data.source.plugin}`]
            : ['snapshot'];
      case 'model/start':
        return ['model'];
      default:
        return [];
    }
  });
}

/** 人看得到的訊息：模型讀到的 prompt 裡的人話，照順序。 */
function humanTexts(prompt: readonly BaseMessage[] | undefined): string[] {
  return (prompt ?? []).filter((message) => message.getType() === 'human').map((m) => m.text);
}

function inboxPushes(frames: readonly Event[]): InboxPayload[] {
  return frames.flatMap((frame) => {
    const data = frame.params.data as { name?: unknown; payload?: unknown } | null;
    return frame.method === 'custom' && data?.name === INBOX ? [data.payload as InboxPayload] : [];
  });
}

interface Hooks {
  /** 工具本體跑到一半：第幾次呼叫 `poke`。 */
  onPoke?: (call: number) => void;
  /** 第幾次模型呼叫剛回來、圖還沒往下走。 */
  afterModelCall?: (call: number) => void;
}

/** 從工具本體與模型呼叫剛回來的那一刻插話的外掛：跑著的這一輪裡唯一排得準的兩個時刻。 */
function triggerPlugin(
  hooks: Hooks,
  extra?: (registry: Parameters<PluginEntry['plugin']['apply']>[0]) => void,
): PluginEntry {
  let pokes = 0;
  let calls = 0;
  return {
    plugin: {
      name: 'steer-trigger',
      apply(registry) {
        registry.tools.register(
          tool(
            async () => {
              pokes += 1;
              hooks.onPoke?.(pokes);
              return 'poked';
            },
            { name: 'poke', description: '戳一下。', schema: z.object({}) },
          ),
        );
        registry.middleware.use(
          createMiddleware({
            name: 'steerTrigger',
            wrapModelCall: async (request, handler) => {
              const result = await handler(request);
              calls += 1;
              hooks.afterModelCall?.(calls);
              return result;
            },
          }),
        );
        extra?.(registry);
      },
    },
  };
}

/** 真的組裝加一條 pump，下行訂全部 channel。 */
async function assemble(
  turns: readonly ScriptedTurn[],
  hooks: Hooks,
  options: {
    readonly stepInbox?: boolean;
    readonly shipped?: boolean;
    readonly extra?: Parameters<typeof triggerPlugin>[1];
  } = {},
) {
  const model = new ScriptedChatModel({ turns });
  const stepInbox = options.stepInbox ?? true;
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    plugins: [
      ...(options.shipped === true ? await shippedPlugins() : []),
      triggerPlugin(hooks, options.extra),
    ],
    stepInbox,
  });
  expect(built.stepInbox).toBe(stepInbox);
  const pump = new ThreadPump(
    built.agent as unknown as PumpAgent,
    'steer',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    built.stepInbox,
  );
  const detach = built.attachSession(pump.sessions);
  const frames: Event[] = [];
  const line = new AbortController();
  const stream = pump.subscribe(['messages', 'tools', 'lifecycle', 'input', 'custom'], line.signal);
  const draining = (async () => {
    for await (const frame of stream) frames.push(frame);
  })();
  return {
    model,
    built,
    pump,
    frames,
    marks: () => marks(pump.sessionLog.events),
    close: async () => {
      pump.close();
      line.abort();
      await draining;
      detach();
      await built.dispose();
    },
  };
}

const POKE: ScriptedTurn = { content: '', toolCalls: [{ name: 'poke', args: {} }] };

describe('真的組裝：跑著的這一輪收插話', () => {
  it('工具跑著時插話：同一輪、下一次模型呼叫讀得到，日誌先領走再記人話', async () => {
    const run = await assemble([POKE, { content: '收到' }], {
      onPoke: () => void run.pump.submit(steer('改用 X', 's1')),
    });
    try {
      await run.pump.submit({ kind: 'message', text: '開始', id: 'm1' });
      await run.pump.whenIdle();
      expect(run.model.prompts).toHaveLength(2);
      expect(humanTexts(run.model.prompts[1])).toEqual(['開始', '改用 X']);
      // 插話排在那顆工具結果後面：模型看到的順序就是它發生的順序。
      expect(
        run.model.prompts[1]!.map((message) => message.getType()).filter(
          (type) => type !== 'system',
        ),
      ).toEqual(['human', 'ai', 'tool', 'human']);
      expect(run.marks()).toEqual([
        'turn+開始',
        'start:message:開始',
        'turn:claim1',
        'model',
        'step+改用 X',
        'step:claim1',
        'steer:改用 X',
        'model',
        'end',
      ]);
      expect(run.pump.nextStep).toEqual([]);
    } finally {
      await run.close();
    }
  }, 20000);

  it('模型說完時還有插話：同一輪再叫一次模型，turn/end 只有一顆（出貨清單全掛上）', async () => {
    const run = await assemble(
      [{ content: '說完了' }, { content: '收到插話' }],
      {
        afterModelCall: (call) => void (call === 1 && run.pump.submit(steer('那個檔先別動', 's1'))),
      },
      { shipped: true },
    );
    try {
      await run.pump.submit({ kind: 'message', text: '開始', id: 'm1' });
      await run.pump.whenIdle();
      expect(run.model.prompts).toHaveLength(2);
      expect(humanTexts(run.model.prompts[1]).at(-1)).toBe('那個檔先別動');
      const skeleton = run.marks();
      expect(skeleton.filter((mark) => mark.startsWith('start:'))).toHaveLength(1);
      expect(skeleton.filter((mark) => mark.startsWith('end'))).toEqual(['end']);
      expect(skeleton.slice(skeleton.indexOf('step+那個檔先別動'))).toEqual([
        'step+那個檔先別動',
        'step:claim1',
        'steer:那個檔先別動',
        'model',
        'end',
      ]);
    } finally {
      await run.close();
    }
  }, 20000);

  it('收尾時領走了插話：窗還開著，之後到的插話仍屬於這一輪（同一輪三次模型呼叫）', async () => {
    const run = await assemble([{ content: '一' }, { content: '二' }, { content: '三' }], {
      afterModelCall: (call) => {
        if (call === 1) void run.pump.submit(steer('第一句插話', 's1'));
        if (call === 2) void run.pump.submit(steer('第二句插話', 's2'));
      },
    });
    try {
      await run.pump.submit({ kind: 'message', text: '開始', id: 'm1' });
      await run.pump.whenIdle();
      expect(run.model.prompts).toHaveLength(3);
      expect(humanTexts(run.model.prompts[2])).toEqual(['開始', '第一句插話', '第二句插話']);
      const skeleton = run.marks();
      expect(skeleton.filter((mark) => mark.startsWith('start:'))).toHaveLength(1);
      expect(skeleton.filter((mark) => mark.startsWith('end'))).toEqual(['end']);
    } finally {
      await run.close();
    }
  }, 20000);

  it('推回模型的那一串等於 checkpoint：插話的位置與 id 都對得上', async () => {
    const run = await assemble([POKE, { content: '說完了' }, { content: '都收到' }], {
      onPoke: () => void run.pump.submit(steer('工具時插的', 's1')),
      afterModelCall: (call) => void (call === 2 && run.pump.submit(steer('說完時插的', 's2'))),
    });
    try {
      await run.pump.submit({ kind: 'message', text: '開始', id: 'm1' });
      await run.pump.whenIdle();
      const state = (await run.built.agent.getState({
        configurable: { thread_id: 'steer' },
      })) as { values: { messages: BaseMessage[] } };
      const replay = replayConversation(run.pump.sessionLog.events);
      expect(replay.kind).toBe('replayed');
      const shape = (messages: readonly BaseMessage[]) =>
        messages.map((message) => `${message.getType()}:${message.text}`);
      const replayed = (replay as { messages: readonly BaseMessage[] }).messages;
      expect(shape(replayed)).toEqual(shape(state.values.messages));
      const steers = (messages: readonly BaseMessage[]) =>
        messages.filter((m) => m.getType() === 'human').map((m) => m.id);
      expect(steers(replayed).slice(1)).toEqual(['s1', 's2']);
      expect(steers(state.values.messages).slice(1)).toEqual(['s1', 's2']);
    } finally {
      await run.close();
    }
  }, 20000);

  it('推送：插進來、領走各一顆，領走那顆帶 claimedNextStep；即時折疊畫出人的泡泡', async () => {
    const run = await assemble([POKE, { content: '收到' }], {
      onPoke: () => void run.pump.submit(steer('改用 X', 's1')),
    });
    try {
      await run.pump.submit({ kind: 'message', text: '開始', id: 'm1' });
      await run.pump.whenIdle();
      await until(() => inboxPushes(run.frames).length === 4);
      const pushes = inboxPushes(run.frames);
      expect(pushes.slice(2)).toEqual([
        { items: [], nextStep: [{ id: 's1', text: '改用 X', source: { kind: 'user' } }] },
        { items: [], nextStep: [], claimedNextStep: [{ id: 's1', text: '改用 X' }] },
      ]);
      const state = reduceAll(emptyConversation(), run.frames);
      const humans = state.entries.filter((entry) => entry.kind === 'human');
      expect(humans.map((entry) => (entry as { text: string }).text)).toEqual(['開始', '改用 X']);
      expect(state.inboxNextStep).toEqual([]);
    } finally {
      await run.close();
    }
  }, 20000);

  it('歷史：插的話畫成人的訊息，外掛塞的不畫', async () => {
    const run = await assemble([POKE, { content: '收到' }], {
      onPoke: () => void run.pump.submit(steer('改用 X', 's1')),
    });
    try {
      await run.pump.submit({ kind: 'message', text: '開始', id: 'm1' });
      await run.pump.whenIdle();
      const log = new SessionLog('history', { seed: run.pump.sessionLog.events });
      log.append('user/message', {
        message: { type: 'human', data: { content: '外掛塞的', additional_kwargs: {} } },
        source: { kind: 'plugin', plugin: 'x' },
      } as never);
      const state = reduceAll(emptyConversation(), historyPage(log.events).events);
      const humans = state.entries.filter((entry) => entry.kind === 'human');
      expect(humans.map((entry) => (entry as { text: string }).text)).toEqual(['開始', '改用 X']);
    } finally {
      await run.close();
    }
  }, 20000);

  it('改、刪插話那一條裡的：被領走之前都行', async () => {
    const run = await assemble([POKE, { content: '收到' }], {
      onPoke: () => {
        void run.pump.submit(steer('改用 X', 's1'));
        void run.pump.submit(steer('算了', 's2'));
        expect(run.pump.updateQueue('s1', { kind: 'edit', text: '改用 Y' })).toBe('updated');
        expect(run.pump.updateQueue('s2', { kind: 'remove' })).toBe('updated');
        // 已經是插話了：再改成插話不收，同 dsh。
        expect(run.pump.updateQueue('s1', { kind: 'steer' })).toBe('steer-unavailable');
      },
    });
    try {
      await run.pump.submit({ kind: 'message', text: '開始', id: 'm1' });
      await run.pump.whenIdle();
      expect(humanTexts(run.model.prompts[1])).toEqual(['開始', '改用 Y']);
      expect(run.marks()).toContain('step:edit:改用 Y');
      expect(run.marks()).toContain('step:remove');
      // 被領走之後就不在隊裡了。
      expect(run.pump.updateQueue('s1', { kind: 'remove' })).toBe('not-found');
    } finally {
      await run.close();
    }
  }, 20000);

  it('queue.update 的 steer：排著的那一件改成插話，這一輪下一步就送進模型，不另開一輪', async () => {
    let queued: Promise<void> | undefined;
    const run = await assemble([POKE, { content: '收到' }], {
      onPoke: () => {
        queued = run.pump.submit({ kind: 'message', text: 'B', id: 'b' });
        expect(run.pump.updateQueue('b', { kind: 'steer' })).toBe('updated');
      },
    });
    try {
      await run.pump.submit({ kind: 'message', text: '開始', id: 'm1' });
      await queued;
      await run.pump.whenIdle();
      expect(humanTexts(run.model.prompts[1])).toEqual(['開始', 'B']);
      expect(run.model.prompts).toHaveLength(2);
      expect(run.marks()).toEqual([
        'turn+開始',
        'start:message:開始',
        'turn:claim1',
        'model',
        'turn+B',
        'turn:remove',
        'step+B',
        'step:claim1',
        'steer:B',
        'model',
        'end',
      ]);
    } finally {
      await run.close();
    }
  }, 20000);

  it('插話之後，重複提醒的鏈清零（對照組：同一串呼叫沒有插話就提醒）', async () => {
    // 預設門檻：同一顆工具同參數連叫三次就提醒。
    const turns = [POKE, POKE, POKE, { content: '好' }];
    const control = await assemble(turns, {}, { shipped: true });
    const steered = await assemble(
      turns,
      { onPoke: (call) => void (call === 2 && steered.pump.submit(steer('換個做法', 's1'))) },
      { shipped: true },
    );
    try {
      for (const run of [control, steered]) {
        await run.pump.submit({ kind: 'message', text: '開始', id: 'm1' });
        await run.pump.whenIdle();
      }
      expect(control.marks().filter((mark) => mark.startsWith('injected:'))).not.toEqual([]);
      expect(steered.marks().filter((mark) => mark.startsWith('injected:'))).toEqual([]);
      expect(steered.marks()).toContain('steer:換個做法');
    } finally {
      await control.close();
      await steered.close();
    }
  }, 30000);
});

describe('真的組裝：這一輪不收插話的時候', () => {
  it('中止之後送來的插話進 next-turn 的頭，照樣開一輪', async () => {
    const run = await assemble([POKE, { content: '不會被叫到' }, { content: '第二輪' }], {
      onPoke: () => {
        run.pump.cancel();
        void run.pump.submit(steer('停了之後插的', 's1'));
      },
    });
    try {
      await run.pump.submit({ kind: 'message', text: '開始', id: 'm1' });
      await run.pump.whenIdle();
      expect(run.marks()).toEqual([
        'turn+開始',
        'start:message:開始',
        'turn:claim1',
        'model',
        'turn+停了之後插的',
        'end:aborted',
        'start:message:停了之後插的',
        'turn:claim1',
        'model',
        'end',
      ]);
      const splice = run.pump.sessionLog.events.find(
        (event): event is SessionEvent<'inbox/spliced'> =>
          event.type === 'inbox/spliced' && event.data.inserted[0]?.id === 's1',
      );
      expect(splice?.data).toMatchObject({ target: 'next-turn', start: 0 });
    } finally {
      await run.close();
    }
  }, 20000);

  it('按停止時排著的插話留著，下一輪開頭一起領走、排在開頭那句後面', async () => {
    const run = await assemble([POKE, { content: '下一輪' }], {
      onPoke: () => {
        void run.pump.submit(steer('停之前插的', 's1'));
        run.pump.cancel();
      },
    });
    try {
      await run.pump.submit({ kind: 'message', text: '開始', id: 'm1' });
      await run.pump.whenIdle();
      // 中止之後不領：它還在插話那一條，沒有自己開一輪。
      expect(run.pump.nextStep.map((item) => item.id)).toEqual(['s1']);
      expect(run.model.prompts).toHaveLength(1);

      await run.pump.submit({ kind: 'message', text: '再來', id: 'm2' });
      await run.pump.whenIdle();
      expect(humanTexts(run.model.prompts[1])).toEqual(['開始', '再來', '停之前插的']);
      expect(run.marks().slice(-7)).toEqual([
        'turn+再來',
        'start:message:再來',
        'turn:claim1',
        'step:claim1',
        'steer:停之前插的',
        'model',
        'end',
      ]);
    } finally {
      await run.close();
    }
  }, 20000);

  it('沒掛載體的組裝：插話退成排隊，不會卡在一條沒人領的 next-step', async () => {
    const run = await assemble(
      [POKE, { content: '第一輪' }, { content: '第二輪' }],
      { onPoke: () => void run.pump.submit(steer('插的', 's1')) },
      { stepInbox: false },
    );
    try {
      await run.pump.submit({ kind: 'message', text: '開始', id: 'm1' });
      await run.pump.whenIdle();
      expect(run.pump.nextStep).toEqual([]);
      expect(run.marks().filter((mark) => mark.startsWith('start:'))).toEqual([
        'start:message:開始',
        'start:message:插的',
      ]);
      expect(run.pump.updateQueue('nope', { kind: 'steer' })).toBe('not-found');
    } finally {
      await run.close();
    }
  }, 20000);
});

describe('真的組裝：停在核准點時的插話', () => {
  function gated(registry: Parameters<PluginEntry['plugin']['apply']>[0]): void {
    registry.tools.register(
      tool(() => '危險的事做完了', {
        name: 'danger',
        description: '要核准。',
        schema: z.object({}),
      }),
    );
    registry.approvals.gate((exec, next) =>
      exec.name === 'danger' ? { kind: 'ask', reason: '危險' } : next(),
    );
  }

  it('收進 next-step，答覆那一段叫模型之前領走', async () => {
    const run = await assemble(
      [{ content: '', toolCalls: [{ name: 'danger', args: {} }] }, { content: '收到' }],
      {},
      { extra: gated },
    );
    try {
      await run.pump.submit({ kind: 'message', text: '開始', id: 'm1' });
      expect(run.pump.awaitingInput).toBe(true);
      await run.pump.submit(steer('核准前插的', 's1'));
      expect(run.pump.nextStep.map((item) => item.id)).toEqual(['s1']);
      const [pending] = run.pump.pendings;
      await run.pump.submit(approve(pending!.interruptId));
      await run.pump.whenIdle();
      expect(humanTexts(run.model.prompts[1])).toEqual(['開始', '核准前插的']);
      expect(run.marks().slice(-7)).toEqual([
        'end',
        'step+核准前插的',
        'start:resume',
        'step:claim1',
        'steer:核准前插的',
        'model',
        'end',
      ]);
    } finally {
      await run.close();
    }
  }, 20000);
});

/**
 * 照 `configurable` 裡的領取口走的假 agent：每一段 `claim` 一次（叫模型之前），再 `finish` 到空為止（同圖的收尾跳回模型）。
 * `seen` 依序記下每一次領到的東西，空的也記。`holdBeforeClaim` 讓這一段停在「跑著、還沒到工具邊界」；`holdAfterFinish`
 * 讓它停在「圖已經關窗、pump 還沒寫 `turn/end`」。
 */
function handleAgent(
  script: readonly {
    readonly holdBeforeClaim?: Promise<void>;
    readonly holdAfterFinish?: Promise<void>;
  }[],
) {
  const seen: string[][] = [];
  let call = 0;
  const texts = (messages: readonly BaseMessage[]) => messages.map((message) => message.text);
  const agent = {
    streamEvents: async (_input: unknown, config: { configurable: Record<string, unknown> }) => {
      const step = script[call] ?? {};
      call += 1;
      const inbox = config.configurable[STEP_INBOX_CONFIG_KEY] as StepInbox;
      return (async function* () {
        if (step.holdBeforeClaim !== undefined) await step.holdBeforeClaim;
        seen.push(texts(await inbox.claim()));
        for (;;) {
          const finished = texts(await inbox.finish());
          seen.push(finished);
          if (finished.length === 0) break;
        }
        if (step.holdAfterFinish !== undefined) await step.holdAfterFinish;
        yield {
          type: 'event',
          seq: 0,
          method: 'lifecycle',
          params: { namespace: [], timestamp: 0, data: { event: 'completed', graph_name: 'root' } },
        };
      })();
    },
    getState: async () => ({ values: {} }),
    updateState: async () => ({}),
  };
  return { agent: agent as unknown as PumpAgent, seen };
}

describe('假 agent：收尾那一刻與重啟', () => {
  it('圖已經關窗、還沒收尾時到的插話排 next-turn 的頭，排在已經排著的前面', async () => {
    const hold = gate();
    const { agent, seen } = handleAgent([{ holdAfterFinish: hold.opened }]);
    const pump = new ThreadPump(
      agent,
      'closing',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    try {
      const first = pump.submit({ kind: 'message', text: 'A', id: 'a' });
      await until(() => seen.length === 2);
      void pump.submit({ kind: 'message', text: 'B', id: 'b' });
      void pump.submit(steer('收尾時插的', 's1'));
      expect(pump.nextStep).toEqual([]);
      expect(pump.inbox.map((item) => item.id)).toEqual(['s1', 'b']);
      hold.open();
      await first;
      await pump.whenIdle();
      expect(marks(pump.sessionLog.events).filter((mark) => mark.startsWith('start:'))).toEqual([
        'start:message:A',
        'start:message:收尾時插的',
        'start:message:B',
      ]);
    } finally {
      pump.close();
    }
  });

  it('重啟：插話那一條折得回來、不自己開一輪；下一輪開頭領走', async () => {
    const seed = new SessionLog('restart');
    const splice = (data: InboxSplice) => seed.append('inbox/spliced', data);
    splice({
      target: 'next-turn',
      start: 0,
      inserted: [{ id: 'm1', text: '開始', source: { kind: 'user' } }],
    });
    seed.append('turn/start', { kind: 'message', text: '開始' });
    splice({ target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
    splice({
      target: 'next-step',
      start: 0,
      inserted: [{ id: 's1', text: '留著的', source: { kind: 'user' } }],
    });
    seed.append('turn/end', { reason: { kind: 'aborted', cause: { kind: 'user' } } });

    const { agent, seen } = handleAgent([]);
    const pump = new ThreadPump(
      agent,
      'restart',
      undefined,
      seed.events,
      undefined,
      undefined,
      undefined,
      true,
    );
    try {
      expect(pump.nextStep.map((item) => item.id)).toEqual(['s1']);
      expect(pump.running).toBe(false);
      const pushed = inboxPushes(historyPage(pump.sessionLog.events).events);
      expect(pushed).toEqual([
        { items: [], nextStep: [{ id: 's1', text: '留著的', source: { kind: 'user' } }] },
      ]);
      await pump.submit({ kind: 'message', text: '再來', id: 'm2' });
      await pump.whenIdle();
      expect(seen).toEqual([['留著的'], []]);
      expect(pump.nextStep).toEqual([]);
    } finally {
      pump.close();
    }
  });

  it('按停止之後停住的那一件：閒著時不收改成插話', async () => {
    const hold = gate();
    const { agent } = handleAgent([{ holdBeforeClaim: hold.opened }]);
    const pump = new ThreadPump(
      agent,
      'parked',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    try {
      const first = pump.submit({ kind: 'message', text: 'A', id: 'a' });
      await until(() => pump.running);
      // 停住的那一件在 `close()` 時被拒絕：這條不驗它。
      pump.submit({ kind: 'message', text: 'B', id: 'b' }).catch(() => undefined);
      pump.cancel();
      hold.open();
      await first.catch(() => undefined);
      await pump.whenIdle();
      expect(pump.inbox.map((item) => item.id)).toEqual(['b']);
      expect(pump.running).toBe(false);
      expect(pump.updateQueue('b', { kind: 'steer' })).toBe('steer-unavailable');
      expect(pump.nextStep).toEqual([]);
    } finally {
      pump.close();
    }
  });

  it('閒著時送插話：沒有一輪可插，照樣開一輪', async () => {
    const { agent } = handleAgent([]);
    const pump = new ThreadPump(
      agent,
      'idle',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    try {
      await pump.submit(steer('閒著時插的', 's1'));
      await pump.whenIdle();
      expect(marks(pump.sessionLog.events)).toEqual([
        'turn+閒著時插的',
        'start:message:閒著時插的',
        'turn:claim1',
        'end',
      ]);
      // 閒著時排著的那一件也不收改成插話。
      expect(pump.updateQueue('s1', { kind: 'steer' })).toBe('not-found');
    } finally {
      pump.close();
    }
  });
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
        stepInbox: true,
        commands: emptyCommandPoint(),
        dispose: async () => {},
        attachSessions: (sessions) => {
          pumpLog = () => sessions.root.events;
          return { detach: async () => {} };
        },
      }),
    });
    opened.push(handler);
    const fetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
      handler.handle(loopbackRequest(input as string, init));
    const client = createWireClient({ baseUrl: 'http://steer.test', fetch });
    let nextId = 1;
    const raw = async (thread: string, method: string, params: unknown) => {
      const response = await fetch(`http://steer.test/threads/${thread}/commands/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: nextId++, method, params }),
      });
      return (await response.json()) as Record<string, unknown>;
    };
    return { client, raw, log: () => pumpLog?.() ?? [] };
  }

  it('run.start 帶 mode: steer 進 next-step、run_id 就是那一件；queue.update 的 steer 收；壞的 mode 回 invalid_argument', async () => {
    const hold = gate();
    const { agent, seen } = handleAgent([{ holdBeforeClaim: hold.opened }]);
    const { client, raw, log } = wire(agent);
    const thread = 'steer-wire';
    await client.runStart(thread, '開始');
    await until(() => log().some((event) => event.type === 'turn/start'));

    const steered = await client.runStart(thread, '插的', { mode: 'steer' });
    expect(steered.type).toBe('success');
    const steerId = (steered as { result: { run_id: string } }).result.run_id;
    const queued = await client.runStart(thread, '排著的');
    const queuedId = (queued as { result: { run_id: string } }).result.run_id;
    expect(
      await raw(thread, 'queue.update', { item_id: queuedId, action: { kind: 'steer' } }),
    ).toMatchObject({ type: 'success', result: { accepted: true } });
    // 已經在插話那一條：同 dsh 不收。
    expect(
      await raw(thread, 'queue.update', { item_id: queuedId, action: { kind: 'steer' } }),
    ).toMatchObject({ type: 'error', error: 'steer_unavailable' });
    expect(await client.runStart(thread, 'x', { mode: 'now' as never })).toMatchObject({
      type: 'error',
      error: 'invalid_argument',
    });

    hold.open();
    await until(() => log().some((event) => event.type === 'turn/end'));
    expect(seen).toEqual([['插的', '排著的'], []]);
    const stepInserted = log().flatMap((event) =>
      event.type === 'inbox/spliced' && event.data.target === 'next-step'
        ? event.data.inserted.map((item) => item.id)
        : [],
    );
    expect(stepInserted).toEqual([steerId, queuedId]);
    // 被領走了：不在任何一條裡。
    expect(
      await raw(thread, 'queue.update', { item_id: steerId, action: { kind: 'steer' } }),
    ).toMatchObject({ type: 'error', error: 'queue_item_not_found' });
  });
});
