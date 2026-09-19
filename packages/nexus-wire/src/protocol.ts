/**
 * 這條線上的協定詞彙。
 *
 * **不是我們發明的。** 封包、channel 名、SSE 的 route、HITL 的兩個 method 都出自
 * `@langchain/protocol` —— 它是 `@langchain/langgraph` 與 `@langchain/langgraph-sdk`
 * 的直接相依，早就在 `node_modules` 裡。本檔只做三件事：把採納的那一小塊挑出來、
 * 釘住 route 的拼法、宣告 channel 白名單。理由與未採納清單見開發計劃第 7 節決策 6。
 *
 * `@langchain/protocol` 的 `exports` 把 `types` 與 `default` 都指向未編譯的
 * `protocol.ts`，**所以整個 repo 只能 `import type`**；一旦出現值層 import，
 * plain node 那條路會當場爆。
 */

import type {
  Channel,
  Command,
  CommandResponse,
  ErrorCode,
  ErrorResponse,
  Event,
  EventStreamRequest,
  InputRespondOne,
  RunStartParams,
} from '@langchain/protocol';

export type {
  Channel,
  Command,
  CommandResponse,
  ErrorCode,
  ErrorResponse,
  Event,
  EventStreamRequest,
  InputRespondOne,
  RunStartParams,
};

/**
 * 下行放行的 channel。
 *
 * **這是安全邊界，不是效能調校。** 實測基座的 `tasks` frame 每一顆都夾著整份 input
 * message list、`updates` 夾著完整序列化的訊息、`values` 夾整個 state；全頻道往瀏覽器
 * 倒等於每個 task event 重送一次對話狀態，而且 state 裡有什麼就送什麼。
 * 要放行 `tasks` / `checkpoints` / `values` 得是一個明白的決定，不是預設。
 *
 * `input` 這一格是我們自己合成的：基座把中斷發在 `updates` 上（`node: "__interrupt__"`），
 * 不發協定裡的 `input.requested`。合成的位置在 `@nexus/harness` 的 pump。
 *
 * `custom` 這一格也是：上面只走 pump 從**日誌**合成的 domain 事件（今天只有
 * {@link DELIVERABLES_PRESENTED}），**圖自己發的 `custom` frame（`config.writer`）一律不上線**
 * ——pump 在翻譯時丟掉它們。所以放行這一格不等於放行任何工具或 plugin 往瀏覽器寫東西。
 */
export const WIRE_CHANNELS = ['messages', 'tools', 'lifecycle', 'input', 'custom'] as const;

export type WireChannel = (typeof WIRE_CHANNELS)[number];

/** `WIRE_CHANNELS` 必須是協定那份 `Channel` union 的子集——寫錯名字在這裡就編不過。 */
const _channelsAreProtocolChannels: readonly Channel[] = WIRE_CHANNELS;
void _channelsAreProtocolChannels;

export function isWireChannel(value: unknown): value is WireChannel {
  return typeof value === 'string' && (WIRE_CHANNELS as readonly string[]).includes(value);
}

/**
 * 封包的 `method` 對應到哪個 channel。
 *
 * 大多數 channel 的 method 就是 channel 名本身，`input` 是例外：訂閱時寫 `input`，
 * 封包上的 method 是 `input.requested`。這是協定自己的不對稱，不是我們加的。
 */
export function channelOfMethod(method: string): WireChannel | undefined {
  if (method === 'input.requested') {
    return 'input';
  }
  return isWireChannel(method) && method !== 'input' ? method : undefined;
}

/** 上行收得下的 method。其餘一律 404，見決策 6 的未採納清單。 */
export const UPLINK_METHODS = ['run.start', 'input.respond'] as const;

export type UplinkMethod = (typeof UPLINK_METHODS)[number];

export function isUplinkMethod(value: unknown): value is UplinkMethod {
  return typeof value === 'string' && (UPLINK_METHODS as readonly string[]).includes(value);
}

/**
 * 下行：`POST /threads/:thread_id/stream`，body 是 `EventStreamRequest`，
 * 回 `text/event-stream`。**這條 route 是協定明文規定的，不是我們挑的。**
 */
export function streamPath(threadId: string): string {
  return `/threads/${encodeURIComponent(threadId)}/stream`;
}

