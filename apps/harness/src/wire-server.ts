/**
 * 把 `(Request) => Response` 的 handler 接上一個真的 socket。
 *
 * **handler 與 listener 是分開的兩件事，這是刻意的**（當初照的是 dsh 的
 * `fetch/handler.ts` 與它的載體分層——那個套件在 HEAD `0a53fb55` 已經不在了，
 * 見 [`wire-handler.ts`](./wire-handler.ts) 的檔頭）：協定的行為在 handler 上驗得完，
 * 不必綁 port；這一層只負責把 `node:http` 的 stream 翻成 fetch 的那組型別，
 * 它自己的正確性靠一次真的 loopback 往返來釘。
 *
 * ## 下行的背壓、心跳與死線淘汰（[#1504](https://github.com/DemianLi/nexus-agent/issues/1504)）
 *
 * - **寫入等 drain**：`write` 回 `false` 且連線還沒毀，就等 `'drain'` 或 `'close'` 其中一個，照 dsh
 *   `packages/client/connection/src/http-bridge.ts:106-124`（`1517a4db`，與 `687f282e` 的 blob 相同）。沒有它，對方不收時
 *   Node 照樣把每一顆 frame 收進寫入緩衝，緩衝沒有上限。斷線之後照 dsh 把 body 讀完但不寫。
 * - **SSE 心跳與死線**：對應 dsh `packages/api/gateway/src/stream-server.ts`（`MAX_MISSED_HEARTBEATS = 2`、預設間隔 2000 ms）。
 *   一支共用、`unref()` 的計時器，第一條 SSE 開線時才起，`close()` 先清它。
 *
 * ### 偏離 A：心跳退成 SSE 註解行，死線判準退成「位元組卡著、連兩拍沒排出去」（理由 1：基座表達不出來）
 *
 * 我們的載體是已拍板的 SSE（`.docs/development-plan.md` 決策 6），HTTP/1.1 回應沒有 ping／pong 控制幀，對方無從回應，
 * 「漏了 pong」這個判準做不出來。退到最接近的：每拍寫 `: ping\n\n`（解碼端本來就跳過註解）；dsh 判準裡做得到的那一半是
 * 「排過隊之後才完成的寫入」＝ `'drain'`，另外**緩衝縮小也算活著**（對方有在收，只是慢）。只有寫入緩衝裡有位元組卡著
 * （`writableLength > 0`）、又沒有任何進展的那一拍算漏拍；閒著、緩衝是空的線不算漏拍，不然健康的閒置線兩拍就被殺。
 * **代價**：沒有 frame 在流、緩衝是空的死線，serve 判不出來——TCP 的對端是 sshd 不是使用者的機器，這一段要靠 sshd 的
 * `ClientAliveInterval` 收（`docs/operations.md`）。
 *
 * 另外兩條偏離（偏離 B：事件下行加位元組上限；偏離 C：超限或死線只斷線、不送終止 frame）登記在
 * [`bounded-event-queue.ts`](./bounded-event-queue.ts)；C 在這裡的落點是 `destroy()` 前只記一行 warn、不寫任何 frame。
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import type { WireHandler } from './wire-handler.js';
import { wireRequestBodyMode } from './wire-handler.js';

/**
 * 先收完整份的路由（JSON 路由）的本文上限：300 MiB，照 dsh `client/connection/src/http-bridge.ts` 的
 * `DEFAULT_MAX_REQUEST_BODY_BYTES`。**串流路由（今天只有上傳）不受這個上限管**——儲存配額由路由自己負責，
 * 這版不做（dsh 預設也沒有）。見 `docs/operations.md`。
 */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 300 * 1024 * 1024;

/** SSE 心跳間隔預設值（毫秒），照 dsh `websocketHeartbeatIntervalMs` 的預設。 */
export const DEFAULT_SSE_HEARTBEAT_INTERVAL_MS = 2_000;

/** 連續漏幾拍就淘汰，照 dsh `MAX_MISSED_HEARTBEATS`。協定常數，不開成設定。 */
export const MAX_MISSED_HEARTBEATS = 2;

/** `setInterval` 收得下的最大間隔（毫秒）；也是 dsh 設定範圍的上界。 */
export const MAX_SSE_HEARTBEAT_INTERVAL_MS = 2_147_483_647;

const SSE_PING = ': ping\n\n';

export interface WireServer {
  readonly url: string;
  close(): Promise<void>;
}

