/**
 * 子代理的模型歷史在 `history-source=log` 下從它自己的日誌推（[#2751](https://github.com/DemianLi/nexus-agent/issues/2751)，
 * [#2362](https://github.com/DemianLi/nexus-agent/issues/2362)），**真的派前景子代理、兩種 loop 各跑一次**。
 *
 * - 逐字相同：同一支腳本在 `state` 與 `log` 下，模型每一輪（root 與子代理）收到的 prompt 在型別、內容、tool_calls、tool_call_id 上相同。
 *   另外與基準比：基準在 `1ef6ca6c`（子代理仍讀 state 的樹）上以 `log` 實跑存下，釘住當時模型每一輪收到的 prompt 與子日誌的事件型別序。
 * - 分得出「退回 state」：一顆只往 graph state 加訊息、不記進日誌的 middleware。`state` 下模型收得到那一則（對照），`log` 下子代理的
 *   prompt 裡不能出現它：子代理若退回送 state，這一條會紅。
 * - 並行兩個同一份定義的子代理：各自的 prompt 只有自己的任務，不含對方的。
 *
 * 這一檔明給 `historySource` 與 `agentLoop`，setup 的 mock 只在沒給時補值，所以不影響；每個比對 `state` 與 `log` 的場景都斷言組裝回報的 `historySource`。
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { createHookStepMiddleware } from '@nexus/core';
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

const STATE_ONLY_MARK = '只在 graph state 裡、沒進日誌的那一則';
/** `UPDATE_BASELINE=1` 時把這一次的結果寫成基準。基準要在 `1ef6ca6c` 的樹上產生：先把本檔複製過去再跑，在別的樹上跑會把基準蓋成那棵樹的結果。 */
const BASELINE_PATH = new URL('./subagent-history-from-log.baseline.json', import.meta.url);

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

