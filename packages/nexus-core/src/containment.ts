/**
 * 圍堵：讓工具的失敗變成一則回饋，而不是讓整場 run 死掉。
 *
 * **這不是新功能，是修回基座自己的預設。** `ToolNode.runTool` 只要
 * `this.wrapToolCall` 存在，就把工具自己拋的錯當成 middleware 的錯
 * （`langchain@1.5.10`，`dist/agents/nodes/ToolNode.js:275-282`），而 `#handleError:150`
 * 對 middleware 的錯是 `handleToolErrors !== true` 即重拋。`ReactAgent` 建 `ToolNode`
 * 時只傳 `{ signal, wrapToolCall }`（`:174-179`），**`handleToolErrors: true` 經由
 * `createAgent` 根本到不了**，所以那不是一個可以設回去的預設值。
 *
 * 而 `createDeepAgent` 永遠掛 `FilesystemMiddleware`，它**永遠帶 `wrapToolCall`**
 * （`deepagents@1.13.1`）。兩件事湊在一起的結果是：**任何一個工具拋錯，整場 run 直接
 * 死**——沒有 ToolMessage、沒有回饋、模型不知道發生過什麼。
 *
 * ## 它為什麼住在 core 而不是某個 plugin
 *
 * dsh 那側**不把這件事做成可選的**：它是註冊表執行管線自己的 `catch`
 * （`packages/core/tools/src/index.ts:1494-1496` → `toolErrorResult`，SHA `4e84901`），
 * 文件把它寫成性質而不是功能——「未知工具和抛出异常的工具都会变为结构化错误……
 * **调用失败但不终止当前轮次**」（`docs/subsystems/tools.zh.md:404`）。
 * 做成一個掛不掛隨人的 plugin 才是偏離。
 *
 * 這一版之前它確實住在 `@nexus/plugin-validation`，而那個 plugin **不在任何一份正式
 * 清單裡**——也就是說產品路徑上的每一個工具，今天拋錯都會殺掉整場 run
 * （[#159](https://github.com/DemianLi/nexus-agent/issues/159)）。搬到 fold 打底之後，
 * 「有沒有圍堵」不再是清單怎麼寫的事。plugin 那側的公開名字保留成 re-export。
 *
 * **一條命脈是 `isGraphBubbleUp`。** LangGraph 的中斷（`interrupt()`）是用拋例外實作的，
 * 一個不分辨的 `try/catch` 會把 HITL 的暫停整個吃掉——實測 `__interrupt__` 消失、
 * 換成一則假的 error ToolMessage，核准點就這樣無聲地不見了。那正好是
 * [#71](https://github.com/DemianLi/nexus-agent/pull/71) 釘住的那些行為。搬家之後圍堵
 * 第一次包住 root 與**每個 subagent** 的核准路徑，所以那條命脈在新位置重量過一次
 * （`apps/harness/src/interrupt.test.ts`、`validation.test.ts`）。
 *
 * ## 超時被單獨認出來（[#162](https://github.com/DemianLi/nexus-agent/issues/162)）
 *
 * 一則「執行失敗：The operation was aborted due to timeout」跟一則「執行失敗：連不上」
 * 對模型是同一種東西。dsh 不是這樣：它把超時做成一個帶碼的結果，訊息說得出等了多久
 * （`Error: tool call timed out after <ms>ms`）。這裡認出它、並且說出等了多久。
 *
 * **這是一筆載體被丟掉的偏離。** dsh 的 `guard/timeout-policy` 同時做三件事：武裝截止
 * 時間、分類、措辭。我們**只做後兩件**，理由是前一件基座已經做了——工具上的
 * `defaultConfig: { timeout }` 會被 `ensureConfig` 變成 `AbortSignal.timeout(ms)` 併進
 * `signal`（`@langchain/core@1.2.9` 的 `runnables/config.js:100-120`，實測），而我們樹上
 * 唯一有預算的 MCP 工具走的正是這條（`@langchain/mcp-adapters` 的 `tools.js:450`）。
 * 一個只剩措辭的 plugin 沒有東西可武裝，而且照 [#159](https://github.com/DemianLi/nexus-agent/issues/159)
 * 的結論，圍堵旁邊的行為藏在選配 plugin 裡等於沒有。**載體丟掉，紀律照抄**：分類
 * （它是超時，不是一般失敗）與射程（只作用在這次工具呼叫，不動整場 run）。
 *
 * **`TOOL_TIMEOUT` 這個碼刻意不發。** dsh 把用途寫在原始碼裡：讓 retry／sandbox
 * plugin 與 replay 路由用。我們三個消費者一個都不在——沒有工具層的 retry、sandbox 由
 * 決策 3 延後、而 replay 雖然在 [#175](https://github.com/DemianLi/nexus-agent/pull/175)
 * 之後有了耐久日誌，仍然沒有任何東西讀得回來。一個沒有目的地的判別式加了只是好看。
 *
 * **`tool()` 的「放生」也不修，明著登記。** abort 當下它 reject 外層 promise、把 `func`
 * 留在背景跑完（`@langchain/core` `dist/tools/index.js:290-301`；#148 實測預算 120ms、
 * 本體 600ms，run 結束當下工具還在跑）。dsh 是等下游靜止之後才給超時結果、絕不硬殺。
 * 差在**載體不在紀律**：`AbortSignal` 沒有 quiescence 這個原語，要模擬得自己接一層靜止
 * 追蹤。不模擬。
 */

