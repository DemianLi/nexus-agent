/**
 * 出貨組裝上模型那一串登記成環繞步的格（#2416）：只記錄的七格（中止閘門與檢查點的模型那一半、起訖、空回覆、用量、請求快照、
 * 綁中止訊號），與會改請求或回覆、這裡檢查登記的四格（{@link MUTATOR_CELLS}）。摘要器也登記了一步，次數另由 core 的
 * `native-loop/summarizer-cell.test.ts` 數。只記錄的七顆都由 core 造，各登記了一步（`@nexus/core` 的 `withModelCallStep`），
 * native 的 root 在原位直接呼叫；次數與路徑由 core 的 `native-loop/recorder-cells.test.ts` 數。這裡守宿主那一側：
 *
 * - 宿主組出來的 native agent 上，七顆都還帶著登記（沒被宿主換成沒登記的同名顆）；會改請求或回覆的格（修工具參數、輸出上限、
 *   補懸空呼叫、計劃模式）也一樣；
 * - 同一輪「root 前景委派 `worker` → 回答」，兩個 loop 的 root 日誌裡，每一筆帶 `modelCall` 的事件指到的 `model/start` 相同
 *   （起訖紀錄器用 `AsyncLocalStorage` 把識別往內帶，native 直接呼叫時不能斷）；
 * - native 進各格的先後照 middleware 的排序：計劃模式在 plugin 套件，core 的計數測試掛不到，它與中止閘門之間的先後只有出貨組裝
 *   看得到。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HumanMessage } from '@langchain/core/messages';
import * as core from '@nexus/core';
import type { PluginEntry } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { shippedPlugins, withScriptedModel } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';

const shipped = await shippedPlugins();

const CELLS = [
  'nexusTurnCancel',
  'nexusModelCallEvents',
  'nexusEmptyResponse',
  'nexusModelUsage',
  'nexusSessionCheckpoint',
  'nexusRequestSnapshot',
  'nexusTurnCancelModelSignal',
];

/**
 * 會改請求或回覆、這裡的組裝（`live: false`）上 root 會掛、這裡要檢查登記的格（摘要器另由 core 的 `summarizer-cell.test.ts`
 * 數）。換模型與圖片省略只在 `live` 時掛，影子比對與從日誌推要歷史來源是 `shadow` 或 `log`（`--history-source` 或
 * `#settings/history-source` 那一列，出廠是 `state`）；這四格與這裡前三格的次數與路徑由 core 的
 * `native-loop/mutator-cells.test.ts` 數。補回 `name` 那一格只在工具清單有 `returnDirect` 工具時掛（出貨有 `exit_plan_mode`），
 * 兩支是同一步：`withModelCallStep` 從同一步造出 `wrapModelCall`（`model-call-step.ts`）；補什麼由 core 的 `tool-name-restore.test.ts` 驗。
 */
const MUTATOR_CELLS = [
  'nexusInvalidToolArgs',
  'nexusMaxTokens',
  'patchToolCallsMiddleware',
  'nexusToolNameRestore',
];

const worker: PluginEntry = {
  plugin: {
    name: 'worker-host',
    apply(registry) {
      registry.subagents.register({
        name: 'worker',
        description: '幹活的。',
        systemPrompt: '你是 worker。',
        model: new ScriptedChatModel({ turns: [{ content: '子代理好了' }] }),
      });
    },
  },
};

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'nexus-recorder-cells-'));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function run(loop: 'native' | 'langgraph') {
  const built = await createCliAgent(
    { live: false, workspace, sandbox: 'workspace-write', agentLoop: loop },
    withScriptedModel(
      [...shipped, worker],
      [
        {
          content: '',
          toolCalls: [
            {
              name: 'subagent',
              args: { description: '叫一下', subagent_type: 'worker', run_in_background: false },
              id: 'root-fg',
            },
          ],
        },
        { content: '好了' },
      ],
    ),
    workspace,
  );
  const sessions = new core.SessionRegistry('root-1');
  const detach = built.attachSession(sessions);
  try {
    await built.agent.invoke(
      { messages: [new HumanMessage('動手')] },
      { configurable: { thread_id: 'recorder-cells' } },
    );
    const middleware = (built.agent as unknown as { middleware?: readonly { name: string }[] })
      .middleware;
    const starts = sessions.root.events
      .filter((event) => event.type === 'model/start')
      .map((event) => Number(event.seq));
    const attribution = sessions.root.events.flatMap((event) => {
      const modelCall = (event.data as { modelCall?: unknown } | undefined)?.modelCall;
      return typeof modelCall === 'number' ? [`${event.type} → ${starts.indexOf(modelCall)}`] : [];
    });
    return { middleware, attribution };
  } finally {
    detach();
    await built.dispose();
  }
}

