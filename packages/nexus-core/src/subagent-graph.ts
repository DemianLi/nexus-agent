/**
 * 把 fold 交出的子代理規格編成一張**帶存檔點的圖**（[#825](https://github.com/DemianLi/nexus-agent/issues/825)）。
 *
 * ## 為什麼要有這個出口
 *
 * 背景續行的子代理要能在 `task` 那一次呼叫之外一輪一輪地跑（[#737](https://github.com/DemianLi/nexus-agent/issues/737)），
 * 基座表達不出來：`createTaskTool` 把編好的圖關在閉包裡，`createSubAgent` 沒有 checkpointer 參數
 * （`deepagents@1.13.1`，`dist/langsmith-zm0ILQsV.js:3399-3413`），而把編好的 `runnable` 交給基座又拿不到 fold 注進規格的那一整疊
 * ——基座對帶 `runnable` 的規格只取 `runnable`（同檔 `:3448-3449`），runnable 要在 plugin 的 `apply` 裡編好，那時 fold 的
 * middleware 還不存在（[#738](https://github.com/DemianLi/nexus-agent/issues/738) 第 1 項，實測）。所以退到最接近的：
 * **一次性照舊走基座的 `task`，背景另外用同一份規格自己呼叫 `createAgent`**。
 *
 * ## 自編路徑不會自動有的東西，要在這裡補
 *
 * 基座在 `createDeepAgent` 裡替每個子代理補一疊預設（`createSubagentDefaultMiddleware`，同檔 `:6245-6259`）：
 * 檔案系統、摘要器、補懸空工具呼叫，規格帶 `skills` 時再加 skills middleware，然後用 `mergeMiddlewareStack` 把規格自己帶的
 * 按名字併進去。自編路徑不經那一步，所以：
 *
 * - **檔案系統那顆一定要帶 `permissions`**（基座傳的是 `input.permissions ?? permissions`）。漏傳的話全域的 `deny('/secret/**')`
 *   在背景圖上消失，`/secret/b.txt` 寫得進去（#738 第 2 項，實測）。
 * - **摘要器被 fold 打底的那顆同名換掉**，不會兩顆並存。
 * - 大結果外溢（[#719](https://github.com/DemianLi/nexus-agent/issues/719)）是檔案系統那顆帶的，所以補了它就有。
 * - **插話載體**（[#858](https://github.com/DemianLi/nexus-agent/issues/858)）：`createStepInboxMiddleware('background')`，讓 `send_message`
 *   給正在跑的子代理在下一步領走。基座的一次性子代理沒有這顆（root 的載體不折進子代理）；它不加工具也不動系統提示，
 *   所以不影響上面那條漂移絆索。
 *
 * 預設疊與併法住在 [`agent-assembly.ts`](./agent-assembly.ts)（`subagentDefaultMiddleware`、`mergeMiddlewareStack`），
 * **一次性子代理（經 `task`）與這個出口共用同一份**，不再各抄一份。
 * **漂移絆索**在 harness 的測試：同一份規格經 `task` 與經這個出口各跑一次，模型看到的工具名與系統提示要相同。
 *
 * ## 不做的事：拒絕，不悄悄少做
 *
 * 基座 `createSubAgent` 還處理 `interruptOn`、`responseFormat`。fold 交出的規格不會帶它們，所以這裡遇到就
 * **拋並指名**，不是默默略過。（基座的 harness profile 曾是第三個要拒絕的東西；自有組裝點不套 profile，那一項不存在了。）
 *
 * @module
 */

import type { SubAgent } from 'deepagents';
import { createAgent } from 'langchain';
import type { AgentMiddleware } from 'langchain';

import { mergeMiddlewareStack, subagentDefaultMiddleware } from './agent-assembly.js';
import type { AgentCheckpointer } from './base-types.js';
import type { FoldedAgentParams } from './fold.js';
import { SUBAGENT_MODEL_FOLLOW_MIDDLEWARE_NAME } from './model-selection.js';
import { createStepInboxMiddleware } from './step-inbox.js';

/** 編一個子代理要看的 fold 產物：規格清單、模型、backend、全域的 deny 規則。 */
export type SubagentGraphParams = Pick<
  FoldedAgentParams,
  'subagents' | 'model' | 'backend' | 'permissions'
>;

/** 編出來的圖：帶 checkpointer 的 `createAgent` 圖。 */
export type SubagentGraph = ReturnType<typeof createAgent>;