import { ToolMessage } from '@langchain/core/messages';
import { isGraphBubbleUp } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from './base-types.js';

/** 圍堵 middleware 的名字。錯誤訊息與排序斷言用得到。 */
export const CONTAINMENT_MIDDLEWARE_NAME = 'nexusToolFailureContainment';

/**
 * 工具自己拋錯時給模型的那句話。
 *
 * 這個字串**會送進模型的 context**，所以有兩條規矩：不帶堆疊、不帶原始參數。
 * 基座自己那條路兩樣都帶——`ToolInvocationError` 的訊息把
 * `JSON.stringify(toolCall.args)` 與整段 `error.stack` 都塞進去（實測），那是 PR #72
 * 那個外洩形狀掉頭往內指。參數本來就在同一輪的 AI 訊息裡，模型看得到，複誦一次
 * 只是多一份、不是多一個資訊。
 *
 * @param toolName - 失敗的那顆工具。
 * @param error - 它拋出來的東西。
 * @returns 給模型看的那一句。
 */
export function formatToolFailure(toolName: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `工具 ${toolName} 執行失敗：${detail}`;
}

/**
 * `AbortSignal.timeout()` 逾時的那顆 `DOMException` 的名字。
 *
 * **這是一個量出來的字串，不是查來的。** 探針（`langchain@1.5.10` /
 * `@langchain/core@1.2.9`，一顆宣告 `defaultConfig: { timeout: 120 }`、本體睡 500ms 的
 * 工具）在 `wrapToolCall` 的 `catch` 裡拿到的是 `DOMException`、`name` 為 `TimeoutError`、
 * `message` 為 `The operation was aborted due to timeout`，而且 `instanceof Error` 為真
 * （`getAbortSignalError` 直接把 `signal.reason` 交出來）。
 */
const TIMEOUT_ERROR_NAME = 'TimeoutError';

/**
 * 這顆錯誤是不是「等太久」。
 *
 * **用 `name` 不用訊息比對**：訊息是 Node 的，會隨版本改；`name` 是 DOM 規範定的。
 *
 * **而且 `name` 是唯一分得開使用者取消的東西。** 同一個 `catch` 也接得到使用者按下取消
 * 的那顆——實測它是 `DOMException`、`name` 為 `AbortError`、訊息 `This operation was
 * aborted`。把「凡是 abort 都當超時」寫下去的話，使用者自己按的取消會被回報成工具太慢。
 *
 * @param error - `catch` 到的東西。
 * @returns 是不是逾時。
 */
export function isToolTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === TIMEOUT_ERROR_NAME;
}

/**
 * 這顆工具**自己宣告**的預算，沒宣告就是 `undefined`。
 *
 * 載體是工具上的 `defaultConfig.timeout`（dsh 那側是工具宣告數字、policy 管時序，形狀
 * 一樣）。**沒有統一預設是照抄來的**：dsh 的 `bash`／`read`／`write`／`edit` 都刻意不
 * 宣告，`timeoutMs === undefined` 就不武裝任何截止時間。所以一顆沒宣告的工具跑多久都
 * 不會被打斷，這裡也就讀不到數字。
 *
 * @param request - `wrapToolCall` 收到的請求。
 * @returns 宣告的毫秒數，或沒宣告／不是正數時的 `undefined`。
 */
export function declaredToolTimeoutMs(request: { readonly tool?: unknown }): number | undefined {
  // **參數型別收到 `unknown` 為止**，同 {@link resolveToolName} 的處境但更極端：
  // `defaultConfig` 根本不在 `ClientTool | ServerTool` 這個聯集上，所以連
  // `{ defaultConfig?: unknown }` 都接不住基座傳進來的 `request`。
  const tool: unknown = request.tool;
  if (typeof tool !== 'object' || tool === null) return undefined;
  const config: unknown = (tool as { defaultConfig?: unknown }).defaultConfig;
  if (typeof config !== 'object' || config === null) return undefined;
  const timeout: unknown = (config as { timeout?: unknown }).timeout;
  return typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
    ? timeout
    : undefined;
}

