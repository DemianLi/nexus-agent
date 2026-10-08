/**
 * 線的 server 端：一個 `(Request) => Response` 的 handler。
 *
 * **不綁 port 是刻意的。** 這個形狀當初照的是 dsh 的
 * `packages/host/apiproxy/src/fetch/handler.ts`（對讀版本 `cd5ef814`）——
 * **那個套件在 HEAD `0a53fb55` 已經整個不見了**：dsh 的載體換成了
 * `packages/host/webserver` 的 `node:http` route 註冊 ＋ WebSocket upgrade，
 * 沒有 fetch 形狀的 handler 了。所以底下每一條標著「照 dsh」的，指的都是那個版本。
 *
 * **不綁 port 這件事今天站的是自己的理由**，不是那份引用：這一整條線在測試裡跑得完
 * ——零 port、零網路、零憑證，而 CI 上沒有任何服務憑證
 * （[#31](https://github.com/DemianLi/nexus-agent/issues/31)），測試必須自足。
 *
 * 錯誤分兩層，也照 dsh：
 *
 * - **載體層**用 HTTP status：403（來源不可信）、401（沒有有效的瀏覽器會話）、
 *   415（media type 不是 JSON）、400（body 不是 JSON）、404（路徑不指向任何 method）。
 * - **協定層**用 200 ＋ error 封包：封包形狀不對、method 與路徑不合、要的功能沒實作。
 *
 * 那個 415 是安全閘不是潔癖：瀏覽器對 `text/plain` 之類的「simple POST」不發
 * preflight，只收 `application/json` 等於逼出一個這個 server 從不回答的 preflight。
 *
 * **它擋得住跨站，擋不住 DNS rebinding**——被 rebinding 的頁面在瀏覽器眼裡是同源，preflight
 * 根本不發。那一條由排在它前面的 403 擋，判準照 dsh，見 [`request-trust.ts`](./request-trust.ts)
 * （[#387](https://github.com/DemianLi/nexus-agent/issues/387)）。
 *
 * **圍欄不建立身分**：curl 帶一個 loopback 的 `Host` 就過得去。緊接在它後面的 401 才是身分——
 * 瀏覽器會話 cookie，照 dsh `rpc-host.ts` 的 `requestRejection`（先 403、再 401，都在路徑判斷之前），
 * 見 [`browser-auth.ts`](./browser-auth.ts)（[#424](https://github.com/DemianLi/nexus-agent/issues/424)）。
 */

import type {
  Command,
  EventStreamRequest,
  FileReferenceListResponse,
  SessionReferenceCandidate,
  SessionReferenceListResponse,
  SlashListResult,
  SlashMethod,
  SlashRunResult,
  ThreadHistoryQuery,
  ThreadHistoryResponse,
  TrajectoryTurnDetail,
  TrajectoryTurnResponse,
  ThreadHistoryResult,
  ThreadListResponse,
  ThreadSearchResponse,
  ThreadSearchResult,
  UplinkMethod,
  UploadResponse,
  WireErrorCode,
  WireChannel,
  FeedbackMethod,
  ModelMethod,
  WireFeedbackRating,
  DeliverableBytes,
  DeliverableMethod,
  DeliverableReadError,
  DeliverableRefusalCode,
  PermissionCatalog,
} from '@nexus/wire';
import {
  THREAD_FEED_PATH,
  THREAD_SEARCH_PATH,
  THREADS_PATH,
  changesDiffPath,
  changesSummaryPath,
  DELIVERABLE_READ_METHOD,
  encodeBinaryResult,
  encodeSseData,
  encodeSseFrame,
  errorResponse,
  fileReferencesPath,
  isModelMethod,
  isPermissionMethod,
  isThreadManagementMethod,
  isSubagentListMethod,
  uploadPath,
  UPLOAD_NAME_PARAM,
  isDeliverableMethod,
  isFeedbackMethod,
  isQueueUpdateMethod,
  isRpcMethod,
  isRunCancelMethod,
  isSubagentMethod,
  QUEUE_ITEM_NOT_FOUND,
  RUN_START_MODES,
  STEER_UNAVAILABLE,
  SUBAGENT_AT_CAPACITY,
  SUBAGENT_CLOSED,
  SUBAGENT_NOT_FOUND,
  TRAJECTORY_PROJECTION,
  trajectoryTurnPath,
  TURN_NOT_FOUND,
  SUBAGENT_SEND_METHOD,
  isSlashMethod,
  isWireChannel,
  SessionReferenceError,
  sessionReferencesPath,
  successResponse,
} from '@nexus/wire';
import type {
  CommandRegistrationPoint,
  ProjectionRegistrationPoint,
  FeedbackCategory,
  FeedbackService,
  SessionEvent,
  SessionLog,
  SessionRegistry,
} from '@nexus/core';
import { FEEDBACK_CATEGORIES, ProjectionDetailError } from '@nexus/core';
import type { CommandExecutor } from '@nexus/plugin-commands';
import type { WorkspaceChanges } from '@nexus/plugin-workspace-changes';
import { createCommandExecutor } from '@nexus/plugin-commands';
import { AttachmentError } from './attachment-store.js';
import type { AttachmentStore, FileAttachmentRef } from './attachment-store.js';
import { isBackgroundRunId } from './background-run-id.js';
import { BackgroundSubagentError } from './background-subagents.js';
import type { BackgroundSubagentControl } from './background-subagents.js';
import type { AttachSessions } from './session-attach.js';
import { HistoryQueryError, historyPage } from './conversation-history.js';
import type { SessionReferenceReader } from './session-reference.js';
import type {
  DeliverableRefusal,
  DeliverableResult,
  LocatedDeliverable,
} from './deliverable-files.js';
import {
  locateDeliverable,
  locateDeliverableFile,
  readDeliverableBytes,
  readDeliverablePage,
} from './deliverable-files.js';
import { readDeliverableWindow, resolveDeliverableWindow } from './deliverable-window.js';
import { listFileReferences, WorkspaceFileSearch } from './file-references.js';
import {
  deliverableFilesConfigSchema,
  type DeliverableFilesConfig,
} from './settings/deliverable-files.js';
import type { ThreadTitleLimits } from './session-title.js';
import type { AttachSessionTitleLlm } from './session-title-llm.js';
import { threadTitleConfigSchema } from './settings/thread-title.js';
import { normalizeThreadSearchQuery, ThreadSearchError } from './thread-search.js';
import type { ThreadSearchErrorKind } from './thread-search.js';
import { toolTextConfigSchema } from './settings/tool-text.js';
import type { ToolTextConfig } from './settings/tool-text.js';
import type { GoalDriverPort } from './goal-driver.js';
import { isTrustedWireRequest } from './request-trust.js';
import { readProjectionChildSeeds } from './projection-children.js';
import type { StoredThreadList } from './session-list.js';
import type { ModelSelectionHost } from './model-selection-host.js';
import type { PumpAgent, QueueAction } from './thread-pump.js';
import { ThreadFeed } from './thread-feed.js';
import { ThreadPump } from './thread-pump.js';

/**
 * 一個 thread 的 agent 與它的清理函式。
 *
 * **`dispose` 是必填的**，因為忘記它的代價看不見：`createNexusAgent` 回的正是這個
 * 形狀，而 MCP plugin 底下是 stdio 子行程——只收 pump 不 dispose agent 的話，
 * 每開一個 thread 就漏一組子行程，而且不會有任何錯誤訊息。
 */
export interface ThreadAgent {
  readonly agent: PumpAgent;
  /**
   * 這個 agent 的圖裡掛沒掛插話的載體（[#710](https://github.com/DemianLi/nexus-agent/issues/710)，`createNexusAgent`
   * 回的那一格）。**省略即沒掛**：那時插話退成排隊、`queue.update` 的 `steer` 回 `steer_unavailable`，不會放進一條沒人領的
   * `next-step`。
   */
  readonly stepInbox?: boolean;
  /**
   * 這個 thread 打得出哪些斜線命令。**必填**，理由同 `dispose`：忘記它的代價看不見。
   *
   * 給 `undefined` 一個預設值的話，組裝點漏傳就是一份空清單——瀏覽器那端看到的是
   * 「這裡沒有命令」，跟「真的沒註冊任何命令」一模一樣，而且沒有任何錯誤訊息
   * （[#123](https://github.com/DemianLi/nexus-agent/issues/123)）。
   *
   * **只讀 `find` 與 `list`**：這條線不註冊任何東西。
   */
  readonly commands: Pick<CommandRegistrationPoint, 'find' | 'list'>;
  /**
   * 這個 thread 掛了哪些會話投影（[#1026](https://github.com/DemianLi/nexus-agent/issues/1026)），選配。**省略即沒有投影**——
   * 手搭的測試組裝不必管；產品路徑（`serve.ts`）一律交，由 `projection-wire.test.ts` 的端到端驗收看著。
   * **只讀 `list`**：這條線不註冊任何東西。
   */
  readonly projections?: Pick<ProjectionRegistrationPoint, 'list'>;
  /**
   * 評分與評語的規則（[#278](https://github.com/DemianLi/nexus-agent/issues/278)），選配。
   * 沒掛 `@nexus/plugin-feedback` 的組裝就沒有，那時四個回饋 method 回 `not_supported`。
   */
  readonly feedback?: FeedbackService;
  /**
   * 每一輪改動檔案的摘要與比較（[#443](https://github.com/DemianLi/nexus-agent/issues/443)），選配。
   * 沒給 `--workspace` 的組裝就沒有，那時兩條 `changes` 路由一律 404——同「這台 server 不服務這份摘要」。
   */
  readonly workspaceChanges?: WorkspaceChanges;
  /**
   * 權限組合的目錄（[#437](https://github.com/DemianLi/nexus-agent/issues/437)），選配。沒有圍堵（沒給 `--workspace`）或
   * 沒掛 `@nexus/plugin-permission-presets` 的組裝就沒有，那時 `permission.catalog` 回 `not_supported`、`permissions` 投影缺席。
   */
  readonly permissionPresets?: { catalog(): PermissionCatalog };
  /**
   * 每會話模型選擇（[#723](https://github.com/DemianLi/nexus-agent/issues/723)），選配。沒帶 `--live`（假模型沒有型錄）的組裝就沒有，
   * 那時 `model.catalog`／`model.select` 回 `not_supported`，web 據這個碼把模型座藏起來。
   */
  readonly modelSelection?: Pick<ModelSelectionHost, 'catalog' | 'state' | 'select'>;
  dispose(): Promise<void>;
  /**
   * 把這個 thread 的**每一份**會話日誌接上遙測、不變量配套入口與參與者，**必填**（[#668](https://github.com/DemianLi/nexus-agent/issues/668)）。
   *
   * 三件事是一個口，答案都來自 `createCliAgent`（掛了什麼 plugin 決定有沒有遙測後端、有沒有配套入口、有沒有參與者），
   * 而且**一律要接**：以前這是三個選配口，`serve.ts` 少轉交任何一個都不報錯、也沒有測試會紅，後果卻是 web 上
   * 每條 thread 的不變量檢查整個消失、或遙測一筆都不送，CLI 照常所以本機看不出來。接線點仍在這裡（pump 建好的那一刻），
   * 因為註冊表是 pump 建的、知道有沒有掛後端的是組裝點，兩邊只在這個口碰得到面。
   *
   * **參與者那一份同時是模型工具那條線。** 綁上註冊表之後，plugin 註冊的工具才問得出「我這次呼叫該寫進哪一份日誌」
   * （`registry.sessions.forCall`）。漏了它，`@nexus/core` 的測試照樣全綠，而 web 那端每一個 thread 的域狀態都不存在。
   *
   * 見 {@link AttachSessions}。
   */
  attachSessions: AttachSessions;
  /**
   * 把這個 thread 的**每一份**會話日誌接上落盤，選配。
   *
   * **這一條與上面三條不同層**：那三個的答案來自 `createCliAgent`（掛了什麼 plugin
   * 決定有沒有遙測後端、有沒有配套入口、有沒有參與者），而落盤是**一台 server 一份**的答案
   * ——開不開由清單上 `session-persistence` 那一列講（#612，`runServe` 起動期解一次），寫去哪裡
   * 由**呼叫方式**講（`serve.ts` 的日誌根：`--session-log`，沒給就是 harness home 底下的
   * `sessions`，#444）。所以組裝點是 `runServe` 自己的閉包，不是 `createCliAgent` 的回傳值。
   *
   * **選配**：`serve` 只在清單把那一列關掉時不給；另外就是這個 handler 的其他組裝（wire 測試那些手搭的）。
   *
   * **一個行程一個 store，一條 thread 一次接線。** store 落在會話根按專案分的那一格，整個
   * 行程共用；每條 thread 的 root session id 就是它的 `threadId`，所以那一格底下一條
   * thread 一個檔（檔名的單射性見 `jsonl-session-store.ts` 的 `safeBaseName`——
   * `threadId` 是呼叫端給的字串），重開之後同一條 thread 找得回自己那一份。
   *
   * 前面那個 `attachSessions` 接的三件事是觀察者，這一個是出口，所以排在最後——同 `cli.ts` 的接線順序。
   *
   * @param sessions - 這個 thread 的會話註冊表。
   * @returns 收掉這次接線的方法（`dispose` 會排空並關檔），或沒開落盤時的 `undefined`。
   */
  attachPersistence?(
    sessions: SessionRegistry,
  ): { flush(): Promise<void>; dispose(): Promise<void> } | undefined;
  /**
   * 把 LLM 標題接到這條 thread 的 root 日誌上（[#650](https://github.com/DemianLi/nexus-agent/issues/650)），選配。
   * 沒帶 `--live`、或清單把 `thread-title-llm` 那一列關掉，`createCliAgent` 就不給，那時只有退回標題。
   *
   * 它跟其他四條一樣住在組裝點：模型與設定是 `createCliAgent` 那一次組裝的，日誌是 pump 建的。
   */
  readonly attachTitle?: AttachSessionTitleLlm;
  /**
   * 組出續行排程器要問域的四件事。**沒開 `--goal-driver` 就整個不給**，那時這條 thread
   * 一輪都不會自己排。
   *
   * `log` 是 getter 而不是一份日誌，因為日誌由 {@link ThreadPump} 建，而 port 要在 pump
   * 之前組好——它是 pump 的建構參數。同一個理由讓 `flush` 也是延後綁的：耐久協調器接在
   * pump 之後。
   *
   * @param log - 讀這條 thread 的 root 日誌。
   * @param flush - 排隊前的耐久檢查點。
   * @returns 排程器那一側。
   */
  goalDriver?(log: () => SessionLog, flush: () => Promise<void>): GoalDriverPort;
  /**
   * root 日誌的 seed：這條 thread 以前寫過、這一次從會話根接回來時，上一個行程留下的事件
   * （[#251](https://github.com/DemianLi/nexus-agent/issues/251) 的門 A）。省略即一份新日誌。
   *
   * 它交給 {@link ThreadPump}，因為註冊表是 pump 建的；落盤那一側（往原檔續寫、只寫還沒存的
   * 後綴）歸 {@link attachPersistence}，由組裝點自己記著。
   */
  readonly rootSeed?: readonly SessionEvent[];
  /**
   * 這一次組裝的工作區根，**沒給 `--workspace` 就是 `undefined`**
   * （[#452](https://github.com/DemianLi/nexus-agent/issues/452)）。
   *
   * 兩支交付讀檔方法拿它當錨。**由組裝點交出來，不是這裡算的**——算它的是
   * `createCliAgent`，而呼叫端不准再寫一次 `resolve(cwd, ...)`（見 `cli.ts` 的
   * `resolveWorkspaceRoot`）。
   */
  readonly workspaceRoot?: string;
  /**
   * **接回來那份日誌的 header 記的工作區根**，沒續接、或那份 header 沒記那一格就是 `undefined`
   * （[#519](https://github.com/DemianLi/nexus-agent/issues/519)）。
   *
   * 它跟 {@link workspaceRoot} 是兩個來源：這一格來自磁碟上的 header，那一格來自這一次的
   * `--workspace`。**兩個都有值的時候它們一定相等**——`assertSameWorkspaceRoot` 在續接那一刻
   * 就擋下了不等的情形——而 `locateAt` 對不等**再拒一次**，理由見那裡。
   *
   * **是 header 有沒有那一格，不是 `version >= 13`。** 一份 12 的日誌被 13 接回來之後 header 的
   * `version` 會被覆寫成 13，而那一格仍然不在（續接不回填，見 `session-store.ts` 的版本 13
   * 那一段）；照版本號判就會替那些更早的事件宣稱一個沒人驗證過的錨。
   */
  readonly resumedWorkspaceRoot?: string;
}

