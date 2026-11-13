/**
 * 一對裡的組合行程與葉子行程之間那條橋的協定，TS 這一側的編解碼；Rust 那一側與完整的規則在
 * `native/sandbox-spawner/host/src/pair_protocol.rs`，兩邊對同一份向量檔（`native/sandbox-spawner/pair-vectors.json`）測。
 *
 * 框是 `u32` LE 長度加內容，內容是一份 JSON 物件，`type` 分種類。葉子連上後先送 `hello`，收到組合行程的 `hello` 才送別的；
 * 收到 `rejected` 照它的 `code`（{@link PAIR_REJECT_CODES}）反應：`retry_later` 退避（至少 {@link PAIR_RETRY_BACKOFF_MIN_MS}）後重連，到啟動時限仍沒進去是「一直被要求稍後再試」；其餘（含 `code` 解不開的）是被拒，不重試（規則在 Rust 那一側的檔頭）；連不上、connect 成功後等滿時限（至少 {@link PAIR_HELLO_TIMEOUT_MS}）沒收到任何框、或沒收到任何框就斷，是對方不在。這三種結局要分開回報，以收到的 `rejected` 為準：寫 `hello` 出錯時先把讀得到的讀完再下結論。之後兩邊都能發 `call` 與 `cancel`，
 * 由對方回 `chunk` 與 `result`；`side` 是發起那一次的一方（`'l'` 葉子、`'m'` 組合行程），一次呼叫的識別是 `(side, id)`。
 *
 * 這裡只管一框的形狀：誰能送哪一種、哪些 `id` 還在跑，由連線那一層判。Rust 那一側的 JSON 是 `serde_json`：`\u` 跳脫的代理對要成對、
 * 數字要是有限值、巢狀最多 {@link MAX_DEPTH} 層，對方解不開就判違反協定；另有些值 `JSON.stringify` 會悄悄改掉或丟掉（非有限的數字、`undefined`、`Date`、`Map`…）。
 * 所以 {@link encodePairMessage} 送出前一律先核，
 * {@link decodePairMessage} 收的也照同一組規則。`JSON.parse` 分不出 `1` 與 `1.0`，寫成小數或指數的整數（`1.0`、`1e2`）`id`、`seq`、`version` 這裡收、Rust 不收；`-0` 兩邊都不收。
 *
 * @module
 */

import { HOST_ERROR_CODES, MAX_DEPTH, type HostErrorCode, type Json } from './protocol.js';

/** 橋的協定版本，跟 `pair_protocol.rs` 的 `PAIR_PROTOCOL_VERSION` 相同；跟宿主連線、監督行程控制通道的版本各自獨立。 */
export const PAIR_PROTOCOL_VERSION = 1;

/** 橋上一框最長多少。 */
export const PAIR_MAX_FRAME = 1024 * 1024;

/** `id` 與 `seq` 最大多少。 */
export const PAIR_MAX_ID = Number.MAX_SAFE_INTEGER;

/** `chunk` 框裡 `payload` 以外的部分最多佔多少。 */
export const PAIR_ENVELOPE_BYTES = 256;

/** 一塊的字串以 UTF-8 計最長多少：編成 JSON 最壞六倍，加上 {@link PAIR_ENVELOPE_BYTES} 仍然放得進一框。 */
export const PAIR_MAX_CHUNK_BYTES = 128 * 1024;

/** 每個方向同時最多幾個呼叫。 */
export const PAIR_MAX_CALLS = 64;

/** 葉子 connect 成功後等組合行程回 `hello` 或 `rejected`，至少等這麼久。 */
export const PAIR_HELLO_TIMEOUT_MS = 5_000;

/** 組合行程收下連線後最多這麼久就排出 `hello` 或 `rejected`（葉子先關的除外）；比 {@link PAIR_HELLO_TIMEOUT_MS} 短。 */
export const PAIR_PID_WAIT_MS = 3_000;

/** 排著沒寫出去的位元組到了這麼多，先不發新的 `call`、`chunk`、`result`；對方送來的照讀。 */
export const PAIR_OUTBOX_PAUSE_BYTES = 512 * 1024;

