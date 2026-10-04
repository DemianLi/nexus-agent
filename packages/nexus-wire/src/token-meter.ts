/**
 * 用量投影（[#1028](https://github.com/DemianLi/nexus-agent/issues/1028)，地圖 [#1015](https://github.com/DemianLi/nexus-agent/issues/1015)）
 * 在線上的形狀：`@nexus/plugin-token-meter` 從會話日誌折出來、由 {@link ./projection.ts | `projection` frame} 整份送到 web 的值。
 *
 * 型別住在這裡的理由同 `trajectory.ts`：讀它的是 `apps/web`，web 只依賴 `@nexus/wire`。
 *
 * ## 一份日誌一份 view
 *
 * 單元宣告了 `children: true`（#1073），所以**同一個單元對 root 與每個子代理各折一份**：
 *
 * - root 的值在 `ConversationState.projections['token-meter']`，
 * - 每個子代理的值在 `ConversationState.subagentProjections[runId]['token-meter']`。
 *
 * 兩邊**同一個形狀**。前景子代理的日誌沒有 `turn/start`，所以它的 `turns` 是空的、數字全在 `outside`；背景的有（派出去那句開一輪），照一般的輪折。
 * 哪個 `runId` 是哪一顆呼叫派的、前景還是背景，讀 root 那份的 {@link TokenMeterView.links}。
 *
 * ## 數字的口徑（讀的人必須看得到，否則會把下限當成總數）
 *
 * 口徑寫在 {@link TOKEN_METER_CALIBER}，**每個欄位一句**，不隨 frame 重送。要點：
 *
 * - **token 是供應商報的**：成功與失敗的呼叫都算（失敗那幾筆另列），**沒報的呼叫不是 0**——數在 {@link TokenMeterSpan.unknownSteps}。
 * - **生摘要那一次的用量另列**（`summary*`），**不含在** `inputTokens`／`outputTokens` 裡，也不進 root 的 `tokenUsage` 總帳。
 * - **時間三段加一格殘差**：模型（扣掉重試退避）、工具（平行的取聯集）、等待（停在核准點的時間），其餘是 `unaccountedMs`。
 * - **token 跨會話可以相加，時間不行**：前景子代理跑的時間已經在 root 那顆工具呼叫的耗時裡。
 * - **不畫金額、不畫完成率**（#1019）。快取讀寫與推理 token 細項等 #724。
 *
 * ## 窗口
 *
 * frame 是整份取代、每顆讓值改變的事件都重送，所以 view 不能隨會話無限長：最近 {@link TOKEN_METER_TURNS_KEEP} 輪帶逐輪的列，
 * 更早的輪併成一列 {@link TokenMeterView.earlier}。依工具名、依模型的分佈各有上限，超過的併進 `other`（總數仍是準的）。
 *
 * @module
 */

/** 用量投影的 key（`projection` frame 的 `key`）。 */
export const TOKEN_METER_PROJECTION = 'token-meter';

/** `token-meter` 的 `stateVersion`：折疊語意或 view 形狀一變就升。 */
export const TOKEN_METER_VERSION = 1;

/** 帶逐輪列的最近幾輪；更早的併進 `earlier`。 */
export const TOKEN_METER_TURNS_KEEP = 20;
/** 一個 {@link TokenMeterSpan} 的依工具名分佈最多幾個名字；超過的併進 `toolsOther`。 */
export const TOKEN_METER_TOOL_NAMES_CAP = 12;
/** 一個 {@link TokenMeterSpan} 的依模型分佈最多幾個模型；超過的併進 `modelsOther`。 */
export const TOKEN_METER_MODELS_CAP = 6;
/** root 的 `links` 最多留幾筆（最新的）；更早的記進 `linksOmitted`。 */
export const TOKEN_METER_LINKS_CAP = 64;

/** 依工具名的一列。 */
export interface TokenMeterToolRow {
  readonly name: string;
  /** 落定了的呼叫（有 `tool/result`）。 */
  readonly calls: number;
  /** 其中 `isError` 的。 */
  readonly errors: number;
}

