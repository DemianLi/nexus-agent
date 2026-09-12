/**
 * 中止這一輪——**合作式的**：人按了停止之後，正在跑的工具等它落定，還沒開始的不開始，
 * 模型請求中途切斷，這一步之後圖就停。見 [#276](https://github.com/DemianLi/nexus-agent/issues/276)，
 * 決議在 [#265](https://github.com/DemianLi/nexus-agent/issues/265)。
 *
 * ## 照 dsh 的哪一段
 *
 * dsh 一輪一個 `AbortController`，每個非同步邊界 `throwIfAborted()`（`packages/core/agent-loop/src/agent.ts`，
 * SHA `c291e79`）；**工具從不丟下**——已經開始的等到靜止，結果才換成 `ABORTED`，還沒開始的補一顆
 * `ABORTED_BEFORE_DISPATCH`（`packages/core/tools/src/index.ts:1518-1520`，`agent-loop/src/tool-calls.ts:238-259`）。
 * 模型串流在下一段就停。**中止只換掉成功的結果**：工具自己拋的、自己回的錯照舊
 * （`docs/subsystems/tools.zh.md:629`）。模型看到的兩句話逐字照抄。
 *
 * ## 載體退到哪裡：訊號放在 `configurable`，不交給 LangGraph
 *
 * **把 `signal` 直接交給 LangGraph 表達不出「不丟下工具」**（2026-09-12 實測）：runner 拿它跟整個
 * task 競速，錯誤 3ms 內冒出，工具本體在背景照樣跑完，圍堵來不及落定——日誌只剩一顆沒配到結果的
 * `tool/call`，而按了停止之後檔案照樣被寫。所以訊號由進入點放進 `configurable` 的
 * {@link TURN_CANCEL_CONFIG_KEY}，由這裡的兩顆 middleware 合作地讀：
 *
 * - `configurable` 抄進 metadata 的只有固定幾個鍵（`@langchain/langgraph@1.4.12` 的
 *   `propagateConfigurableToMetadata`），一個 `AbortSignal` 不會外漏進 checkpoint。
 * - deepagents 叫子代理時把 `configurable` 原樣展開（`task` 工具的 `subagentConfig`），所以**中止往下
 *   傳是免費的**：子代理那張圖的同兩顆 middleware 讀到的是同一個訊號（#265 的 Q10）。
 *
 * ## 為什麼是兩顆
 *
 * 兩件事要的位置相反：
 *
 * 1. **{@link createTurnCancelGuard}（外層，緊貼圍堵）**：擋工具、擋中止之後的模型呼叫。它必須在
 *    圍堵**裡面**（圍堵才看得到換過的結果、記得到碼），又必須在模型起訖紀錄器**外面**——中止之後被擋下
 *    的那次呼叫不算一步，同 dsh「一步都沒開始就沒有 `step/end`」。
 * 2. **{@link createTurnCancelModelSignal}（我們交出去那串的最內層）**：把訊號綁到模型上。綁法是把
 *    `request.model` 包成核心的 `RunnableBinding`，而一顆排在它外面的 middleware 若讀模型本身的屬性
 *    就會讀到那層包裝——放在最內層，外面每一顆看到的都是原本的模型。
 *
 * ## 綁模型為什麼不用 `withConfig` 或 `modelSettings`
 *
 * 兩條都實測過、都送不到（真的 `ChatOpenAI` 接本機假 SSE，`fetch` 那一層的訊號從沒 abort）：
 * `ChatOpenAI.withConfig` 重建一個新實例、把選項塞進 `defaultOptions`（`@langchain/openai@1.5.10`
 * `chat_models/index.js:605`），而模型節點呼叫時明著傳 `{ ...config, signal }`——LangGraph 沒拿到訊號時那一格是
 * `undefined`，`_combineCallOptions` 一展開就把它蓋掉；`bindTools(tools, modelSettings)` 走的是同一條。
 * 核心 `RunnableBinding` 的 `mergeConfigs` 對 signal 是「已經有值就留、兩邊都有就合成」，`undefined`
 * 蓋不掉。`apps/harness/src/turn-cancel-openai.test.ts` 釘著這件事——換回 `withConfig` 的那一刻它會紅，
 * 假模型重現不了這個 quirk。
 *
 * ## 兩處偏離
 *
 * - **回 `Command` 的工具結果不換。** dsh 的結果只有一種形狀；我們的 `Command` 帶著狀態更新（todo、goal
 *   的收尾），而那些工具在本體裡已經把事件寫進日誌了。換成一則 ToolMessage 等於丟掉狀態更新、留下日誌
 *   上那顆事件，兩邊從此對不上。
 * - **半段文字不在這裡組。** dsh 在迴圈裡把已經送出的文字記成一則被打斷的回覆；我們的產品路徑
 *   （`streamEvents` v3）上，逐字片段根本不經過模型層的回呼（實測一個 token 都收不到），唯一看得到
 *   「使用者看到了哪些字」的是轉發那些片段的 pump。所以這裡只拋 {@link TurnCancelledError}，半段由
 *   `apps/harness` 的 pump 事後寫回對話。
 *
 * **中止之後工具的副作用照樣發生**：等它落定就是讓它做完。dsh 也是這樣，不算偏離，但使用者會意外。
 *
 * ## 在攔截索引上佔哪一格
 *
 * 外層那顆的 `wrapToolCall` 是 dsh `tools/execute` 那一格（環繞 waterfall）在我們樹上的又一個
 * 佔用者，索引見 `apps/harness/src/interception-index.test.ts` 的第 6 列。**dsh 的中止不佔這一格**
 * ——它是迴圈自己的訊號，在每個非同步邊界檢查；我們沒有那個迴圈，最接近的縫就是這一格與模型那一側
 * 的 `wrapModelCall`。退的是載體，「等工具落定、只換成功的結果」的紀律照抄。
 *
 * @module
 */

