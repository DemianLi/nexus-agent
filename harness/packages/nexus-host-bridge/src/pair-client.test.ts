import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PAIR_STARTUP_DEADLINE_MAX_MS,
  PairCallError,
  PairClient,
  PairConnectError,
  PairPeerGoneError,
  PairSendError,
  type PairCallContext,
  type PairClock,
  type PairConnectFailure,
  type PairConnectOptions,
  type PairRetry,
} from './pair-client.js';
import {
  PAIR_HELLO_TIMEOUT_MS,
  PAIR_MAX_CALLS,
  PAIR_MAX_CHUNK_BYTES,
  PAIR_MAX_FRAME,
  PAIR_METHOD_ECHO_BYTES,
  PAIR_OUTBOX_LIMIT_BYTES,
  PAIR_OUTBOX_PAUSE_BYTES,
  PAIR_PROTOCOL_VERSION,
  PAIR_RETRY_BACKOFF_MIN_MS,
  PAIR_STALL_TIMEOUT_MS,
  PairFrameReader,
  PairFrameTooLargeError,
  PairProtocolError,
  decodePairMessage,
  encodePairMessage,
  type PairMessage,
} from './pair-protocol.js';
import { frame, type Json } from './protocol.js';

/** 手動推進的時鐘：時間只在 `advance` 裡走。 */
class ManualClock implements PairClock {
  #now = 0;
  #next = 0;
  readonly #timers = new Map<number, { readonly at: number; readonly callback: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    this.#next += 1;
    this.#timers.set(this.#next, { at: this.#now + ms, callback });
    return this.#next;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  get pending(): number {
    return this.#timers.size;
  }

  /** 走 `ms` 毫秒，到期的計時器照時間順序叫。 */
  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      let due: number | undefined;
      for (const [id, timer] of this.#timers) {
        const best = due === undefined ? undefined : this.#timers.get(due);
        if (timer.at <= target && (best === undefined || timer.at < best.at)) due = id;
      }
      const timer = due === undefined ? undefined : this.#timers.get(due);
      if (due === undefined || timer === undefined) break;
      this.#timers.delete(due);
      this.#now = timer.at;
      timer.callback();
    }
    this.#now = target;
  }
}

/** 讓事件迴圈轉到 `condition` 成立；不靠時間。 */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let round = 0; round < 200_000; round += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`等不到：${what}`);
}

