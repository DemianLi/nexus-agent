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
 * 兩顆都不帶資料：步數與耗時都只要事件自己的 `time`。
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
 * 說得通：溢出的那一次是一個真的送出去、失敗了的請求，而失敗的呼叫本來就算一步。
 *
 * ## 記不進去不能扳倒模型呼叫
 *
 * 同 {@link ./model-usage.ts}：`forCall` 的非 `ok` 與 `append` 自己拋，一律吃掉。**開頭那顆
 * 沒記成，結尾那顆也不記**——半對的事件比沒有更糟，不變量會把它讀成寫錯了。
 *
 * @module
 */

import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from './base-types.js';
import type { SessionLog } from './session-log.js';
import type { SessionLookup } from './registry.js';

/** middleware 的名字。名字不撞基座任何一個，所以它是 novel entry。 */
export const MODEL_CALL_EVENTS_MIDDLEWARE_NAME = 'nexusModelCallEvents';

/** 記一顆，記不進去回 `false`。 */
function tryAppend(log: SessionLog, type: 'model/start' | 'model/end'): boolean {
  try {
    log.append(type, {});
    return true;
  } catch {
    return false;
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
      if (found.kind !== 'ok' || !tryAppend(found.log, 'model/start')) return handler(request);
      try {
        return await handler(request);
      } finally {
        tryAppend(found.log, 'model/end');
      }
    },
  }) as unknown as AgentMiddleware;
}