/** 每次叫模型之前，往這個 agent 的 graph state 加一則沒記進日誌的訊息（每個 agent 一次）。root 與子代理都走它。 */
const STATE_ONLY: PluginEntry = {
  plugin: {
    name: 'state-only-mark',
    apply(registry) {
      registry.middleware.use(
        createHookStepMiddleware({
          name: 'stateOnlyMark',
          beforeModel: (state: unknown) => {
            const messages = (state as { messages?: readonly BaseMessage[] }).messages ?? [];
            if (messages.some((message) => message.text === STATE_ONLY_MARK)) return undefined;
            return { messages: [new HumanMessage(STATE_ONLY_MARK)] };
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

/** 比型別、內容、tool_calls、tool_call_id；id、時間戳與其他 kwargs 不比。 */
function project(message: BaseMessage): unknown {
  return {
    type: message.getType(),
    // 摘要附的歷史檔名帶每次隨機的會話代號，其餘逐字。
    content: JSON.parse(
      JSON.stringify(message.content).replace(/session_[0-9a-f]+\.md/g, 'session_X.md'),
    ) as unknown,
    toolCalls: 'tool_calls' in message ? message.tool_calls : undefined,
    toolCallId: 'tool_call_id' in message ? message.tool_call_id : undefined,
  };
}

interface Run {
  readonly prompts: readonly (readonly unknown[])[];
  readonly built: HistorySource;
  /** 子日誌上的事件型別序，一個子代理一份。 */
  readonly subagentEventTypes: readonly (readonly string[])[];
  /** 子日誌第一則 `user/message` 的 message（spawn input）。 */
  readonly subagentFirstInputs: readonly string[];
}

async function run(
  loop: Loop,
  historySource: HistorySource,
  turns: readonly ScriptedTurn[],
  plugins: readonly PluginEntry[] = [WORKER],
  summarization?: CreateNexusAgentOptions['summarization'],
): Promise<Run> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-subagent-log-'));
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
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'subagent-log');
  const detach = built.attachSession(pump.sessions);
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
      built: built.historySource,
      subagentEventTypes: subagents.map((entry) => entry.log.events.map((event) => event.type)),
      subagentFirstInputs: subagents.map((entry) => {
        const first = entry.log.events.find((event) => event.type === 'user/message');
        return JSON.stringify((first?.data as { message?: unknown } | undefined)?.message ?? null);
      }),
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

const ONE_SUBAGENT: readonly ScriptedTurn[] = [
  { content: '委派。', toolCalls: [task('幹活')] },
  { content: '', toolCalls: [{ name: 'noop', args: {} }] },
  { content: '', toolCalls: [{ name: 'noop', args: {} }] },
  { content: '子代理收工。' },
  { content: '根收工。' },
];

const TWO_SUBAGENTS: readonly ScriptedTurn[] = [
  { content: '委派。', toolCalls: [task('幹活甲'), task('幹活乙')] },
  { content: '甲收工。' },
  { content: '乙收工。' },
  { content: '根收工。' },
];

/**
 * 子代理叫三次工具（累到 7 則，超過門檻 6；root 只有 4 則，不會觸發），摘要器在第四輪之前跑一次（吃掉第五個腳本輪），
 * 之後再叫一次工具、收工。
 */
const WITH_SUMMARY: readonly ScriptedTurn[] = [
  { content: '委派。', toolCalls: [task('幹活')] },
  { content: '', toolCalls: [{ name: 'bulk', args: {} }] },
  { content: '', toolCalls: [{ name: 'bulk', args: {} }] },
  { content: '', toolCalls: [{ name: 'bulk', args: {} }] },
  { content: '摘要：子代理已經叫過三次 noop。' },
  { content: '', toolCalls: [{ name: 'bulk', args: {} }] },
  { content: '子代理收工。' },
  { content: '根收工。' },
];

const SUMMARY_SETTINGS = { trigger: [{ type: 'messages' as const, value: 6 }], retainTokens: 36 };

const sortedJson = (prompts: readonly (readonly unknown[])[]): string[] =>
  prompts.map((prompt) => JSON.stringify(prompt)).sort();

describe.each(['langgraph', 'native'] as const)('子代理的模型歷史從日誌推：%s', (loop) => {
  it('前景子代理：log 下每一輪 prompt 與 state 逐字相同，並與改之前的基準相同', async () => {
    const viaState = await run(loop, 'state', ONE_SUBAGENT);
    const viaLog = await run(loop, 'log', ONE_SUBAGENT);

    expect(viaState.built).toBe('state');
    expect(viaLog.built).toBe('log');
    // 子代理三輪（兩次工具、一次收工）加 root 兩輪；少了就沒量到子代理。
    expect(viaLog.subagentEventTypes).toHaveLength(1);
    expect(viaLog.prompts.length).toBe(5);
    expect(viaLog.prompts).toEqual(viaState.prompts);
    expect(viaLog.subagentEventTypes).toEqual(viaState.subagentEventTypes);
    // spawn input 是子日誌第一句進模型的話，由 `forCall` 寫（#1159）。
    expect(viaLog.subagentFirstInputs[0]).toContain('幹活');

    const key = `${loop}`;
    const actual = {
      prompts: viaLog.prompts,
      subagentEventTypes: viaLog.subagentEventTypes,
    };
    if (process.env['UPDATE_BASELINE'] === '1') {
      const all = existsSync(BASELINE_PATH)
        ? (JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Record<string, unknown>)
        : {};
      all[key] = actual;
      writeFileSync(BASELINE_PATH, `${JSON.stringify(all, null, 2)}\n`);
      return;
    }
    const baseline = (JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Record<string, unknown>)[
      key
    ];
    expect(JSON.parse(JSON.stringify(actual))).toEqual(baseline);
  });

  it('分得出退回 state：只在 state 裡的那一則，state 下模型收得到、log 下子代理收不到', async () => {
    const plugins = [WORKER, STATE_ONLY];
    const viaState = await run(loop, 'state', ONE_SUBAGENT, plugins);
    const viaLog = await run(loop, 'log', ONE_SUBAGENT, plugins);
    expect(viaState.built).toBe('state');
    expect(viaLog.built).toBe('log');
    const withMark = (prompts: readonly (readonly unknown[])[]): number =>
      prompts.filter((prompt) => JSON.stringify(prompt).includes(STATE_ONLY_MARK)).length;
    const isSubagent = (prompt: readonly unknown[]): boolean =>
      JSON.stringify(prompt).includes('幹活');

    // 對照：state 下每一輪（root 與子代理）都收得到。
    expect(withMark(viaState.prompts)).toBe(viaState.prompts.length);
    expect(viaState.prompts.filter(isSubagent).length).toBeGreaterThan(0);
    // log 下沒有任何一輪收得到：root 與子代理都從日誌推。
    expect(withMark(viaLog.prompts)).toBe(0);
  });

  it('並行兩個同一份定義的子代理：各自的 prompt 只有自己的任務，且與 state 相同', async () => {
    const viaState = await run(loop, 'state', TWO_SUBAGENTS);
    const viaLog = await run(loop, 'log', TWO_SUBAGENTS);
    expect(viaState.built).toBe('state');
    expect(viaLog.built).toBe('log');

    expect(viaLog.subagentEventTypes).toHaveLength(2);
    // 兩個子代理各一份日誌，各自第一句是自己的任務。
    expect(viaLog.subagentFirstInputs.filter((text) => text.includes('幹活甲'))).toHaveLength(1);
    expect(viaLog.subagentFirstInputs.filter((text) => text.includes('幹活乙'))).toHaveLength(1);
    // 子代理的 prompt：含甲的不含乙，反之亦然（root 的兩輪不是都不含、就是都含，XOR 排除）。
    const json = viaLog.prompts.map((prompt) => JSON.stringify(prompt));
    const subagentPrompts = json.filter(
      (text) => text.includes('幹活甲') !== text.includes('幹活乙'),
    );
    expect(subagentPrompts).toHaveLength(2);
    // 兩個子代理的輪次交錯順序不固定，比的是集合。
    expect(sortedJson(viaLog.prompts)).toEqual(sortedJson(viaState.prompts));
  });

  it('前景子代理跑到摘要：log 下每一輪 prompt 與 state 逐字相同，子日誌上有 compaction/summary', async () => {
    const viaState = await run(loop, 'state', WITH_SUMMARY, [WORKER], SUMMARY_SETTINGS);
    const viaLog = await run(loop, 'log', WITH_SUMMARY, [WORKER], SUMMARY_SETTINGS);

    expect(viaLog.built).toBe('log');
    // 子日誌上有摘要。
    expect(viaLog.subagentEventTypes[0]).toContain('compaction/summary');
    expect(viaState.subagentEventTypes[0]).toContain('compaction/summary');
    expect(viaLog.prompts).toEqual(viaState.prompts);
  });
});
