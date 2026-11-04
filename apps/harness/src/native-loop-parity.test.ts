/**
 * native agent loop 對照 LangGraph（[#2356](https://github.com/DemianLi/nexus-agent/issues/2356)）：同一份腳本、同一串 plugin，
 * 兩個 loop 各跑一次，比 pump 會讀的 v3 欄位與會話日誌。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import {
  FOREGROUND_SUBAGENT_DELEGATION_CONTEXT,
  SESSION_EVENT_MAX_DEPTH,
  SessionRegistry,
  SUBAGENT_DELEGATION_CONTEXT,
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
    // 這一步失敗：跑完的兄弟照寫進 state。前一顆失敗、兄弟晚進的那種不在這裡比，見下面「native 下同一步的兄弟」。
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
              createMiddleware({
                name: 'nativeParityJumps',
                beforeAgent: { canJumpTo: ['end'], hook: () => ({ jumpTo: 'end' as const }) },
                afterAgent: {
                  canJumpTo: ['model'],
                  hook: () => (exits++ === 0 ? { jumpTo: 'model' as const } : undefined),
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
            createMiddleware({
              name: 'nativeParityToolsJump',
              beforeModel: { canJumpTo: ['tools'], hook: () => undefined },
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