/** 讓事件迴圈多轉幾圈：給「不該發生的事」機會發生。 */
async function spin(): Promise<void> {
  for (let round = 0; round < 200; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** 假的組合行程收下的一條連線。 */
class Conn {
  readonly frames: PairMessage[] = [];
  closed = false;
  readonly #reader = new PairFrameReader();
  #reading = false;
  /** 讀到第一框時叫一次。 */
  onHello: () => void = () => undefined;

  constructor(
    readonly socket: Socket,
    readonly at: number,
  ) {
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.closed = true;
    });
  }

  /** 開始讀（或接著讀）；沒叫過就不把收到的交出來：Node 自己的緩衝滿了就不再從 kernel 讀，kernel 的 buffer 也滿了之後對方就寫不進來。 */
  read(): void {
    this.socket.resume();
    if (this.#reading) return;
    this.#reading = true;
    this.socket.on('data', (chunk: Buffer) => {
      for (const payload of this.#reader.push(chunk)) {
        this.frames.push(decodePairMessage(payload));
        if (this.frames.length === 1) this.onHello();
      }
    });
  }

  /** 讀到葉子的 `hello` 就回 `hello`（後面接 `more`）；`thenStop` 時回完就不再讀，到下一次 `read`。 */
  greet(thenStop = false, ...more: PairMessage[]): void {
    this.onHello = () => {
      this.send({ type: 'hello', version: PAIR_PROTOCOL_VERSION }, ...more);
      if (thenStop) this.socket.pause();
    };
    this.read();
  }

  send(...messages: PairMessage[]): void {
    this.socket.write(Buffer.concat(messages.map((message) => frame(encodePairMessage(message)))));
  }

  sendJson(json: string): void {
    this.socket.write(frame(Buffer.from(json, 'utf8')));
  }

  /** 讀到的框裡某一種的。 */
  of<T extends PairMessage['type']>(type: T): Extract<PairMessage, { type: T }>[] {
    return this.frames.filter(
      (message): message is Extract<PairMessage, { type: T }> => message.type === type,
    );
  }
}

const HELLO: PairMessage = { type: 'hello', version: PAIR_PROTOCOL_VERSION };

function rejected(code: 'retry_later' | 'identity' | 'version' | 'protocol', reason: string) {
  return { type: 'rejected', code, reason } as const;
}

/** 假的組合行程：每收下一條連線叫一次 `onConn`。 */
class Composition {
  readonly conns: Conn[] = [];
  readonly dir = mkdtempSync(join(tmpdir(), 'npair-'));
  readonly path = join(this.dir, 's');
  readonly clock = new ManualClock();
  readonly retries: PairRetry[] = [];
  onConn: (conn: Conn, index: number) => void = (conn) => {
    conn.greet();
  };
  #server: Server | undefined;

  async listen(): Promise<void> {
    const server = createServer((socket) => {
      const conn = new Conn(socket, this.clock.now());
      this.conns.push(conn);
      this.onConn(conn, this.conns.length - 1);
    });
    this.#server = server;
    await new Promise<void>((resolve) => server.listen(this.path, resolve));
  }

  options(extra: Partial<PairConnectOptions> = {}): PairConnectOptions {
    return {
      socketPath: this.path,
      startupDeadlineMs: 10_000,
      clock: this.clock,
      onRetry: (retry) => {
        this.retries.push(retry);
      },
      ...extra,
    };
  }

  /** 連到結束：每次要退避就把時鐘推過那一段。回連上的 client 或失敗；每次連進來的時刻在 `conns[].at`。 */
  async run(
    extra: Partial<PairConnectOptions> = {},
  ): Promise<{ readonly client?: PairClient; readonly failure?: PairConnectFailure }> {
    const outcome = track(PairClient.connect(this.options(extra)));
    let seen = 0;
    for (;;) {
      await until(() => outcome.settled || this.retries.length > seen, '連線結束或要退避');
      if (outcome.settled) break;
      seen = this.retries.length;
      this.clock.advance(this.retries[seen - 1]?.waitMs ?? 0);
    }
    if (outcome.error === undefined) return { client: outcome.value as PairClient };
    if (!(outcome.error instanceof PairConnectError)) throw outcome.error;
    return { failure: outcome.error.failure };
  }

  /** 握手完成的一條：葉子與組合行程那一端。 */
  async connected(
    extra: Partial<PairConnectOptions> = {},
  ): Promise<{ readonly client: PairClient; readonly conn: Conn }> {
    await this.listen();
    const { client } = await this.run(extra);
    const conn = this.conns[0];
    if (client === undefined || conn === undefined) throw new Error('沒連上');
    return { client, conn };
  }

  close(): void {
    for (const conn of this.conns) conn.socket.destroy();
    this.#server?.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

interface Tracked<T> {
  settled: boolean;
  value?: T;
  error?: Error;
}

function track<T>(promise: Promise<T>): Tracked<T> {
  const tracked: Tracked<T> = { settled: false };
  promise.then(
    (value) => {
      tracked.settled = true;
      tracked.value = value;
    },
    (error: unknown) => {
      tracked.settled = true;
      tracked.error = error instanceof Error ? error : new Error(String(error));
    },
  );
  return tracked;
}

let rigs: Composition[] = [];

function composition(): Composition {
  const rig = new Composition();
  rigs.push(rig);
  return rig;
}

afterEach(() => {
  for (const rig of rigs) rig.close();
  rigs = [];
});

describe('連線的選項', () => {
  it('時限與退避短於下限、超過上限或是 NaN 就丟 RangeError', async () => {
    const base = { socketPath: '/nonexistent', startupDeadlineMs: 10_000 };
    await expect(
      PairClient.connect({ ...base, helloTimeoutMs: PAIR_HELLO_TIMEOUT_MS - 1 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      PairClient.connect({ ...base, startupDeadlineMs: PAIR_HELLO_TIMEOUT_MS - 1 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      PairClient.connect({ ...base, helloTimeoutMs: 20_000, startupDeadlineMs: 19_999 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      PairClient.connect({ ...base, backoffMs: PAIR_RETRY_BACKOFF_MIN_MS - 1 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      PairClient.connect({ ...base, backoffMs: 500, backoffMaxMs: 499 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      PairClient.connect({ ...base, startupDeadlineMs: Number.NaN }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      PairClient.connect({ ...base, startupDeadlineMs: PAIR_STARTUP_DEADLINE_MAX_MS + 1 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      PairClient.connect({ ...base, startupDeadlineMs: Number.POSITIVE_INFINITY }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      PairClient.connect({ ...base, backoffMaxMs: PAIR_STARTUP_DEADLINE_MAX_MS + 1 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      PairClient.connect({ ...base, backoffMs: PAIR_STARTUP_DEADLINE_MAX_MS + 1 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      PairClient.connect({ ...base, backoffMaxMs: Number.POSITIVE_INFINITY }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      PairClient.connect({ ...base, helloTimeoutMs: Number.POSITIVE_INFINITY }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      PairClient.connect({
        ...base,
        helloTimeoutMs: PAIR_STARTUP_DEADLINE_MAX_MS + 1,
        startupDeadlineMs: PAIR_STARTUP_DEADLINE_MAX_MS + 1,
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('register 的名稱過不了橋就丟 PairProtocolError，不連', async () => {
    const rig = composition();
    await rig.listen();
    await expect(
      PairClient.connect(rig.options({ register: { tools: ['\uD800'], hooks: [] } })),
    ).rejects.toBeInstanceOf(PairProtocolError);
    await spin();
    expect(rig.conns).toHaveLength(0);
  });
});

describe('握手與四種結局', () => {
  it('第一框送 hello，收到 hello 才送 register，連上之後沒有計時器', async () => {
    const rig = composition();
    const { client, conn } = await rig.connected({ register: { tools: ['t'], hooks: ['h'] } });
    await until(() => conn.frames.length === 2, 'hello 與 register');
    expect(conn.frames).toEqual([HELLO, { type: 'register', tools: ['t'], hooks: ['h'] }]);
    expect(rig.retries).toEqual([]);
    expect(rig.clock.pending).toBe(0);
    client.close();
    await expect(client.closed).resolves.toMatchObject({ kind: 'local' });
  });

  it('組合行程還沒回 hello 之前，葉子只送了 hello', async () => {
    const rig = composition();
    rig.onConn = (conn) => {
      conn.read();
    };
    await rig.listen();
    const outcome = track(PairClient.connect(rig.options({ register: { tools: [], hooks: [] } })));
    await until(() => rig.conns[0]?.frames.length === 1, 'hello');
    await spin();
    expect(rig.conns[0]?.frames).toEqual([HELLO]);
    expect(outcome.settled).toBe(false);
    rig.conns[0]?.send(HELLO);
    await until(() => outcome.settled, '連上');
    await until(() => rig.conns[0]?.frames.length === 2, 'register');
  }, 60_000);

  it('沒人 listen：每次都連不上，到啟動時限回報「對方不在」，說明從頭到尾沒連上', async () => {
    const rig = composition();
    const { failure } = await rig.run();
    expect(failure).toMatchObject({
      kind: 'absent',
      connects: 0,
      retryLater: 0,
      closedBeforeFrame: 0,
      unanswered: 0,
      cutShort: 0,
    });
    // 0、250、750、1750、3750、5750、7750、9750 各連一次；再等 2000 就過 10000，不等了。
    expect(failure?.attempts).toBe(8);
    expect(failure?.elapsedMs).toBe(9_750);
    expect(rig.retries.map((retry) => retry.waitMs)).toEqual([
      250, 500, 1_000, 2_000, 2_000, 2_000, 2_000,
    ]);
    expect(rig.retries.every((retry) => retry.outcome === 'unreachable')).toBe(true);
    const message = new PairConnectError(failure as PairConnectFailure).message;
    expect(message).toContain('從頭到尾沒連上');
    expect(message).not.toContain('連上過');
  });

  it('每次都被要求稍後再試：退避不短於下限，到啟動時限回報「一直被要求稍後再試」，帶次數、經過多久與最後的理由', async () => {
    const rig = composition();
    rig.onConn = (conn, index) => {
      conn.read();
      conn.send(rejected('retry_later', `還沒有葉子的 pid（第 ${String(index + 1)} 次）`));
      conn.socket.end();
    };
    await rig.listen();
    const { failure } = await rig.run();
    expect(failure).toMatchObject({
      kind: 'retry_later',
      attempts: 8,
      connects: 8,
      retryLater: 8,
      elapsedMs: 9_750,
      lastReason: '還沒有葉子的 pid（第 8 次）',
    });
    const times = rig.conns.map((conn) => conn.at);
    expect(times).toEqual([0, 250, 750, 1_750, 3_750, 5_750, 7_750, 9_750]);
    for (let index = 1; index < times.length; index += 1) {
      expect((times[index] ?? 0) - (times[index - 1] ?? 0)).toBeGreaterThanOrEqual(
        PAIR_RETRY_BACKOFF_MIN_MS,
      );
    }
    // 過了啟動時限不再連。
    rig.clock.advance(60_000);
    await spin();
    expect(rig.conns).toHaveLength(8);
    expect(rig.clock.pending).toBe(0);
  }, 60_000);

  it('版本不對：被拒，帶 code 與 reason，不重試', async () => {
    const rig = composition();
    rig.onConn = (conn) => {
      conn.read();
      conn.send(rejected('version', '版本不對'));
      conn.socket.end();
    };
    await rig.listen();
    const { failure } = await rig.run();
    expect(failure).toMatchObject({
      kind: 'rejected',
      code: 'version',
      reason: '版本不對',
      attempts: 1,
    });
    expect(rig.retries).toEqual([]);
    expect(rig.clock.pending).toBe(0);
  });

  it.each(['identity', 'protocol'] as const)('%s：被拒，不重試', async (code) => {
    const rig = composition();
    rig.onConn = (conn) => {
      conn.send(rejected(code, '不收'));
      conn.socket.end();
    };
    await rig.listen();
    const { failure } = await rig.run();
    expect(failure).toMatchObject({ kind: 'rejected', code, attempts: 1 });
  });

  it('code 不認得的 rejected：照被拒回報，code 是 undefined，不重試', async () => {
    const rig = composition();
    rig.onConn = (conn) => {
      conn.sendJson('{"type":"rejected","code":"come_back_tomorrow","reason":"新版的理由"}');
      conn.socket.end();
    };
    await rig.listen();
    const { failure } = await rig.run();
    expect(failure).toMatchObject({ kind: 'rejected', reason: '新版的理由', attempts: 1 });
    expect(failure?.kind === 'rejected' && failure.code).toBeUndefined();
  });

  it('code 認得、別的欄位不合的 rejected 照 code 判：retry_later 多了欄位照樣重連', async () => {
    const rig = composition();
    rig.onConn = (conn) => {
      conn.sendJson('{"type":"rejected","code":"retry_later","reason":"等一下","until":5}');
      conn.socket.end();
    };
    await rig.listen();
    const { failure } = await rig.run();
    expect(failure).toMatchObject({ kind: 'retry_later', lastReason: '等一下' });
    expect(failure?.attempts).toBeGreaterThan(1);
    expect(failure?.retryLater).toBe(failure?.attempts);
  });

  it('code 認得、reason 不是字串的 rejected 照 code 判：identity 不重試，reason 是空的', async () => {
    const rig = composition();
    rig.onConn = (conn) => {
      conn.sendJson('{"type":"rejected","code":"identity","reason":7}');
      conn.socket.end();
    };
    await rig.listen();
    const { failure } = await rig.run();
    expect(failure).toMatchObject({ kind: 'rejected', code: 'identity', reason: '', attempts: 1 });
  });

  it.each([
    ['只有 type', '{"type":"rejected"}'],
    ['只有 reason', '{"type":"rejected","reason":"token 不對"}'],
    ['code 不是字串', '{"type":"rejected","code":3,"reason":"x"}'],
  ])(
    '沒有 code 或 code 不是字串的 rejected（%s）：不當成被拒，算違反協定，不重試',
    async (_name, json) => {
      const rig = composition();
      rig.onConn = (conn) => {
        conn.sendJson(json);
        conn.socket.end();
      };
      await rig.listen();
      const { failure } = await rig.run();
      expect(failure).toMatchObject({ kind: 'violation', attempts: 1 });
      expect(rig.retries).toEqual([]);
    },
  );

  it('組合行程給的 reason 截到 1024 個單位、控制字元與落單的代理對換掉，才進回報、訊息與 onRetry', async () => {
    // 第 1024 個單位落在一個代理對中間：截完剩下的那一半也換掉。
    const long = `第一行\n第二行\u0000\u001B[31m\u2028${'長'.repeat(1_009)}😀${'尾'.repeat(100)}`;
    const longClean = `第一行\uFFFD第二行\uFFFD\uFFFD[31m\uFFFD${'長'.repeat(1_009)}\uFFFD`;
    const rig = composition();
    rig.onConn = (conn, index) => {
      if (index === 0) conn.send(rejected('retry_later', long));
      else conn.sendJson('{"type":"rejected","code":"identity","reason":"壞\\ud800字","more":1}');
      conn.socket.end();
    };
    await rig.listen();
    const outcome = track(PairClient.connect(rig.options()));
    await until(() => rig.retries.length === 1, '第一次被要求稍後再試');
    expect(longClean).toHaveLength(1024);
    expect(rig.retries[0]?.detail).toBe(longClean);
    rig.clock.advance(rig.retries[0]?.waitMs ?? 0);
    await until(() => outcome.settled, '被拒');
    const error = outcome.error;
    expect(error).toBeInstanceOf(PairConnectError);
    expect(error instanceof PairConnectError && error.failure).toMatchObject({
      kind: 'rejected',
      code: 'identity',
      reason: '壞\uFFFD字',
    });
    expect(error?.message).toBe('被拒（identity）：壞\uFFFD字');
  });

  it('對方不在、一直被要求稍後再試、被拒是三個不同的 kind', async () => {
    const absent = composition();
    const retrying = composition();
    retrying.onConn = (conn) => {
      conn.send(rejected('retry_later', '等一下'));
      conn.socket.end();
    };
    await retrying.listen();
    const refused = composition();
    refused.onConn = (conn) => {
      conn.send(rejected('identity', '身分不對'));
      conn.socket.end();
    };
    await refused.listen();
    const kinds = [
      (await absent.run()).failure?.kind,
      (await retrying.run()).failure?.kind,
      (await refused.run()).failure?.kind,
    ];
    expect(kinds).toEqual(['absent', 'retry_later', 'rejected']);
  });

  it('組合行程沒讀 hello 就回 retry_later 並關：照 retry_later 重連，不當對方不在', async () => {
    const rig = composition();
    rig.onConn = (conn, index) => {
      if (index === 0) {
        // 收下的當下就寫完並關掉：葉子這時還沒寫 `hello`。
        conn.socket.write(
          frame(encodePairMessage(rejected('retry_later', '等著驗身分的連線太多'))),
        );
        conn.socket.destroy();
      } else {
        conn.greet();
      }
    };
    await rig.listen();
    const { client } = await rig.run();
    expect(client).toBeInstanceOf(PairClient);
    expect(rig.retries).toEqual([
      { attempt: 1, outcome: 'retry_later', detail: '等著驗身分的連線太多', waitMs: 250 },
    ]);
  });

  it('葉子比 listen 早：連不上先重試，組合行程起來之後就進去', async () => {
    const rig = composition();
    const outcome = track(PairClient.connect(rig.options()));
    await until(() => rig.retries.length === 1, '第一次連不上');
    expect(rig.retries[0]).toMatchObject({ attempt: 1, outcome: 'unreachable', waitMs: 250 });
    await rig.listen();
    rig.clock.advance(250);
    await until(() => outcome.settled, '連上');
    expect(outcome.value).toBeInstanceOf(PairClient);
    expect(rig.conns[0]?.at).toBe(250);
  });

  it('connect 成功、沒收到任何框就被關：重試到啟動時限，回報「對方不在」但帶連上過幾次', async () => {
    const rig = composition();
    rig.onConn = (conn) => {
      conn.socket.destroy();
    };
    await rig.listen();
    const { failure } = await rig.run();
    expect(failure).toMatchObject({
      kind: 'absent',
      attempts: 8,
      connects: 8,
      closedBeforeFrame: 8,
      unanswered: 0,
    });
    expect(rig.retries.every((retry) => retry.outcome === 'dropped')).toBe(true);
    const message = new PairConnectError(failure as PairConnectFailure).message;
    expect(message).toContain('連上過 8 次，0 次被要求稍後再試、8 次在收到任何框之前被關');
    expect(message).not.toContain('從頭到尾沒連上');
  });

  it('只收到半框就被關：一樣算沒收到任何框', async () => {
    const rig = composition();
    rig.onConn = (conn) => {
      conn.socket.end(frame(encodePairMessage(HELLO)).subarray(0, 6));
    };
    await rig.listen();
    const { failure } = await rig.run();
    expect(failure).toMatchObject({ kind: 'absent', closedBeforeFrame: 8 });
  });

  it('連上了但沒人理：每一條等滿 hello 的時限再重連，最後一條被啟動時限截斷', async () => {
    const rig = composition();
    rig.onConn = (conn) => {
      conn.read();
    };
    await rig.listen();
    const outcome = track(PairClient.connect(rig.options({ startupDeadlineMs: 12_000 })));
    await until(() => rig.conns[0]?.frames.length === 1, '第一條的 hello');
    rig.clock.advance(PAIR_HELLO_TIMEOUT_MS - 1);
    await spin();
    expect(rig.retries).toEqual([]);
    rig.clock.advance(1);
    await until(() => rig.retries.length === 1, '第一條逾時');
    expect(rig.retries[0]).toMatchObject({ outcome: 'unanswered', waitMs: 250 });
    await until(() => rig.conns[0]?.closed === true, '第一條被葉子關掉');
    rig.clock.advance(250);
    await until(() => rig.conns[1]?.frames.length === 1, '第二條的 hello');
    rig.clock.advance(PAIR_HELLO_TIMEOUT_MS);
    await until(() => rig.retries.length === 2, '第二條逾時');
    rig.clock.advance(500);
    await until(() => rig.conns[2]?.frames.length === 1, '第三條的 hello');
    // 第三條在 10750 連上，離啟動時限只剩 1250：等到 12000 就回報，這一次不算等滿。
    rig.clock.advance(1_249);
    await spin();
    expect(outcome.settled).toBe(false);
    rig.clock.advance(1);
    await until(() => outcome.settled, '回報');
    expect((outcome.error as PairConnectError).failure).toMatchObject({
      kind: 'absent',
      attempts: 3,
      connects: 3,
      unanswered: 2,
      cutShort: 1,
      closedBeforeFrame: 0,
      elapsedMs: 12_000,
      lastError: '等滿時限沒有回覆',
    });
    expect(rig.clock.pending).toBe(0);
  }, 120_000);

  it('被啟動時限截斷的那一次不改結局：之前都是 retry_later 就回報「一直被要求稍後再試」', async () => {
    const rig = composition();
    rig.onConn = (conn, index) => {
      conn.read();
      if (index < 2) {
        conn.send(rejected('retry_later', 'pid 不對'));
        conn.socket.end();
      }
    };
    await rig.listen();
    const outcome = track(
      PairClient.connect(rig.options({ startupDeadlineMs: PAIR_HELLO_TIMEOUT_MS })),
    );
    await until(() => rig.retries.length === 1, '第一次 retry_later');
    rig.clock.advance(250);
    await until(() => rig.retries.length === 2, '第二次 retry_later');
    rig.clock.advance(500);
    await until(() => rig.conns[2]?.frames.length === 1, '第三條的 hello');
    rig.clock.advance(PAIR_HELLO_TIMEOUT_MS - 750);
    await until(() => outcome.settled, '回報');
    expect((outcome.error as PairConnectError).failure).toMatchObject({
      kind: 'retry_later',
      attempts: 3,
      retryLater: 2,
      cutShort: 1,
      lastReason: 'pid 不對',
      elapsedMs: PAIR_HELLO_TIMEOUT_MS,
    });
  });

  it.each([
    ['hello 之前送別種框', '{"type":"cancel","side":"m","id":0}'],
    ['hello 的版本跟這邊不同', '{"type":"hello","version":2}'],
    ['解不開的框', '{"type":"hello"'],
    ['不認得的種類', '{"type":"welcome"}'],
  ])('組合行程在驗過之前違反協定（%s）：關連線，不重試', async (_name, json) => {
    const rig = composition();
    rig.onConn = (conn) => {
      conn.onHello = () => {
        conn.sendJson(json);
      };
      conn.read();
    };
    await rig.listen();
    const { failure } = await rig.run();
    expect(failure).toMatchObject({ kind: 'violation', attempts: 1 });
    await until(() => rig.conns[0]?.closed === true, '葉子關連線');
    expect(rig.conns[0]?.frames).toEqual([HELLO]);
    expect(rig.retries).toEqual([]);
  });

  it('葉子還沒送 hello 組合行程就送 hello：違反協定，不當成驗過', async () => {
    const rig = composition();
    rig.onConn = (conn) => {
      conn.send(HELLO);
    };
    await rig.listen();
    const { failure } = await rig.run();
    expect(failure).toMatchObject({ kind: 'violation', attempts: 1 });
  });

  it('第一框的長度超過上限：違反協定', async () => {
    const rig = composition();
    rig.onConn = (conn) => {
      const head = Buffer.alloc(4);
      head.writeUInt32LE(PAIR_MAX_FRAME + 1);
      conn.socket.write(head);
    };
    await rig.listen();
    const { failure } = await rig.run();
    expect(failure).toMatchObject({ kind: 'violation', attempts: 1 });
  });

  it('hello 與後面的框同一塊到：後面的框照樣處理', async () => {
    const rig = composition();
    rig.onConn = (conn) => {
      conn.greet(false, {
        type: 'call',
        side: 'm',
        id: 0,
        parent: null,
        method: 'echo',
        payload: 'hi',
      });
    };
    const { conn } = await rig.connected({ methods: { echo: (payload) => payload } });
    await until(() => conn.of('result').length === 1, 'result');
    expect(conn.of('result')).toEqual([{ type: 'result', side: 'm', id: 0, ok: 'hi' }]);
  });
});

describe('自己發的呼叫', () => {
  it('送 call，塊照順序交給 onChunk，result 的 ok 是回傳值', async () => {
    const rig = composition();
    const { client, conn } = await rig.connected();
    const chunks: string[] = [];
    const call = client.call(
      'echo',
      { a: 1 },
      {
        onChunk: (text) => {
          chunks.push(text);
        },
      },
    );
    await until(() => conn.of('call').length === 1, 'call');
    expect(conn.of('call')).toEqual([
      { type: 'call', side: 'l', id: 0, parent: null, method: 'echo', payload: { a: 1 } },
    ]);
    conn.send(
      { type: 'chunk', side: 'l', id: 0, seq: 0, payload: '一' },
      { type: 'chunk', side: 'l', id: 0, seq: 1, payload: '二' },
      { type: 'result', side: 'l', id: 0, ok: { done: true } },
    );
    await expect(call).resolves.toEqual({ done: true });
    expect(chunks).toEqual(['一', '二']);
    expect(rig.clock.pending).toBe(0);
  });

  it('組合行程回錯：以 PairCallError 結算，帶它的 code', async () => {
    const rig = composition();
    const { client, conn } = await rig.connected();
    const call = client.call('nope', null);
    await until(() => conn.of('call').length === 1, 'call');
    conn.send({
      type: 'result',
      side: 'l',
      id: 0,
      error: { code: 'unknown_method', message: 'nope' },
    });
    const error = await call.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PairCallError);
    expect(error).toMatchObject({ code: 'unknown_method', message: 'nope' });
  });

  it('parent 帶外層那一次；外層是組合行程發來的也可以', async () => {
    const rig = composition();
    let inner: Promise<Json> | undefined;
    const { client, conn } = await rig.connected({
      methods: {
        outer: async (_payload, context) => {
          inner = client.call('inner', null, { parent: context.ref });
          return inner;
        },
      },
    });
    conn.send({ type: 'call', side: 'm', id: 7, parent: null, method: 'outer', payload: null });
    await until(() => conn.of('call').length === 1, '內層的 call');
    expect(conn.of('call')[0]).toMatchObject({ side: 'l', parent: { id: 7, side: 'm' } });
    conn.send({ type: 'result', side: 'l', id: 0, ok: 'in' });
    await until(() => conn.of('result').length === 1, '外層的 result');
    expect(conn.of('result')).toEqual([{ type: 'result', side: 'm', id: 7, ok: 'in' }]);
  });

  it('取消：以 cancelled 結算並送 cancel；晚到的 result 丟掉，連線不動', async () => {
    const rig = composition();
    const { client, conn } = await rig.connected();
    const abort = new AbortController();
    const call = client.call('slow', null, { signal: abort.signal });
    await until(() => conn.of('call').length === 1, 'call');
    abort.abort();
    await expect(call).rejects.toMatchObject({ name: 'PairCallError', code: 'cancelled' });
    await until(() => conn.of('cancel').length === 1, 'cancel');
    expect(conn.of('cancel')).toEqual([{ type: 'cancel', side: 'l', id: 0 }]);
    conn.send({ type: 'result', side: 'l', id: 0, error: { code: 'cancelled', message: '' } });
    const next = client.call('echo', 1);
    await until(() => conn.of('call').length === 2, '下一個 call');
    conn.send({ type: 'result', side: 'l', id: 1, ok: 1 });
    await expect(next).resolves.toBe(1);
  });

  it('送出之前就中止：不送', async () => {
    const rig = composition();
    const { client, conn } = await rig.connected();
    await expect(client.call('echo', null, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: 'cancelled',
    });
    const next = client.call('echo', 2);
    await until(() => conn.of('call').length === 1, 'call');
    expect(conn.of('call')[0]).toMatchObject({ id: 0, payload: 2 });
    conn.send({ type: 'result', side: 'l', id: 0, ok: 2 });
    await next;
  });

  it('onChunk 丟錯：呼叫以那個錯結算並送 cancel', async () => {
    const rig = composition();
    const { client, conn } = await rig.connected();
    const boom = new Error('不要了');
    const call = client.call('stream', null, {
      onChunk: () => {
        throw boom;
      },
    });
    await until(() => conn.of('call').length === 1, 'call');
    conn.send({ type: 'chunk', side: 'l', id: 0, seq: 0, payload: 'x' });
    await expect(call).rejects.toBe(boom);
    await until(() => conn.of('cancel').length === 1, 'cancel');
  });

  it('同時最多 MAX_CALLS 個，再來的丟 busy，沒送出去', async () => {
    const rig = composition();
    const { client, conn } = await rig.connected();
    const calls = Array.from({ length: PAIR_MAX_CALLS }, (_, index) =>
      track(client.call('hold', index)),
    );
    await expect(client.call('hold', 'extra')).rejects.toMatchObject({
      name: 'PairSendError',
      reason: 'busy',
    });
    await until(() => conn.of('call').length === PAIR_MAX_CALLS, '64 個 call');
    conn.send({ type: 'result', side: 'l', id: 0, ok: null });
    await until(() => calls[0]?.settled === true, '第一個結束');
    const again = client.call('hold', 'again');
    await until(() => conn.of('call').length === PAIR_MAX_CALLS + 1, '補上的 call');
    expect(conn.of('call').at(-1)).toMatchObject({ id: PAIR_MAX_CALLS, payload: 'again' });
    client.close();
    await expect(again).rejects.toBeInstanceOf(PairPeerGoneError);
  });

  it('parent 不在跑、call 超過一框、payload 過不了橋：都沒送出去，也不佔編號', async () => {
    const rig = composition();
    const { client, conn } = await rig.connected();
    await expect(client.call('x', null, { parent: { id: 9, side: 'm' } })).rejects.toMatchObject({
      reason: 'bad_parent',
    });
    await expect(client.call('x', 'a'.repeat(PAIR_MAX_FRAME))).rejects.toMatchObject({
      name: 'PairSendError',
      reason: 'too_large',
    });
    await expect(client.call('x', Number.NaN)).rejects.toBeInstanceOf(PairProtocolError);
    const call = client.call('x', null);
    await until(() => conn.of('call').length === 1, 'call');
    expect(conn.of('call')[0]).toMatchObject({ id: 0 });
    conn.send({ type: 'result', side: 'l', id: 0, ok: null });
    await call;
  });
});

describe('組合行程發來的呼叫', () => {
  const call = (id: number, method: string, payload: Json = null): PairMessage => ({
    type: 'call',
    side: 'm',
    id,
    parent: null,
    method,
    payload,
  });

  it('照 method 找處理函式，塊與結果照順序回', async () => {
    const rig = composition();
    const { conn } = await rig.connected({
      methods: {
        stream: async (payload, context) => {
          await context.chunk('a');
          await context.chunk('b');
          return { echoed: payload };
        },
      },
    });
    conn.send(call(3, 'stream', 'in'));
    await until(() => conn.of('result').length === 1, 'result');
    expect(conn.frames.slice(1)).toEqual([
      { type: 'chunk', side: 'm', id: 3, seq: 0, payload: 'a' },
      { type: 'chunk', side: 'm', id: 3, seq: 1, payload: 'b' },
      { type: 'result', side: 'm', id: 3, ok: { echoed: 'in' } },
    ]);
  });

  it('沒有 await 的塊也排在結果之前', async () => {
    const rig = composition();
    const { conn } = await rig.connected({
      methods: {
        stream: (_payload, context) => {
          void context.chunk('a');
          void context.chunk('b');
          return 'done';
        },
      },
    });
    conn.send(call(0, 'stream'));
    await until(() => conn.of('result').length === 1, 'result');
    expect(conn.frames.slice(1).map((message) => message.type)).toEqual([
      'chunk',
      'chunk',
      'result',
    ]);
  });

  it('不認得的 method 回 unknown_method，訊息是名稱的前幾個位元組（切在字元邊界）；原型上的名字不算', async () => {
    const rig = composition();
    const { conn } = await rig.connected({ methods: {} });
    const long = '橋'.repeat(40);
    conn.send(call(0, long), call(1, 'constructor'), call(2, 'toString'));
    await until(() => conn.of('result').length === 3, 'result');
    const echo = '橋'.repeat(Math.floor(PAIR_METHOD_ECHO_BYTES / 3));
    expect(conn.of('result')).toEqual([
      { type: 'result', side: 'm', id: 0, error: { code: 'unknown_method', message: echo } },
      {
        type: 'result',
        side: 'm',
        id: 1,
        error: { code: 'unknown_method', message: 'constructor' },
      },
      { type: 'result', side: 'm', id: 2, error: { code: 'unknown_method', message: 'toString' } },
    ]);
  });

  it('parent 不在跑回 bad_payload', async () => {
    const rig = composition();
    const { conn } = await rig.connected({ methods: { echo: (payload) => payload } });
    conn.send({ ...call(0, 'echo'), parent: { id: 5, side: 'l' } } as PairMessage);
    await until(() => conn.of('result').length === 1, 'result');
    expect(conn.of('result')[0]).toMatchObject({ id: 0, error: { code: 'bad_payload' } });
  });

  it('處理函式丟 PairCallError 回它的 code，丟別的回 service_error；訊息太長或有落單的代理對也回得出去', async () => {
    const rig = composition();
    const { conn } = await rig.connected({
      methods: {
        refuse: () => {
          throw new PairCallError('bad_payload', '少了 threadId');
        },
        crash: () => {
          throw new Error('炸了');
        },
        noisy: () => {
          throw new Error(`\uD800${'x'.repeat(PAIR_MAX_FRAME * 2)}`);
        },
      },
    });
    conn.send(call(0, 'refuse'), call(1, 'crash'), call(2, 'noisy'));
    await until(() => conn.of('result').length === 3, 'result');
    const results = conn.of('result');
    expect(results[0]).toEqual({
      type: 'result',
      side: 'm',
      id: 0,
      error: { code: 'bad_payload', message: '少了 threadId' },
    });
    expect(results[1]).toMatchObject({ error: { code: 'service_error', message: '炸了' } });
    expect(results[2]).toMatchObject({ id: 2, error: { code: 'service_error' } });
    const noisy = results[2];
    expect(noisy !== undefined && 'error' in noisy && noisy.error.message.length).toBe(1_024);
  });

  it('結果超過一框回 too_large，過不了橋的回 service_error', async () => {
    const rig = composition();
    const { conn } = await rig.connected({
      methods: {
        big: () => 'a'.repeat(PAIR_MAX_FRAME),
        nan: () => Number.NaN,
      },
    });
    conn.send(call(0, 'big'), call(1, 'nan'));
    await until(() => conn.of('result').length === 2, 'result');
    expect(conn.of('result')[0]).toMatchObject({ id: 0, error: { code: 'too_large' } });
    expect(conn.of('result')[1]).toMatchObject({ id: 1, error: { code: 'service_error' } });
  });

  it('同時最多 MAX_CALLS 個，再來的回 busy；有一個結束就能再收', async () => {
    const rig = composition();
    const release: (() => void)[] = [];
    const { conn } = await rig.connected({
      methods: {
        hold: () =>
          new Promise<Json>((resolve) => {
            release.push(() => {
              resolve(null);
            });
          }),
      },
    });
    conn.send(...Array.from({ length: PAIR_MAX_CALLS + 1 }, (_, id) => call(id, 'hold')));
    await until(() => conn.of('result').length === 1, 'busy');
    expect(conn.of('result')).toEqual([
      {
        type: 'result',
        side: 'm',
        id: PAIR_MAX_CALLS,
        error: { code: 'busy', message: '同時在跑的呼叫已經到上限' },
      },
    ]);
    release[0]?.();
    await until(() => conn.of('result').length === 2, '第一個的 result');
    conn.send(call(PAIR_MAX_CALLS + 1, 'hold'));
    await until(() => release.length === PAIR_MAX_CALLS + 1, '補上的那一個開始跑');
  });

  it('組合行程取消：signal 中止、馬上回 cancelled；處理函式之後的塊與結果都不送', async () => {
    const rig = composition();
    let seen: PairCallContext | undefined;
    let finish: (value: Json) => void = () => undefined;
    const { client, conn } = await rig.connected({
      methods: {
        slow: (_payload, context) => {
          seen = context;
          return new Promise<Json>((resolve) => {
            finish = resolve;
          });
        },
        echo: (payload) => payload,
      },
    });
    conn.send(call(0, 'slow'));
    await until(() => seen !== undefined, '處理函式開始');
    conn.send({ type: 'cancel', side: 'm', id: 0 }, { type: 'cancel', side: 'm', id: 99 });
    await until(() => conn.of('result').length === 1, 'cancelled');
    expect(conn.of('result')).toEqual([
      { type: 'result', side: 'm', id: 0, error: { code: 'cancelled', message: '' } },
    ]);
    expect(seen?.signal.aborted).toBe(true);
    await expect(seen?.chunk('晚了')).rejects.toMatchObject({
      name: 'PairSendError',
      reason: 'not_running',
    });
    await expect(seen?.chunk('a'.repeat(PAIR_MAX_CHUNK_BYTES + 1))).rejects.toMatchObject({
      name: 'PairSendError',
      reason: 'not_running',
    });
    finish('晚了');
    conn.send(call(0, 'echo', '同一個編號可以再用'));
    await until(() => conn.of('result').length === 2, '下一個 result');
    expect(conn.of('result')[1]).toEqual({
      type: 'result',
      side: 'm',
      id: 0,
      ok: '同一個編號可以再用',
    });
    expect(conn.of('chunk')).toEqual([]);
    client.close();
  });

  it('一塊超過上限：不送，那一次以 too_large 收尾，之後的結果不送', async () => {
    const rig = composition();
    let thrown: unknown;
    let aborted = false;
    const { conn } = await rig.connected({
      methods: {
        stream: async (_payload, context) => {
          try {
            await context.chunk('a'.repeat(PAIR_MAX_CHUNK_BYTES + 1));
          } catch (error: unknown) {
            thrown = error;
          }
          aborted = context.signal.aborted;
          return 'ignored';
        },
        echo: (payload) => payload,
      },
    });
    conn.send(call(0, 'stream'), call(1, 'echo', 'after'));
    await until(() => conn.of('result').length === 2, 'result');
    expect(conn.of('result')).toEqual([
      { type: 'result', side: 'm', id: 0, error: { code: 'too_large', message: '一塊超過上限' } },
      { type: 'result', side: 'm', id: 1, ok: 'after' },
    ]);
    expect(thrown).toBeInstanceOf(PairSendError);
    expect(thrown).toMatchObject({ reason: 'too_large' });
    expect(aborted).toBe(true);
    expect(conn.of('chunk')).toEqual([]);
  });

  it('一塊有落單的代理對：丟 PairProtocolError、不送，下一塊的 seq 接得上', async () => {
    const rig = composition();
    let thrown: unknown;
    const { conn } = await rig.connected({
      methods: {
        stream: async (_payload, context) => {
          try {
            await context.chunk('\uD800');
          } catch (error: unknown) {
            thrown = error;
          }
          await context.chunk('好的');
          return 'done';
        },
      },
    });
    conn.send(call(0, 'stream'));
    await until(() => conn.of('result').length === 1, 'result');
    expect(thrown).toBeInstanceOf(PairProtocolError);
    expect(conn.of('chunk')).toEqual([
      { type: 'chunk', side: 'm', id: 0, seq: 0, payload: '好的' },
    ]);
    expect(conn.of('result')).toEqual([{ type: 'result', side: 'm', id: 0, ok: 'done' }]);
  });
});

describe('組合行程違反協定與斷線', () => {
  it.each<[string, (conn: Conn) => void]>([
    ['又送一次 hello', (conn) => conn.send(HELLO)],
    ['送 register', (conn) => conn.send({ type: 'register', tools: [], hooks: [] })],
    [
      'call 的 side 是葉子',
      (conn) =>
        conn.send({ type: 'call', side: 'l', id: 0, parent: null, method: 'hold', payload: null }),
    ],
    [
      '還在跑的 id 又發一次',
      (conn) =>
        conn.send(
          { type: 'call', side: 'm', id: 1, parent: null, method: 'hold', payload: null },
          { type: 'call', side: 'm', id: 1, parent: null, method: 'hold', payload: null },
        ),
    ],
    [
      'chunk 指到不在跑的呼叫',
      (conn) => conn.send({ type: 'chunk', side: 'l', id: 5, seq: 0, payload: '' }),
    ],
    [
      'chunk 的 seq 沒接上',
      (conn) => conn.send({ type: 'chunk', side: 'l', id: 0, seq: 1, payload: '' }),
    ],
    [
      'result 指到不在跑的呼叫',
      (conn) => conn.send({ type: 'result', side: 'l', id: 5, ok: null }),
    ],
    [
      'result 的 side 是組合行程',
      (conn) => conn.send({ type: 'result', side: 'm', id: 0, ok: null }),
    ],
    ['cancel 的 side 是葉子', (conn) => conn.send({ type: 'cancel', side: 'l', id: 0 })],
    ['解不開的框', (conn) => conn.sendJson('{"type":"result"}')],
    [
      '框長超過上限',
      (conn) => {
        const head = Buffer.alloc(4);
        head.writeUInt32LE(PAIR_MAX_FRAME + 1);
        conn.socket.write(head);
      },
    ],
  ])('%s：葉子直接關連線，不回 rejected', async (_name, violate) => {
    const rig = composition();
    const { client, conn } = await rig.connected({
      methods: { hold: () => new Promise<Json>(() => undefined) },
    });
    const mine = client.call('theirs', null);
    await until(() => conn.of('call').length === 1, 'call');
    violate(conn);
    await expect(client.closed).resolves.toMatchObject({ kind: 'violation' });
    await expect(mine).rejects.toBeInstanceOf(PairPeerGoneError);
    await until(() => conn.closed, '連線關了');
    expect(conn.of('rejected')).toEqual([]);
    expect(rig.clock.pending).toBe(0);
  });

  it('驗過之後收到 rejected：關連線，斷線的原因是 rejected，帶組合行程給的 code 與 reason', async () => {
    const rig = composition();
    const { client, conn } = await rig.connected();
    const mine = client.call('theirs', null);
    await until(() => conn.of('call').length === 1, 'call');
    conn.send(rejected('protocol', `seq 沒接上\n${'長'.repeat(2_000)}`));
    await expect(client.closed).resolves.toEqual({
      kind: 'rejected',
      code: 'protocol',
      detail: `seq 沒接上\uFFFD${'長'.repeat(2_000)}`.slice(0, 1024),
    });
    await expect(mine).rejects.toBeInstanceOf(PairPeerGoneError);
    await until(() => conn.closed, '連線關了');
    expect(rig.clock.pending).toBe(0);
  });

  it('組合行程關連線：自己發的收成 PairPeerGoneError、在服務的中止，之後不重連、送不出去', async () => {
    const rig = composition();
    let seen: PairCallContext | undefined;
    const { client, conn } = await rig.connected({
      methods: {
        hold: (_payload, context) => {
          seen = context;
          return new Promise<Json>(() => undefined);
        },
      },
    });
    const mine = client.call('theirs', null);
    conn.send({ type: 'call', side: 'm', id: 0, parent: null, method: 'hold', payload: null });
    await until(() => seen !== undefined && conn.of('call').length === 1, '兩個方向各一個在跑');
    conn.socket.destroy();
    await expect(client.closed).resolves.toMatchObject({ kind: 'closed' });
    const error = await mine.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PairPeerGoneError);
    expect(error).not.toBeInstanceOf(PairCallError);
    expect(seen?.signal.aborted).toBe(true);
    await expect(client.call('x', null)).rejects.toMatchObject({ reason: 'not_connected' });
    expect(() => {
      client.register([], []);
    }).toThrow(PairSendError);
    await expect(client.writable()).resolves.toBeUndefined();
    rig.clock.advance(600_000);
    await spin();
    expect(rig.conns).toHaveLength(1);
    expect(rig.clock.pending).toBe(0);
  }, 60_000);
});

describe('背壓與停滯', () => {
  /**
   * 組合行程不讀；葉子排到「過了暫停線」與「送端不再前進」同時成立為止。回排進去的呼叫。
   *
   * 排過暫停線之後對端 Node 的緩衝與 kernel 的 buffer 還會收走一些，收走多少看平台，排著的可能又降回線下；所以停下來之後還在線下就再排。
   * 排滿 {@link PAIR_MAX_CALLS} 個還停不在線上就丟錯。
   */
  async function fill(client: PairClient): Promise<Tracked<Json>[]> {
    const calls: Tracked<Json>[] = [];
    for (;;) {
      while (!client.paused && calls.length < PAIR_MAX_CALLS) {
        calls.push(track(client.call('sink', 'x'.repeat(200_000))));
      }
      await stuck(client);
      if (client.paused) return calls;
      if (calls.length === PAIR_MAX_CALLS) {
        throw new Error(`排滿了還是沒停在暫停線上：排著 ${String(client.queuedBytes)} 位元組`);
      }
    }
  }

  /** 等到送端不再前進：kernel 的 buffer 滿了，排著的位元組數不再變。 */
  async function stuck(client: PairClient): Promise<void> {
    let last = -1;
    let same = 0;
    await until(() => {
      same = client.queuedBytes === last ? same + 1 : 0;
      last = client.queuedBytes;
      return same >= 50;
    }, '送端不再前進');
  }

  it('過了暫停線：自己的 call 與 register 送不了，組合行程送來的照讀照回；降回去之後留著的塊與結果才送', async () => {
    const rig = composition();
    rig.onConn = (conn) => {
      conn.greet(true);
    };
    let entered = false;
    const { client, conn } = await rig.connected({
      methods: {
        stream: async (_payload, context) => {
          entered = true;
          await context.chunk('留著的塊');
          return '留著的結果';
        },
      },
    });
    const calls = await fill(client);
    expect(client.paused).toBe(true);
    expect(client.queuedBytes).toBeGreaterThanOrEqual(PAIR_OUTBOX_PAUSE_BYTES);
    await expect(client.call('sink', null)).rejects.toMatchObject({ reason: 'paused' });
    expect(() => {
      client.register([], []);
    }).toThrow(PairSendError);

    const before = client.queuedBytes;
    conn.send(
      { type: 'call', side: 'm', id: 0, parent: null, method: 'nope', payload: null },
      { type: 'call', side: 'm', id: 1, parent: null, method: 'stream', payload: null },
    );
    await until(() => entered, '暫停時照讀：處理函式開始了');
    // 自動回的 unknown_method 照排；處理函式的塊沒排進去。
    const reply = encodePairMessage({
      type: 'result',
      side: 'm',
      id: 0,
      error: { code: 'unknown_method', message: 'nope' },
    });
    await spin();
    expect(client.queuedBytes).toBe(before + reply.length + 4);
    const writable = track(client.writable());
    await Promise.resolve();
    expect(writable.settled).toBe(false);

    conn.read();
    await until(() => conn.of('result').length === 2, '兩個 result');
    expect(writable.settled).toBe(true);
    expect(client.paused).toBe(false);
    expect(conn.of('call')).toHaveLength(calls.length);
    expect(conn.of('chunk')).toEqual([
      { type: 'chunk', side: 'm', id: 1, seq: 0, payload: '留著的塊' },
    ]);
    expect(conn.of('result')).toEqual([
      { type: 'result', side: 'm', id: 0, error: { code: 'unknown_method', message: 'nope' } },
      { type: 'result', side: 'm', id: 1, ok: '留著的結果' },
    ]);
    await until(() => client.queuedBytes === 0, '排著的都寫完');
    expect(rig.clock.pending).toBe(0);
  }, 120_000);

  it('暫停時等著的幾個結果不會一起越過上限：降回去一次放一個，連線不斷', async () => {
    const rig = composition();
    rig.onConn = (conn) => {
      conn.greet(true);
    };
    let entered = 0;
    // 一個結果約 1 MB：降回線下時排著的至少還有 512 KiB − 64 KiB，兩個一起排進去就超過 2 MiB 而關連線，一次一個不會。
    const big = 'x'.repeat(1_000_000);
    const { client, conn } = await rig.connected({
      methods: {
        big: () => {
          entered += 1;
          return big;
        },
      },
    });
    await fill(client);
    conn.send(
      ...[0, 1, 2].map((id): PairMessage => ({
        type: 'call',
        side: 'm',
        id,
        parent: null,
        method: 'big',
        payload: null,
      })),
    );
    await until(() => entered === 3, '三個處理函式都跑完，結果等著');
    const closed = track(client.closed);
    conn.read();
    await until(() => conn.of('result').length === 3, '三個 result');
    expect(conn.of('result')).toEqual(
      [0, 1, 2].map((id) => ({ type: 'result', side: 'm', id, ok: big })),
    );
    expect(closed.settled).toBe(false);
    client.close();
  }, 120_000);

  it('組合行程一直不讀：照排的框再排就超過上限時關連線', async () => {
    const rig = composition();
    rig.onConn = (conn) => {
      conn.greet(true);
    };
    const { client, conn } = await rig.connected();
    const calls = await fill(client);
    const method = 'x'.repeat(PAIR_METHOD_ECHO_BYTES);
    const one = frame(
      encodePairMessage({ type: 'call', side: 'm', id: 0, parent: null, method, payload: null }),
    );
    const count = Math.ceil(PAIR_OUTBOX_LIMIT_BYTES / one.length) + 1;
    for (let at = 0; at < count; at += 1_000) {
      conn.send(
        ...Array.from({ length: Math.min(1_000, count - at) }, (_, index): PairMessage => ({
          type: 'call',
          side: 'm',
          id: at + index,
          parent: null,
          method,
          payload: null,
        })),
      );
    }
    await expect(client.closed).resolves.toMatchObject({ kind: 'overflow' });
    await until(() => calls.every((call) => call.settled), '排著的呼叫都結算');
    expect(calls.every((call) => call.error instanceof PairPeerGoneError)).toBe(true);
    expect(rig.clock.pending).toBe(0);
  }, 120_000);

  it('有東西排著、滿 STALL_TIMEOUT 沒寫出去：關連線；差 1 ms 還不關', async () => {
    const rig = composition();
    rig.onConn = (conn) => {
      conn.greet(true);
    };
    const { client } = await rig.connected();
    const calls = await fill(client);
    expect(rig.clock.pending).toBe(1);
    rig.clock.advance(PAIR_STALL_TIMEOUT_MS - 1);
    const closed = track(client.closed);
    await Promise.resolve();
    expect(closed.settled).toBe(false);
    rig.clock.advance(1);
    await expect(client.closed).resolves.toMatchObject({ kind: 'stalled' });
    await until(() => calls.every((call) => call.settled), '排著的呼叫都結算');
    expect(calls.every((call) => call.error instanceof PairPeerGoneError)).toBe(true);
    expect(rig.clock.pending).toBe(0);
  }, 120_000);

  it('寫得出去就重新起算：一直有進度的連線不會被當成停滯', async () => {
    const rig = composition();
    rig.onConn = (conn) => {
      conn.greet(true);
    };
    const { client, conn } = await rig.connected();
    await fill(client);
    rig.clock.advance(PAIR_STALL_TIMEOUT_MS - 1);
    conn.read();
    await until(() => client.queuedBytes === 0, '排著的都寫完');
    rig.clock.advance(PAIR_STALL_TIMEOUT_MS);
    const closed = track(client.closed);
    await Promise.resolve();
    expect(closed.settled).toBe(false);
    expect(rig.clock.pending).toBe(0);
  }, 120_000);

  it('寫出去一段、還有排著的：停滯從那一段寫完起算', async () => {
    const rig = composition();
    rig.onConn = (conn) => {
      conn.greet(true);
    };
    const { client, conn } = await rig.connected();
    await fill(client);
    const before = client.queuedBytes;
    rig.clock.advance(PAIR_STALL_TIMEOUT_MS - 1);
    // 對端不恢復讀取，只一份一份拿走 Node 緩衝裡的（Node 隨後再從 kernel 讀到 highWaterMark 就停），拿到葉子寫得出去就不拿了：
    // kernel 要空出多少葉子才寫得進去看平台，所以看的是葉子排著的有沒有變少，不是拿了幾份。
    let taken = 0;
    for (let round = 0; client.queuedBytes === before; round += 1) {
      if (round === 10_000) {
        throw new Error(`對端拿走 ${String(taken)} 位元組，葉子還是沒寫出去`);
      }
      const part = conn.socket.read() as Buffer | null;
      taken += part?.length ?? 0;
      await spin();
    }
    await stuck(client);
    expect(client.queuedBytes).toBeGreaterThan(0);
    expect(client.queuedBytes).toBeLessThan(before);
    rig.clock.advance(PAIR_STALL_TIMEOUT_MS - 1);
    const closed = track(client.closed);
    await Promise.resolve();
    expect(closed.settled).toBe(false);
    rig.clock.advance(1);
    await expect(client.closed).resolves.toMatchObject({ kind: 'stalled' });
  }, 120_000);
});

describe('探針', () => {
  it('pair-leaf-probe 只給測試起：src 裡沒有任何一支非測試的檔提到它，所以進不了 lib', () => {
    const dir = import.meta.dirname;
    const sources = readdirSync(dir).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'pair-leaf-probe.ts',
    );
    expect(sources).toContain('index.ts');
    expect(readdirSync(dir)).toContain('pair-leaf-probe.ts');
    for (const name of sources) {
      expect(readFileSync(join(dir, name), 'utf8'), name).not.toContain('pair-leaf-probe');
    }
  });

  it('package.json 的 exports 沒有逐字點名 pair-leaf-probe', () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { readonly exports: unknown };
    expect(JSON.stringify(manifest.exports)).not.toContain('pair-leaf-probe');
  });
});

describe('錯誤的名稱', () => {
  it('PairFrameTooLargeError 有自己的 name，仍然是 PairProtocolError', () => {
    const error = new PairFrameTooLargeError('太大');
    expect(error.name).toBe('PairFrameTooLargeError');
    expect(error).toBeInstanceOf(PairProtocolError);
    expect(new PairProtocolError('x').name).toBe('PairProtocolError');
  });
});
