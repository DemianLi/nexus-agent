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
  SlashDescriptor,
  SlashListResult,
  SlashMethod,
  SlashRunResult,
  ThreadHistoryQuery,
  ThreadHistoryResponse,
  ThreadHistoryResult,
  ThreadListResponse,
  UplinkMethod,
  WireChannel,
  FeedbackMethod,
  WireFeedbackCategory,
  WireFeedbackItem,
} from '@nexus/wire';
import {
  THREADS_PATH,
  changesDiffPath,
  changesSummaryPath,
  deliverableBytesPath,
  deliverableDownloadPath,
  deliverableFilePath,
  encodeSseFrame,
  errorResponse,
  isFeedbackMethod,
  isRpcMethod,
  isRunCancelMethod,
  isSlashMethod,
  isWireChannel,
  successResponse,
} from '@nexus/wire';
import type {
  CommandDescriptor,
  CommandRegistrationPoint,
  FeedbackCategory,
  FeedbackService,
  MessageFeedbackItem,
  SessionEvent,
  SessionLog,
  SessionRegistry,
} from '@nexus/core';
import { FEEDBACK_CATEGORIES } from '@nexus/core';
import type { CommandExecutor } from '@nexus/plugin-commands';
import type { WorkspaceChanges } from '@nexus/plugin-workspace-changes';
import { createCommandExecutor } from '@nexus/plugin-commands';
import { HistoryQueryError, historyPage } from './conversation-history.js';
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
import {
  deliverableFilesConfigSchema,
  type DeliverableFilesConfig,
} from './settings/deliverable-files.js';
import { toolTextConfigSchema } from './settings/tool-text.js';
import type { ToolTextConfig } from './settings/tool-text.js';
import type { GoalDriverPort } from './goal-driver.js';
import { isTrustedWireRequest } from './request-trust.js';
import type { StoredThreadList } from './session-list.js';
import type { PumpAgent } from './thread-pump.js';
import { ThreadPump } from './thread-pump.js';

/**
 * `@nexus/core` 的命令視圖必須塞得進線上那一個。
 *
 * 兩份形狀是手抄的（`@nexus/wire` 進得了瀏覽器正是因為它不相依 `@nexus/core`），而
 * **這裡是唯一同時看得到兩邊的地方**。少了這一行，`CommandDescriptor` 多一格就會安靜地
 * 到不了瀏覽器；有了它，那一刻編不過。形狀照 `protocol.ts` 的
 * `_channelsAreProtocolChannels`。
 */
const _descriptorFitsTheWire: SlashDescriptor = {} as CommandDescriptor;
void _descriptorFitsTheWire;

/**
 * 回饋的詞彙同一條理由（[#278](https://github.com/DemianLi/nexus-agent/issues/278)）。**分類兩個方向
 * 都釘**：只釘一邊的話，線上那份多寫一類會安靜地通過，而 core 那側的折疊不認得它。
 */
