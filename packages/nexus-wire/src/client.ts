/**
 * 瀏覽器那一端的線。
 *
 * 只用 `fetch`，所以它是同構的：`apps/web` 用它連 harness，測試用它連一個
 * 記憶體裡的 handler，兩邊跑的是同一條路徑（對應 dsh 的 `InProcessApiClient`
 * ——「跑完整的協定序列化與校驗路徑而不經過網路」）。
 *
 * **上行只走 HTTP POST，下行只讀不寫。** 下行單向是協定不變量，不是實作細節：
 * dsh 的 `websocket-downlink.ts` 明文「Client messages are a protocol violation:
 * upstream traffic remains on HTTP.」
 */

import { UPLOAD_NAME_PARAM, attachmentPath, uploadPath } from './attachments.js';
import type {
  AttachmentReadResponse,
  AttachmentReadResult,
  PromptAttachment,
  UploadReceipt,
  UploadResponse,
} from './attachments.js';
import type {
  ModelCatalogCommand,
  ModelCatalogResult,
  ModelCommand,
  ModelSelectCommand,
  ModelSelectResult,
  ModelSelection,
} from './model-selection.js';
import type {
  PermissionCatalogCommand,
  PermissionCatalogResult,
  PermissionCommand,
} from './permission-presets.js';
import type {
  ThreadArchiveCommand,
  ThreadArchiveResult,
  ThreadManagementCommand,
  ThreadPinCommand,
  ThreadPinResult,
  ThreadRenameCommand,
  ThreadRenameResult,
  ThreadUnarchiveCommand,
  ThreadUnarchiveResult,
  ThreadUnpinCommand,
  ThreadUnpinResult,
} from './thread-management.js';
import type { SubagentListCommand, SubagentListResult, SubagentMention } from './subagent-list.js';
import type { TrajectoryTurnDetail, TrajectoryTurnQuery } from './trajectory.js';
import type {
  FileReferenceCandidate,
  FileReferenceListResponse,
  FileReferenceListResult,
} from './file-references.js';
import { fileReferencesPath } from './file-references.js';
import { sessionReferencesPath } from './session-references.js';
import type {
  SessionReferenceCandidate,
  SessionReferenceListResponse,
  SessionReferenceListResult,
} from './session-references.js';
import { decodeSseData, decodeSseStream } from './sse.js';
import type {
  Command,
  CommandResponse,
  Event,
  FeedbackCommand,
  FeedbackDeleteCommand,
  FeedbackDeleteResult,
  FeedbackListResult,
  FeedbackPutCommand,
  FeedbackPutResult,
  FeedbackRecordCommand,
  FeedbackRecordResult,
  InputRespondOne,
  QueueSteerAction,
  QueueUpdateAction,
  QueueUpdateCommand,
  RpcMethod,
  RunCancelCommand,
  SubagentInterruptCommand,
  SubagentSendCommand,
  RunStartCommand,
  RunStartMode,
  SlashCommand,
  SlashDescriptor,
  SlashRunResult,
  ThreadFeedFrame,
  ThreadHistoryQuery,
  ThreadHistoryResponse,
  TrajectoryTurnResponse,
  ThreadHistoryResult,
  ThreadListResponse,
  ThreadListResult,
  ThreadSearchItem,
  ThreadSearchResponse,
  ThreadSearchResult,
  ThreadSummary,
  WireChannel,
  WireErrorResponse,
} from './protocol.js';
import {
  QUEUE_UPDATE_METHOD,
  RUN_CANCEL_METHOD,
  SUBAGENT_INTERRUPT_METHOD,
  SUBAGENT_SEND_METHOD,
  THREAD_FEED_PATH,
  THREAD_SEARCH_PATH,
  THREADS_PATH,
  WIRE_CHANNELS,
  commandPath,
  historyPath,
  subagentHistoryPath,
  trajectoryTurnPath,
  isThreadFeedFrame,
  streamPath,
} from './protocol.js';

export interface WireClientOptions {
  /** harness 的來源，例如 `http://localhost:8787`。結尾的斜線會被去掉。 */
  readonly baseUrl: string;
  /** 注入用；預設是全域的 `fetch`。 */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * 上傳要取進度時用的 `XMLHttpRequest` 工廠（[#732](https://github.com/DemianLi/nexus-agent/issues/732)），注入用。
   * 預設：沒注入 {@link fetch} 又有全域 `XMLHttpRequest` 時用它（瀏覽器）；否則上傳走 `fetch`、只在送完時報一次進度。
   * `fetch` 拿不到上傳進度，這是瀏覽器的限制，dsh 的 `file-upload` 同樣用 XHR（`client/runtime.ts`）。
   */
  readonly createXhr?: () => UploadXhr;
}

/** 上傳進度：已送出的位元組與總量。`total` 在不知道長度時缺席。 */
export interface UploadProgress {
  readonly loaded: number;
  readonly total?: number;
}

/** XHR 進度事件裡我們用到的欄位（wire 套件沒有 DOM 型別庫，真的 `ProgressEvent` 滿足它）。 */
export interface UploadProgressEvent {
  readonly loaded: number;
  readonly total: number;
  readonly lengthComputable: boolean;
}

/**
 * 事件處理函式的型別。**用方法簽名取出來是刻意的**：方法參數是雙變的，真的 `XMLHttpRequest` 的處理函式收的是完整
 * `ProgressEvent`，用屬性函式型別寫會因為參數逆變而不收它。
 */
type UploadHandler<E> = { handler(event: E): void }['handler'];

/** {@link WireClientOptions.createXhr} 要的那一小塊 `XMLHttpRequest`；真的 `XMLHttpRequest` 滿足它。 */
export interface UploadXhr {
  readonly upload: { onprogress: UploadHandler<UploadProgressEvent> | null };
  readonly status: number;
  readonly responseText: string;
  onload: UploadHandler<unknown> | null;
  onerror: UploadHandler<unknown> | null;
  onabort: UploadHandler<unknown> | null;
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: Blob): void;
  abort(): void;
}

export interface OpenEventsOptions {
  /** 預設訂全部放行的 channel，見 `WIRE_CHANNELS`。 */
  readonly channels?: readonly WireChannel[];
  /**
   * 中止這條下行。
   *
   * **中止的是這條線，不是 agent。** server 端不會因為瀏覽器斷線就停掉 run；
   * 接回來的方式是重開一條（reopen），不是續傳——`since` 這一版明確不支援，
   * server 收到會回 `not_supported` 而不是靜靜忽略。
   */
  readonly signal?: AbortSignal;
}

/**
 * 上行 RPC 的回應。**收件回條，不是命令的執行結果。**
 *
 * 名字從 `CommandResult` 改成這個，是因為
 * [#118](https://github.com/DemianLi/nexus-agent/issues/118) 引進了**人打的斜線命令**，
 * 而 dsh 那一側的結果型別就叫 `CommandResult`。`Command` 在這個檔案裡是
 * **agent-protocol 自己的字**（見 `commandPath` 的說明），那個不動；但這個別名是我們
 * 自己取的，讓路給同名而語意不同的那一個。
 */
