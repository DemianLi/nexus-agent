/**
 * 監督行程控制面的編解碼（[#1947](https://github.com/DemianLi/nexus-agent/issues/1947)，設計 `.docs/supervisor-1947-design-2026-11-03.md` §五）：
 * 監督行程與對話行程、與前台之間的訊息。**純函式、不依賴任何套件**。格式的定義在
 * `native/sandbox-spawner/src/supervisor_protocol.rs` 的檔頭；兩邊對同一份向量檔（`native/sandbox-spawner/supervisor-vectors.json`）測。
 *
 * 框（長度前綴）與 spawner 的控制通道同一個格式，用 {@link frame}、{@link takeFrames}。四個方向各一對編解碼，種類 byte 在四個方向之間不重複：
 * 這兩條通道之間框送錯方向時，解碼器丟「不認得的種類」。跟 spawner 控制通道的種類 byte 有重疊（`R`、`E`），那條通道的框不在保證內。
 * 監督行程與宿主之間的兩個方向只在 Rust 那一側，這裡沒有。
 *
 * 每條通道的第一框都是 `hello`，帶 {@link PROTOCOL_VERSION}：監督行程一起起子行程就先送它的（帶這個行程連宿主用的 token），子行程送的第一框
 * 也要是 `hello`。版本要完全相等：兩邊一起出貨，對不上就是裝錯了。
 *
 * 編碼器不夾值：數字欄位超出 0 到 2³²−1 就丟 `RangeError`（小數截掉、`NaN` 寫成 0，照 Node 的 `writeUInt32LE`）。解碼遇到不是 UTF-8 的字串換成 U+FFFD，不丟錯。
 *
 * @module
 */

/** 框的長度前綴與切框，同 spawner 那一份。`takeFrames` 遇到超過 `MAX_FRAME` 的框丟 `SpawnerProtocolError`；`frame` 不檢查大小。 */
export { MAX_FRAME, frame, takeFrames } from './sandbox-protocol.js';

/** 控制面協定的版本，跟 `supervisor_protocol.rs` 的 `PROTOCOL_VERSION` 與向量檔的 `protocolVersion` 相同。 */
export const PROTOCOL_VERSION = 1;

/** 監督行程 → 對話行程。`hello`：第一框，帶這個行程連宿主用的 token（只在這條通道上，不放環境變數與參數）。`bind`：綁定一條 thread，預熱池裡的與一開始就為某條 thread 起的行程都走這一則。`drain`：對話行程確認仍閒置才回 `drained`，否則回 `busy`；收掉是接著關 stdin。 */
export type ConversationCommand =
  | { readonly type: 'hello'; readonly version: number; readonly token: string }
  | { readonly type: 'bind'; readonly threadId: string }
  | { readonly type: 'drain' };

/** 對話行程 → 監督行程。 */
export type ConversationReport =
  /** 第一框。版本不對或第一框不是它，監督行程以 `protocol` 收掉這個行程。 */
  | { readonly type: 'hello'; readonly version: number }
  /** 根建好、插件載完，可以綁 thread。 */
  | { readonly type: 'ready' }
  /** 已綁定，帶回同一個 id。 */
  | { readonly type: 'bound'; readonly threadId: string }
  | { readonly type: 'turn'; readonly phase: 'begin' | 'end' }
  /** 變成閒置時送，帶送出時已經閒置了多久（毫秒，0 到 2³²−1；超過時送端送 2³²−1）。時間只送相對值：監督行程用自己的單調時鐘記收到的時間點。 */
  | { readonly type: 'idle'; readonly idleMs: number }
  /** 不再閒置；也是 `drain` 時仍不閒置的回答。 */
  | { readonly type: 'busy' }
  /** 一輪中定時送，監督行程用它判斷事件迴圈有沒有卡死。 */
  | { readonly type: 'heartbeat' }
  /** 回 `drain`：確認仍閒置、不再接新的請求，可以收了。 */
  | { readonly type: 'drained' };

