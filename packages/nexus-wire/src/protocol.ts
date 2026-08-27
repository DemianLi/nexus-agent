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
 * 上行：協定只在 WebSocket 那條路上指定怎麼送 `Command`，HTTP 這格是空的。
 * 補這一格的是 dsh 的 `fetch/handler.ts`——**路徑指名 method，封包裡也帶 method，
 * 兩者不合就是錯誤**。這裡照抄那個不變量。
 */
export function commandPath(threadId: string, method: UplinkMethod): string {
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