export interface WireHandlerOptions {
  /** 一個 thread 一個 agent。第一次碰到這個 thread 時呼叫。 */
  createAgent(threadId: string): Promise<ThreadAgent>;
  /**
   * 讀以前落盤的 thread（`GET /threads`，[#302](https://github.com/DemianLi/nexus-agent/issues/302)），選配。
   *
   * **缺席就是「沒有落盤」**，那時列表回 `not_supported` 而不是空清單——同 `ThreadAgent.attachPersistence`
   * 用缺席表達「沒開落盤」的規矩。答案來自呼叫方式（serve 的日誌根），所以跟落盤一樣住在組裝點；
   * `serve` 只在清單把落盤那一列關掉時不給（#612；#444 起預設就給），另外就是手搭的組裝。
   *
   * **它不准碰 {@link createAgent}**：列表照 dsh 是冷讀，一條 thread 都不為它啟動。`running` 那一格由這個
   * handler 從手上活著的 thread 補，不從檔案猜。
   *
   * **`signal` 是這一個請求的**（客戶端斷線就中止，同 {@link searchThreads}；[#983](https://github.com/DemianLi/nexus-agent/issues/983)）：
   * 實作要在每一份之間看它，不然一個被放棄的請求會把整份掃描做完（實測 1000 份 × 1 MB 約 2.6 秒的 CPU 白花）。
   */
  listThreads?(signal: AbortSignal): Promise<StoredThreadList>;
  /**
   * 讀一個背景子代理自己的落盤日誌（唯讀冷讀，[#871](https://github.com/DemianLi/nexus-agent/issues/871)）：`undefined`＝
   * 沒有這一份。**實作要自己確認它屬於 `threadId`**（header 的 `parentSession`），不然別條 thread 的編號讀得到。缺席＝沒開落盤，
   * 路由那時只讀得到載入著的 thread 記憶體裡的日誌。**同 {@link listThreads}，它不准碰 {@link createAgent}。**
   */
  readSubagentSession?(
    threadId: string,
    runId: string,
  ): Promise<readonly SessionEvent[] | undefined>;
  /**
   * 按內容搜以前的 thread（`POST /threads/search`，[#631](https://github.com/DemianLi/nexus-agent/issues/631)），選配。實作是
   * `thread-search.ts` 的 `ThreadSearch.search`，失敗拋 `ThreadSearchError`。
   *
   * **缺席就是清單上沒掛 `thread-search` 那一列**（`disabled: true`）：查詢合法時一律回 `not_supported`，連沒有東西可搜
   * 也是，同 dsh 沒掛 `sessionQuery`（`packages/api/session-controller/src/list.ts:170-177`，`477b4f4`）。掛了但沒接落盤、
   * 或設成 `openAt: never`，由它自己回空或拋，不在這裡判。**同 {@link listThreads}，它不准碰 {@link createAgent}**。
   */
  searchThreads?(query: unknown, signal: AbortSignal): Promise<ThreadSearchResult>;
  /**
   * `@` 引用別的會話的候選（`GET /threads/:id/session-references`，[#713](https://github.com/DemianLi/nexus-agent/issues/713)），選配。
   * 實作是 `session-reference-candidates.ts` 的 `SessionReferenceCandidates.list`。
   *
   * **缺席就是沒接落盤**：路由回 `{ available: false }`，web 整個不列會話那兩段。**同 {@link listThreads}，它不准碰 {@link createAgent}**——
   * 為了列候選把提問的那條 thread 建起來是反的。取消（web 每打一個字就取消上一次）時照樣拋出去，由載體收掉。
   *
   * @param threadId - 提問的那條 thread：候選不含它自己。
   */
  listSessionReferences?(
    threadId: string,
    query: string,
    signal: AbortSignal,
  ): Promise<readonly SessionReferenceCandidate[]>;
  /**
   * 精確讀一條被 `@` 的會話（[#713](https://github.com/DemianLi/nexus-agent/issues/713) 的準備那一半），選配。實作是
   * `session-reference-candidates.ts` 的 `SessionReferenceCandidates.read`，交給每條 thread 的 pump。
   *
   * **缺席就是這台 server 不收引用**：帶引用的 `run.start`／`queue.update` 回 `invalid_argument`，不悄悄收下再不展開。
   * 與 {@link listSessionReferences} 同進同出（都來自落盤的會話根），分開兩格是因為手搭的組裝可以只給其中一個。
   */
  readonly sessionReferenceReader?: SessionReferenceReader;
  /**
   * 瀏覽器會話的驗證（[#424](https://github.com/DemianLi/nexus-agent/issues/424)）。
   *
   * **必填，沒有「不驗」的選項**：這條線上每一條路由都能以 serve 擁有者的身分操作 agent，
   * 一個可以省略的開關遲早會被產品組裝省略。測試換的是密鑰（`fixtures.ts` 的 `TEST_BROWSER_AUTH`），
   * 不是這道檢查。
   */
  readonly auth: WireAuth;
  /**
   * 交付檔的三個上限，來自 plugin 清單上 `#settings/deliverable-files` 那一列
   * （[#529](https://github.com/DemianLi/nexus-agent/issues/529)）。
   *
   * **選配，省略即那一列 schema 的預設值**——同 `BrowserAuth` 的有效期那一格，省略是給手搭的
   * 測試用的，拿到的跟出貨清單一模一樣。產品路徑由 `serve.ts` 在起動期 `startupSetting` 解出來
   * 傳進來。
   *
   * **它是 server 的性質，所以在這裡而不是在 `ThreadAgent` 上**：這兩支方法住在這個閉包裡、
   * 一個 server 一次，`threadId` 是它們的參數。放進 `ThreadAgent` 會讓「每條 thread 的交付上限
   * 可以不同」變成一個可表達而沒有意義的狀態。
   */
  readonly deliverableLimits?: DeliverableFilesConfig;
  /**
   * 工具結果 meta 與壓縮摘要放上線的上限（[#538](https://github.com/DemianLi/nexus-agent/issues/538)；結果文字自 #736 起不截）。
   *
   * **兩個消費點都在這個閉包底下**：即時那條走 `new ThreadPump(...)`，重播那條走
   * `historyPage(...)`。省略即 schema 的預設。
   */
  readonly toolTextLimits?: ToolTextConfig;
  /**
   * 退回標題的兩個上限（[#647](https://github.com/DemianLi/nexus-agent/issues/647)）。消費點與 {@link toolTextLimits}
   * 一樣是這個閉包底下的兩個：即時那條（pump 寫標題），重播那條（18 以前的日誌當場推）。省略即 schema 的預設。
   */
  readonly threadTitleLimits?: ThreadTitleLimits;
  /**
   * 插件投影 frame 的合併視窗毫秒（`projection-flush` 那一列，[#1071](https://github.com/DemianLi/nexus-agent/issues/1071)）。
   * 每條 thread 的 pump 吃同一個數字。省略即合併器的預設。
   */
  readonly projectionFlushMs?: number;
  /**
   * 這台 server 講話的地方，選配（[#479](https://github.com/DemianLi/nexus-agent/issues/479)）。
   *
   * **今天有三件事走到它**，加它的理由都很窄——發生時回應照樣是 200、畫面照樣對，不講就完全看不見：
   *
   * - 一頁歷史的位元組上限是**軟的**（單獨一輪就超標時不從輪中間切，見 `conversation-history.ts` 的 `fitBytes`）。
   * - 退回標題寫不進去（[#647](https://github.com/DemianLi/nexus-agent/issues/647)）：那一輪照跑，同 dsh；經 pump 的建構子傳下去。
   * - 模型標題寫不成（[#650](https://github.com/DemianLi/nexus-agent/issues/650)）：留著退回標題，同上。
   *
   * 缺席就是不講，測試不必為它接線。
   */
  warn?(message: string): void;
  /**
   * 附件儲存（`POST /threads/:id/uploads`，[#732](https://github.com/DemianLi/nexus-agent/issues/732)），選配。
   *
   * **缺席就是這個組裝沒有附件儲存**（手搭的組裝、沒有 harness home 的測試）：上傳路徑回 `not_supported`，web 據這個碼把附件列藏起來。
   */
  readonly attachments?: AttachmentStore;
  /**
   * 單次上傳的位元組上限，選填；超過回 `invalid_argument`、什麼都不留。**省略就沒有上限**，同 dsh 的 `file-upload`
   * （`http-route.ts` 串流收、沒有上限）：位元組串流進暫存檔、不聚合，吃的是磁碟不是記憶體。
   */
  readonly maxUploadBytes?: number;
}

/** wire 只需要知道「這個請求帶的會話有沒有效」。`BrowserAuth` 滿足它。 */
export interface WireAuth {
  isAuthenticated(headers: Headers): boolean;
}

export interface WireHandler {
  handle(request: Request): Promise<Response>;
  /** 收掉所有 thread 的下行，並把每個 thread 的 agent 清乾淨。 */
  close(): Promise<void>;
}

const JSON_MEDIA_TYPE = 'application/json';

/** 請求本文轉成依序的位元組塊，給附件儲存串流收（沒有 body 就是空的）。 */
async function* requestBodyChunks(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<Uint8Array> {
  if (body === null) return;
  const reader = body.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      yield chunk.value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** 契約已合、實作還沒做的 RPC method 回 `not_supported` 時的說明（#723、#633），實作落地時隨分支一起拿掉。 */
const NOT_IMPLEMENTED = {
  'thread.pin': '這個組裝還沒有伺服器端的釘選',
  'thread.unpin': '這個組裝還沒有伺服器端的釘選',
  'thread.archive': '這個組裝還沒有伺服器端的封存',
  'thread.unarchive': '這個組裝還沒有伺服器端的封存',
  'thread.rename': '這個組裝還沒有伺服器端的改名',
  'subagent.list': '這個組裝還沒有可點名的子代理清單',
} as const;

/** 搜尋失敗怎麼上線。`disabled` 同 dsh 的 `SESSION_QUERY_SEARCH_DISABLED`：web 收到就退回只比標題。 */
const SEARCH_ERROR_CODES: Record<ThreadSearchErrorKind, WireErrorCode> = {
  invalid: 'invalid_argument',
  disabled: 'not_supported',
  failed: 'unknown_error',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': `${JSON_MEDIA_TYPE}; charset=utf-8` },
  });
}

/**
 * 軌跡按需細節認的子代理編號（前景的是 `tools:<uuid>`，背景的是 `bg-<hex>`），當檔名的一段用之前先過這一關：
 * 不含路徑分隔符與點，長度有上限。**不只認背景的**——軌跡投影（#1070）連前景子代理也展開了。
 */
const SUBAGENT_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

/** 一頁歷史的三個查詢參數（root 的與背景子代理的共用）；不是整數就回現成的 `invalid_argument` 回應。 */
function historyQueryOf(search: URLSearchParams): ThreadHistoryQuery | Response {
  const query: ThreadHistoryQuery = {};
  for (const key of ['maxMessages', 'beforeSeq', 'throughSeq'] as const) {
    const raw = search.get(key);
    if (raw === null) continue;
    const value = Number(raw);
    if (raw.trim() === '' || !Number.isSafeInteger(value)) {
      return json(
        errorResponse(null, 'invalid_argument', `${key} 不是整數：${JSON.stringify(raw)}`),
      );
    }
    (query as Record<string, number>)[key] = value;
  }
  return query;
}

/**
 * `/threads/:id/stream`、`/threads/:id/uploads`、`/threads/:id/history`、`/threads/:id/subagents/:runId/history`、`/threads/:id/file-references`、`/threads/:id/session-references`、
 * `/threads/:id/changes/{summary,diff}` 或
 * `/threads/:id/commands/:method`，都不是就 undefined。
 */