/**
 * 人打的斜線命令，**上行的另一半**。
 *
 * 這兩支不進 {@link UPLINK_METHODS}：那個 union 綁著協定自己的 `Command`，而
 * `@langchain/protocol@0.0.18` 的 `Command` 只有五個 method（`run.start`、
 * `subscription.subscribe`、`agent.getTree`、`input.respond`、`state.get`），
 * **沒有一個是命令列舉或命令執行**。所以信封是我們自己的
 * （[#123](https://github.com/DemianLi/nexus-agent/issues/123)）。
 *
 * 名字刻意不叫 `command.*`：**「command」這個字在這棵樹上已經被佔了兩次**——
 * {@link commandPath} 拼出來的那一段指的是**上行封包**，`apps/web` 的 `commandError`
 * 指的也是上行封包的錯誤。再用一次就分不出誰是誰。
 *
 * 端點形狀照 dsh：Remote 的正規端點是 `<namespace>/<method>`
 * （`packages/api/gateway/src/index.ts:134`），事件流是同一條傳輸上的兄弟端點。
 * 我們的 SSE ＋ 這條 RPC family 已經是那個形狀，**所以這裡沒有偏離要標**。
 */
export const SLASH_METHODS = ['slash.list', 'slash.run'] as const;

export type SlashMethod = (typeof SLASH_METHODS)[number];

export function isSlashMethod(value: unknown): value is SlashMethod {
  return typeof value === 'string' && (SLASH_METHODS as readonly string[]).includes(value);
}

/**
 * 中止這一輪（[#276](https://github.com/DemianLi/nexus-agent/issues/276)）。**以 thread 為單位、不帶
 * run id**：一條 thread 一次只跑一個 run。回 `{ accepted: true }`——只代表受理，不等停穩；這一輪
 * 結束的事實走下行（root 那顆收尾的 `lifecycle` 帶 `aborted: true`）。
 *
 * **這是我們加在自己 wire 上的命令**：`@langchain/protocol@0.0.18` 的 `Command` 沒有任何取消類的
 * method（見 {@link SLASH_METHODS} 那段的清單），所以它跟斜線命令一樣不進 {@link UPLINK_METHODS}。
 * 形狀照 dsh 的 `session.cancel({ sessionId })` → `{ accepted: true }`
 * （`packages/api/session-controller/src/commands.ts:497-510`，`c291e79`）：不查是哪個分頁送的
 * （#265 的 Q3）。
 */
export const RUN_CANCEL_METHOD = 'run.cancel';

export interface RunCancelCommand {
  readonly id: number;
  readonly method: typeof RUN_CANCEL_METHOD;
}

export function isRunCancelMethod(value: unknown): value is typeof RUN_CANCEL_METHOD {
  return value === RUN_CANCEL_METHOD;
}

/**
 * 評分與評語（[#278](https://github.com/DemianLi/nexus-agent/issues/278)、
 * [#382](https://github.com/DemianLi/nexus-agent/issues/382)）。
 *
 * **四個都是我們加在自己 wire 上的命令**，理由同 {@link RUN_CANCEL_METHOD}：協定的 `Command` 沒有
 * 這一類。形狀照 dsh 的兩個 Remote——`messageFeedback.put`／`delete`／`list` 與 `sessionFeedback.record`
 * （`packages/feedback/*`，`ddefc45`）——回應都是 `{ ok: true, value }`／`{ ok: false, error: { code } }`，
 * 業務失敗走成功回應，`ErrorResponse` 只給「這條線收不了」。
 *
 * **指名的是那則回覆的訊息 id**（`AiEntry.messageId`），同 dsh 的 `messageId`。沒有 `sessionId`：一條
 * thread 就是一個會話。
 *
 * **任何時候都收**：跑著、停在核准點、任何分頁——不經過斜線命令那道「還在跑就擋」
 * （#267 的 Q10）。所以 web 的回饋對話框送的是 `feedback.record`，不是 `slash.run` 的
 * `/feedback <文字>`。
 */
export const FEEDBACK_METHODS = [
  'feedback.put',
  'feedback.delete',
  'feedback.list',
  'feedback.record',
] as const;

export type FeedbackMethod = (typeof FEEDBACK_METHODS)[number];

export function isFeedbackMethod(value: unknown): value is FeedbackMethod {
  return typeof value === 'string' && (FEEDBACK_METHODS as readonly string[]).includes(value);
}

/**
 * 回饋的分類。結構上是 `@nexus/core` 的 `FeedbackCategory`，**重新宣告的理由同
 * {@link SlashDescriptor}**；鏡像斷言在 `@nexus/harness`。
 */
export type WireFeedbackCategory =
  | 'task-result'
  | 'instruction-following'
  | 'product-interaction'
  | 'service-stability'
  | 'resource-cost'
  | 'security-privacy-permission'
  | 'other';

export type WireFeedbackRating = 'positive' | 'negative';