/** 排著沒寫出去的位元組不超過這麼多；再排一框就超過的，關連線。 */
export const PAIR_OUTBOX_LIMIT_BYTES = 2 * 1024 * 1024;

/** 有東西排著、連續這麼久一個位元組都沒寫出去，當對方不在、關連線。 */
export const PAIR_STALL_TIMEOUT_MS = 30_000;

/** 組合行程叫葉子綁 thread 的 method；`payload` 是 `{ threadId }`。 */
export const PAIR_ATTACH_METHOD = 'attach';

/** `unknown_method` 的訊息帶回 method 名稱的前幾個位元組（切在字元邊界）。 */
export const PAIR_METHOD_ECHO_BYTES = 64;

/** 葉子收到 `retry_later` 之後，至少等這麼久才重連。經驗值，沒有量過。 */
export const PAIR_RETRY_BACKOFF_MIN_MS = 250;

/** `rejected` 的 `code`：只有 `retry_later` 可以退避後重連；跟呼叫的錯誤碼是兩組。 */
export const PAIR_REJECT_CODES = ['retry_later', 'identity', 'version', 'protocol'] as const;

/** `rejected` 的 `code`，見 {@link PAIR_REJECT_CODES}。 */
export type PairRejectCode = (typeof PAIR_REJECT_CODES)[number];

/** 發起那一次呼叫的一方：`'l'` 葉子、`'m'` 組合行程。 */
export type PairSide = 'l' | 'm';

/** 一次呼叫的識別：發起的一方加上那一方自己編的 `id`。 */
export interface PairCallRef {
  readonly id: number;
  readonly side: PairSide;
}

/** 橋上的一框。 */
export type PairMessage =
  | { readonly type: 'hello'; readonly version: number }
  | { readonly type: 'rejected'; readonly code: PairRejectCode; readonly reason: string }
  | {
      readonly type: 'register';
      readonly tools: readonly string[];
      readonly hooks: readonly string[];
    }
  | {
      readonly type: 'call';
      readonly side: PairSide;
      readonly id: number;
      readonly parent: PairCallRef | null;
      readonly method: string;
      readonly payload: Json;
    }
  | {
      readonly type: 'chunk';
      readonly side: PairSide;
      readonly id: number;
      readonly seq: number;
      readonly payload: string;
    }
  | { readonly type: 'result'; readonly side: PairSide; readonly id: number; readonly ok: Json }
  | {
      readonly type: 'result';
      readonly side: PairSide;
      readonly id: number;
      readonly error: { readonly code: HostErrorCode; readonly message: string };
    }
  | { readonly type: 'cancel'; readonly side: PairSide; readonly id: number };

/** 框長、形狀或值不合協定；編與解都丟它。 */
export class PairProtocolError extends Error {
  override readonly name = 'PairProtocolError';
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** 只收有限的數字、成對的代理對、純物件與陣列；`depth` 是它外面已經有幾層。 */
function checkJson(value: unknown, depth: number): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new PairProtocolError('數字只收有限值');
    return;
  }
  if (typeof value === 'string') {
    if (LONE_SURROGATE.test(value)) throw new PairProtocolError('字串有落單的代理對');
    return;
  }
  if (typeof value !== 'object') throw new PairProtocolError(`不能過橋的值：${typeof value}`);
  if (depth >= MAX_DEPTH) throw new PairProtocolError('巢狀太深');
  if (Array.isArray(value)) {
    for (const item of value) checkJson(item, depth + 1);
    return;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new PairProtocolError('只收純物件');
  for (const [key, item] of Object.entries(value)) {
    if (LONE_SURROGATE.test(key)) throw new PairProtocolError('鍵有落單的代理對');
    checkJson(item, depth + 1);
  }
}

function asString(value: unknown): string {
  if (typeof value !== 'string') throw new PairProtocolError('要是字串');
  return value;
}

function asRejectCode(value: unknown): PairRejectCode {
  const code = PAIR_REJECT_CODES.find((known) => known === value);
  if (code === undefined) throw new PairProtocolError('不認得的拒絕碼');
  return code;
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new PairProtocolError('要是字串的陣列');
  }
  return value as string[];
}

