/**
 * 對話行程連宿主 socket 的協定，客戶端這一側；宿主那一側是 `native/sandbox-spawner/src/host_protocol.rs`，兩邊對同一份向量檔
 * （`native/sandbox-spawner/host-vectors.json`）測。
 *
 * 框是 `u32` LE 長度加內容，內容是一份 JSON 物件，`type` 分種類。客戶端只送 `hello`（帶協定版本與監督行程在控制通道上給的 token）；
 * 宿主回 `hello`（收下這條連線）或 `rejected`（送完就斷）。
 *
 * @module
 */

/** 宿主協定的版本，跟 `supervisor_protocol.rs` 的 `PROTOCOL_VERSION` 與向量檔的 `protocolVersion` 相同。 */
export const PROTOCOL_VERSION = 3;

/** 一框最長多少，跟 `host_protocol.rs` 的 `MAX_FRAME` 相同。 */
export const MAX_FRAME = 256 * 1024;

export type ClientMessage = {
  readonly type: 'hello';
  readonly version: number;
  readonly token: string;
};

export type HostMessage =
  | { readonly type: 'hello'; readonly version: number }
  | { readonly type: 'rejected'; readonly reason: string };

export class HostProtocolError extends Error {
  override readonly name = 'HostProtocolError';
}

/** 編成緊湊 JSON，鍵照 `type` 在前的固定順序，跟宿主那一側編出來的一字不差。 */
export function encodeClientMessage(message: ClientMessage): Buffer {
  return Buffer.from(
    JSON.stringify({ type: message.type, version: message.version, token: message.token }),
    'utf8',
  );
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
  if (fields.type === 'hello') {
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
  if (fields.type === 'rejected') {
    exactFields(fields, ['reason']);
    if (typeof fields.reason !== 'string') throw new HostProtocolError('reason 要是字串');
    return { type: 'rejected', reason: fields.reason };
  }
  throw new HostProtocolError(typeof fields.type === 'string' ? '不認得的種類' : '少了 type');
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
