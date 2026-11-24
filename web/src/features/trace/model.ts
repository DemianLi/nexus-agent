/**
 * 觀測分頁的列與組的型別（`TraceRow`、`TurnHead`、`TraceTurn`、`TraceModel` 等）與兩張狀態字表。
 * 抽成獨立檔，讓各個實作檔只依賴型別、不必回頭 import `view.ts`；對外仍從 `features/trace/view.ts` 取。
 *
 * @module
 */

import type {
  AgentMessageEntry,
  AiEntry,
  AnswerEntry,
  Attribution,
  CompactionEntry,
  DecisionEntry,
  HumanEntry,
  NoticeEntry,
  ToolEntry,
  TrajectoryEnd,
  TrajectoryTurnKind,
  TurnStopCause,
} from '@nexus/wire';
import type { PlanOutcome } from '@/features/plan';
import type { SignalKind } from '@/features/trace/trajectory-view';

/** 一次模型呼叫沒有正常回來的說法：拋錯、被中止，或被那一輪的時鐘切斷。 */
export const CALL_OUTCOME_LABEL = {
  error: '失敗',
  aborted: '已中止',
  'timed-out': '超過時間上限，已中止',
} as const;

export type EndingReason = 'stopped' | 'timed-out' | 'max-tokens' | 'blocked' | 'failed';

export const ENDING_LABEL: Readonly<Record<EndingReason, string>> = {
  stopped: '已停止',
  /** 一輪的時鐘到點停下（#1631）：不是誰按了停止，也不是失敗，不畫紅。 */
  'timed-out': '超過時間上限，已停止',
  'max-tokens': '輸出上限',
  /** 封存的會話收到話：這一輪開了又立刻收尾，沒有送給模型（#633）。不是失敗，不畫紅。 */
  blocked: '已擋下（會話已封存）',
  failed: '失敗',
};

interface RowBase {
  /** React key；同一則條目的幾列靠後綴分開。 */
  readonly key: string;
  /**
   * 「在對話裡定位」要找的那一格：對話區 `MessageScrollerItem` 的 `messageId`，也就是條目 id。**沒有就是沒有地方可定位**
   * （配不到提問卡的答案：它自己在對話區沒有一格；投影裡的重試、提醒也沒有），那一列不畫定位鈕。
   */
  readonly target: string | undefined;
  /** 子代理那幾列帶歸屬；root 的沒有。 */
  readonly attribution?: Attribution;
}

/** 一份請求快照在這次呼叫上的狀態：呼叫沒記指向哪一份、指到的已不保留、或還在。 */
export type SnapshotState = 'none' | 'gone' | 'kept';

/** 這份快照為什麼被記：第一次記，或內容變了（`request/system`、`request/header` 的 `reason`）。 */
export type SnapshotReason = 'initial' | 'change';

