/**
 * 對話行程連宿主 socket 的協定，客戶端這一側；宿主那一側是 `native/sandbox-spawner/src/host_protocol.rs`，兩邊對同一份向量檔
 * （`native/sandbox-spawner/host-vectors.json`）測。
 *
 * 框是 `u32` LE 長度加內容，內容是一份 JSON 物件，`type` 分種類。客戶端第一框送 `hello`（帶協定版本與監督行程在控制通道上給的 token）；
 * 宿主回 `hello`（收下這條連線）或 `rejected`（送完就斷）。之後客戶端送 `call`、`cancel`，宿主回 `chunk`、`result`（每個 `id`
 * 剛好一框），並主動推 `event`。只傳資料。
 *
 * `side` 是 `id` 由哪一邊發的：現在只有客戶端發呼叫（`'c'`），`'h'` 留給宿主反過來發請求。
 *
 * 宿主的 JSON 收得比標準少（`native/sandbox-spawner/src/json.rs`）：數字只收整數，`\u` 跳脫的代理對要成對，巢狀最多 {@link MAX_DEPTH} 層。
 * 送出去的框宿主解不開就判違反協定、隔離這個行程，所以 {@link encodeClientMessage} 先把 `payload` 核過，不合就丟、不送。
 *
 * @module
 */

/**
 * 宿主連線的協定版本，跟 `host_protocol.rs` 的 `HOST_PROTOCOL_VERSION` 與向量檔的 `protocolVersion` 相同。
 * 跟監督行程控制通道的版本各自獨立。
 */
export const PROTOCOL_VERSION = 4;

/** 一框最長多少，跟 `host_protocol.rs` 的 `MAX_FRAME` 相同。 */
export const MAX_FRAME = 256 * 1024;

/** 陣列與物件加起來最多幾層，跟 `json.rs` 的 `MAX_DEPTH` 相同；框本身佔一層。 */
export const MAX_DEPTH = 32;

/** `id` 最大多少，跟 `host_protocol.rs` 的 `MAX_ID` 相同。 */
export const MAX_ID = Number.MAX_SAFE_INTEGER;

/** 宿主回的錯誤碼，跟 `host_protocol.rs` 的 `ErrorCode` 相同。 */
export const HOST_ERROR_CODES = [
  'unknown_service',
  'unknown_method',
  'bad_payload',
  'busy',
  'cancelled',
  'too_large',
  'service_error',
] as const;

export type HostErrorCode = (typeof HOST_ERROR_CODES)[number];

export type Side = 'c' | 'h';

/** 過橋的資料：宿主的 JSON 收得下的那一部分。 */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

export type ClientMessage =
  | { readonly type: 'hello'; readonly version: number; readonly token: string }
  | {
      readonly type: 'call';
      readonly side: Side;
      readonly id: number;
      readonly service: string;
      readonly method: string;
      readonly payload: Json;
    }
  | { readonly type: 'cancel'; readonly side: Side; readonly id: number };

export type HostMessage =
  | { readonly type: 'hello'; readonly version: number }
  | { readonly type: 'rejected'; readonly reason: string }
  | {
      readonly type: 'chunk';
      readonly side: Side;
      readonly id: number;
      readonly seq: number;
      readonly payload: Json;
    }
  | { readonly type: 'result'; readonly side: Side; readonly id: number; readonly ok: Json }
  | {
      readonly type: 'result';
      readonly side: Side;
      readonly id: number;
      readonly error: { readonly code: HostErrorCode; readonly message: string };
    }
  | {
      readonly type: 'event';
      readonly service: string;
      readonly topic: string;
      readonly payload: Json;
    };

export class HostProtocolError extends Error {
  override readonly name = 'HostProtocolError';
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** 核 `payload` 合不合宿主的 JSON：只收安全整數、成對的代理對、純物件與陣列，`depth` 是它外面已經有幾層。 */
function checkJson(value: unknown, depth: number): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new HostProtocolError('數字只收安全整數');
    return;
  }
  if (typeof value === 'string') {
    if (LONE_SURROGATE.test(value)) throw new HostProtocolError('字串有落單的代理對');
    return;
  }
  if (typeof value !== 'object') throw new HostProtocolError(`不能過橋的值：${typeof value}`);
  if (depth >= MAX_DEPTH) throw new HostProtocolError('巢狀太深');
  if (Array.isArray(value)) {
    for (const item of value) checkJson(item, depth + 1);
    return;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new HostProtocolError('只收純物件');
  for (const [key, item] of Object.entries(value)) {
    if (LONE_SURROGATE.test(key)) throw new HostProtocolError('鍵有落單的代理對');
    checkJson(item, depth + 1);
  }
}

function checkId(id: number): void {
  if (!Number.isSafeInteger(id) || id < 0) throw new HostProtocolError('id 不在範圍內');
}