const _categoryFitsTheWire: WireFeedbackCategory = {} as FeedbackCategory;
const _wireCategoryIsCore: FeedbackCategory = {} as WireFeedbackCategory;
const _feedbackItemFitsTheWire: WireFeedbackItem = {} as MessageFeedbackItem;
void _categoryFitsTheWire;
void _wireCategoryIsCore;
void _feedbackItemFitsTheWire;

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
   * 評分與評語的規則（[#278](https://github.com/DemianLi/nexus-agent/issues/278)），選配。
   * 沒掛 `@nexus/plugin-feedback` 的組裝就沒有，那時四個回饋 method 回 `not_supported`。
   */
  readonly feedback?: FeedbackService;
  /**
   * 每一輪改動檔案的摘要與比較（[#443](https://github.com/DemianLi/nexus-agent/issues/443)），選配。
   * 沒給 `--workspace` 的組裝就沒有，那時兩條 `changes` 路由一律 404——同「這台 server 不服務這份摘要」。
   */
  readonly workspaceChanges?: WorkspaceChanges;
  dispose(): Promise<void>;
  /**
   * 把這個 thread 的**每一份**會話日誌接上遙測，選配。
   *
   * **接線點必須在這裡**，因為註冊表是 pump 建的（一個 thread 一張），而知道有沒有掛
   * 後端的是組裝點。兩邊只在這一行碰得到面。沒掛後端時 `createNexusAgent` 回
   * `undefined`，這裡什麼都不會發生。
   *
   * @param sessions - 這個 thread 的會話註冊表。
   * @returns 收掉這次接線的函式，或沒掛後端時的 `undefined`。
   */
  attachTelemetry?(sessions: SessionRegistry): (() => Promise<void>) | undefined;
  /**
   * 把這個 thread 的日誌接上不變量配套入口。同 `attachTelemetry` 的理由住在組裝點：
   * 只有那裡同時看得到 registry 與日誌。沒有人註冊配套入口時回 `undefined`。
   *
   * @param sessions - 這個 thread 的會話註冊表。
   * @returns 收掉這次接線的函式，或沒有配套入口時的 `undefined`。
   */
  attachInvariants?(sessions: SessionRegistry): (() => void) | undefined;
  /**
   * 把這個 thread 的日誌接上 `sessions` 通道的參與者，選配。
   *
   * 同上面兩條的理由住在組裝點，但**方向相反**：交出去的日誌寫得動，參與者記得下
   * `goal/change` 這種權威 domain 事件。沒有人註冊參與者時回 `undefined`。
   *
   * **這條路不能漏。** 漏了的話 `@nexus/core` 的測試照樣全綠，而 web 那端每一個 thread
   * 的域狀態都不存在——那是一種只在瀏覽器上看得到的缺席。
   *
   * **它同時是模型工具那條線。** 綁上註冊表之後，plugin 註冊的工具才問得出「我這次呼叫
   * 該寫進哪一份日誌」（`registry.sessions.forCall`）。所以它現在**一定**回一個 detach，
   * 沒有「沒人 join 就 `undefined`」那條短路了。
   *
   * @param sessions - 這個 thread 的會話註冊表。
   * @returns 收掉這次接線的函式。
   */
  attachSession?(sessions: SessionRegistry): () => void;
  /**
   * 把這個 thread 的**每一份**會話日誌接上落盤，選配。
   *
   * **這一條與上面三條不同層**：那三個的答案來自 `createCliAgent`（掛了什麼 plugin
   * 決定有沒有遙測後端、有沒有配套入口、有沒有參與者），而落盤與 plugin 清單無關
   * ——它的答案來自**呼叫方式**（`serve.ts` 的日誌根：`--session-log`，沒給就是 harness home
   * 底下的 `sessions`，#444）。所以組裝點是 `runServe` 自己的閉包，不是 `createCliAgent` 的回傳值。
   *
   * **選配是給這個 handler 的其他組裝用的**（wire 測試那些手搭的）：`serve` 從 #444 起一律給。
   *
   * **一個行程一個 store，一條 thread 一次接線。** store 落在會話根按專案分的那一格，整個
   * 行程共用；每條 thread 的 root session id 就是它的 `threadId`，所以那一格底下一條
   * thread 一個檔（檔名的單射性見 `jsonl-session-store.ts` 的 `safeBaseName`——
   * `threadId` 是呼叫端給的字串），重開之後同一條 thread 找得回自己那一份。
   *
   * 前三個是觀察者，這一個是出口，所以排在最後——同 `cli.ts` 的接線順序。
   *
   * @param sessions - 這個 thread 的會話註冊表。
   * @returns 收掉這次接線的方法（`dispose` 會排空並關檔），或沒開落盤時的 `undefined`。
   */
  attachPersistence?(
    sessions: SessionRegistry,
  ): { flush(): Promise<void>; dispose(): Promise<void> } | undefined;
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
   * 兩條交付讀檔路由拿它當錨。**由組裝點交出來，不是這裡算的**——算它的是
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
   * 就擋下了不等的情形——而 `locateRequested` 對不等**再拒一次**，理由見那裡。
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
   * `serve` 從 #444 起一律給，缺席的只剩手搭的組裝。
   *
   * **它不准碰 {@link createAgent}**：列表照 dsh 是冷讀，一條 thread 都不為它啟動。`running` 那一格由這個
   * handler 從手上活著的 thread 補，不從檔案猜。
   */
  listThreads?(): Promise<StoredThreadList>;
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
   * **它是 server 的性質，所以在這裡而不是在 `ThreadAgent` 上**：這兩條路由住在這個閉包裡、
   * 一個 server 一次，`threadId` 是它們的參數。放進 `ThreadAgent` 會讓「每條 thread 的交付上限
   * 可以不同」變成一個可表達而沒有意義的狀態。
   */
  readonly deliverableLimits?: DeliverableFilesConfig;
  /**
   * 一段工具結果文字放上線的上限（[#538](https://github.com/DemianLi/nexus-agent/issues/538)）。
   *
   * **兩個消費點都在這個閉包底下**：即時那條走 `new ThreadPump(...)`，重播那條走
   * `historyPage(...)`。省略即 schema 的預設。
   */
  readonly toolTextLimits?: ToolTextConfig;
  /**
   * 這台 server 講話的地方，選配（[#479](https://github.com/DemianLi/nexus-agent/issues/479)）。
   *
   * **這是這個檔案的第一個、而且目前唯一的記錄點**，加它的理由很窄：一頁歷史的位元組上限是**軟的**
   * （單獨一輪就超標時不從輪中間切，見 `conversation-history.ts` 的 `fitBytes`），而那件事發生時回應
   * 照樣是 200、畫面照樣對——不講就完全看不見。缺席就是不講，測試不必為它接線。
   */
  warn?(message: string): void;
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': `${JSON_MEDIA_TYPE}; charset=utf-8` },
  });
}

