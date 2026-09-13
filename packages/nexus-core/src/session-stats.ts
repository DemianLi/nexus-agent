/**
 * 會話統計：一份會話日誌折疊成**輪數、步數、模型耗時、工具耗時**。純折疊，不回寫任何東西。
 * 見 [#266](https://github.com/DemianLi/nexus-agent/issues/266)。
 *
 * 照 dsh 的 `sessionStats` 投影單元（`packages/session/session-stats/src/projection.ts`，SHA
 * `c291e79`）：同樣是 `init`／`apply`／`view` 三件、狀態是純 JSON、不相干的事件回同一個參照。
 *
 * ## 載體退到哪裡
 *
 * - **沒有投影註冊表。** dsh 把單元註冊到 `session-projection`，由它交給 web 的統計列。我們
 *   沒有那個註冊表，也沒有那個畫面；**今天的讀者是離線掃描**
 *   （[#268](https://github.com/DemianLi/nexus-agent/issues/268) 的步數欄），它自己把事件
 *   餵過 {@link deriveSessionStats}。形狀照單元寫，哪天有了註冊表可以原樣登記。
 * - **步是模型呼叫，不是 dsh 的步。** 邊界是 `model/start`／`model/end`（見
 *   {@link ./model-calls.ts}），只包模型那一段、工具落在外面。**顆數對得上**——一步恰好一次
 *   模型請求——所以 `steps` 照 dsh 的意思數；`llmMs` 也同義：dsh 量 `step/start` →
 *   `assistant/message`，一樣是請求開始到回應組好。**脈絡溢出的那一輪例外**：摘要器重叫一次
 *   模型，算兩步（`model-calls.ts` 的偏離那一節）。
 * - **失敗與中止的呼叫也計時。** dsh 被取消的步不計時（沒有組好的訊息），我們的 `model/end`
 *   不帶結果，分不出來，所以那段牆鐘照算進 `llmMs`。步數兩邊一樣都算。
 * - **首字延遲與解碼（`ttftMs`／`ttftSteps`、`decodeMs`／`decodeTokens`）整組不做。** 我們沒有
 *   記串流第一個 token 的時間。給 0 會被讀成「瞬間就回」；單留 `decodeTokens` 會被拿去算
 *   每秒 token 數。沒有載體就沒有欄位，不發明替代量。
 *
 * ## 輪怎麼數：沒有輪號，靠位置
 *
 * dsh 用事件上的輪號，只數「至少有一個已結束步」的輪。我們的 `turn/start` 不帶輪號，所以
 * 看位置：`message` 與 `goal` 開一輪，**`resume` 併回前一輪**——核准之後的那顆 `turn/start`
 * 在 dsh 那側是同一輪裡的等待，不是新的一輪；直接數 `turn/start` 會讓每次核准多算一輪。
 * 一輪要等到它的第一顆 `model/end` 才算數：沒叫到模型的輪不算，同 dsh。
 *
 * **subagent 那份沒有 `turn/start`**（入口點只包 root 的輪），一份就是一次委派，整份算一輪。
 *
 * ## 數字是逐份日誌的
 *
 * subagent 的模型呼叫與工具事件寫進它自己那份（`forCall`），所以 **root 那份的 `steps` 不是
 * 整場的總數**。要整場的就把每一份各折一次再加。
 *
 * ## 工具耗時與兩個清空點
 *
 * `tool/call` → `tool/result` 以 `callId` 配對，同 dsh。沒配到的呼叫在輪收尾時丟掉——dsh 只有
 * `turn/end`，我們的失敗是另一顆 `turn/failed`，兩顆都丟。**另外在 `session/end-seed` 丟**：
 * dsh 沒有這條路。沒丟的話，崩潰前那顆沒配對的 `tool/call` 會跟重啟 resume 之後的結果配上，
 * `toolMs` 吃進人不在鍵盤前的那一整段。
 *
 * **核准的等待不進帳**，靠的是兩條：被閘門中斷的那一輪以 `turn/end` 收尾（清空），resume
 * 之後同一個 `callId` 再記一顆 `tool/call`（覆寫派發時間）。前一條是承重的，後一條是保險。
 *
 * @module
 */

import type { SessionEvent } from './session-log.js';

