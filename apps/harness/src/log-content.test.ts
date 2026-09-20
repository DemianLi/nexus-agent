/**
 * **對話內容進會話日誌**——[#305](https://github.com/DemianLi/nexus-agent/issues/305) 的驗收，量的是真的
 * 跑一場之後日誌裡有什麼、跟模型看到的是不是同一則。
 *
 * 規則（什麼時候記、什麼不記、記不進去會怎樣）在 core 那一側：`model-calls.test.ts`、
 * `containment.test.ts`。這一份問的是**掛進兩條產品路徑之後還成不成立**。
 *
 * **判準在模型那一側。** `ScriptedChatModel` 記下每一次被叫時拿到的訊息，第二次呼叫看到的就是第一次
 * 的回覆與工具結果——日誌推回來的要跟那一份逐則相同。不跟腳本比：腳本是我們寫的，模型看到的才是
 * 推模型歷史的一側（[#306](https://github.com/DemianLi/nexus-agent/issues/306)）要重現的東西。
 *
 * 其餘幾格各在各的地方：中斷那一顆與真的 `ChatOpenAI` 走 v3 串流的那一則在
 * `turn-cancel-openai.test.ts`，goal 收尾的 `user/message` 在 `goal-driver-pump.test.ts`，壓縮的
 * `summary` 在 `compaction-log.test.ts`，停在核准點收回的那幾顆在 `turn-cancel.test.ts`。
 *
 * **零憑證、零外部連線。**
 */

import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import {
  fromLoggedMessage,
  REPEAT_REMINDER_MARKER,
  REPEAT_REMINDER_MIDDLEWARE_NAME,
  SESSION_LOG_FORMAT_VERSION,
  SessionRegistry,
} from '@nexus/core';
import type { PluginEntry, SessionEvent, SessionEventMap } from '@nexus/core';
import { createEchoPlugin, ECHO_TOOL_NAME } from '@nexus/plugin-echo';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { runTurn } from './cli.js';
import { LoopingChatModel } from './looping-model.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedModelState, ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

/** 一顆會成功的工具。 */
const echoPlugin: PluginEntry = {
  plugin: {
    name: 'log-content-echo',
    apply(registry) {
      registry.tools.register(
        tool(({ text }: { text: string }) => `回聲：${text}`, {
          name: 'echo',
          description: '原樣回聲。',
          schema: z.object({ text: z.string() }),
        }),
      );
    },
  },
};

/** 只註冊一個 subagent。 */
const workerPlugin: PluginEntry = {
  plugin: {
    name: 'log-content-worker',
    apply(registry) {
      registry.subagents.register({ name: 'worker', description: '幹活的。' });
    },
  },
};

/** 腳本用完就拋，所以多備幾輪；多備的不會被叫到。 */
const SPARE: ScriptedTurn[] = [{ content: '多備的一。' }, { content: '多備的二。' }];

/** 卡上的驗收句 1：講一句話 → 模型回文字並叫一個工具 → 工具成功 → 模型再回一句。 */
const TURNS: ScriptedTurn[] = [
  { content: '我先回聲一次。', toolCalls: [{ name: 'echo', args: { text: '嗨' } }] },
  { content: '回聲說了嗨。' },
  ...SPARE,
];

/** 主線那幾種：模型起訖與其他記帳的事件去掉。 */
const MAINLINE = new Set([
  'turn/start',
  'assistant/message',
  'tool/call',
  'tool/result',
  'user/message',
  'turn/end',
]);

/** 一份日誌推回來的訊息：回覆、工具結果、外掛注入的，照日誌順序。 */
function derived(events: readonly SessionEvent[]): BaseMessage[] {
  return events.flatMap((event) => {
    if (event.type === 'assistant/message' || event.type === 'user/message') {
      return [
        fromLoggedMessage(
          (event.data as { message: SessionEventMap['assistant/message']['message'] }).message,
        ),
      ];
    }
    if (event.type === 'tool/result') {
      const { message } = event.data as SessionEventMap['tool/result'];
      return message === undefined ? [] : [fromLoggedMessage(message)];
    }
    return [];
  });
}