/**
 * `/threads/:id/stream`、`/threads/:id/history`、`/threads/:id/changes/{summary,diff}`、
 * `/threads/:id/deliverables/{file,download}` 或 `/threads/:id/commands/:method`，
 * 都不是就 undefined。
 */
function parsePath(
  pathname: string,
):
  | { readonly kind: 'stream'; readonly threadId: string }
  | { readonly kind: 'history'; readonly threadId: string }
  | { readonly kind: 'changes-summary'; readonly threadId: string }
  | { readonly kind: 'changes-diff'; readonly threadId: string }
  | { readonly kind: 'deliverable-file'; readonly threadId: string }
  | { readonly kind: 'deliverable-download'; readonly threadId: string }
  | { readonly kind: 'deliverable-bytes'; readonly threadId: string }
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
  if (segments.length === 4 && segments[2] === 'changes') {
    if (pathname === changesSummaryPath(threadId)) return { kind: 'changes-summary', threadId };
    if (pathname === changesDiffPath(threadId)) return { kind: 'changes-diff', threadId };
  }
  if (segments.length === 4 && segments[2] === 'deliverables') {
    if (pathname === deliverableFilePath(threadId)) return { kind: 'deliverable-file', threadId };
    if (pathname === deliverableDownloadPath(threadId)) {
      return { kind: 'deliverable-download', threadId };
    }
    if (pathname === deliverableBytesPath(threadId)) return { kind: 'deliverable-bytes', threadId };
  }
  if (segments.length === 4 && segments[2] === 'commands' && segments[3] !== undefined) {
    return { kind: 'command', threadId, method: segments[3] };
  }
  return undefined;
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
 * 一個拒絕的理由對到哪個 HTTP status。
 *
 * **不壓成同一個碼，因為前端對每一種的動作不一樣**：`not-text` 是「改給下載鈕」，`too-large`
 * 是「講一句太大了」，`no-anchor` 與 `not-found` 才是「這張卡讀不到」。壓掉它們等於把前端
 * 唯一的判別依據拿走——而錯的那一側長得跟對的一模一樣。
 */
const DELIVERABLE_STATUS: Readonly<Record<DeliverableRefusal, number>> = {
  'bad-request': 400,
  'no-anchor': 404,
  'not-found': 404,
  'not-regular-file': 404,
  'too-large': 413,
  // **422 而不是 415。** 415 這條線上已經有人用了——`wrongMediaType` 拿它講「你的請求沒帶
  // `content-type: application/json`」。兩件事壓在同一個碼上，前端就分不出「我忘了帶 header」
  // 與「這個檔是二進位、改給下載鈕」，而那是兩個完全不同的修法。
  'not-text': 422,
};

/** 交付那幾條路由的拒絕：協定同 `changes`，裸 status ＋純文字 ＋不快取。 */
function deliverableRefused(result: {
  readonly reason: DeliverableRefusal;
  readonly message: string;
}): Response {
  return new Response(result.message, {
    status: DELIVERABLE_STATUS[result.reason],
    headers: { 'cache-control': 'no-store' },
  });
}