/** `ensure` 這次打開是為了什麼。`read-only`：只讀歷史（設計 §7-3），閒置時間短、名額滿時最先被逐出。 */
export type OpenMode = 'run' | 'read-only';

/** 前台 → 監督行程。`ensure` 的回答是 `up`、`down` 或 `capacity`；`release`：前台用完了這條 thread，只讀開啟的可以先收；已經轉成一般的（`ensure(run)` 或 `turn(begin)` 過）監督行程不理，照 `--idle-ms` 收。 */
export type FrontRequest =
  /** 第一框。版本不對或第一框不是它，監督行程整台停機、結束碼 3。 */
  | { readonly type: 'hello'; readonly version: number }
  | { readonly type: 'ensure'; readonly threadId: string; readonly open: OpenMode }
  | { readonly type: 'release'; readonly threadId: string }
  /** 回 `stop-admission`：不再收新的請求了。 */
  | { readonly type: 'admission-stopped' };

/** 對話行程為什麼結束，依碼（1 起）的順序。前七類見設計 §6-2；`protocol`：控制通道的第一框不是版本相同的 `hello`。 */
export const DEATH_CAUSES = [
  'heap',
  'memory',
  'host-oom',
  'stalled',
  'crash',
  'evicted',
  'shutdown',
  'protocol',
] as const;

export type DeathCause = (typeof DEATH_CAUSES)[number];

/** 監督行程 → 前台。 */
export type FrontEvent =
  /** 第一框，帶前台連宿主用的 token。 */
  | { readonly type: 'hello'; readonly version: number; readonly token: string }
  /** 停機的第一步：停收新的請求，停好了回 `admission-stopped`。監督行程等它回答（有上限），之後才收對話行程。 */
  | { readonly type: 'stop-admission' }
  /** 這條 thread 的對話行程在 `socket` 上聽，前台直接連。 */
  | { readonly type: 'up'; readonly threadId: string; readonly socket: string }
  /** 結束了，或沒起成（`crash`）。 */
  | { readonly type: 'down'; readonly threadId: string; readonly cause: DeathCause }
  /** 名額滿、沒有可逐出的，這條沒起：前台回 `thread_at_capacity`。`current` 含預熱池與起動中的行程。 */
  | {
      readonly type: 'capacity';
      readonly threadId: string;
      readonly current: number;
      readonly limit: number;
    }
  /** 給 `/metrics`：活著的對話行程數（含預熱池）、預熱池大小、RSS 合計（KiB）、各類死因的累計。 */
  | {
      readonly type: 'stats';
      readonly live: number;
      readonly warm: number;
      readonly rssKib: number;
      readonly deaths: Readonly<Record<DeathCause, number>>;
    };

const CMD_HELLO = 0x77; // w
const CMD_BIND = 0x62; // b
const CMD_DRAIN = 0x64; // d
const REP_HELLO = 0x56; // V
const REP_READY = 0x52; // R
const REP_BOUND = 0x42; // B
const REP_TURN = 0x54; // T
const REP_IDLE = 0x49; // I
const REP_BUSY = 0x59; // Y
const REP_HEARTBEAT = 0x48; // H
const REP_DRAINED = 0x44; // D
const REQ_HELLO = 0x46; // F
const REQ_ENSURE = 0x45; // E
const REQ_RELEASE = 0x4c; // L
const REQ_ADMISSION_STOPPED = 0x53; // S
const EV_HELLO = 0x66; // f
const EV_STOP_ADMISSION = 0x73; // s
const EV_UP = 0x75; // u
const EV_DOWN = 0x78; // x
const EV_CAPACITY = 0x63; // c
const EV_STATS = 0x6d; // m

const PHASES = ['begin', 'end'] as const;
const OPEN_MODES: readonly OpenMode[] = ['run', 'read-only'];

/** 內容解不開（截斷、框尾多餘、不認得的種類或列舉碼）丟這個；框太大是 `takeFrames` 丟的 `SpawnerProtocolError`，兩個都要接。 */
export class SupervisorProtocolError extends Error {
  override readonly name = 'SupervisorProtocolError';
}

