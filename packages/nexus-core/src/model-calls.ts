/**
 * 每一次模型呼叫的**起訖**，記進這次呼叫所屬的那一份會話日誌：`model/start` 在呼叫之前、
 * `model/end` 在 `finally` 裡。會話統計（{@link ./session-stats.ts}）拿它數步數、量模型耗時。
 * 見 [#266](https://github.com/DemianLi/nexus-agent/issues/266)。
 *
 * ## dsh 的 `step/*`，以及為什麼不叫那個名字
 *
 * dsh 的一步是「一次模型請求＋它派發的工具」：`step/start` 在請求前，`step/end` 在
 * `finally` 裡、**工具跑完之後**（`packages/core/agent-loop/src/agent.ts:302-312`，SHA
 * `c291e79`；`executeToolCalls` 在 `step()` 裡面）。所以 dsh 的工具事件**包在**一步裡。
 *
 * 我們拿得到的邊界是 `wrapModelCall`，而它只包模型那一段：工具事件落在這一對**之後**。
 * 名字沿用、時刻不同，下一個照 dsh 的投影去算「第 3 步叫了哪些工具」的人會靜靜算錯，
 * 而偏離登記擋不住只讀名字的人——所以換一個講實話的名字。**退的是載體，紀律照抄**：
 * `finally` 裡記結束，完成、失敗、中止的呼叫都落一顆，同 dsh 那條「每一個進入的步
 * 恰好一顆 `step/end`」。
 *
 * `model/start` 不帶資料：步數與耗時都只要事件自己的 `time`。
 *
 * ## 識別：哪些事件屬於同一次呼叫（[#1021](https://github.com/DemianLi/nexus-agent/issues/1021)）
 *
 * dsh 的 `assistant/message`、`tool/call`、`tool/result`、`system/message` 都帶 `{turn, step}`；我們的事件只有 `seq`／`time`，
 * 一對起訖之間夾什麼、量測寫在哪一顆之後，位置都不可靠（`model-call-index.ts` 檔頭有三個真實日誌的反例）。所以
 * 呼叫的識別就是**它的 `model/start` 的 `seq`**，`model/end`、`model/usage`、`llm/retry*`、`assistant/message`、
 * `context/measure` 各帶一格 `modelCall` 指回去；`tool/call`／`tool/result` 靠 `callId` 出現在發出它的那則回覆裡來歸
 * （不另存，見 `indexModelCalls`）。傳法見 {@link ./model-call-scope.ts}。**輪編號維持由 `seq` 推導、不另存。**
 *
 * 這一格是 dsh `step` 的對應物——**同一個詞、不同的邊界**：我們的「一次呼叫」只包模型那一段（見上），工具在它外面，
 * 所以工具歸它靠 `callId` 而不是時刻。上面登記的三處偏離逐項重核過：`model/start` 不是 `step/start`（載體是
 * `wrapModelCall`，沒變）、脈絡溢出算兩次呼叫（現在兩次各有各的識別，不再只是顆數）、拋錯的呼叫沒有 `assistant/attempt`（沒變）。
 *
 * ## 鉤子與位置都是選的
 *
 * - **`wrapModelCall`，不是 `beforeModel`／`afterModel`**：後兩個各自是圖上的一個節點，每一輪
 *   多吃一格 super-step（見 {@link ./model-usage.ts} 檔頭）。
 * - **緊貼用量記錄器、排在 plugin middleware 外層**（`fold.ts`）：一個自己重試模型的 plugin，
 *   重試幾次都只算一步。供應商 client 自己的重試在 handler 裡面，本來就包在這一對之內——
 *   同 dsh 的 `llm/retry` 在一步之內。
 *
 * ## 偏離：脈絡溢出的那一次算兩步
 *
 * 原本要排在摘要器外層（#266 拍板），**這個基座上表達不出來**：我們的摘要器是同名取代，
 * `createAgent` 以名字為鍵合併 middleware，它落回基座 `SummarizationMiddleware` 的原位——
 * 基座那幾顆在 fold 交出去的整串之前（`apps/harness/src/summarization.test.ts` 釘著那份
 * 順序）。所以不管排在哪，這顆都在摘要器**裡面**。
 *
 * 後果：deepagents 的摘要器碰到 `ContextOverflowError` 會先摘要、再叫一次內層
 * （`deepagents@1.13.1` `dist/index.js:3146-3225`），日誌上是兩對起訖，**算兩步**。退到這裡
 * 說得通：溢出的那一次是一個真的送出去、失敗了的請求，而失敗的呼叫本來就算一步。產摘要的
 * 那次呼叫是摘要器直接叫模型，不經過內層，**不算、也不計時**；兩對起訖一前一後、中間隔著
 * 摘要，`llmMs` 不會把同一段牆鐘算兩次。`apps/harness/src/context-overflow.test.ts` 釘著
 * 「四次模型節點、五步」。
 *
 * ## 重試也在這一格記（[#712](https://github.com/DemianLi/nexus-agent/issues/712)）
 *
 * 重試發生在 handler 裡面，core 看不到；這一格替每次呼叫開一個重試範圍（{@link ./llm-retry.ts}），
 * adapter 在裡面回報，落成 `llm/retry`／`llm/retry-started`，位置就在這一對起訖之間。
 *
 * ## 回覆也在這一格記（[#305](https://github.com/DemianLi/nexus-agent/issues/305)）
 *
 * `handler(request)` 回來的就是那一則完整的 AIMessage，web 與 CLI 兩條路都是——所以
 * `assistant/message` 寫在這裡，在 `model/end` 之前，順序同 dsh。這一格看到的是**進 graph state 的
 * 那一則**：外層只剩改請求不改回覆的那幾顆（摘要器、計劃模式的提示詞、基座那幾顆），改寫解不開
 * 參數的那顆與清掉截斷回覆裡呼叫的那顆（{@link ./max-tokens.ts}）都在內側。
 *
 * **拋錯的呼叫不記**：那次沒有回覆可記（dsh 那一次記的是 `assistant/attempt`，我們沒有，見
 * `session-log.ts`）。**但 `model/end` 帶 `outcome`**（[#1022](https://github.com/DemianLi/nexus-agent/issues/1022)）：
 * 拋錯是 `error`、使用者按了停止是 `aborted`，讓「這次燒了多少不知道」讀得出來。子代理那一層被中止時回的空訊息也不記——它是 {@link ./turn-cancel.ts} 合成來
 * 讓子代理的圖收尾的，不是模型的回覆；dsh 那側被中止、沒有看得見內容的那一步沒有 `assistant/message`。
 *
 * ## 記不進去不能扳倒模型呼叫
 *
 * 同 {@link ./model-usage.ts}：`forCall` 的非 `ok` 與 `append` 自己拋，一律吃掉。**開頭那顆
 * 沒記成，結尾那顆也不記**——半對的事件比沒有更糟，不變量會把它讀成寫錯了。回覆那顆吞得起，是因為
 * 會讓它拋的那條路（`undefined` 欄位）已經在 {@link ./logged-message.ts} 從源頭拿掉了。
 *
 * @module
 */

import { AIMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from './base-types.js';
import { runInRetryScope } from './llm-retry.js';
import { toLoggedMessage } from './logged-message.js';
import { noteModelCallReplied, runInModelCall, withModelCall } from './model-call-scope.js';
import { routeOfModel } from './model-route.js';
import type { ModelRoute } from './model-route.js';
import type { ModelCallOutcome, SessionLog } from './session-log.js';
import type { SessionLookup } from './registry.js';
import { isSyntheticStopReply, modelCallAborted } from './turn-cancel.js';

/** middleware 的名字。名字不撞基座任何一個，所以它是 novel entry。 */
export const MODEL_CALL_EVENTS_MIDDLEWARE_NAME = 'nexusModelCallEvents';

/** 記 `model/start`（帶這次請求走的路由，認得出來才帶），回它的 `seq`；記不進去回 `undefined`。 */
function tryAppendStart(log: SessionLog, route: ModelRoute | undefined): number | undefined {
  try {
    return log.append('model/start', route === undefined ? {} : { route }).seq;
  } catch {
    return undefined;
  }
}

/** 記配對的 `model/end`，帶這次呼叫的識別與（沒有正常回來時的）結果；記不進去就算了。 */
function tryAppendEnd(log: SessionLog, modelCall: number, outcome: ModelCallOutcome | undefined) {
  try {
    log.append('model/end', outcome === undefined ? { modelCall } : { modelCall, outcome });
  } catch {
    // 見檔頭「記不進去不能扳倒模型呼叫」。
  }
}

/** 記下這次呼叫回來的那一則。不是回覆的（`Command`、合成的空訊息）不記；記不進去就算了。 */
function tryRecordReply(log: SessionLog, response: unknown, modelCall: number): void {
  if (!AIMessage.isInstance(response) || isSyntheticStopReply(response)) return;
  try {
    log.append(
      'assistant/message',
      withModelCall({ message: toLoggedMessage(response) }, modelCall),
    );
    // 這一次有正常回覆了：之後 pump 補記的被切斷半段不會再掛到它底下（`lastModelCall`）。
    noteModelCallReplied(log, modelCall);
  } catch {
    // 見檔頭「記不進去不能扳倒模型呼叫」。
  }
}

/**
 * 建那顆 middleware。**無狀態，所以一份實例掛到哪裡都行**——同 {@link ./model-usage.ts}，
 * 日誌每次從執行期的 `configurable` 現算。
 *
 * @param sessions - 註冊表的 `sessions` 通道，用來問「這次呼叫該寫進哪一份」。
 * @returns 可以放進 middleware 陣列的實例。
 */
export function createModelCallRecorder(sessions: {
  forCall(config: unknown): SessionLookup;
}): AgentMiddleware {
  return createMiddleware({
    name: MODEL_CALL_EVENTS_MIDDLEWARE_NAME,
    wrapModelCall: async (request, handler) => {
      const found = sessions.forCall({
        configurable: (request as { runtime?: { configurable?: unknown } }).runtime?.configurable,
      });
      if (found.kind !== 'ok') return handler(request);
      const { log } = found;
      const modelCall = tryAppendStart(log, routeOfModel(request.model));
      if (modelCall === undefined) return handler(request);
      // 沒有正常回來的方式（#1022）：拋錯、或使用者按了停止。正常回來沒有。
      let outcome: ModelCallOutcome | undefined;
      try {
        // 這次呼叫的識別（`model/start` 的 `seq`）往內傳給用量與重試的寫入點，往外填給摘要器的量測
        // （{@link ./model-call-scope.ts}）。重試範圍包住 handler：adapter 在裡面回報失敗與重開（{@link ./llm-retry.ts}）。
        const response = await runInModelCall(log, modelCall, () =>
          runInRetryScope(log, () => handler(request)),
        );
        // 子代理被中止時回的是合成的空收尾，不是拋錯：它沒有回覆可記，這次呼叫算被中止。
        if (AIMessage.isInstance(response) && isSyntheticStopReply(response)) outcome = 'aborted';
        tryRecordReply(log, response, modelCall);
        return response;
      } catch (error) {
        outcome = modelCallAborted(request) ? 'aborted' : 'error';
        throw error;
      } finally {
        tryAppendEnd(log, modelCall, outcome);
      }
    },
  }) as unknown as AgentMiddleware;
}
