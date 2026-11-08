/**
 * native agent loop 對照 LangGraph（[#2356](https://github.com/DemianLi/nexus-agent/issues/2356)）：同一份腳本、同一串 plugin，
 * 兩個 loop 各跑一次，比 pump 會讀的 v3 欄位與會話日誌。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  RemoveMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { tool } from '@langchain/core/tools';
import { Command, MemorySaver } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import {
  createHookStepMiddleware,
  FOREGROUND_SUBAGENT_DELEGATION_CONTEXT,
  SESSION_EVENT_MAX_DEPTH,
  SessionRegistry,
  SUBAGENT_DELEGATION_CONTEXT,
  TURN_CANCEL_CONFIG_KEY,
  withModelCallStep,
} from '@nexus/core';
import type { AgentLoopKind, PluginEntry, SessionEvent } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { humanChannelPlugin } from './fixtures.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { markProjectionsHandled } from './thread-pump.js';
import type { RunProjections } from './thread-pump.js';

const THREAD = 'native-parity';

const toolsPlugin: PluginEntry = {
  plugin: {
    name: 'native-parity-tools',
    apply(registry) {
      registry.tools.register(
        tool(({ text }: { text: string }) => `回聲：${text}`, {
          name: 'echo',
          description: '原樣回聲。',
          schema: z.object({ text: z.string() }),
        }),
      );
      registry.tools.register(
        tool(
          () => {
            throw new Error('連不上');
          },
          { name: 'boom', description: '會拋錯。', schema: z.object({}) },
        ),
      );
      registry.tools.register(
        tool(() => ['好了', pastLogDepthCap()] as [string, unknown], {
          name: 'deep',
          description: '結果記不進日誌。',
          schema: z.object({}),
          responseFormat: 'content_and_artifact',
        }),
      );
    },
  },
};

/** 前景委派的對象。 */
const workerPlugin: PluginEntry = {
  plugin: {
    name: 'native-parity-worker',
    apply(registry) {
      registry.subagents.register({ name: 'worker', description: '幹活的。' });
    },
  },
};

interface RawEvent {
  readonly method: string;
  readonly params: { readonly namespace: string[]; readonly node?: string; readonly data: unknown };
}

/** `tool-finished` 的 `output`：pump 的 `#toolData` 拿它判定，比 `status` 與 `content`。 */
function toolOutputOf(output: unknown): string {
  if (!ToolMessage.isInstance(output))
    return `raw:${JSON.stringify(output).replace(UUID, '<uuid>')}`;
  return JSON.stringify({ status: output.status, content: output.content });
}

/** pump 與 wire 會讀的欄位（`thread-pump.ts` 的 `trackRootReply`、`isRootTerminal`、`#translate`）。id 換成出現序。 */
function projected(events: readonly RawEvent[]): string[] {
  const ids = new Map<string, string>();
  const idOf = (raw: unknown): string => {
    if (typeof raw !== 'string') return String(raw);
    if (!ids.has(raw)) ids.set(raw, `${raw.startsWith('run-') ? 'run-' : 'id-'}${ids.size}`);
    return ids.get(raw)!;
  };
  const out: string[] = [];
  for (const event of events) {
    const data = (event.params.data ?? {}) as Record<string, unknown>;
    const ns = event.params.namespace.length;
    if (event.method === 'lifecycle') {
      out.push(`lifecycle ns${ns} ${String(data['event'])} ${String(data['graph_name'])}`);
    } else if (event.method === 'messages') {
      const delta = data['delta'] as Record<string, unknown> | undefined;
      out.push(
        `messages ns${ns} node=${String(event.params.node)} ${String(data['event'])}` +
          (data['id'] === undefined ? '' : ` id=${idOf(data['id'])}`) +
          (data['role'] === undefined ? '' : ` role=${String(data['role'])}`) +
          (delta === undefined
            ? ''
            : ` ${String(delta['type'])}=${JSON.stringify(delta['text'] ?? delta['reasoning'] ?? '')}`),
      );
    } else if (event.method === 'tools') {
      out.push(
        `tools ns${ns} ${String(data['event'])} call=${String(data['tool_call_id'])}` +
          (data['tool_name'] === undefined ? '' : ` name=${String(data['tool_name'])}`) +
          (data['input'] === undefined ? '' : ` input=${String(data['input'])}`) +
          (data['message'] === undefined ? '' : ` message=${String(data['message'])}`) +
          (data['output'] === undefined ? '' : ` output=${toolOutputOf(data['output'])}`),
      );
    } else if (event.method === 'custom' && ns === 0) {
      out.push(`custom ns0 ${JSON.stringify(data)}`);
    }
  }
  return out;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const CLOCK_KEYS = new Set([
  'time',
  'timestamp',
  'durationMs',
  'elapsedMs',
  'startedAt',
  'endedAt',
]);

/** 日誌逐筆的型別與內容；時間換成記號、uuid 換成出現序。 */
function logShape(events: readonly SessionEvent[]): string[] {
  const ids = new Map<string, string>();
  return events.map((event) =>
    JSON.stringify({ type: event.type, data: event.data }, (key, value: unknown) => {
      if (CLOCK_KEYS.has(key) && typeof value === 'number') return '<clock>';
      if (typeof value !== 'string') return value;
      return value.replace(UUID, (raw) => {
        if (!ids.has(raw)) ids.set(raw, `<uuid-${ids.size}>`);
        return ids.get(raw)!;
      });
    }),
  );
}

/**
 * 已知差異（中斷類，TODO(#2358)）：native 沒有存檔點，核准管道是 `no-channel`，前景子代理的委派聲明因此是「會自動被拒絕」
 * 那一句（`subagent-delegation.ts` 的 `foregroundDelegationContext`）。換回 LangGraph 那一句再比，其餘一個字都不放過。
 */
function withKnownDifferences(log: string[][]): string[][] {
  const from = JSON.stringify(SUBAGENT_DELEGATION_CONTEXT).slice(1, -1);
  const to = JSON.stringify(FOREGROUND_SUBAGENT_DELEGATION_CONTEXT).slice(1, -1);
  return log.map((lines) => lines.map((line) => line.replaceAll(from, to)));
}

async function runOnce(
  loop: AgentLoopKind,
  turns: readonly ScriptedTurn[],
  prompt: string,
  extra: readonly PluginEntry[] = [],
) {
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns }),
    checkpointer: new MemorySaver(),
    plugins: [humanChannelPlugin(), toolsPlugin, workerPlugin, ...extra],
    agentLoop: loop,
  });
  const sessions = new SessionRegistry(THREAD);
  const detach = built.attachSession(sessions);
  const raw: RawEvent[] = [];
  try {
    const run = await built.agent.streamEvents(toAgentInvocation(prompt) as never, {
      configurable: { thread_id: THREAD },
      version: 'v3',
    });
    // LangGraph 那條的投影孤兒（工具拋錯時），pump 也這樣標掉。
    markProjectionsHandled(run as RunProjections);
    let failure: string | undefined;
    try {
      for await (const event of run as AsyncIterable<RawEvent>) raw.push(event);
    } catch (error) {
      failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    const logs = sessions
      .list()
      .map((entry) => [entry.address.kind, ...logShape(entry.log.events)]);
    return { events: projected(raw), log: logs, failure };
  } finally {
    detach();
    await built.dispose();
  }
}