function parsePath(
  pathname: string,
):
  | { readonly kind: 'stream'; readonly threadId: string }
  | { readonly kind: 'history'; readonly threadId: string }
  | { readonly kind: 'subagent-history'; readonly threadId: string; readonly runId: string }
  | { readonly kind: 'trajectory-turn'; readonly threadId: string }
  | { readonly kind: 'file-references'; readonly threadId: string }
  | { readonly kind: 'session-references'; readonly threadId: string }
  | { readonly kind: 'upload'; readonly threadId: string }
  | { readonly kind: 'changes-summary'; readonly threadId: string }
  | { readonly kind: 'changes-diff'; readonly threadId: string }
  | { readonly kind: 'command'; readonly threadId: string; readonly method: string }
  | undefined {
  const segments = pathname.split('/').filter((segment) => segment !== '');
  if (segments[0] !== 'threads' || segments[1] === undefined) {
    return undefined;
  }
  const threadId = decodeURIComponent(segments[1]);
  if (segments.length === 3 && segments[2] === 'stream') {
    return { kind: 'stream', threadId };
  }
  if (segments.length === 3 && segments[2] === 'history') {
    return { kind: 'history', threadId };
  }
  if (
    segments.length === 5 &&
    segments[2] === 'subagents' &&
    segments[3] !== undefined &&
    segments[4] === 'history'
  ) {
    return { kind: 'subagent-history', threadId, runId: decodeURIComponent(segments[3]) };
  }
  if (segments.length === 4 && pathname === trajectoryTurnPath(threadId)) {
    return { kind: 'trajectory-turn', threadId };
  }
  if (segments.length === 3 && pathname === fileReferencesPath(threadId)) {
    return { kind: 'file-references', threadId };
  }
  if (segments.length === 3 && pathname === sessionReferencesPath(threadId)) {
    return { kind: 'session-references', threadId };
  }
  if (segments.length === 3 && pathname === uploadPath(threadId)) {
    return { kind: 'upload', threadId };
  }
  if (segments.length === 4 && segments[2] === 'changes') {
    if (pathname === changesSummaryPath(threadId)) return { kind: 'changes-summary', threadId };
    if (pathname === changesDiffPath(threadId)) return { kind: 'changes-diff', threadId };
  }
  if (segments.length === 4 && segments[2] === 'commands' && segments[3] !== undefined) {
    return { kind: 'command', threadId, method: segments[3] };
  }
  return undefined;
}

/**
 * 這個請求的本文要怎麼讀（照 dsh `client/connection` 的 `requestBodyMode`，`http-bridge.ts`）：
 * `buffered` 先收完整份、有總量上限（JSON 路由）；`streaming` 不聚合、不受那個上限管，由路由自己負責落地與取消。
 * 今天只有上傳是 `streaming`——位元組不是 JSON，不該為了它在行程裡先留一份整檔。
 *
 * @param method - HTTP 方法。
 * @param pathname - 請求路徑（不含 query）。
 */
export function wireRequestBodyMode(method: string, pathname: string): 'buffered' | 'streaming' {
  if (method !== 'POST') return 'buffered';
  try {
    return parsePath(pathname)?.kind === 'upload' ? 'streaming' : 'buffered';
  } catch {
    // `decodeURIComponent` 遇到壞的百分號編碼會拋；那個請求之後會被當成 404，本文照 buffered 收。
    return 'buffered';
  }
}

const NUMERIC = /^\d+$/;

/** 查詢字串裡的一個非負整數座標，照 dsh `present-open.ts` 的 `coordinate`。 */
function coordinate(value: string | null): number | undefined {
  return value !== null && NUMERIC.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : undefined;
}

/** `changes` 兩條路由的回應：錯誤協定照 dsh，純文字加 HTTP status；成功是 JSON。一律不快取。 */
function changesResponse(body: unknown, status = 200): Response {
  return status === 200
    ? new Response(JSON.stringify(body), {
        status,
        headers: {
          'content-type': `${JSON_MEDIA_TYPE}; charset=utf-8`,
          'cache-control': 'no-store',
        },
      })
    : new Response(String(body), { status, headers: { 'cache-control': 'no-store' } });
}

/**
 * 一個拒絕的理由對到命令通道上的哪個碼（[#747](https://github.com/DemianLi/nexus-agent/issues/747)）。
 *
 * **值域是 wire 的 {@link DeliverableRefusalCode}**：寫一個 wire 沒有的字串當場編不過，而 wire 的碼清單是網頁分畫面的依據。
 * `bad-request` 不在裡面：參數本身不合格照 dsh 算閘道層的錯，回協定錯誤 `invalid_argument`，見 {@link deliverableFailure}。
 */
const DELIVERABLE_REFUSAL_CODE: Readonly<
  Record<Exclude<DeliverableRefusal, 'bad-request'>, DeliverableRefusalCode>
> = {
  'no-anchor': 'deliverable/no-anchor',
  'not-found': 'deliverable/not-found',
  'not-regular-file': 'deliverable/not-regular-file',
  'too-large': 'deliverable/too-large',
  'not-text': 'deliverable/not-text',
};

/**
 * 命令通道上的交付檔拒絕：業務上的拒絕是成功回應裡的 `{ ok: false, error: { code, … } }`（同回饋那幾支），
 * 參數不合格是協定錯誤 `invalid_argument`（dsh 的 `gateway/bad-request`）。`too-large` 帶上限數字，照 dsh。
 */
function deliverableFailure(
  id: number,
  refused: {
    readonly reason: DeliverableRefusal;
    readonly message: string;
    readonly maxBytes?: number;
  },
): Response {
  if (refused.reason === 'bad-request') {
    return json(errorResponse(id, 'invalid_argument', refused.message));
  }
  const code = DELIVERABLE_REFUSAL_CODE[refused.reason];
  const error: DeliverableReadError =
    code === 'deliverable/too-large'
      ? // 每個 `too-large` 的產生處都帶上限（頁、窗口、整檔三處由 `deliverable-files.test.ts` 釘住，整檔讀的當下長大那一處用同一個數字）；沒帶是那邊漏了，不是這裡編一個。
        { code, message: refused.message, maxBytes: refused.maxBytes ?? Number.NaN }
      : { code, message: refused.message };
  return json(successResponse(id, { ok: false, error }));
}

function requestedChannels(body: EventStreamRequest): readonly WireChannel[] | undefined {
  const { channels } = body;
  if (!Array.isArray(channels) || channels.length === 0 || !channels.every(isWireChannel)) {
    return undefined;
  }
  return channels;
}

/**
 * 一條 thread 在這台 server 上的全部狀態。
 *
 * 命令執行器**一條 thread 一個**，跟 CLI 的「一個 REPL 一個」是同一條規則——
 * `@nexus/plugin-commands` 的配套入口就是靠那件事在檢查 `command/run` 與
 * `command/done` 的配對。
 */
interface ThreadState {
  readonly pump: ThreadPump;
  readonly commands: Pick<CommandRegistrationPoint, 'find' | 'list'>;
  readonly executor: CommandExecutor;
  readonly feedback: FeedbackService | undefined;
  readonly workspaceChanges: WorkspaceChanges | undefined;
  readonly permissionPresets: { catalog(): PermissionCatalog } | undefined;
  readonly modelSelection: Pick<ModelSelectionHost, 'catalog' | 'state' | 'select'> | undefined;
  /**
   * 接回來那批事件的長度；沒續接就是 0（[#452](https://github.com/DemianLi/nexus-agent/issues/452)）。
   *
   * **它是一條分界線**：`seq < storedCount` 的事件是上一個行程寫的，所以這個行程手上的
   * {@link workspaceRoot} 不會自動是它們的錨——准不准拿它當錨，由
   * {@link resumedWorkspaceRoot} 在不在決定
   * （[#519](https://github.com/DemianLi/nexus-agent/issues/519)，判準與證明見
   * `locateAt` 的檔頭）。
   */
  readonly storedCount: number;
  /** 這一次組裝的工作區根，沒給 `--workspace` 就是 `undefined`。見 {@link ThreadAgent.workspaceRoot}。 */
  readonly workspaceRoot: string | undefined;
  /**
   * 接回來那份 header 記的工作區根，沒續接或沒記就是 `undefined`。
   * 見 {@link ThreadAgent.resumedWorkspaceRoot}。
   */
  readonly resumedWorkspaceRoot: string | undefined;
  /**
   * `@` 引用的列檔索引（[#651](https://github.com/DemianLi/nexus-agent/issues/651)），**沒給 `--workspace` 就是
   * `undefined`**，那時列檔回「不提供」、不碰磁碟。
   *
   * **一條 thread 一份，只聽 root 日誌的 `tool/result`**：dsh 是一個 agent 一份、各聽各的。子代理寫的檔，要等父那顆
   * `task` 的 `tool/result` 落在 root 日誌上才過期——dsh 那邊父 agent 的索引也是等到那一刻，所以逐格等價。
   */
  readonly fileSearch: WorkspaceFileSearch | undefined;
  /** 對單一背景子代理傳話、單獨停的控制面（#865）。這份組裝沒有背景派出就沒有。 */
  readonly background: BackgroundSubagentControl | undefined;
  /**
   * 有沒有一次 `slash.run` 還沒回來。
   *
   * **HTTP handler 本身沒有序列性**：`handle()` 是一次請求一次呼叫，兩個分頁同時打
   * `slash.run` 會同時走到同一個執行器上，而那正是配套入口會報成違規的交錯
   * （執行器自己的檔頭寫著那不是誤報）。REPL 的序列性是 readline 白送的，這條線沒有，
   * 所以在這裡明著擋。
   */
  slashInFlight: boolean;
  dispose(): Promise<void>;
}

/** 這張表以型別窮舉 `WireFeedbackRating`：聯集多一種評價，這裡不補就編不過，不會悄悄被擋在門外。 */
const RATINGS: Readonly<Record<WireFeedbackRating, true>> = { positive: true, negative: true };

function isRating(value: unknown): value is WireFeedbackRating {
  return typeof value === 'string' && Object.hasOwn(RATINGS, value);
}

function isCategory(value: unknown): value is FeedbackCategory {
  return typeof value === 'string' && (FEEDBACK_CATEGORIES as readonly string[]).includes(value);
}

/** 選填的一格：缺席、或合乎 `check` 的值。 */
function optional(value: unknown, check: (candidate: unknown) => boolean): boolean {
  return value === undefined || check(value);
}

const isString = (value: unknown): value is string => typeof value === 'string';

/**
 * 四個回饋 method 的回應（[#278](https://github.com/DemianLi/nexus-agent/issues/278)、
 * [#382](https://github.com/DemianLi/nexus-agent/issues/382)）。
 *
 * **參數在這裡驗**：這是線的邊界，瀏覽器送什麼都可能。規則本身（備註、版本、目標是不是 root 日誌裡的一則
 * 回覆）歸 `@nexus/plugin-feedback`，這裡原樣交過去：瀏覽器指名的訊息 id 就是日誌記的那個，沒有要換的。
 * 子代理的回覆在它自己那一份日誌裡，這裡交的是 root 那一份，所以評不到。
 */
/**
 * `model.catalog`／`model.select`（#723）。業務失敗（選不上）走成功回應的 `ok: false`，`ErrorResponse` 只給「這條線收不了」。
 *
 * 照 dsh `selectModel`：型錄沒有那顆、或帶了沒宣告的強度，在記進日誌之前就拒，選擇不變。
 */
