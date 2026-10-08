/**
 * 每步平行工具呼叫上限（[#711](https://github.com/DemianLi/nexus-agent/issues/711) 第 1 步）的驗收：一律走
 * `createNexusAgent` 的產品路徑，量同一步吐出很多顆工具呼叫時同時在跑的最大顆數。
 *
 * **判準是在途數量的最大值「等於」上限**，不是「不超過」：全串行的實作也不超過，分不出來。
 *
 * 零憑證、零外部連線：模型是 `ScriptedChatModel`，工具是會睡一下、記在途數的探針。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Annotation, END, MemorySaver, Send, START, StateGraph } from '@langchain/langgraph';
import { BACKGROUND_SESSION_CONFIG_KEY, CONCURRENCY_SAFE_METADATA_KEY } from '@nexus/core';
import type { PluginEntry } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import type { BackgroundAgent } from './background-subagents.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { PROTECTED_ENTRY_NAMES } from './plugin-config.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedToolCall, ScriptedTurn } from './scripted-model.js';
import {
  agentLoopConfigSchema,
  agentLoopPlugin,
  DEFAULT_MAX_PARALLEL_TOOL_CALLS,
} from './settings/agent-loop.js';

/** 量在途數的探針工具。每次組裝各建一份，計數不串。 */
function probe() {
  const meter = { inFlight: 0, max: 0, starts: [] as number[] };
  const probeTool = tool(
    async ({ i }: { i: number }) => {
      meter.inFlight += 1;
      meter.max = Math.max(meter.max, meter.inFlight);
      meter.starts.push(i);
      // 睡得夠久，讓同一步的每一顆都有機會重疊；長短錯開，完成順序跟起跑順序不同。
      await new Promise((resolve) => setTimeout(resolve, 20 + (i % 3) * 10));
      meter.inFlight -= 1;
      return `done ${i}`;
    },
    {
      name: 'probe',
      description: '睡一下。',
      schema: z.object({ i: z.number() }),
      // 宣告可重疊（#711 第 2 步）：沒宣告的工具是獨佔，一步裡會串行，量不到上限。
      metadata: { [CONCURRENCY_SAFE_METADATA_KEY]: true },
    },
  );
  return { meter, probeTool };
}

/** 一步裡 `n` 顆探針呼叫，編號從 `from` 起。 */
function burst(n: number, from = 0, prefix = 'c'): ScriptedToolCall[] {
  return Array.from({ length: n }, (_, k) => ({
    name: 'probe',
    args: { i: from + k },
    id: `${prefix}${from + k}`,
  }));
}

function row(maxParallelToolCalls?: number): PluginEntry {
  return {
    plugin: agentLoopPlugin as never,
    config: maxParallelToolCalls === undefined ? {} : { maxParallelToolCalls },
  };
}

/** root 一步吐 `n` 顆探針，回在途最大值與 state 裡 ToolMessage 的順序。 */
async function rootBurst(n: number, plugins: readonly PluginEntry[]) {
  const { meter, probeTool } = probe();
  const calls = burst(n);
  const { agent, dispose } = await createNexusAgent({
    model: new ScriptedChatModel({
      turns: [{ content: '', toolCalls: calls }, { content: '好。' }],
    }),
    plugins: [
      { plugin: { name: 'probe', apply: (r) => void r.tools.register(probeTool) } },
      ...plugins,
    ],
  });
  try {
    const state = (await agent.invoke(toAgentInvocation('一起跑。'))) as {
      messages: BaseMessage[];
    };
    const order = state.messages
      .filter((message): message is ToolMessage => ToolMessage.isInstance(message))
      .map((message) => message.tool_call_id);
    return { meter, order, expected: calls.map((call) => call.id) };
  } finally {
    await dispose();
  }
}