/**
 * 編成緊湊 JSON，鍵照 `type` 在前的固定順序，跟宿主那一側編出來的一字不差。`call` 的 `payload` 不合宿主的 JSON、或整框超過
 * {@link MAX_FRAME}，丟 {@link HostProtocolError}。
 */
export function encodeClientMessage(message: ClientMessage): Buffer {
  let text: string;
  switch (message.type) {
    case 'hello':
      text = JSON.stringify({ type: 'hello', version: message.version, token: message.token });
      break;
    case 'call':
      checkId(message.id);
      checkJson(message.payload, 1);
      text = JSON.stringify({
        type: 'call',
        side: message.side,
        id: message.id,
        service: message.service,
        method: message.method,
        payload: message.payload,
      });
      break;
    case 'cancel':
      checkId(message.id);
      text = JSON.stringify({ type: 'cancel', side: message.side, id: message.id });
      break;
  }
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > MAX_FRAME) {
    throw new HostProtocolError(`框長 ${String(bytes.length)} 超過上限 ${String(MAX_FRAME)}`);
  }
  return bytes;
}

/** 加上長度前綴。 */
export function frame(payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32LE(payload.length);
  return Buffer.concat([head, payload]);
}

function exactFields(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length + 1 || !keys.every((key) => key in value)) {
    throw new HostProtocolError('欄位不對');
  }
}

function asString(value: unknown): string {
  if (typeof value !== 'string') throw new HostProtocolError('要是字串');
  return value;
}

function asSide(value: unknown): Side {
  if (value !== 'c' && value !== 'h') throw new HostProtocolError('side 要是 c 或 h');
  return value;
}

function asId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new HostProtocolError('id 不在範圍內');
  }
  return value;
}

function asSeq(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new HostProtocolError('seq 不在範圍內');
  }
  return value;
}

function asError(value: unknown): { readonly code: HostErrorCode; readonly message: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HostProtocolError('error 要是物件');
  }
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== 2) throw new HostProtocolError('欄位不對');
  const code = HOST_ERROR_CODES.find((known) => known === fields.code);
  if (code === undefined) throw new HostProtocolError('不認得的錯誤碼');
  if (!('message' in fields)) throw new HostProtocolError('欄位不對');
  return { code, message: asString(fields.message) };
}

/** 解宿主送來的一框；種類不認得、欄位少了或多了、型別不對都丟 {@link HostProtocolError}。 */
export function decodeHostMessage(payload: Buffer): HostMessage {
  let value: unknown;
  try {
    value = JSON.parse(payload.toString('utf8'));
  } catch {
    throw new HostProtocolError('不是 JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new HostProtocolError('不是物件');
  const fields = value as Record<string, unknown>;
  switch (fields.type) {
    case 'hello': {
      exactFields(fields, ['version']);
      const { version } = fields;
      if (
        typeof version !== 'number' ||
        !Number.isInteger(version) ||
        version < 0 ||
        version > 0xffff_ffff
      ) {
        throw new HostProtocolError('版本不是 u32');
      }
      return { type: 'hello', version };
    }
    case 'rejected':
      exactFields(fields, ['reason']);
      return { type: 'rejected', reason: asString(fields.reason) };
    case 'chunk':
      exactFields(fields, ['side', 'id', 'seq', 'payload']);
      return {
        type: 'chunk',
        side: asSide(fields.side),
        id: asId(fields.id),
        seq: asSeq(fields.seq),
        payload: fields.payload as Json,
      };
    case 'result': {
      if ('ok' in fields) {
        exactFields(fields, ['side', 'id', 'ok']);
        return {
          type: 'result',
          side: asSide(fields.side),
          id: asId(fields.id),
          ok: fields.ok as Json,
        };
      }
      exactFields(fields, ['side', 'id', 'error']);
      return {
        type: 'result',
        side: asSide(fields.side),
        id: asId(fields.id),
        error: asError(fields.error),
      };
    }
    case 'event':
      exactFields(fields, ['service', 'topic', 'payload']);
      return {
        type: 'event',
        service: asString(fields.service),
        topic: asString(fields.topic),
        payload: fields.payload as Json,
      };
    default:
      throw new HostProtocolError(typeof fields.type === 'string' ? '不認得的種類' : '少了 type');
  }
}

/** 邊讀邊切框：每次 `push` 回這次湊齊的框，不完整的留著等下一次。長度欄位超過 {@link MAX_FRAME} 就丟 {@link HostProtocolError}。 */
export class FrameReader {
  #pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.#pending = this.#pending.length === 0 ? chunk : Buffer.concat([this.#pending, chunk]);
    const frames: Buffer[] = [];
    while (this.#pending.length >= 4) {
      const length = this.#pending.readUInt32LE(0);
      if (length > MAX_FRAME)
        throw new HostProtocolError(`框長 ${String(length)} 超過上限 ${String(MAX_FRAME)}`);
      if (this.#pending.length < 4 + length) break;
      frames.push(this.#pending.subarray(4, 4 + length));
      this.#pending = this.#pending.subarray(4 + length);
    }
    return frames;
  }
}
