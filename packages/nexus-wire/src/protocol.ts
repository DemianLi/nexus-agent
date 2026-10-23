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
  Extensible,
  InputRespondOne,
  RunStartParams,
} from '@langchain/protocol';

// 命令與回饋的詞彙是 core 的型別，這裡只取別名（#683）。**只有 `import type`**，`@nexus/core` 只進
// `devDependencies`：`verbatimModuleSyntax` 會把這兩行整行擦掉，所以上面「plain node 那條路」與瀏覽器都不會載到 core。
import type { CommandDescriptor, CommandInputDescriptor } from '@nexus/core/src/commands.ts';
import type {
  FeedbackCategory,
  MessageFeedbackItem,
  MessageFeedbackRating,
} from '@nexus/core/src/feedback.ts';

import type {
  ATTACHMENT_NOT_FOUND,
  MODEL_DOES_NOT_SUPPORT_IMAGES,
  PromptAttachment,
} from './attachments.js';
import { isDeliverableMethod } from './deliverables.js';
import { isGoalMethod } from './goal.js';
import type { GoalMethod, GoalPauseCommand } from './goal.js';
import { isModelMethod } from './model-selection.js';
import type { ModelCommand, ModelMethod } from './model-selection.js';
import { isPermissionMethod } from './permission-presets.js';
import { WireProtocolError } from './protocol-error.js';
import { isSubagentListMethod } from './subagent-list.js';
import type {
  SubagentListCommand,
  SubagentMention,
  SUBAGENT_LIST_METHOD,
} from './subagent-list.js';
import { isThreadManagementMethod } from './thread-management.js';
import type {
  ThreadListSets,
  ThreadManagementCommand,
  ThreadManagementMethod,
} from './thread-management.js';
import type { PermissionCommand, PermissionMethod } from './permission-presets.js';
import type { TrajectoryTurnDetail } from './trajectory.js';
import type { DeliverableCommand, DeliverableMethod } from './deliverables.js';

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
 * `custom` 這一格也是：上面只走 pump 從**日誌**合成的 domain 事件（有哪些名字、各帶什麼酬載，看 `custom-frame.ts`
 * 那張名字→酬載表，[#685](https://github.com/DemianLi/nexus-agent/issues/685)），**圖自己發的 `custom` frame（`config.writer`）一律不上線**
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

/**
 * 送出的那一句怎麼進收件匣（[#710](https://github.com/DemianLi/nexus-agent/issues/710)），照 dsh `prompt` 的 `mode`
 * （`packages/api/session-controller/src/commands.ts:364`，`477b4f4`）：
 *
 * - `queue`（省略就是它）：排進 `next-turn`，等這一輪收掉再開新的一輪。
 * - `steer`：插話，排進 `next-step`，跑著的這一輪下一步就送進模型、不停。這一輪已經不收插話時（閒著、按了停止、
 *   正在收尾）同 dsh 改排 `next-turn`，照樣開一輪。
 */
export const RUN_START_MODES = ['queue', 'steer'] as const;

export type RunStartMode = (typeof RUN_START_MODES)[number];

/**
 * `run.start` 的封包。**`params` 比協定的 `RunStartParams` 多一格我們自己的 {@link RunStartMode}**：協定的 `Command`
 * 沒有送出模式那一格，而 dsh 的送出模式就掛在送出請求本身（`prompt` 的 `mode`）。另立一支命令的話，同一句話會有
 * 兩條上行，將來每會話的模型選擇（#723）也要掛在送出請求上，又得再長一支。所以加在這裡。
 */
export interface RunStartCommand {
  readonly id: number;
  readonly method: 'run.start';
  readonly params: RunStartParams & {
    readonly mode?: RunStartMode;
    /**
     * 這句話帶的檔案收據（[#732](https://github.com/DemianLi/nexus-agent/issues/732)，形狀見 `attachments.ts`）。
     * 協定的 `RunStartParams` 沒有這一格，dsh 的對應物是 prompt 內容裡的 `{ type: 'file', receiptId }` 區塊。
     * 沒實作的 server 對非空的 `attachments` 回 `not_supported`。
     */
    readonly attachments?: readonly PromptAttachment[];
    /**
     * 這句話點名派哪一種子代理（[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 2 項，形狀見 `subagent-list.ts`）。
     * 協定的 `RunStartParams` 沒有這一格，dsh 也沒有使用者派工的入口。沒實作的 server 對有值的 `mention` 回 `not_supported`；
     * 名字不在 `subagent.list` 上回 `invalid_argument`。
     */
    readonly mention?: SubagentMention;
    /**
     * 客戶端給這一次送出的請求編號（[#1335](https://github.com/DemianLi/nexus-agent/issues/1335)），**選填**。
     * 照 dsh `session.prompt` 的 `requestId`（`packages/api/session-controller/src/types.ts:340`，`d7432673886`）：
     * 帶了的話，伺服器先查這個編號收過沒有，收過就**不再排第二次**。
     *
     * **為什麼需要**：請求到了伺服器、回應卻斷在半路時，客戶端分不出「沒送到」還是「送到了、只是沒收到回條」，使用者
     * 會再按一次送出；沒有編號的話伺服器分不出這是同一句，模型就會看到兩次同樣的話。
     *
     * **用法**：每一句話送出時產生一個新編號（UUID 之類，客戶端自己保證唯一），**同一句話重送沿用同一個編號**；不同的話
     * 用不同的編號。只比編號、不比內容（同 dsh）：同編號不同文字的第二次也當成同一句。
     *
     * **回應**：第一次與重送都回 `{ run_id }`，**重送回的是原本那一件的 `run_id`**，所以客戶端據它對上自己已經畫出來的那一句，
     * 不必多畫一則。認得的範圍是這條 thread 的三個階段：還排著、已經領走開了一輪、已經落進日誌（含伺服器重啟之後）；
     * 排著的那一句被使用者刪掉之後，同一個編號再送就是新的一句。
     *
     * **形狀**：非空字串，至多 {@link REQUEST_ID_MAX_LENGTH} 個字元，其餘回 `invalid_argument`。省略＝維持現狀（每次都排一次），
     * 舊客戶端不受影響。沒實作的舊 server 會略過這一格。
     */
    readonly request_id?: string;
    /**
     * 使用者在哪個時區（[#1629](https://github.com/DemianLi/nexus-agent/issues/1629)），**選填**，給 `@nexus/plugin-time-context`
     * 的「Browser time zone」那一行用。照 dsh `session.prompt` 的 `clientTimeZone`（`packages/api/session-controller/src/index.ts:467-482`，
     * `687f282e`）：多人共用一台主機時，主機的時區不等於每個使用者的時區，瀏覽器知道使用者在哪。
     *
     * **形狀**：`UTC` 或 IANA 的 `Area/Location` 名（例如 `Asia/Taipei`）；伺服器會驗證並正規化（別名退回正規名，所以日誌上記的是正規名），
     * 空字串、前後有空白、格式不對、系統不認得的名字回 `invalid_argument`，訊息指名這個欄位，那句話不進佇列。
     * 省略＝維持現狀（模型被告知時區不明，遇到「明天」會向使用者確認），舊客戶端不受影響；沒實作的舊 server 會略過這一格。
     *
     * 這個欄位記在這句話的來源上（一輪開頭那句的 `turn/start`、輪中插話的 `user/message`），**不是**這條 thread 的設定：
     * 同一條 thread 上不同句話可以來自不同時區，模型看到的是這一輪裡有幾種。
     */
    readonly client_time_zone?: string;
  };
}

/** `run.start` 的 `request_id` 最長幾個字元。夠放 UUID；擋的是把整段文字當編號塞進日誌的客戶端 bug。 */
export const REQUEST_ID_MAX_LENGTH = 200;

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
 * 這條對話用 `/名字` 叫得出哪些技能（[#1574](https://github.com/DemianLi/nexus-agent/issues/1574) N0929）。**只讀，不帶正文**。
 *
 * 照 dsh 的 `skills/list({ sessionId })`（`packages/api/session-controller/src/skill-catalog.ts:35-91`，`687f282e`）：只回人叫得到的
 * （`isUserInvocable`），依名字逐碼排序（`skill/src/index.ts` 的 `compareSkillSummary`），每列是 {@link SkillEntry}。thread 在路徑上，
 * 同 {@link SLASH_METHODS}，所以沒有 `sessionId` 那一格；端點形狀同 {@link SLASH_METHODS} 那段說的，沒有偏離要標。
 *
 * 這台 server 沒掛 `skills` 那一列時回 `not_supported`（dsh 是「registry 不在」的 `gateway/internal`，碼用我們現有的）；
 * 掛了但沒有技能是 `{ skills: [] }`。
 */
export const SKILL_METHODS = ['skill.list'] as const;

export type SkillMethod = (typeof SKILL_METHODS)[number];

export function isSkillMethod(value: unknown): value is SkillMethod {
  return typeof value === 'string' && (SKILL_METHODS as readonly string[]).includes(value);
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
 * 改或刪送出佇列裡排著的一件（[#637](https://github.com/DemianLi/nexus-agent/issues/637)）。佇列本身的形狀見
 * `inbox.ts`。
 *
 * 照 dsh 的 `session.updateQueue({ sessionId, itemId, action })` → `{ accepted: true }`
 * （`packages/api/session-controller/src/commands.ts:432-504`，`477b4f4`）。**thread 在路徑上**，同
 * {@link RUN_CANCEL_METHOD}，所以 params 裡沒有 `sessionId` 那一格。
 *
 * - `edit`：換掉文字，id 與位置不變。只收文字，空白回 `invalid_argument`（dsh 回 `gateway/bad-request`）。
 * - `remove`：拿掉，它不會跑。
 * - 已經不在隊裡（開跑了、被刪了、從沒有過）：回 {@link QUEUE_ITEM_NOT_FOUND}，同 dsh 的
 *   `session/queue-item-not-found`。
 * - `steer`：排著的那一件改成插話（[#710](https://github.com/DemianLi/nexus-agent/issues/710)），下一步送進模型、這一輪
 *   不停。條件照 dsh：那一件還在 `next-turn`、這一輪還收插話，否則回 {@link STEER_UNAVAILABLE}，同 dsh 的
 *   `session/steer-unavailable`（`:495-497`）。
 *
 * 改、刪兩條清單裡的都找得到（dsh `:469-472`），插話的那一件也能改能刪，直到它被領走。
 *
 * **這是我們加在自己 wire 上的命令**，理由同 {@link RUN_CANCEL_METHOD}：`@langchain/protocol@0.0.18` 的 `Command`
 * 沒有佇列類的 method。改、刪**任何時候都收**：跑著、停在核准點、按了停止之後都能改能刪。
 */
export const QUEUE_UPDATE_METHOD = 'queue.update';

/** `queue.update` 的改、刪兩種。 */
export type QueueUpdateAction =
  { readonly kind: 'edit'; readonly text: string } | { readonly kind: 'remove' };

/**
 * `queue.update` 的第三種：改成插話（#710）。**不併進 {@link QueueUpdateAction}**：那個聯集今天在 web 裡被窮舉成改、刪兩種，
 * 加寬它會讓 web 當場編不過，而 web 送不送插話是它自己那一張卡的事。上行的型別收兩種的聯集。
 */
export interface QueueSteerAction {
  readonly kind: 'steer';
}

export interface QueueUpdateCommand {
  readonly id: number;
  readonly method: typeof QUEUE_UPDATE_METHOD;
  readonly params: {
    /** 那一件的 id：送出它的 `run.start` 回的 `run_id`。 */
    readonly item_id: string;
    readonly action: QueueUpdateAction | QueueSteerAction;
  };
}

export function isQueueUpdateMethod(value: unknown): value is typeof QUEUE_UPDATE_METHOD {
  return value === QUEUE_UPDATE_METHOD;
}

/**
 * 那一件已經不在送出佇列裡。
 *
 * **不在協定的 `ErrorCode` 裡**（`@langchain/protocol@0.0.18` 只有十個碼，沒有佇列類），所以錯誤碼在這一層擴充成
 * {@link WireErrorCode}，同 {@link QUEUE_UPDATE_METHOD} 是我們自己的命令。最近的 `no_such_run` 講的是 run，一件被領走
 * 開跑的輸入在我們這裡正好就有一個 run，拿它會讓「已經開跑」與「沒有這個 run」讀起來是同一件事。
 */
export const QUEUE_ITEM_NOT_FOUND = 'queue_item_not_found';

/**
 * 這一輪不收插話了：`queue.update` 的 `steer` 撞上那一件已經不在 `next-turn`（已經是插話、或被領走了），或這一輪
 * 已經不收插話（閒著、按了停止、正在收尾）。同 dsh 的 `session/steer-unavailable`。擴充的理由同
 * {@link QUEUE_ITEM_NOT_FOUND}。
 */
export const STEER_UNAVAILABLE = 'steer_unavailable';

/**
 * 對單一背景子代理傳話、單獨停下（[#865](https://github.com/DemianLi/nexus-agent/issues/865)）。
 *
 * 照 dsh 對 continuable 子代理的兩個動作（`477b4f4`）：
 * - `subagent.send` ＝ 瀏覽器端的 `prompt`：**人**對那個子代理說一句話。模型看到的是原文，**沒有**
 *   `Agent … sent a message:` 前綴（那是 agent 轉的才有）。對方跑著且這一輪還收插話：下一步領走；閒著、或已被中止／收尾：
 *   開下一輪；已結算而並存名額滿了：{@link SUBAGENT_AT_CAPACITY}。
 * - `subagent.interrupt` ＝ `interruptByParent`：只停它**當下那一輪**，不等停穩，**不連帶 root**（root 的 `run.cancel`
 *   也不連帶它）。被它中斷而排著的輪次不丟，等下一次 `subagent.send` 喚醒。不認得的編號、沒在跑的：**被接受的 no-op**
 *   （dsh 明寫，也不讓呼叫端靠回應試探編號）。
 *
 * **兩個都回 `{ accepted: true }`，不等那一輪跑完**；子代理說了什麼、做了什麼走主串流（`agent-message` 與委派卡）。
 * 人說的那句話目前**不回播到主串流**：它寫在子代理自己的日誌裡，主對話日誌沒有對應的事件（今天不加）。
 *
 * `run_id` 是背景派出時回給模型的編號（`bg-…`），**只認這條 thread 派出去的**：host 屬於這條 thread，別條的編號在這裡
 * 就是不存在——直接 parent 的鄰接是結構保證，授權就是這條線已有的會話認證。這份組裝沒有背景派出：
 * 一樣是 {@link SUBAGENT_NOT_FOUND}（`subagent.interrupt` 則是 no-op）。
 *
 * **重啟之後的冷子代理（[#1271](https://github.com/DemianLi/nexus-agent/issues/1271)，缺口源自 #737）**：`subagent.send` 對一條只在磁碟上、
 * 還沒載入的 thread 會把它建起來（`subagent.interrupt` 仍不建），載體冷讀 root 日誌認得重啟之前派出的子代理；對冷的送話就是叫醒它，
 * 之後同一般投遞。叫醒失敗（別的行程握著寫入把手、日誌壞了……）回 `unknown_error`，原因寫在 message，子代理仍是冷的、可以再送。
 * 並存名額在重建之前佔：滿了回 {@link SUBAGENT_AT_CAPACITY}，沒去握租約。叫不醒的（舊日誌沒有身分）回 {@link SUBAGENT_NOT_FOUND}，
 * message 說明原因。磁碟上也沒有這條 thread：{@link SUBAGENT_NOT_FOUND}，不建 agent。`subagent.interrupt` 對冷的是被接受的 no-op（dsh）。
 *
 * **都是我們加在自己 wire 上的命令**，理由同 {@link RUN_CANCEL_METHOD}。
 */
export const SUBAGENT_SEND_METHOD = 'subagent.send';
export const SUBAGENT_INTERRUPT_METHOD = 'subagent.interrupt';

export interface SubagentSendCommand {
  readonly id: number;
  readonly method: typeof SUBAGENT_SEND_METHOD;
  readonly params: {
    readonly run_id: string;
    /** 不能是空白；長度不另設上限，同 `run.start`。 */
    readonly text: string;
    /**
     * 使用者在哪個時區（[#1734](https://github.com/DemianLi/nexus-agent/issues/1734)），**選填**，形狀與語意同 `run.start` 的
     * `client_time_zone`（[#1629](https://github.com/DemianLi/nexus-agent/issues/1629)）：`UTC` 或 IANA 的 `Area/Location` 名，伺服器驗證並正規化，
     * 不合法回 `invalid_argument` 並指名這個欄位，那句話不送給子代理。照 dsh `subagent.prompt` 的 `clientTimeZone`
     * （`packages/subagent/subagent/src/index.ts:447-475`、`control-types.ts:110`，`687f282e`）。**錯誤碼對照**：dsh 回的是
     * `subagent/invalid-time-zone`，我們沿用 `run.start` 的 `invalid_argument`（這條 wire 沒有 dsh 的命名空間碼，欄位名寫在 message 裡）。
     *
     * 記在子代理**自己日誌**裡這句話的來源上（開一輪的 `turn/start`、插進跑著那一輪的 `user/message`），所以子代理的下一則讀數是 `resolved`。
     * **派出去的那一輪不帶時區**（沒有人在說話；dsh 的 `manager.ts:464` 同樣給 `{ kind: 'user' }`）：第一則讀數是 `missing`。
     * 省略＝維持現狀；沒實作的舊 server 會略過這一格。
     */
    readonly client_time_zone?: string;
  };
}

export interface SubagentInterruptCommand {
  readonly id: number;
  readonly method: typeof SUBAGENT_INTERRUPT_METHOD;
  readonly params: { readonly run_id: string };
}

export function isSubagentMethod(
  value: unknown,
): value is typeof SUBAGENT_SEND_METHOD | typeof SUBAGENT_INTERRUPT_METHOD {
  return value === SUBAGENT_SEND_METHOD || value === SUBAGENT_INTERRUPT_METHOD;
}

/** 沒有這個背景子代理：編號不是這條 thread 派出去的，或這條 thread 沒有背景派出。只有 `subagent.send` 會回。 */
export const SUBAGENT_NOT_FOUND = 'subagent_not_found';
/** 對方已結算，而並存的背景子代理已達上限，沒有名額讓它再收一輪。等其中一個做完再送。 */
export const SUBAGENT_AT_CAPACITY = 'subagent_at_capacity';
/** 背景子代理的載體已經關閉（這條 thread 正在拆）。 */
export const SUBAGENT_CLOSED = 'subagent_closed';

/** 按需拉軌跡的某一輪（{@link trajectoryTurnPath}），錨點在日誌裡沒有對應的輪。 */
export const TURN_NOT_FOUND = 'turn_not_found';

/**
 * serve 行程裡的 thread 數已到管理者設的上限（`#settings/thread-capacity`，[#1476](https://github.com/DemianLi/nexus-agent/issues/1476)），
 * 這條新 thread 沒建。任何會經 `threadFor` 新建組裝的路都可能回（送訊息、讀歷史、續聊磁碟上的舊 thread）；
 * 已在行程裡的 thread 不受影響。名額不會自己回來——沒開閒置逐出時要重啟 serve 才釋放；開了（`idleEvictAfterMs`，[#1484](https://github.com/DemianLi/nexus-agent/issues/1484)）
 * 則閒置夠久的 thread 被撤掉就還名額。message 寫了上限與對應的下一步。
 */
export const THREAD_AT_CAPACITY = 'thread_at_capacity';

/**
 * 這個 id 是**子代理的會話**（`<thread>/<編號>`，header 是子代理的：`origin: 'subagent'`，或 50 以前帶 `parentSession` 的），不能當一條 thread 開或驅動
 * （[#1544](https://github.com/DemianLi/nexus-agent/issues/1544)）。serve 在碰日誌之前就拒絕，日誌一個位元組都不動。
 * 要對子代理說話，請從它的主對話用 `subagent.send`。對到 dsh 的 `session/agent-busy`＋`use subagent delivery`
 * （`packages/api/session-controller/src/agent.ts:24-30`、`:127-133`）。**不是暫時失敗，重試沒用**。
 */
export const THREAD_IS_SUBAGENT = 'thread_is_subagent';

/**
 * 這條 thread 的歷史（磁碟上的會話日誌）裡有一則巢狀太深，灌不回 serve 的狀態，這條 thread 建不起來
 * （[#1668](https://github.com/DemianLi/nexus-agent/issues/1668)）。多半是上限出現之前寫下的舊日誌。message 寫了是日誌第幾顆事件、
 * 幾層、上限多少。**不是暫時失敗，重試沒用**：同一份日誌每次都一樣深。任何會經 `threadFor` 續接舊 thread 的路都可能回。
 */
export const THREAD_HISTORY_TOO_DEEP = 'thread_history_too_deep';

/**
 * serve 正在收尾（`close()` 已經開始：收到 `SIGTERM`／`SIGINT`，或致命例外；`close()` 一開始就停收新的一輪，**不論有沒有 `/readyz` 時間窗**——
 * `drainMs: 0`、沒人抓過 `/readyz`、致命例外不等時間窗的路徑都一樣，[#1787](https://github.com/DemianLi/nexus-agent/issues/1787)），
 * **這一句話沒有送出**：會開新一輪的上行命令一律回這個碼，HTTP 照舊 200：
 * `run.start`、`subagent.send`，以及 `slash.run` 裡會開一輪的命令——`/plan <話>`、`/goal <目標>`（建立）、`/goal resume`、
 * `/goal edit`（改進行中的目標、或換掉已完成的目標）、`/goal create|edit` 帶附件。`/goal` 這幾種不 steer，但目標一變成進行中排程器就自己起一輪，
 * 所以在寫 `goal/change` 之前就拒（沒有目標被建起來、也沒有被續上）。`/goal pause`／`clear`、`run.cancel`、`input.respond`、`queue.update`、讀取與下行不受影響。
 *
 * **重送**：請求編號沒用掉；重啟之後帶同一個 `request_id` 重送，已經收過的那一筆照樣拿回原本的 `run_id`。**附件不一定能原樣重送**：
 * 上傳過的檔案收據放在 serve 的記憶體表裡，被拒時雖然放回去，重啟之後表是空的，**檔案要重新上傳**；圖片是隨請求帶來的，重送即可。
 * 重試馬上沒用——這台 serve 是在關機——要等它重新起來。
 *
 * **message 是寫給使用者看的**，不是給管理者的（本專案其他碼的 message 多半給管理者看）：web 目前直接把 `result.message` 顯示在輸入框旁，
 * 所以這裡寫的是「這句話沒有送出；稍後再送一次」的口吻。要讓 web 改用自己的固定文案，認這個碼就行（同 `thread_at_capacity`）。
 */
export const SERVER_CLOSING = 'server_closing';

/** 這條線上的錯誤碼：協定的那十個，加上我們自己的命令用到的。 */
export type WireErrorCode =
  | ErrorCode
  | typeof TURN_NOT_FOUND
  | typeof QUEUE_ITEM_NOT_FOUND
  | typeof STEER_UNAVAILABLE
  | typeof SUBAGENT_NOT_FOUND
  | typeof SUBAGENT_AT_CAPACITY
  | typeof SUBAGENT_CLOSED
  | typeof THREAD_AT_CAPACITY
  | typeof THREAD_IS_SUBAGENT
  | typeof THREAD_HISTORY_TOO_DEEP
  | typeof SERVER_CLOSING
  | typeof MODEL_DOES_NOT_SUPPORT_IMAGES
  | typeof ATTACHMENT_NOT_FOUND;

/**
 * 協定的 `ErrorResponse`，錯誤碼換成 {@link WireErrorCode}。
 *
 * **不能寫成 `Omit<ErrorResponse, 'error'> & {...}`**（[#1166](https://github.com/DemianLi/nexus-agent/issues/1166)）：
 * `ErrorResponse` 是 `Extensible & {...}`，`Extensible` 帶 `string` 索引簽名，`Omit` 的 `keyof` 因此是 `string`，
 * `Pick` 只剩索引簽名，`type`、`id`、`message` 這些具名鍵全掉了——`UplinkResult` 在 `type === 'error'` 之後不收窄，
 * `message` 讀出來是 `any`。所以具名鍵照 `ErrorResponse` 逐個列出，只把 `error` 換掉；索引簽名留著（協定允許額外欄位）。
 */
export type WireErrorResponse = Extensible & {
  type: 'error';
  id: ErrorResponse['id'];
  error: WireErrorCode;
  message: string;
  stacktrace?: string;
  meta?: ErrorResponse['meta'];
};

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
 * 回饋的分類：**就是 `@nexus/core` 的 `FeedbackCategory`**，別名，不另寫一份（[#683](https://github.com/DemianLi/nexus-agent/issues/683)）。
 * 理由同 {@link SlashDescriptor}。
 */
export type WireFeedbackCategory = FeedbackCategory;

/** 對一則回覆的整體判斷：**就是 `@nexus/core` 的 `MessageFeedbackRating`**。 */
export type WireFeedbackRating = MessageFeedbackRating;

/** 一則回覆目前的評分：**就是 `@nexus/core` 的 `MessageFeedbackItem`**。 */
export type WireFeedbackItem = MessageFeedbackItem;

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
export type RpcMethod =
  | UplinkMethod
  | SlashMethod
  | SkillMethod
  | typeof RUN_CANCEL_METHOD
  | typeof QUEUE_UPDATE_METHOD
  | typeof SUBAGENT_SEND_METHOD
  | typeof SUBAGENT_INTERRUPT_METHOD
  | FeedbackMethod
  | GoalMethod
  | DeliverableMethod
  | ModelMethod
  | PermissionMethod
  | ThreadManagementMethod
  | typeof SUBAGENT_LIST_METHOD;

export function isRpcMethod(value: unknown): value is RpcMethod {
  return (
    isUplinkMethod(value) ||
    isSlashMethod(value) ||
    isSkillMethod(value) ||
    isRunCancelMethod(value) ||
    isQueueUpdateMethod(value) ||
    isSubagentMethod(value) ||
    isFeedbackMethod(value) ||
    isGoalMethod(value) ||
    isDeliverableMethod(value) ||
    isModelMethod(value) ||
    isPermissionMethod(value) ||
    isThreadManagementMethod(value) ||
    isSubagentListMethod(value)
  );
}

/**
 * 每支上行命令的 `params` 收哪些欄位（[#1572](https://github.com/DemianLi/nexus-agent/issues/1572)，N1228）。
 *
 * 照 dsh 的 `assertExactArguments`（`packages/api/gateway/src/index.ts:1613-1640`，`687f282e`）：欄位集合要跟描述完全一致，
 * 多一格就拋 `gateway/arguments-invalid`，訊息只指名欄位、不帶值。**偏離（理由 1：基座表達不出來）**：dsh 的鍵集來自 Typert
 * 描述，這裡沒有 Typert，所以用這張表代替。型別與執行期看同一份：`satisfies` 讓**新增 method 時編譯當場報錯**，下面的
 * `_paramKeysAgree` 讓**每一列等於該命令 `params` 的 keyof（扣掉 {@link RPC_PARAMS_NOT_IMPLEMENTED}）**——命令型別多一格或少一格、
 * 表漏登或多登，`tsc` 都紅。
 *
 * **只列這台 server 讀得懂的欄位。** 協定的型別上合法、但這台 server 沒實作的欄位在 {@link RPC_PARAMS_NOT_IMPLEMENTED}，不在這張表。
 * `input.respond` 的 `responses` 在表裡，是為了讓批次形照舊走 `not_supported`。
 *
 * 沒有參數的命令是空陣列。`params` 省略時這張表不管（有些命令的型別本來就沒有 `params`，缺不缺由各命令自己決定）；
 * 有給就要是物件，多一格就是多的。
 */
export const RPC_PARAM_KEYS = {
  'run.start': [
    'assistant_id',
    'input',
    'mode',
    'attachments',
    'mention',
    'request_id',
    'client_time_zone',
  ],
  'input.respond': ['namespace', 'interrupt_id', 'response', 'responses'],
  'slash.list': [],
  'slash.run': ['line', 'attachments'],
  'skill.list': [],
  'run.cancel': [],
  'queue.update': ['item_id', 'action'],
  'subagent.send': ['run_id', 'text', 'client_time_zone'],
  'subagent.interrupt': ['run_id'],
  'subagent.list': [],
  'feedback.put': ['messageId', 'rating', 'note', 'category', 'ifVersion'],
  'feedback.delete': ['messageId', 'ifVersion'],
  'feedback.list': [],
  'feedback.record': ['text', 'category'],
  'goal.pause': ['goalId', 'revision'],
  'deliverable.read': ['seq', 'index', 'offset', 'limit'],
  'deliverable.readBytes': ['seq', 'index', 'offset', 'length'],
  'model.catalog': [],
  'model.select': ['modelId', 'reasoningEffort'],
  'permission.catalog': [],
  'thread.pin': [],
  'thread.unpin': [],
  'thread.archive': ['stopActivity'],
  'thread.unarchive': [],
  'thread.rename': ['title'],
  'thread.fork': ['messageId'],
} as const satisfies Record<RpcMethod, readonly string[]>;

/**
 * 協定型別上合法、但這台 server **沒實作**的 `params` 欄位（[#1572](https://github.com/DemianLi/nexus-agent/issues/1572)，Q2 (a)）。
 * 有值（含空物件）就回 `not_supported` 並指名欄位，**不是** `invalid_argument`——同 `attachments`、`mention` 的既有模式：欄位在協定裡合法，
 * 只是這台 server 沒有東西去讀它。不拒的話，客戶端以為「這一次的 config 覆寫」生效了，其實被靜靜忽略。
 * 這些欄位不在 {@link RPC_PARAM_KEYS}；其餘不認得的欄位走 {@link unknownParamKeys}，回 `invalid_argument`。
 */
export const RPC_PARAMS_NOT_IMPLEMENTED = {
  'run.start': ['config', 'metadata'],
  'input.respond': ['update', 'goto', 'config', 'metadata'],
} as const satisfies Partial<Record<RpcMethod, readonly string[]>>;

/** 逐支命令的 `params` 型別：命令型別是聯集，所以用 `Extract` 取出那一支。 */
type RpcCommand =
  | RunStartCommand
  | Extract<Command, { method: 'input.respond' }>
  | SlashCommand
  | SkillListCommand
  | RunCancelCommand
  | QueueUpdateCommand
  | SubagentSendCommand
  | SubagentInterruptCommand
  | FeedbackCommand
  | GoalPauseCommand
  | DeliverableCommand
  | ModelCommand
  | PermissionCommand
  | SubagentListCommand
  | ThreadManagementCommand;

/**
 * 一支命令的 `params` 有哪些鍵。`params` 是聯集時取所有分支的鍵（`input.respond` 的單一形與批次形）；沒有 `params`、或寫成
 * `Record<string, never>`（鍵是 `string`，意思是「不收任何欄位」）的是 `never`。
 */
type ParamKeysOf<M extends RpcMethod> =
  Extract<RpcCommand, { method: M }> extends infer C
    ? C extends { readonly params: infer P }
      ? P extends unknown
        ? string extends keyof P
          ? never
          : keyof P & string
        : never
      : never
    : never;

type TableKeysOf<M extends RpcMethod> =
  | (typeof RPC_PARAM_KEYS)[M][number]
  | (M extends keyof typeof RPC_PARAMS_NOT_IMPLEMENTED
      ? (typeof RPC_PARAMS_NOT_IMPLEMENTED)[M][number]
      : never);

/** 每支命令：`params` 的鍵與表（含沒實作的）互相包含就是 `true`，否則是那支命令的名字，下面的賦值當場編不過並指出是哪一支。 */
type ParamKeysAgree = {
  readonly [M in RpcMethod]: [ParamKeysOf<M>] extends [TableKeysOf<M>]
    ? [TableKeysOf<M>] extends [ParamKeysOf<M>]
      ? true
      : M
    : M;
};

/** `RPC_PARAM_KEYS` 與命令型別的 `params` 對不上，這一行就編不過；指出的是 `RpcMethod` 裡哪一支。 */
const _paramKeysAgree: { readonly [M in RpcMethod]: true } = {} as ParamKeysAgree;
void _paramKeysAgree;

/**
 * `params` 裡**這支命令不認得**的欄位名，依出現順序。**不含** {@link RPC_PARAMS_NOT_IMPLEMENTED} 的那幾格（那些走 `not_supported`）。
 * `params` 不是物件（`null`、陣列、字串……）就沒有欄位可數，回空陣列；那一類由 server 在這之前以 `invalid_argument` 擋下。
 *
 * 只看自有的字串鍵（`JSON.parse` 出來的物件沒有別的）；`__proto__` 這種鍵在 JSON 裡是普通的自有鍵，照樣被數到。
 */
export function unknownParamKeys(method: RpcMethod, params: unknown): readonly string[] {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return [];
  const allowed: readonly string[] = RPC_PARAM_KEYS[method];
  const notImplemented: readonly string[] =
    (RPC_PARAMS_NOT_IMPLEMENTED as Partial<Record<RpcMethod, readonly string[]>>)[method] ?? [];
  return Object.keys(params).filter(
    (key) => !allowed.includes(key) && !notImplemented.includes(key),
  );
}

/** 命令的自由輸入怎麼提示：**就是 `@nexus/core` 的 `CommandInputDescriptor`**。 */
export type SlashInputDescriptor = CommandInputDescriptor;

/**
 * 線上的命令視圖，**不帶 handler**。
 *
 * **就是 `@nexus/core` 的 `CommandDescriptor`**，別名，不另寫一份（[#683](https://github.com/DemianLi/nexus-agent/issues/683)）。
 * 照 dsh：UI 對領域套件做 type-only 相依拿型別，只有一份（dsh `packages/client/ui-commands/src/client/directory.ts:8`
 * 從 `dsh-commands/types` 拿 `CommandDescriptor`）。原本手抄一份、在 harness 釘單向可指派，core 多一格選填欄位時
 * 照樣編得過——兩份本來就不該存在。
 *
 * `import type` 進不了瀏覽器的執行期（`verbatimModuleSyntax` 整行擦掉），但會把 core 這兩個檔的型別圖帶進
 * web 的 `tsc`：`commands.ts` 引 `SessionLog`、`feedback.ts` 引 `session-log.ts`，一路到 langchain 的型別。
 * dsh 的那條邊指向純型別的 `./types` 子路徑；我們 core 還沒有那樣的檔，所以邊照 dsh、窄度沒照到。
 *
 * **型別一樣不等於線上一樣**：`slash.list` 的結果在 client 的 `readDescriptors` 逐格重建，core 多一格欄位時
 * 型別上有、瀏覽器拿到的沒有，要那一格上線得去那裡補。
 */
export type SlashDescriptor = CommandDescriptor;

/** 列出這條 thread 上打得出哪些命令。沒有參數——清單是整個 thread 的。 */
export interface SlashListCommand {
  readonly id: number;
  readonly method: 'slash.list';
}

/** 送一整行進去。**原文原樣**：要不要 trim 是命令自己的文法決定的。 */
export interface SlashRunCommand {
  readonly id: number;
  readonly method: 'slash.run';
  readonly params: {
    readonly line: string;
    /**
     * 這一行帶的附件（[#732](https://github.com/DemianLi/nexus-agent/issues/732)，形狀同 `run.start` 的 `attachments`：檔案收據與內嵌圖）。
     * 只有宣告了 `input.attachments` 的命令收（見 {@link SlashDescriptor}）；沒宣告的命令帶了就回 `error`，附件沒被收下、收據還在。
     * 沒實作附件的 server 對非空的 `attachments` 回 `not_supported`。
     */
    readonly attachments?: readonly PromptAttachment[];
  };
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

/** 列出這條 thread 用 `/名字` 叫得出的技能。沒有參數——清單是整個 thread 的（同 `slash.list`）。 */
export interface SkillListCommand {
  readonly id: number;
  readonly method: 'skill.list';
}

/**
 * 人叫得到的一份技能，逐格照 dsh 的 `SkillEntry`（`packages/api/session-controller/src/types.ts:248-259`，`687f282e`）。
 * **不帶正文**：叫用時才由 `/名字` 那條路讀。
 */
export interface SkillEntry {
  /** kebab-case 的名字，`/name` 叫的就是它。 */
  readonly name: string;
  /** 一句話的用途說明。 */
  readonly description: string;
  /** 選填的補充：什麼時候用。 */
  readonly whenToUse?: string;
  /**
   * 那份 `SKILL.md` 的路徑。**是 backend 命名空間的路徑，不是磁碟路徑**（dsh 是磁碟上的絕對路徑；偏離登記在
   * `apps/harness` 的 `skill-catalog-wire.ts`）。
   */
  readonly path?: string;
  /** 同一份技能有沒有也列給模型（`disable-model-invocation: true` 的是 `false`，只給人叫）。 */
  readonly modelInvocable: boolean;
}

/** `skill.list` 的結果，**依名字逐碼排序**。 */
export type SkillListResult = { readonly skills: readonly SkillEntry[] };

/**
 * 列出以前的 thread 走的路徑（[#302](https://github.com/DemianLi/nexus-agent/issues/302)），`GET`。
 *
 * 對到 dsh 的 `session/list`。**不進 {@link RpcMethod}**：那一族綁在 `/threads/:id/commands/:method`
 * 上，而列表不屬於任何一條 thread；`@langchain/protocol` 的 `Command` 也沒有這個 method（同斜線命令那兩支）。
 *
 * **`GET` 也要帶 `content-type: application/json`**，server 沒帶就回 415。這一條不是潔癖，是上行那道
 * 閘門的延伸：瀏覽器對不帶自訂 header 的跨來源 `GET` 不發 preflight，而這一份回應帶著每一條 thread 的標題，
 * 標題是從第一句話來的。帶了這個 header 就不是 simple request，逼出一個這台 server 從不回答的 preflight。
 */
export const THREADS_PATH = '/threads';

/**
 * 列表上的一列。形狀照 dsh 的 `SessionSummary`，少掉的幾格：`origin`（subagent 不列）、
 * `cwd`（只列這台 server 那個目錄的）、`projections`（我們沒有投影快取）、`agentAvailable`（dsh 後來才加，我們沒有
 * 這一格）。多的一格是 `title`：dsh 的清單列把標題放在 `projections` 的 `title` 投影裡；我們把日誌上最後一顆
 * `session/title` 直接放進 `title` 這一格，來源見 `@nexus/core` 的 `SessionTitleSource`。
 */
export interface ThreadSummary {
  readonly threadId: string;
  /** Unix epoch 毫秒：`max(建立時間, 最後一則人打的字的時間)`，同 dsh。 */
  readonly updatedAt: number;
  /**
   * 這台 server 上這條 thread 的 agent 在跑：有一輪在跑或排著要跑，**或停在等人回答**（核准、提問、計劃審核），
   * 同 dsh 的 `agent/status`（等核准發生在一輪裡面）。按了停止之後停住的那幾件不算。之後的切換走
   * {@link THREAD_FEED_PATH} 的 {@link ThreadStatusFrame}，兩邊是同一個判準（#632）。
   */
  readonly running: boolean;
  /** 還沒有任何一輪，同 dsh 的 `blank`。 */
  readonly blank: boolean;
  /**
   * 這條會話現在的標題：日誌上最後一顆 `session/title` 的文字（latest-wins，來源見 `@nexus/core` 的
   * `SessionTitleSource`）；一顆都沒有時（例如 18 以前的日誌，或退回標題寫不進去），照退回規則從第一則合格的人話推。**缺席不等於空白**：只有目標排的輪次的 thread 不是空白，但沒有人打過字。
   */
  readonly title?: string;
  /**
   * 這條是從哪條 thread 分出來的（`thread.fork`，[#1580](https://github.com/DemianLi/nexus-agent/issues/1580)），對到 dsh `SessionSummary.parentSessionId`
   * （`session-controller/src/list.ts:353-362`）。不是分叉來的不帶。子代理照舊不列，所以這一格只會指向分叉的來源。
   * 契約先合（#1580 刀 1）：刀 2 接上分叉之後列表才開始填。
   */
  readonly parentThreadId?: string;
}

/** `GET /threads` 的結果。 */
export interface ThreadListResult extends Partial<ThreadListSets> {
  /** 由新到舊。 */
  readonly items: readonly ThreadSummary[];
  /** header 讀不懂、或格式版本比這台 server 新而沒列的份數。 */
  readonly unreadable: number;
  // 另有選填的 `pinnedThreadIds`、`archivedThreadIds`（#633，見 `thread-management.ts`）：沒有實作釘選與封存的 server 不送。
}

/**
 * `GET /threads` 的回應。錯誤分層同上行：載體層是 HTTP status，協定層是 200 ＋ error 封包——這台 server
 * 沒接落盤時是後者，**不是一份空清單**：那兩件事在畫面上要分得出來。
 */
export type ThreadListResponse =
  { readonly type: 'success'; readonly result: ThreadListResult } | ErrorResponse;

/**
 * 按內容搜尋以前的 thread（[#631](https://github.com/DemianLi/nexus-agent/issues/631)），`POST`，body 是一顆
 * {@link ThreadSearchRequest}，回 {@link ThreadSearchResponse}。
 *
 * 對到 dsh 的 `session.search`（`packages/api/session-controller/src/index.ts:262-265`、`list.ts:163-266`，`477b4f4`）：
 * 冷讀、不啟動任何 thread；搜得到的一定列得出來（同 {@link THREADS_PATH} 的判準）；一條 thread 最多一筆，
 * 固定最多 {@link THREAD_SEARCH_RESULT_LIMIT} 筆加一格 `hasMore`，**線上沒有 cursor、limit、filter**，同 dsh。
 *
 * ## 搜什麼
 *
 * 人打的字、目標排的那一輪的字、外掛塞進對話的訊息、壓縮換上去的摘要，與模型回覆的文字加上它要叫的工具（名字與參數）。
 * 推理、工具結果、標題不搜，同 dsh（標題由 web 在列表上自己比）。**只搜模型現在看得到的那一串**：被壓縮換掉的
 * 那幾則搜不到，換上去的摘要搜得到，同 dsh 只查 `surface: current`。
 *
 * ## 怎麼比
 *
 * **偏離**：dsh 用 unicode61 斷詞、整段當一個片語比，而連續的中文在那裡是一整個詞，句子中間的「搜尋」「會話」都搜不到。
 * 我們比的是**子字串**（英文不分大小寫，連續的空白算一個）。細節見 `apps/harness` 的 `thread-search.ts`。
 *
 * ## 失敗
 *
 * 錯誤分層同 {@link ThreadListResponse}，先後照 dsh `list.ts:163-266`：
 *
 * 1. 查詢去掉頭尾空白之後是空的、超過 {@link THREAD_SEARCH_QUERY_MAX_LENGTH}、或含 NUL：`invalid_argument`，有沒有東西可搜都一樣。
 * 2. 清單上沒掛內容搜尋那一列（`disabled: true`）：`not_supported`，同 dsh 沒掛 `sessionQuery` 時的「unavailable」。
 * 3. **沒有東西可搜時回空，不是錯**：這台 server 沒接落盤，或一條列得出來的 thread 都沒有。dsh 先列會話、一個都沒有
 *    就回空，還沒問到搜尋那一層（`list.ts:179-184`）。
 * 4. **有東西可搜、但那一列設成不開**（`openAt: never`，出廠就是）：`not_supported`，同 dsh 的
 *    `SESSION_QUERY_SEARCH_DISABLED`。web 收到失敗就退回只比標題。
 *
 * **`POST`，body 是 JSON**，同上行：`content-type` 不是 `application/json` 就回 415。
 */
export const THREAD_SEARCH_PATH = '/threads/search';

/** 一次最多回幾條 thread，同 dsh 的 `SESSION_SEARCH_RESULT_LIMIT`（`types.ts:197`）。 */
export const THREAD_SEARCH_RESULT_LIMIT = 20;

/** 命中片段最多幾個 code point，同 dsh 的 `SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS`（`types.ts:200`）。 */
export const THREAD_SEARCH_SNIPPET_MAX_CODE_POINTS = 240;

/** 去掉頭尾空白之後最長幾個 UTF-16 code unit（`String.length`），同 dsh 的 `SESSION_SEARCH_QUERY_MAX_CHARS`（`list.ts:22`）。 */
export const THREAD_SEARCH_QUERY_MAX_LENGTH = 500;

/** `POST /threads/search` 的 body，同 dsh 的 `SessionSearchRequest`。 */
export interface ThreadSearchRequest {
  readonly query: string;
}

/** 一筆命中，同 dsh 的 `SessionSearchItem`。 */
export interface ThreadSearchItem {
  readonly threadId: string;
  /**
   * 那條 thread 裡最相關的那一則，截在命中附近的一段：連續的空白算一個，前後被截掉的地方是 `…`，最多
   * {@link THREAD_SEARCH_SNIPPET_MAX_CODE_POINTS} 個 code point。**純文字，不帶命中的位置**，同 dsh：要標出來的話
   * client 自己找。
   */
  readonly snippet: string;
}

/** `POST /threads/search` 的結果，同 dsh 的 `SessionSearchValue`。 */
export interface ThreadSearchResult {
  /** 最相關的在前。 */
  readonly items: readonly ThreadSearchItem[];
  /** 超過 {@link THREAD_SEARCH_RESULT_LIMIT} 條還有。 */
  readonly hasMore: boolean;
}

/** `POST /threads/search` 的回應。 */
export type ThreadSearchResponse =
  { readonly type: 'success'; readonly result: ThreadSearchResult } | ErrorResponse;

/**
 * 全部 thread 共用的一條下行（[#632](https://github.com/DemianLi/nexus-agent/issues/632)），`GET`，回
 * `text/event-stream`。每顆 SSE frame 的 `data` 是一顆 {@link ThreadFeedFrame}。
 *
 * 照 dsh gateway 的 remote event 串流（`packages/api/gateway/src/index.ts:490-600`，`477b4f4`）：一個 client 接一條，
 * 這台 server 上所有會話的狀態與等人回答的請求都走它，側欄因此看得到沒打開的會話。
 *
 * - **在跑／閒著**：切換時各一顆 {@link ThreadStatusFrame}，同 dsh 的 `api-session/status` 廣播。**接上時不補送**：
 *   起點是 {@link THREADS_PATH} 那份列表的 `running`，所以 client **每次接上之後都重抓一次列表**（dsh 的
 *   `reconcileStatus` 也是列表當基準）。
 * - **等人回答**：還掛著的 `input.requested` 一顆 {@link ThreadInputRequestedFrame}；答掉或收回（按停止）時
 *   一顆 {@link ThreadInputWithdrawnFrame}。**接上當下補送所有 thread 還掛著的**，同 dsh 的 `pendingRemoteEvents`。
 *   同一條 thread、同一個 `interrupt_id` 再來一顆 requested（沒被答到的那些會帶原 id 再中斷），**後到的蓋過先到的**。
 *
 * **回答不走這條線**：照舊走那條 thread 自己的 `input.respond`。
 *
 * **client 要跳過不認得的 `type`**：這條線之後還要帶會話增減與活動時間（dsh 的 `api-session/added`／`removed`／
 * `activity`，#632 拍板這一版不做），舊的 client 收到新種類不能當掉。
 *
 * **偏離**：dsh 的 frame 是 Cordis 的 `emit`／`waterfall`，路徑是 gateway 的；我們沒有那一層，frame 與路徑是這裡定的。
 * dsh 的撤回只送給收過那一顆的 client，我們送給每一條——多收一顆認不得的撤回，client 照規則跳過。
 *
 * **`GET` 也要帶 `content-type: application/json`**，理由同 {@link THREADS_PATH}：這條線上有每一條 thread 的
 * 核准內容。
 */
export const THREAD_FEED_PATH = '/threads/feed';

/** 一條 thread 的 agent 切換了在跑／閒著。判準同 {@link ThreadSummary.running}。 */
export interface ThreadStatusFrame {
  readonly type: 'status';
  readonly threadId: string;
  readonly running: boolean;
}

/**
 * 一條 thread 停下來等人回答。`event` 就是那條 thread 自己的下行送出的那一顆 `input.requested`，**號與
 * `event_id` 一起**，所以兩條線上的同一題對得起來。
 */
export interface ThreadInputRequestedFrame {
  readonly type: 'input-requested';
  readonly threadId: string;
  readonly event: Event;
}

/** 那一題不用再問了：答掉，或收回（按停止）。 */
export interface ThreadInputWithdrawnFrame {
  readonly type: 'input-withdrawn';
  readonly threadId: string;
  readonly interruptId: string;
}

/** {@link THREAD_FEED_PATH} 上的一顆。 */
export type ThreadFeedFrame =
  ThreadStatusFrame | ThreadInputRequestedFrame | ThreadInputWithdrawnFrame;

/**
 * 一顆下行的事件，信封哪裡不對：回第一個不對的欄位路徑與原因，都對就回 `undefined`。{@link assertWireEvent} 與 {@link isWireEvent}
 * 共用這一支，兩邊不會各寫一份「怎麼認」。
 *
 * 驗的是**折疊器與發布器會讀的欄位**：`type`、`method`、`params`、`params.namespace`、`params.data`、`seq`（若有）、`event_id`（若有）。
 * 各 `method` 的 `data` 內容照舊由 `conversation.ts` 的各 `reduceX` 驗。
 *
 * ## 照 dsh 的哪裡
 *
 * `assertSessionWireEvent`（`packages/api/session-controller/src/client/session-wire-event.ts:14-46`，`687f282e`）：拒收非物件；
 * `seq` 不是安全非負整數（含 `-0`）；缺 `data` 或 `data` 是 `undefined`（`null` 放行）。套在 follow 的每顆與歷史頁的每筆
 * （`transport.ts:185`、`:217`、`:233`）。
 *
 * ## 偏離（理由 1：基座表達不出來）
 *
 * - **不拒收未知欄位。** dsh 逐鍵比對信封的鍵集（`:20-33`）。我們的 `Event` 是 `@langchain/protocol` 的
 *   `EventData & Extensible & {type, event_id?, seq?}`（`protocol.ts:311`，`@langchain/protocol@0.0.19`），協定明文允許多出的欄位；
 *   照 dsh 拒收未知鍵會跟協定本身衝突，退到只驗折疊器會讀的欄位。
 * - **dsh 的 `time`、`ignorable`、`surfaceOp`、`sourceEventSeqs` 不照搬。** 那是 dsh 日誌事件的信封；nexus 下行送的是協定 `Event`，
 *   沒有這幾個欄位（時間在 `params.timestamp`，是 `@langchain/protocol` 的 `Extensible` 欄位，折疊器不讀它）。取而代之驗的是我們信封
 *   的等價物：`type`（dsh 的 `type` 是字串）、`method`、`params.namespace`。
 * - **錯誤類別的方向相反**，見 {@link WireProtocolError}。
 * - **`seq` 若有才驗，沒有不拒收。** dsh 的信封必帶 `seq`（`session-wire-event.ts:36`）。我們的歷史 `Event` 一律不帶 `seq`
 *   （既有偏離，見 {@link historyPath} 的「歷史的 `Event` 一律不帶 `seq`」與 `conversation-history.ts` 的 `frame()`）：帶了耐久 seq，之後的即時 frame 會被
 *   折疊器當重複丟掉。實測 8,670 顆歷史事件全部不帶；必帶的話整份歷史都會被拒。撤除條件（建議）：歷史改帶傳輸 seq 之後，改成必帶。
 *
 * @param value - 解出來的一顆。
 * @param at - 這一顆在更大的資料裡的位置（歷史頁的 `events[3]`），接在欄位路徑前面；省略就是頂層。
 */
function wireEventProblem(
  value: unknown,
  at: string | undefined,
): { readonly field: string; readonly reason: string } | undefined {
  const path = (field: string): string => (at === undefined ? field : `${at}.${field}`);
  const problem = (field: string, reason: string) => ({ field: path(field), reason });
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { field: at ?? 'event', reason: '必須是物件' };
  }
  const event = value as Record<string, unknown>;
  if (event['type'] !== 'event') return problem('type', "必須是 'event'");
  if (typeof event['method'] !== 'string') return problem('method', '必須是字串');
  const params = event['params'];
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return problem('params', '必須是物件');
  }
  const body = params as Record<string, unknown>;
  const namespace = body['namespace'];
  if (!Array.isArray(namespace) || !namespace.every((part) => typeof part === 'string')) {
    return problem('params.namespace', '必須是字串陣列');
  }
  // 同 dsh：`data` 要有、不能是 `undefined`（`null` 放行）。JSON 裡 `undefined` 的欄位根本不會出現，所以兩種缺法是同一件事。
  if (!Object.hasOwn(body, 'data') || body['data'] === undefined) {
    return problem('params.data', '必須存在');
  }
  const seq = event['seq'];
  if (
    seq !== undefined &&
    (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0 || Object.is(seq, -0))
  ) {
    return problem('seq', '必須是安全非負整數');
  }
  if (event['event_id'] !== undefined && typeof event['event_id'] !== 'string') {
    return problem('event_id', '必須是字串');
  }
  return undefined;
}

/**
 * 不合格就拋 {@link WireProtocolError}（`field` 指名哪個欄位）。規則見 {@link wireEventProblem}。
 *
 * @param value - 解出來的一顆。
 * @param at - 這一顆在更大的資料裡的位置，例如歷史頁的 `events[3]`。
 * @throws {WireProtocolError} 信封不合格。
 */
export function assertWireEvent(value: unknown, at?: string): asserts value is Event {
  const found = wireEventProblem(value, at);
  if (found !== undefined) {
    throw new WireProtocolError(found.field, `下行事件的 ${found.field} ${found.reason}`);
  }
}

/** {@link assertWireEvent} 的布林版：不拋，給「不認得就丟掉」的那條路用。 */
export function isWireEvent(value: unknown): value is Event {
  return wireEventProblem(value, undefined) === undefined;
}

/**
 * 認得這一顆嗎。**client 在這裡丟掉不認得的**，見 {@link THREAD_FEED_PATH}。只驗 client 要讀的欄位：`input-requested` 的 `event`
 * 要過 {@link isWireEvent}（折疊器在 `useReducer` 裡讀它的 `params`，壞的進去就是 render 錯誤、整頁白掉），其餘形狀不驗：
 * server 那側（`thread-feed.ts`）照同一份 `@nexus/wire` 的型別建。
 */
export function isThreadFeedFrame(value: unknown): value is ThreadFeedFrame {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Record<string, unknown>;
  if (typeof frame['threadId'] !== 'string') return false;
  switch (frame['type']) {
    case 'status':
      return typeof frame['running'] === 'boolean';
    case 'input-requested': {
      const event = frame['event'];
      return isWireEvent(event) && event.method === 'input.requested';
    }
    case 'input-withdrawn':
      return typeof frame['interruptId'] === 'string';
    default:
      return false;
  }
}

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

/**
 * `GET /threads/:id/subagents/:runId/history`——背景子代理**自己那份對話**的一頁歷史
 * （[#871](https://github.com/DemianLi/nexus-agent/issues/871)）。
 *
 * 照 dsh：continuable 子代理是自己一份 session（`SessionHeader.parentSession` 指回 parent），人的 `prompt` 記在它自己的日誌，
 * 瀏覽器是**跟隨那份 session**，不是把它併進 parent 的歷史（`docs/subsystems/subagent.zh.md`，`477b4f4`）。所以這條路徑
 * 對子代理自己的日誌套**同一個** `historyPage`：回應形狀、查詢參數（`maxMessages`／`beforeSeq`／`throughSeq`）、頁的切法、
 * 位元組上限、frame 不帶 `seq` 的規矩全同 {@link historyPath}，folded 起來是一份**獨立的 `ConversationState`**，不要折進
 * 主對話的。裡面有：
 *
 * - 它的第一則「人話」是派它的那段指示（`turn/start` 的 `message`）；之後 `subagent.send` 的人話（輪次開頭的 `message`、
 *   輪中插的 `user/message` 來源 `user`）也是人話。
 * - 模型的回覆（含推理）、工具卡。
 * - 主對話寫給它的話（`agent-message`）長成「某某說」，同主對話那一側（#863）。
 *
 * 找不到（編號不是 `bg-` 加十二位十六進位、不是這條 thread 派出去的、日誌讀不到）：`subagent_not_found`，不細分，免得
 * 呼叫端靠回應試探編號。**授權就是這條 thread 的會話認證**，而且只在這條 thread 的 id 底下找。
 *
 * **只有歷史，沒有即時**：這條路徑不跟隨子代理的下一步。想看它現在跑到哪，看
 * `SUBAGENT_STATUS`（`running` 變 `idle` 就是一輪收了）再抓一次。**GET 也要帶 `content-type: application/json`**，
 * 理由同 {@link THREADS_PATH}。
 */
export function subagentHistoryPath(threadId: string, runId: string): string {
  return `/threads/${encodeURIComponent(threadId)}/subagents/${encodeURIComponent(runId)}/history`;
}

/**
 * `GET /threads/:id/trajectory/turn?seq=|messageId=[&runId=]`——軌跡的某一個邏輯輪的細節
 * （[#1083](https://github.com/DemianLi/nexus-agent/issues/1083)）。
 *
 * 軌跡投影只推有界的骨架（每輪一筆摘要），逐呼叫、逐工具的細節由客戶端帶著錨點來要。照 dsh 的形狀：投影只推小而有界的整份值，
 * 細節走 seq 錨點按需拉（`loadThrough(seq)`）。**偏離**：dsh 拉的是事件頁、由客戶端自己折；我們的軌跡是伺服端折疊的投影，
 * 客戶端沒有折疊器，所以回的是伺服端折好的結果（形狀 {@link TrajectoryTurnDetail}）。
 *
 * - 錨點 `seq` 或 `messageId` 二擇一（都給或都沒給是 `invalid_argument`）；`runId` 可選，給了就在那個子代理（前景或背景，軌跡投影兩種都展開）自己的日誌裡找。
 * - 錨點落在 resume 輪上，回的仍是整個邏輯輪。
 * - 錨點在日誌裡沒有對應的輪：{@link TURN_NOT_FOUND}。`runId` 長得不對、不是這條 thread 派的、日誌讀不到：{@link SUBAGENT_NOT_FOUND}，
 *   不細分。這份組裝沒掛軌跡投影：`not_supported`。
 * - **經 `threadFor`**（同 {@link historyPath}）：要的是這條 thread 組裝裡的軌跡投影單元；子代理的日誌 live 的讀記憶體、沒有就冷讀落盤的。
 * - 認證同歷史頁（會話認證）。允許並行請求，回應不保證順序。**GET 也要帶 `content-type: application/json`**，理由同 {@link THREADS_PATH}。
 */
export function trajectoryTurnPath(threadId: string): string {
  return `/threads/${encodeURIComponent(threadId)}/trajectory/turn`;
}

/** 一頁歷史的則數上限，同 dsh 的預設（`history.ts:38`）。 */
export const HISTORY_PAGE_MESSAGES = 50;

/**
 * 一頁歷史的**位元組上限**（[#479](https://github.com/DemianLi/nexus-agent/issues/479)）。
 *
 * ## 為什麼則數上限不夠
 *
 * {@link HISTORY_PAGE_MESSAGES} 數的是「則」，而**一則底下可以掛任意多張工具卡**。
 * [#471](https://github.com/DemianLi/nexus-agent/pull/471) 把成功的工具結果文字放上線之後，一頁的量變成
 * 「這個窗口裡的工具卡數 × 每張卡的大小」，而卡數那一項沒有任何上限——一輪連著呼叫幾十次
 * `read_file` 是正常的。合成日誌量過（2026-09-20，**不是真的 session log**）：每輪 10 次滿版讀的 25 輪
 * 窗口是 12.04 MiB，每輪 40 次是 48.05 MiB。一個往回翻的請求就能讓 server 一次把那些組出來送掉。
 *
 * ## dsh 沒有這個上限
 *
 * dsh 的 `paginate` 只數訊息數（`packages/api/session-controller/src/history.ts:38,384-410`，`ddefc45`），
 * 全檔沒有位元組上限。**這一格是我們主動多加的一層，不是補上我們缺的東西**：當初加它時我們把工具結果文字截在
 * wire 層（#471），那條偏離在 [#736](https://github.com/DemianLi/nexus-agent/issues/736) 收掉了——文字照 dsh 原樣
 * 上線，上限回到模型面（外溢層，#719）。這一格留著，因為「一則底下的卡數沒有上限」那件事沒變。
 *
 * ## 這個數字怎麼來的
 *
 * `8_000_000` 當初是 **80 × 每張工具卡的上限**，讀作「一頁最多裝 80 張滿版工具卡」。那時一張卡的上限是結果
 * 文字 50000 bytes（`tool-text` 那一列）加上給專屬卡的 `meta` 50000 bytes
 * （[#617](https://github.com/DemianLi/nexus-agent/issues/617) 決定 2；在那之前一張卡只有文字，這個數字是
 * `4_000_000`）。80 這個倍數對著量測挑：典型的一頁是 0.20 MiB 量級（量的時候還沒有 `meta`，一頁讀檔也
 * 還是 100 行，今天的典型值會比它大，沒有重量過），當時離這裡有一個量級的餘裕，所以正常瀏覽一次都不會
 * 被切（切了只會讓分頁變碎，對所有人都變差）；而上面那兩個病態形狀會落回單位數 MiB 的兩倍。
 *
 * **讀檔卡比那個大**（[#630](https://github.com/DemianLi/nexus-agent/issues/630)）：讀檔一頁照 dsh 放大到
 * 2000 行之後，讀檔 `meta` 的上限放寬成 `tool-text` 那一格的**兩倍**。8 MB 沒跟著改（demian 2026-09-25 拍板）：
 * 這個上限本來就是軟的（見下面），最壞的卡少裝幾張只是讓分頁碎一點。
 *
 * **#736 之後，卡上的文字由生產者自己的上限決定**，`meta` 那一半不變：
 *
 * - **外溢層開著**：一則最多 12500 個估算 token（o200k，含通知）。2026-10-02 量過換成位元組是多少：TypeScript
 *   原始碼每 token 3.47 bytes（約 43 KB）、中文散文 3.11（約 39 KB）、lockfile 2.13（約 27 KB）、emoji 2.00、
 *   隨機 base64 1.46；**病態的是長串重複字元**——一種字母重複是 8.00（約 100 KB），一長串空白是 127.96（約 1.6 MB，
 *   o200k 最長的空白 token）。所以典型的滿版卡跟從前同一個量級，病態的那種一張就能吃掉一頁的五分之一。
 * - **`read_file` 不外溢**：選到的行（含換行）累計 50 KiB 就停、一頁最多 2000 行，加上每行 7 bytes 的行號，文字最壞約
 *   65 KB，一張讀檔卡最壞約 165 KB，一頁約裝 48 張；單行超過 50 KiB 時退到基座格式化後的 80,000 字元。
 * - **外溢層關掉**：文字沒有上限，同 dsh 關掉時。這一頁的上限仍然是軟的，超標時 server 講一聲（`onOversize`）。
 *
 * **與那些數字的關係由 `apps/harness` 的絆索釘著**（`meta` 的上限與讀檔的倍數住在 app 裡，wire 不能往上
 * import，所以這裡只能寫字面值）：那條測試把 8 MB、50000 與兩倍三個值一起釘死，任何一個動了都會紅。
 * 同一個做法見 `conversation.ts:927` 那條。
 *
 * **但它只釘得住出廠那一份**（[#538](https://github.com/DemianLi/nexus-agent/issues/538)）：`meta` 的上限
 * 在 #538 之後是清單上 `tool-text` 那一列的 `config`，**部署在 patch 裡改掉它，這個比例就不再成立，
 * 而且沒有任何東西會紅**。配對的另一半是這裡——一個協定常數，兩端對「一頁多大」的共識不該是執行期
 * 的事，所以它刻意沒跟著變成設定。
 *
 * 那是 #538 三選一裡明著選的第三條（2026-09-23 拍板），代價寫在這裡而不是只寫在 harness 那側，是因為
 * **讀到這個數字的人會在這裡問它憑什麼是 8 MB**。dsh 那側沒有先例可抄：它的歷史分頁按則數算
 * （`packages/api/session-controller/src/history.ts:38`），組頁路徑上一個位元組預算都沒有，兩個值
 * 沒有共同單位可以做比例——這個耦合是我們自己長出來的。
 *
 * ## 它是**軟的**
 *
 * 見 {@link ThreadHistoryResult.events}：切點只落在輪邊界上，所以單獨一輪就超標時那一頁就是超標。
 */
export const HISTORY_PAGE_MAX_BYTES = 8_000_000;

/**
 * 拿一頁歷史的參數。三格都省略就是最後一頁。
 *
 * **位元組上限不在這裡**（#479）：{@link HISTORY_PAGE_MAX_BYTES} 限的是「server 為一個呼叫端一次組多少
 * 東西出來」，而呼叫端正是被限的那個人——可以被調高的參數限不住任何東西。只能調低的參數今天沒有消費者
 * （要小一點的頁調 {@link ThreadHistoryQuery.maxMessages} 就是了），哪天真有再加。
 */
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
  /**
   * 照順序折進 `reduceConversation`。**一顆都不帶 `seq`**，見 {@link historyPath}。
   *
   * **切點一律落在一輪的開頭**，而且這條保證比 {@link HISTORY_PAGE_MAX_BYTES} 強：單獨一輪就超過那個
   * 上限時，**那一頁就是超標**，不會從輪中間切開（#479）。從輪中間切會送出孤兒工具卡——有 `tool/result`
   * 沒有對應的 `tool/call`——畫面上是半張卡。dsh 的 `paginate` 也把切點無條件退到群組開頭
   * （`history.ts:397-405` 的 `groupStart`），這一條與它同向。
   *
   * 於是「一頁至少一整輪」是這條保證的推論，不是另一條規則：`firstSeq` 因此嚴格遞減，往前翻一定會前進。
   */
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

/** `GET /threads/:id/trajectory/turn` 的回應。 */
export type TrajectoryTurnResponse =
  { readonly type: 'success'; readonly result: TrajectoryTurnDetail } | ErrorResponse;

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

export function errorResponse(
  id: number | null,
  error: WireErrorCode,
  message: string,
): WireErrorResponse {
  return { type: 'error', id, error, message };
}

export function successResponse(id: number, result: Record<string, unknown>): CommandResponse {
  return { type: 'success', id, result };
}