describe('出貨組裝上登記成環繞步的格', () => {
  it('native agent 上七顆都帶著登記的一步', async () => {
    const { middleware } = await run('native');
    const registered = Object.fromEntries(
      CELLS.map((name) => {
        const found = middleware?.filter((m) => m.name === name) ?? [];
        return [
          name,
          found.length === 1 && core.modelCallStepOf(found[0]!) !== undefined
            ? '登記'
            : `${found.length} 顆，${found.length === 1 ? '沒登記' : '數目不對'}`,
        ];
      }),
    );
    expect(registered).toEqual(Object.fromEntries(CELLS.map((name) => [name, '登記'])));
  });

  it('native agent 上改請求或回覆的格也都帶著登記的一步', async () => {
    const { middleware } = await run('native');
    const names = middleware?.map((m) => m.name) ?? [];
    const registered = Object.fromEntries(
      MUTATOR_CELLS.map((name) => {
        const found = middleware?.filter((m) => m.name === name) ?? [];
        return [
          name,
          found.length === 1 && core.modelCallStepOf(found[0]!) !== undefined
            ? '登記'
            : `${found.length} 顆，${found.length === 1 ? '沒登記' : '數目不對'}`,
        ];
      }),
    );
    expect(registered, names.join(', ')).toEqual(
      Object.fromEntries(MUTATOR_CELLS.map((name) => [name, '登記'])),
    );
  });

  it('native 進各格的先後照 middleware 的排序，也就是 langgraph 經 wrapModelCall 由外往內的先後', async () => {
    const built = await createCliAgent(
      { live: false, workspace, sandbox: 'workspace-write', agentLoop: 'native' },
      withScriptedModel(shipped, [{ content: '好了' }]),
      workspace,
    );
    const sessions = new core.SessionRegistry('root-1');
    const detach = built.attachSession(sessions);
    try {
      const agent = built.agent as unknown as {
        middleware: readonly { name: string }[];
        withConfig(config: object): typeof built.agent;
      };
      const registered = agent.middleware.filter((m) => core.modelCallStepOf(m) !== undefined);
      const entered: string[] = [];
      // 每顆登記的那一步換成先記一筆再照原樣做的一步；`withConfig` 造的新 agent 重讀登記，native 直接呼叫的就是換過的。
      for (const m of registered) {
        const step = core.modelCallStepOf(m)!;
        core.withModelCallStep(
          (request, next) => {
            entered.push(m.name);
            return step(request, next);
          },
          (wrapModelCall) => Object.assign(m, { wrapModelCall }),
        );
      }
      await agent
        .withConfig({})
        .invoke({ messages: [new HumanMessage('動手')] }, { configurable: { thread_id: 'order' } });
      expect(entered).toEqual(registered.map((m) => m.name));
      expect(entered).toEqual(expect.arrayContaining(['nexusTurnCancel', 'nexusToolNameRestore']));
    } finally {
      detach();
      await built.dispose();
    }
  });

  it('兩個 loop 的 root 日誌，每一筆帶 modelCall 的事件指到同一次 model/start', async () => {
    const native = (await run('native')).attribution;
    const langgraph = (await run('langgraph')).attribution;
    expect(native).toEqual(langgraph);
    expect(native).toContain('model/end → 0');
    expect(native).toContain('model/end → 1');
    expect(native.some((line) => line.endsWith('→ -1'))).toBe(false);
  });
});