/** 一則回覆目前的評分。結構上是 `@nexus/core` 的 `MessageFeedbackItem`。 */
export interface WireFeedbackItem {
  readonly messageId: string;
  readonly rating: WireFeedbackRating;
  readonly note?: string;
  readonly category?: WireFeedbackCategory;
  readonly version: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface FeedbackPutCommand {
  readonly id: number;
  readonly method: 'feedback.put';
  readonly params: {
    /** 那則回覆的訊息 id（`AiEntry.messageId`）。 */
    readonly messageId: string;
    readonly rating: WireFeedbackRating;
    readonly note?: string;
    readonly category?: WireFeedbackCategory;
    /** 看到的版本；`null` 表示要求目前沒有評分。 */
    readonly ifVersion: string | null;
  };
}

export interface FeedbackDeleteCommand {
  readonly id: number;
  readonly method: 'feedback.delete';
  readonly params: { readonly messageId: string; readonly ifVersion: string };
}

/**
 * 讀回這條 thread 目前的評分。web 照 dsh **在第一次滑過或聚焦讚踩時才讀**，重連之後再讀一次。
 */
export interface FeedbackListCommand {
  readonly id: number;
  readonly method: 'feedback.list';
  readonly params: Record<string, never>;
}

export interface FeedbackRecordCommand {
  readonly id: number;
  readonly method: 'feedback.record';
  readonly params: { readonly text?: string; readonly category?: WireFeedbackCategory };
}

export type FeedbackCommand =
  FeedbackPutCommand | FeedbackDeleteCommand | FeedbackListCommand | FeedbackRecordCommand;

/** 那個訊息 id 指不到：這條 thread 的 root 日誌裡沒有一則回覆記著它（人打的那一則、子代理的都不是）。 */
export type FeedbackTargetNotFound = {
  readonly code: 'target-not-found';
  readonly messageId: string;
};
export type FeedbackVersionConflict = {
  readonly code: 'version-conflict';
  readonly current: WireFeedbackItem | null;
};

export type FeedbackPutResult =
  | { readonly ok: true; readonly value: WireFeedbackItem }
  | {
      readonly ok: false;
      readonly error:
        | FeedbackTargetNotFound
        | FeedbackVersionConflict
        | { readonly code: 'note-blank' }
        | {
            readonly code: 'note-too-large';
            readonly maxBytes: number;
            readonly actualBytes: number;
          };
    };

export type FeedbackDeleteResult =
  | { readonly ok: true; readonly value: { readonly absent: true } }
  | { readonly ok: false; readonly error: FeedbackTargetNotFound | FeedbackVersionConflict };

/** 目前的評分，依第一次評的先後。 */
export type FeedbackListResult = {
  readonly ok: true;
  readonly value: { readonly items: readonly WireFeedbackItem[] };
};

export type FeedbackRecordResult = {
  readonly ok: true;
  readonly value: { readonly recorded: true };
};

/** `/threads/:id/commands/:method` 這條 RPC family 收得下的全部 method。 */
export type RpcMethod = UplinkMethod | SlashMethod | typeof RUN_CANCEL_METHOD | FeedbackMethod;

export function isRpcMethod(value: unknown): value is RpcMethod {
  return (
    isUplinkMethod(value) ||
    isSlashMethod(value) ||
    isRunCancelMethod(value) ||
    isFeedbackMethod(value)
  );
}

/** 命令的自由輸入怎麼提示。結構上就是 `@nexus/core` 的 `CommandInputDescriptor`。 */
export interface SlashInputDescriptor {
  readonly hint: string;
}

/**
 * 線上的命令視圖，**不帶 handler**。
 *
 * 結構上是 `@nexus/core` 的 `CommandDescriptor`，但這裡**重新宣告而不是 import**：
 * `@nexus/wire` 進得了瀏覽器正是因為它沒有執行期相依，拉 `@nexus/core` 進來會把
 * Node 那半邊一起拖過去。兩份形狀不能各走各的，所以 `@nexus/harness`
 * （唯一同時看得到兩邊的地方）釘了一條編譯期的鏡像斷言。
 */
export interface SlashDescriptor {
  readonly name: string;
  readonly description: string;
  readonly input?: SlashInputDescriptor;
}

/** 列出這條 thread 上打得出哪些命令。沒有參數——清單是整個 thread 的。 */
export interface SlashListCommand {
  readonly id: number;
  readonly method: 'slash.list';
}

/** 送一整行進去。**原文原樣**：要不要 trim 是命令自己的文法決定的。 */
export interface SlashRunCommand {
  readonly id: number;
  readonly method: 'slash.run';
  readonly params: { readonly line: string };
}

export type SlashCommand = SlashListCommand | SlashRunCommand;

/** `slash.list` 的結果，**依名字排序**（註冊表那側就排好了）。 */
export type SlashListResult = { readonly commands: readonly SlashDescriptor[] };

/**
 * `slash.run` 的結果。**三值，而且 `unknown` 不是錯誤。**
 *
 * 語法不符或名字不認得時，dsh 的 `execute` 回 `undefined`、**日誌裡一個字都不留**
 * （「Admission misses (syntax or unknown name) log nothing」）。那不是協定層的錯——
 * 封包是好的，只是那一行不是命令——所以它走成功回應的 `kind: 'unknown'`，
 * 不是 `ErrorResponse`。
 *
 * `error` 兩種來源：handler 自己回的 `kind: 'error'`，與 handler 拋出來的例外。
 * 兩者在日誌裡都已經落定成一顆 `command/done`，所以線上也是同一種形狀——
 * **但 `command_id` 只有前者有**：執行器在拋錯路徑上往外拋的是 handler 原本那顆錯誤
 * （那才是呼叫端要看的），配對 id 沒有跟著出來。缺這一格不影響日誌，日誌那側是完整的。
 */
export type SlashRunResult =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'success'; readonly command_id: string; readonly text?: string }
  | { readonly kind: 'error'; readonly command_id?: string; readonly text: string };

