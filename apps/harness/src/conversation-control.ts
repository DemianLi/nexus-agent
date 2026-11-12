/**
 * 對話行程這一側的控制面（[#2338](https://github.com/DemianLi/nexus-agent/issues/2338)，設計 `.docs/supervisor-1947-design-2026-11-03.md` §5-2、§7-2）：
 * 從 stdin 讀監督行程的命令，往 stdout 寫回報，框格式與編解碼在 `supervisor-protocol.ts`。**stdout 只寫框**，日誌一律走 stderr。
 *
 * - `hello`：建構時就送自己的，宣告 loop 在自己這裡（`runsLoop: true`）。監督行程的第一框也要是版本相同的 `hello`，不是就當讀到解不開的框；它帶的 token 留在 {@link ConversationControl.hostToken}，
 *   並交給 `onHostToken`，給連宿主用。
 * - `bind(threadId)`：記下綁哪一條，叫 `open` 把它建起來，回 `bound`。建不起來也回 `bound`、記一行：之後經這條 thread 的請求會再建一次，
 *   失敗的話回的是 wire 上那個原因的專用碼（例如日誌太大），前台照常轉給瀏覽器。
 * - 閒置：每 `pollMs` 問一次 `idleState`。變成閒置時送 `idle(idleMs)`，`idleMs` 從「handler 的最後活動時間」與「上一次問到不閒的時間」
 *   兩者較晚的那個算（後者同 `sweepIdle` 的「不閒的重新計時」：有些條件放掉時不推最後活動時間）。閒著的期間最後活動時間又往前推了
 *   （兩次輪詢之間有個短請求來去），就再送一次 `idle`，讓監督行程從新的時間點重新計時。不再閒置時送 `busy`。
 * - `leaf`：給組合行程的，不理。
 * - `drain`：當場再問一次。仍閒置就停收會開新一輪的命令、回 `drained`；否則回 `busy`。
 * - 心跳：收到 `bind` 起每 `heartbeatMs` 送一次 `heartbeat`，在 `open` 之前就開始，不分在不在一輪裡。計時器 `unref`，跟著行程一起結束；
 *   `close` 才會提早停。
 *   監督行程看多久沒收到任何一框，事件迴圈卡住時計時器不觸發，心跳就斷了。
 * - 一輪的開始與結束：送 `turn`。沒看到開始的結束不送（續接時補寫的收尾）。
 * - stdin 讀到 EOF 或讀到解不開的框（當成 EOF）時叫 `onEnd` 一次，由呼叫端走收尾。
 *
 * @module
 */

import type { Readable, Writable } from 'node:stream';

import {
  PROTOCOL_VERSION,
  decodeConversationCommand,
  encodeConversationReport,
  frame,
  takeFrames,
} from './supervisor-protocol.js';
import type { ConversationCommand, ConversationReport } from './supervisor-protocol.js';

/** 控制面要 handler 提供的那幾樣，見 `wire-handler.ts` 的同名成員。 */
export interface ControlledHandler {
  idleState(
    threadId: string,
  ): { readonly idle: boolean; readonly lastActiveAt: number } | undefined;
  open(threadId: string): Promise<void>;
  stopAdmission(): void;
}

export interface ConversationControlOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly handler: ControlledHandler;
  /** 跟 handler 同一個時鐘（毫秒）。 */
  readonly now: () => number;
  /** 多久問一次閒不閒。 */
  readonly pollMs: number;
  /** 綁定之後多久送一次心跳。 */
  readonly heartbeatMs: number;
  /** stdin 讀到 EOF，或讀到解不開的框（框格式錯了，之後的位元組都對不上）。只叫一次。 */
  readonly onEnd: () => void;
  readonly warn: (message: string) => void;
  /** 收到監督行程 `hello` 帶的 token 時叫一次。 */
  readonly onHostToken?: (token: string) => void;
}

/** 回報 `idle` 時 `idleMs` 的上限（u32）。 */
const MAX_IDLE_MS = 0xffff_ffff;

export class ConversationControl {
  readonly #options: ConversationControlOptions;
  #bound: string | undefined;
  #opening = false;
  /** 建不起來的那一刻：之後沒有最後活動時間可讀，閒置從這裡算。 */
  #openFailedAt: number | undefined;
  /** 上一次送 `idle` 時的最後活動時間；`undefined` 是上一次送的是 `busy` 或還沒送過。 */
  #reportedIdleSince: number | undefined;
  /** 上一次問到不閒的時間。 */
  #busySeenAt: number | undefined;
  #inTurn = false;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #poll: ReturnType<typeof setInterval> | undefined;
  #pending: Buffer = Buffer.alloc(0);
  #ended = false;
  #hostToken: string | undefined;

