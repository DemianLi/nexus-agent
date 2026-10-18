/**
 * [#1386](https://github.com/DemianLi/nexus-agent/issues/1386) 驗收 ②：Cordis 當根、`PluginRegistry`＋組裝流程包成一顆相容層插件，
 * 出貨清單組出來的工具、命令、middleware 名稱與順序、系統提示，與今天的組裝逐位元組相同。
 *
 * 比法照 `assembly-parity.test.ts`：同一支腳本模型跑一輪，比**送給模型的請求**（含系統提示）、**綁定的工具**
 * （名稱、描述、參數 schema）、**圖的節點**（middleware 名稱與順序），再加上**命令名**。
 *
 * 防自證：兩條路都呼叫同一個 `createNexusAgent`，所以
 *
 * - 相容層經 Loader 的列載入，清單的來源設定從那一列的 config 來，在 fiber 的 async apply 裡自己解；
 * - 兩次組裝各自解清單、各自組、各自序列化之後才比；
 * - 突變對照：相容層那條路拿掉一顆插件，比對必須紅。
 */

import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NexusAgentHandle } from '../../agent-factory.js';
import { createNexusAgent } from '../../agent-factory.js';
import { toAgentInvocation } from '../../messages.js';
import { loadDefaultPlugins } from '../../plugin-config.js';
import { ScriptedChatModel } from '../../scripted-model.js';
import type { CompatConfig, NexusAssembly } from './compat.js';
import { compatLayer, loopPlugin } from './compat.js';
import { STATE, boot, createEntry } from './tree.js';

/** 每次 `bindTools` 都記下綁了什麼。 */
class RecordingModel extends ScriptedChatModel {
  readonly sink: string[] = [];

  constructor() {
    super({ turns: [{ content: '好。' }] });
  }

  override bindTools(tools: readonly unknown[]): ScriptedChatModel {
    this.sink.push(
      JSON.stringify(
        tools.map((candidate) =>
          convertToOpenAITool(candidate as Parameters<typeof convertToOpenAITool>[0]),
        ),
      ),
    );
    return super.bindTools(tools);
  }
}

/** 訊息串的穩定投影，同 `assembly-parity.test.ts`。 */
function project(messages: readonly BaseMessage[]): unknown[] {
  return messages.map((message) => ({
    type: message.getType(),
    content: message.content,
    ...(AIMessage.isInstance(message) &&
      message.tool_calls !== undefined &&
      message.tool_calls.length > 0 && {
        toolCalls: message.tool_calls.map((call) => ({ name: call.name, args: call.args })),
      }),
  }));
}

/** 組一個 agent、跑一輪，序列化觀察到的東西。 */
async function observe(create: (model: RecordingModel) => Promise<NexusAgentHandle>) {
  const model = new RecordingModel();
  const handle = await create(model);
  try {
    type Runnable = {
      invoke: (input: unknown, config?: unknown) => Promise<unknown>;
      graph?: { nodes?: Record<string, unknown> };
    };
    const agent = handle.agent as unknown as Runnable;
    await agent.invoke(toAgentInvocation('開工。'), { configurable: { thread_id: 'parity' } });
    return JSON.stringify({
      requests: model.prompts.map((prompt) => project(prompt)),
      bindings: model.sink,
      nodes: Object.keys(agent.graph?.nodes ?? {}),
      commands: handle.commands
        .list()
        .map((command) => command.name)
        .sort(),
    });
  } finally {
    await handle.dispose();
  }
}

/** 今天的路：解出貨清單、直接組。 */
async function today(serve: boolean): Promise<string> {
  const { plugins } = await loadDefaultPlugins({ serve });
  return observe((model) =>
    createNexusAgent({ model, checkpointer: new MemorySaver(), plugins: [...plugins] }),
  );
}

/** 相容層的路：Cordis 當根，相容層一列、loop 一列。 */
async function viaCordis(config: CompatConfig): Promise<{ observed: string; plugins: number }> {
  const result: { observed?: string; plugins?: number } = {};
  const run = async (assembly: NexusAssembly) => {
    result.plugins = assembly.plugins.length;
    result.observed = await observe((model) =>
      assembly.create({ model, checkpointer: new MemorySaver() }),
    );
  };
  const t = await boot({ compat: compatLayer, loop: loopPlugin(run) });
  await createEntry(t.loader, { id: 'compat', name: 'cordis:compat', config });
  await createEntry(t.loader, { id: 'loop', name: 'cordis:loop' });
  await t.loader.await();
  expect(t.state('compat')).toBe(STATE.ACTIVE);
  expect(t.state('loop')).toBe(STATE.ACTIVE);
  expect(t.errors).toEqual([]);
  if (result.observed === undefined) throw new Error('loop 那一列沒有跑');
  return { observed: result.observed, plugins: result.plugins! };
}

describe('相容層讓出貨清單原樣跑（#1386 ②）', () => {
  // `time-context`（#1625）的讀數帶牆鐘秒數：兩條路各跑一次，秒數會不同；固定 `Date` 讓比對只剩組裝差異（讀數留在清單裡，順序也一併比到）。
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-18T01:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const serve of [false, true]) {
    it(`${serve ? 'serve' : 'CLI'} 清單：請求、工具、middleware、命令逐位元組相同`, async () => {
      const reference = await today(serve);
      const { observed, plugins } = await viaCordis({ serve });
      expect(plugins).toBeGreaterThan(20);
      // 先確認比的東西不是空的：有系統提示、有工具、有 middleware 節點、有命令。
      const parsed = JSON.parse(reference) as {
        requests: { type: string }[][];
        bindings: string[];
        nodes: string[];
        commands: string[];
      };
      expect(parsed.requests[0]?.[0]?.type).toBe('system');
      expect(parsed.bindings.length).toBeGreaterThan(0);
      expect(parsed.nodes.length).toBeGreaterThan(2);
      expect(parsed.commands.length).toBeGreaterThan(0);
      expect(observed).toBe(reference);
    }, 60_000);
  }

  // 交換的對子裡沒有 `agent-instructions` 與 `system-prompt`：`agent/pre-step` 的 listener 順序就是列的順序（#1474），
  // #1625 之後有兩位消費者（`agent-instructions`、`time-context`），把 `agent-instructions` 換到 `time-context` 之後，
  // 同一次 invoke 裡兩則訊息的先後就跟著變——那是該有的差別，不是「順序由槽位表決定」的反例。
  it.each([
    ['skills', 'system-prompt'],
    ['plan-mode', 'goal'],
    ['repeat-reminder', 'tool-result-pruner'],
  ] as const)(
    '清單上交換 %s 與 %s：組出來的東西不變——順序由 fold 的槽位表決定，不靠清單順序',
    async (a, b) => {
      const reference = await today(false);
      const { observed } = await viaCordis({ mutate: { swap: [a, b] } });
      expect(observed).toBe(reference);
    },
    60_000,
  );

  it('突變對照：相容層那條路拿掉一顆插件，比對就紅', async () => {
    const reference = await today(false);
    const { observed } = await viaCordis({ mutate: { drop: 'todo' } });
    expect(observed).not.toBe(reference);
  }, 60_000);
});