function asSide(value: unknown): PairSide {
  if (value !== 'l' && value !== 'm') throw new PairProtocolError('side 要是 l 或 m');
  return value;
}

function asCount(value: unknown, field: 'id' | 'seq'): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    Object.is(value, -0)
  ) {
    throw new PairProtocolError(`${field} 不在範圍內`);
  }
  return value;
}

function asVersion(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 0xffff_ffff ||
    Object.is(value, -0)
  ) {
    throw new PairProtocolError('版本不是 u32');
  }
  return value;
}

function asChunk(value: unknown): string {
  if (typeof value !== 'string') throw new PairProtocolError('塊要是字串');
  if (Buffer.byteLength(value, 'utf8') > PAIR_MAX_CHUNK_BYTES) {
    throw new PairProtocolError('塊太大');
  }
  return value;
}

/** `keys` 每一個都要有，連同 `extra` 個別的鍵之外不能再多。 */
function exactFields(value: Record<string, unknown>, keys: readonly string[], extra: number): void {
  if (
    Object.keys(value).length !== keys.length + extra ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new PairProtocolError('欄位不對');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asParent(value: unknown): PairCallRef | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new PairProtocolError('parent 要是 null 或物件');
  exactFields(value, ['id', 'side'], 0);
  const side = asSide(value.side);
  return { id: asCount(value.id, 'id'), side };
}

function asError(value: unknown): { readonly code: HostErrorCode; readonly message: string } {
  if (!isRecord(value)) throw new PairProtocolError('error 要是物件');
  exactFields(value, ['code', 'message'], 0);
  const code = HOST_ERROR_CODES.find((known) => known === value.code);
  if (code === undefined) throw new PairProtocolError('不認得的錯誤碼');
  return { code, message: asString(value.message) };
}

/**
 * `method` 的 UTF-8 前 {@link PAIR_METHOD_ECHO_BYTES} 個位元組；落在一個字元中間時往前退到字元邊界。
 * 跟 Rust 那一側的 `clip_method` 同一個結果（向量檔的 `methodEchoes`）；前提是 `method` 沒有落單的代理對，{@link decodePairMessage} 解出來的都是。
 */
export function clipPairMethod(method: string): string {
  let bytes = 0;
  let end = 0;
  for (const char of method) {
    const point = char.codePointAt(0) ?? 0;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (bytes > PAIR_METHOD_ECHO_BYTES) break;
    end += char.length;
  }
  return method.slice(0, end);
}

/**
 * 編成緊湊 JSON：外層鍵照 `type` 在前的固定順序，`parent` 與 `error` 的鍵照碼位順序，跟 Rust 那一側一字不差；`payload` 與 `ok`
 * 照 `JSON.stringify`，Rust 重編時物件的鍵會照碼位排序。欄位的值不合 {@link decodePairMessage} 收的規則（`reason`、`method`、錯誤碼與錯誤訊息的型別由 TS 管，這裡不重核）、或整框超過
 * {@link PAIR_MAX_FRAME}，丟 {@link PairProtocolError}。
 */
export function encodePairMessage(message: PairMessage): Buffer {
  let value: Record<string, unknown>;
  switch (message.type) {
    case 'hello':
      value = { type: 'hello', version: asVersion(message.version) };
      break;
    case 'rejected':
      value = { type: 'rejected', code: asRejectCode(message.code), reason: message.reason };
      break;
    case 'register':
      value = {
        type: 'register',
        tools: asStrings(message.tools),
        hooks: asStrings(message.hooks),
      };
      break;
    case 'call': {
      const parent = asParent(message.parent);
      value = {
        type: 'call',
        side: asSide(message.side),
        id: asCount(message.id, 'id'),
        parent: parent && { id: parent.id, side: parent.side },
        method: message.method,
        payload: message.payload,
      };
      break;
    }
    case 'chunk':
      value = {
        type: 'chunk',
        side: asSide(message.side),
        id: asCount(message.id, 'id'),
        seq: asCount(message.seq, 'seq'),
        payload: asChunk(message.payload),
      };
      break;
    case 'result': {
      const head = { type: 'result', side: asSide(message.side), id: asCount(message.id, 'id') };
      value =
        'error' in message
          ? { ...head, error: { code: message.error.code, message: message.error.message } }
          : { ...head, ok: message.ok };
      break;
    }
    case 'cancel':
      value = { type: 'cancel', side: asSide(message.side), id: asCount(message.id, 'id') };
      break;
  }
  checkJson(value, 0);
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  if (bytes.length > PAIR_MAX_FRAME) {
    throw new PairProtocolError(`框長 ${String(bytes.length)} 超過上限 ${String(PAIR_MAX_FRAME)}`);
  }
  return bytes;
}

// `ignoreBOM: true` 是「不把開頭的 BOM 吃掉」：留著它，`JSON.parse` 才會跟 Rust 一樣拒收。
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** 解對方送來的一框；不是合法的 UTF-8 或 JSON、種類不認得、欄位少了或多了、型別不對，都丟 {@link PairProtocolError}。 */
export function decodePairMessage(payload: Buffer): PairMessage {
  let value: unknown;
  try {
    value = JSON.parse(UTF8.decode(payload));
  } catch {
    throw new PairProtocolError('不是 JSON');
  }
  checkJson(value, 0);
  if (!isRecord(value)) throw new PairProtocolError('不是物件');
  switch (value.type) {
    case 'hello':
      exactFields(value, ['version'], 1);
      return { type: 'hello', version: asVersion(value.version) };
    case 'rejected':
      exactFields(value, ['code', 'reason'], 1);
      return {
        type: 'rejected',
        code: asRejectCode(value.code),
        reason: asString(value.reason),
      };
    case 'register':
      exactFields(value, ['tools', 'hooks'], 1);
      return { type: 'register', tools: asStrings(value.tools), hooks: asStrings(value.hooks) };
    case 'call': {
      exactFields(value, ['side', 'id', 'parent', 'method', 'payload'], 1);
      const side = asSide(value.side);
      const id = asCount(value.id, 'id');
      const parent = asParent(value.parent);
      return {
        type: 'call',
        side,
        id,
        parent,
        method: asString(value.method),
        payload: value.payload as Json,
      };
    }
    case 'chunk': {
      exactFields(value, ['side', 'id', 'seq', 'payload'], 1);
      const side = asSide(value.side);
      const id = asCount(value.id, 'id');
      const seq = asCount(value.seq, 'seq');
      return { type: 'chunk', side, id, seq, payload: asChunk(value.payload) };
    }
    case 'result': {
      const last = Object.hasOwn(value, 'ok') ? 'ok' : 'error';
      exactFields(value, ['side', 'id', last], 1);
      const side = asSide(value.side);
      const id = asCount(value.id, 'id');
      return last === 'ok'
        ? { type: 'result', side, id, ok: value.ok as Json }
        : { type: 'result', side, id, error: asError(value.error) };
    }
    case 'cancel': {
      exactFields(value, ['side', 'id'], 1);
      const side = asSide(value.side);
      return { type: 'cancel', side, id: asCount(value.id, 'id') };
    }
    default:
      throw new PairProtocolError(typeof value.type === 'string' ? '不認得的種類' : '少了 type');
  }
}

/** 邊讀邊切框：每次 `push` 回這次湊齊的框，不完整的留著等下一次。長度欄位超過 {@link PAIR_MAX_FRAME} 就丟 {@link PairProtocolError}。 */
export class PairFrameReader {
  #pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.#pending = this.#pending.length === 0 ? chunk : Buffer.concat([this.#pending, chunk]);
    const frames: Buffer[] = [];
    while (this.#pending.length >= 4) {
      const length = this.#pending.readUInt32LE(0);
      if (length > PAIR_MAX_FRAME) {
        throw new PairProtocolError(`框長 ${String(length)} 超過上限 ${String(PAIR_MAX_FRAME)}`);
      }
      if (this.#pending.length < 4 + length) break;
      frames.push(this.#pending.subarray(4, 4 + length));
      this.#pending = this.#pending.subarray(4 + length);
    }
    return frames;
  }
}