export type UplinkResult = CommandResponse | WireErrorResponse;

/**
 * `slash.list` 的結果。
 *
 * **`rejected` 與命令自己的失敗是兩件事**，所以它們在型別上分得開：`rejected` 是
 * 這條線拒絕發派（`message`），命令自己失敗是 {@link SlashRunOutcome} 的
 * `kind: 'error'`（`text`）。鍵名不同不是巧合——混起來的那一刻，「這條 thread 正在跑」
 * 就會被顯示成「這個命令壞了」。
 */
export type SlashListOutcome =
  | { readonly kind: 'ok'; readonly commands: readonly SlashDescriptor[] }
  | { readonly kind: 'rejected'; readonly code?: string; readonly message: string };

/** `slash.run` 的結果：三個命令自己的值，加上這條線拒絕發派的那一個。 */
export type SlashRunOutcome =
  SlashRunResult | { readonly kind: 'rejected'; readonly code?: string; readonly message: string };

/**
 * 回饋三個 method 的結果。**`rejected` 與業務失敗是兩件事**，理由同 {@link SlashListOutcome}：
 * `rejected` 是這條線收不了（這個組裝沒掛回饋、封包壞了），業務失敗在 `result` 裡
 * （`{ ok: false, error: { code } }`）。
 */
export type FeedbackOutcome<T> = CommandOutcome<T>;

/**
 * 回 `{ ok, … }` 這一類結果的命令（回饋、模型選擇、權限目錄）的結果。`rejected` 是這條線收不了——**含 `not_supported`**：
 * 這台 server 還沒實作那一支，web 據這個碼把功能藏起來；業務失敗在 `result` 裡（`{ ok: false, error }`）。
 */
export type CommandOutcome<T> =
  | { readonly kind: 'ok'; readonly result: T }
  | { readonly kind: 'rejected'; readonly code?: string; readonly message: string };

/** `uploadFile` 的結果。`rejected` 是這條線收不了（含 `not_supported`：這個組裝沒有附件儲存），見 `attachments.ts`。 */
export type UploadOutcome =
  | { readonly kind: 'ok'; readonly receipt: UploadReceipt }
  | { readonly kind: 'rejected'; readonly code?: string; readonly message: string };

/** `readAttachment` 的結果。`rejected` 的 `code` 是 `attachment_not_found`（日誌沒引用過）或 `not_supported`（沒有附件儲存）。 */
export type AttachmentReadOutcome =
  | { readonly kind: 'ok'; readonly result: AttachmentReadResult }
  | { readonly kind: 'rejected'; readonly code?: string; readonly message: string };

/**
 * `GET /threads` 的結果。`rejected` 是這台 server 列不了（例如組裝時沒接落盤），**不是空清單**，
 * 理由見 {@link ThreadListResponse}。
 */
export type ThreadListOutcome =
  | { readonly kind: 'ok'; readonly result: ThreadListResult }
  | { readonly kind: 'rejected'; readonly code?: string; readonly message: string };

/** `searchThreads` 的結果。`rejected` 是協定層的失敗（這個部署沒開、查詢不合法、索引壞了），見 `THREAD_SEARCH_PATH`。 */
export type ThreadSearchOutcome =
  | { readonly kind: 'ok'; readonly result: ThreadSearchResult }
  | { readonly kind: 'rejected'; readonly code?: string; readonly message: string };