/** 依模型的一列。 */
export interface TokenMeterModelRow {
  /** 模型 id，讀自 `request/header`（#1020）；日誌上沒有快照（舊日誌）就是 `null`，不猜。 */
  readonly model: string | null;
  /** 結束了的呼叫（完成、失敗、中止都算）。 */
  readonly steps: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** 依工具名超過名額、被併起來的那幾種工具。 */
export interface TokenMeterToolsOther {
  readonly calls: number;
  readonly errors: number;
}

/** 依模型超過名額、被併起來的那幾個模型。 */
export interface TokenMeterModelsOther {
  readonly steps: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * 一段事件的數字。**同一個形狀用在三處**：整份日誌（`session`）、輪外（`outside`）、一輪（{@link TokenMeterTurn}）。
 * 每一格在第一個有貢獻的事件之前都是 0。口徑見 {@link TOKEN_METER_CALIBER}。
 */
export interface TokenMeterSpan {
  /** 結束了的模型呼叫（`model/end`），完成、失敗、中止都算。 */
  readonly steps: number;
  /** 其中帶 `outcome` 的（沒有正常回來）。 */
  readonly failedSteps: number;
  /** 其中沒有任何 `model/usage` 的——燒了多少不知道，**不是 0**。 */
  readonly unknownSteps: number;
  /** 供應商報的輸入 token 加總，成功＋失敗，**含快取讀取**，不含生摘要那一次。 */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** {@link inputTokens} 裡，失敗或中止的呼叫報的那一份。 */
  readonly failedInputTokens: number;
  readonly failedOutputTokens: number;
  /** 生摘要的次數（`compaction/summary`）。 */
  readonly summaries: number;
  /** 其中沒報用量的。 */
  readonly summariesUnknown: number;
  /** 生摘要那一次報的用量加總，**另列**，不在 {@link inputTokens} 裡。 */
  readonly summaryInputTokens: number;
  readonly summaryOutputTokens: number;
  /** 重試的次數（`llm/retry-started`）與實際等了多久的加總。 */
  readonly retries: number;
  readonly retryWaitMs: number;
  /** 模型呼叫的牆鐘，**扣掉重試退避**。 */
  readonly modelMs: number;
  /** 落定的工具呼叫數與其中 `isError` 的。 */
  readonly toolCalls: number;
  readonly toolErrors: number;
  /** 每個工具各自的牆鐘加總（平行的重疊會重複算），同 `sessionStats.toolMs`。 */
  readonly toolSumMs: number;
  /** 至少有一個工具在跑的牆鐘（區間聯集）。三段時間用這個。 */
  readonly toolMs: number;
  /** 停在核准點的時間：一輪的 `turn/end` 到接著它的 `resume` 的 `turn/start`。 */
  readonly waitMs: number;
  /** 依工具名。一輪裡照第一次出現的順序；會話總計是併起來的，列序不保證。 */
  readonly tools: readonly TokenMeterToolRow[];
  readonly toolsOther?: TokenMeterToolsOther;
  /** 依模型。列序同上。 */
  readonly models: readonly TokenMeterModelRow[];
  readonly modelsOther?: TokenMeterModelsOther;
}

/** 一輪是怎麼結束的；還沒結束就沒有這一格。`paused` ＝ 停在核准點、還沒等到 resume。 */
export type TokenMeterEnd =
  'completed' | 'aborted' | 'max-tokens' | 'interrupted' | 'failed' | 'paused';

/** 一個邏輯輪（`resume` 併回前一輪）。 */
export interface TokenMeterTurn extends TokenMeterSpan {
  /** 第幾個邏輯輪（0 起，整份日誌連續）。 */
  readonly index: number;
  /** 開這一輪的 `turn/start` 的 `seq` 與時刻。 */
  readonly seq: number;
  readonly time: number;
  readonly kind: string;
  readonly end?: TokenMeterEnd;
  /** 最後一顆 `turn/end`／`turn/failed` 的時刻。 */
  readonly endTime?: number;
  /** `endTime − time`：含停在核准點等的那段。 */
  readonly wallMs?: number;
  /**
   * `wallMs − modelMs − toolMs − waitMs`：三段都沒覆蓋到的時間（圖的啟動、生摘要那一次、事件之間的空隙）。
   * **不夾 0**：負的代表「三段互不重疊」這個前提被破壞了，那是要追的 bug，不是要藏的。
   */
  readonly unaccountedMs?: number;
}

/** root 的 `subagent/catalog` 解出來的連結：哪個 `runId` 是哪一顆呼叫派的。 */
export interface TokenMeterLink {
  /** 子代理的 `runId`，也是 `subagentProjections` 的鍵。 */
  readonly runId: string;
  /** 派它的那顆 `tool/call` 的 `callId`。 */
  readonly callId: string;
  /** `one-shot` ＝ 前景跑完就結束，`continuable` ＝ 背景收得到後續的話。 */
  readonly mode: 'one-shot' | 'continuable';
  /** 派它的時候在哪個邏輯輪（{@link TokenMeterTurn.index}）；不在任何輪裡就沒有。 */
  readonly turn?: number;
}

/** 窗口之外、併成一列的輪。 */
export interface TokenMeterEarlier extends TokenMeterSpan {
  /** 併了幾個邏輯輪。 */
  readonly turns: number;
}

/** `token-meter` 投影的 view。 */
export interface TokenMeterView {
  /** 這份日誌全部的數字：`outside` ＋ `earlier` ＋ `turns` 每一列。 */
  readonly session: TokenMeterSpan;
  /** 不在任何輪裡的事件（前景子代理那份全在這裡）。 */
  readonly outside: TokenMeterSpan;
  /** 最近的邏輯輪，由舊到新。 */
  readonly turns: readonly TokenMeterTurn[];
  /** 更早的邏輯輪併成一列；沒有就缺席。 */
  readonly earlier?: TokenMeterEarlier;
  /** 到目前為止開過幾個邏輯輪。 */
  readonly totalTurns: number;
  /** 派過的子代理，由舊到新（只有 root 那份有）。 */
  readonly links: readonly TokenMeterLink[];
  readonly linksOmitted: number;
}

/**
 * 每個 {@link TokenMeterSpan} 欄位的口徑，一句話。**給畫面當說明用**，不隨 frame 重送。
 * 「每個數字附口徑」的承諾落在這張表：讀的人看得到哪些沒算進去。
 */
export const TOKEN_METER_CALIBER: Readonly<Record<string, string>> = {
  steps:
    '結束了的模型呼叫，完成、失敗、中止都算；重試掉的中間幾次不算（重試在記錄器底下，只有最後一次的起訖）。',
  failedSteps: '沒有正常回來的呼叫（拋錯或使用者按了停止）。',
  unknownSteps: '有結束但供應商沒報用量的呼叫：燒了多少不知道，不是 0，所以 token 是下限。',
  inputTokens:
    '供應商報的輸入 token，含快取讀取；成功與失敗的呼叫都算；不含生摘要那一次；沒報的呼叫不在裡面。',
  outputTokens:
    '供應商報的輸出 token；成功與失敗的呼叫都算；不含生摘要那一次；沒報的呼叫不在裡面。',
  failedInputTokens: '上面輸入 token 裡，失敗或中止的呼叫報的那一份（已含在上面）。',
  failedOutputTokens: '上面輸出 token 裡，失敗或中止的呼叫報的那一份（已含在上面）。',
  summaries: '壓縮上下文時生摘要的次數。',
  summariesUnknown: '生摘要時供應商沒報用量的次數。',
  summaryInputTokens:
    '生摘要那一次報的輸入 token，另列，不在輸入 token 裡、也不進 root 的 token 總帳。',
  summaryOutputTokens: '生摘要那一次報的輸出 token，另列，同上。',
  retries: '模型呼叫的重試次數。',
  retryWaitMs: '重試實際等的退避時間，包在該次模型呼叫的起訖之內，所以從模型時間扣掉。',
  modelMs:
    '模型呼叫的牆鐘（含失敗與中止的），扣掉重試退避。逐輪加總會小於會話總計的 llmMs，差的正是退避。',
  toolCalls: '落定的工具呼叫（有結果的）；核准被拒的也有結果；停在核准點、沒跑的那一次不算。',
  toolErrors: '落定的工具呼叫裡 isError 的。',
  toolSumMs: '每個工具各自的牆鐘加總，平行的重疊會重複算（同會話統計的工具耗時）。',
  toolMs: '至少有一個工具在跑的牆鐘（區間聯集）。前景子代理跑的時間已經在派它的那顆工具裡。',
  waitMs: '停在核准點的時間：一輪的收尾到接著它的 resume 開始；人離開、行程重啟的時間也在裡面。',
  unaccountedMs: '一輪牆鐘扣掉模型、工具、等待之後剩的：圖的啟動、生摘要那一次、事件之間的空隙。',
};