describe('每步平行工具呼叫上限（#711）', { timeout: 30_000 }, () => {
  it('沒有那一列：內建 10，一步 15 顆時在途最多剛好 10 顆，15 顆都跑完', async () => {
    const { meter, order, expected } = await rootBurst(15, []);
    expect(meter.max).toBe(DEFAULT_MAX_PARALLEL_TOOL_CALLS);
    expect(meter.starts).toHaveLength(15);
    expect(order).toEqual(expected);
  });

  it('那一列寫 3：在途最多剛好 3 顆，8 顆都跑完', async () => {
    const { meter, order, expected } = await rootBurst(8, [row(3)]);
    expect(meter.max).toBe(3);
    expect(meter.starts).toHaveLength(8);
    expect(order).toEqual(expected);
  });

  it('寫 2（收得下的最小值）：在途最多剛好 2 顆，照模型給的順序起跑，6 顆都跑完', async () => {
    const { meter, order, expected } = await rootBurst(6, [row(2)]);
    expect(meter.max).toBe(2);
    expect(meter.starts).toEqual([0, 1, 2, 3, 4, 5]);
    expect(order).toEqual(expected);
  });

  it('寫 1（串行，同 dsh）：即使工具宣告可重疊，在途也只有 1 顆，照模型給的順序一顆一顆跑完，不丟任何一顆', async () => {
    const { meter, order, expected } = await rootBurst(6, [row(1)]);
    // 判準是「剛好 1」且「6 顆都有結果」：LangGraph 的 maxConcurrency 1 會丟掉第一顆之後的，這裡 maxConcurrency 墊在 2。
    expect(meter.max).toBe(1);
    expect(meter.starts).toEqual([0, 1, 2, 3, 4, 5]);
    expect(order).toEqual(expected);
  });

  it('寫 1 時子代理也串行（一次性 task 子代理的屏障各一份）', async () => {
    const { meter, probeTool } = probe();
    const { agent, dispose } = await createNexusAgent({
      model: new ScriptedChatModel({
        turns: [
          {
            content: '',
            toolCalls: [
              { name: 'task', args: { description: '跑', subagent_type: 'general-purpose' } },
            ],
          },
          { content: '', toolCalls: burst(5, 100, 's') },
          { content: '子代理收工。' },
          { content: '好。' },
        ],
      }),
      plugins: [
        { plugin: { name: 'probe', apply: (r) => void r.tools.register(probeTool) } },
        row(1),
      ],
    });
    try {
      await agent.invoke(toAgentInvocation('派人。'));
    } finally {
      await dispose();
    }
    expect(meter.starts).toEqual([100, 101, 102, 103, 104]);
    expect(meter.max).toBe(1);
  });

  it('不寫 1 時屏障照宣告重疊（對照：寫 2 在途剛好 2，不是被串行吃掉）', async () => {
    const { meter } = await rootBurst(6, [row(2)]);
    expect(meter.max).toBe(2);
  });

  it('同一步兩顆 task 仍會重疊（#711 驗收：task 宣告可重疊，兩個子代理的工具呼叫在時間上交疊）', async () => {
    const { meter, probeTool } = probe();
    const { agent, dispose } = await createNexusAgent({
      model: new ScriptedChatModel({
        turns: [
          // root：一步吐兩顆 task。
          {
            content: '',
            toolCalls: [
              { name: 'task', args: { description: '甲', subagent_type: 'general-purpose' } },
              { name: 'task', args: { description: '乙', subagent_type: 'general-purpose' } },
            ],
          },
          // 兩個子代理各自的第一次模型呼叫（誰先拿到哪一格不重要，兩顆探針各一個編號），睡 20–30 毫秒，
          // 所以串行的話第二個子代理要等第一個整個收工才開始，在途最多 1；重疊的話兩顆探針同時在途。
          { content: '', toolCalls: [{ name: 'probe', args: { i: 0 }, id: 'sub-a' }] },
          { content: '', toolCalls: [{ name: 'probe', args: { i: 1 }, id: 'sub-b' }] },
          { content: '甲收工。' },
          { content: '乙收工。' },
          { content: '都好。' },
        ],
      }),
      plugins: [{ plugin: { name: 'probe', apply: (r) => void r.tools.register(probeTool) } }],
    });
    try {
      await agent.invoke(toAgentInvocation('派兩個人。'));
    } finally {
      await dispose();
    }
    expect([...meter.starts].sort()).toEqual([0, 1]);
    expect(meter.max).toBe(2);
  });

  it('state 裡 ToolMessage 的順序等於 tool_calls 的順序（完成順序刻意錯開）', async () => {
    const { order, expected } = await rootBurst(12, [row(4)]);
    expect(order).toEqual(expected);
  });

  it('一次性 task 子代理吃到同一個值（隨執行脈絡繼承）', async () => {
    const { meter, probeTool } = probe();
    const { agent, dispose } = await createNexusAgent({
      model: new ScriptedChatModel({
        turns: [
          {
            content: '',
            toolCalls: [
              { name: 'task', args: { description: '跑', subagent_type: 'general-purpose' } },
            ],
          },
          { content: '', toolCalls: burst(8, 100, 's') },
          { content: '子代理收工。' },
          { content: '好。' },
        ],
      }),
      plugins: [
        { plugin: { name: 'probe', apply: (r) => void r.tools.register(probeTool) } },
        row(2),
      ],
    });
    try {
      await agent.invoke(toAgentInvocation('派人。'));
    } finally {
      await dispose();
    }
    expect(meter.starts).toHaveLength(8);
    expect(meter.max).toBe(2);
  });

  describe('背景子代理（另編的圖，不在 root 那次 invoke 的執行脈絡裡）', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'nexus-bg-parallel-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('組裝點給背景圖帶上同一個值', async () => {
      const { meter, probeTool } = probe();
      const crew: PluginEntry = {
        plugin: {
          name: 'parallel-crew',
          apply(registry) {
            registry.subagents.register({
              name: 'worker',
              description: '一步吐很多顆的。',
              systemPrompt: '幹活。',
              tools: [probeTool],
            });
          },
        },
      };
      const turns: ScriptedTurn[] = [
        { content: '', toolCalls: burst(8, 200, 'b') },
        { content: '完' },
      ];
      const built = await createNexusAgent({
        model: new ScriptedChatModel({ turns }),
        checkpointer: new MemorySaver(),
        plugins: [crew, row(3)],
        backend: new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' }),
      });
      try {
        const graph = built.compileSubagent(
          'worker',
          new MemorySaver(),
        ) as unknown as BackgroundAgent;
        const run = await graph.streamEvents(
          { messages: [{ role: 'user', content: '開工' }] } as never,
          {
            version: 'v3',
            configurable: { thread_id: 'root/bg-1', [BACKGROUND_SESSION_CONFIG_KEY]: 'bg-1' },
          },
        );
        for await (const event of run) void event;
      } finally {
        await built.dispose();
      }
      expect(meter.starts).toHaveLength(8);
      expect(meter.max).toBe(3);
    });
  });

  describe('那一列', () => {
    it('0、負數、小數、多寫欄位：載入時就擋；1 收下（串行，同 dsh）', () => {
      for (const bad of [0, -1, 1.5]) {
        expect(
          () => agentLoopConfigSchema.parse({ maxParallelToolCalls: bad }),
          String(bad),
        ).toThrow();
      }
      expect(() => agentLoopConfigSchema.parse({ maxParallelToolCalls: 10, typo: 1 })).toThrow();
      expect(agentLoopConfigSchema.parse({})).toEqual({ maxParallelToolCalls: 10 });
      expect(agentLoopConfigSchema.parse({ maxParallelToolCalls: 1 })).toEqual({
        maxParallelToolCalls: 1,
      });
      expect(agentLoopConfigSchema.parse({ maxParallelToolCalls: 2 })).toEqual({
        maxParallelToolCalls: 2,
      });
    });

    it('關不掉：在保護名單上', () => {
      expect(PROTECTED_ENTRY_NAMES.has('#settings/agent-loop')).toBe(true);
    });
  });
});

