/**
 * 子代理的提醒鏈在 `history-source=log` 下讀它自己的日誌沒套摘要的那一串
 * （[#2751](https://github.com/DemianLi/nexus-agent/issues/2751)，[#2362](https://github.com/DemianLi/nexus-agent/issues/2362)），
 * **真的派前景子代理、兩種 loop 各跑一次**。
 *
 * - 逐字相同：子代理反覆叫同一顆工具，`state` 與 `log` 下子代理每一輪 prompt（含提醒）逐字相同；提醒記進**它自己的**子日誌。
 * - 摘要之後：子代理跑到摘要，鏈跨過切點，提醒的條數與 `state` 讀法相同。
 * - 分得出「退回讀 state」：一顆每一步都往 graph state 加一則真使用者訊息（不進日誌）的 middleware。`state` 讀法下鏈每步清零、出不了提醒；
 *   `log` 讀日誌，提醒照出。子代理的鏈若退回讀 state，這一條會紅。
 * - 並行兩個同一份定義的子代理：各自的鏈各自數，各自一則提醒，不串。
 * - 寫不進去：子代理的 spawn input 寫不進去時，那一步失敗、root 收到原錯，恢復後再派可成功。
 *
 * 這一檔明給 `historySource` 與 `agentLoop`，setup 的 mock 只在沒給時補值，所以不影響；每個場景都斷言 `log` 那一邊組裝回報的 `historySource`，比對 `state` 的場景也斷言 `state` 那一邊。
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { createHookStepMiddleware, REPEAT_REMINDER_MARKER } from '@nexus/core';
import type { HistorySource, PluginEntry } from '@nexus/core';
import type { Event } from '@nexus/wire';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import type { CreateNexusAgentOptions } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

type Loop = NonNullable<CreateNexusAgentOptions['agentLoop']>;

const NOISE = '每一步都只加進 graph state 的真使用者訊息';

const WORKER: PluginEntry = {
  plugin: {
    name: 'worker-host',
    apply(registry) {
      registry.subagents.register({
        name: 'worker',
        description: '幹活的。',
        systemPrompt: '你是 worker，只做交代給你的事。',
      });
      registry.tools.register(
        tool(() => '好', { name: 'noop', description: '什麼都不做。', schema: z.object({}) }),
      );
      // 結果很長的那顆：讓摘要比被取代的內容小，摘要器才接受。
      registry.tools.register(
        tool(() => `長${'字'.repeat(400)}`, {
          name: 'bulk',
          description: '回一大段字。',
          schema: z.object({}),
        }),
      );
    },
  },
};

/** 每次叫模型之前，往這個 agent 的 graph state 加一則新的真使用者訊息、不記進日誌。root 與子代理都走它。 */
const STATE_NOISE: PluginEntry = {
  plugin: {
    name: 'state-noise',
    apply(registry) {
      let n = 0;
      registry.middleware.use(
        createHookStepMiddleware({
          name: 'stateNoise',
          beforeModel: () => {
            n += 1;
            return { messages: [new HumanMessage(`${NOISE} ${n}`)] };
          },
        }),
      );
    },
  },
};

const isRootDone = (frame: Event): boolean =>
  frame.method === 'lifecycle' &&
  frame.params.namespace.length === 0 &&
  (frame.params.data as { graph_name?: unknown }).graph_name === 'root' &&
  ['completed', 'failed'].includes(String((frame.params.data as { event?: unknown }).event));

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const isReminder = (message: BaseMessage): boolean =>
  HumanMessage.isInstance(message) && message.additional_kwargs[REPEAT_REMINDER_MARKER] != null;

/** id 與逐次不同的欄位不比，其餘逐欄比。 */
function project(message: BaseMessage): unknown {
  return {
    type: message.getType(),
    // 摘要附的歷史檔名帶每次隨機的會話代號，其餘逐字。
    content: JSON.parse(
      JSON.stringify(message.content).replace(/session_[0-9a-f]+\.md/g, 'session_X.md'),
    ) as unknown,
    toolCalls: 'tool_calls' in message ? message.tool_calls : undefined,
    toolCallId: 'tool_call_id' in message ? message.tool_call_id : undefined,
    reminder: isReminder(message) ? message.additional_kwargs[REPEAT_REMINDER_MARKER] : undefined,
  };
}

interface Run {
  readonly prompts: readonly (readonly unknown[])[];
  /** 每一輪 prompt 裡提醒的條數。 */
  readonly remindersPerPrompt: readonly number[];
  readonly built: HistorySource;
  /** 每個子日誌上 `source.kind === 'plugin'` 的 `user/message` 條數（提醒）。 */
  readonly subagentLoggedReminders: readonly number[];
  readonly subagentEventTypes: readonly (readonly string[])[];
  /** 每個子日誌第一顆 `user/message` 的 `message` 序列化成 JSON（沒有就是 `'""'`）。 */
  readonly subagentInputs: readonly string[];
}