export interface WireClient {
  /**
   * 開一條長期下行。它跨 run 存活：核准前後是同一條線。
   *
   * **promise 兌現代表線已經開好**（server 端的訂閱已註冊），之後才發生的 frame
   * 一顆都不會掉在中間。所以正確的順序是：先 `await openEvents`，再 `runStart`。
   */
  openEvents(
    threadId: string,
    options?: OpenEventsOptions,
  ): Promise<AsyncGenerator<Event, void, undefined>>;
  /**
   * 送一句話進去。回應只是收件回條，不等這一輪跑完。
   *
   * `options.mode` 見 {@link RunStartMode}：省略就是排隊；`steer` 是插話（[#710](https://github.com/DemianLi/nexus-agent/issues/710)），
   * 跑著的這一輪下一步就送進模型。
   */
  runStart(
    threadId: string,
    text: string,
    options?: {
      readonly mode?: RunStartMode;
      /** 這句話帶的附件（[#732](https://github.com/DemianLi/nexus-agent/issues/732)）：先上傳的檔案收據與內嵌的圖，順序就是選取的順序。 */
      readonly attachments?: readonly PromptAttachment[];
      /** 這句話點名派哪一種子代理（[#328](https://github.com/DemianLi/nexus-agent/issues/328)，形狀見 `subagent-list.ts`）。 */
      readonly mention?: SubagentMention;
    },
  ): Promise<UplinkResult>;
  /**
   * 回答**一顆**核准請求。
   *
   * 同一顆中斷的多筆決定要一次送（見開發計劃 Phase 5 的全有全無那條），但**界線就在
   * 中斷上**：同一輪的其他中斷各答各的，`interrupt_id` 是那道界線，伺服器據它逐 task
   * 派送（[#232](https://github.com/DemianLi/nexus-agent/issues/232)）。
   */
  inputRespond(
    threadId: string,
    params: Pick<InputRespondOne, 'namespace' | 'interrupt_id' | 'response'>,
  ): Promise<UplinkResult>;
  /**
   * 中止這一輪（`run.cancel`，[#276](https://github.com/DemianLi/nexus-agent/issues/276)）。
   *
   * **回的是受理回條，不等停穩**——停下來的事實走下行（root 那顆收尾的 `lifecycle` 帶
   * `aborted: true`）。沒有 run 在跑、也沒有等核准時，server 照樣受理、什麼都不做。
   */
  runCancel(threadId: string): Promise<UplinkResult>;
  /**
   * 改或刪送出佇列裡排著的一件（`queue.update`，[#637](https://github.com/DemianLi/nexus-agent/issues/637)）。
   *
   * **回的是受理回條**——佇列變成什麼樣走下行的 `inbox` 推送。那一件已經開跑、被刪了（可能是別的分頁）或從沒有過，
   * 回 `queue_item_not_found`；改成空白回 `invalid_argument`。
   *
   * **也收改成插話**（`protocol.ts` 的 `QueueSteerAction`，#710）：`action` 是改、刪、插話三選一。web 的測試替身已在 #778 一併加寬。
   */
  queueUpdate(
    threadId: string,
    params: { readonly item_id: string; readonly action: QueueUpdateAction | QueueSteerAction },
  ): Promise<UplinkResult>;
  /**
   * 人對單一背景子代理說一句話（`subagent.send`，[#865](https://github.com/DemianLi/nexus-agent/issues/865)）。
   * 語意與錯誤碼見 `SUBAGENT_SEND_METHOD`。受理就回（成功是 `{ accepted: true }`），不等那一輪跑完。
   */
  subagentSend(threadId: string, runId: string, text: string): Promise<UplinkResult>;
  /** 只停單一背景子代理當下那一輪（`subagent.interrupt`）。不認得的編號是被接受的 no-op。 */
  subagentInterrupt(threadId: string, runId: string): Promise<UplinkResult>;
  /** 評一則回覆（`feedback.put`，[#278](https://github.com/DemianLi/nexus-agent/issues/278)）。 */
  feedbackPut(
    threadId: string,
    params: FeedbackPutCommand['params'],
  ): Promise<FeedbackOutcome<FeedbackPutResult>>;
  /** 收回一則回覆的評分（`feedback.delete`）。 */
  feedbackDelete(
    threadId: string,
    params: FeedbackDeleteCommand['params'],
  ): Promise<FeedbackOutcome<FeedbackDeleteResult>>;
  /**
   * 讀型錄與這條 thread 目前的模型選擇（`model.catalog`，[#723](https://github.com/DemianLi/nexus-agent/issues/723)）。
   * 契約見 `model-selection.ts`。**還沒實作的 server 回 `rejected`，`code` 是 `not_supported`**——web 據此藏起模型座。
   */
  modelCatalog(threadId: string): Promise<CommandOutcome<ModelCatalogResult>>;
  /**
   * 列這個組裝可以點名派的子代理種類（`subagent.list`，[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 2 項）。
   * 契約見 `subagent-list.ts`。**沒有清單的組裝（手搭的）回 `rejected`，`code` 是 `not_supported`**——web 據此藏起 `@` 子代理的入口。
   */
  subagentList(threadId: string): Promise<CommandOutcome<SubagentListResult>>;
  /**
   * 選模型與推理強度（`model.select`）。從下一步生效，跑著的那步不換。型錄沒有那顆或強度沒宣告：`result` 是
   * `{ ok: false, error: { code: 'model_unavailable' } }`，選擇不變。
   */
  selectModel(
    threadId: string,
    selection: ModelSelection,
  ): Promise<CommandOutcome<ModelSelectResult>>;
  /**
   * 讀權限組合的目錄（`permission.catalog`，[#437](https://github.com/DemianLi/nexus-agent/issues/437)）。契約見
   * `permission-presets.ts`。切換不在這裡：送 `/permission <組名>` 那一行斜線命令。`rejected` 的 `code` 是 `not_supported`
   * 就藏起選單。
   */
  permissionCatalog(threadId: string): Promise<CommandOutcome<PermissionCatalogResult>>;
  /**
   * 釘選這條 thread（`thread.pin`，[#633](https://github.com/DemianLi/nexus-agent/issues/633)）。契約見 `thread-management.ts`：
   * 回**整個釘選集合**（最近釘的在前），封存的不能釘（`thread_archived`）。`rejected` 的 `code` 是 `not_supported` 就藏起這個動作。
   */
  threadPin(threadId: string): Promise<CommandOutcome<ThreadPinResult>>;
  /** 取消釘選（`thread.unpin`）。冪等，不會失敗；回整個釘選集合。 */
  threadUnpin(threadId: string): Promise<CommandOutcome<ThreadUnpinResult>>;
  /**
   * 封存這條 thread（`thread.archive`）。還在跑而沒帶 `stopActivity` 回 `thread_active`；帶了就先停掉它的工作。回整個封存集合。
   */
  threadArchive(
    threadId: string,
    options?: { readonly stopActivity?: boolean },
  ): Promise<CommandOutcome<ThreadArchiveResult>>;
  /** 取消封存（`thread.unarchive`）。冪等，不會失敗；回整個封存集合。 */
  threadUnarchive(threadId: string): Promise<CommandOutcome<ThreadUnarchiveResult>>;
  /** 改這條 thread 的標題（`thread.rename`）。回受理後的標題與事件 `seq`；標題不合法回 `title_invalid`，標題不變。 */
  threadRename(threadId: string, title: string): Promise<CommandOutcome<ThreadRenameResult>>;
  /**
   * 上傳一個檔案，換一張收據（[#732](https://github.com/DemianLi/nexus-agent/issues/732)）。契約見 `attachments.ts`：收據只在這條
   * thread 有效，送訊息時放進 `run.start` 的 `attachments`。**排在 {@link openEvents} 兌現之後**（這條 thread 會為它建起來）。
   *
   * 簽名照 dsh `file-upload` 的 `upload(sessionId, body, name, signal, onProgress)`（`client/contract.ts`）。
   *
   * @param body - 檔案的位元組。
   * @param name - 顯示用的檔名；省略由 server 取預設。
   * @param signal - 中止這一次：Promise 以 `signal.reason`（`AbortError`）拒絕，server 端收到的是斷線、什麼都不留。
   * @param onProgress - 進度觀察者。**`loaded` 單調不減；`total` 只在知道長度時才有**——`Blob` 在有 `XMLHttpRequest` 的瀏覽器
   *   由 `lengthComputable` 決定，沒有 XHR（Node、注入了 `fetch`）時只在送完那一刻報一次，且 `loaded === total`。
   */
  uploadFile(
    threadId: string,
    body: Blob | Uint8Array,
    name?: string,
    signal?: AbortSignal,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<UploadOutcome>;
  /** 讀回這條 thread 目前的評分（`feedback.list`，[#382](https://github.com/DemianLi/nexus-agent/issues/382)）。 */
  feedbackList(threadId: string): Promise<FeedbackOutcome<FeedbackListResult>>;
  /** 記一則對整個會話的評語（`feedback.record`）——回饋對話框只打 `/feedback` 時送這個。 */
  feedbackRecord(
    threadId: string,
    params: FeedbackRecordCommand['params'],
  ): Promise<FeedbackOutcome<FeedbackRecordResult>>;
  /**
   * 這條 thread 上打得出哪些斜線命令。**拿來顯示，不做選單**——
   * dsh 那一套 `CommandDirectory`（epoch guard、single-flight、`ensureReady`）是另一張卡。
   */
  slashList(threadId: string): Promise<SlashListOutcome>;
  /**
   * 打一行斜線命令。**回的是命令的執行結果，不是收件回條**——命令不進模型，
   * 所以它沒有「之後走下行」的那一半。
   *
   * @param line - 完整的候選行，**原文原樣**。
   * @param attachments - 這一行帶的附件（[#732](https://github.com/DemianLi/nexus-agent/issues/732)，同 `runStart` 的 `attachments`）。
   *   只有 descriptor 上 `input.attachments` 為真的命令收；省略或空陣列＝不帶。
   */
  slashRun(
    threadId: string,
    line: string,
    attachments?: readonly PromptAttachment[],
  ): Promise<SlashRunOutcome>;
  /**
   * 這台 server 以前的 thread（[#302](https://github.com/DemianLi/nexus-agent/issues/302)）。**不綁 thread**，
   * 也不替任何一條 thread 建 agent——server 那側照 dsh 的 `session/list` 是冷讀。
   */
  listThreads(): Promise<ThreadListOutcome>;
  /**
   * 按內容搜以前的 thread（[#631](https://github.com/DemianLi/nexus-agent/issues/631)），契約見 `THREAD_SEARCH_PATH`。
   * 跟 {@link listThreads} 一樣冷讀、不綁 thread。**這個部署沒開內容搜尋時是 `rejected`，不是空的**：畫面要退回只比標題。
   *
   * @param query - 原樣送出；去頭尾空白與檢查長度在 server 那側。
   * @param signal - 中止這一次搜尋。
   */
  searchThreads(query: string, signal?: AbortSignal): Promise<ThreadSearchOutcome>;
  /**
   * 開全部 thread 共用的那條下行（[#632](https://github.com/DemianLi/nexus-agent/issues/632)），契約見
   * `THREAD_FEED_PATH`。**promise 兌現代表線已經開好**，同 {@link openEvents}；還掛著的那幾題緊接著補送。
   *
   * **兌現之後再抓一次 {@link listThreads}** 當「在跑」的起點：狀態切換不補送。不認得的 frame 在這裡就丟掉。
   *
   * @param signal - 中止這條線，不是任何一條 thread 的 run。
   */
  openThreadFeed(signal?: AbortSignal): Promise<AsyncGenerator<ThreadFeedFrame, void, undefined>>;
  /**
   * 這條 thread 的一頁歷史（#306）。省略參數就是最後一頁；往前翻帶上一頁的 `firstSeq` 與第一頁的 `throughSeq`。
   *
   * **排在 {@link openEvents} 兌現之後**，照 dsh 的「先訂閱、再拿 snapshot」：反過來的話，兩者之間發生的事
   * 兩邊都沒有。這條 thread 會為它建起來（同開下行），跟列表的冷讀不同。
   */
  threadHistory(threadId: string, query?: ThreadHistoryQuery): Promise<ThreadHistoryOutcome>;
  /**
   * 背景子代理自己那份對話的一頁歷史（[#871](https://github.com/DemianLi/nexus-agent/issues/871)）。契約見
   * `subagentHistoryPath`：形狀、查詢同 {@link threadHistory}，折成**獨立的**對話，不折進主對話的。找不到是 `rejected`
   * （訊息說明原因；錯誤碼 `subagent_not_found` 這一版不往上帶，同 {@link threadHistory}）。
   */
  subagentHistory(
    threadId: string,
    runId: string,
    query?: ThreadHistoryQuery,
  ): Promise<ThreadHistoryOutcome>;
  /**
   * 軌跡某一個邏輯輪的細節（[#1083](https://github.com/DemianLi/nexus-agent/issues/1083)）。契約見 `trajectoryTurnPath`。
   * 失敗是 `rejected`，**帶錯誤碼與可直接顯示的中文原因**（`turn_not_found`／`subagent_not_found`／`invalid_argument`／`not_supported`）。
   * 允許並行請求；**排在 {@link openEvents} 兌現之後**，同 {@link threadHistory}（這條 thread 會為它建起來）。
   *
   * @param signal - 中止這一次。
   */
  trajectoryTurn(
    threadId: string,
    query: TrajectoryTurnQuery,
    signal?: AbortSignal,
  ): Promise<TrajectoryTurnOutcome>;
  /**
   * `@` 後面那一段的候選（[#651](https://github.com/DemianLi/nexus-agent/issues/651)）。契約見 `fileReferencesPath`。
   *
   * @param query - `@` 或 `@"` 後面那一段，原文原樣；開頭的 `/` 給不給都一樣。
   * @param signal - 中止這一次。**每打一個字就該取消上一次**：伺服器那側一個呼叫者取消不會殺掉共用的走訪。
   */
  fileReferences(
    threadId: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<FileReferenceListOutcome>;
  /**
   * `@` 後面那一段的會話候選（[#713](https://github.com/DemianLi/nexus-agent/issues/713)）。契約見 `sessionReferencesPath`。
   *
   * @param query - `@` 後面那一段，原文原樣。
   * @param signal - 中止這一次：每打一個字就該取消上一次。
   */
  sessionReferences(
    threadId: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<SessionReferenceListOutcome>;
  /**
   * 讀一張這條 thread 引用過的圖（[#733](https://github.com/DemianLi/nexus-agent/issues/733)）。契約見 `attachmentPath`。
   *
   * @param attachmentId - 參照上的 `attachmentId`（`sha256:<hex>`）。
   * @param signal - 中止這一次。
   */
  readAttachment(
    threadId: string,
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<AttachmentReadOutcome>;
}

/** 全域下行上認得的那幾顆；不認得的跳過（`THREAD_FEED_PATH`：那條線之後會多出新種類）。 */
async function* knownFeedFrames(
  frames: AsyncGenerator<unknown, void, undefined>,
): AsyncGenerator<ThreadFeedFrame, void, undefined> {
  for await (const frame of frames) {
    if (isThreadFeedFrame(frame)) yield frame;
  }
}

/** `GET /threads/:id/file-references` 的結果。`rejected` 是這條 thread 起不來、或索引建不起來。 */
export type FileReferenceListOutcome =
  | { readonly kind: 'ok'; readonly result: FileReferenceListResult }
  | { readonly kind: 'rejected'; readonly code?: string; readonly message: string };

/** 線上回來的候選得先驗過，理由同 {@link readDescriptors}。 */
function readFileReferences(result: unknown): FileReferenceListResult {
  const { available, candidates } = result as { available?: unknown; candidates?: unknown };
  if (available === false) return { available: false };
  if (available !== true || !Array.isArray(candidates)) {
    throw new Error('GET /threads/:id/file-references 回了不認得的結果');
  }
  return {
    available: true,
    candidates: candidates.map((entry: unknown): FileReferenceCandidate => {
      const row = entry as Record<string, unknown> | null;
      if (
        typeof row?.path !== 'string' ||
        !row.path.startsWith('/') ||
        (row.kind !== 'file' && row.kind !== 'directory')
      ) {
        throw new Error('GET /threads/:id/file-references 回了不認得的候選');
      }
      return Object.freeze({ path: row.path, kind: row.kind });
    }),
  };
}

/** 線上回來的軌跡細節要先驗過形狀的最外層，理由同 {@link readDescriptors}；每一輪的內部交給消費端（同歷史的 frame）。 */
function readTrajectoryTurn(result: unknown): TrajectoryTurnDetail {
  const { turns, seq } = result as Record<string, unknown>;
  if (!Array.isArray(turns) || turns.length === 0 || typeof seq !== 'number') {
    throw new Error('GET /threads/:id/trajectory/turn 回了不認得的結果');
  }
  return { turns: turns as TrajectoryTurnDetail['turns'], seq };
}

/** `GET /threads/:id/session-references` 的結果。`rejected` 是讀不了存放處。 */
export type SessionReferenceListOutcome =
  | { readonly kind: 'ok'; readonly result: SessionReferenceListResult }
  | { readonly kind: 'rejected'; readonly code?: string; readonly message: string };

/** 線上回來的候選得先驗過，理由同 {@link readDescriptors}。 */
function readSessionReferences(result: unknown): SessionReferenceListResult {
  const { available, candidates } = result as { available?: unknown; candidates?: unknown };
  if (available === false) return { available: false };
  if (available !== true || !Array.isArray(candidates)) {
    throw new Error('GET /threads/:id/session-references 回了不認得的結果');
  }
  const optionalString = (value: unknown): string | undefined | null =>
    value === undefined ? undefined : typeof value === 'string' ? value : null;
  return {
    available: true,
    candidates: candidates.map((entry: unknown): SessionReferenceCandidate => {
      const row = (entry ?? {}) as Record<string, unknown>;
      const cwd = optionalString(row['cwd']);
      const parentSessionId = optionalString(row['parentSessionId']);
      const parentLabel = optionalString(row['parentLabel']);
      if (
        typeof row['sessionId'] !== 'string' ||
        typeof row['label'] !== 'string' ||
        typeof row['sameWorkspace'] !== 'boolean' ||
        typeof row['createdAt'] !== 'number' ||
        typeof row['updatedAt'] !== 'number' ||
        typeof row['mention'] !== 'string' ||
        cwd === null ||
        parentSessionId === null ||
        parentLabel === null
      ) {
        throw new Error('GET /threads/:id/session-references 回了不認得的候選');
      }
      return Object.freeze({
        sessionId: row['sessionId'],
        label: row['label'],
        sameWorkspace: row['sameWorkspace'],
        createdAt: row['createdAt'],
        updatedAt: row['updatedAt'],
        mention: row['mention'],
        ...(cwd !== undefined && { cwd }),
        ...(parentSessionId !== undefined && { parentSessionId }),
        ...(parentLabel !== undefined && { parentLabel }),
      });
    }),
  };
}

/** `GET /threads/:id/history` 的結果。`rejected` 是這條 thread 起不來、或參數不對。 */
export type ThreadHistoryOutcome =
  | { readonly kind: 'ok'; readonly result: ThreadHistoryResult }
  | { readonly kind: 'rejected'; readonly code?: string; readonly message: string };

/** `GET /threads/:id/trajectory/turn` 的結果。 */
export type TrajectoryTurnOutcome =
  | { readonly kind: 'ok'; readonly result: TrajectoryTurnDetail }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

/** 線上回來的歷史得先驗過，理由同 {@link readDescriptors}。frame 本身交給折疊器，它本來就收別人的位元組。 */
function readHistory(result: unknown): ThreadHistoryResult {
  const { events, firstSeq, throughSeq, hasMore, legacy } = result as Record<string, unknown>;
  if (
    !Array.isArray(events) ||
    typeof firstSeq !== 'number' ||
    typeof throughSeq !== 'number' ||
    typeof hasMore !== 'boolean' ||
    typeof legacy !== 'boolean'
  ) {
    throw new Error('GET /threads/:id/history 回了不認得的結果');
  }
  return { events: events as Event[], firstSeq, throughSeq, hasMore, legacy };
}

/** 線上回來的列表得先驗過，理由同 {@link readDescriptors}。 */
function readThreadList(result: unknown): ThreadListResult {
  const { items, unreadable } = result as { items?: unknown; unreadable?: unknown };
  if (!Array.isArray(items) || typeof unreadable !== 'number') {
    throw new Error('GET /threads 的結果裡沒有 items 陣列或 unreadable 數');
  }
  // 釘選與封存兩個全域集合（#633）：各自選填、各自驗，是字串陣列才帶（整份，不逐筆挑）；不是就省略，
  // 沒有實作的 server 不送，web 以「兩格都在」當支援的判準。
  const { pinnedThreadIds, archivedThreadIds } = result as {
    pinnedThreadIds?: unknown;
    archivedThreadIds?: unknown;
  };
  const stringArray = (value: unknown): readonly string[] | undefined =>
    Array.isArray(value) && value.every((id: unknown) => typeof id === 'string')
      ? Object.freeze([...(value as string[])])
      : undefined;
  const pinned = stringArray(pinnedThreadIds);
  const archived = stringArray(archivedThreadIds);
  return {
    unreadable,
    ...(pinned === undefined ? {} : { pinnedThreadIds: pinned }),
    ...(archived === undefined ? {} : { archivedThreadIds: archived }),
    items: items.map((entry: unknown): ThreadSummary => {
      const row = entry as Record<string, unknown> | null;
      if (
        typeof row?.threadId !== 'string' ||
        typeof row.updatedAt !== 'number' ||
        typeof row.running !== 'boolean' ||
        typeof row.blank !== 'boolean' ||
        (row.title !== undefined && typeof row.title !== 'string')
      ) {
        throw new Error('GET /threads 回了不認得的一列');
      }
      return Object.freeze({
        threadId: row.threadId,
        updatedAt: row.updatedAt,
        running: row.running,
        blank: row.blank,
        ...(typeof row.title === 'string' ? { title: row.title } : {}),
      });
    }),
  };
}

function readThreadSearch(result: unknown): ThreadSearchResult {
  const { items, hasMore } = result as { items?: unknown; hasMore?: unknown };
  if (!Array.isArray(items) || typeof hasMore !== 'boolean') {
    throw new Error(`POST ${THREAD_SEARCH_PATH} 的結果裡沒有 items 陣列或 hasMore`);
  }
  return {
    hasMore,
    items: items.map((entry: unknown): ThreadSearchItem => {
      const row = entry as Record<string, unknown> | null;
      if (typeof row?.threadId !== 'string' || typeof row.snippet !== 'string') {
        throw new Error(`POST ${THREAD_SEARCH_PATH} 回了不認得的一筆`);
      }
      return Object.freeze({ threadId: row.threadId, snippet: row.snippet });
    }),
  };
}

/** 線上回來的清單得先驗過。**這是別人的位元組**，不是我們剛剛建的物件。 */
function readDescriptors(result: unknown): readonly SlashDescriptor[] {
  const { commands } = result as { commands?: unknown };
  if (!Array.isArray(commands)) {
    throw new Error('slash.list 的結果裡沒有 commands 陣列');
  }
  return commands.map((entry: unknown) => {
    const descriptor = entry as { name?: unknown; description?: unknown; input?: unknown };
    if (typeof descriptor?.name !== 'string' || typeof descriptor.description !== 'string') {
      throw new Error('slash.list 回了不認得的 descriptor');
    }
    const input = descriptor.input as { hint?: unknown; attachments?: unknown } | undefined;
    const hint = input?.hint;
    return Object.freeze({
      name: descriptor.name,
      description: descriptor.description,
      ...(typeof hint === 'string'
        ? {
            input: Object.freeze({
              hint,
              // 只有「收」這一種說法（同 core 的 `normalizeCommandDefinition`）。
              ...(input?.attachments === true ? { attachments: true } : {}),
            }),
          }
        : {}),
    });
  });
}

/** 同上。`unknown` 是三值之一，不是「驗不出來」。 */
function readRunResult(result: unknown): SlashRunResult {
  const { kind, command_id: commandId, text } = result as Record<string, unknown>;
  if (kind === 'unknown') {
    return { kind: 'unknown' };
  }
  if (kind === 'success') {
    if (typeof commandId !== 'string') {
      throw new Error('slash.run 成功時要帶 command_id');
    }
    return {
      kind: 'success',
      command_id: commandId,
      ...(typeof text === 'string' ? { text } : {}),
    };
  }
  if (kind === 'error' && typeof text === 'string') {
    // `command_id` 在拋錯路徑上是缺的，見 `SlashRunResult`。
    return {
      kind: 'error',
      text,
      ...(typeof commandId === 'string' ? { command_id: commandId } : {}),
    };
  }
  throw new Error(`slash.run 回了不認得的 kind "${String(kind)}"`);
}

/**
 * 把 server 回的協定錯誤**原樣**交給呼叫端：碼（`error`）與可直接顯示的中文原因（`message`）。
 *
 * 照 dsh 的 client 失敗形狀（`ConnectionRpcFailure`，`packages/client/connection/src/rpc.ts`）：
 * 失敗帶 `code` 與 `message`，呼叫端按碼分支、按 `message` 顯示，**不比對 `message` 的字串**。
 * `code` 在型別上是選填的（[#764](https://github.com/DemianLi/nexus-agent/issues/764) 先加成選填，
 * 讓只讀 `message` 的呼叫端與測試替身照樣編得過）。
 *
 * **只在 server 真的送了字串碼的時候才帶 `code`**，缺欄位就不放這個鍵，不拿 `"undefined"` 之類的字串頂。
 * 參數收成 `unknown` 欄位：上行（`UplinkResult` 收窄到 `type === 'error'` 之後）與 GET（解析來的 JSON 本體，沒有型別）
 * 兩條路共用這一個讀法。上行那條早先要靠型別轉換才過，是 `WireErrorResponse` 掉了具名鍵（[#1166](https://github.com/DemianLi/nexus-agent/issues/1166)，已修）。
 */
type RejectedSource = { readonly error?: unknown; readonly message?: unknown };

function rejectedOf(failure: RejectedSource) {
  return {
    kind: 'rejected' as const,
    ...(typeof failure.error === 'string' ? { code: failure.error } : {}),
    message: typeof failure.message === 'string' ? failure.message : '對方拒絕了，但沒有說明原因',
  };
}

/** 全域有 `XMLHttpRequest`（瀏覽器）就給工廠，沒有（Node）就是 `undefined`。 */
function defaultXhr(): (() => UploadXhr) | undefined {
  const ctor = (globalThis as { XMLHttpRequest?: new () => UploadXhr }).XMLHttpRequest;
  return ctor === undefined ? undefined : () => new ctor();
}

/** 用 XHR 送一個 Blob 並回報進度；`signal` 中止就 `abort()` 並以 `signal.reason` 拒絕（同 `fetch` 的行為）。 */
function uploadWithXhr(
  xhr: UploadXhr,
  url: string,
  body: Blob,
  signal: AbortSignal | undefined,
  onProgress: (progress: UploadProgress) => void,
): Promise<{ readonly ok: boolean; readonly status: number; text(): Promise<string> }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    let loadedSoFar = 0;
    const onAbort = (): void => {
      xhr.abort();
    };
    const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
    xhr.upload.onprogress = (event) => {
      // 單調不減：瀏覽器偶爾會回報比上一次小的值（重送、重導），畫面的進度條不該倒退。
      loadedSoFar = Math.max(loadedSoFar, event.loaded);
      onProgress({
        loaded: loadedSoFar,
        ...(event.lengthComputable ? { total: event.total } : {}),
      });
    };
    xhr.onload = () => {
      cleanup();
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        text: async () => xhr.responseText,
      });
    };
    xhr.onerror = () => {
      cleanup();
      reject(new TypeError('上傳的連線失敗'));
    };
    xhr.onabort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException('上傳被中止', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    xhr.open('POST', url);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.send(body);
  });
}