/**
 * 列出以前的 thread 走的路徑（[#302](https://github.com/DemianLi/nexus-agent/issues/302)），`GET`。
 *
 * 對到 dsh 的 `session/list`。**不進 {@link RpcMethod}**：那一族綁在 `/threads/:id/commands/:method`
 * 上，而列表不屬於任何一條 thread；`@langchain/protocol` 的 `Command` 也沒有這個 method（同斜線命令那兩支）。
 *
 * **`GET` 也要帶 `content-type: application/json`**，server 沒帶就回 415。這一條不是潔癖，是上行那道
 * 閘門的延伸：瀏覽器對不帶自訂 header 的跨來源 `GET` 不發 preflight，而這一份回應是每一條 thread 第一句話
 * 的開頭。帶了這個 header 就不是 simple request，逼出一個這台 server 從不回答的 preflight。
 */
export const THREADS_PATH = '/threads';

/**
 * 列表上的一列。形狀照 dsh 的 `SessionSummary`，少掉的幾格：`parentSessionId`／`origin`（subagent 不列）、
 * `cwd`（只列這台 server 那個目錄的）、`projections`（我們沒有投影快取）。多的一格是 `title`：dsh 的標題走
 * 另一個 method，我們只有內建回退那一種來源，跟著列表一起給。
 */
export interface ThreadSummary {
  readonly threadId: string;
  /** Unix epoch 毫秒：`max(建立時間, 最後一則人打的字的時間)`，同 dsh。 */
  readonly updatedAt: number;
  /** 這台 server 上這條 thread 正在跑一輪。 */
  readonly running: boolean;
  /** 還沒有任何一輪，同 dsh 的 `blank`。 */
  readonly blank: boolean;
  /** 第一則人打的字的開頭。**缺席不等於空白**：只有目標排的輪次的 thread 不是空白，但沒有人打過字。 */
  readonly title?: string;
}

/** `GET /threads` 的結果。 */
export interface ThreadListResult {
  /** 由新到舊。 */
  readonly items: readonly ThreadSummary[];
  /** header 讀不懂、或格式版本比這台 server 新而沒列的份數。 */
  readonly unreadable: number;
}

/**
 * `GET /threads` 的回應。錯誤分層同上行：載體層是 HTTP status，協定層是 200 ＋ error 封包——這台 server
 * 沒開 `--session-log` 時是後者，**不是一份空清單**：那兩件事在畫面上要分得出來。
 */
export type ThreadListResponse =
  { readonly type: 'success'; readonly result: ThreadListResult } | ErrorResponse;