/** 比兩則訊息用的指紋：種類、文字、呼叫、配對的 id。 */
function shape(message: BaseMessage) {
  return {
    type: message.getType(),
    text: message.text,
    toolCalls: AIMessage.isInstance(message)
      ? (message.tool_calls ?? []).map(({ id, name, args }) => ({ id, name, args }))
      : [],
    toolCallId: ToolMessage.isInstance(message) ? message.tool_call_id : undefined,
  };
}

/** 跑一輪，回 root 那份日誌與模型每一次被叫時拿到的訊息。 */
async function runOnce(path: 'cli' | 'serve'): Promise<{
  events: readonly SessionEvent[];
  prompts: readonly (readonly BaseMessage[])[];
}> {
  const state: ScriptedModelState = { turn: 0, boundToolNames: [], lastPrompt: [], prompts: [] };
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns: TURNS, shared: state }) as never,
    checkpointer: new MemorySaver(),
    plugins: [echoPlugin],
  });
  if (path === 'cli') {
    const sessions = new SessionRegistry('log-content-cli');
    const detach = built.attachSession(sessions);
    try {
      await runTurn(
        built.agent,
        '跑。',
        { log: () => undefined, error: () => undefined },
        sessions.root,
      );
      return { events: sessions.root.events, prompts: state.prompts };
    } finally {
      detach();
      await built.dispose();
    }
  }
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'log-content-serve');
  const detach = built.attachSession(pump.sessions);
  try {
    await pump.submit({ kind: 'message', text: '跑。' });
    return { events: pump.sessions.root.events, prompts: state.prompts };
  } finally {
    pump.close();
    detach();
    await built.dispose();
  }
}

describe('兩條產品路徑', () => {
  /**
   * **卡上的驗收句 1。** 兩條路各拿得到的顆粒度不一樣（CLI 收 `updates`，serve 收 v3 分片），而寫入點
   * 在兩者共用的那一格——所以兩條都要量，量到的要一模一樣。
   */
  it.each([
    ['CLI（runTurn，stream updates）', 'cli'],
    ['serve（pump，v3 streamEvents）', 'serve'],
  ] as const)('%s：主線依序、內容逐則等於模型看到的', async (_label, path) => {
    const { events, prompts } = await runOnce(path);

    expect(events.map((event) => event.type).filter((type) => MAINLINE.has(type))).toEqual([
      'turn/start',
      'assistant/message',
      'tool/call',
      'tool/result',
      'assistant/message',
      'turn/end',
    ]);
    // 回覆寫在它那次呼叫的 `model/end` 之前：回覆在前，它派發的工具事件在後，同 dsh。
    const types = events.map((event) => event.type);
    expect(types.indexOf('assistant/message')).toBeLessThan(types.indexOf('model/end'));

    // 模型第二次被叫時看到的：人那句、它自己上一則回覆、工具結果。
    const seen = (prompts[1] ?? []).filter((message) => message.getType() !== 'system');
    expect(seen.map((message) => message.getType())).toEqual(['human', 'ai', 'tool']);
    const logged = derived(events);
    expect(logged).toHaveLength(3);
    expect(logged.slice(0, 2).map(shape)).toEqual(seen.slice(1).map(shape));
    // 最後那一則沒有下一次呼叫可以對，跟它那一輪的產出比：就是那一句，沒有呼叫。
    expect(shape(logged[2]!)).toMatchObject({ type: 'ai', text: '回聲說了嗨。', toolCalls: [] });
  });
});