describe('native loop 對照 LangGraph', () => {
  const scenarios: [string, ScriptedTurn[]][] = [
    ['只有文字', [{ content: '你好。' }]],
    [
      '一顆工具',
      [
        { content: '我來回聲。', toolCalls: [{ name: 'echo', args: { text: '嗨' } }] },
        { content: '好了。' },
      ],
    ],
    [
      '平行兩顆工具',
      [
        {
          content: '兩顆。',
          toolCalls: [
            { name: 'echo', args: { text: '一' } },
            { name: 'echo', args: { text: '二' } },
          ],
        },
        { content: '好了。' },
      ],
    ],
    [
      '工具拋錯',
      [{ content: '試試。', toolCalls: [{ name: 'boom', args: {} }] }, { content: '壞了。' }],
    ],
    [
      '沒有這顆工具',
      [{ content: '試試。', toolCalls: [{ name: 'nope', args: {} }] }, { content: '沒有。' }],
    ],
    ['模型出錯', [{ content: '', error: '供應商過載' }]],
    // 這一步失敗：跑完的兄弟、失敗那顆在事件與日誌上跟 LangGraph 一樣。前一顆失敗、兄弟晚進的那種不在這裡比，見下面「native 下同一步的兄弟」。
    [
      '兄弟跑完、後一顆失敗',
      [
        {
          content: '',
          toolCalls: [
            { name: 'echo', args: { text: '先' } },
            { name: 'deep', args: {} },
          ],
        },
      ],
    ],
    [
      '前景委派',
      [
        {
          content: '委派。',
          toolCalls: [{ name: 'task', args: { description: '幹活', subagent_type: 'worker' } }],
        },
        { content: '子代理動手。', toolCalls: [{ name: 'echo', args: { text: '子' } }] },
        { content: '子代理收工。' },
        { content: '收工。' },
      ],
    ],
  ];
  it.each(scenarios)('%s', async (_label, turns) => {
    const graph = await runOnce('langgraph', turns, '開始。');
    const native = await runOnce('native', turns, '開始。');
    expect(native.failure).toEqual(graph.failure);
    expect(native.events).toEqual(graph.events);
    expect(withKnownDifferences(native.log)).toEqual(graph.log);
  });

  it('beforeAgent 跳 end 之後，afterAgent 照樣能跳回模型', async () => {
    // 每個 loop 一份，第一次收尾時跳回模型、第二次放行。
    const jumps = (): PluginEntry => {
      let exits = 0;
      return {
        plugin: {
          name: 'native-parity-jumps',
          apply(registry) {
            registry.middleware.use(
              createHookStepMiddleware({
                name: 'nativeParityJumps',
                beforeAgent: { canJumpTo: ['end'], step: () => ({ jumpTo: 'end' as const }) },
                afterAgent: {
                  canJumpTo: ['model'],
                  step: () => (exits++ === 0 ? { jumpTo: 'model' as const } : undefined),
                },
              }),
            );
          },
        },
      };
    };
    const turns: ScriptedTurn[] = [{ content: '跳回來了。' }];
    const graph = await runOnce('langgraph', turns, '開始。', [jumps()]);
    const native = await runOnce('native', turns, '開始。', [jumps()]);
    // LangGraph 那條跳回模型時真的叫了模型；有這一條，下面的相等才分得出 native 有沒有跳回去。
    expect(graph.events.filter((line) => line.endsWith('message-start id=run-0'))).toHaveLength(1);
    expect(native.failure).toEqual(graph.failure);
    expect(native.events).toEqual(graph.events);
    expect(native.log).toEqual(graph.log);
  });
});

/**
 * native 下沒有存檔點（`fold.ts` 的 `foldApprovalChannel`），核准閘門是 `no-channel`：要核准的工具確定性地拒絕，**本體一次都不跑**，
 * 也不發中斷。LangGraph 下同一份組裝停在核准中斷（`tool-events.test.ts` 的「被核准閘門中斷的呼叫」）。
 */