/**
 * 基座絆索：LangGraph 的 `maxConcurrency: 1` 跑完第一顆就收掉那一步（`pregel/runner.js` 的
 * `_executeTasksWithRetry` 迴圈條件，見 `settings/agent-loop.ts` 檔頭「跟 dsh 不同」第 0 條）。
 *
 * **這條釘的是今天的缺陷。** 它紅了就是上游修好了：把 schema 的下限放回 dsh 的 1、補回「寫 1 全串行」那條測試、
 * 拿掉檔頭的偏離登記。
 */
describe('基座絆索：maxConcurrency 1', () => {
  it('同一步三顆 Send，只有第一顆跑了，其餘靜靜被丟掉、不報錯，連最終狀態都沒有', async () => {
    const ran: number[] = [];
    const State = Annotation.Root({
      done: Annotation<number[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
    });
    const graph = new StateGraph(State)
      .addNode('work', async (input: { i: number }) => {
        ran.push(input.i);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { done: [input.i] };
      })
      .addConditionalEdges(START, () => [0, 1, 2].map((i) => new Send('work', { i })))
      .addEdge('work', END)
      .compile();
    const out = await graph.invoke({}, { maxConcurrency: 1 });
    expect(ran).toEqual([0]);
    // 連最終狀態都沒交回來（`invoke` 回 undefined），不只少了兩筆。
    expect(out).toBeUndefined();
    // 對照組：2 的時候三顆都跑。
    ran.length = 0;
    const control = await graph.invoke({}, { maxConcurrency: 2 });
    expect([...ran].sort()).toEqual([0, 1, 2]);
    expect(control.done).toHaveLength(3);
  });
});