export type TraceRow =
  | (RowBase & { readonly kind: 'input'; readonly entry: HumanEntry; readonly summary: string })
  | (RowBase & { readonly kind: 'notice'; readonly entry: NoticeEntry; readonly summary: string })
  | (RowBase & {
      readonly kind: 'agent-message';
      readonly entry: AgentMessageEntry;
      readonly caption: string;
      readonly summary: string;
    })
  | (RowBase & { readonly kind: 'thinking'; readonly entry: AiEntry; readonly text: string })
  | (RowBase & { readonly kind: 'reply'; readonly entry: AiEntry; readonly summary: string })
  | (RowBase & {
      readonly kind: 'tool';
      readonly entry: ToolEntry;
      readonly title: string;
      readonly summary: string;
      /** 交出計劃那一顆的審核結果；別的工具、還在等、或沒走審核的沒有。 */
      readonly outcome?: PlanOutcome;
      /** 配到這張提問卡的本地答案（`pairAnswers`），展開的那張卡要讀它當退路。 */
      readonly answer?: AnswerEntry;
      /** 結構化模式才有：`tool/call` 的時刻與配對結果的耗時（取自投影，不取條目）。 */
      readonly time?: number;
      readonly durationMs?: number;
      /** 這顆工具派出的子代理（`runId`）：展開它的呼叫結構要用。 */
      readonly subagentRunId?: string;
      /** 派它的那一輪（含續接段）被時鐘切斷（只放原始值，理由同 `call` 那一列）。前景子代理的呼叫靠它分開講，見 {@link cutByParentClock}。 */
      readonly parentCutByClock?: true;
    })
  | (RowBase & {
      readonly kind: 'decision';
      readonly entry: DecisionEntry;
      readonly summary: string;
    })
  | (RowBase & { readonly kind: 'answer'; readonly entry: AnswerEntry; readonly summary: string })
  | (RowBase & { readonly kind: 'compaction'; readonly entry: CompactionEntry })
  | (RowBase & {
      readonly kind: 'ending';
      readonly reason: EndingReason;
      readonly summary: string;
    })
  /**
   * 模型呼叫段落（結構化模式）。**只放原始值**：投影每顆事件都整份換掉，列要是抓著 view 裡的物件，`sameRow` 每個 frame 都會
   * 判成不同、整個分頁每顆事件重畫一次。
   */
  | (RowBase & {
      readonly kind: 'call';
      /** 這一輪裡第幾次呼叫（1 起，含被摺掉的）。 */
      readonly n: number;
      readonly time: number;
      readonly endTime?: number;
      readonly durationMs?: number;
      readonly model?: string;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      /** 快取分桶（#724）；缺席＝沒記，投影沒給這幾格（舊 server）整組缺席。 */
      readonly uncachedInputTokens?: number;
      readonly cacheReadTokens?: number;
      readonly cacheWriteTokens?: number;
      readonly toolCount: number;
      readonly retryCount: number;
      /**
       * 這次呼叫沒有正常回來的方式（投影的 `TrajectoryCall.outcome`）；沒有這一格 ＝ 正常回來，或舊日誌。
       * `timed-out` 是 `aborted` 而且那一輪時鐘到點（`TrajectoryDigest.endCause`，#1847）；前景子代理沒有自己的原因，讀派它那一輪（含續接段）的，見 {@link cutByParentClock}。一輪只會被中止一次，中止的呼叫就是那次原因切斷的。
       */
      readonly outcome?: keyof typeof CALL_OUTCOME_LABEL;
      readonly system: SnapshotState;
      readonly systemChars?: number;
      readonly systemTruncated?: boolean;
      readonly header: SnapshotState;
      readonly headerTools?: number;
      /** 展開要看的內容。**都是字串**：列只放原始值（見上），投影的物件每個 frame 都是新的。 */
      readonly systemText?: string;
      readonly systemReason?: SnapshotReason;
      /** 設定與工具清單（`request/header` 的 `header`）整份轉成 JSON；展開時才解析。 */
      readonly headerJson?: string;
      readonly headerReason?: SnapshotReason;
      /** 這份工具清單相對上一份留著的快照，多了哪些、少了哪些；沒有上一份、或沒變就沒有這一格。 */
      readonly toolsDiff?: string;
      /** 投影說這次呼叫有東西可看：回覆有字、有推理，或叫了工具。 */
      readonly hasContent: boolean;
      /** 有沒有任何條目歸在這次呼叫上。`hasContent` 而沒有 `loaded`，就是內文沒載入。 */
      readonly loaded: boolean;
    })
  | (RowBase & {
      readonly kind: 'retry';
      readonly retry: number;
      readonly maxRetries: number;
      readonly time: number;
      readonly code: string;
      readonly status?: number;
      readonly waitedMs?: number;
    })
  | (RowBase & {
      readonly kind: 'signal';
      readonly signal: SignalKind;
      readonly time: number;
      readonly summary: string;
    });