describe('native 下要核准的工具', () => {
  it('本體呼叫 0 次，結果是拒絕，這一輪照常收完', async () => {
    let calls = 0;
    const dangerPlugin: PluginEntry = {
      plugin: {
        name: 'native-parity-danger',
        apply(registry) {
          registry.tools.register(
            tool(
              () => {
                calls += 1;
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
    const built = await createNexusAgent({
      model: new ScriptedChatModel({
        turns: [
          { content: '動手。', toolCalls: [{ name: 'danger', args: {} }] },
          { content: '收工。' },
        ],
      }),
      checkpointer: new MemorySaver(),
      plugins: [humanChannelPlugin(), dangerPlugin],
      agentLoop: 'native',
    });
    try {
      const result = await built.agent.invoke(toAgentInvocation('跑。'), {
        configurable: { thread_id: 'native-danger' },
      });
      expect(calls).toBe(0);
      expect((result as { __interrupt__?: unknown }).__interrupt__).toBeUndefined();
      const reply = result.messages.find((message) => ToolMessage.isInstance(message));
      expect(reply).toMatchObject({ name: 'danger', status: 'error' });
      // 分得出「閘門算出 no-channel 而拒絕」與「閘門以為有人在、撞上 `interrupt()` 的 No checkpointer set」：兩者都是 0 次、error。
      expect(String(reply?.content)).toContain(
        '這次組裝沒有 checkpointer，核准之後接不回來，所以沒有執行',
      );
      expect(result.messages.at(-1)?.content).toBe('收工。');
    } finally {
      await built.dispose();
    }
  });
});

/**
 * 同一步有一顆失敗了：兄弟拿到 abort、這一步拋第一個錯，同 LangGraph 的 `PregelRunner.tick`。
 *
 * 兄弟在失敗之後才進工具時（獨佔的兄弟排在失敗那顆後面）跟 LangGraph 不一樣：native 一失敗就 abort，兄弟不進工具；LangGraph
 * 要等它的 runner 收到那顆失敗才 abort，這段空檔裡進工具的兄弟會跑完。已知差異，不在上面的等值對照裡。不先拋的話兄弟會永遠懸著：
 * LangChain 的 `tool()` 拿到已經 abort 的 signal 不拒絕、也永不 resolve。
 */
describe('native 下同一步的兄弟', () => {
  // 可重疊時兩顆同時進工具；獨佔時屏障讓 wait 等 breaks 收完才進，進去時 signal 已經舉起來了。
  for (const [label, safe, order] of [
    ['可重疊：兄弟跑著時被 abort', true, ['wait', 'breaks']],
    ['獨佔：兄弟進工具時已經 abort', false, ['breaks', 'wait']],
  ] as const) {
    it(`${label}，這一輪拋第一個錯`, async () => {
      let sawAbort = false;
      const waitPlugin: PluginEntry = {
        plugin: {
          name: 'native-parity-wait',
          apply(registry) {
            registry.tools.register(
              tool(
                (_input, config) =>
                  new Promise<string>((resolve) => {
                    const signal = (config as { signal?: AbortSignal }).signal;
                    signal?.addEventListener('abort', () => {
                      sawAbort = true;
                      resolve('不該用到');
                    });
                  }),
                {
                  name: 'wait',
                  description: '等到被 abort。',
                  schema: z.object({}),
                  metadata: { concurrencySafe: safe },
                },
              ),
            );
            registry.tools.register(
              tool(() => ['好了', pastLogDepthCap()] as [string, unknown], {
                name: 'breaks',
                description: '結果記不進日誌。',
                schema: z.object({}),
                responseFormat: 'content_and_artifact',
                metadata: { concurrencySafe: safe },
              }),
            );
          },
        },
      };
      const turns: ScriptedTurn[] = [
        { content: '', toolCalls: order.map((name) => ({ name, args: {} })) },
        { content: '不該走到。' },
      ];
      const built = await createNexusAgent({
        model: new ScriptedChatModel({ turns }),
        checkpointer: new MemorySaver(),
        plugins: [waitPlugin],
        agentLoop: 'native',
      });
      const detach = built.attachSession(new SessionRegistry(THREAD));
      try {
        await expect(
          built.agent.invoke(toAgentInvocation('跑。'), { configurable: { thread_id: THREAD } }),
        ).rejects.toThrow('超過上限');
        if (safe) expect(sawAbort).toBe(true);
      } finally {
        detach();
        await built.dispose();
      }
    });
  }
});

/** 剛好超過日誌深度上限的值（同 `step-failure-closers.test.ts`）：結果記不進日誌，這一步失敗。 */
function pastLogDepthCap(): unknown {
  let value: unknown = 'leaf';
  for (let level = 0; level < SESSION_EVENT_MAX_DEPTH; level++) {
    value = level % 2 ? { next: value } : [value];
  }
  return value;
}

describe('native 不支援的跳轉', () => {
  it('beforeModel 宣告跳 tools：組裝時就拒絕，不在跑到時忽略', async () => {
    const plugin: PluginEntry = {
      plugin: {
        name: 'native-parity-tools-jump',
        apply(registry) {
          registry.middleware.use(
            createHookStepMiddleware({
              name: 'nativeParityToolsJump',
              beforeModel: { canJumpTo: ['tools'], step: () => undefined },
            }),
          );
        },
      },
    };
    await expect(
      createNexusAgent({
        model: new ScriptedChatModel({ turns: [{ content: '好。' }] }),
        checkpointer: new MemorySaver(),
        plugins: [plugin],
        agentLoop: 'native',
      }),
    ).rejects.toThrow(
      'native agent loop 不支援 beforeModel 跳 tools（middleware "nativeParityToolsJump"）',
    );
  });
});

/** 組一個 agent、跑一輪，回 `invoke` 的結果（或拋的錯，`name: message`）與跑完之後的 `getState`。 */
async function invokeOnce(
  loop: AgentLoopKind,
  turns: readonly ScriptedTurn[],
  plugins: readonly PluginEntry[],
  signal?: AbortSignal,
  input: Readonly<Record<string, unknown>> = { ...toAgentInvocation('跑。') },
) {
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns }),
    checkpointer: new MemorySaver(),
    plugins: [...plugins],
    agentLoop: loop,
  });
  const detach = built.attachSession(new SessionRegistry(THREAD));
  const config = { configurable: { thread_id: THREAD } };
  try {
    let output: Record<string, unknown> | undefined;
    let failure: string | undefined;
    try {
      output = (await built.agent.invoke(input as never, {
        ...config,
        ...(signal !== undefined && { signal }),
      })) as Record<string, unknown>;
    } catch (error) {
      failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    const state = (await built.agent.getState(config)) as { values: Record<string, unknown> };
    return { output, failure, values: state.values };
  } finally {
    detach();
    await built.dispose();
  }
}

/** 一顆帶私有鍵 `_secret` 與一般鍵 `marker` 的 middleware；`beforeModel` 寫私有鍵。 */
function markerPlugin(): PluginEntry {
  return {
    plugin: {
      name: 'native-parity-marker',
      apply(registry) {
        registry.middleware.use(
          createHookStepMiddleware({
            name: 'nativeParityMarker',
            stateSchema: z.object({
              _secret: z.string().optional(),
              marker: z.string().optional(),
            }),
            beforeModel: () => ({ _secret: '不外漏' }),
          }),
        );
      },
    },
  };
}

describe('native 的 state 對照 LangGraph', () => {
  it('invoke 的結果不帶 `_` 開頭的私有鍵', async () => {
    const turns: ScriptedTurn[] = [{ content: '好。' }];
    const graph = await invokeOnce('langgraph', turns, [markerPlugin()]);
    const native = await invokeOnce('native', turns, [markerPlugin()]);
    // 私有鍵真的寫進了 state，下面的比較才分得出有沒有濾。
    expect(native.values['_secret']).toBe('不外漏');
    expect(Object.keys(graph.output ?? {})).not.toContain('_secret');
    expect(Object.keys(native.output ?? {}).sort()).toEqual(Object.keys(graph.output ?? {}).sort());
  });

  it('工具這一步失敗：失敗那顆已經送出的寫入照套進 state', async () => {
    const sends: PluginEntry = {
      plugin: {
        name: 'native-parity-sends',
        apply(registry) {
          registry.tools.register(
            tool(
              (_input, config) => {
                const send = (
                  config as { configurable?: { __pregel_send?: (w: [string, unknown][]) => void } }
                ).configurable?.__pregel_send;
                send?.([['marker', '寫了']]);
                return ['好了', pastLogDepthCap()] as [string, unknown];
              },
              {
                name: 'sends',
                description: '先寫 state，結果記不進日誌。',
                schema: z.object({}),
                responseFormat: 'content_and_artifact',
              },
            ),
          );
        },
      },
    };
    const turns: ScriptedTurn[] = [
      { content: '', toolCalls: [{ name: 'sends', args: {} }] },
      { content: '不該走到。' },
    ];
    const graph = await invokeOnce('langgraph', turns, [markerPlugin(), sends]);
    const native = await invokeOnce('native', turns, [markerPlugin(), sends]);
    expect(graph.failure).toContain('超過上限');
    expect(native.failure).toEqual(graph.failure);
    expect(graph.values['marker']).toBe('寫了');
    expect(native.values['marker']).toBe('寫了');
  });
});

/** 訊息換成「型別:內容」，物件的鍵排序，比得出寫了什麼、不比物件身分。 */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shapeOf);
  if (BaseMessage.isInstance(value)) {
    return `${value.getType()}:${typeof value.content === 'string' ? value.content : JSON.stringify(value.content)}`;
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, shapeOf(entry)]),
    );
  }
  return value;
}

