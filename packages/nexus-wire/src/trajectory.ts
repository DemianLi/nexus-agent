/**
 * 軌跡投影（[#1027](https://github.com/DemianLi/nexus-agent/issues/1027)）在線上的形狀：`@nexus/plugin-trajectory`
 * 折出來、由 {@link ./projection.ts | `projection` frame} 整份送到 web 的兩個值。
 *
 * 型別住在這裡而不是插件裡，因為讀它的是 `apps/web`，而 web 只依賴 `@nexus/wire`——插件是 harness 側的套件，
 * web 不該為了一個型別多一條相依。插件依賴 wire（單向、wire 是葉子）。
 *
 * ## 這份 view 刻意不帶內文
 *
 * 使用者原話、推理、回覆、工具參數與結果**早就在 web 的對話狀態裡**（既有的 `messages`／`tools` frame 與歷史頁）。
 * 這裡再放一份，只會讓每顆事件都重送的整份取代 frame 變大。所以只帶 web 拿不到的**結構**：時刻與耗時、哪次模型呼叫、
 * 用量、重試、當時生效的請求快照、工具的狀態與錯誤碼、決策點；內文一律用 web 已有的鍵指回去：
 *
 * - 工具：`callId`（工具卡的鍵）。
 * - 回覆：`messageId`（日誌上那則訊息自己的 id）與 `seq`（歷史頁的 `history-<seq>`）。
 * - 輪：`seq` 是 `turn/start` 在 root 日誌上的位置。
 *
 * ## 窗口
 *
 * frame 是**整份取代**、每顆事件都重送，所以 view 不能隨會話無限長：最近 {@link TRAJECTORY_DETAIL_TURNS} 輪帶逐呼叫結構
 * （`turns`），更早的輪只留一列摘要（`digests`，最多 {@link TRAJECTORY_DIGEST_CAP} 列，再早的只記數量 `omitted`）。
 * 預覽字串都有上限（{@link TRAJECTORY_PREVIEW_CHARS}）。
 *
 * ## 「沒記」與「是 0」
 *
 * 舊日誌沒有的欄位（沒有 `modelCall` 的事件、沒有請求快照）**缺席**，不補 0 也不猜。讀的人標「—」。
 *
 * @module
 */

/** 軌跡投影的 key（`projection` frame 的 `key`）。 */
export const TRAJECTORY_PROJECTION = 'trajectory';
/** 請求快照投影的 key。 */
export const REQUEST_SNAPSHOTS_PROJECTION = 'request-snapshots';

/** `trajectory` 的 `stateVersion`：折疊語意或 view 形狀一變就升。 */
export const TRAJECTORY_VERSION = 5;
/** `request-snapshots` 的 `stateVersion`。 */
export const REQUEST_SNAPSHOTS_VERSION = 1;

/**
 * 帶逐呼叫結構的最近幾輪。
 *
 * **過渡值**：8 → 3（2026-10-05，[#1083](https://github.com/DemianLi/nexus-agent/issues/1083) 的 B 半）。整份取代的 frame
 * 最壞情況（滿載輪：33 次呼叫 × 10 工具）8 輪是 377 KB，3 輪約 140 KB（推算，非實測）。dsh 與 penguin-harness 都沒有
 * 「推送的投影裡留最近 N 輪完整細節」這種形狀，共通做法是骨架給全部、細節按需拉；那一半是 #1083，做完後這個常數就不再需要。
 * 代價：第 4 輪以前只剩摘要，「跳到舊輪」落地的是摘要列。
 */