/** 編圖的選項。 */
export interface SubagentGraphOptions {
  /** 存檔點。**沒有它就沒有「第二輪看得到第一輪」**——這個出口存在的理由。 */
  readonly checkpointer: NonNullable<AgentCheckpointer>;
  /**
   * 這張圖改用的模型（[#876](https://github.com/DemianLi/nexus-agent/issues/876)），**勝過規格自己帶的與組裝點的**。
   * 省略＝同今天（規格的，沒有就用組裝點的）。呼叫端每張圖各給各的實例：重試與逾時的包裝是每個實例一份，共用會讓兩張圖悄悄混在一起。
   */
  readonly model?: SubAgent['model'];
  /**
   * 這張圖要不要跟隨會話選擇（[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 3 項）。省略＝只有沒指定 {@link model} 時才跟。
   * 給 `false`＝一律不跟：背景子代理的模型在委派那一刻就定了（路由由呼叫端算好，經 {@link model} 或沿用預設實例傳進來），之後使用者
   * 換模型不影響已經派出去的——照 dsh，子代理建立時取父代理當下的選擇、之後固定。
   */
  readonly follow?: boolean;
}

/**
 * 同基座 `mergeMiddlewareStack` 的形狀：預設疊裡同名的原地換成規格自己帶的，沒撞名的接在後面。
 *
 * @param defaults - 基座替子代理補的那疊預設。
 * @param custom - 規格自己帶的（fold 打底的整疊都在裡面）。
 * @returns 合併後的疊。
 */
export function mergeMiddlewareByName(
  defaults: readonly AgentMiddleware[],
  custom: readonly AgentMiddleware[],
): AgentMiddleware[] {
  return mergeMiddlewareStack(defaults, custom);
}

/**
 * 把一個子代理規格編成帶存檔點的圖。
 *
 * @param params - fold 交出的參數（用到規格清單、模型、backend、全域 deny 規則）。
 * @param name - 子代理名。
 * @param options - 存檔點，以及選填的模型覆寫。
 * @returns 一張圖；用 `configurable.thread_id` 分輪，同一個 thread id 的下一輪看得到上一輪。
 * @throws 沒有這個子代理；規格是編好的 `runnable`、帶 `interruptOn`／`responseFormat`；缺工具、模型或 backend。
 */
export function compileSubagentGraph(
  params: SubagentGraphParams,
  name: string,
  options: SubagentGraphOptions,
): SubagentGraph {
  const spec = params.subagents.find((candidate) => candidate.name === name);
  if (spec === undefined) {
    const known = params.subagents.map((candidate) => candidate.name).join('、');
    throw new Error(`沒有 "${name}" 這個子代理（有：${known === '' ? '（沒有）' : known}）`);
  }
  if ('runnable' in spec) {
    throw new Error(`子代理 "${name}" 是編好的 runnable，背景續行需要規格才編得出帶存檔點的圖`);
  }
  const declarative = spec as Exclude<SubAgent, { runnable: unknown }>;
  for (const field of ['interruptOn', 'responseFormat'] as const) {
    if (declarative[field] !== undefined) {
      throw new Error(
        `子代理 "${name}" 帶了 ${field}，背景圖不處理它；fold 交出的規格不該有這一格`,
      );
    }
  }
  const model = options.model ?? declarative.model ?? params.model;
  const follows = options.follow ?? options.model === undefined;
  if (model === undefined) throw new Error(`子代理 "${name}" 沒有模型：規格與組裝點都沒給`);
  const tools = declarative.tools;
  if (tools === undefined) {
    throw new Error(`子代理 "${name}" 沒有工具清單：fold 應該替每個子代理補上有效集合`);
  }
  const backend = params.backend;
  if (backend === undefined)
    throw new Error(`子代理 "${name}" 沒有 backend，檔案系統 middleware 建不起來`);

  // 預設疊與一次性子代理共用同一個函式（`subagentDefaultMiddleware`）：檔案系統那顆帶的 `permissions`
  // 是 `spec.permissions ?? 全域`，漏傳的話全域的 deny 在背景圖上消失（#738 第 2 項，實測）。
  const defaults = [
    ...subagentDefaultMiddleware(declarative, { backend, permissions: params.permissions }),
    // 背景版插話載體（#858）：host 經 `configurable` 交 handle 進來才有作用，沒交就什麼都不做。
    createStepInboxMiddleware('background'),
  ];

  return createAgent({
    model: model as never,
    systemPrompt: declarative.systemPrompt,
    tools: tools as never,
    middleware: mergeMiddlewareByName(
      defaults,
      // 呼叫端替這一張圖指定了模型（#876／#709：模型在委派時自己挑的）就不跟隨：挑的勝過定義釘的與父代理當下的（dsh
      // `requestedAgentOptions`：request 蓋過 configured），跟隨的那顆每次叫模型都會換掉它。`follow: false` 則是呼叫端明說不跟。
      ((declarative.middleware ?? []) as AgentMiddleware[]).filter(
        (each) => follows || each.name !== SUBAGENT_MODEL_FOLLOW_MIDDLEWARE_NAME,
      ),
    ),
    name: declarative.name,
    checkpointer: options.checkpointer,
  });
}