export function createWireClient(options: WireClientOptions): WireClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  let nextCommandId = 1;

  async function postJson(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return doFetch(`${base}${path}`, {
      method: 'POST',
      // 這個 header 不是裝飾：server 端只收 application/json，為的是逼出一個它從不
      // 回答的 CORS preflight，擋掉瀏覽器不發 preflight 的那種「simple POST」。
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  }

  /** 一頁歷史（root 的或背景子代理的）：同一條 GET、同一套查詢與驗證。 */
  async function fetchHistory(
    path: string,
    query: ThreadHistoryQuery,
  ): Promise<ThreadHistoryOutcome> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const encoded = params.toString();
    const search = encoded === '' ? '' : `?${encoded}`;
    const response = await doFetch(`${base}${path}${search}`, {
      method: 'GET',
      // 同 `listThreads`，見 `THREADS_PATH`。
      headers: { 'content-type': 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`歷史被載體層擋下：${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as ThreadHistoryResponse;
    return body.type === 'error'
      ? rejectedOf(body)
      : { kind: 'ok', result: readHistory(body.result) };
  }

  async function sendCommand(
    threadId: string,
    method: RpcMethod,
    command:
      | Command
      | RunStartCommand
      | SlashCommand
      | RunCancelCommand
      | QueueUpdateCommand
      | SubagentSendCommand
      | SubagentInterruptCommand
      | FeedbackCommand
      | ModelCommand
      | PermissionCommand
      | SubagentListCommand
      | ThreadManagementCommand,
  ): Promise<UplinkResult> {
    // 路徑與封包各講一次 method，server 端不合就拒——照 dsh 的端點慣例
    // （`packages/api/gateway/src/index.ts:134`，`<namespace>/<method>`）。
    const response = await postJson(commandPath(threadId, method), command);
    if (!response.ok) {
      throw new Error(`上行被載體層擋下：${response.status} ${await response.text()}`);
    }
    return (await response.json()) as UplinkResult;
  }

  /**
   * 送一個回饋命令，把回應拆成「這條線收不了」與「命令自己的結果」。
   *
   * 結果**只檢 `ok` 是不是布林**，其餘形狀不驗、直接 `as T`。這是**信任，不是保證**：server 那側用
   * `successResponse` 送（參數是 `Record<string, unknown>`），送出去的值沒有在編譯期綁到這裡的 `T`
   * （[#683](https://github.com/DemianLi/nexus-agent/issues/683)）。這裡要擋的只有「回來的根本不是回饋結果」——
   * 那種時候當成收不了，不硬讀。
   */
  async function sendFeedback<T>(
    threadId: string,
    command: FeedbackCommand,
  ): Promise<FeedbackOutcome<T>> {
    return sendOkCommand<T>(threadId, command, '回饋');
  }

  /** 同 {@link sendFeedback} 的拆法，給回 `{ ok, … }` 的其他命令；`label` 只用在「看不懂」的訊息裡。 */
  async function sendOkCommand<T>(
    threadId: string,
    command:
      | FeedbackCommand
      | ModelCommand
      | PermissionCommand
      | SubagentListCommand
      | ThreadManagementCommand,
    label: string,
  ): Promise<CommandOutcome<T>> {
    const response = await sendCommand(threadId, command.method, command);
    if (response.type === 'error') return rejectedOf(response);
    const result: unknown = response.result;
    if (typeof (result as { ok?: unknown } | null)?.ok !== 'boolean') {
      return { kind: 'rejected', message: `${label}的回應看不懂：${JSON.stringify(result)}` };
    }
    return { kind: 'ok', result: result as T };
  }

  return {
    async openEvents(threadId, streamOptions = {}) {
      const response = await postJson(
        streamPath(threadId),
        { channels: streamOptions.channels ?? [...WIRE_CHANNELS] },
        streamOptions.signal,
      );
      if (!response.ok) {
        throw new Error(`下行開不起來：${response.status} ${await response.text()}`);
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.startsWith('text/event-stream')) {
        // 協定層的錯是 200 ＋ error 封包（照 dsh 的分層），所以這裡拿得到原因。
        throw new Error(`下行被拒：${await response.text()}`);
      }
      if (response.body === null) {
        throw new Error('下行沒有 body');
      }
      return decodeSseStream(response.body);
    },

    async openThreadFeed(signal) {
      const response = await doFetch(`${base}${THREAD_FEED_PATH}`, {
        method: 'GET',
        // 同列表那一條：沒有它就是一個不發 preflight 的跨來源 simple request，見 `THREAD_FEED_PATH`。
        headers: { 'content-type': 'application/json' },
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) {
        throw new Error(`全域下行開不起來：${response.status} ${await response.text()}`);
      }
      if (!(response.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
        throw new Error(`全域下行被拒：${await response.text()}`);
      }
      if (response.body === null) {
        throw new Error('全域下行沒有 body');
      }
      return knownFeedFrames(decodeSseData(response.body));
    },

    async runStart(threadId, text, options) {
      return sendCommand(threadId, 'run.start', {
        id: nextCommandId++,
        method: 'run.start',
        params: {
          // 協定的 `assistant_id` 指的是部署上的某個 graph；我們一個 thread 就一個
          // agent，所以這一格是形式上的，server 只檢查它是字串。
          assistant_id: 'nexus',
          input: { messages: [{ role: 'human', content: text }] },
          // 省略就不放這個 key：排隊是預設，舊的 server 也收得下。
          ...(options?.mode === undefined ? {} : { mode: options.mode }),
          // 省略或空陣列都不放這個 key：舊的 server 也收得下。
          ...(options?.attachments === undefined || options.attachments.length === 0
            ? {}
            : { attachments: options.attachments }),
          // 省略就不放這個 key：舊的 server 也收得下。
          ...(options?.mention === undefined ? {} : { mention: options.mention }),
        },
      });
    },

    async inputRespond(threadId, params) {
      return sendCommand(threadId, 'input.respond', {
        id: nextCommandId++,
        method: 'input.respond',
        params,
      });
    },

    async runCancel(threadId) {
      return sendCommand(threadId, RUN_CANCEL_METHOD, {
        id: nextCommandId++,
        method: RUN_CANCEL_METHOD,
      });
    },

    async queueUpdate(threadId, params) {
      return sendCommand(threadId, QUEUE_UPDATE_METHOD, {
        id: nextCommandId++,
        method: QUEUE_UPDATE_METHOD,
        params,
      });
    },

    async subagentSend(threadId, runId, text) {
      return sendCommand(threadId, SUBAGENT_SEND_METHOD, {
        id: nextCommandId++,
        method: SUBAGENT_SEND_METHOD,
        params: { run_id: runId, text },
      });
    },

    async subagentInterrupt(threadId, runId) {
      return sendCommand(threadId, SUBAGENT_INTERRUPT_METHOD, {
        id: nextCommandId++,
        method: SUBAGENT_INTERRUPT_METHOD,
        params: { run_id: runId },
      });
    },

    async subagentList(threadId) {
      const command: SubagentListCommand = {
        id: nextCommandId++,
        method: 'subagent.list',
        params: {},
      };
      return sendOkCommand<SubagentListResult>(threadId, command, '列子代理');
    },

    async modelCatalog(threadId) {
      const command: ModelCatalogCommand = {
        id: nextCommandId++,
        method: 'model.catalog',
        params: {},
      };
      return sendOkCommand<ModelCatalogResult>(threadId, command, '模型型錄');
    },

    async selectModel(threadId, selection) {
      const command: ModelSelectCommand = {
        id: nextCommandId++,
        method: 'model.select',
        params: selection,
      };
      return sendOkCommand<ModelSelectResult>(threadId, command, '模型選擇');
    },

    async permissionCatalog(threadId) {
      const command: PermissionCatalogCommand = {
        id: nextCommandId++,
        method: 'permission.catalog',
        params: {},
      };
      return sendOkCommand<PermissionCatalogResult>(threadId, command, '權限目錄');
    },

    async threadPin(threadId) {
      const command: ThreadPinCommand = { id: nextCommandId++, method: 'thread.pin', params: {} };
      return sendOkCommand<ThreadPinResult>(threadId, command, '釘選');
    },

    async threadUnpin(threadId) {
      const command: ThreadUnpinCommand = {
        id: nextCommandId++,
        method: 'thread.unpin',
        params: {},
      };
      return sendOkCommand<ThreadUnpinResult>(threadId, command, '取消釘選');
    },

    async threadArchive(threadId, options) {
      const command: ThreadArchiveCommand = {
        id: nextCommandId++,
        method: 'thread.archive',
        // 省略就不放這個 key：舊的 server 與預設（不停活動）一致。
        params: options?.stopActivity === undefined ? {} : { stopActivity: options.stopActivity },
      };
      return sendOkCommand<ThreadArchiveResult>(threadId, command, '封存');
    },

    async threadUnarchive(threadId) {
      const command: ThreadUnarchiveCommand = {
        id: nextCommandId++,
        method: 'thread.unarchive',
        params: {},
      };
      return sendOkCommand<ThreadUnarchiveResult>(threadId, command, '取消封存');
    },

    async threadRename(threadId, title) {
      const command: ThreadRenameCommand = {
        id: nextCommandId++,
        method: 'thread.rename',
        params: { title },
      };
      return sendOkCommand<ThreadRenameResult>(threadId, command, '改名');
    },

    async uploadFile(threadId, body, name, signal, onProgress) {
      const search =
        name === undefined ? '' : `?${new URLSearchParams({ [UPLOAD_NAME_PARAM]: name })}`;
      const url = `${base}${uploadPath(threadId)}${search}`;
      const size = body instanceof Uint8Array ? body.byteLength : body.size;
      // 要進度、body 是 Blob、又有 XHR 可用：走 XHR（`fetch` 量不到上傳進度）。否則走 `fetch`，送完報一次。
      const makeXhr = options.createXhr ?? (options.fetch === undefined ? defaultXhr() : undefined);
      let reply: { readonly ok: boolean; readonly status: number; text(): Promise<string> };
      if (
        onProgress !== undefined &&
        makeXhr !== undefined &&
        typeof Blob !== 'undefined' &&
        body instanceof Blob
      ) {
        reply = await uploadWithXhr(makeXhr(), url, body, signal, onProgress);
      } else {
        const response = await doFetch(url, {
          method: 'POST',
          // 不是 JSON：原始位元組。這個 content-type 也不是 simple request，跨來源會發 server 從不回答的 preflight，見 `attachments.ts`。
          headers: { 'content-type': 'application/octet-stream' },
          body: body as NonNullable<RequestInit['body']>,
          ...(signal === undefined ? {} : { signal }),
        });
        onProgress?.({ loaded: size, total: size });
        reply = response;
      }
      if (!reply.ok) {
        throw new Error(`上傳被載體層擋下：${reply.status} ${await reply.text()}`);
      }
      const parsed = JSON.parse(await reply.text()) as UploadResponse;
      if (parsed.type === 'error') return rejectedOf(parsed);
      const { receiptId, name: stored, bytes } = parsed.result as Partial<UploadReceipt>;
      if (
        typeof receiptId !== 'string' ||
        typeof stored !== 'string' ||
        typeof bytes !== 'number'
      ) {
        throw new Error('POST /threads/:id/uploads 回了不認得的收據');
      }
      return { kind: 'ok', receipt: { receiptId, name: stored, bytes } };
    },

    async feedbackPut(threadId, params) {
      return sendFeedback<FeedbackPutResult>(threadId, {
        id: nextCommandId++,
        method: 'feedback.put',
        params,
      });
    },

    async feedbackDelete(threadId, params) {
      return sendFeedback<FeedbackDeleteResult>(threadId, {
        id: nextCommandId++,
        method: 'feedback.delete',
        params,
      });
    },

    async feedbackList(threadId) {
      return sendFeedback<FeedbackListResult>(threadId, {
        id: nextCommandId++,
        method: 'feedback.list',
        params: {},
      });
    },

    async feedbackRecord(threadId, params) {
      return sendFeedback<FeedbackRecordResult>(threadId, {
        id: nextCommandId++,
        method: 'feedback.record',
        params,
      });
    },

    async slashList(threadId) {
      const response = await sendCommand(threadId, 'slash.list', {
        id: nextCommandId++,
        method: 'slash.list',
      });
      return response.type === 'error'
        ? rejectedOf(response)
        : { kind: 'ok', commands: readDescriptors(response.result) };
    },

    async slashRun(threadId, line, attachments) {
      const response = await sendCommand(threadId, 'slash.run', {
        id: nextCommandId++,
        method: 'slash.run',
        // 省略或空陣列都不放這個 key：舊的 server 也收得下。
        params: {
          line,
          ...(attachments === undefined || attachments.length === 0 ? {} : { attachments }),
        },
      });
      return response.type === 'error' ? rejectedOf(response) : readRunResult(response.result);
    },

    async listThreads() {
      const response = await doFetch(`${base}${THREADS_PATH}`, {
        method: 'GET',
        // 同上行那一條：沒有它就是一個不發 preflight 的跨來源 simple request，見 `THREADS_PATH`。
        headers: { 'content-type': 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`列表被載體層擋下：${response.status} ${await response.text()}`);
      }
      const body = (await response.json()) as ThreadListResponse;
      return body.type === 'error'
        ? rejectedOf(body)
        : { kind: 'ok', result: readThreadList(body.result) };
    },

    async searchThreads(query, signal) {
      const response = await postJson(THREAD_SEARCH_PATH, { query }, signal);
      if (!response.ok) {
        throw new Error(`搜尋被載體層擋下：${response.status} ${await response.text()}`);
      }
      const body = (await response.json()) as ThreadSearchResponse;
      return body.type === 'error'
        ? rejectedOf(body)
        : { kind: 'ok', result: readThreadSearch(body.result) };
    },

    async threadHistory(threadId, query = {}) {
      return fetchHistory(historyPath(threadId), query);
    },

    async subagentHistory(threadId, runId, query = {}) {
      return fetchHistory(subagentHistoryPath(threadId, runId), query);
    },

    async trajectoryTurn(threadId, query, signal) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) params.set(key, String(value));
      }
      const encoded = params.toString();
      const response = await doFetch(
        `${base}${trajectoryTurnPath(threadId)}${encoded === '' ? '' : `?${encoded}`}`,
        {
          method: 'GET',
          // 同 `listThreads`，見 `THREADS_PATH`。
          headers: { 'content-type': 'application/json' },
          signal,
        },
      );
      if (!response.ok) {
        throw new Error(`軌跡被載體層擋下：${response.status} ${await response.text()}`);
      }
      const body = (await response.json()) as TrajectoryTurnResponse;
      return body.type === 'error'
        ? { kind: 'rejected', code: String(body.error), message: body.message }
        : { kind: 'ok', result: readTrajectoryTurn(body.result) };
    },

    async fileReferences(threadId, query, signal) {
      const search = new URLSearchParams({ query }).toString();
      const response = await doFetch(`${base}${fileReferencesPath(threadId)}?${search}`, {
        method: 'GET',
        // 同 `listThreads`，見 `THREADS_PATH`。
        headers: { 'content-type': 'application/json' },
        signal,
      });
      if (!response.ok) {
        throw new Error(`列檔被載體層擋下：${response.status} ${await response.text()}`);
      }
      const body = (await response.json()) as FileReferenceListResponse;
      return body.type === 'error'
        ? rejectedOf(body)
        : { kind: 'ok', result: readFileReferences(body.result) };
    },

    async sessionReferences(threadId, query, signal) {
      const search = new URLSearchParams({ query }).toString();
      const response = await doFetch(`${base}${sessionReferencesPath(threadId)}?${search}`, {
        method: 'GET',
        // 同 `listThreads`，見 `THREADS_PATH`。
        headers: { 'content-type': 'application/json' },
        signal,
      });
      if (!response.ok) {
        throw new Error(`列會話被載體層擋下：${response.status} ${await response.text()}`);
      }
      const body = (await response.json()) as SessionReferenceListResponse;
      return body.type === 'error'
        ? rejectedOf(body)
        : { kind: 'ok', result: readSessionReferences(body.result) };
    },

    async readAttachment(threadId, attachmentId, signal) {
      const response = await doFetch(`${base}${attachmentPath(threadId, attachmentId)}`, {
        method: 'GET',
        // 同 `listThreads`，見 `THREADS_PATH`。
        headers: { 'content-type': 'application/json' },
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) {
        throw new Error(`讀圖被載體層擋下：${response.status} ${await response.text()}`);
      }
      const body = (await response.json()) as AttachmentReadResponse;
      if (body.type === 'error') return rejectedOf(body);
      const { attachment, data } = body.result as Partial<AttachmentReadResult>;
      if (
        typeof data !== 'string' ||
        attachment === undefined ||
        attachment.type !== 'image' ||
        typeof attachment.attachmentId !== 'string'
      ) {
        throw new Error('GET /threads/:id/attachments/:attachmentId 回了不認得的內容');
      }
      return { kind: 'ok', result: { attachment, data } };
    },
  };
}