/** 一輪的標題。取自投影，只放原始值。 */
export interface TurnHead {
  /**
   * 第幾個**邏輯輪**（1 起）：核准後續接的 `resume` 併回它接著的那一輪、不另外編號，與 #1028 的用量折疊同一套（兩個分頁的輪才對得上）。
   * 投影的 `index` 把每顆 `turn/start` 都算進去、含 `resume`，所以不能直接拿來當編號。`omitted` 裡看不到的輪當成都是邏輯輪，
   * 超過窗口與摘要（約 200 輪）的長會話裡，編號可能比實際大一點（被省略的續接輪無從得知）。
   */
  readonly number: number;
  readonly kind: TrajectoryTurnKind;
  readonly time: number;
  readonly end?: TrajectoryEnd;
  /**
   * `end` 是 `failed` 時，日誌帶了哪一類失敗碼（`TrajectoryDigest.failureCode`，#1121）。**缺席就是「沒記」**（舊日誌的 `turn/failed`
   * 沒有 `error`），標頭只寫「失敗」，不補成「原因不明」。
   */
  readonly failureCode?: string;
  /** `end` 是 `aborted` 時為什麼停（`TrajectoryDigest.endCause`，#1847）。**缺席就是「沒記」**，標頭只寫「已停止」，不猜原因。 */
  readonly endCause?: TurnStopCause;
  /** 這一輪（含併進來的續接）收尾的時刻；還沒結束沒有。 */
  readonly endTime?: number;
  /** 牆鐘：第一顆 `turn/start` 到最後收尾，**含停在核准點等人的時間**（同 #1028）。 */
  readonly durationMs?: number;
  readonly callCount: number;
  readonly toolCount: number;
  readonly toolErrors: number;
  /** 這一輪（含併進來的續接）派出幾個子代理。 */
  readonly subagentCount: number;
  readonly retryCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * 快取分桶的加總（#724），規則同 `TrajectoryDigest`：缺席＝沒記。**併續接時兩段都有才相加**，只一段有的數字當成總數，
   * 命中率的分母會是錯的。
   */
  readonly uncachedInputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  /** 單輪上限摺掉的呼叫與工具數；沒摺過沒有這兩格。計數仍含它們。 */
  readonly elidedCalls?: number;
  readonly elidedTools?: number;
  /**
   * 這一輪現在停在等人：掛著核准（`approval`）或問答（`question`）。**只有最後一組、而且收尾還是 `completed`（或還沒收）時才有。**
   * 停在中斷點的那個實體輪，日誌上是照常 `turn/end`（`completed`）收的，標頭照著寫「完成」、聊天區卻寫「等待核准」（成本分頁的用量投影早有 `paused` 這一格，寫「停在核准點」），
   * 讀的人會以為這一輪做完了。續接之後核准有了結局、併回同一組，這一格就沒了，標頭照常。
   */
  readonly waiting?: 'approval' | 'question';
}

/** 窗口外那些輪只剩的一行摘要。 */
export interface TraceDigest extends TurnHead {
  readonly key: string;
  /** 開這一輪的 `turn/start` 的 `seq`（`resume` 併進來之後仍是第一段的）；成本分頁的「看這一輪」靠它找。 */
  readonly seq: number;
}

export interface TraceTurn {
  /** 這一輪第一列的 key，換對話狀態時穩定。 */
  readonly key: string;
  readonly rows: readonly TraceRow[];
  /** 結構化模式裡投影認得的輪才有；沒有結構資料的組（窗口之前、投影還沒跟上的最新條目）沒有。 */
  readonly head?: TurnHead;
  /** 這一組是以人那一句切的（第 0 版的做法），不是投影的輪界。 */
  readonly legacy: boolean;
  /** 開這一輪的 `turn/start` 的 `seq`（等於 `TokenMeterTurn.seq`）；沒有結構資料的組沒有。 */
  readonly seq?: number;
  /**
   * 這一組只有摘要的計數、沒有逐呼叫的結構：它前面有一輪的細節被拉了回來，時間順序要接得上，所以這一輪補成一組放在原位
   * （按需拉的細節見 `features/trace/trajectory-pull.ts`）。畫面在這一組放「載入這一輪的細節」。
   */
  readonly summaryOnly?: true;
}

export interface TraceModel {
  /** 有沒有用上軌跡投影。 */
  readonly structured: boolean;
  readonly turns: readonly TraceTurn[];
  /** 窗口外的輪，舊的在前；只剩計數。 */
  readonly digests: readonly TraceDigest[];
  /** 比 `digests` 更早、連摘要都沒留下的輪數。 */
  readonly omitted: number;
}