describe('subagent 的回覆', () => {
  /** 卡上的驗收句「subagent」：記在它自己那份，root 那份只有 root 的。 */
  it('記在 subagent 那份，root 那份只有 root 的', async () => {
    const built = await createNexusAgent({
      model: new ScriptedChatModel({
        turns: [
          {
            content: '委派。',
            toolCalls: [{ name: 'task', args: { description: '幹活', subagent_type: 'worker' } }],
          },
          { content: '子代理動手。', toolCalls: [{ name: 'echo', args: { text: '子' } }] },
          { content: '子代理收工。' },
          { content: '收工。' },
          ...SPARE,
        ],
      }),
      checkpointer: new MemorySaver(),
      plugins: [echoPlugin, workerPlugin],
    });
    const sessions = new SessionRegistry('log-content-sub');
    const detach = built.attachSession(sessions);
    try {
      await built.agent.invoke(toAgentInvocation('跑。'), {
        configurable: { thread_id: 'log-content-sub' },
      });
    } finally {
      detach();
      await built.dispose();
    }
    const texts = (events: readonly SessionEvent[]) =>
      derived(events.filter((event) => event.type === 'assistant/message')).map(
        (message) => message.text,
      );
    const logsOf = (kind: 'root' | 'subagent') =>
      sessions
        .list()
        .filter((entry) => entry.address.kind === kind)
        .map((entry) => entry.log.events);

    expect(logsOf('root').map(texts)).toEqual([['委派。', '收工。']]);
    expect(logsOf('subagent').map(texts)).toEqual([['子代理動手。', '子代理收工。']]);
  });
});

describe('外掛注入的：重複工具呼叫的提醒', () => {
  /**
   * 提醒是 `beforeModel` 塞進對話的 HumanMessage——模型看得到，推模型歷史的一側就得讀得到。它落在
   * 它提醒的那次模型呼叫之前，同 dsh 在 `agent/pre-step` 注入。
   *
   * 跑法同 `repeat-reminder.test.ts`：一場永不停的迴圈跑到上限，同參數重複到第一道門檻就會提醒。
   */
  it('記成 user/message，緊接著就是它提醒的那次模型呼叫，文字就是模型讀到的那一則', async () => {
    const model = new LoopingChatModel({ toolName: ECHO_TOOL_NAME });
    const built = await createNexusAgent({
      model,
      plugins: [createEchoPlugin()],
      recursionLimit: 20,
      summarization: false,
    });
    const sessions = new SessionRegistry('log-content-reminder');
    const detach = built.attachSession(sessions);
    try {
      await expect(built.agent.invoke(toAgentInvocation('一直跑'))).rejects.toThrow(
        /Recursion limit/,
      );
    } finally {
      detach();
      await built.dispose();
    }

    const events = sessions.root.events;
    const reminders = events.flatMap((event, at) =>
      event.type === 'user/message'
        ? [{ at, data: event.data as SessionEventMap['user/message'] }]
        : [],
    );
    // 模型最後一次讀到的那一串裡的提醒，照順序。
    const seen = (model.seen.at(-1) ?? [])
      .filter(
        (message) =>
          HumanMessage.isInstance(message) &&
          message.additional_kwargs[REPEAT_REMINDER_MARKER] != null,
      )
      .map((message) => message.text);
    expect(seen.length).toBeGreaterThan(0);

    const logged = reminders.map(({ data }) => fromLoggedMessage(data.message).text);
    // 圖若剛好停在提醒之後、模型呼叫之前，日誌會比模型讀到的多最後那一顆；除此之外逐則相同。
    expect(logged.slice(0, seen.length)).toEqual(seen);
    expect(logged.length - seen.length).toBeLessThanOrEqual(1);
    for (const { at } of reminders.slice(0, seen.length)) {
      expect(events[at + 1]?.type).toBe('model/start');
    }
    for (const { data } of reminders) {
      expect(data.source).toEqual({ kind: 'plugin', plugin: REPEAT_REMINDER_MIDDLEWARE_NAME });
    }
  });
});

describe('格式版本', () => {
  /**
   * **這一個號是閘。** 讀不懂 9 的舊 runtime 若照收新檔，它續寫下去的輪次沒有回覆、沒有結果內容，
   * 推出來的歷史就有洞；我們的 body parser 對不認得的 `type` 照收，守這條線的只有版本號
   * （`session-store.ts` 的 9）。「比這一版新就拒讀」本身在 `session-resume.test.ts`。
   */
  it('對話內容從 9 起記：這一版的號至少是 9', () => {
    expect(SESSION_LOG_FORMAT_VERSION).toBeGreaterThanOrEqual(9);
  });
});