export const TRAJECTORY_DETAIL_TURNS = 3;
/** 摘要列最多幾列；更早的只記進 `omitted`。 */
export const TRAJECTORY_DIGEST_CAP = 200;
/** 預覽字串（輸入、錯誤訊息）最多幾個字元。 */
export const TRAJECTORY_PREVIEW_CHARS = 120;
/** 一輪最多留幾次呼叫的逐呼叫結構（最新的）；更早的折進 {@link TrajectoryElided}。 */
export const TRAJECTORY_TURN_CALLS_CAP = 32;
/** 一次呼叫最多留幾個工具（最新的）。 */
export const TRAJECTORY_CALL_TOOLS_CAP = 16;
/** 一輪的 `inputs`、`decisions`、`looseTools` 各最多留幾筆（最新的）。 */
export const TRAJECTORY_TURN_LIST_CAP = 32;
/**
 * 請求快照每種最多留幾份（最新的）。
 *
 * **比軌跡窗口（{@link TRAJECTORY_DETAIL_TURNS} 輪）留得少**：呼叫上記的 `system`／`header` 是指向快照的 `seq`，窗口裡舊的呼叫
 * 指到的快照可能已經不在這裡——讀的人要接得住「找不到」並標「已不保留」。系統提示詞只在計劃模式、沙箱模式這類切換時才變，所以
 * 實際上很少發生，但型別上沒有保證。
 */
export const REQUEST_SNAPSHOTS_KEEP = 4;
/** 一份系統提示詞最多存幾個字元；超過的截斷並標 `truncated`。 */
export const REQUEST_SYSTEM_MAX_CHARS = 64 * 1024;

/**
 * 一輪是怎麼開始的。同 `turn/start` 的 `kind`，外加 `run`：一份**整份都沒有 `turn/start`** 的日誌（前景子代理，它的日誌從第一次
 * 模型呼叫就開始、沒有輪的邊界）從第一次模型呼叫算一輪，標 `run`（#1070）。它沒有 `turn/end`，所以不會有 `end`——那一份有沒有
 * 跑完，看 root 軌跡上 `subagent/catalog` 的連結。
 */
export type TrajectoryTurnKind =
  'message' | 'resume' | 'agent-message' | 'subagent-settled' | 'goal' | 'run';

/** 一輪怎麼結束的；還沒結束就沒有這一格。 */
export type TrajectoryEnd = 'completed' | 'aborted' | 'max-tokens' | 'interrupted' | 'failed';

/** 一次重試。第一次嘗試本身沒有事件，所以 `retry` 從 1 起。 */
export interface TrajectoryRetry {
  readonly seq: number;
  readonly time: number;
  /** 一次呼叫的所有重試共用的識別（`llm/retry` 與配對的 `llm/retry-started` 靠它對上）。 */
  readonly retryId: string;
  /** 第幾次重試（1 起）。 */
  readonly retry: number;
  readonly maxRetries: number;
  /** 失敗的分類碼（`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`…）。 */
  readonly code: string;
  /** 供應商回的 HTTP 狀態；沒有就不放。 */
  readonly status?: number;
  /** 實際等了幾毫秒（`llm/retry-started` 才知道）；還沒開始重試就沒有。 */
  readonly waitedMs?: number;
}

/** 子代理連結（`subagent/catalog`）。 */
export interface TrajectorySubagentLink {
  /** 子會話 id（`<root>/<runId>`）。 */
  readonly childId: string;
  /**
   * 子代理的 `runId`，就是 `childId` 最後一段：這個子代理自己那份軌跡在 `subagentProjections[runId]`（#1070）。直接給出來，
   * 讀的人不必知道 `childId` 的拼法。
   */
  readonly runId: string;
  readonly mode: 'one-shot' | 'continuable';
  /** 那顆目錄在 root 日誌上的位置。 */
  readonly catalogSeq: number;
}

/** 一次工具呼叫。 */
export interface TrajectoryTool {
  readonly callId: string;
  readonly name: string;
  /** `tool/call` 的位置與時刻（被核准中斷後重進的，是最後一次）。 */
  readonly seq: number;
  readonly time: number;
  readonly status: 'running' | 'ok' | 'error';
  readonly endTime?: number;
  /** 配對的 `tool/result` 時刻減 `tool/call` 時刻。 */
  readonly durationMs?: number;
  /** 失敗的分類碼（`UNKNOWN_TOOL`、`INVALID_ARGS`、`ABORTED`…）；不帶碼的失敗沒有。 */
  readonly code?: string;
  readonly subagent?: TrajectorySubagentLink;
}