/**
 * 一條 thread 的歷史（[#306](https://github.com/DemianLi/nexus-agent/issues/306) 的畫面那一刀），`GET`。
 *
 * 對到 dsh 的兩支：`session.follow` 開頭那份 snapshot（最後 {@link HISTORY_PAGE_MESSAGES} 則）與往前翻的
 * `session.page`（`packages/api/session-controller/src/history.ts:77-111,119-240`，`c291e79`）。形狀照它：
 * 一頁以**則數**切，不以事件數；往前翻帶 `beforeSeq`（上一頁的 `firstSeq`）與 `throughSeq`（第一頁定下的
 * 上界，之後每一頁讀的都是同一段日誌）。**沒有不透明的 cursor**，兩格都是日誌的位置。
 *
 * ## 偏離：送的是線上的 `Event`，不是日誌事件
 *
 * dsh 的 snapshot 與即時送的是同一種東西（日誌事件），進同一個 assembler。我們的即時 frame 是 LangGraph 的，
 * 不是日誌事件——**表達不出「同一種」**，退到最接近的：server 把日誌事件轉成線上的 `Event`，畫面沿用
 * `reduceConversation`，歷史與即時照樣走同一個折疊器。人打的字走 `messages` 的 `message-start`
 * `role: "human"`，那是協定自己留的格（「human/system messages are typically replayed as complete
 * messages」）。
 *
 * ## 歷史的 `Event` 一律不帶 `seq`
 *
 * 折疊器丟掉 `seq <= lastSeq` 的 frame，而傳輸 seq 每次行程重開從 0 起。歷史帶了日誌的耐久 seq 的話，
 * 之後的即時 frame 會全被當成重複丟掉——畫面上看不到回覆，日誌上一切正常。耐久 seq 不能冒充傳輸 seq
 * （[#89](https://github.com/DemianLi/nexus-agent/issues/89) 否掉 (A) 的理由）。`Event.seq` 在協定上是選填的。
 *
 * **`GET` 也要帶 `content-type: application/json`**，理由同 {@link THREADS_PATH}。
 */
export function historyPath(threadId: string): string {
  return `/threads/${encodeURIComponent(threadId)}/history`;
}

/** 一頁歷史的則數上限，同 dsh 的預設（`history.ts:38`）。 */
export const HISTORY_PAGE_MESSAGES = 50;

/** 拿一頁歷史的參數。三格都省略就是最後一頁。 */
export interface ThreadHistoryQuery {
  /** 這一頁最多幾則（人打的字與模型的回覆各算一則）。 */
  readonly maxMessages?: number;
  /** 只要這個位置之前的；往前翻時帶上一頁的 `firstSeq`。 */
  readonly beforeSeq?: number;
  /** 讀到哪裡為止（含）；往前翻時帶第一頁的 `throughSeq`。 */
  readonly throughSeq?: number;
}

/** 一頁歷史。 */
export interface ThreadHistoryResult {
  /** 照順序折進 `reduceConversation`。**一顆都不帶 `seq`**，見 {@link historyPath}。 */
  readonly events: readonly Event[];
  /** 這一頁從日誌的哪個位置起。往前翻時當 `beforeSeq` 帶回來。 */
  readonly firstSeq: number;
  /** 這份 snapshot 讀到哪裡為止（含）。一顆事件都沒有時是 -1。 */
  readonly throughSeq: number;
  /** 這一頁之前還有看得見的東西。 */
  readonly hasMore: boolean;
  /**
   * 這條會話是舊格式（格式 9 以前寫的）：模型的回覆沒有保存，畫面上只有人打的字與工具卡，模型也從空的開始。
   * 判法與推模型歷史的一側是同一條（`@nexus/core` 的 `replayConversation` 推不出來，原因是缺回覆、缺結果內容或
   * 缺摘要本文——三樣都是格式 9 才開始記的），整份日誌判一次。
   */
  readonly legacy: boolean;
}

/** `GET /threads/:id/history` 的回應。錯誤分層同 {@link ThreadListResponse}。 */
export type ThreadHistoryResponse =
  { readonly type: 'success'; readonly result: ThreadHistoryResult } | ErrorResponse;

/**
 * 上行：協定只在 WebSocket 那條路上指定怎麼送 `Command`，HTTP 這格是空的。
 * 補這一格的是 dsh 的 gateway（`packages/api/gateway/src/index.ts:134`，端點是
 * `<namespace>/<method>`）——**路徑指名 method，封包裡也帶 method，兩者不合就是錯誤**。
 * 這裡照抄那個不變量，斜線命令那兩支也一樣受它管。
 */
export function commandPath(threadId: string, method: RpcMethod): string {
  return `/threads/${encodeURIComponent(threadId)}/commands/${method}`;
}

/** SSE 的 `id:` 欄位；協定的 `Event.event_id` 註明它就是對應這個。 */
export function eventId(threadId: string, seq: number): string {
  return `${threadId}:${seq}`;
}

export function errorResponse(id: number | null, error: ErrorCode, message: string): ErrorResponse {
  return { type: 'error', id, error, message };
}

export function successResponse(id: number, result: Record<string, unknown>): CommandResponse {
  return { type: 'success', id, result };
}
