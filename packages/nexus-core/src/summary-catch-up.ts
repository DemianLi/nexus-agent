/**
 * 失敗輪留下的摘要事件，在下一步請求之前補回 graph state
 * （[#1390](https://github.com/DemianLi/nexus-agent/issues/1390)）。
 *
 * ## 缺的是什麼
 *
 * 摘要生成之後、請求才失敗（503、逾時、使用者停止）：日誌上的 `compaction/summary` 已經記下（記在 `model/start`
 * 之前，#1301），而基座只在請求**成功**時才用 `Command` 把 `_summarizationEvent` 交給 graph state。失敗的那一步
 * 沒有 `Command`，state 沒有事件。下一輪若不再摘要（換到窗口更大的模型、或重新量過沒到門檻），模型收到的是完整
 * 原文，而從日誌推出來的歷史套用了那筆事件——推導與實送對不上（#1339 的驗收條件）。下一輪若又要摘要，基座從
 * 沒摘要過的狀態重摘，歷史檔疊一份重複的區段（#1389）。
 *
 * ## 為什麼是在請求前補，不是失敗當下寫
 *
 * 失敗當下用 `__pregel_send` 把事件送進該 task 的寫入是做得到的，也會被 `putWrites` 存下來（`getState()` 看得到），
 * **但下一輪不套用**：`ReactAgent.invoke`／`stream` 每次呼叫前走 `#initializeMiddlewareStates`
 * （`langchain@1.5.10`，`dist/agents/ReactAgent.js:560-570`），把 `getState().values` 與新輸入合併後**當輸入**餵回圖；
 * `_` 開頭的私有欄位在那裡被特別處理（`dist/agents/nodes/utils.js:27`），不走輸入，失敗任務對它的寫入在下一個 input
 * 步被丟掉。`files` 之所以延續得下來，靠的就是這條回灌，不是 pending writes 被套用。換成 `ReducedValue`、改成
 * 摘要生成當下就送，結果相同（量過）。所以只剩節點自己的回傳這一個入口：這一層在下一步請求**之前**讀日誌、補上。
 *
 * ## 做法
 *
 * 進來的請求，state 的事件落後日誌上最後一筆 `compaction/summary` 時：
 *
 * 1. 用日誌事件還原一份 `_summarizationEvent`（切點、`filePath` 直接取日誌上那份，摘要訊息用 replay 同一個建構函式
 *    {@link fromLoggedMessage} 還原，不重算）；
 * 2. 把它放進交下去的請求的 state，基座就從這個切點接著算（重摘時切點接著提交過的那一筆）；
 * 3. 這一步沒有再摘要（基座沒回 `Command`）時，回一顆只帶這個事件的 `Command`，讓 state 跟上。基座自己又摘要了，
 *    它的 `Command` 帶著更新的事件，照原樣往外走。
 *
 * **比對只用兩個結構化欄位（切點與 `filePath`），不比摘要文字**：摘要文字是模型生的，沒有穩定的相等性；切點是 state
 * 座標，單調遞增。落後＝日誌切點大於 state 切點（或 state 沒有事件）。
 *
 * ## 子代理與換模型
 *
 * 讀的是**這次呼叫自己的**日誌（`sessions.forCall`，與 `model/usage`、`compaction/summary` 同一把鑰匙，規則同
 * `summaryModelOf`）：子代理讀自己那份、root 讀 root 的；規則不看 `request.model`，換模型的那一步與沒換的一樣。
 *
 * ## 偏離登記（AGENTS.md「偏離規則」）
 *
 * dsh 的壓縮是一筆交易：`compaction/start` → 摘要 → `commitCompactionBody` → `compaction/end`，提交之後就算數，
 * 之後的請求失敗不撤回（`compaction-basic/src/region.ts:157-250`、`index.ts:202-216` 的 durable surface progress）。
 * 我們的 graph state 表達不出「摘要一完成就提交」：基座只在請求成功時回 `Command`，失敗任務對私有欄位的寫入下一輪
 * 不套用（上面量過）。**退到最接近的：提交時點從壓縮當下延到下一步請求之前**，資料取日誌上記著的那一份（日誌是
 * 耐久的、先記的）。失敗與下一步請求之間，日誌已有事件、state 還沒有，這一段不影響請求（下一步前一定補上）。
 *
 * @module
 */