/** 一則回覆的結構（內文不在這裡）。 */
export interface TrajectoryReply {
  readonly seq: number;
  readonly time: number;
  /** 日誌上那則訊息自己的 id；有些供應商不給。 */
  readonly messageId?: string;
  /** 被人按停止切斷的半段。 */
  readonly interrupted?: true;
  readonly textChars: number;
  /** 推理區塊的總字數。**日誌不記供應商給的是全文還是摘要版**，所以這裡只有字數、沒有判斷。 */
  readonly reasoningChars: number;
  /** 這則回覆叫了幾個工具。 */
  readonly toolCalls: number;
}

/** 一次模型呼叫。識別是它的 `model/start` 的位置（#1021）。 */
export interface TrajectoryCall {
  /** 識別，也就是 `model/start` 的 `seq`。 */
  readonly id: number;
  readonly time: number;
  readonly endTime?: number;
  readonly durationMs?: number;
  /**
   * 這次呼叫沒有正常回來的方式（`model/end.outcome`，#1022）：`error` ＝ 拋錯，`aborted` ＝ 使用者按了停止。
   * 沒有這一格 ＝ 正常回來，或舊日誌。失敗的呼叫若供應商報過用量，數字在 `usage` 裡。
   */
  readonly outcome?: 'error' | 'aborted';
  /** 模型 id（取自當時生效的請求快照）。 */
  readonly model?: string;
  /** 當時生效的 `request/system` 的位置；細節在 `request-snapshots` 投影。 */
  readonly system?: number;
  /** 當時生效的 `request/header` 的位置。 */
  readonly header?: number;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
  /** 摘要器量這次請求得到的估算。 */
  readonly measure?: { readonly approxTokens: number; readonly messageCount: number };
  readonly retries: readonly TrajectoryRetry[];
  readonly reply?: TrajectoryReply;
  readonly tools: readonly TrajectoryTool[];
}

/** 輪中進來的輸入（人插的話、佇列變動、子代理來信…），不開新的一輪。 */
export interface TrajectoryInput {
  readonly seq: number;
  readonly time: number;
  /** `user/message` 的來源 `kind`，或 `inbox`（送出佇列變動）。 */
  readonly source: string;
  /** 前 {@link TRAJECTORY_PREVIEW_CHARS} 個字元（只有人話與來信才有）。 */
  readonly preview?: string;
  /** 佇列變動的方向：插入幾件、拿掉幾件。 */
  readonly inserted?: number;
  readonly removed?: number;
}

/** 一個決策點／閘門。只有結構化欄位，不帶寫給模型的原文（#1018 Q3）。 */
export type TrajectoryDecision =
  | {
      readonly kind: 'reminder';
      readonly seq: number;
      readonly time: number;
      readonly tool?: string;
      readonly count?: number;
    }
  | {
      readonly kind: 'plugin-message';
      readonly seq: number;
      readonly time: number;
      readonly plugin: string;
    }
  | {
      readonly kind: 'goal';
      readonly seq: number;
      readonly time: number;
      readonly operation?: string;
      readonly phase?: string;
    }
  | { readonly kind: 'plan'; readonly seq: number; readonly time: number; readonly active: boolean }
  | { readonly kind: 'todo'; readonly seq: number; readonly time: number; readonly items: number }
  | {
      readonly kind: 'compaction';
      readonly seq: number;
      readonly time: number;
      readonly cutoffIndex: number;
      readonly messagesBefore: number;
    }
  | {
      readonly kind: 'interrupt';
      readonly seq: number;
      readonly time: number;
      /** 這顆中斷的 id（`interrupt/raised.interruptId`）。**選填**：v3 以前的值沒有它。 */
      readonly id?: string;
      /**
       * 這顆中斷是一個**核准問題**時才有（#1029，`approval/asked` 與它的結局）；問答那一種（`ask_user_question`、計劃審核）
       * 與沒記過 `approval/*` 的舊日誌沒有這一格，**缺席不是「沒有核准」**，只是這份日誌答不出。
       */
      readonly approval?: TrajectoryApproval;
    };