class Writer {
  private readonly parts: Buffer[] = [];

  u8(value: number): this {
    this.parts.push(Buffer.from([value]));
    return this;
  }

  u32(value: number): this {
    const out = Buffer.alloc(4);
    out.writeUInt32LE(value);
    this.parts.push(out);
    return this;
  }

  text(value: string): this {
    const raw = Buffer.from(value, 'utf8');
    return this.u32(raw.length).raw(raw);
  }

  private raw(value: Buffer): this {
    this.parts.push(value);
    return this;
  }

  done(): Buffer {
    return Buffer.concat(this.parts);
  }
}

class Reader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}

  private need(n: number): void {
    if (this.buf.length - this.offset < n) throw new SupervisorProtocolError('框被截斷');
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

  text(): string {
    const len = this.u32();
    this.need(len);
    const value = this.buf.toString('utf8', this.offset, this.offset + len);
    this.offset += len;
    return value;
  }

  /** 一個 byte 的列舉，碼是 `table` 的索引加上 `base`。 */
  pick<T>(table: readonly T[], base: number, what: string): T {
    const value = table[this.u8() - base];
    if (value === undefined) throw new SupervisorProtocolError(`不認得的${what}`);
    return value;
  }

  end(): void {
    if (this.offset !== this.buf.length) throw new SupervisorProtocolError('框尾有多餘的內容');
  }
}

function decoded<T>(payload: Buffer, read: (r: Reader, kind: number) => T | undefined): T {
  const r = new Reader(payload);
  const value = read(r, r.u8());
  if (value === undefined) throw new SupervisorProtocolError('不認得的種類');
  r.end();
  return value;
}

/** 編一則給對話行程的命令（不含長度前綴，用 {@link frame} 加）。 */
export function encodeConversationCommand(command: ConversationCommand): Buffer {
  const w = new Writer();
  switch (command.type) {
    case 'hello':
      return w.u8(CMD_HELLO).u32(command.version).text(command.token).done();
    case 'bind':
      return w.u8(CMD_BIND).text(command.threadId).done();
    case 'drain':
      return w.u8(CMD_DRAIN).done();
  }
}

/** 解一框給對話行程的命令。截斷、框尾多出來、不認得的種類都丟 {@link SupervisorProtocolError}。 */
export function decodeConversationCommand(payload: Buffer): ConversationCommand {
  return decoded<ConversationCommand>(payload, (r, kind) => {
    if (kind === CMD_HELLO) return { type: 'hello', version: r.u32(), token: r.text() };
    if (kind === CMD_BIND) return { type: 'bind', threadId: r.text() };
    if (kind === CMD_DRAIN) return { type: 'drain' };
    return undefined;
  });
}

/** 編一則對話行程的回報（不含長度前綴）。 */
export function encodeConversationReport(report: ConversationReport): Buffer {
  const w = new Writer();
  switch (report.type) {
    case 'hello':
      return w.u8(REP_HELLO).u32(report.version).done();
    case 'ready':
      return w.u8(REP_READY).done();
    case 'bound':
      return w.u8(REP_BOUND).text(report.threadId).done();
    case 'turn':
      return w.u8(REP_TURN).u8(PHASES.indexOf(report.phase)).done();
    case 'idle':
      return w.u8(REP_IDLE).u32(report.idleMs).done();
    case 'busy':
      return w.u8(REP_BUSY).done();
    case 'heartbeat':
      return w.u8(REP_HEARTBEAT).done();
    case 'drained':
      return w.u8(REP_DRAINED).done();
  }
}

/** 解一框對話行程的回報。截斷、框尾多出來、不認得的種類或一輪階段都丟 {@link SupervisorProtocolError}。 */
export function decodeConversationReport(payload: Buffer): ConversationReport {
  return decoded<ConversationReport>(payload, (r, kind) => {
    switch (kind) {
      case REP_HELLO:
        return { type: 'hello', version: r.u32() };
      case REP_READY:
        return { type: 'ready' };
      case REP_BOUND:
        return { type: 'bound', threadId: r.text() };
      case REP_TURN:
        return { type: 'turn', phase: r.pick(PHASES, 0, '一輪階段') };
      case REP_IDLE:
        return { type: 'idle', idleMs: r.u32() };
      case REP_BUSY:
        return { type: 'busy' };
      case REP_HEARTBEAT:
        return { type: 'heartbeat' };
      case REP_DRAINED:
        return { type: 'drained' };
      default:
        return undefined;
    }
  });
}