/** 回 `Command` 的工具：寫 `marker` 與它自己的那則結果，同 task、todo、goal 那幾顆工具的回法。 */
const commandPlugin: PluginEntry = {
  plugin: {
    name: 'native-parity-command',
    apply(registry) {
      registry.tools.register(
        tool(
          (_input, config) =>
            new Command({
              update: {
                marker: '命令寫的',
                messages: [
                  new ToolMessage({
                    content: '命令的結果',
                    tool_call_id: (config as { toolCall?: { id?: string } }).toolCall?.id ?? '',
                    name: 'command',
                  }),
                ],
              },
            }),
          { name: 'command', description: '回 Command。', schema: z.object({}) },
        ),
      );
    },
  },
};

/** 三種 hook：`beforeAgent` 不寫，`beforeModel` 插一則訊息（同重複提醒），`afterAgent` 寫 `marker`。 */
const hookWritesPlugin: PluginEntry = {
  plugin: {
    name: 'native-parity-hook-writes',
    apply(registry) {
      registry.middleware.use(
        createHookStepMiddleware({
          name: 'nativeParityHookWrites',
          beforeAgent: () => undefined,
          beforeModel: () => ({ messages: [new HumanMessage('提醒')] }),
          afterAgent: () => ({ marker: '收尾' }) as never,
        }),
      );
    },
  },
};

/**
 * 回它的 config 帶了哪幾格只給 run 的選項。漏下去的話，工具裡再叫一張圖（`task` 叫子代理）會照呼叫端的 `streamMode` 回一串
 * chunk 而不是 state。
 */