import { RunnableBinding } from '@langchain/core/runnables';
import { isCommand } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from './base-types.js';
import {
  readToolOutcome,
  TOOL_ABORTED,
  TOOL_ABORTED_BEFORE_DISPATCH,
  toolRefusal,
} from './tool-events.js';

/** 進入點把這一輪的中止訊號放在 `configurable` 的這個鍵上。 */
export const TURN_CANCEL_CONFIG_KEY = 'nexus_turn_cancel';

/** 外層那顆的名字。 */
export const TURN_CANCEL_MIDDLEWARE_NAME = 'nexusTurnCancel';

/** 內層那顆的名字。 */
export const TURN_CANCEL_MODEL_SIGNAL_MIDDLEWARE_NAME = 'nexusTurnCancelModelSignal';

/** 已經開始的呼叫被中止時，模型看到的那一句。dsh 原文照抄（`tools/src/index.ts:1909-1920`）。 */
export const TOOL_ABORTED_TEXT = 'Error: tool call aborted';

/** 還沒開始的呼叫被中止時，模型看到的那一句。dsh 原文照抄（`agent-loop/src/tool-calls.ts:250-259`）。 */
export const TOOL_ABORTED_BEFORE_DISPATCH_TEXT = 'Error: tool call aborted before dispatch';

/**
 * 這一輪被人中止了。
 *
 * **進入點要靠類別認它，不能比對訊息**：它決定這一輪收成 `turn/end`（帶 aborted）還是
 * `turn/failed`。比對措辭的話，哪天改一個字，每一次中止都會被記成失敗——更糟的是反過來。
 */
export class TurnCancelledError extends Error {
  override readonly name = 'TurnCancelledError';

  constructor(options?: { readonly cause?: unknown }) {
    super('這一輪被中止了', options);
  }
}

/**
 * 從一份 config 讀這一輪的中止訊號。
 *
 * @param config - 有 `configurable` 的東西（工具的第二個參數、`{ configurable: runtime.configurable }`）。
 * @returns 那個訊號；這一輪沒有人放就是 `undefined`——CLI 與 eval 走的就是這條。
 */