export interface StartWireServerOptions {
  readonly handler: WireHandler;
  /** 預設 0——由作業系統挑一個空的，測試因此可以平行跑。 */
  readonly port?: number;
  readonly host?: string;
  /** 先收完整份的路由的本文上限（位元組）。預設 {@link DEFAULT_MAX_REQUEST_BODY_BYTES}；超過回 413。串流路由不受管。 */
  readonly maxRequestBodyBytes?: number;
  /** 一個請求處理失敗時往哪裡講（見 {@link startWireServer} 的最後一道防線）。預設 `console.warn`。 */
  readonly warn?: (error: Error) => void;
  /**
   * SSE 心跳間隔（毫秒），預設 {@link DEFAULT_SSE_HEARTBEAT_INTERVAL_MS}。連續 {@link MAX_MISSED_HEARTBEATS} 拍緩衝卡著、
   * 沒有任何排出去的進展，就斷那一條線（#1504）。
   */
  readonly heartbeatIntervalMs?: number;
  /**
   * 一條下行因為卡住被斷開時往哪裡講（一行訊息，不含 thread 內容）。預設 `console.warn`。
   * **和 {@link StartWireServerOptions.warn} 分開**：那一個的呼叫端會把每則訊息包成「處理失敗，回 400」。
   */
  readonly warnDisconnect?: (message: string) => void;
}

/** 先收完整份的路由，本文超過上限。 */
class RequestBodyTooLarge extends Error {
  constructor(readonly limit: number) {
    super(`request body exceeds ${String(limit)} bytes`);
  }
}

interface ParsedRequest {
  readonly request: Request;
  readonly streaming: boolean;
}

async function toRequest(
  incoming: IncomingMessage,
  origin: string,
  maxBodyBytes: number,
): Promise<ParsedRequest> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === 'string') {
      headers.set(name, value);
    }
  }
  const method = incoming.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  // **只取路徑與 query**，照 dsh `packages/host/webserver/src/index.ts` 的 `new URL(req.url, 'http://x').pathname`：
  // 請求行可以是 absolute-form（`GET http://evil/threads HTTP/1.1`），直接接在 origin 後面會拼出一個
  // 解析不了的網址。它帶的 authority 不算數——信任看 `Host` 標頭（`request-trust.ts`）。
  const target = new URL(incoming.url ?? '/', 'http://x');
  const url = `${origin}${target.pathname}${target.search}`;
  if (!hasBody) return { request: new Request(url, { method, headers }), streaming: false };

  // **串流路由（上傳）不聚合**：位元組一路從 socket 流到路由手上，行程裡不留整份檔案。
  // 路由自己負責落地、取消與配額；這裡不套總量上限（照 dsh 的 `requestBodyMode: 'streaming'`）。
  if (wireRequestBodyMode(method, target.pathname) === 'streaming') {
    const body = Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>;
    return {
      request: new Request(url, { method, headers, body, duplex: 'half' } as RequestInit),
      streaming: true,
    };
  }

  // 先收完整份：宣告的長度就超過上限的，一個位元組都不讀；沒宣告（或說謊）的，累計超過就停。
  const declared = Number(incoming.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBodyBytes) {
    throw new RequestBodyTooLarge(maxBodyBytes);
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of incoming) {
    received += (chunk as Buffer).byteLength;
    if (received > maxBodyBytes) throw new RequestBodyTooLarge(maxBodyBytes);
    chunks.push(chunk as Buffer);
  }
  return {
    request: new Request(url, { method, headers, body: Buffer.concat(chunks) }),
    streaming: false,
  };
}

/** 一條還開著的 SSE 線，給心跳計時器看的。 */
export interface SseLine {
  readonly outgoing: ServerResponse;
  readonly path: string;
  /** 連續沒有進展的拍數。 */
  missed: number;
  /** 上一拍看到的 `writableLength`；縮小就是對方有在收。 */
  lastBuffered: number;
}

/** 一拍的裁決：寫心跳、什麼都不做、淘汰。 */
export type BeatVerdict = 'ping' | 'hold' | 'evict';

/**
 * 一拍裡判一條線（純函式，改的只有 `line` 的兩個計數）。
 *
 * - 寫入緩衝是空的：對方收得完，或線閒著——**不算漏拍**（不然健康的閒置線兩拍就被殺），寫心跳。
 * - 緩衝有位元組：比上一拍小＝對方有在收、只是慢，歸零；沒縮小才漏拍 +1。漏到 {@link MAX_MISSED_HEARTBEATS} 就淘汰。
 *   `'drain'` 的歸零在 {@link SseHeartbeat.watch}，不在這裡。
 */
