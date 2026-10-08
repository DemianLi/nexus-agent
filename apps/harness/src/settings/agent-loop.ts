/**
 * 每步平行工具呼叫上限的**設定條目**（[#711](https://github.com/DemianLi/nexus-agent/issues/711) 第 1 步）：模型在同一步
 * 吐出多顆工具呼叫時，同時在跑的最多幾顆。id 與欄位名照 dsh `agent-loop` 的 `maxParallelToolCalls`
 * （`packages/core/agent-loop/src/index.ts:297`、schema `:335`，`477b4f4`），預設 10 照 dsh `constants.ts:6`。
 * dsh 全樹沒有 bundle 或 preset 覆寫這一格，所有出廠組合都是 10。
 *
 * **消費點在組裝期**（`agent-factory.ts`，跑在 `loadPlugins` 之後），同 `recursion-limit`：`apply` 把驗過的值提供成
 * {@link MAX_PARALLEL_TOOL_CALLS_SERVICE}，組裝點去讀，帶進 LangGraph 的 `maxConcurrency`（pregel 每一步同時起跑的
 * task 上限；工具呼叫各是一個 task）。這一格基座表達得出來，所以**上限本身沒有偏離**。實測：一次性 `task` 子代理吃到
 * 同一個值（`maxConcurrency` 隨執行脈絡流進子圖），同 dsh「子代理也經同一個 agent-loop」；背景子代理的圖由組裝點另外
 * 帶上同一個值。
 *
 * ## 跟 dsh 不同的三件事
 *
 * 0. **最小值是 2，不收 1。**（偏離登記：哪一條——dsh 的下限 1，`1` 就是串行，`README.zh.md:48`；為什麼表達不出來——
 *    LangGraph `pregel/runner.js` 的 `_executeTasksWithRetry` 迴圈條件是「還沒起跑過，或還有在跑的」
 *    （`@langchain/langgraph` 1.4.12 第 136 行，最新的 1.4.18 同一行沒變）。`maxConcurrency: 1` 時第一顆跑完、在跑的
 *    清空，迴圈就出去了：那一步其餘的工具呼叫**沒跑、沒有 ToolMessage、不報錯**，那一輪靜靜收掉。2 以上不會清空
 *    （每收一顆還剩 k−1 顆在跑，下一圈補滿）。退到什麼——schema 下限 2，`1` 在載入期就擋並說明原因。）出廠值 10 不受影響。
 *    `max-parallel-tool-calls.test.ts` 有一條直接對基座的絆索：它紅了就是上游修好了，下限放回 1、補回串行那條測試。
 *    串行要另做載體（例如工具呼叫層的依序鎖）的話，那跟 #711 第 2 步「獨佔的工具一顆一顆照順序跑」是同一個設計，不在這一步做。
 *
 * 1. **組裝期讀一次，改值要重啟。** dsh 的 Config 是 `Volatile<number>`，每個工具組開始時讀一次
 *    （`tool-calls.ts:132`）。`maxConcurrency` 每次 invoke 都能傳，所以這不是基座表達不出來，缺的是設定層的熱重載——
 *    那是 [#46](https://github.com/DemianLi/nexus-agent/issues/46) Out of scope 已經寫明不接的（「`!!js` 運算式與熱重載：
 *    grilling 決定不接」）。這是既有的範圍決定，不是技術偏離。
 * 2. **上限之外的另一半是「平行安全／獨佔」的分類與屏障**（#711 第 2 步），在 `@nexus/core` 的 `tool-barrier.ts`，不在這一列：
 *    dsh 只讓宣告了 `isConcurrencySafe` 的工具重疊，其餘一顆一顆照模型順序跑；我們同形。這一列管的是「重疊的那一類最多幾顆」。
 *
 * ## 這一列關不掉
 *
 * 理由同 `recursion-limit`：關掉在機制上確實會讓服務消失，但組裝點接著就落回內建的 10——**護欄還在**，讀起來卻像把上限
 * 解除了（基座自己那層是不限）。所以 `disabled: true` 在載入期當場拋（`plugin-config.ts` 的 `PROTECTED_ENTRY_REASONS`）。
 *
 * @module
 */

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';

/** 這一列在訊息裡叫什麼。 */
export const AGENT_LOOP_PLUGIN_NAME = 'agent-loop';

/** 驗過的上限，由 `#settings/agent-loop` 提供。 */
export const MAX_PARALLEL_TOOL_CALLS_SERVICE = 'maxParallelToolCalls';

/** 每步同時在跑的工具呼叫上限的內建值，同 dsh 的 `DEFAULT_MAX_PARALLEL_TOOL_CALLS`。 */
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10;

/** 這一格收的最小值。dsh 是 1；為什麼是 2 見檔頭「跟 dsh 不同」第 0 條。 */
export const MIN_MAX_PARALLEL_TOOL_CALLS = 2;

/** 一格。`strictObject`：多寫一個欄位是打錯字，不是擴充點。整數且至少 2：0、1、負數、小數在載入期就擋。 */
export const agentLoopConfigSchema = z.strictObject({
  maxParallelToolCalls: z
    .number()
    .int()
    .min(MIN_MAX_PARALLEL_TOOL_CALLS, {
      message:
        'maxParallelToolCalls must be at least 2: LangGraph maxConcurrency 1 silently drops every tool call after the first in a step',
    })
    .default(DEFAULT_MAX_PARALLEL_TOOL_CALLS),
});

/** 驗過的設定。 */
export type AgentLoopConfig = z.infer<typeof agentLoopConfigSchema>;

declare module '@nexus/core' {
  interface NexusServices {
    /**
     * 每步同時在跑的工具呼叫上限，由 `#settings/agent-loop` 提供（#711）。沒人提供時組裝點用
     * {@link DEFAULT_MAX_PARALLEL_TOOL_CALLS}，見 `settings/agent-loop.ts` 檔頭。
     */
    maxParallelToolCalls: number;
  }
}

/** 只講設定的那一顆：把值提供成服務，見檔頭。 */
export const agentLoopPlugin: NexusPlugin<AgentLoopConfig> = {
  name: AGENT_LOOP_PLUGIN_NAME,
  Config: agentLoopConfigSchema,
  apply: (registry: PluginRegistry, config: AgentLoopConfig): void => {
    registry.services.provide(MAX_PARALLEL_TOOL_CALLS_SERVICE, config.maxParallelToolCalls);
  },
};

export default agentLoopPlugin;
