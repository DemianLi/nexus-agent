/**
 * native agent loop 對照 LangGraph（[#2356](https://github.com/DemianLi/nexus-agent/issues/2356) K6 驗收第二條）：同一份腳本、同一串 plugin，
 * 兩個 loop 各跑一次，比 pump 會讀的 v3 欄位與會話日誌。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { SessionRegistry } from '@nexus/core';
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
    },
  },
};

interface RawEvent {
  readonly method: string;
  readonly params: { readonly namespace: string[]; readonly node?: string; readonly data: unknown };
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
        `messages ns${ns} ${String(data['event'])}` +
          (data['id'] === undefined ? '' : ` id=${idOf(data['id'])}`) +
          (data['role'] === undefined ? '' : ` role=${String(data['role'])}`) +
          (delta === undefined ? '' : ` ${String(delta['type'])}=${JSON.stringify(delta['text'] ?? delta['reasoning'] ?? '')}`),
      );
    } else if (event.method === 'tools') {
      out.push(
        `tools ns${ns} ${String(data['event'])} call=${String(data['tool_call_id'])}` +
          (data['tool_name'] === undefined ? '' : ` name=${String(data['tool_name'])}`) +
          (data['input'] === undefined ? '' : ` input=${String(data['input'])}`) +
          (data['message'] === undefined ? '' : ` message=${String(data['message'])}`),
      );
    } else if (event.method === 'custom' && ns === 0) {
      out.push(`custom ns0 ${JSON.stringify(data)}`);
    }
  }
  return out;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const CLOCK_KEYS = new Set(['time', 'timestamp', 'durationMs', 'elapsedMs', 'startedAt', 'endedAt']);

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

async function runOnce(loop: AgentLoopKind, turns: readonly ScriptedTurn[], prompt: string) {
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns }),
    checkpointer: new MemorySaver(),
    plugins: [humanChannelPlugin(), toolsPlugin],
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
    const root0 = () => sessions.list().find((entry) => entry.address.kind === 'root')?.log.events ?? [];
    let failure: string | undefined;
    try {
      for await (const event of run as AsyncIterable<RawEvent>) raw.push(event);
    } catch (error) {
      failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    if (process.env['PARITY_DUMP']) (await import('node:fs')).appendFileSync(process.env['PARITY_DUMP'], [...raw.map((e) => [loop, e.method, JSON.stringify(e.params.namespace), e.params.node, JSON.stringify(e.params.data).slice(0, 300)].join(' ')), `${loop} FAILURE ${failure}`, ...logShape(root0()).map((l) => `${loop} LOG ${l.slice(0, 300)}`)].join('\n') + '\n');
    const root = sessions.list().find((entry) => entry.address.kind === 'root');
    return { events: projected(raw), log: logShape(root?.log.events ?? []), failure };
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
      [{ content: '我來回聲。', toolCalls: [{ name: 'echo', args: { text: '嗨' } }] }, { content: '好了。' }],
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
  ];
  it.each(scenarios)('%s', async (_label, turns) => {
    const graph = await runOnce('langgraph', turns, '開始。');
    const native = await runOnce('native', turns, '開始。');
    expect(native.failure).toEqual(graph.failure);
    expect(native.events).toEqual(graph.events);
    expect(native.log).toEqual(graph.log);
  });
});