/** 整份日誌的數字。每一格在第一個有貢獻的事件之前都是 0。 */
export interface SessionStats {
  /** 至少叫過一次模型的輪。`resume` 併回前一輪。 */
  readonly turns: number;
  /** 結束了的模型呼叫——完成、失敗、中止都算。 */
  readonly steps: number;
  /** 模型呼叫的牆鐘總和，ms。 */
  readonly llmMs: number;
  /** 配對到的 `tool/call` → `tool/result` 牆鐘總和，ms。 */
  readonly toolMs: number;
}

/** 折疊狀態：數字加上還在路上的邊界。純 JSON。 */
export interface SessionStatsState extends SessionStats {
  /** 目前這一輪已經算進 `turns` 了沒。 */
  readonly turnCounted: boolean;
  /** 還沒結束的那次模型呼叫的開始時間。 */
  readonly openModelCall: number | null;
  /** 還沒落定的工具呼叫的派發時間，以 `callId` 為鍵。 */
  readonly pendingCalls: Readonly<Record<string, number>>;
}

/** 空的 `pendingCalls`，換新的時候不必每次配一個。 */
const NO_PENDING: Readonly<Record<string, number>> = Object.freeze({});

/**
 * 會話統計的單元。形狀照 dsh 的 `ProjectionDefinition`，見檔頭。
 *
 * `apply` 對不相干的事件回**同一個參照**——dsh 那側拿 `Object.is` 閘住變更流，照抄。
 */
export const sessionStatsUnit = {
  key: 'sessionStats',
  stateVersion: 1,
  init: (): SessionStatsState => ({
    turns: 0,
    steps: 0,
    llmMs: 0,
    toolMs: 0,
    turnCounted: false,
    openModelCall: null,
    pendingCalls: NO_PENDING,
  }),
  apply: (state: SessionStatsState, event: SessionEvent): SessionStatsState => {
    switch (event.type) {
      case 'turn/start': {
        const { kind } = event.data as { kind?: unknown };
        if (kind === 'resume' || !state.turnCounted) return state;
        return { ...state, turnCounted: false };
      }
      case 'model/start':
        return { ...state, openModelCall: event.time };
      case 'model/end': {
        const started = state.openModelCall;
        return {
          ...state,
          turns: state.turnCounted ? state.turns : state.turns + 1,
          steps: state.steps + 1,
          llmMs: started === null ? state.llmMs : state.llmMs + Math.max(0, event.time - started),
          turnCounted: true,
          openModelCall: null,
        };
      }
      case 'tool/call':
        return {
          ...state,
          pendingCalls: { ...state.pendingCalls, [event.data.callId]: event.time },
        };
      case 'tool/result': {
        // 自己的 key 才算：`callId` 是模型給的，叫 `constructor` 的結果不能讀到繼承來的函式、
        // 把 `toolMs` 變成 NaN。同 dsh。
        const { callId } = event.data;
        if (!Object.hasOwn(state.pendingCalls, callId)) return state;
        const dispatched = state.pendingCalls[callId]!;
        const pendingCalls = Object.fromEntries(
          Object.entries(state.pendingCalls).filter(([id]) => id !== callId),
        );
        return {
          ...state,
          toolMs: state.toolMs + Math.max(0, event.time - dispatched),
          pendingCalls,
        };
      }
      case 'turn/end':
      case 'turn/failed':
        return Object.keys(state.pendingCalls).length === 0
          ? state
          : { ...state, pendingCalls: NO_PENDING };
      case 'session/end-seed':
        // `turnCounted` 不動：重啟之後的 `resume` 接的是崩潰前那一輪。
        return state.openModelCall === null && Object.keys(state.pendingCalls).length === 0
          ? state
          : { ...state, openModelCall: null, pendingCalls: NO_PENDING };
      default:
        return state;
    }
  },
  view: (state: SessionStatsState): SessionStats => ({
    turns: state.turns,
    steps: state.steps,
    llmMs: state.llmMs,
    toolMs: state.toolMs,
  }),
};

/**
 * 把一份日誌從頭折到尾。
 *
 * @param events - 一份日誌的事件，照 `seq` 排。
 * @returns 那一份的數字。**只有這一份**——subagent 的在它們自己那份，見檔頭。
 */
export function deriveSessionStats(events: Iterable<SessionEvent>): SessionStats {
  let state = sessionStatsUnit.init();
  for (const event of events) state = sessionStatsUnit.apply(state, event);
  return sessionStatsUnit.view(state);
}