export function judgeBeat(
  line: Pick<SseLine, 'missed' | 'lastBuffered'>,
  buffered: number,
): BeatVerdict {
  if (buffered === 0) {
    line.missed = 0;
    line.lastBuffered = 0;
    return 'ping';
  }
  line.missed = buffered < line.lastBuffered ? 0 : line.missed + 1;
  line.lastBuffered = buffered;
  return line.missed >= MAX_MISSED_HEARTBEATS ? 'evict' : 'hold';
}

/** 所有 SSE 線共用的那一支計時器，見檔頭。 */
export class SseHeartbeat {
  readonly #lines = new Set<SseLine>();
  readonly #intervalMs: number;
  readonly #warnDisconnect: (message: string) => void;
  #timer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(intervalMs: number, warnDisconnect: (message: string) => void) {
    this.#intervalMs = intervalMs;
    this.#warnDisconnect = warnDisconnect;
  }

  /** 開始盯一條 SSE 線；線關掉時自己放手。第一條開線才起計時器。 */
  watch(outgoing: ServerResponse, path: string): void {
    if (this.#closed) return;
    const line: SseLine = { outgoing, path, missed: 0, lastBuffered: 0 };
    this.#lines.add(line);
    // 任何一次 'drain' 都是「排過隊之後才完成的寫入」，對方有在收。
    const onDrain = () => {
      line.missed = 0;
    };
    outgoing.on('drain', onDrain);
    outgoing.once('close', () => {
      outgoing.off('drain', onDrain);
      this.#lines.delete(line);
    });
    if (this.#timer === undefined) {
      this.#timer = setInterval(() => this.#beat(), this.#intervalMs);
      this.#timer.unref();
    }
  }

  #beat(): void {
    for (const line of this.#lines) {
      const { outgoing } = line;
      if (outgoing.destroyed || outgoing.writableEnded) continue;
      const verdict = judgeBeat(line, outgoing.writableLength);
      // 寫在兩顆 frame 之間（每個 chunk 本來就是一整顆 frame）；卡著的線不再寫 ping，免得排進更多位元組。
      if (verdict === 'ping') outgoing.write(SSE_PING);
      // 在 setImmediate 裡再確認一次：同一個 tick 裡排著的 'drain' 先跑完，不誤殺剛好醒過來的線。
      else if (verdict === 'evict') setImmediate(() => this.#evict(line));
    }
  }

  #evict(line: SseLine): void {
    if (line.missed < MAX_MISSED_HEARTBEATS || line.outgoing.destroyed) return;
    this.#warnDisconnect(
      `[下行] 斷開卡住的串流 ${line.path}：${String(line.outgoing.writableLength)} 位元組在寫入緩衝裡，連 ${String(MAX_MISSED_HEARTBEATS)} 拍沒有排出去`,
    );
    // 走既有的 'close' 路徑：aborted.abort() → 訂閱者收掉。不另開一條收線的路。
    line.outgoing.destroy();
  }

  /** 先清計時器，再不盯任何線。 */
  close(): void {
    this.#closed = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#lines.clear();
  }
}

async function writeResponse(
  response: Response,
  outgoing: ServerResponse,
  heartbeat: SseHeartbeat,
  path: string,
): Promise<void> {
  const headers: Record<string, string | string[]> = Object.fromEntries(response.headers.entries());
  // `Headers` 逐顆列出 `set-cookie`，`fromEntries` 只會留最後一顆；照原樣交給 node:http 的陣列形式。
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length > 0) headers['set-cookie'] = setCookies;
  outgoing.writeHead(response.status, headers);
  if (response.body === null) {
    outgoing.end();
    return;
  }
  // **一定要現在就把 header 送出去。** 不然 Node 會等到第一顆 body chunk 才發，
  // 而下行的第一顆 frame 可能要等使用者先送出上行——兩邊互等就死鎖了。
  outgoing.flushHeaders();
  if (response.headers.get('content-type')?.startsWith('text/event-stream') === true) {
    heartbeat.watch(outgoing, path);
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      // 斷線之後照樣把 body 讀完（讓來源收得到結束），但不寫（dsh `http-bridge.ts:109`）。
      if (outgoing.destroyed) continue;
      // 每一顆 frame 立刻推出去；SSE 的重點就是不要在這裡積著。
      // **背壓**（照 dsh `http-bridge.ts:106-124`）：回 `false` 表示 socket 緩衝滿了，等 `'drain'`，不再往 heap 裡積。
      // 'close' 也算一個出口，斷線時迴圈才不會停在這裡。
      if (!outgoing.write(value) && !outgoing.destroyed) {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            outgoing.off('drain', done);
            outgoing.off('close', done);
            resolve();
          };
          outgoing.once('drain', done);
          outgoing.once('close', done);
        });
      }
    }
  } catch {
    // 對方先斷線是正常結束，不是錯誤。
  } finally {
    reader.releaseLock();
    outgoing.end();
  }
}