import { fromLoggedMessage } from './logged-message.js';
import { HumanMessage } from '@langchain/core/messages';
import { Command, isCommand } from '@langchain/langgraph';
import type { AgentMiddleware } from './base-types.js';
import type { SessionLookup } from './registry.js';
import type { SessionEvent } from './session-log.js';

/** 基座 `_summarizationEvent` 的形狀（`SummarizationEventSchema`，`deepagents@1.13.1`）。 */
export interface RestoredSummaryEvent {
  readonly cutoffIndex: number;
  readonly summaryMessage: HumanMessage;
  readonly filePath: string | null;
}

/**
 * 這個 state 的摘要事件是不是落後日誌；落後就回該補的那一份。
 *
 * @param state - 這一步請求的 graph state（只讀 `messages` 長度與 `_summarizationEvent` 的 `cutoffIndex`、`filePath`）。
 * @param events - 這次呼叫所屬的那份日誌上的事件。
 * @returns 要補的事件；沒有落後（或日誌上沒有可用的摘要事件）回 `undefined`。
 */
export function summaryEventToCatchUp(
  state: unknown,
  events: readonly SessionEvent[],
): RestoredSummaryEvent | undefined {
  let latest: Extract<SessionEvent, { type: 'compaction/summary' }> | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === 'compaction/summary') {
      latest = event;
      break;
    }
  }
  if (latest === undefined) return undefined;
  const { cutoffIndex, filePath, summary } = latest.data;
  if (summary === undefined || typeof cutoffIndex !== 'number') return undefined;

  const shape = (state ?? {}) as {
    readonly messages?: unknown;
    readonly _summarizationEvent?: unknown;
  };
  const current = shape._summarizationEvent;
  if (current !== null && typeof current === 'object') {
    const held = current as { readonly cutoffIndex?: unknown; readonly filePath?: unknown };
    // 結構化比對：切點與 filePath 都一樣＝已經跟上；日誌切點不比 state 的大＝沒有落後（不退回舊的）。
    if (held.cutoffIndex === cutoffIndex && held.filePath === filePath) return undefined;
    if (typeof held.cutoffIndex === 'number' && cutoffIndex <= held.cutoffIndex) return undefined;
  }
  // 切點落在 state 訊息串之外：日誌與 state 不是同一份歷史（例如退回過），不補。
  if (Array.isArray(shape.messages) && cutoffIndex > shape.messages.length) return undefined;

  const message = fromLoggedMessage(summary);
  if (!HumanMessage.isInstance(message)) return undefined;
  return { cutoffIndex, summaryMessage: message, filePath };
}

/**
 * 在每一步請求之前讓 state 的摘要事件跟上日誌（見檔頭）。包在摘要器的最外層：外面的預算與剪刀看到的
 * 有效訊息串（{@link ./summarization.ts | effectiveMessages}）也要是補過的。
 *
 * **不准拋**：讀日誌失敗就當沒有落後，請求照舊往下走。
 *
 * @param base - 摘要器（已包過其餘各層）。
 * @param sessions - 註冊表的 `sessions` 通道。
 * @returns 同名、同狀態、請求前多一道補寫的 middleware。
 */
export function withSummaryCatchUp(
  base: AgentMiddleware,
  sessions: { forCall(config: unknown): SessionLookup },
): AgentMiddleware {
  const inner = base.wrapModelCall?.bind(base);
  /* v8 ignore next -- 摘要器一定有 wrapModelCall；沒有的話包了也沒意義，原樣回去。 */
  if (inner === undefined) return base;
  return {
    ...base,
    wrapModelCall: async (request, handler) => {
      let restored: RestoredSummaryEvent | undefined;
      try {
        const found = sessions.forCall({
          configurable: (request as { runtime?: { configurable?: unknown } }).runtime?.configurable,
        });
        if (found.kind === 'ok') restored = summaryEventToCatchUp(request.state, found.log.events);
      } catch {
        restored = undefined;
      }
      if (restored === undefined) return inner(request, handler);
      const seeded = {
        ...request,
        state: { ...(request.state as object), _summarizationEvent: restored },
      } as unknown as typeof request;
      const result = await inner(seeded, handler);
      // 基座自己又摘要了：它的 Command 帶著更新的事件。其餘的時候補一顆，讓 state 跟上。
      return isCommand(result)
        ? result
        : (new Command({ update: { _summarizationEvent: restored } }) as unknown as typeof result);
    },
  } as AgentMiddleware;
}