/** 結局的詞彙，同 `@nexus/core` 的 `ApprovalOutcome`（dsh 的 `ApprovalOutcome`）。`plugin-trajectory` 的測試釘兩邊一致。 */
export type TrajectoryApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

/**
 * 一個核准問題。**只有結構化欄位**，不帶發問的人話（那在對話的核准卡上，且可能夾著工具參數的片段）。
 *
 * 配對是 `approval/asked` 與 `approval/decided` 靠同一個 id（人那條路上 id 就是中斷的 id）。**沒有 `outcome` ＝ 還在等，
 * 或這一輪死在等的時候**：讀的人照「未決」表態，不要推一個結果。政策／無管道這類不必問人就確定的核准不在這裡
 * （沒有人被擋下來等；它們的結局在那一次呼叫的錯誤碼 `APPROVAL_POLICY_NEVER`／`APPROVAL_NO_CHANNEL`）。
 */
export interface TrajectoryApproval {
  /** 被問的工具名。 */
  readonly tool: string;
  /** 被問的那一次呼叫，配得上呼叫列的工具 id。基座沒給就缺席。 */
  readonly callId?: string;
  readonly outcome?: TrajectoryApprovalOutcome;
  /** 結局落日誌的時刻（毫秒）；等多久自己和中斷的 `time` 相減。 */
  readonly decidedAt?: number;
}

/** 超過單輪上限而被摺掉的結構數（只有真的摺過才出現）。計數（`callCount` 等）仍然包含它們。 */
export interface TrajectoryElided {
  /** 被摺掉的最舊幾次呼叫。 */
  readonly calls: number;
  /** 被摺掉的工具（含歸不到呼叫的 `looseTools`）。 */
  readonly tools: number;
  readonly inputs: number;
  readonly decisions: number;
}