function modelResponse(
  selection: ThreadState['modelSelection'],
  id: number,
  method: ModelMethod,
  body: unknown,
): unknown {
  if (selection === undefined) {
    return errorResponse(id, 'not_supported', '這個組裝沒有每會話的模型選擇（沒帶 --live）');
  }
  if (method === 'model.catalog') {
    return successResponse(id, {
      ok: true,
      value: { catalog: selection.catalog(), selection: selection.state() },
    });
  }
  const params = (body as { params?: unknown }).params;
  const p =
    typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
  if (
    typeof p.modelId !== 'string' ||
    p.modelId.length === 0 ||
    !(p.reasoningEffort === undefined || typeof p.reasoningEffort === 'string')
  ) {
    return errorResponse(
      id,
      'invalid_argument',
      'model.select 的 modelId 要是非空字串、reasoningEffort 要是字串',
    );
  }
  try {
    return successResponse(id, {
      ...selection.select({
        modelId: p.modelId,
        ...(typeof p.reasoningEffort === 'string' && { reasoningEffort: p.reasoningEffort }),
      }),
    });
  } catch (error) {
    return errorResponse(
      id,
      'invalid_argument',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function feedbackResponse(
  thread: ThreadState | undefined,
  id: number,
  method: FeedbackMethod,
  body: unknown,
): unknown {
  const service = thread?.feedback;
  if (thread !== undefined && service === undefined) {
    return errorResponse(id, 'not_supported', '這個組裝沒有掛回饋（@nexus/plugin-feedback）');
  }
  const params = (body as { params?: unknown }).params;
  if (typeof params !== 'object' || params === null) {
    return errorResponse(id, 'invalid_argument', `${method} 缺 params`);
  }
  const p = params as Record<string, unknown>;

  if (method === 'feedback.record') {
    if (!optional(p.text, isString) || !optional(p.category, isCategory)) {
      return errorResponse(
        id,
        'invalid_argument',
        'feedback.record 的 text 要是字串、category 要是七類之一',
      );
    }
    if (thread === undefined || service === undefined) {
      return errorResponse(id, 'invalid_argument', '這條 thread 還沒開過，沒有會話可以記回饋');
    }
    const result = service.record(thread.pump.sessionLog, {
      ...(typeof p.text === 'string' && { text: p.text }),
      ...(isCategory(p.category) && { category: p.category }),
    });
    return successResponse(id, { ...result });
  }

  if (method === 'feedback.list') {
    // 還沒開過的 thread 沒有日誌，也就沒有評分：回空的，不回錯（web 在任何一條 thread 上都會問）。
    if (thread === undefined || service === undefined) {
      return successResponse(id, { ok: true, value: { items: [] } });
    }
    return successResponse(id, { ...service.list(thread.pump.sessionLog) });
  }

  if (typeof p.messageId !== 'string' || p.messageId.length === 0) {
    return errorResponse(id, 'invalid_argument', `${method} 缺 messageId`);
  }
  const messageId = p.messageId;
  const notFound = { ok: false, error: { code: 'target-not-found', messageId } };

  if (method === 'feedback.delete') {
    if (typeof p.ifVersion !== 'string') {
      return errorResponse(id, 'invalid_argument', 'feedback.delete 缺 ifVersion');
    }
    if (thread === undefined || service === undefined) return successResponse(id, notFound);
    return successResponse(id, {
      ...service.delete(thread.pump.sessionLog, { messageId, ifVersion: p.ifVersion }),
    });
  }

  if (
    !isRating(p.rating) ||
    !optional(p.note, isString) ||
    !optional(p.category, isCategory) ||
    !(p.ifVersion === null || typeof p.ifVersion === 'string')
  ) {
    return errorResponse(
      id,
      'invalid_argument',
      'feedback.put 要 rating（positive／negative）、ifVersion（字串或 null），note 與 category 選填',
    );
  }
  if (thread === undefined || service === undefined) return successResponse(id, notFound);
  const result = service.put(thread.pump.sessionLog, {
    messageId,
    rating: p.rating,
    ...(typeof p.note === 'string' && { note: p.note }),
    ...(isCategory(p.category) && { category: p.category }),
    ifVersion: p.ifVersion,
  });
  return successResponse(id, { ...result });
}

export function createWireHandler(options: WireHandlerOptions): WireHandler {
  /**
   * 這台 server 的交付上限，**一個 server 解一次**。
   *
   * 省略時走 schema——`parse({})` 的答案就是那一列不寫 `config:` 時的答案，所以「手搭的測試」與
   * 「出貨清單」拿到的是同一份，不是兩份各自維護的預設值。
   */
  const deliverableLimits: DeliverableFilesConfig =
    options.deliverableLimits ?? deliverableFilesConfigSchema.parse({});
  // **解一次、兩個消費點共用同一份**：即時與重播對同一則結果要截得一模一樣，不然同一張卡會
  // 「即時一個樣、重新整理另一個樣」——那正是 `tool-result-text.ts` 存在的理由。
  const toolTextLimits: ToolTextConfig = options.toolTextLimits ?? toolTextConfigSchema.parse({});
  // 同上：兩個消費點共用同一份，寫的標題與推的標題才會一字不差。
  const threadTitleLimits: ThreadTitleLimits =
    options.threadTitleLimits ?? threadTitleConfigSchema.parse({});
  /**
   * **存的是 promise 不是狀態**，而且是同步就存進去的。
   *
   * 存已完成的狀態、在 `await createAgent` 之後才寫回去的話，同一條 thread 的兩個並行
   * 請求會各建一個 agent：後寫的那個覆蓋先寫的，先建的那一個**沒有人 dispose** ——
   * 而 MCP plugin 底下是 stdio 子行程。兩個分頁同時打開就到得了，而且不會有任何錯誤
   * 訊息。順帶一提，那也會讓下面那道序列閘失效：兩個請求手上是兩個不同的執行器。
   */
  const threads = new Map<string, Promise<ThreadState>>();
  /**
   * 已經建好的那些，同步讀得到。**給列表用**：它要知道哪幾條正在跑，但不能等一條還在建的 thread
   * ——`createAgent` 可能要起 MCP 子行程，列表不該被它拖住。還在建的就是還沒在跑。
   *
   * **沒有逐條刪除是對的**：進得了這張表的，是 `threadFor` 已經走完、不會再失敗的 thread（失敗那條路在
   * `set` 之前），而 thread 只在 `close()` 一起收，那裡整張清掉。哪天有了逐條收 thread 的路，要跟著刪。
   */
  const ready = new Map<string, ThreadState>();
  /** 全部 thread 共用的那條下行（#632）。每條 pump 一建好就接上，見 `thread-feed.ts`。 */
  const feed = new ThreadFeed();
  /**
   * 上傳收據（[#732](https://github.com/DemianLi/nexus-agent/issues/732)）：thread → 收據 id → 存好的檔案參照。
   * **收據只在收下它的那條 thread 有效**（查表以 thread 為鍵，拿別條 thread 的收據查不到），行程重開就失效——沒送出去的上傳不續命。
   * 收據是不透明的隨機 id，不是內容雜湊：知道某個檔的雜湊不等於有權把它掛進這條 thread 的訊息。
   */
  const receipts = new Map<string, Map<string, FileAttachmentRef>>();

  function threadFor(threadId: string): Promise<ThreadState> {
    const existing = threads.get(threadId);
    if (existing !== undefined) {
      return existing;
    }
    const created = (async (): Promise<ThreadState> => {
      const threadAgent = await options.createAgent(threadId);
      // **從這裡到回傳之間拋錯，要把剛建好的 agent 收掉。** 下面說好「下一次請求該重試」，
      // 而續接的 thread 在 `createAgent` 裡就拿了寫租約——沒人收的話，重試撞上的是**自己
      // 上一次**留下的租約。收 agent 也順便收掉它底下的東西（MCP 的子行程之類）。
      let detachFeed: (() => void) | undefined;
      try {
        // **三個東西互相要對方，所以綁定是延後的**：port 要日誌（pump 才有）與 flush
        // （協調器才有），而 pump 的建構參數就是 port。這個格子把環打開——兩個 getter
        // 讀它，而它在 pump 與協調器各自建好之後才被填上。
        //
        // **排程器第一次問這兩格是在第一輪落定的時候**，那時兩個都填好了。
        const late: { log?: SessionLog; flush?: () => Promise<void> } = {};
        const driver = threadAgent.goalDriver?.(
          () => {
            const log = late.log;
            /* v8 ignore next -- pump 在下一行就建好，而排程器最早在第一輪落定時才問 */
            if (log === undefined) throw new Error('這條 thread 的日誌還沒建好');
            return log;
          },
          async () => void (await late.flush?.()),
        );
        const pump = new ThreadPump(
          threadAgent.agent,
          threadId,
          driver,
          threadAgent.rootSeed,
          toolTextLimits,
          threadTitleLimits,
          (message) => options.warn?.(message),
          threadAgent.stepInbox === true,
          options.sessionReferenceReader,
          threadAgent.projections?.list(),
          // 上一個行程留下的子代理日誌（#1028）：只有註冊了要折子代理的單元、又接了落盤才讀，見 `projection-children.ts`。
          await readProjectionChildSeeds(
            threadId,
            threadAgent.rootSeed,
            threadAgent.projections?.list() ?? [],
            options.readSubagentSession,
            options.warn,
          ),
          options.projectionFlushMs,
        );
        // **緊接著建好就接上全域下行**（#632）：在它收下任何一件之前，狀態與中斷一顆都不漏。
        detachFeed = feed.attach(pump);
        late.log = pump.sessionLog;
        // 遙測、不變量、參與者一個口接完（#668）；順序與「參與者寫的會被檢查看到」的保證見 `AttachSessions`。
        // 背景子代理結算了，通知這條 thread 的主對話（#840）：閒著就叫醒它開一輪，見 `ThreadPump.notifySettled`。
        const attachment = threadAgent.attachSessions(pump.sessions, {
          onSettled: (settlement) =>
            pump.notifySettled({
              text: settlement.text,
              summary: settlement.summary,
              reason: settlement.reason,
              senderSessionId: settlement.sessionId,
            }),
          // 背景子代理寫來的話（#849）：同一條路，來源是 `agent-message`（agent 寫的，不是人說的）。
          onMessage: (message) =>
            pump.receiveAgentMessage({ text: message.text, senderSessionId: message.sessionId }),
          // 現況變了（#867）：整份送下行，新接上的下行補送最後一份。
          onStatus: (items) => pump.notifySubagentStatus(items),
        });
        // **接在最後，理由同 `cli.ts`**：上面那個口接的三件事是觀察者，落盤不改變任何人看得到什麼，
        // 所以順序在功能上沒有差別；排最後是為了讓讀的人看到的因果跟實際一致。
        const persistence = threadAgent.attachPersistence?.(pump.sessions);
        // **沒開落盤時 `flush` 就整個缺席**，而不是一個假裝成功的 no-op：`late.flush?.()`
        // 的缺席語意就是「這條路上沒有耐久檢查點」，同 `attachPersistence` 自己的規矩。
        late.flush = persistence === undefined ? undefined : () => persistence.flush();
        // **LLM 標題接在落盤之後**，同 `cli.ts`：它寫的兩顆照常落地。只接 root，子代理的日誌不排。
        const detachTitle = threadAgent.attachTitle?.(pump.sessionLog, (message) =>
          options.warn?.(`[標題] thread ${threadId} ${message}`),
        );
        // **列檔索引跟 pump 同一刻建**：它要聽的是這條 thread 的 root 日誌，而那份日誌在這裡誕生。
        const fileSearch =
          threadAgent.workspaceRoot === undefined
            ? undefined
            : new WorkspaceFileSearch(threadAgent.workspaceRoot);
        const unsubscribeFileSearch = fileSearch
          ? pump.sessionLog.subscribe((event) => {
              if (event.type === 'tool/result') fileSearch.invalidate();
            })
          : undefined;
        const state: ThreadState = {
          pump,
          commands: threadAgent.commands,
          // **建在這裡**：日誌是 pump 建的（一個 thread 一份），而這一行正是它誕生的地方
          // ——跟上面兩條接線同一個位置，理由也同一個。
          executor: createCommandExecutor({
            commands: threadAgent.commands,
            sessionLog: pump.sessionLog,
            // 命令要送的話跟 `run.start` 收的話同一道驗（#713）：引用不能用就讓命令在動任何東西之前失敗。
            acceptSteer: (text) => void pump.referencedText(text),
          }),
          feedback: threadAgent.feedback,
          workspaceChanges: threadAgent.workspaceChanges,
          permissionPresets: threadAgent.permissionPresets,
          modelSelection: threadAgent.modelSelection,
          // **就是 seed 的長度**，不另外傳一個數字：兩個來源各記一次的話，有一天它們會不一樣，
          // 而那時錯的方向是「把重播的事件當成這個行程寫的」——靜靜讀到另一個工作區的同名檔。
          storedCount: threadAgent.rootSeed?.length ?? 0,
          workspaceRoot: threadAgent.workspaceRoot,
          resumedWorkspaceRoot: threadAgent.resumedWorkspaceRoot,
          fileSearch,
          background: attachment.background,
          slashInFlight: false,
          dispose: async () => {
            detachFeed?.();
            // **標題最先拆**：它在任何一輪之外寫日誌，拆掉會中止還在跑的那一次，之後回來的寫不進去
            // （同 dsh 的會話拆卸）。排在參與者前面，理由同下一條：寫得動日誌的先停手。
            await detachTitle?.();
            // **列檔索引接著收**，同 dsh 在 `agent/disposed` 上收它：中止還在背景跑的走訪，之後的查詢回空。它不寫日誌，
            // 所以排在寫得動日誌的那幾個之間哪裡都不改變誰看到什麼。
            unsubscribeFileSearch?.();
            fileSearch?.dispose();
            // 參與者、不變量、遙測三個一起收，順序（參與者先、遙測最後）住在 `createCliAgent` 的 `attachSessions`。
            await attachment.detach();
            // **落盤收在 agent 之前，但這一行的依據跟上面三條不一樣，別讀成驗過的因果。**
            // 「有這一行」是量出來的（拿掉它，`serve` 那組落盤斷言會紅）；「排在
            // `threadAgent.dispose()` 之前」是預防，今天的組裝分不出兩種順序——同
            // `cli.ts` 關機那兩行的處境與措辭。
            await persistence?.dispose();
            await threadAgent.dispose();
          },
        };
        ready.set(threadId, state);
        return state;
      } catch (error) {
        // 建不起來的那條不留在全域下行上：它的中斷永遠答不到。
        detachFeed?.();
        await threadAgent.dispose().catch(() => {});
        throw error;
      }
    })();
    // 建不起來就不要把失敗記在那個 thread 上——下一次請求該重試，不是永遠拿到同一個錯。
    const tracked = created.catch((error: unknown) => {
      threads.delete(threadId);
      throw error;
    });
    threads.set(threadId, tracked);
    return tracked;
  }

  /**
   * 這條 thread；**建不起來就回一個協定層的錯**，帶著原因。
   *
   * `handle()` 不接錯、`wire-server.ts` 也不接，所以讓 `threadFor` 的 rejection 往上冒的話，
   * 那個請求一個位元組都不回、client 永遠卡著，而那顆 rejection 沒有人處理。它屬於協定層：
   * 請求本身沒有錯，是這條 thread 起不來（壞掉的日誌、別的行程握著、目錄對不上……）。
   * 協定的錯誤碼裡沒有「thread 起不來」，最近的是 `unknown_error`——原因寫在 message 裡。
   *
   * @param threadId - 哪一條。
   * @param id - 回給哪一顆上行封包；下行那條沒有，是 `null`。
   * @returns 這條 thread，或一個已經包好的錯誤回應。
   */
  async function threadOrError(
    threadId: string,
    id: number | null,
  ): Promise<ThreadState | Response> {
    try {
      return await threadFor(threadId);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      return json(errorResponse(id, 'unknown_error', `這條 thread 建不起來：${reason}`));
    }
  }

  /**
   * `POST /threads/:id/uploads`（[#732](https://github.com/DemianLi/nexus-agent/issues/732)）：契約見 `@nexus/wire` 的 `attachments.ts`。
   * body 是原始位元組，**串流進附件儲存**（不聚合），回一張收據。沒開過的 thread 為它建起來（收據要綁在一條 thread 上）。
   */
  async function handleUpload(
    threadId: string,
    search: URLSearchParams,
    request: Request,
  ): Promise<Response> {
    const store = options.attachments;
    if (store === undefined) {
      return json(errorResponse(null, 'not_supported', '這個組裝沒有附件儲存，不收上傳'));
    }
    const thread = await threadOrError(threadId, null);
    if (thread instanceof Response) return thread;
    let ref: FileAttachmentRef;
    try {
      ref = await store.save({
        data: requestBodyChunks(request.body),
        name: search.get(UPLOAD_NAME_PARAM) ?? undefined,
        signal: request.signal,
        maxBytes: options.maxUploadBytes,
      });
    } catch (error: unknown) {
      if (error instanceof AttachmentError && error.code === 'ATTACHMENT_TOO_LARGE') {
        return json(errorResponse(null, 'invalid_argument', error.message));
      }
      const reason = error instanceof Error ? error.message : String(error);
      options.warn?.(`[上傳] thread ${threadId} 的上傳沒存成：${reason}`);
      return json(errorResponse(null, 'unknown_error', `上傳沒存成：${reason}`));
    }
    // 存的期間這條 thread 被收掉了（`close()`）：收據進不了表，回錯而不是發一張沒人認的收據。
    if (ready.get(threadId) !== thread) {
      return json(errorResponse(null, 'unknown_error', '這條 thread 在上傳完成前已經關閉'));
    }
    const receiptId = crypto.randomUUID();
    let own = receipts.get(threadId);
    if (own === undefined) {
      own = new Map();
      receipts.set(threadId, own);
    }
    own.set(receiptId, ref);
    const response: UploadResponse = {
      type: 'success',
      result: { receiptId, name: ref.name, bytes: ref.bytes },
    };
    return json(response);
  }

  function openStream(
    pump: ThreadPump,
    channels: readonly WireChannel[],
    signal: AbortSignal,
  ): Response {
    return sseResponse(pump.subscribe(channels, signal), encodeSseFrame);
  }

  /** `GET /threads/feed`（#632）：契約見 `@nexus/wire` 的 `THREAD_FEED_PATH`。不建任何一條 thread。 */
  function openFeed(signal: AbortSignal): Response {
    return sseResponse(feed.subscribe(signal), (frame) => encodeSseData(frame.type, frame));
  }

  function sseResponse<T>(
    events: AsyncGenerator<T, void, undefined>,
    encode: (value: T) => string,
  ): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // **開線就先吐一行 SSE 註解。** 沒有這一行的話，中間任何一層代理都可能把
        // header 壓著等第一顆 body byte——實測 Vite dev server 的 proxy 正是如此：
        // 直連拿得到 `200 text/event-stream`，經過它就一個位元組都不來，而瀏覽器那端
        // 看起來就是永遠「連線中」。**這一行今天的依據就是那次實測**——dsh 當初的
        // `sseResponse()` 也這樣做（「Send an SSE comment line on open so
        // clients/proxies see a live channel」），但那個套件在 HEAD `0a53fb55` 已經
        // 不在了，見檔頭。註解不是封包，解碼端本來就會跳過它。
        controller.enqueue(encoder.encode(': connected\n\n'));
      },
      async pull(controller) {
        const next = await events.next();
        if (next.done === true) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(encode(next.value)));
      },
      cancel() {
        void events.return(undefined);
      },
    });
    return new Response(body, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        // 代理層常見的 SSE 緩衝會把「串流」變成「一次吐完」，這一行是關掉它的慣例。
        'x-accel-buffering': 'no',
      },
    });
  }

  async function handleStream(
    threadId: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Response> {
    const request = body as EventStreamRequest;
    if (typeof request !== 'object' || request === null) {
      return json(errorResponse(null, 'invalid_argument', 'body 不是 EventStreamRequest'));
    }
    if (request.since !== undefined) {
      // **明確拒絕，不靜靜忽略。** 靜靜忽略會生出看不見的斷檔；重播要能做得先有
      // frame 的持久化。接回來的方式是重開這條線 ＋ 重抓歷史，照 dsh 的 v1。
      return json(
        errorResponse(null, 'not_supported', '這一版不支援 since 重播：重開下行並重抓歷史'),
      );
    }
    if (request.namespaces !== undefined || request.depth !== undefined) {
      return json(errorResponse(null, 'not_supported', '這一版不支援 namespace 過濾'));
    }
    const channels = requestedChannels(request);
    if (channels === undefined) {
      return json(errorResponse(null, 'invalid_argument', 'channels 必須是非空的白名單子集'));
    }
    const thread = await threadOrError(threadId, null);
    if (thread instanceof Response) return thread;
    return openStream(thread.pump, channels, signal);
  }

  async function handleCommand(
    threadId: string,
    method: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Response> {
    if (!isRpcMethod(method)) {
      return new Response('not found', { status: 404 });
    }
    // **信封先於內容**：協定的 `Command` 與斜線命令那兩支各有各的 params，但
    // `id` 與 `method` 是共通的，而下面那條路徑／封包的比對兩邊都受它管。
    const envelope = body as { id?: unknown; method?: unknown };
    if (typeof envelope !== 'object' || envelope === null || typeof envelope.id !== 'number') {
      return json(errorResponse(null, 'invalid_argument', 'body 不是上行封包'));
    }
    if (envelope.method !== method) {
      // dsh 的不變量：路徑指名 method、封包裡也帶 method，兩者不合就是錯誤。
      return json(
        errorResponse(
          envelope.id,
          'invalid_argument',
          `封包的 method "${String(envelope.method)}" 與路徑 "${method}" 不合`,
        ),
      );
    }

    if (isRunCancelMethod(method)) {
      // 中止這一輪（#276）：**受理就回，不等停穩**，停下來的事實走下行——照 dsh 的
      // `session.cancel` → `{ accepted: true }`。不查是哪個分頁送的（#265 的 Q3），也不看
      // `slashInFlight`：斜線命令有自己的中止路，`run.cancel` 只管 agent 這一輪（Q13）。
      //
      // **不經 `threadFor`**：那會替一條沒人開過的 thread 建一個 agent（連 MCP 子行程），
      // 只為了中止一件不存在的事。沒建過的就是閒著，照「閒著時中止什麼都不做」回受理。
      const existing = threads.get(threadId);
      if (existing !== undefined) {
        // 建到一半的等它建好再中止；建不起來的就沒有東西可停。
        const thread = await existing.catch(() => undefined);
        thread?.pump.cancel();
      }
      return json(successResponse(envelope.id, { accepted: true }));
    }
    if (isSubagentMethod(method)) {
      // 對單一背景子代理傳話、單獨停（#865）：**不經 `threadFor`**，同 `run.cancel`——host 是這條 thread 的 agent 的，
      // 沒建過的 thread 沒有任何背景子代理，不為了回「沒有」建一個 agent。重啟後的 thread 同樣沒有：host 的編號表在記憶體裡
      // （`send_message` 同一個限制）。
      const existing = threads.get(threadId);
      const thread = existing === undefined ? undefined : await existing.catch(() => undefined);
      return handleSubagentCommand(thread?.background, method, envelope.id, body);
    }
    if (isDeliverableMethod(method)) {
      return handleDeliverableCommand(threadId, method, envelope.id, body);
    }
    if (isFeedbackMethod(method)) {
      // 評分與評語（#278）：**不經 `threadFor`**，同 `run.cancel`——評的是這條 thread 上已經出現過
      // 的回覆，沒開過的 thread 沒有東西可評，不為了回一個 target-not-found 建一個 agent。
      // **也不看 `slashInFlight` 與「還在跑」**：跑著、停在核准點都能評（#267 的 Q10）。
      const existing = threads.get(threadId);
      const thread = existing === undefined ? undefined : await existing.catch(() => undefined);
      return json(feedbackResponse(thread, envelope.id, method, body));
    }
    if (isThreadManagementMethod(method) || isSubagentListMethod(method)) {
      // 釘選／封存／改名（#633）與可點名的子代理清單（#328）：**契約先合，實作還沒做**，一律 `not_supported`，web 據這個碼把
      // 釘選封存改名與 `@` 子代理藏起來。**不經 `threadFor`**，同 `run.cancel`：沒有東西可回，不為了回「還沒做」建一個 agent。
      // 契約在 `@nexus/wire` 的 `thread-management.ts`／`subagent-list.ts`；實作落地時把這個分支換成真的 handler。
      return json(errorResponse(envelope.id, 'not_supported', NOT_IMPLEMENTED[method]));
    }
    const thread = await threadOrError(threadId, envelope.id);
    if (thread instanceof Response) return thread;
    if (isModelMethod(method)) {
      // 每會話模型選擇（#723）：經 `threadFor`——選擇記在這條 thread 的日誌裡，web 打開一條 thread 才畫模型座。
      // 沒有型錄的組裝（沒帶 `--live`）回 `not_supported`，web 據這個碼把模型座藏起來。
      return json(modelResponse(thread.modelSelection, envelope.id, method, body));
    }
    if (isPermissionMethod(method)) {
      // 權限組合目錄（#437）：整台共用的一份，掛在這條 thread 的組裝上讀（目錄在 `permission-presets` 的 `apply` 當下定了）。
      // 經 `threadFor`：web 打開一條 thread 才畫權限選單，那條 thread 的組裝本來就要建。沒有目錄的組裝（沒圍堵、那一列沒掛）
      // 回 `not_supported`，web 據這個碼把選單藏起來。
      if (thread.permissionPresets === undefined) {
        return json(
          errorResponse(
            envelope.id,
            'not_supported',
            '這個組裝沒有具名的權限組合（沒給 --workspace）',
          ),
        );
      }
      return json(
        successResponse(envelope.id, {
          ok: true,
          value: { catalog: thread.permissionPresets.catalog() },
        }),
      );
    }
    if (isSlashMethod(method)) {
      return handleSlash(thread, method, envelope.id, body, signal);
    }
    if (isQueueUpdateMethod(method)) {
      return handleQueueUpdate(thread.pump, envelope.id, body);
    }

    // **窄到上行那兩支**：路徑已經是 `UPLINK_METHODS` 之一（`isRpcMethod` 減掉斜線那兩支與
    // `run.cancel`），
    // 而封包的 method 剛剛跟路徑比對過。少了這個窄化，下面的 `input.respond` 分支面對的
    // 是整個 `Command` union——那裡面有八個我們從不收的 method。
    const command = body as Extract<Command, { method: UplinkMethod }>;
    const { pump } = thread;
    if (command.method === 'run.start') {
      const params = command.params;
      if (typeof params?.assistant_id !== 'string') {
        return json(errorResponse(command.id, 'invalid_argument', 'run.start 缺 assistant_id'));
      }
      if (thread.slashInFlight) {
        // **擋的方向是雙向的。** 一次 `slash.run` 還在跑的時候起一輪，`/plan` 那格
        // pending intent 就會跟這一輪的 `beforeAgent` 賽跑——而那正是
        // `@nexus/plugin-plan-mode` 的偏離註記押著的那個前提（「命令一定跑在兩輪之間」）。
        return json(
          errorResponse(
            command.id,
            'invalid_argument',
            '這條 thread 正在跑一個斜線命令：等它回來再說下一句話',
          ),
        );
      }
      // **停在核准點時照收**（#637 的 Q4，同 dsh）：以前這裡回錯，因為基座會照跑新的一輪、把中斷靜靜丟掉。
      // 現在收下的這句進送出佇列，由 pump 停住，等中斷答完、那一輪收掉才跑（#629，`ThreadPump.#nextIndex`）。
      // 附件（#732）：契約先合，實作還沒做。**帶了就整句拒絕**，不悄悄收下文字、丟掉附件——使用者以為檔案送出去了。
      const attachments = (params as { attachments?: unknown }).attachments;
      if (attachments !== undefined) {
        if (!Array.isArray(attachments)) {
          return json(
            errorResponse(command.id, 'invalid_argument', 'run.start 的 attachments 要是陣列'),
          );
        }
        if (attachments.length > 0) {
          return json(errorResponse(command.id, 'not_supported', '這個組裝還不收附件'));
        }
      }
      // 點名子代理（#328 第 2 項）：同附件，契約先合、實作還沒做，**有值就整句拒絕**，不悄悄收下文字、丟掉點名。
      const mention = (params as { mention?: unknown }).mention;
      if (mention !== undefined) {
        return json(errorResponse(command.id, 'not_supported', '這個組裝還不能點名子代理'));
      }
      const text = firstHumanText(params.input);
      if (text === undefined) {
        return json(
          errorResponse(command.id, 'invalid_argument', 'run.start 的 input 沒有可用的訊息'),
        );
      }
      // `@` 的會話要能用才收（#713）：網址壞、引用自己、超過三條、這條 thread 不收引用，都在這裡回錯，那句話不進佇列。
      const referenceError = referenceRejection(pump, command.id, text);
      if (referenceError !== undefined) return json(referenceError);
      // 送出模式（#710）：我們加在協定 `RunStartParams` 上的一格，見 `@nexus/wire` 的 `RunStartCommand`。省略就是排隊。
      const mode = (params as { mode?: unknown }).mode;
      if (mode !== undefined && !(RUN_START_MODES as readonly unknown[]).includes(mode)) {
        return json(
          errorResponse(command.id, 'invalid_argument', 'run.start 的 mode 要是 queue 或 steer'),
        );
      }
      // **`run_id` 就是這一件在送出佇列裡的 id**：畫面據它對上自己送出的那一句（推送裡的 `claimed.id`，插話是
      // `claimedNextStep` 裡的那一件）。插話在這一輪不收時退成排隊，由 pump 決定，這裡不分。
      const runId = crypto.randomUUID();
      start(pump, {
        kind: 'message',
        text,
        id: runId,
        ...(mode === 'steer' ? { steer: true as const } : {}),
      });
      return json(successResponse(command.id, { run_id: runId }));
    }

    const params = command.params;
    if (params !== null && typeof params === 'object' && 'responses' in params) {
      // 協定的批次形（一次回答同一個 checkpoint 上的多個中斷）。同一輪確實會有多顆
      // 中斷，但**一顆一個 resume**（基座逐 task 派送，見 `thread-pump.ts` 的
      // `PumpInput.interruptId`），逐顆送就夠了，所以這個形狀明著不收。
      return json(
        errorResponse(command.id, 'not_supported', '這一版只收單一 interrupt 的 input.respond'),
      );
    }
    if (typeof params?.interrupt_id !== 'string') {
      return json(errorResponse(command.id, 'invalid_argument', 'input.respond 缺 interrupt_id'));
    }
    // **逐 id 認領，認不得就退回。** 這一道曾經是「跟目前掛著的那顆比對」，理由沒變：
    // 基座只認「有沒有中斷掛著」、不比對 id，實測拿掉之後一個**完全不存在**的
    // interrupt_id 照樣把掛著的那顆核准掉，工具真的跑了。差別在同一輪多顆之後，
    // 「不是最後那顆」不再等於「不存在」——第一顆是認得的，回答它是對的。
    const pending = pump.pendingFor(params.interrupt_id);
    if (pending === undefined) {
      return json(
        errorResponse(
          command.id,
          'no_such_interrupt',
          pump.awaitingInput
            ? `interrupt_id "${params.interrupt_id}" 不在這條 thread 掛著的那些中斷裡`
            : '這條 thread 上沒有等著回答的中斷',
        ),
      );
    }
    const decisions = (params.response as { decisions?: unknown } | null)?.decisions;
    if (
      pending.actionCount > 0 &&
      (!Array.isArray(decisions) || decisions.length !== pending.actionCount)
    ) {
      // 基座逐 index 把決定配到被中斷的工具呼叫上，長度不符當場拋——線上就是一顆
      // `lifecycle failed / root`，整條 thread 死在一個客戶端的 bug 上。擋在這裡。
      return json(
        errorResponse(
          command.id,
          'invalid_argument',
          `這顆中斷要 ${pending.actionCount} 筆決定，收到 ${Array.isArray(decisions) ? decisions.length : 0} 筆`,
        ),
      );
    }
    return json(
      successResponse(command.id, {
        run_id: start(pump, {
          kind: 'resume',
          interruptId: params.interrupt_id,
          response: params.response,
        }),
      }),
    );
  }

  /**
   * 斜線命令的發派面。**「發派面明文保證序列」就是這幾行。**
   *
   * REPL 那條線上的序列性是 readline 白送的（一行一輪，`execute` 回來之前不會有第二
   * 行），而 `@nexus/plugin-plan-mode` 的偏離註記正是押在那件事上：「命令一定跑在兩輪
   * 之間」。**web 不是序列的 REPL**——命令可以在 run 飛在半空時到，也可以在 thread 停
   * 在核准點時到，還可以兩個分頁同時到。所以三道都在這裡明著擋，而不是排隊：排隊會讓
   * `/plan` 的 pending intent 跟飛行中那一輪的 `beforeAgent` 賽跑，等於把一個已經標過
   * 的偏離再擴大一次（[#123](https://github.com/DemianLi/nexus-agent/issues/123)）。
   *
   * `slash.list` 不受這三道管：它只讀，沒有東西可以跟誰賽跑。
   */
  async function handleSlash(
    thread: ThreadState,
    method: SlashMethod,
    id: number,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Response> {
    if (method === 'slash.list') {
      const result: SlashListResult = { commands: thread.commands.list() };
      return json(successResponse(id, result));
    }

    const params = (body as { params?: { line?: unknown } }).params;
    if (typeof params?.line !== 'string') {
      return json(errorResponse(id, 'invalid_argument', 'slash.run 缺 line'));
    }
    if (thread.pump.awaitingInput) {
      return json(
        errorResponse(
          id,
          'invalid_argument',
          '這條 thread 停在核准點：先用 input.respond 回答它，再打斜線命令',
        ),
      );
    }
    if (thread.pump.running) {
      return json(
        errorResponse(id, 'invalid_argument', '這條 thread 正在跑：等這一輪跑完再打斜線命令'),
      );
    }
    if (thread.slashInFlight) {
      // 兩個分頁同時打。放行的話兩次執行會在日誌裡交錯，而配套入口會把那件事報成違規
      // ——**那是對的，不是誤報**（見 `createCommandExecutor` 的檔頭）。
      return json(
        errorResponse(id, 'invalid_argument', '這條 thread 上已經有一個斜線命令在跑：等它回來'),
      );
    }

    thread.slashInFlight = true;
    try {
      // **取消訊號就是發派它的那次請求的**：瀏覽器關掉分頁，這次執行也就沒有人要了。
      const execution = await thread.executor.execute(params.line, signal);
      if (execution === undefined) {
        // 語法不符或名字不認得。**日誌裡一個字都沒有**（執行器保證），線上也不是錯誤
        // ——封包是好的，只是那一行不是命令。
        return json(successResponse(id, { kind: 'unknown' } satisfies SlashRunResult));
      }
      const { commandId, result, steers } = execution;
      // **`command/done` 已經寫完了才開這一輪**（`CommandInvocation.steer` 的時刻承諾）：日誌上 `command/run` → `command/done`
      // 的配對先完整收掉，才有 `turn/start`。`slashInFlight` 這時還沒放，但它只擋斜線命令，不擋 `pump.submit`。
      // 每句一件、進送出佇列，順序就是命令呼叫 `steer` 的順序。
      for (const text of steers)
        start(thread.pump, { kind: 'message', text, id: crypto.randomUUID() });
      return json(
        successResponse(
          id,
          result.kind === 'success'
            ? ({
                kind: 'success',
                command_id: commandId,
                ...(result.text === undefined ? {} : { text: result.text }),
              } satisfies SlashRunResult)
            : ({
                kind: 'error',
                command_id: commandId,
                text: result.text,
              } satisfies SlashRunResult),
        ),
      );
    } catch (error) {
      // handler 自己拋的，或執行前後被中止。**日誌那側已經落定成一顆 `kind: 'error'` 的
      // `command/done`**（執行器在往外拋之前就寫完了），所以線上跟前一種形狀一樣——
      // 少的只有 `command_id`，理由見 `SlashRunResult`。
      return json(
        successResponse(id, {
          kind: 'error',
          text: error instanceof Error ? error.message : String(error),
        } satisfies SlashRunResult),
      );
    } finally {
      thread.slashInFlight = false;
    }
  }

  /**
   * 起一輪，然後**立刻**回。上行的回應是收件回條，不是「跑完了」——跑出來的東西
   * 走下行。這一輪炸掉的話原因已經以 `lifecycle failed` 上了線，這裡只負責不讓它
   * 變成 unhandled rejection。
   *
   * **射程只有 `submit` 回的這一顆。** 基座 v3 投影裡那些沒人讀的 promise（工具本體拋錯時 reject）
   * 不經過這裡，由 `ThreadPump` 在拿到 run 物件時標掉（#346）。
   */
  function start(pump: ThreadPump, input: Parameters<ThreadPump['submit']>[0]): string {
    void pump.submit(input).catch(() => undefined);
    return crypto.randomUUID();
  }

  /** 這句話裡的引用收不收（#713）：不收就是一則 `invalid_argument`，帶 {@link SessionReferenceError} 的說法。 */
  function referenceRejection(pump: ThreadPump, id: number | null, text: string) {
    try {
      pump.referencedText(text);
      return undefined;
    } catch (error: unknown) {
      if (!(error instanceof SessionReferenceError)) throw error;
      return errorResponse(id, 'invalid_argument', `${error.code}: ${error.message}`);
    }
  }

  /**
   * `subagent.send`／`subagent.interrupt`（[#865](https://github.com/DemianLi/nexus-agent/issues/865)）。語意與錯誤碼見
   * `SUBAGENT_SEND_METHOD`。**授權就是進得到這裡的會話認證**：host 只認得這條 thread 自己派出去的編號，所以「只能對直接
   * parent 派出去的子代理動手」是結構保證，這裡不另做一道。
   */
  function handleSubagentCommand(
    background: BackgroundSubagentControl | undefined,
    method: 'subagent.send' | 'subagent.interrupt',
    id: number,
    body: unknown,
  ): Response {
    const params = (body as { params?: unknown }).params as
      { run_id?: unknown; text?: unknown } | null | undefined;
    if (typeof params?.run_id !== 'string' || params.run_id === '') {
      return json(errorResponse(id, 'invalid_argument', `${method} 缺 run_id`));
    }
    const accepted = () => json(successResponse(id, { accepted: true }));
    if (method !== SUBAGENT_SEND_METHOD) {
      // 不認得的、沒在跑的、沒有背景派出：被接受的 no-op（dsh 的 `interruptByParent`），不讓呼叫端靠回應試探編號。
      background?.interrupt(params.run_id);
      return accepted();
    }
    // 同 `queue.update` 的 edit，也同 dsh 的 `hasPromptContent`：只有空白不算一句話。**不展開 `@` 引用**——那是 `run.start`
    // 的事，傳給子代理的是原文。
    if (typeof params.text !== 'string' || params.text.trim() === '') {
      return json(errorResponse(id, 'invalid_argument', `${method} 要有非空白的 text`));
    }
    if (background === undefined) {
      return json(errorResponse(id, SUBAGENT_NOT_FOUND, `沒有編號 ${params.run_id} 的背景子代理`));
    }
    try {
      background.sendFromUser(params.run_id, params.text);
    } catch (error) {
      if (!(error instanceof BackgroundSubagentError)) throw error;
      const code =
        error.code === 'not-found'
          ? SUBAGENT_NOT_FOUND
          : error.code === 'at-capacity'
            ? SUBAGENT_AT_CAPACITY
            : SUBAGENT_CLOSED;
      return json(errorResponse(id, code, error.message));
    }
    return accepted();
  }

  /**
   * 改或刪送出佇列裡排著的一件（`queue.update`，[#637](https://github.com/DemianLi/nexus-agent/issues/637)）。
   *
   * **經 `threadFor`**，不學 `run.cancel` 那種「沒建過就當沒有」：dsh 的 `updateQueue` 會把冷的 agent 接回來
   * （`resolveAgent`），而重啟之後停住的佇列就在一條還沒建的 thread 上——不接回來的話它改不動。**也不看
   * `slashInFlight` 與 `awaitingInput`**：跑著、停在核准點、停住時都能改能刪。
   */
  function handleQueueUpdate(pump: ThreadPump, id: number, body: unknown): Response {
    const params = (body as { params?: unknown }).params as
      { item_id?: unknown; action?: { kind?: unknown; text?: unknown } | null } | null | undefined;
    if (typeof params?.item_id !== 'string') {
      return json(errorResponse(id, 'invalid_argument', 'queue.update 缺 item_id'));
    }
    const kind = params.action?.kind;
    let action: QueueAction;
    if (kind === 'steer') {
      // 排著的那一件改成插話（#710）：收不收由 pump 照 dsh 的條件判，見 `ThreadPump.updateQueue`。
      action = { kind: 'steer' };
    } else if (kind === 'remove') {
      action = { kind: 'remove' };
    } else if (kind === 'edit') {
      const text = params.action?.text;
      // 同 dsh 的 `hasPromptContent`：只有空白不算一句話。
      if (typeof text !== 'string' || text.trim() === '') {
        return json(errorResponse(id, 'invalid_argument', 'queue.update 的 edit 要有非空白的文字'));
      }
      const referenceError = referenceRejection(pump, id, text);
      if (referenceError !== undefined) return json(referenceError);
      action = { kind: 'edit', text };
    } else {
      return json(
        errorResponse(id, 'invalid_argument', 'queue.update 的 action 要是 edit、remove 或 steer'),
      );
    }
    const outcome = pump.updateQueue(params.item_id, action);
    if (outcome === 'not-found') {
      return json(
        errorResponse(id, QUEUE_ITEM_NOT_FOUND, `"${params.item_id}" 已經不在送出佇列裡`),
      );
    }
    if (outcome === 'steer-unavailable') {
      return json(
        errorResponse(
          id,
          STEER_UNAVAILABLE,
          `"${params.item_id}" 現在不能改成插話：這一輪不收插話了，或它已經是插話`,
        ),
      );
    }
    return json(successResponse(id, { accepted: true }));
  }

  /**
   * `GET /threads`。**不經 `threadFor`**：一條 thread 都不為列表建（同 `run.cancel` 的理由，而且這裡更嚴——
   * 列的正是還沒開起來的那些）。讀不動整個目錄是協定層的錯，同 `threadOrError` 的分寸。
   */
  async function handleList(signal: AbortSignal): Promise<Response> {
    if (options.listThreads === undefined) {
      return json(
        errorResponse(
          null,
          'not_supported',
          '這台 server 的會話日誌只在記憶體裡（沒接落盤：清單上 session-persistence 那一列沒掛上），以前的 thread 列不出來',
        ),
      );
    }
    let stored: StoredThreadList;
    try {
      stored = await options.listThreads(signal);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      return json(errorResponse(null, 'unknown_error', `以前的 thread 列不出來：${reason}`));
    }
    const response: ThreadListResponse = {
      type: 'success',
      result: {
        unreadable: stored.unreadable,
        items: stored.items.map((item) => ({
          ...item,
          // 同全域下行的狀態（#632）：停在等人回答也算在跑，兩邊是同一個判準。
          running: ready.get(item.threadId)?.pump.agentRunning ?? false,
        })),
      },
    };
    return json(response);
  }

  /**
   * `POST /threads/search`（#631）。**不經 `threadFor`**，同列表。先後見 `@nexus/wire` 的 `THREAD_SEARCH_PATH`。
   */
  async function handleSearch(body: unknown, signal: AbortSignal): Promise<Response> {
    const query = (body as { query?: unknown } | null)?.query;
    let result: ThreadSearchResult;
    try {
      if (options.searchThreads === undefined) {
        // 查詢不合法的話先講那一條，同 dsh 在問提供方之前先正規化（`list.ts:164`）。
        normalizeThreadSearchQuery(query);
        return json(
          errorResponse(
            null,
            'not_supported',
            '這台 server 沒掛會話內容搜尋（清單上 thread-search 那一列沒掛上），只能比標題',
          ),
        );
      }
      result = await options.searchThreads(query, signal);
    } catch (error: unknown) {
      if (!(error instanceof ThreadSearchError)) {
        const reason = error instanceof Error ? error.message : String(error);
        return json(errorResponse(null, 'unknown_error', `搜尋失敗：${reason}`));
      }
      return json(errorResponse(null, SEARCH_ERROR_CODES[error.kind], error.message));
    }
    const response: ThreadSearchResponse = { type: 'success', result };
    return json(response);
  }

  /**
   * `GET /threads/:id/history`（#306）。**經 `threadFor`**，跟列表相反：照 dsh 的 `session.follow` 開的是那條
   * session，而 web 拿歷史之前已經開了下行、這條 thread 本來就建起來了。
   *
   * **讀的是記憶體裡那份 root 日誌，不讀檔**：它含上一個行程留下的 seed（`SessionLog` 建構時接上），也含這個
   * 行程寫的、還沒落盤的那幾筆——讀檔的話那幾筆的 frame 可能早就送出去了，兩邊都沒有。順帶的：沒接
   * 落盤的組裝上，同一個行程裡切回去也有歷史。
   */
  async function handleHistory(threadId: string, search: URLSearchParams): Promise<Response> {
    const query = historyQueryOf(search);
    if (query instanceof Response) return query;
    const thread = await threadOrError(threadId, null);
    if (thread instanceof Response) return thread;
    let result: ThreadHistoryResult;
    try {
      result = historyPage(
        thread.pump.sessionLog.events,
        query,
        thread.pump.awaitingInput ? { gatedTools: thread.pump.gatedTools } : undefined,
        // **不要在這裡讀 `result`**：這顆回呼跑在 `historyPage` 裡面，那時它還沒被賦值。
        (bytes) =>
          options.warn?.(
            `[歷史] thread ${threadId} 的一頁超過上限：${String(bytes)} bytes。` +
              `單獨一輪就超標，不從輪中間切（#479）。`,
          ),
        toolTextLimits,
        threadTitleLimits,
        thread.pump.projectionUnits,
        thread.pump.projectionChildren(),
      );
    } catch (error: unknown) {
      if (error instanceof HistoryQueryError) {
        return json(errorResponse(null, 'invalid_argument', error.message));
      }
      throw error;
    }
    const response: ThreadHistoryResponse = { type: 'success', result };
    return json(response);
  }

  /**
   * `GET /threads/:id/subagents/:runId/history`（[#871](https://github.com/DemianLi/nexus-agent/issues/871)）：背景子代理
   * 自己那份對話的一頁歷史，契約見 `subagentHistoryPath`。**對它自己的日誌套同一個 `historyPage`**，所以人說的話、模型回覆、
   * 工具卡、分頁與位元組上限都跟主對話那條一樣。
   *
   * **不經 `threadFor`**：這條 thread 沒載入時（重啟之後）不為了讀歷史建一個 agent，讀落盤的那份（`readSubagentSession`，
   * 唯讀冷讀）；載入著的就讀記憶體裡的日誌（含還沒落盤的那幾筆）。**找不到一律 `subagent_not_found`**：編號長得不對、不是
   * 這條 thread 的、日誌不存在或讀不到，不細分。
   */
  async function handleSubagentHistory(
    threadId: string,
    runId: string,
    search: URLSearchParams,
  ): Promise<Response> {
    const query = historyQueryOf(search);
    if (query instanceof Response) return query;
    const notFound = () =>
      json(errorResponse(null, SUBAGENT_NOT_FOUND, `沒有編號 ${runId} 的背景子代理`));
    if (!isBackgroundRunId(runId)) return notFound();
    const existing = threads.get(threadId);
    const thread = existing === undefined ? undefined : await existing.catch(() => undefined);
    const live = thread?.pump.sessions.get({ kind: 'subagent', runId });
    let events: readonly SessionEvent[] | undefined = live?.events;
    if (events === undefined) {
      try {
        events = await options.readSubagentSession?.(threadId, runId);
      } catch (error: unknown) {
        // 讀不到（壞檔、版本太新）一樣是找不到，原因講給操作的人聽，不送給呼叫端。
        options.warn?.(
          `[歷史] thread ${threadId} 的子代理 ${runId} 讀不出來：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (events === undefined) return notFound();
    let result: ThreadHistoryResult;
    try {
      result = historyPage(
        events,
        query,
        undefined,
        (bytes) =>
          options.warn?.(
            `[歷史] thread ${threadId} 的子代理 ${runId} 的一頁超過上限：${String(bytes)} bytes。` +
              `單獨一輪就超標，不從輪中間切（#479）。`,
          ),
        toolTextLimits,
        threadTitleLimits,
      );
    } catch (error: unknown) {
      if (error instanceof HistoryQueryError) {
        return json(errorResponse(null, 'invalid_argument', error.message));
      }
      throw error;
    }
    const response: ThreadHistoryResponse = { type: 'success', result };
    return json(response);
  }

  /**
   * `GET /threads/:id/trajectory/turn?seq=|messageId=[&runId=]`（[#1083](https://github.com/DemianLi/nexus-agent/issues/1083)）：
   * 軌跡某個邏輯輪的細節，契約見 `trajectoryTurnPath`。**這裡只負責找到日誌與單元、把錨點交下去、把結果與失敗翻成封包**；
   * 折疊本身是軌跡投影單元的 `detail`（同一個 `apply`），所以 host 不依賴軌跡插件，沒掛它就是 `not_supported`。
   *
   * **經 `threadFor`，同 `handleHistory`**：要的是這條 thread 組裝裡的投影單元，web 看觀測分頁之前這條 thread 已經建起來了。
   * 日誌的來源跟歷史頁同一套：root 讀記憶體裡那份（含 seed 與還沒落盤的）；子代理先讀 live 的，沒有就冷讀落盤的。
   */
  async function handleTrajectoryTurn(
    threadId: string,
    search: URLSearchParams,
  ): Promise<Response> {
    const runId = search.get('runId');
    const seq = search.get('seq');
    const messageId = search.get('messageId');
    if (runId === null && seq === null && messageId === null) {
      return json(
        errorResponse(null, 'invalid_argument', '要給 seq 或 messageId（背景子代理可只給 runId）'),
      );
    }
    const thread = await threadOrError(threadId, null);
    if (thread instanceof Response) return thread;
    const unit = thread.pump.projectionUnits.find((each) => each.key === TRAJECTORY_PROJECTION);
    if (unit?.detail === undefined) {
      return json(errorResponse(null, 'not_supported', '這台 server 沒掛軌跡投影，沒有可拉的細節'));
    }
    let events: readonly SessionEvent[] | undefined;
    if (runId === null) {
      events = thread.pump.sessionLog.events;
    } else {
      if (!SUBAGENT_RUN_ID.test(runId)) {
        return json(errorResponse(null, SUBAGENT_NOT_FOUND, `沒有編號 ${runId} 的子代理`));
      }
      events = thread.pump.sessions.get({ kind: 'subagent', runId })?.events;
      if (events === undefined) {
        try {
          events = await options.readSubagentSession?.(threadId, runId);
        } catch (error: unknown) {
          options.warn?.(
            `[軌跡] thread ${threadId} 的子代理 ${runId} 讀不出來：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (events === undefined) {
        return json(errorResponse(null, SUBAGENT_NOT_FOUND, `沒有編號 ${runId} 的子代理`));
      }
    }
    try {
      const result = unit.detail(events, {
        ...(seq === null ? {} : { seq }),
        ...(messageId === null ? {} : { messageId }),
      });
      // 單元的 `detail` 回 `unknown`（host 不知道各單元的形狀）；軌跡這一個的形狀由 `@nexus/wire` 的 `TrajectoryTurnDetail` 定。
      return json({
        type: 'success',
        result: result as TrajectoryTurnDetail,
      } satisfies TrajectoryTurnResponse);
    } catch (error: unknown) {
      if (error instanceof ProjectionDetailError) {
        return json(
          errorResponse(
            null,
            error.kind === 'not-found' ? TURN_NOT_FOUND : 'invalid_argument',
            error.message,
          ),
        );
      }
      const reason = error instanceof Error ? error.message : String(error);
      options.warn?.(`[軌跡] thread ${threadId} 折不出細節：${reason}`);
      return json(errorResponse(null, 'unknown_error', `軌跡折不出來：${reason}`));
    }
  }

  /**
   * `GET /threads/:id/file-references?query=`（[#651](https://github.com/DemianLi/nexus-agent/issues/651)）：`@` 後面那一段的候選。
   * 契約見 `@nexus/wire` 的 `file-references.ts`，查法與圍堵見 `file-references.ts`。
   *
   * **經 `threadFor`，同 `slash.list`**：打 `@` 多半發生在第一句之前，所以沒開過的 thread 要為它建起來，而不是像
   * `changes` 那樣回 404。也同 `slash.list` **不看「還在跑」與核准點**：它只讀，沒有東西可以跟誰賽跑。
   *
   * **取消與失敗分開**：請求被取消（web 每打一個字就取消上一次）時照樣拋出去，由載體收掉，同 `changes/diff`；
   * 其他失敗（例如工作區根讀不到，索引照 dsh 不落定成空的）回協定層的錯誤封包。
   */
  async function handleFileReferences(
    threadId: string,
    search: URLSearchParams,
    signal: AbortSignal,
  ): Promise<Response> {
    const thread = await threadOrError(threadId, null);
    if (thread instanceof Response) return thread;
    let response: FileReferenceListResponse;
    if (thread.fileSearch === undefined) {
      response = { type: 'success', result: { available: false } };
    } else {
      try {
        const candidates = await listFileReferences(
          thread.fileSearch,
          search.get('query') ?? '',
          signal,
        );
        response = { type: 'success', result: { available: true, candidates } };
      } catch (error: unknown) {
        signal.throwIfAborted();
        const reason = error instanceof Error ? error.message : String(error);
        return changesResponse(errorResponse(null, 'unknown_error', `列不出檔案：${reason}`));
      }
    }
    return changesResponse(response);
  }

  /**
   * `GET /threads/:id/session-references?query=`（[#713](https://github.com/DemianLi/nexus-agent/issues/713)）：`@` 後面那一段的會話候選。
   * 契約見 `@nexus/wire` 的 `session-references.ts`，查法見 `session-reference-candidates.ts`。
   *
   * **不經 `threadOrError`**：候選是冷讀，為了回一份清單把 thread 建起來是反的（同 `handleList`）。取消與失敗分開，同 `handleFileReferences`。
   */
  async function handleSessionReferences(
    threadId: string,
    search: URLSearchParams,
    signal: AbortSignal,
  ): Promise<Response> {
    let response: SessionReferenceListResponse;
    if (options.listSessionReferences === undefined) {
      response = { type: 'success', result: { available: false } };
    } else {
      try {
        const candidates = await options.listSessionReferences(
          threadId,
          search.get('query') ?? '',
          signal,
        );
        response = { type: 'success', result: { available: true, candidates } };
      } catch (error: unknown) {
        signal.throwIfAborted();
        const reason = error instanceof Error ? error.message : String(error);
        return changesResponse(errorResponse(null, 'unknown_error', `列不出會話：${reason}`));
      }
    }
    return changesResponse(response);
  }

  /**
   * `GET /threads/:id/changes/summary?seq=`（[#443](https://github.com/DemianLi/nexus-agent/issues/443)），照 dsh 的
   * `handleChangesSummary`：400 座標不對，404 這台 server 不再服務這份摘要。
   *
   * **錯誤協定是這個檔案的第三種寫法，刻意的**：檔頭那兩層（載體層 status、協定層 200＋封包）是我們自己的 RPC
   * 形狀，這兩條照的是 dsh 的裸 status。「這台 server 根本不記改動（沒給 `--workspace`）」與「這份摘要已經不在」
   * 也刻意壓成同一個 404——跟 `handleList` 分得出「沒開」與「空的」不同，對 web 這兩種是同一個動作：不畫卡。
   *
   * **不經 `threadFor`**：摘要只對這個行程裡活著的 thread 存在，為了回一句「沒有」把一條 thread 建起來是反的
   * （同 `handleList` 的分寸）。
   */
  function handleChangesSummary(threadId: string, search: URLSearchParams): Response {
    const seq = coordinate(search.get('seq'));
    if (seq === undefined) return changesResponse('Invalid change summary coordinates.', 400);
    const summary = ready.get(threadId)?.workspaceChanges?.summary(seq);
    if (summary === undefined) return changesResponse('Change summary unavailable.', 404);
    return changesResponse(summary);
  }

  /**
   * `GET /threads/:id/changes/diff?seq=&index=`，照 dsh 的 `handleChangesDiff`：400 座標不對，404 這台 server 不再
   * 服務這份摘要、或沒有那個 index，500 讀檔失敗（找不到檔算 404）。請求被取消時照樣拋出去，由載體收掉。
   */
  async function handleChangesDiff(
    threadId: string,
    search: URLSearchParams,
    signal: AbortSignal,
  ): Promise<Response> {
    const seq = coordinate(search.get('seq'));
    const index = coordinate(search.get('index'));
    if (seq === undefined || index === undefined) {
      return changesResponse('Invalid changed file coordinates.', 400);
    }
    const service = ready.get(threadId)?.workspaceChanges;
    try {
      const diff = await service?.diff(seq, index, signal);
      if (diff === undefined) return changesResponse('Change comparison unavailable.', 404);
      return changesResponse(diff);
    } catch (error: unknown) {
      signal.throwIfAborted();
      const code = (error as { code?: unknown } | null)?.code;
      return changesResponse(
        'Change comparison unavailable.',
        code === 'ENOENT' || code === 'ENOTDIR' ? 404 : 500,
      );
    }
  }

  /**
   * 座標 → 一個通過所有閘門的檔。**挑錨的是這裡**，見
   * `deliverable-files.ts` 的檔頭。命令通道（[#747](https://github.com/DemianLi/nexus-agent/issues/747)）從 `params` 讀座標。
   *
   * **`ready` 拿不到就拒，理由是手上根本沒有那份 events**：`state.pump.sessionLog` 才是這條
   * thread 的日誌，沒有 state 就沒有日誌可查，連那個 `seq` 上有沒有交付都答不出來。
   *
   * ## 續接線以下那些（[#519](https://github.com/DemianLi/nexus-agent/issues/519)）
   *
   * 一條續接回來的 thread，日誌裡混著兩群事件：**線以下**的（上一個行程寫的）與**以上**的
   * （這個行程寫的）。分界是逐事件的 `seq < storedCount`——`storedCount` 就是接回來那批的長度，
   * `SessionLog` 的 `#adoptSeed` 釘死 `event.seq === index`，所以這個比較是精確的，不是估計。
   *
   * 線以下那些**以前一律拒**（[#452](https://github.com/DemianLi/nexus-agent/issues/452)），理由是
   * 「上一個行程當時的工作區根無從得知」。
   * [#504](https://github.com/DemianLi/nexus-agent/issues/504) 把那一格加進 header 之後，那句話只
   * 對了一半：**那份日誌的 header 記著根的時候，線以下那些錨得住**，所以這裡改成逐事件問
   * {@link ThreadState.resumedWorkspaceRoot} 在不在。
   *
   * ### 為什麼「header 記著根」蘊含「線以下每一顆交付都錨在它」
   *
   * 這一步是整刀的承重句，**兩個別處的事實撐著它**，兩個都配了上游斷言：
   *
   * 1. **沒有工作區的那一段生不出交付。** `present` 在 `registry.capabilities` 沒有工作區能力、
   *    或 backend 缺席時直接拒（`packages/nexus-plugin-present/src/index.ts` 的
   *    `PRESENT_NO_WORKSPACE_MESSAGE`），所以一個沒給 `--workspace` 的行程續寫進這份日誌的那一段，
   *    裡面一顆 `deliverables/presented` 都不會有。**這是放寬的正確性前提**：哪天 `present` 改成
   *    「沒有工作區就錨在 cwd」，這條路就變成一次靜默錯檔。
   * 2. **有給 `--workspace` 的那些段落，根一定等於 header 記的那個。** `assertSameWorkspaceRoot`
   *    在每一次續接當場比過（`resume-guards.ts` 的四格表），不等就拋。
   *
   * 兩條合起來：header 記著根 ⟹ 這份日誌裡每一顆 `deliverables/presented` 都是在那個根底下宣告的。
   * 而 header 那一格只在會話出生時寫得進去——續接只覆寫 `version`、**不回填**那一格，格式 13 以前
   * 的行程又讀不動 13 的 header（`parseHeader` 的版本閘），所以沒有第三條路徑把它種進去。
   *
   * ### 兩道判準，都 fail-closed
   *
   * - **是那一格在不在，不是 `version >= 13`。** 一份 12 的日誌被 13 接回來之後 header 的
   *   `version` 會被覆寫成 13 而那一格仍然不在——照版本號判就會做出一次靜默錯檔，剛好是 #504
   *   存在的理由。
   * - **記的根跟這一次的根不等也拒。** 上面第 2 條保證了走到這裡時兩者相等，所以這一道今天
   *   **永遠不會響**——它是那個保證的觀察點：守衛哪天鬆掉或轉交途中被換掉，這裡當場 404，
   *   而不是靜靜讀到另一個工作區裡的同名檔。
   */
  async function locateAt(
    threadId: string,
    seq: number,
    index: number,
  ): Promise<DeliverableResult<LocatedDeliverable>> {
    const state = ready.get(threadId);
    if (state === undefined) {
      return {
        kind: 'refused',
        reason: 'no-anchor',
        message: `讀不到：thread "${threadId}" 這台 server 沒有在服務。`,
      };
    }
    // **兩個拒絕分開講。** 壓成同一句的話，`workspaceRoot` 從組裝點一路傳到這裡的那條線就
    // **沒有任何觀察點**——拔掉 `cli.ts` 的回傳或 `serve.ts` 的轉交，全樹測試照樣綠，而真的
    // serve 上每一顆交付都 404。量過：兩條都拔，1169 條一條都不紅。
    const root = state.workspaceRoot;
    if (root === undefined) {
      return {
        kind: 'refused',
        reason: 'no-anchor',
        message: `讀不到：這台 server 這一次沒給 --workspace，交付檔沒有錨。`,
      };
    }
    if (seq < state.storedCount) {
      // 線以下：那份日誌的 header 記著根，才准用今天這個根當錨。兩道判準見檔頭。
      const recorded = state.resumedWorkspaceRoot;
      if (recorded === undefined) {
        return {
          kind: 'refused',
          reason: 'no-anchor',
          message:
            `讀不到：seq ${seq} 那顆交付是上一個行程寫的，而那份日誌的 header 沒記工作區根` +
            `——格式 13 以前的日誌都沒有這一格，所以它當時的根無從得知。` +
            `不能拿這一次的 --workspace 去讀它宣告的路徑（#504）。`,
        };
      }
      if (recorded !== root) {
        return {
          kind: 'refused',
          reason: 'no-anchor',
          message: `讀不到：seq ${seq} 那顆交付錨在工作區 ${recorded}，這台 server 這一次跑在 ${root}。`,
        };
      }
    }
    const declared = locateDeliverable(state.pump.sessionLog.events, seq, index);
    if (declared.kind === 'refused') return declared;
    return locateDeliverableFile(root, declared.value);
  }

  /**
   * 命令通道上的交付檔讀取（[#747](https://github.com/DemianLi/nexus-agent/issues/747)）：`deliverable.read` 與
   * `deliverable.readBytes`，契約與理由見 `@nexus/wire` 的 `DELIVERABLE_READ_METHOD`。
   *
   * **不經 `threadFor`**，同 `run.cancel` 與回饋：讀的是這條 thread 已經宣告過的檔，沒開過的 thread 沒有東西可讀，
   * 不為了回一個 `no-anchor` 建一個 agent。挑錨、找檔、上限全部走 {@link locateAt} 與 `deliverable-files.ts`，
   * 跟三條舊網址是同一份判定。
   */
  async function handleDeliverableCommand(
    threadId: string,
    method: DeliverableMethod,
    id: number,
    body: unknown,
  ): Promise<Response> {
    const params = (body as { params?: unknown }).params;
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      return json(errorResponse(id, 'invalid_argument', `${method} 缺 params`));
    }
    const fields = params as Record<string, unknown>;
    const count = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    const seq = count(fields.seq);
    const index = count(fields.index);
    if (seq === undefined || index === undefined) {
      return json(errorResponse(id, 'invalid_argument', '交付檔的座標不對。'));
    }
    // 沒給的欄位取預設；**給了卻不是非負整數**是參數不合格，不悄悄當沒給。
    const optional = (name: string, fallback: number): number | undefined =>
      fields[name] === undefined ? fallback : count(fields[name]);

    if (method === DELIVERABLE_READ_METHOD) {
      const offset = optional('offset', 0);
      // 沒給 `limit` 就是那一列講的上限，理由見 `deliverableLimits` 的說明：預設與上限是同一個數字。
      const limit = optional('limit', deliverableLimits.maxLines);
      if (offset === undefined || limit === undefined) {
        return json(errorResponse(id, 'invalid_argument', '交付檔的翻頁參數不對。'));
      }
      const found = await locateAt(threadId, seq, index);
      if (found.kind === 'refused') return deliverableFailure(id, found);
      const page = await readDeliverablePage(found.value, deliverableLimits, offset, limit);
      if (page.kind === 'refused') return deliverableFailure(id, page);
      return json(successResponse(id, { ok: true, value: page.value }));
    }

    // `deliverable.readBytes`：**給 `offset`／`length` 就是窗口，都不給是整檔**（下載）。
    const windowed = fields.offset !== undefined || fields.length !== undefined;
    let value: DeliverableBytes;
    if (windowed) {
      const offset = optional('offset', 0);
      const length = optional('length', deliverableLimits.maxBytes);
      if (offset === undefined || length === undefined) {
        return json(errorResponse(id, 'invalid_argument', '交付檔的位元組窗口參數不對。'));
      }
      // 窗口參數先驗、再找檔，照 dsh 的順序。
      const window = resolveDeliverableWindow(offset, length, deliverableLimits);
      if (window.kind === 'refused') return deliverableFailure(id, window);
      const found = await locateAt(threadId, seq, index);
      if (found.kind === 'refused') return deliverableFailure(id, found);
      const read = await readDeliverableWindow(found.value, window.value);
      if (read.kind === 'refused') return deliverableFailure(id, read);
      value = read.value;
    } else {
      const found = await locateAt(threadId, seq, index);
      if (found.kind === 'refused') return deliverableFailure(id, found);
      const bytes = await readDeliverableBytes(found.value, deliverableLimits);
      if (bytes.kind === 'refused') return deliverableFailure(id, bytes);
      value = { ...found.value.stat, offset: 0, data: bytes.value, eof: true };
    }
    return encodeBinaryResult(id, value);
  }

  function firstHumanText(input: unknown): string | undefined {
    const messages = (input as { messages?: unknown })?.messages;
    if (!Array.isArray(messages)) {
      return undefined;
    }
    const first = messages.find(
      (message): message is { content: string } =>
        typeof message === 'object' &&
        message !== null &&
        typeof (message as { content?: unknown }).content === 'string',
    );
    return first?.content;
  }

  return {
    async handle(request) {
      // 在任何路徑判斷之前：404 的路徑一樣不回答不信任的來源。見 `request-trust.ts`。
      if (!isTrustedWireRequest(request.headers)) {
        return new Response('untrusted host or origin', { status: 403 });
      }
      // 同一個位置、排在圍欄之後：不存在的路徑一樣先要身分。見 `browser-auth.ts`。
      if (!options.auth.isAuthenticated(request.headers)) {
        return new Response('unauthorized', {
          status: 401,
          headers: { 'cache-control': 'no-store' },
        });
      }
      const { pathname, searchParams } = new URL(request.url);
      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      const wrongMediaType = () =>
        new Response('content type must be application/json', { status: 415 });
      if (pathname === THREADS_PATH) {
        if (request.method !== 'GET') return new Response('not found', { status: 404 });
        // `GET` 沒有 body，這個 header 在這裡純粹是閘門：見 `THREADS_PATH` 的說明。
        if (mediaType !== JSON_MEDIA_TYPE) return wrongMediaType();
        return handleList(request.signal);
      }
      if (pathname === THREAD_SEARCH_PATH) {
        if (request.method !== 'POST') return new Response('not found', { status: 404 });
        if (mediaType !== JSON_MEDIA_TYPE) return wrongMediaType();
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return new Response('body is not JSON', { status: 400 });
        }
        return handleSearch(body, request.signal);
      }
      if (pathname === THREAD_FEED_PATH) {
        if (request.method !== 'GET') return new Response('not found', { status: 404 });
        // 同列表那一條：`GET` 沒有 body，這個 header 純粹是閘門。
        if (mediaType !== JSON_MEDIA_TYPE) return wrongMediaType();
        return openFeed(request.signal);
      }
      const route = parsePath(pathname);
      if (route?.kind === 'upload') {
        // 上傳（#732）：契約先合，實作還沒做。位元組不是 JSON，所以不走下面那道 `application/json` 閘門，換成
        // `application/octet-stream`（同樣不是 simple request，見 `@nexus/wire` 的 `attachments.ts`）。
        if (request.method !== 'POST') return new Response('not found', { status: 404 });
        if (mediaType !== 'application/octet-stream') {
          return new Response('content type must be application/octet-stream', { status: 415 });
        }
        return handleUpload(route.threadId, searchParams, request);
      }
      if (route?.kind === 'history') {
        if (request.method !== 'GET') return new Response('not found', { status: 404 });
        // 同列表那一條：`GET` 沒有 body，這個 header 純粹是閘門。
        if (mediaType !== JSON_MEDIA_TYPE) return wrongMediaType();
        return handleHistory(route.threadId, searchParams);
      }
      if (route?.kind === 'subagent-history') {
        if (request.method !== 'GET') return new Response('not found', { status: 404 });
        if (mediaType !== JSON_MEDIA_TYPE) return wrongMediaType();
        return handleSubagentHistory(route.threadId, route.runId, searchParams);
      }
      if (route?.kind === 'trajectory-turn') {
        if (request.method !== 'GET') return new Response('not found', { status: 404 });
        if (mediaType !== JSON_MEDIA_TYPE) return wrongMediaType();
        return handleTrajectoryTurn(route.threadId, searchParams);
      }
      if (route?.kind === 'file-references') {
        if (request.method !== 'GET') return new Response('not found', { status: 404 });
        // 同列表那一條：`GET` 沒有 body，這個 header 純粹是閘門。
        if (mediaType !== JSON_MEDIA_TYPE) return wrongMediaType();
        return handleFileReferences(route.threadId, searchParams, request.signal);
      }
      if (route?.kind === 'session-references') {
        if (request.method !== 'GET') return new Response('not found', { status: 404 });
        if (mediaType !== JSON_MEDIA_TYPE) return wrongMediaType();
        return handleSessionReferences(route.threadId, searchParams, request.signal);
      }
      if (route?.kind === 'changes-summary' || route?.kind === 'changes-diff') {
        if (request.method !== 'GET') return new Response('not found', { status: 404 });
        // 同列表那一條：`GET` 沒有 body，這個 header 純粹是閘門。
        if (mediaType !== JSON_MEDIA_TYPE) return wrongMediaType();
        return route.kind === 'changes-summary'
          ? handleChangesSummary(route.threadId, searchParams)
          : handleChangesDiff(route.threadId, searchParams, request.signal);
      }
      if (request.method !== 'POST' || route === undefined) {
        return new Response('not found', { status: 404 });
      }
      if (mediaType !== JSON_MEDIA_TYPE) {
        return wrongMediaType();
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return new Response('body is not JSON', { status: 400 });
      }
      return route.kind === 'stream'
        ? handleStream(route.threadId, body, request.signal)
        : handleCommand(route.threadId, route.method, body, request.signal);
    },
    async close() {
      // 全域下行先收：它不屬於任何一條 thread，下面那幾條 pump 收掉也不會讓它結束。
      feed.close();
      const opened = [...threads.values()];
      threads.clear();
      ready.clear();
      receipts.clear();
      // 還在建的那些也要等——`createAgent` 已經開了資源，只是還沒交出來。
      const settled = await Promise.all(opened.map((thread) => thread.catch(() => undefined)));
      for (const thread of settled) {
        thread?.pump.close();
      }
      // 一個 thread 清不乾淨不該擋住其他的。
      await Promise.all(settled.map((thread) => thread?.dispose().catch(() => undefined)));
    },
  };
}