const runOptionsPlugin: PluginEntry = {
  plugin: {
    name: 'native-parity-run-options',
    apply(registry) {
      registry.tools.register(
        tool(
          (_input, config) =>
            ['streamMode', 'runId', 'debug', 'outputKeys', 'subgraphs']
              .filter((key) => (config as Record<string, unknown>)[key] !== undefined)
              .join(',') || '沒有',
          { name: 'runOptions', description: '回 config 裡的 run 選項。', schema: z.object({}) },
        ),
      );
    },
  },
};

/** CLI 的 `runTurn`（`cli.ts`）照 `stream()` 的 updates 印過程：每一筆 `[節點, 寫入]`。 */
async function streamUpdates(
  loop: AgentLoopKind,
  turns: readonly ScriptedTurn[],
  plugins: readonly PluginEntry[],
) {
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns }),
    checkpointer: new MemorySaver(),
    plugins: [toolsPlugin, markerPlugin(), ...plugins],
    agentLoop: loop,
  });
  const detach = built.attachSession(new SessionRegistry(THREAD));
  try {
    const updates: [string, unknown][] = [];
    for await (const [mode, payload] of await built.agent.stream(toAgentInvocation('跑。'), {
      streamMode: ['updates', 'values'],
      configurable: { thread_id: THREAD },
    })) {
      if (mode !== 'updates') continue;
      for (const [node, update] of Object.entries(payload as Record<string, unknown>)) {
        updates.push([node, shapeOf(update)]);
      }
    }
    return updates;
  } finally {
    detach();
    await built.dispose();
  }
}

describe('native 的 stream() 對照 LangGraph', () => {
  const scenarios: [string, ScriptedTurn[], PluginEntry[]][] = [
    ['只有文字', [{ content: '你好。' }], []],
    [
      '平行兩顆工具',
      [
        {
          content: '',
          toolCalls: [
            { name: 'echo', args: { text: '一' } },
            { name: 'echo', args: { text: '二' } },
          ],
        },
        { content: '好了。' },
      ],
      [],
    ],
    [
      '回 Command 的工具與一般工具同一步',
      [
        {
          content: '',
          toolCalls: [
            { name: 'command', args: {} },
            { name: 'echo', args: { text: '二' } },
          ],
        },
        { content: '好了。' },
      ],
      [commandPlugin],
    ],
    ['hook 寫了東西', [{ content: '好了。' }], [hookWritesPlugin]],
    [
      '工具讀得到的 config 不帶呼叫端的 streamMode',
      [{ content: '', toolCalls: [{ name: 'runOptions', args: {} }] }, { content: '好了。' }],
      [runOptionsPlugin],
    ],
  ];
  it.each(scenarios)('%s：updates 逐筆相同', async (_label, turns, plugins) => {
    const graph = await streamUpdates('langgraph', turns, plugins);
    const native = await streamUpdates('native', turns, plugins);
    // hook 節點在 LangGraph 下真的吐了 updates，下面的相等才分得出 native 有沒有吐。
    expect(graph.some(([node]) => String(node).endsWith('.before_model'))).toBe(true);
    expect(native).toEqual(graph);
  });
});

/**
 * 記下沒有 parent 的 run：tracer（LangSmith）要等 root run 收尾才送出整串，模型與工具的 run 要掛在它底下。
 */
class RootRunRecorder extends BaseCallbackHandler {
  name = 'native-parity-root-runs';
  readonly roots: unknown[] = [];
  readonly #rootIds = new Set<string>();

  override handleChainStart(
    _chain: unknown,
    _inputs: unknown,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    _runType?: string,
    runName?: string,
  ): void {
    if (parentRunId !== undefined) return;
    this.#rootIds.add(runId);
    this.roots.push(['chain', runName]);
  }