  constructor(options: ConversationControlOptions) {
    this.#options = options;
    this.#send({ type: 'hello', version: PROTOCOL_VERSION, runsLoop: true });
    options.input.on('data', (chunk: Buffer) => this.#receive(chunk));
    options.input.on('end', () => this.#end());
  }

  /** 監督行程在 `hello` 裡給的 token；還沒收到是 `undefined`。 */
  get hostToken(): string | undefined {
    return this.#hostToken;
  }

  /** 這個行程綁著的 thread；還沒綁是 `undefined`。給 `WireHandlerOptions.boundThread`。 */
  get boundThread(): string | undefined {
    return this.#bound;
  }

  /** 根建好、插件載完：送 `ready`，開始輪詢閒置。 */
  ready(): void {
    this.#send({ type: 'ready' });
    this.#poll = setInterval(() => this.checkIdle(), this.#options.pollMs);
    this.#poll.unref();
  }

  /** 給 `WireHandlerOptions.onTurn`。 */
  turn(threadId: string, phase: 'begin' | 'end'): void {
    if (threadId !== this.#bound) return;
    if (phase === 'begin') {
      if (this.#inTurn) return;
      this.#inTurn = true;
      this.#send({ type: 'turn', phase });
      return;
    }
    if (!this.#inTurn) return;
    this.#inTurn = false;
    this.#send({ type: 'turn', phase });
  }

  /** 問一次閒不閒，有變化就回報。計時器每 `pollMs` 叫它；公開是為了測試決定性地驅動。 */
  checkIdle(): void {
    const since = this.#idleSince();
    if (since === undefined) {
      if (this.#bound !== undefined) this.#busySeenAt = this.#options.now();
      if (this.#reportedIdleSince !== undefined) {
        this.#reportedIdleSince = undefined;
        this.#send({ type: 'busy' });
      }
      return;
    }
    if (since === this.#reportedIdleSince) return;
    this.#reportedIdleSince = since;
    this.#send({
      type: 'idle',
      idleMs: Math.min(MAX_IDLE_MS, Math.max(0, this.#options.now() - since)),
    });
  }

  /** 停掉計時器。不碰 stdin／stdout。 */
  close(): void {
    clearInterval(this.#poll);
    clearInterval(this.#heartbeat);
  }

  /** 閒著的話回從什麼時候開始閒，不閒回 `undefined`。 */
  #idleSince(): number | undefined {
    const threadId = this.#bound;
    if (threadId === undefined || this.#opening) return undefined;
    const state = this.#options.handler.idleState(threadId);
    const since =
      state === undefined ? this.#openFailedAt : state.idle ? state.lastActiveAt : undefined;
    if (since === undefined) return undefined;
    return this.#busySeenAt === undefined ? since : Math.max(since, this.#busySeenAt);
  }

  #receive(chunk: Buffer): void {
    if (this.#ended) return;
    let frames: Buffer[];
    try {
      ({ frames, rest: this.#pending } = takeFrames(Buffer.concat([this.#pending, chunk])));
    } catch (error: unknown) {
      this.#fail(error);
      return;
    }
    for (const payload of frames) {
      let command: ConversationCommand;
      try {
        command = decodeConversationCommand(payload);
      } catch (error: unknown) {
        this.#fail(error);
        return;
      }
      if (this.#hostToken === undefined) {
        if (command.type !== 'hello' || command.version !== PROTOCOL_VERSION) {
          this.#fail(
            new Error(
              `第一框要是版本 ${String(PROTOCOL_VERSION)} 的 hello，收到 ${command.type === 'hello' ? `版本 ${String(command.version)}` : command.type}`,
            ),
          );
          return;
        }
        this.#hostToken = command.token;
        this.#options.onHostToken?.(command.token);
        continue;
      }
      if (command.type === 'hello') this.#options.warn('[控制面] 監督行程又送了一次 hello，不理');
      else if (command.type === 'bind') void this.#bind(command.threadId);
      else if (command.type === 'drain') this.#drain();
    }
  }

  async #bind(threadId: string): Promise<void> {
    if (this.#bound !== undefined) {
      if (this.#bound !== threadId) {
        this.#options.warn(`[控制面] 已綁 thread "${this.#bound}"，不改綁 "${threadId}"`);
        return;
      }
      this.#send({ type: 'bound', threadId });
      return;
    }
    this.#bound = threadId;
    this.#heartbeat = setInterval(
      () => this.#send({ type: 'heartbeat' }),
      this.#options.heartbeatMs,
    );
    this.#heartbeat.unref();
    this.#opening = true;
    try {
      await this.#options.handler.open(threadId);
    } catch (error: unknown) {
      this.#openFailedAt = this.#options.now();
      this.#options.warn(
        `[控制面] thread "${threadId}" 建不起來（之後的請求會再試）：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.#opening = false;
    }
    this.#send({ type: 'bound', threadId });
  }

  #drain(): void {
    if (this.#idleSince() === undefined) {
      this.#reportedIdleSince = undefined;
      this.#send({ type: 'busy' });
      return;
    }
    this.#options.handler.stopAdmission();
    this.#send({ type: 'drained' });
  }

  #fail(error: unknown): void {
    this.#options.warn(
      `[控制面] 讀不懂監督行程送來的框，當成 EOF：${error instanceof Error ? error.message : String(error)}`,
    );
    this.#end();
  }

  #end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#options.onEnd();
  }

  #send(report: ConversationReport): void {
    this.#options.output.write(frame(encodeConversationReport(report)));
  }
}
