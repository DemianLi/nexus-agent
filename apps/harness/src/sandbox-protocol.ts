/**
 * 沙箱 spawner 控制通道的編解碼（[#1946](https://github.com/DemianLi/nexus-agent/issues/1946)）：**純函式、不依賴任何套件**，
 * harness 與樹外的驗證腳本（`scripts/release/verify-packed-install.ts`）共用這一份。格式的定義在
 * `native/sandbox-spawner/src/protocol.rs` 的檔頭；兩邊對同一份向量檔（`native/sandbox-spawner/protocol-vectors.json`）測。
 *
 * @module
 */

/** 一框最多多大，同 spawner 的 `MAX_FRAME`。 */
export const MAX_FRAME = 1 << 20;

/** 檔案效果政策。`full-access` 不上 Landlock，seccomp 照樣繼承。 */
export type SpawnMode = 'read-only' | 'workspace-write' | 'full-access';

export interface SpawnRequest {
  readonly type: 'spawn';
  readonly id: number;
  readonly mode: SpawnMode;
  /** 第 i 位元是 1：fd i 接 Node 連進去的那條連線；是 0：接 `/dev/null`。 */
  readonly pipes: number;
  readonly cwd: string;
  readonly readable: readonly string[];
  readonly writable: readonly string[];
  readonly argv: readonly string[];
  /** `NAME=value`。子行程的環境就是這一份。 */
  readonly env: readonly string[];
}

export interface SignalRequest {
  readonly type: 'signal';
  readonly id: number;
  readonly signo: number;
}

export type SpawnerRequest = SpawnRequest | SignalRequest;

export type FailKind = 'sandbox-unavailable' | 'start-dir' | 'exec' | 'protocol' | 'resource';

export type SpawnerEvent =
  | { readonly type: 'unavailable'; readonly errno: number; readonly detail: string }
  | { readonly type: 'ready'; readonly filterInsns: number; readonly landlockAbi: number }
  | {
      readonly type: 'started';
      readonly id: number;
      readonly pid: number;
      readonly partial: boolean;
    }
  | {
      readonly type: 'failed';
      readonly id: number;
      readonly kind: FailKind;
      readonly errno: number;
      readonly detail: string;
    }
  | {
      readonly type: 'exited';
      readonly id: number;
      readonly code: number;
      readonly signal: number;
    };

const MODES: readonly SpawnMode[] = ['read-only', 'workspace-write', 'full-access'];
const FAIL_KINDS: readonly FailKind[] = [
  'sandbox-unavailable',
  'start-dir',
  'exec',
  'protocol',
  'resource',
];
const REQ_SPAWN = 0x53;
const REQ_SIGNAL = 0x4b;
const EV_UNAVAILABLE = 0x55;
const EV_READY = 0x52;
const EV_STARTED = 0x53;
const EV_FAILED = 0x46;
const EV_EXITED = 0x45;

/** 看不懂的框：兩邊對協定的認知不一致。 */
export class SpawnerProtocolError extends Error {
  override readonly name = 'SpawnerProtocolError';
}

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0);
  return out;
}

function bytes(value: string): Buffer {
  const raw = Buffer.from(value, 'utf8');
  return Buffer.concat([u32(raw.length), raw]);
}

function list(values: readonly string[]): Buffer {
  return Buffer.concat([u32(values.length), ...values.map(bytes)]);
}

export function encodeRequest(request: SpawnerRequest): Buffer {
  if (request.type === 'signal') {
    return Buffer.concat([Buffer.from([REQ_SIGNAL]), u32(request.id), u32(request.signo)]);
  }
  return Buffer.concat([
    Buffer.from([REQ_SPAWN]),
    u32(request.id),
    Buffer.from([MODES.indexOf(request.mode), request.pipes]),
    bytes(request.cwd),
    list(request.readable),
    list(request.writable),
    list(request.argv),
    list(request.env),
  ]);
}

class Reader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}

  private need(n: number): void {
    if (this.buf.length - this.offset < n) throw new SpawnerProtocolError('框被截斷');
  }

  u8(): number {
    this.need(1);
    return this.buf.readUInt8(this.offset++);
  }

  u32(): number {
    this.need(4);
    const value = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  i32(): number {
    return this.u32() | 0;
  }

  text(): string {
    const len = this.u32();
    this.need(len);
    const value = this.buf.toString('utf8', this.offset, this.offset + len);
    this.offset += len;
    return value;
  }

  end(): void {
    if (this.offset !== this.buf.length) throw new SpawnerProtocolError('框尾有多餘的內容');
  }
}

export function decodeEvent(payload: Buffer): SpawnerEvent {
  const r = new Reader(payload);
  let event: SpawnerEvent;
  switch (r.u8()) {
    case EV_UNAVAILABLE:
      event = { type: 'unavailable', errno: r.i32(), detail: r.text() };
      break;
    case EV_READY:
      event = { type: 'ready', filterInsns: r.u32(), landlockAbi: r.u32() };
      break;
    case EV_STARTED:
      event = { type: 'started', id: r.u32(), pid: r.u32(), partial: r.u8() !== 0 };
      break;
    case EV_FAILED: {
      const id = r.u32();
      const kind = FAIL_KINDS[r.u8() - 1];
      if (kind === undefined) throw new SpawnerProtocolError('不認得的失敗種類');
      event = { type: 'failed', id, kind, errno: r.i32(), detail: r.text() };
      break;
    }
    case EV_EXITED:
      event = { type: 'exited', id: r.u32(), code: r.i32(), signal: r.i32() };
      break;
    default:
      throw new SpawnerProtocolError('不認得的事件');
  }
  r.end();
  return event;
}

/** 加上長度前綴。 */
export function frame(payload: Buffer): Buffer {
  return Buffer.concat([u32(payload.length), payload]);
}

/**
 * 從累積的輸入切出完整的框，回切出來的框與剩下的輸入。框長超過 {@link MAX_FRAME} 丟 {@link SpawnerProtocolError}。
 */
export function takeFrames(input: Buffer): { readonly frames: Buffer[]; readonly rest: Buffer } {
  const frames: Buffer[] = [];
  let offset = 0;
  while (input.length - offset >= 4) {
    const len = input.readUInt32LE(offset);
    if (len > MAX_FRAME) throw new SpawnerProtocolError('框太大');
    if (input.length - offset - 4 < len) break;
    frames.push(input.subarray(offset + 4, offset + 4 + len));
    offset += 4 + len;
  }
  return { frames, rest: input.subarray(offset) };
}

/** stdio 連線的 8 bytes 標頭：要求的 id 與要接的 fd（0、1、2）。 */
export function stdioHeader(id: number, fd: 0 | 1 | 2): Buffer {
  return Buffer.concat([u32(id), u32(fd)]);
}