async function run(
  loop: Loop,
  historySource: HistorySource,
  turns: readonly ScriptedTurn[],
  plugins: readonly PluginEntry[] = [WORKER],
  summarization?: CreateNexusAgentOptions['summarization'],
  /** 給了就讓第一個子日誌的 spawn input（子日誌第一顆 `user/message`）寫不進去一次，之後恢復。 */
  failSpawnInputOnce?: Error,
): Promise<Run> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-subagent-reminder-'));
  const model = new ScriptedChatModel({ turns });
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    plugins: [...plugins],
    backend: new ContainedFilesystemBackend({ rootDir: root, mode: 'workspace-write' }),
    agentLoop: loop,
    historySource,
    ...(summarization !== undefined && { summarization }),
  });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'subagent-reminder');
  const detach = built.attachSession(pump.sessions);
  if (failSpawnInputOnce !== undefined) {
    let failed = false;
    pump.sessions.observe(({ address, log }) => {
      if (address.kind !== 'subagent') return;
      const real = log.append.bind(log);
      log.append = ((type: never, data: never, options: never) => {
        if (!failed && type === 'user/message') {
          failed = true;
          throw failSpawnInputOnce;
        }
        return real(type, data, options);
      }) as typeof log.append;
    });
  }
  const frames: Event[] = [];
  const line = new AbortController();
  const stream = pump.subscribe(['lifecycle'], line.signal);
  const draining = (async () => {
    for await (const frame of stream) frames.push(frame);
  })();
  try {
    await pump.submit({ kind: 'message', text: '委派' });
    await until(() => frames.some(isRootDone));
    await pump.whenIdle();
    const subagents = pump.sessions.list().filter((entry) => entry.address.kind === 'subagent');
    return {
      prompts: model.prompts.map((prompt) => prompt.map(project)),
      remindersPerPrompt: model.prompts.map((prompt) => prompt.filter(isReminder).length),
      built: built.historySource,
      subagentLoggedReminders: subagents.map(
        (entry) =>
          entry.log.events.filter(
            (event) =>
              event.type === 'user/message' &&
              (event.data as { source?: { kind?: string } }).source?.kind === 'plugin',
          ).length,
      ),
      subagentEventTypes: subagents.map((entry) => entry.log.events.map((event) => event.type)),
      subagentInputs: subagents.map((entry) =>
        JSON.stringify(
          (
            entry.log.events.find((event) => event.type === 'user/message')?.data as
              { message?: unknown } | undefined
          )?.message ?? '',
        ),
      ),
    };
  } finally {
    line.abort();
    await draining;
    detach();
    await built.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

const task = (description: string): { name: string; args: Record<string, unknown> } => ({
  name: 'task',
  args: { description, subagent_type: 'worker' },
});

const call = (name: string): ScriptedTurn => ({ content: '', toolCalls: [{ name, args: {} }] });

/** 子代理連叫 8 次 `noop`：第 3、5、8 次之後各一則提醒（門檻 3／5／8），再收工。 */
const REPEATING: readonly ScriptedTurn[] = [
  { content: '委派。', toolCalls: [task('幹活')] },
  ...Array.from({ length: 8 }, () => call('noop')),
  { content: '子代理收工。' },
  { content: '根收工。' },
];

/**
 * 子代理叫 5 次 `bulk`，摘要器在第 4 次呼叫之前與收工那一輪之前各跑一次，各吃掉一個腳本輪；門檻 3 與 5 各一則提醒。
 * 觸發值 6：root 只有 4 則，不會觸發。
 */
const REPEATING_WITH_SUMMARY: readonly ScriptedTurn[] = [
  { content: '委派。', toolCalls: [task('幹活')] },
  call('bulk'),
  call('bulk'),
  call('bulk'),
  { content: '摘要：子代理已經叫過三次 bulk。' },
  call('bulk'),
  call('bulk'),
  { content: '摘要：又累了兩次 bulk。' },
  { content: '子代理收工。' },
  { content: '根收工。' },
];

const SUMMARY_SETTINGS = { trigger: [{ type: 'messages' as const, value: 6 }], retainTokens: 36 };

/** 並行兩個子代理，各叫 3 次 `noop`：交錯執行時各自 3 次、各一則提醒；共用一條鏈的話第 3 次之後就出，條數不是各一。 */
const TWO_REPEATING: readonly ScriptedTurn[] = [
  { content: '委派。', toolCalls: [task('幹活甲'), task('幹活乙')] },
  ...Array.from({ length: 6 }, () => call('noop')),
  { content: '甲收工。' },
  { content: '乙收工。' },
  { content: '根收工。' },
];

describe.each(['langgraph', 'native'] as const)('子代理的提醒鏈讀它自己的日誌：%s', (loop) => {
  it('前景子代理反覆叫同一顆工具：log 下每一輪 prompt 與 state 逐字相同，提醒記進子日誌', async () => {
    const viaState = await run(loop, 'state', REPEATING);
    const viaLog = await run(loop, 'log', REPEATING);

    expect(viaState.built).toBe('state');
    expect(viaLog.built).toBe('log');
    // 沒有提醒這場就沒量到鏈：第 3、5、8 次之後各一則，各自出現在後面每一輪裡（提醒留在歷史中）。
    expect(viaLog.remindersPerPrompt.some((count) => count > 0)).toBe(true);
    expect(Math.max(...viaLog.remindersPerPrompt)).toBe(3);
    expect(viaLog.prompts).toEqual(viaState.prompts);
    // 提醒進它自己的子日誌，三則；`state` 下接了會話也照記，所以兩邊子日誌的事件序列相同。
    expect(viaLog.subagentLoggedReminders).toEqual([3]);
    expect(viaLog.subagentEventTypes).toEqual(viaState.subagentEventTypes);
  });

  it('前景子代理跑到摘要：鏈跨過切點，log 與 state 逐字相同', async () => {
    const viaState = await run(loop, 'state', REPEATING_WITH_SUMMARY, [WORKER], SUMMARY_SETTINGS);
    const viaLog = await run(loop, 'log', REPEATING_WITH_SUMMARY, [WORKER], SUMMARY_SETTINGS);

    expect(viaLog.built).toBe('log');
    expect(viaState.built).toBe('state');
    expect(viaLog.subagentEventTypes[0]).toContain('compaction/summary');
    expect(viaState.subagentEventTypes[0]).toContain('compaction/summary');
    expect(viaLog.subagentLoggedReminders[0]).toBeGreaterThanOrEqual(2);
    expect(viaLog.prompts).toEqual(viaState.prompts);
    expect(viaLog.subagentLoggedReminders).toEqual(viaState.subagentLoggedReminders);
  });

  it('分得出退回讀 state：state 每步被加一則真使用者訊息，log 下鏈照日誌算、提醒照出', async () => {
    const plugins = [WORKER, STATE_NOISE];
    const viaState = await run(loop, 'state', REPEATING, plugins);
    const viaLog = await run(loop, 'log', REPEATING, plugins);

    expect(viaState.built).toBe('state');
    expect(viaLog.built).toBe('log');
    // 對照：state 讀法下每步多一則真使用者訊息，鏈每步清零，一則提醒也出不了。
    expect(viaState.remindersPerPrompt.every((count) => count === 0)).toBe(true);
    // log 讀日誌，噪音只在 state 裡：提醒照出，子日誌記三則。
    expect(Math.max(...viaLog.remindersPerPrompt)).toBe(3);
    expect(viaLog.subagentLoggedReminders).toEqual([3]);
  });

  it('並行兩個同一份定義的子代理：各自的鏈各自數，各一則提醒', async () => {
    const viaLog = await run(loop, 'log', TWO_REPEATING);
    expect(viaLog.built).toBe('log');
    expect(viaLog.subagentEventTypes).toHaveLength(2);
    expect(viaLog.subagentLoggedReminders).toEqual([1, 1]);
  });

  /**
   * spawn input 寫不進去（#1665）：子代理那一步失敗，root 收到原錯；寫入恢復之後再派可以成功。
   *
   * 重試是 root 的模型做的：它看到失敗的工具結果，自己再派一個（腳本第二個 `task`）；程式碼層沒有重試。
   * 失敗那一個子代理的日誌留在註冊表裡、沒有事件；它的等著寫登記以那份日誌為鍵，不擋新的子代理（新的有自己的日誌與登記）。
   * 失敗只注入一次，所以分得出誰先查：剪裁器（`summarization.ts` 的 `pruneLogOf`）吞查找錯誤，若它是這一步第一個查找，下一個查找會重寫成功、甲照常跑，這條就紅。
   */
  it('spawn input 寫不進去：子代理那一步失敗、root 收到原錯，恢復後再派可成功', async () => {
    const boom = new Error('寫不進去：spawn input');
    const turns: readonly ScriptedTurn[] = [
      { content: '委派。', toolCalls: [task('幹活甲')] },
      { content: '失敗了，再派一個。', toolCalls: [task('幹活乙')] },
      { content: '乙收工。' },
      { content: '根收工。' },
    ];
    const result = await run(loop, 'log', turns, [WORKER], undefined, boom);
    expect(result.built).toBe('log');
    // 模型呼叫：root、root（看到失敗後再派）、乙、root；甲沒有叫到模型。
    expect(result.prompts).toHaveLength(4);
    // root 第二輪的 prompt 裡有原錯的文字（不是被包成別的訊息、也不是靜默成功）。
    expect(JSON.stringify(result.prompts[1])).toContain('寫不進去：spawn input');
    // 甲：日誌在、沒有任何事件；乙：自己的第一句是自己的任務，之後有回覆。
    expect(result.subagentEventTypes).toHaveLength(2);
    expect(result.subagentEventTypes[0]).toEqual([]);
    expect(result.subagentInputs[0]).toBe('""');
    expect(result.subagentInputs[1]).toContain('幹活乙');
    expect(result.subagentEventTypes[1]).toContain('assistant/message');
    // 乙的 prompt 只有自己的任務，沒有甲的。
    const sub = result.prompts[2] ?? [];
    expect(JSON.stringify(sub)).toContain('幹活乙');
    expect(JSON.stringify(sub)).not.toContain('幹活甲');
  });
});