export function turnCancelSignalOf(config: unknown): AbortSignal | undefined {
  const configurable = (config as { configurable?: Record<string, unknown> } | null | undefined)
    ?.configurable;
  const value = configurable?.[TURN_CANCEL_CONFIG_KEY];
  return value instanceof AbortSignal ? value : undefined;
}

/** middleware 拿到的 request 上讀訊號。 */
function signalOfRequest(request: unknown): AbortSignal | undefined {
  return turnCancelSignalOf({
    configurable: (request as { runtime?: { configurable?: unknown } }).runtime?.configurable,
  });
}

/**
 * 外層那顆：擋工具與中止之後的模型呼叫。位置見檔頭「為什麼是兩顆」。
 *
 * **無狀態，一份實例走遍 root 與每個子代理**：訊號每次從那一次呼叫的 `configurable` 現讀。
 *
 * @returns 可以放進 middleware 陣列的實例。
 */
export function createTurnCancelGuard(): AgentMiddleware {
  return createMiddleware({
    name: TURN_CANCEL_MIDDLEWARE_NAME,
    wrapToolCall: async (request, handler) => {
      const signal = signalOfRequest(request);
      if (signal === undefined) return handler(request);
      const callId = request.toolCall.id ?? '';
      const name = request.toolCall.name;
      const aborted = (content: string, code: string) =>
        toolRefusal(content, { callId, name, error: { name: 'AbortError', code } });
      if (signal.aborted)
        return aborted(TOOL_ABORTED_BEFORE_DISPATCH_TEXT, TOOL_ABORTED_BEFORE_DISPATCH);
      let result: Awaited<ReturnType<typeof handler>>;
      try {
        result = await handler(request);
      } catch (error) {
        // 子代理被同一個訊號停下時，`task` 的本體就是拋這一顆出來——那是一次被中止的呼叫，
        // 不是工具壞了（#265 的 Q10）。其餘照拋，讓圍堵照它自己的規則分類。
        if (signal.aborted && error instanceof TurnCancelledError) {
          return aborted(TOOL_ABORTED_TEXT, TOOL_ABORTED);
        }
        throw error;
      }
      // 只換成功的結果，而且不換 `Command`。理由見檔頭。
      if (!signal.aborted || isCommand(result)) return result;
      if (readToolOutcome(result, callId).isError) return result;
      return aborted(TOOL_ABORTED_TEXT, TOOL_ABORTED);
    },
    wrapModelCall: async (request, handler) => {
      // 中止之後的下一次模型呼叫就是「這一步之後」：擋在這裡，圖停在剛落定的那批工具結果後面，
      // 對話狀態一致（AI 帶 tool_calls、每一顆都配到結果）。
      if (signalOfRequest(request)?.aborted) throw new TurnCancelledError();
      return handler(request);
    },
  }) as unknown as AgentMiddleware;
}

/**
 * 內層那顆：把中止訊號綁到模型請求上，被切斷的那次換成 {@link TurnCancelledError}。
 *
 * **無狀態，一份走遍**，同 {@link createTurnCancelGuard}。
 *
 * @returns 可以放進 middleware 陣列的實例，**要排在最內層**。
 */
export function createTurnCancelModelSignal(): AgentMiddleware {
  return createMiddleware({
    name: TURN_CANCEL_MODEL_SIGNAL_MIDDLEWARE_NAME,
    wrapModelCall: async (request, handler) => {
      const signal = signalOfRequest(request);
      // 動態模型（函式）包不了，照舊交出去——那條路上中止等到下一步才生效。
      if (signal === undefined || !RunnableBinding.isRunnable(request.model)) {
        return handler(request);
      }
      try {
        return await handler({
          ...request,
          model: new RunnableBinding({
            bound: request.model,
            config: { signal },
            kwargs: {},
          }) as unknown as typeof request.model,
        });
      } catch (error) {
        // 被切斷的那次拋什麼要看供應商與抽法（實測有 `Error("AbortError")`，也有
        // `DOMException`），所以認的是「訊號已經 abort」，不是錯誤長什麼樣。
        if (signal.aborted) throw new TurnCancelledError({ cause: error });
        throw error;
      }
    },
  }) as unknown as AgentMiddleware;
}