/**
 * 工具等太久時給模型的那句話。
 *
 * **主詞是「等了多久」，不是「預算是多少」，而那是量出來的選擇。** 卡片
 * （[#162](https://github.com/DemianLi/nexus-agent/issues/162)）的驗收句要求文字裡有預算
 * 數字；探針量到那個數字**可以是錯的**：一顆宣告 5000ms 的工具，在呼叫端另外給了 120ms
 * 預算時，`catch` 一樣收到 `TimeoutError`，而 `defaultConfig.timeout` 讀出來仍是 5000
 * ——先響的是 120 那顆。**實際等了多久則永遠是真的**，不管是誰的計時器先響。
 *
 * 所以：**經過時間一定講**；**宣告的預算只在 `elapsedMs >= budgetMs` 時才講**——那時候
 * 它才是一個合理的成因。反過來（等 121ms、預算 5000ms）兩個數字擺在一起像自相矛盾，
 * 會把模型推向「這顆工具壞了」而不是「有別的東西先把它切掉」。
 *
 * 今天三個入口**都沒有人往 `invoke` 的 config 傳 `timeout`**（CLI 與 `serve` 只給
 * `configurable`，eval 給的是 `signal`），所以那個情形是留給未來呼叫端的，不是現在就會
 * 發生的事——這個條件是便宜的保險，不是在修一個活著的缺陷。
 *
 * 兩條規矩同 {@link formatToolFailure}：不帶堆疊、不帶原始參數。
 *
 * @param toolName - 超時的那顆工具。
 * @param elapsedMs - 從進入這一層到拋出來之間過了多久。
 * @param budgetMs - 這顆工具自己宣告的預算，沒宣告就是 `undefined`。
 * @returns 給模型看的那一句。
 */
export function formatToolTimeout(toolName: string, elapsedMs: number, budgetMs?: number): string {
  const overBudget = budgetMs !== undefined && elapsedMs >= budgetMs;
  return overBudget
    ? `工具 ${toolName} 超時：等了 ${elapsedMs}ms，超過它宣告的 ${budgetMs}ms 預算。`
    : `工具 ${toolName} 超時：等了 ${elapsedMs}ms。`;
}

/**
 * 這次呼叫的工具名。
 *
 * 基座寫的是 `request.tool?.name ?? request.toolCall.name`，但那個 `tool` 是
 * `ClientTool | ServerTool` 的聯集，`name` 在型別上收斂成 `{}`——JS 那邊沒事，
 * TS 這邊接不住。所以先確定它真的是字串，不是的話退回 `toolCall.name`。
 *
 * @param request - `wrapToolCall` 收到的請求。
 * @returns 工具名。
 */
export function resolveToolName(request: {
  readonly tool?: { readonly name?: unknown };
  readonly toolCall: { readonly name: string };
}): string {
  const fromTool: unknown = request.tool?.name;
  return typeof fromTool === 'string' ? fromTool : request.toolCall.name;
}

/**
 * 造一個把工具失敗翻成 error ToolMessage 的 middleware。
 *
 * 它**必須排在整份 middleware 陣列的第 0 格**（root 與每個 subagent 都是）：`wrapToolCall`
 * 是層層相包的，越前面越外層，而圍堵的射程要涵蓋內層每一個 middleware——連核准閘門
 * 與校驗器自己的 bug 都在裡面。基座自己那幾個 middleware 永遠排在所有這些之前，接不到，
 * 那是 `createDeepAgent` 的組裝順序，不是這裡能決定的事。掛法見 `fold.ts`。
 *
 * **一份實例走遍 root 與每個 subagent。** 它沒有 closure 狀態——`try/catch` 裡讀到的
 * 一切都來自那一次呼叫的 `request`。
 *
 * @returns 可以放進 `middleware` 陣列的 middleware。
 */
export function createContainmentMiddleware(): AgentMiddleware {
  return createMiddleware({
    name: CONTAINMENT_MIDDLEWARE_NAME,
    wrapToolCall: async (request, handler) => {
      // **計時從這一層開始，不是從工具本體開始**——工具本體我們碰不到。所以這個數字是
      // 「這次呼叫在圍堵眼裡花了多久」，內層 middleware 的開銷也算在裡面。那正是要回報
      // 的東西：模型等的就是這一段。
      const startedAt = Date.now();
      try {
        return await handler(request);
      } catch (error) {
        // 中斷、`Command` 這類控制流是用拋例外走的，接住它們等於把功能吃掉。
        if (isGraphBubbleUp(error)) throw error;
        const toolName = resolveToolName(request);
        return new ToolMessage({
          content: isToolTimeout(error)
            ? formatToolTimeout(toolName, Date.now() - startedAt, declaredToolTimeoutMs(request))
            : formatToolFailure(toolName, error),
          tool_call_id: request.toolCall.id ?? '',
          name: toolName,
          // 基座自己的錯誤回饋**不設 `status`**（`defaultHandleToolErrors`，實測
          // `undefined`），等於錯誤散文以一則結構上成功的訊息送進模型。這裡比基座嚴。
          status: 'error',
        });
      }
    },
  }) as AgentMiddleware;
}