  override handleChainEnd(outputs: Record<string, unknown>, runId: string): void {
    if (this.#rootIds.has(runId)) this.roots.push(['end', Object.keys(outputs).sort()]);
  }

  override handleChatModelStart(
    _llm: unknown,
    _messages: unknown,
    _runId: string,
    parentRunId?: string,
  ): void {
    if (parentRunId === undefined) this.roots.push(['model']);
  }

  override handleToolStart(
    _tool: unknown,
    _input: string,
    _runId: string,
    parentRunId?: string,
  ): void {
    if (parentRunId === undefined) this.roots.push(['tool']);
  }
}

describe('native 的 stream() 的 streamMode，對照 LangGraph', () => {
  const turns: ScriptedTurn[] = [
    { content: '', toolCalls: [{ name: 'echo', args: { text: '嗨' } }] },
    { content: '好。' },
  ];
  it.each([['updates'], [undefined]] as const)(
    'streamMode 是 %s：吐的是內容本身，不是 [mode, 內容]',
    async (streamMode) => {
      const run = async (loop: AgentLoopKind) => {
        const built = await createNexusAgent({
          model: new ScriptedChatModel({ turns }),
          checkpointer: new MemorySaver(),
          plugins: [toolsPlugin, markerPlugin()],
          agentLoop: loop,
        });
        try {
          const chunks: unknown[] = [];
          for await (const chunk of await built.agent.stream(toAgentInvocation('跑。'), {
            configurable: { thread_id: THREAD },
            ...(streamMode !== undefined && { streamMode }),
          })) {
            chunks.push(Object.keys(chunk as object));
          }
          return chunks;
        } finally {
          await built.dispose();
        }
      };
      const graph = await run('langgraph');
      const native = await run('native');
      expect(graph).toContainEqual(['tools']);
      expect(native).toEqual(graph);
    },
  );
});

describe('native 的 callbacks 對照 LangGraph', () => {
  it('一次 run 一顆 root chain run，模型與工具的 run 都掛在它底下', async () => {
    const run = async (loop: AgentLoopKind) => {
      const built = await createNexusAgent({
        model: new ScriptedChatModel({
          turns: [
            { content: '', toolCalls: [{ name: 'echo', args: { text: '嗨' } }] },
            { content: '好。' },
          ],
        }),
        checkpointer: new MemorySaver(),
        plugins: [toolsPlugin, markerPlugin()],
        agentLoop: loop,
      });
      try {
        const recorder = new RootRunRecorder();
        await built.agent.invoke(toAgentInvocation('跑。'), {
          configurable: { thread_id: THREAD },
          callbacks: [recorder],
        });
        return recorder.roots;
      } finally {
        await built.dispose();
      }
    };
    const graph = await run('langgraph');
    const native = await run('native');
    expect(graph[0]).toEqual(['chain', 'LangGraph']);
    expect(native).toEqual(graph);
  });
});

/**
 * 一顆在 `where` 指的地方中止呼叫端 signal 的 middleware（加上一顆中止的工具與閘門）。`wrapModelCall` 先經 `__pregel_send` 寫
 * `marker`，比得出中止的模型節點送出的寫入有沒有套；工具本體跑一次往 `ran` 記一筆。
 */
function abortAt(where: string, controller: AbortController, ran: string[] = []): PluginEntry {
  const abort = (): void => controller.abort();
  return {
    plugin: {
      name: 'native-parity-abort-at',
      apply(registry) {
        registry.tools.register(
          tool(
            () => {
              ran.push('aborts');
              if (where === 'tool') abort();
              return '做完了';
            },
            { name: 'aborts', description: '本體裡中止。', schema: z.object({}) },
          ),
        );
        registry.approvals.gate(async (_exec, next) => {
          if (where === 'gate') abort();
          return next();
        });
        registry.middleware.use(
          withModelCallStep(
            async (request, next) => {
              (
                (request as { runtime: unknown }).runtime as {
                  configurable?: { __pregel_send?: (w: [string, unknown][]) => void };
                }
              ).configurable?.__pregel_send?.([['marker', '模型節點寫的']]);
              if (where === 'before handler') abort();
              const response = await next(request);
              if (where === 'after handler') abort();
              return response;
            },
            (wrapModelCall) =>
              createHookStepMiddleware({
                name: 'nativeParityAbortAt',
                beforeModel: () => {
                  if (where === 'beforeModel') abort();
                  return undefined;
                },
                wrapModelCall: wrapModelCall as never,
                afterAgent: () => {
                  if (where === 'afterAgent') abort();
                  return undefined;
                },
              }),
          ),
        );
      },
    },
  };
}

/**
 * 呼叫端的 `config.signal` 中止：拋的錯（名字與訊息）與留在 state 裡的訊息，兩個 loop 一樣。LangGraph 的節點看到中止時拋
 * signal 的 reason（`AbortError`），那個節點的寫入不套；已經過了閘門的工具本體照跑（被放掉，沒人等它）。
 */
describe('native 下呼叫端中止，對照 LangGraph', () => {
  const textOnly: ScriptedTurn[] = [{ content: '你好。' }];
  const withTool: ScriptedTurn[] = [
    { content: '', toolCalls: [{ name: 'aborts', args: {} }] },
    { content: '不該走到。' },
  ];
  const cases: [string, ScriptedTurn[]][] = [
    ['呼叫前', textOnly],
    ['beforeModel', textOnly],
    ['before handler', textOnly],
    ['after handler', textOnly],
    ['afterAgent', textOnly],
    ['after handler', withTool],
    ['gate', withTool],
    ['tool', withTool],
  ];
  it.each(cases)('中止在 %s', async (where, turns) => {
    const run = async (loop: AgentLoopKind) => {
      const controller = new AbortController();
      if (where === '呼叫前') controller.abort();
      const ran: string[] = [];
      const result = await invokeOnce(
        loop,
        turns,
        [markerPlugin(), abortAt(where, controller, ran)],
        controller.signal,
      );
      return {
        failure: result.failure,
        messages: shapeOf(result.values['messages']),
        marker: result.values['marker'],
        ran,
      };
    };
    const graph = await run('langgraph');
    const native = await run('native');
    expect(graph.failure).toBe('AbortError: This operation was aborted');
    expect(native).toEqual(graph);
  });
});

describe('native 的輸入與預設值，對照 LangGraph', () => {
  /** 宣告 `bag`（預設 `[]`）的 middleware，`beforeModel` 原地往裡推一格，順手記下 hook 讀得到的鍵。 */
  const bagPlugin = (seen: string[][]): PluginEntry => ({
    plugin: {
      name: 'native-parity-bag',
      apply(registry) {
        registry.middleware.use(
          createHookStepMiddleware({
            name: 'nativeParityBag',
            stateSchema: z.object({ bag: z.array(z.string()).default([]) }),
            beforeModel: (state) => {
              seen.push(Object.keys(state as object).sort());
              (state as { bag: string[] }).bag.push('推了');
              return undefined;
            },
          }),
        );
      },
    },
  });

  it('輸入只套宣告過的公開鍵', async () => {
    const input = { ...toAgentInvocation('跑。'), marker: '輸入帶的', _given: '私的', zzz: 1 };
    const turns: ScriptedTurn[] = [{ content: '好。' }];
    const pick = (values: Record<string, unknown>) => ({
      marker: values['marker'],
      zzz: values['zzz'],
    });
    // 私有鍵不出現在結果裡（`outputOf`），只能在第一顆 hook 裡看它有沒有進 state。
    const run = async (loop: AgentLoopKind) => {
      const seen: unknown[] = [];
      const given: PluginEntry = {
        plugin: {
          name: 'native-parity-given',
          apply(registry) {
            registry.middleware.use(
              createHookStepMiddleware({
                name: 'nativeParityGiven',
                stateSchema: z.object({ _given: z.string().optional() }),
                beforeAgent: (state) => {
                  seen.push((state as { _given?: string })._given);
                  return undefined;
                },
              }),
            );
          },
        },
      };
      const result = await invokeOnce(loop, turns, [markerPlugin(), given], undefined, input);
      return { values: pick(result.values), seen };
    };
    const graph = await run('langgraph');
    const native = await run('native');
    expect(graph.values.marker).toBe('輸入帶的');
    expect(graph.seen).toEqual([undefined]);
    expect(native).toEqual(graph);
  });

  it('hook 只讀得到 messages 與自己宣告的鍵；預設值每條 thread 各一份', async () => {
    const run = async (loop: AgentLoopKind) => {
      const seen: string[][] = [];
      const built = await createNexusAgent({
        model: new ScriptedChatModel({ turns: [{ content: '一。' }, { content: '二。' }] }),
        checkpointer: new MemorySaver(),
        plugins: [markerPlugin(), bagPlugin(seen)],
        agentLoop: loop,
      });
      try {
        const bags: unknown[] = [];
        for (const thread of ['甲', '乙']) {
          const config = { configurable: { thread_id: thread } };
          await built.agent.invoke(toAgentInvocation('跑。'), config);
          bags.push(
            ((await built.agent.getState(config)) as { values: { bag?: unknown } }).values.bag,
          );
        }
        return { seen, bags };
      } finally {
        await built.dispose();
      }
    };
    const graph = await run('langgraph');
    const native = await run('native');
    expect(graph.bags).toEqual([['推了'], ['推了']]);
    expect(native).toEqual(graph);
  });

  it('寫進沒有宣告的鍵：Command 與 hook 寫的都不進 state', async () => {
    const undeclared: PluginEntry = {
      plugin: {
        name: 'native-parity-undeclared',
        apply(registry) {
          registry.tools.register(
            tool(
              (_input, config) =>
                new Command({
                  update: {
                    undeclared: '命令寫的',
                    messages: [
                      new ToolMessage({
                        content: '命令的結果',
                        tool_call_id: (config as { toolCall?: { id?: string } }).toolCall?.id ?? '',
                        name: 'undeclared',
                      }),
                    ],
                  },
                }),
              { name: 'undeclared', description: '寫沒宣告的鍵。', schema: z.object({}) },
            ),
          );
          registry.middleware.use(
            createHookStepMiddleware({
              name: 'nativeParityUndeclared',
              afterAgent: () => ({ hookUndeclared: 'hook 寫的' }) as never,
            }),
          );
        },
      },
    };
    const turns: ScriptedTurn[] = [
      { content: '', toolCalls: [{ name: 'undeclared', args: {} }] },
      { content: '好。' },
    ];
    const pick = (values: Record<string, unknown>) => ({
      undeclared: values['undeclared'],
      hookUndeclared: values['hookUndeclared'],
      messages: shapeOf(values['messages']),
    });
    const graph = await invokeOnce('langgraph', turns, [markerPlugin(), undeclared]);
    const native = await invokeOnce('native', turns, [markerPlugin(), undeclared]);
    expect(graph.failure).toBeUndefined();
    expect(graph.values['messages']).toHaveLength(4);
    expect(pick(native.values)).toEqual(pick(graph.values));
  });

  it('模型那一步失敗：wrapModelCall 已經送出的寫入照套進 state', async () => {
    const sendsBeforeModel: PluginEntry = {
      plugin: {
        name: 'native-parity-model-sends',
        apply(registry) {
          registry.middleware.use(
            withModelCallStep(
              async (request, next) => {
                const send = (
                  (request as { runtime: unknown }).runtime as {
                    configurable?: { __pregel_send?: (w: [string, unknown][]) => void };
                  }
                ).configurable?.__pregel_send;
                send?.([['marker', '模型前寫的']]);
                return next(request);
              },
              (wrapModelCall) =>
                createMiddleware({
                  name: 'nativeParityModelSends',
                  wrapModelCall: wrapModelCall as never,
                }),
            ),
          );
        },
      },
    };
    const turns: ScriptedTurn[] = [{ content: '', error: '供應商過載' }];
    const graph = await invokeOnce('langgraph', turns, [markerPlugin(), sendsBeforeModel]);
    const native = await invokeOnce('native', turns, [markerPlugin(), sendsBeforeModel]);
    expect(graph.failure).toBeDefined();
    expect(native.failure).toEqual(graph.failure);
    expect(graph.values['marker']).toBe('模型前寫的');
    expect(native.values['marker']).toBe('模型前寫的');
  });
});

describe('native 的多輪、updateState 與上限，對照 LangGraph', () => {
  it('同一條 thread：第一輪之後 updateState 補一則、RemoveMessage 拿掉一則，第二輪接著跑', async () => {
    const run = async (loop: AgentLoopKind) => {
      const built = await createNexusAgent({
        model: new ScriptedChatModel({
          turns: [
            { content: '', toolCalls: [{ name: 'echo', args: { text: '一' } }] },
            { content: '第一輪收。' },
            { content: '第二輪收。' },
          ],
        }),
        checkpointer: new MemorySaver(),
        plugins: [toolsPlugin],
        agentLoop: loop,
      });
      const config = { configurable: { thread_id: THREAD } };
      try {
        await built.agent.invoke(toAgentInvocation('第一句。'), config);
        await built.agent.updateState(config, {
          messages: [new AIMessage({ content: '補的', id: 'patched' })],
        });
        await built.agent.updateState(config, {
          messages: [new AIMessage({ content: '補的又改', id: 'patched' })],
        });
        await built.agent.updateState(config, {
          messages: [new HumanMessage({ content: '要拿掉的', id: 'doomed' })],
        });
        await built.agent.updateState(config, { messages: [new RemoveMessage({ id: 'doomed' })] });
        const output = await built.agent.invoke(toAgentInvocation('第二句。'), config);
        const state = (await built.agent.getState(config)) as { values: Record<string, unknown> };
        return { output: shapeOf(output.messages), state: shapeOf(state.values['messages']) };
      } finally {
        await built.dispose();
      }
    };
    const graph = await run('langgraph');
    const native = await run('native');
    expect(graph.state).toContain('ai:補的又改');
    expect(graph.state).not.toContain('human:要拿掉的');
    expect(native).toEqual(graph);
  });

  it('stream() 最後那筆 values 與 invoke 的結果一致', async () => {
    const turns: ScriptedTurn[] = [
      { content: '', toolCalls: [{ name: 'echo', args: { text: '一' } }] },
      { content: '好了。' },
    ];
    const run = async (loop: AgentLoopKind) => {
      const make = () =>
        createNexusAgent({
          model: new ScriptedChatModel({ turns }),
          checkpointer: new MemorySaver(),
          plugins: [toolsPlugin, markerPlugin()],
          agentLoop: loop,
        });
      const viaStream = await make();
      const viaInvoke = await make();
      const config = { configurable: { thread_id: THREAD } };
      try {
        let last: Record<string, unknown> = {};
        for await (const [mode, payload] of await viaStream.agent.stream(
          toAgentInvocation('跑。'),
          { ...config, streamMode: ['updates', 'values'] },
        )) {
          if (mode === 'values') last = payload as Record<string, unknown>;
        }
        const output = (await viaInvoke.agent.invoke(toAgentInvocation('跑。'), config)) as Record<
          string,
          unknown
        >;
        return {
          stream: shapeOf({ messages: last['messages'], files: last['files'] }),
          invoke: shapeOf({ messages: output['messages'], files: output['files'] }),
        };
      } finally {
        await viaStream.dispose();
        await viaInvoke.dispose();
      }
    };
    const graph = await run('langgraph');
    const native = await run('native');
    expect(graph.stream).toEqual(graph.invoke);
    expect(native).toEqual(graph);
  });

  it.each([3, 4, 5, 6])('recursionLimit %i：在同一步拋同一個錯，留下同樣的訊息', async (limit) => {
    const turns: ScriptedTurn[] = Array.from({ length: 6 }, (_, i) => ({
      content: '',
      toolCalls: [{ name: 'echo', args: { text: String(i) } }],
    }));
    const run = async (loop: AgentLoopKind) => {
      const built = await createNexusAgent({
        model: new ScriptedChatModel({ turns }),
        checkpointer: new MemorySaver(),
        plugins: [toolsPlugin],
        agentLoop: loop,
      });
      const config = { configurable: { thread_id: THREAD }, recursionLimit: limit };
      try {
        let failure: string | undefined;
        try {
          await built.agent.invoke(toAgentInvocation('跑。'), config);
        } catch (error) {
          failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        }
        const state = (await built.agent.getState(config)) as { values: Record<string, unknown> };
        return { failure, messages: shapeOf(state.values['messages']) };
      } finally {
        await built.dispose();
      }
    };
    const graph = await run('langgraph');
    const native = await run('native');
    expect(graph.failure).toContain(`Recursion limit of ${limit} reached`);
    expect(native).toEqual(graph);
  });

  it('returnDirect 的工具：結果就是這一輪的收尾，不再叫模型', async () => {
    const direct: PluginEntry = {
      plugin: {
        name: 'native-parity-direct',
        apply(registry) {
          registry.tools.register(
            tool(() => '直接交回', {
              name: 'direct',
              description: '結果直接交回。',
              schema: z.object({}),
              returnDirect: true,
            }),
          );
        },
      },
    };
    const turns: ScriptedTurn[] = [
      { content: '', toolCalls: [{ name: 'direct', args: {} }] },
      { content: '不該走到。' },
    ];
    const graph = await runOnce('langgraph', turns, '開始。', [direct]);
    const native = await runOnce('native', turns, '開始。', [direct]);
    expect(graph.events.some((line) => line.includes('name=direct'))).toBe(true);
    expect(native.failure).toEqual(graph.failure);
    expect(native.events).toEqual(graph.events);
    expect(native.log).toEqual(graph.log);
  });
});

/**
 * `agent/request-error`（只有 native 派）：監聽者每次都回 retry 時，這一輪的中止訊號照樣收得掉這一輪。不看的話，中止之後
 * `createTurnCancelGuard` 擋下的那次模型呼叫（`stopHere` 拋 `TurnCancelledError`）又進這個事件，又重試，永遠不停。
 */
describe('native 的 agent/request-error', () => {
  it('監聽者一直回 retry：這一輪中止之後不再重試，拋出來', async () => {
    const controller = new AbortController();
    let asked = 0;
    const retryForever: PluginEntry = {
      plugin: {
        name: 'native-parity-retry-forever',
        apply(registry) {
          registry.events.on('agent/request-error', async () => {
            asked += 1;
            controller.abort();
            // 第三次就放手：不看中止的話這裡會一直轉，轉到放手為止，次數對不上。
            return asked < 3 ? { kind: 'retry' as const } : undefined;
          });
        },
      },
    };
    const built = await createNexusAgent({
      model: new ScriptedChatModel({ turns: [{ content: '', error: '供應商過載' }] }),
      checkpointer: new MemorySaver(),
      plugins: [retryForever],
      agentLoop: 'native',
    });
    try {
      await expect(
        built.agent.invoke(toAgentInvocation('跑。'), {
          configurable: { thread_id: THREAD, [TURN_CANCEL_CONFIG_KEY]: controller.signal },
        }),
      ).rejects.toThrow();
      expect(asked).toBe(1);
    } finally {
      await built.dispose();
    }
  });
});
