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
 */
export const WIRE_CHANNELS = ['messages', 'tools', 'lifecycle', 'input'] as const;

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

/** `/threads/:id/commands/:method` 這條 RPC family 收得下的全部 method。 */
export type RpcMethod = UplinkMethod | SlashMethod;

export function isRpcMethod(value: unknown): value is RpcMethod {
  return isUplinkMethod(value) || isSlashMethod(value);
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