export async function startWireServer(options: StartWireServerOptions): Promise<WireServer> {
  const host = options.host ?? '127.0.0.1';
  const warn = options.warn ?? ((error: Error) => console.warn(error));
  const maxBodyBytes = options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
  const heartbeat = new SseHeartbeat(
    options.heartbeatIntervalMs ?? DEFAULT_SSE_HEARTBEAT_INTERVAL_MS,
    options.warnDisconnect ?? ((message: string) => console.warn(message)),
  );
  const handle = async (incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> => {
    const address = server.address() as AddressInfo;
    const origin = `http://${host}:${address.port}`;
    // 對方斷線就中止這個 request 的 signal——**中止的是這條線，不是 agent 的 run**。
    const aborted = new AbortController();
    // **這個 Request 要活到連線關掉。** `new Request(base, { signal })` 把來源 signal 的中止轉給自己的 signal，
    // 照 undici 的實作是一條弱參照（`WeakRef`），Request 被回收之後那條線就斷了。而 handler 常常只留 `request.signal`、
    // 不留 Request（`handleList(request.signal)`；下行的 `openFeed`／`openStream` 回完串流之後更是什麼都不抓），
    // 一次完整的垃圾回收落在「handler 回來」與「客戶端斷線」之間，之後客戶端斷線 handler 的 signal 就永遠不會中止（#983）。
    // 實測（`measure/subscriber-leak.ts`，每 25 毫秒強制一次完整回收）：修前真的 `stream`、`feed` 放棄 400 次漏 396–400 條
    // 訂閱，修後 0；不強制回收時只在行程跑了一陣子之後才偶爾漏。所以由 `close` 的回呼抓著它，關線時才放手。
    let live: Request | undefined;
    outgoing.on('close', () => {
      aborted.abort();
      live = undefined;
    });
    let parsed: ParsedRequest;
    try {
      parsed = await toRequest(incoming, origin, maxBodyBytes);
    } catch (error: unknown) {
      if (!(error instanceof RequestBodyTooLarge)) throw error;
      // 413：回完就斷線——對方可能還在傳一份我們不收的本文，留著這條連線只會讓它被拿去當下一個請求的開頭。
      outgoing.writeHead(413, { 'content-type': 'text/plain', connection: 'close' });
      outgoing.end('request body too large', () => incoming.destroy());
      return;
    }
    const { request, streaming } = parsed;
    // 只取路徑（不含 query），給斷線的 warn 用。
    const path = new URL(request.url).pathname;
    live = new Request(request, {
      signal: aborted.signal,
      ...(streaming ? { duplex: 'half' } : {}),
    } as RequestInit);
    const response = await options.handler.handle(live);
    if (streaming) {
      // 串流本文路由回應時本文可能還沒讀完（早退的 415、錯誤）：這條連線不能再當 keep-alive 用，
      // 回完就把沒讀完的請求端砍掉（照 dsh 的串流模式）。
      const headers = new Headers(response.headers);
      headers.set('connection', 'close');
      await writeResponse(
        new Response(response.body, { status: response.status, headers }),
        outgoing,
        heartbeat,
        path,
      );
      if (!incoming.readableEnded) {
        if (outgoing.writableFinished) incoming.destroy();
        else outgoing.once('finish', () => incoming.destroy());
      }
      return;
    }
    await writeResponse(response, outgoing, heartbeat, path);
  };
  // **最後一道防線**，照 dsh `packages/host/webserver/src/index.ts`（`ddefc45`）：一個請求的失敗只收在那個
  // 請求上——記一筆、回 400，已經送出標頭的就斷線。沒有這一層，`handle` 的 rejection 沒人接，Node 會讓
  // 整個行程退出：同機任何人送一個畸形的請求就能把 serve 打掉（#424 審查時實測過）。
  const server: Server = createServer((incoming, outgoing) => {
    void handle(incoming, outgoing).catch((error: unknown) => {
      warn(error instanceof Error ? error : new Error(String(error)));
      if (outgoing.headersSent) {
        outgoing.destroy();
        return;
      }
      outgoing.writeHead(400);
      outgoing.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    // listen 失敗（最常見的是 port 被佔住）會走 'error' 事件而不是 callback——
    // 不接的話它變成一個沒人處理的 error 事件，呼叫端只看到行程莫名其妙地死掉。
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://${host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        // 計時器先清（#1504）：之後 `closeAllConnections` 觸發的 'close' 都不會再碰到它。
        heartbeat.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