/** 編一則前台的要求（不含長度前綴）。 */
export function encodeFrontRequest(request: FrontRequest): Buffer {
  const w = new Writer();
  switch (request.type) {
    case 'hello':
      return w.u8(REQ_HELLO).u32(request.version).done();
    case 'ensure':
      return w.u8(REQ_ENSURE).text(request.threadId).u8(OPEN_MODES.indexOf(request.open)).done();
    case 'release':
      return w.u8(REQ_RELEASE).text(request.threadId).done();
    case 'admission-stopped':
      return w.u8(REQ_ADMISSION_STOPPED).done();
  }
}

/** 解一框前台的要求。截斷、框尾多出來、不認得的種類或打開方式都丟 {@link SupervisorProtocolError}。 */
export function decodeFrontRequest(payload: Buffer): FrontRequest {
  return decoded<FrontRequest>(payload, (r, kind) => {
    if (kind === REQ_ENSURE) {
      return { type: 'ensure', threadId: r.text(), open: r.pick(OPEN_MODES, 0, '打開方式') };
    }
    if (kind === REQ_RELEASE) return { type: 'release', threadId: r.text() };
    if (kind === REQ_HELLO) return { type: 'hello', version: r.u32() };
    if (kind === REQ_ADMISSION_STOPPED) return { type: 'admission-stopped' };
    return undefined;
  });
}

/** 編一則給前台的事件（不含長度前綴）。 */
export function encodeFrontEvent(event: FrontEvent): Buffer {
  const w = new Writer();
  switch (event.type) {
    case 'hello':
      return w.u8(EV_HELLO).u32(event.version).text(event.token).done();
    case 'stop-admission':
      return w.u8(EV_STOP_ADMISSION).done();
    case 'up':
      return w.u8(EV_UP).text(event.threadId).text(event.socket).done();
    case 'down':
      return w
        .u8(EV_DOWN)
        .text(event.threadId)
        .u8(DEATH_CAUSES.indexOf(event.cause) + 1)
        .done();
    case 'capacity':
      return w.u8(EV_CAPACITY).text(event.threadId).u32(event.current).u32(event.limit).done();
    case 'stats':
      w.u8(EV_STATS).u32(event.live).u32(event.warm).u32(event.rssKib);
      for (const cause of DEATH_CAUSES) w.u32(event.deaths[cause]);
      return w.done();
  }
}

/** 解一框給前台的事件。截斷、框尾多出來、不認得的種類或死因都丟 {@link SupervisorProtocolError}。 */
export function decodeFrontEvent(payload: Buffer): FrontEvent {
  return decoded<FrontEvent>(payload, (r, kind) => {
    switch (kind) {
      case EV_HELLO:
        return { type: 'hello', version: r.u32(), token: r.text() };
      case EV_STOP_ADMISSION:
        return { type: 'stop-admission' };
      case EV_UP:
        return { type: 'up', threadId: r.text(), socket: r.text() };
      case EV_DOWN:
        return { type: 'down', threadId: r.text(), cause: r.pick(DEATH_CAUSES, 1, '死因') };
      case EV_CAPACITY:
        return { type: 'capacity', threadId: r.text(), current: r.u32(), limit: r.u32() };
      case EV_STATS: {
        const live = r.u32();
        const warm = r.u32();
        const rssKib = r.u32();
        const deaths = Object.fromEntries(DEATH_CAUSES.map((cause) => [cause, r.u32()])) as Record<
          DeathCause,
          number
        >;
        return { type: 'stats', live, warm, rssKib, deaths };
      }
      default:
        return undefined;
    }
  });
}