/**
 * 下載那條的 `content-disposition`。
 *
 * 檔名取宣告路徑的最後一段。**兩種寫法都給**：`filename=` 那一份把非 ASCII 換成底線（舊
 * 瀏覽器只看得懂它），`filename*=` 那一份帶完整的 UTF-8。換掉的還有引號與控制字元——它們
 * 進得了 header 值就能把這個欄位切成兩半。
 */
function attachmentHeader(declaredPath: string): string {
  const name =
    declaredPath
      .split('/')
      .filter((part) => part !== '')
      .pop() ?? 'deliverable';
  // 白名單寫法：只留可列印的 ASCII，剩下的（含控制字元）一律換掉。用黑名單列控制字元的話
  // 少列一個就是一個漏，而漏的後果是 header 被切成兩半。
  const ascii = name.replaceAll(/[^\u0020-\u007e]|["\\]/gu, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
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
  /**
   * 接回來那批事件的長度；沒續接就是 0（[#452](https://github.com/DemianLi/nexus-agent/issues/452)）。
   *
   * **它是一條分界線**：`seq < storedCount` 的事件是上一個行程寫的，所以這個行程手上的
   * {@link workspaceRoot} 不會自動是它們的錨——准不准拿它當錨，由
   * {@link resumedWorkspaceRoot} 在不在決定
   * （[#519](https://github.com/DemianLi/nexus-agent/issues/519)，判準與證明見
   * `locateRequested` 的檔頭）。
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

const RATINGS: readonly string[] = ['positive', 'negative'];

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
    typeof p.rating !== 'string' ||
    !RATINGS.includes(p.rating) ||
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
    rating: p.rating as 'positive' | 'negative',
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
        );
        late.log = pump.sessionLog;
        const detachTelemetry = threadAgent.attachTelemetry?.(pump.sessions);
        const detachInvariants = threadAgent.attachInvariants?.(pump.sessions);
        // **接在不變量之後**，同 `cli.ts` 那條的理由：參與者一裝上去就可能記東西，
        // 那些東西該被已經在看的檢查看到。註冊表通知訂閱者的順序就是這三行的順序，
        // 所以 subagent 後來出生的那些日誌也照這個順序被接上。
        const detachSession = threadAgent.attachSession?.(pump.sessions);
        // **接在最後，理由同 `cli.ts`**：前三個是觀察者，落盤不改變任何人看得到什麼，
        // 所以順序在功能上沒有差別；排最後是為了讓讀的人看到的因果跟實際一致。
        const persistence = threadAgent.attachPersistence?.(pump.sessions);
        // **沒開落盤時 `flush` 就整個缺席**，而不是一個假裝成功的 no-op：`late.flush?.()`
        // 的缺席語意就是「這條路上沒有耐久檢查點」，同 `attachPersistence` 自己的規矩。
        late.flush = persistence === undefined ? undefined : () => persistence.flush();
        const state: ThreadState = {
          pump,
          commands: threadAgent.commands,
          // **建在這裡**：日誌是 pump 建的（一個 thread 一份），而這一行正是它誕生的地方
          // ——跟上面兩條接線同一個位置，理由也同一個。
          executor: createCommandExecutor({
            commands: threadAgent.commands,
            sessionLog: pump.sessionLog,
          }),
          feedback: threadAgent.feedback,
          workspaceChanges: threadAgent.workspaceChanges,
          // **就是 seed 的長度**，不另外傳一個數字：兩個來源各記一次的話，有一天它們會不一樣，
          // 而那時錯的方向是「把重播的事件當成這個行程寫的」——靜靜讀到另一個工作區的同名檔。
          storedCount: threadAgent.rootSeed?.length ?? 0,
          workspaceRoot: threadAgent.workspaceRoot,
          resumedWorkspaceRoot: threadAgent.resumedWorkspaceRoot,
          slashInFlight: false,
          dispose: async () => {
            // **參與者先收，比不變量還早**：它是唯一寫得動日誌的那一個，先讓它停手，
            // 檢查才還在看著它最後那幾筆。反過來收的話，關機途中寫進去的東西沒人檢。
            detachSession?.();
            // 不變量再退訂：它只是一個訂閱，退掉不會有東西要排空，而留著它跑在關機途中的
            // 事件上只會多噪音。
            detachInvariants?.();
            // 遙測先收，理由同 `agent-factory.ts`：後端可能是某個 plugin 開的。
            await detachTelemetry?.();
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

  function openStream(
    pump: ThreadPump,
    channels: readonly WireChannel[],
    signal: AbortSignal,
  ): Response {
    const encoder = new TextEncoder();
    const events = pump.subscribe(channels, signal);
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
        controller.enqueue(encoder.encode(encodeSseFrame(next.value)));
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
    if (isFeedbackMethod(method)) {
      // 評分與評語（#278）：**不經 `threadFor`**，同 `run.cancel`——評的是這條 thread 上已經出現過
      // 的回覆，沒開過的 thread 沒有東西可評，不為了回一個 target-not-found 建一個 agent。
      // **也不看 `slashInFlight` 與「還在跑」**：跑著、停在核准點都能評（#267 的 Q10）。
      const existing = threads.get(threadId);
      const thread = existing === undefined ? undefined : await existing.catch(() => undefined);
      return json(feedbackResponse(thread, envelope.id, method, body));
    }
    const thread = await threadOrError(threadId, envelope.id);
    if (thread instanceof Response) return thread;
    if (isSlashMethod(method)) {
      return handleSlash(thread, method, envelope.id, body, signal);
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
      if (pump.awaitingInput) {
        // **基座這時不會擋，它會靜靜地把中斷丟掉**：新的一輪照跑，那個等著核准的工具
        // 既沒執行也沒被拒絕，而且不會再發第二顆 `input.requested`（實測）。靜靜照做
        // 等於讓一道核准閘門無聲消失，所以這裡明著回錯——同 `since` 那條的理由。
        return json(
          errorResponse(
            command.id,
            'invalid_argument',
            '這條 thread 停在核准點：先用 input.respond 回答它，再說下一句話',
          ),
        );
      }
      const text = firstHumanText(params.input);
      if (text === undefined) {
        return json(
          errorResponse(command.id, 'invalid_argument', 'run.start 的 input 沒有可用的訊息'),
        );
      }
      return json(successResponse(command.id, { run_id: start(pump, { kind: 'message', text }) }));
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
      const { commandId, result } = execution;
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

  /**
   * `GET /threads`。**不經 `threadFor`**：一條 thread 都不為列表建（同 `run.cancel` 的理由，而且這裡更嚴——
   * 列的正是還沒開起來的那些）。讀不動整個目錄是協定層的錯，同 `threadOrError` 的分寸。
   */
  async function handleList(): Promise<Response> {
    if (options.listThreads === undefined) {
      return json(
        errorResponse(
          null,
          'not_supported',
          '這台 server 的會話日誌只在記憶體裡（組裝時沒接落盤），以前的 thread 列不出來',
        ),
      );
    }
    let stored: StoredThreadList;
    try {
      stored = await options.listThreads();
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
          running: ready.get(item.threadId)?.pump.running ?? false,
        })),
      },
    };
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
   * 兩條交付讀檔路由共用的前半：座標 → 一個通過所有閘門的檔。**挑錨的是這裡**，見
   * `deliverable-files.ts` 的檔頭。
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
  async function locateRequested(
    threadId: string,
    search: URLSearchParams,
  ): Promise<DeliverableResult<LocatedDeliverable>> {
    const seq = coordinate(search.get('seq'));
    const index = coordinate(search.get('index'));
    if (seq === undefined || index === undefined) {
      return { kind: 'refused', reason: 'bad-request', message: '交付檔的座標不對。' };
    }
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
   * `GET /threads/:id/deliverables/file?seq=&index=&offset=&limit=`
   * （[#452](https://github.com/DemianLi/nexus-agent/issues/452)）：預覽一個宣告過的交付檔。
   *
   * 錯誤協定與狀態碼見 {@link DELIVERABLE_STATUS}；契約見 `@nexus/wire` 的 `deliverableFilePath`。
   */
  async function handleDeliverableFile(
    threadId: string,
    search: URLSearchParams,
  ): Promise<Response> {
    const offset = coordinate(search.get('offset') ?? '0');
    // **沒給 `limit` 就是那一列講的上限**，而同一個數字在 `readDeliverablePage` 裡當「不准超過」。
    // 兩處都讀 `deliverableLimits.maxLines`：只接一處的話，設定一動兩個方向都會 400。
    const limit = coordinate(search.get('limit') ?? String(deliverableLimits.maxLines));
    if (offset === undefined || limit === undefined) {
      return new Response('交付檔的翻頁參數不對。', {
        status: 400,
        headers: { 'cache-control': 'no-store' },
      });
    }
    const found = await locateRequested(threadId, search);
    if (found.kind === 'refused') return deliverableRefused(found);
    const page = await readDeliverablePage(found.value, deliverableLimits, offset, limit);
    if (page.kind === 'refused') return deliverableRefused(page);
    return new Response(JSON.stringify(page.value), {
      headers: {
        'content-type': `${JSON_MEDIA_TYPE}; charset=utf-8`,
        'cache-control': 'no-store',
      },
    });
  }

  /**
   * `GET /threads/:id/deliverables/download?seq=&index=`：下載一個宣告過的交付檔，**原始位元組**。
   *
   * **它跟隔壁每一條 `GET` 一樣要帶 `content-type: application/json`**，所以前端不能用
   * `<a download>`——理由與後果逐字寫在 `@nexus/wire` 的 `deliverableDownloadPath`。
   */
  async function handleDeliverableDownload(
    threadId: string,
    search: URLSearchParams,
  ): Promise<Response> {
    const found = await locateRequested(threadId, search);
    if (found.kind === 'refused') return deliverableRefused(found);
    const bytes = await readDeliverableBytes(found.value, deliverableLimits);
    if (bytes.kind === 'refused') return deliverableRefused(bytes);
    return new Response(bytes.value, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': attachmentHeader(found.value.stat.path),
        'cache-control': 'no-store',
      },
    });
  }

  /**
   * `GET /threads/:id/deliverables/bytes?seq=&index=&offset=&length=`
   * （[#544](https://github.com/DemianLi/nexus-agent/issues/544)）：一個宣告過的交付檔的**位元組窗口**，
   * 照 dsh 的 `readBytes`。理由見 `deliverable-window.ts` 的檔頭；契約見 `@nexus/wire` 的
   * `deliverableBytesPath`。
   *
   * **窗口參數先驗、再找檔**，照 dsh 的順序：參數本身不合格的請求，不該先讓它知道那個座標上有沒有檔。
   */
  async function handleDeliverableBytes(
    threadId: string,
    search: URLSearchParams,
  ): Promise<Response> {
    const offset = coordinate(search.get('offset') ?? '0');
    // 沒給 `length` 就是頁的位元組上限，同 dsh 的 `resolveWindow`。
    const length = coordinate(search.get('length') ?? String(deliverableLimits.maxBytes));
    if (offset === undefined || length === undefined) {
      return new Response('交付檔的位元組窗口參數不對。', {
        status: 400,
        headers: { 'cache-control': 'no-store' },
      });
    }
    const window = resolveDeliverableWindow(offset, length, deliverableLimits);
    if (window.kind === 'refused') return deliverableRefused(window);
    const found = await locateRequested(threadId, search);
    if (found.kind === 'refused') return deliverableRefused(found);
    const bytes = await readDeliverableWindow(found.value, window.value);
    if (bytes.kind === 'refused') return deliverableRefused(bytes);
    return new Response(JSON.stringify(bytes.value), {
      headers: {
        'content-type': `${JSON_MEDIA_TYPE}; charset=utf-8`,
        'cache-control': 'no-store',
      },
    });
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
        return handleList();
      }
      const route = parsePath(pathname);
      if (route?.kind === 'history') {
        if (request.method !== 'GET') return new Response('not found', { status: 404 });
        // 同列表那一條：`GET` 沒有 body，這個 header 純粹是閘門。
        if (mediaType !== JSON_MEDIA_TYPE) return wrongMediaType();
        return handleHistory(route.threadId, searchParams);
      }
      if (
        route?.kind === 'deliverable-file' ||
        route?.kind === 'deliverable-download' ||
        route?.kind === 'deliverable-bytes'
      ) {
        if (request.method !== 'GET') return new Response('not found', { status: 404 });
        // 同列表那一條：`GET` 沒有 body，這個 header 純粹是閘門。**下載也不例外**，見
        // `@nexus/wire` 的 `deliverableDownloadPath`。
        if (mediaType !== JSON_MEDIA_TYPE) return wrongMediaType();
        if (route.kind === 'deliverable-file')
          return handleDeliverableFile(route.threadId, searchParams);
        if (route.kind === 'deliverable-bytes') {
          return handleDeliverableBytes(route.threadId, searchParams);
        }
        return handleDeliverableDownload(route.threadId, searchParams);
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
      const opened = [...threads.values()];
      threads.clear();
      ready.clear();
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