/** 一輪的摘要，窗口外的輪只剩這些。 */
export interface TrajectoryDigest {
  /** 第幾輪（0 起，每顆 `turn/start` 一輪，含 `resume`）。 */
  readonly index: number;
  /** `turn/start` 在 root 日誌上的位置。 */
  readonly seq: number;
  readonly time: number;
  readonly kind: TrajectoryTurnKind;
  /** 這一輪是不是開了新的邏輯輪（`resume` 不算，它接著上一輪停在核准點的那幾顆呼叫）。 */
  readonly logical: boolean;
  readonly end?: TrajectoryEnd;
  readonly endTime?: number;
  readonly durationMs?: number;
  /** 模型呼叫數。 */
  readonly callCount: number;
  /**
   * 工具呼叫數（含歸不到呼叫的、含被摺掉的）。
   *
   * **被摺掉的那幾個，成功與否只記到「摺掉當下」**：還在跑的就算沒失敗，之後才失敗的不會回頭加進 `toolErrors`。
   */
  readonly toolCount: number;
  readonly toolErrors: number;
  /**
   * 這一輪派出幾個子代理（工具帶 `subagent` 連結的數目，含被摺掉的），讓骨架就能畫「N 個子代理」而不必展開
   * （[#1083](https://github.com/DemianLi/nexus-agent/issues/1083)）。**被摺掉的那幾個，連結與否只記到摺掉當下**，同 `toolErrors`。
   */
  readonly subagentCount: number;
  readonly retryCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** 一輪的完整結構。 */
export interface TrajectoryTurn extends TrajectoryDigest {
  /** 開頭那一句的前 {@link TRAJECTORY_PREVIEW_CHARS} 個字元；`resume` 沒有。 */
  readonly preview?: string;
  /** 開頭那一句的總字元數。 */
  readonly chars?: number;
  /** 失敗的訊息預覽。 */
  readonly failure?: string;
  /** 輪中進來的輸入。起訖之間夾著的佇列變動在這裡，**不算進任何一次模型呼叫**（#1067 的承諾）。 */
  readonly inputs: readonly TrajectoryInput[];
  /** 這一輪的模型呼叫，照 `model/start` 的順序。最多留最新 {@link TRAJECTORY_TURN_CALLS_CAP} 次，更早的見 `elided`。 */
  readonly calls: readonly TrajectoryCall[];
  /** 單輪上限摺掉了什麼；沒摺過就沒有這一格。 */
  readonly elided?: TrajectoryElided;
  /** 歸不到任何一次呼叫的工具（舊日誌的回覆沒記 `modelCall`、或回覆不在這份日誌裡）。**不猜**。 */
  readonly looseTools: readonly TrajectoryTool[];
  readonly decisions: readonly TrajectoryDecision[];
  /** 歸不到任何呼叫的模型事件數（`modelCall` 缺席或指到不存在的呼叫）。 */
  readonly unattributed: number;
}

/** `trajectory` 投影的 view。 */
export interface TrajectoryView {
  /** 窗口外的輪，舊的在前。 */
  readonly digests: readonly TrajectoryDigest[];
  /** 比 `digests` 更早、連摘要都沒留下的輪數。 */
  readonly omitted: number;
  /** 最近的輪，舊的在前，帶逐呼叫結構。 */
  readonly turns: readonly TrajectoryTurn[];
}

/** 一份系統提示詞快照。 */
export interface RequestSystemSnapshot {
  readonly seq: number;
  readonly time: number;
  readonly reason: 'initial' | 'change';
  /** 記下它的那次呼叫（`model/start` 的位置）。 */
  readonly modelCall?: number;
  readonly text: string;
  /** 原文總字元數；超過 {@link REQUEST_SYSTEM_MAX_CHARS} 時 `text` 是截斷的。 */
  readonly chars: number;
  readonly truncated?: true;
}

/** 一份請求設定與工具清單快照。 */
export interface RequestHeaderSnapshot {
  readonly seq: number;
  readonly time: number;
  readonly reason: 'initial' | 'change';
  readonly modelCall?: number;
  /** 同 `request/header` 的 `header`（`config` 與選配的 `tools`）。 */
  readonly header: unknown;
}

/** `request-snapshots` 投影的 view：最新的幾份，舊的在前。 */
export interface RequestSnapshotsView {
  readonly system: readonly RequestSystemSnapshot[];
  readonly header: readonly RequestHeaderSnapshot[];
}

/**
 * 按需拉一個邏輯輪的錨點（[#1083](https://github.com/DemianLi/nexus-agent/issues/1083)），`seq` 與 `messageId` 二擇一。
 * `runId` 可選：給了就在那個子代理自己的日誌裡找（沒給 `seq`／`messageId` 時回它的第一個邏輯輪）。
 */
export interface TrajectoryTurnQuery {
  /** 日誌上任意一顆事件的位置（摘要的 `seq`、呼叫的 `id`、工具的 `seq` 都行）；解析成包含它的那個邏輯輪。 */
  readonly seq?: number;
  /** 對話裡 ai 條目的 `messageId`；找到那則回覆，再解析成包含它的邏輯輪。 */
  readonly messageId?: string;
  /** 子代理的編號：`subagentProjections` 的鍵，也是工具上 `subagent.runId`。前景的是 `tools:…`，背景的是 `bg-…`。 */
  readonly runId?: string;
}

/**
 * 按需拉到的一個邏輯輪。
 *
 * `turns` 是組成它的**實體輪**：第一個 `logical: true`，其後是它的 resume 輪（`logical: false`）。每一輪的形狀、`index`、`seq`
 * 都與推送的骨架裡同一輪完全相同，所以拉回來的可以原位取代那一列摘要。整份日誌都折過，所以**窗口外才到的事件**（遲到的工具結果、
 * 後面的 resume 輪才落日誌的核准結局）也已經記在裡面；比推送出去的摘要更完整，兩邊的計數可能因此不同，以這一份為準。
 */
export interface TrajectoryTurnDetail {
  readonly turns: readonly TrajectoryTurn[];
  /** 折疊時看到的日誌最後一顆事件的位置；拿它判斷這份細節新不新。 */
  readonly seq: number;
}
