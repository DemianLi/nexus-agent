/**
 * 前台的 wire handler（[#2341](https://github.com/DemianLi/nexus-agent/issues/2341)，設計 `.docs/supervisor-1947-design-2026-11-03.md` §三-3、§四）：
 * 包住前台自己那一支 `wire-handler.ts`，**指名一條 thread 的請求轉給那條的對話行程**，其餘在前台答。
 *
 * - **閘門在前台**：先過本地那支的 `admit`（信任圍欄、cookie），過了才 `ensure`、才轉送。驗出來的身分放進內部標頭往下傳
 *   （`forwarded-principal.ts`），客戶端帶來的同名標頭由轉送器刪掉。
 * - **嵌入版兩道檢查**：前台先用本地那支的 `embedRefusal` 擋（白名單、是不是嵌入版開的、是不是這個身分的，冷讀 header），
 *   對話行程收到之後照樣再核一次；那一道拒絕時帶回原因，`access` 稽核由前台記（對話行程沒有稽核檔）。
 * - **嵌入版的 thread 下行由前台登記**（#2489）：開線先記 `opened`，每 {@link EmbedStreamGuard.intervalMs} 拿開線時的標頭重驗一次，
 *   驗不過就切掉往對話行程的那條、記 `cut`；收掉記 `closed`。對話行程收不到 cookie，重驗只能在這裡做。
 * - **前台自己答的**：列表、搜尋、全域下行（不指名 thread）、`@` 的會話候選（冷讀磁碟，看不到還沒落盤的事件）；釘選與封存（整理檔只有前台一個寫的人）；`run.cancel` 在那條
 *   thread 沒有行程時（嵌入路由也一樣，本地答受理，同 single 取消一條沒在跑的）。評分一律轉送：它要寫那條 thread 的日誌，
 *   前台不載 thread，本地答只會是「還沒開過」。
 * - **打開方式**：開下行、讀歷史、附件、引用、變更的是 `read-only`，其餘（送指令、上傳）是 `run`。開著的下行讓對話行程不回報閒置；
 *   這條 thread 經前台的最後一條下行收掉時送 `release`（見 `countDownlink`）。只讀過歷史、沒開下行的照只讀的閒置時間收。
 *
 * @module
 */

import {
  errorResponse,
  isRunCancelMethod,
  isThreadManagementMethod,
  SERVER_CLOSING,
  SUBAGENT_SEND_METHOD,
  THREAD_AT_CAPACITY,
  type ThreadActivityKind,
} from '@nexus/wire';

import { randomUUID } from 'node:crypto';

import type { EmbedAccessRoute, StreamRecord } from './embed-audit.js';
import { IDENTITY_TABLE_STAT_INTERVAL_MS } from './embed-identities.js';
import { EMBED_ROUTE_KINDS, withoutEmbedPrefix } from './embed-profile.js';
import type { EmbedCookieRefusal } from './embed-session.js';
import {
  EMBED_REFUSED_HEADER,
  FRONT_CLOSING_HEADER,
  principalHeaders,
} from './forwarded-principal.js';
import type { FrontForwarder } from './front-forward.js';
import { StreamCutError } from './sse-response.js';
import type { EnsureOutcome, SupervisorClient } from './supervisor-client.js';
import type { OpenMode } from './supervisor-protocol.js';
import {
  internalThreadPath,
  parsePath,
  type EmbedStreamGuard,
  type IdleSweepingWireHandler,
  type WireAuth,
  type WireHandlerOptions,
} from './wire-handler.js';
import type { EmbedPrincipal, WirePrincipal } from './wire-principal.js';

type Route = NonNullable<ReturnType<typeof parsePath>>;

/** 用 `read-only` 打開的路由：監督行程給它較短的閒置時間（`--read-only-idle-ms`），名額滿時先逐出（設計 §7-3）。 */
const READ_ONLY_KINDS: ReadonlySet<Route['kind']> = new Set([
  'stream',
  'history',
  'subagent-history',
  'trajectory-turn',
  'file-references',
  'attachment',
  'changes-summary',
  'changes-diff',
]);

export interface FrontWireOptions {
  /** 前台自己那一支：閘門、列表、搜尋、全域下行、整理檔都在它身上。 */
  readonly local: IdleSweepingWireHandler;
  readonly supervisor: SupervisorClient;
  readonly forwarder: FrontForwarder;
  /** 前台的驗證（會話 cookie 與嵌入 cookie）；`admit` 過了之後拿它取身分往下傳。 */
  readonly auth: WireAuth;
  /** 同本地那支的 `embedStreams`；缺席就是沒有嵌入方，嵌入身分不會出現。 */
  readonly embedStreams?: EmbedStreamGuard;
  /** 轉送給一條 thread 的請求拿到了對話行程的回應（不論狀態碼；那條 thread 不一定已組裝，看路由）。前台拿它去問 plugin 綁定（`front-plugins.ts`）。 */
  readonly onForwarded?: (threadId: string) => void;
  readonly warn?: (message: string) => void;
  /** 分叉出來的子 thread 的 id；省略用 `randomUUID`（測試給固定的）。 */
  readonly newThreadId?: () => string;
}

/** 前台登記中的一條嵌入版下行。 */
interface ForwardedEmbedStream {
  readonly headers: Headers;
  cut(reason: EmbedCookieRefusal): void;
  /** 前台關機：記 `closed`（`server`），客戶端那頭以錯誤結束，斷掉往對話行程的那條。 */
  close(): void;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** 指令的 envelope id；讀不到是 `null`（錯誤回應照樣回得出去）。讀的是複本，原本那份還要轉送。 */
async function envelopeId(request: Request, route: Route): Promise<number | null> {
  if (route.kind !== 'command') return null;
  try {
    const body: unknown = await request.clone().json();
    const id = (body as { id?: unknown } | null)?.id;
    return typeof id === 'number' ? id : null;
  } catch {
    return null;
  }
}

/** 收尾中不收的那句；文案同本地那支（客戶端認碼，不認文案）。 */
function serverClosing(id: number | null): Response {
  return json(
    errorResponse(
      id,
      SERVER_CLOSING,
      'serve 正在收尾，這個請求沒有處理；等它重新起來再送一次（run.start 帶同一個 request_id）。',
    ),
  );
}

/** 轉送的錯是不是「socket 那頭沒有行程」：沒人在聽，或 socket 檔已經不在。 */
function processGone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ECONNREFUSED' || code === 'ENOENT';
}

function outcomeFailure(
  outcome: Exclude<EnsureOutcome, { type: 'up' }>,
  id: number | null,
  threadId: string,
): Response {
  if (outcome.type === 'capacity') {
    return json(
      errorResponse(
        id,
        THREAD_AT_CAPACITY,
        `同時開著的 thread 已達上限（${outcome.current}／${outcome.limit}），"${threadId}" 這次沒開起來；關掉閒置的或稍後再試。`,
      ),
    );
  }
  if (outcome.cause === 'shutdown') return serverClosing(id);
  return json(
    errorResponse(
      id,
      'unknown_error',
      `thread "${threadId}" 的對話行程沒起來（${outcome.cause}），原因記在監督行程的稽核檔。`,
    ),
  );
}

/**
 * 包成前台的 handler。`admit` 與其餘欄位照本地那一支，換掉 `handle`、`close`（先收轉送中的嵌入下行、補記 `closed`，再收本地那一支）與 `stopAdmission`（停准入之後轉送的請求帶 `FRONT_CLOSING_HEADER`）；
 * 轉送器由入口收。
 */
export function createFrontWireHandler(options: FrontWireOptions): IdleSweepingWireHandler {
  const { local, supervisor, forwarder, auth, embedStreams: guard } = options;
  const warn = options.warn ?? (() => {});
  const streams = new Set<ForwardedEmbedStream>();
  let scan: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let admissionStopped = false;
  /** 每條 thread 轉送中的下行有幾條；降到 0 就 `release`。 */
  const downlinks = new Map<string, number>();

  /**
   * 數這條下行：本文讀完、被取消或出錯時減一，這條 thread 一條都不剩就告訴監督行程可以先收。監督行程只收只讀開的，
   * 已經轉成一般的（收到過 `ensure(run)` 或 `turn(begin)`）照一般的閒置時間收。讀歷史不 `release`：監督行程會把它記到行程閒置為止，
   * 送了的話，只讀過歷史的那條一閒置就收，不留只讀的閒置時間。
   */
  function countDownlink(threadId: string, response: Response): Response {
    const source = response.body;
    if (source === null || response.status !== 200) return response;
    downlinks.set(threadId, (downlinks.get(threadId) ?? 0) + 1);
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      const left = (downlinks.get(threadId) ?? 1) - 1;
      if (left > 0) {
        downlinks.set(threadId, left);
        return;
      }
      downlinks.delete(threadId);
      supervisor.release(threadId);
    };
    const reader = source.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            finish();
            controller.close();
            return;
          }
          controller.enqueue(chunk.value);
        } catch (error) {
          finish();
          controller.error(error);
        }
      },
      async cancel(reason) {
        finish();
        await reader.cancel(reason);
      },
    });
    return new Response(body, { status: response.status, headers: response.headers });
  }

  function scanStreams(active: EmbedStreamGuard): void {
    const verdicts = new Map<string, ReturnType<EmbedStreamGuard['recheck']>>();
    for (const entry of [...streams]) {
      const key = `${entry.headers.get('host') ?? ''}\n${entry.headers.get('cookie') ?? ''}`;
      let verdict = verdicts.get(key);
      if (verdict === undefined) {
        verdict = active.recheck(entry.headers);
        verdicts.set(key, verdict);
      }
      if (!verdict.ok) entry.cut(verdict.reason);
    }
  }

  function register(entry: ForwardedEmbedStream, active: EmbedStreamGuard): void {
    streams.add(entry);
    if (scan === undefined) {
      scan = setInterval(() => {
        scanStreams(active);
      }, active.intervalMs ?? IDENTITY_TABLE_STAT_INTERVAL_MS);
      scan.unref();
    }
  }

  function unregister(entry: ForwardedEmbedStream): void {
    streams.delete(entry);
    if (streams.size === 0 && scan !== undefined) {
      clearInterval(scan);
      scan = undefined;
    }
  }

  async function recordAccess(
    principal: EmbedPrincipal,
    threadId: string,
    route: Route,
    reason: string,
  ): Promise<void> {
    if (guard === undefined) return;
    if (reason !== 'thread_not_owned' && reason !== 'not_embedded') return;
    try {
      const audit = guard.audit();
      if (audit === undefined) throw new Error('稽核紀錄還沒打開');
      await audit.recordAccess({
        outcome: 'refused',
        ...identity(principal),
        threadId,
        route: route.kind as EmbedAccessRoute,
        reason,
      });
    } catch (error: unknown) {
      warn(`[嵌入下行] thread ${threadId} 拒絕 ${route.kind} 的稽核紀錄寫不進去：${String(error)}`);
    }
  }

  /**
   * 對話行程回的嵌入版下行：先記 `opened`、寫好才交出第一個位元組；登記給掃描，切掉時連往對話行程的那條一起斷。
   */
  async function guardStream(
    active: EmbedStreamGuard,
    response: Response,
    upstream: AbortController,
    request: Request,
    threadId: string,
    principal: EmbedPrincipal,
  ): Promise<Response> {
    const audit = active.audit();
    const base = { ...identity(principal), threadId, streamId: randomUUID() };
    try {
      if (audit === undefined) throw new Error('稽核紀錄還沒打開');
      await audit.recordStream({ outcome: 'opened', ...base });
    } catch (error: unknown) {
      upstream.abort();
      warn(`[嵌入下行] thread ${threadId} 的稽核紀錄寫不進去，這條下行不開：${String(error)}`);
      return new Response('audit unavailable', {
        status: 500,
        headers: { 'cache-control': 'no-store' },
      });
    }
    // 寫 `opened` 期間客戶端斷了（之後掛的 abort 監聽不會觸發），或前台已經在收（`close` 掃過 `streams` 了，之後登記的沒人收）：
    // 在這裡就收尾。
    if (request.signal.aborted || closed) {
      upstream.abort();
      audit
        .recordStream({
          outcome: 'closed',
          ...base,
          by: request.signal.aborted ? 'client' : 'server',
        })
        .catch((error: unknown) => {
          warn(`[嵌入下行] thread ${threadId} 收線的稽核紀錄寫不進去：${String(error)}`);
        });
      return new Response('stream not opened', {
        status: 503,
        headers: { 'cache-control': 'no-store' },
      });
    }
    const reader = response.body!.getReader();
    let ended = false;
    let fail: ((error: Error) => void) | undefined;
    const end = (record: StreamRecord): void => {
      if (ended) return;
      ended = true;
      unregister(entry);
      request.signal.removeEventListener('abort', onAbort);
      audit.recordStream(record).catch((error: unknown) => {
        warn(`[嵌入下行] thread ${threadId} 收線的稽核紀錄寫不進去：${String(error)}`);
      });
    };
    const entry: ForwardedEmbedStream = {
      headers: request.headers,
      cut: (reason) => {
        end({ outcome: 'cut', ...base, reason });
        fail?.(new StreamCutError(`嵌入版下行重驗沒過，已切掉（${reason}）`));
        upstream.abort();
      },
      close: () => {
        end({ outcome: 'closed', ...base, by: 'server' });
        fail?.(new Error('前台關機，下行收掉'));
        upstream.abort();
      },
    };
    const onAbort = (): void => end({ outcome: 'closed', ...base, by: 'client' });
    request.signal.addEventListener('abort', onAbort, { once: true });
    register(entry, active);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        fail = (error) => controller.error(error);
      },
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (ended && !done) return;
          if (done) {
            end({ outcome: 'closed', ...base, by: 'server' });
            controller.close();
          } else {
            controller.enqueue(value);
          }
        } catch (error: unknown) {
          if (ended) return;
          end({ outcome: 'closed', ...base, by: request.signal.aborted ? 'client' : 'server' });
          controller.error(error);
        }
      },
      cancel(reason) {
        end({ outcome: 'closed', ...base, by: 'client' });
        upstream.abort();
        return reader.cancel(reason);
      },
    });
    return new Response(body, { status: response.status, headers: response.headers });
  }

  /** 監督行程替這條 thread 開好行程，回它的 socket；開不了回要回給客戶端的那一份。 */
  async function socketFor(
    threadId: string,
    open: OpenMode,
    id: number | null,
    signal: AbortSignal,
  ): Promise<string | Response> {
    let outcome: EnsureOutcome;
    try {
      outcome = await supervisor.ensure(threadId, open, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      return json(
        errorResponse(id, 'unknown_error', `監督行程不在，thread "${threadId}" 開不了。`),
      );
    }
    return outcome.type === 'up' ? outcome.socket : outcomeFailure(outcome, id, threadId);
  }

  /** 打一支對話行程的內部路由（不帶身分標頭，同 `turn-failures`）；連不上回 `undefined`。 */
  async function internalPost(
    threadId: string,
    socket: string,
    action: 'fork-seed' | 'fork-adopt',
    body: string,
    signal: AbortSignal,
  ): Promise<Response | undefined> {
    try {
      return await forwarder.forward(
        new Request(`http://localhost${internalThreadPath(threadId, action)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal,
        }),
        socket,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      if (processGone(error)) forwarder.forget(socket);
      else forwarder.dropIdle(socket);
      return undefined;
    }
  }

  /**
   * 分叉（`.docs/supervisor-1947-design-2026-11-03.md` §4-3）：來源的對話行程照 `handleFork`（`wire-handler.ts`）的第 1 到 4 步算出子 thread 的 seed
   * （`fork-seed`；冷的來源用 `read-only` 開：照樣佔一格，名額滿時先被收），分得出去才替子 thread 開一個行程、交給它照第 5、6 步建（`fork-adopt`）。
   * 來源開不起來（名額滿）時回那一份，排在參數與切點的檢查之前；分不出去的、子 thread 建不起來的，原樣回對話行程的那一份；`fork-adopt` 回的不是 2xx（例如本文超過上限的 413）時回 `unknown_error`，
   * 已經開好的子行程照閒置時間收。
   */
  async function forkAcross(request: Request, route: Route, id: number): Promise<Response> {
    const body = await request.text();
    const unreachable = (threadId: string): Response =>
      json(errorResponse(id, 'unknown_error', `thread "${threadId}" 的對話行程連不上，請重試。`));
    const source = await socketFor(route.threadId, 'read-only', id, request.signal);
    if (source instanceof Response) return source;
    const seeded = await internalPost(route.threadId, source, 'fork-seed', body, request.signal);
    if (seeded === undefined) return unreachable(route.threadId);
    if (!seeded.ok) {
      await seeded.body?.cancel();
      return unreachable(route.threadId);
    }
    const result = (await seeded.json()) as { fork?: unknown; answer?: unknown };
    if (result.fork === undefined) return json(result.answer);
    const childId = options.newThreadId?.() ?? randomUUID();
    const child = await socketFor(childId, 'run', id, request.signal);
    if (child instanceof Response) return child;
    const adopted = await internalPost(
      childId,
      child,
      'fork-adopt',
      JSON.stringify({ id, fork: result.fork }),
      request.signal,
    );
    if (adopted === undefined) return unreachable(childId);
    if (!adopted.ok) {
      await adopted.body?.cancel();
      return json(
        errorResponse(
          id,
          'unknown_error',
          `分叉出來的 thread 沒有建起來（對話行程回 ${String(adopted.status)}）。`,
        ),
      );
    }
    options.onForwarded?.(childId);
    return adopted;
  }

  async function forwardTo(
    request: Request,
    route: Route,
    open: OpenMode,
    principal: WirePrincipal,
    embedded: boolean,
  ): Promise<Response> {
    const id = await envelopeId(request, route);
    let outcome: EnsureOutcome;
    try {
      outcome = await supervisor.ensure(route.threadId, open, request.signal);
    } catch (error) {
      if (request.signal.aborted) throw error;
      return json(
        errorResponse(id, 'unknown_error', `監督行程不在，thread "${route.threadId}" 開不了。`),
      );
    }
    if (outcome.type !== 'up') return outcomeFailure(outcome, id, route.threadId);
    const guarded =
      embedded && route.kind === 'stream' && principal.kind === 'embed' && guard !== undefined;
    // 嵌入版下行要能從這一側切：另開一支 signal，客戶端斷線或掃描切掉都中止往對話行程的那條。
    const upstream = new AbortController();
    const outgoing = guarded
      ? new Request(request, {
          signal: AbortSignal.any([request.signal, upstream.signal]),
          duplex: 'half',
        } as RequestInit)
      : request;
    let response: Response;
    try {
      // 停准入之後轉的每一個都帶標頭，對話行程照它擋這一個請求（有行程的 `run.start`、會 steer 的 `slash.run`）：
      // 停准入只在前台，對話行程的那一支沒被叫過。
      response = await forwarder.forward(outgoing, outcome.socket, {
        ...principalHeaders(principal),
        ...(admissionStopped && { [FRONT_CLOSING_HEADER]: '1' }),
      });
    } catch (error) {
      if (request.signal.aborted) throw error;
      // 連不上（行程剛走、`down` 還沒到）才收掉整個 socket 的連線；其餘的錯只丟閒置的，同一條 thread 開著的下行不跟著斷。
      // 都回暫時性的錯，客戶端重試會再 `ensure` 一次。
      if (processGone(error)) forwarder.forget(outcome.socket);
      else forwarder.dropIdle(outcome.socket);
      return json(
        errorResponse(id, 'unknown_error', `thread "${route.threadId}" 的對話行程連不上，請重試。`),
      );
    }
    options.onForwarded?.(route.threadId);
    const refused = response.headers.get(EMBED_REFUSED_HEADER);
    if (refused !== null) {
      response.headers.delete(EMBED_REFUSED_HEADER);
      if (principal.kind === 'embed') await recordAccess(principal, route.threadId, route, refused);
    }
    const eventStream =
      route.kind === 'stream' &&
      response.body !== null &&
      (response.headers.get('content-type') ?? '').startsWith('text/event-stream');
    if (!eventStream) return response;
    return countDownlink(
      route.threadId,
      guarded
        ? await guardStream(guard, response, upstream, request, route.threadId, principal)
        : response,
    );
  }

  return {
    ...local,
    stopAdmission: () => {
      admissionStopped = true;
      local.stopAdmission();
    },
    close: async () => {
      closed = true;
      for (const entry of [...streams]) entry.close();
      await local.close();
    },
    handle: async (request) => {
      const { pathname } = new URL(request.url);
      const embedded = withoutEmbedPrefix(pathname);
      const route = parsePath(embedded ?? pathname);
      if (route === undefined) return local.handle(request);
      const rejection = local.admit(request.headers, pathname);
      if (rejection !== undefined) return rejection;
      const principal = auth.authenticate(request.headers);
      if (principal === undefined) return local.handle(request);
      if (embedded !== undefined) {
        // 第一道：前台冷讀 header 就擋得下的先擋（拒絕的稽核由本地那支記）。
        const refusal = await local.embedRefusal(embedded, principal);
        if (refusal !== undefined) return refusal;
        if (!EMBED_ROUTE_KINDS.has(route.kind)) return new Response('not found', { status: 404 });
      }
      // `@` 的會話候選是冷讀整個會話根，為一份清單起一個行程是反的；嵌入路由打不到它（`EMBED_ROUTE_KINDS`）。
      if (route.kind === 'session-references') return local.handle(request);
      if (route.kind === 'command') {
        if (
          embedded === undefined &&
          isThreadManagementMethod(route.method) &&
          route.method !== 'thread.rename' &&
          route.method !== 'thread.fork'
        ) {
          return local.handle(request);
        }
        if (isRunCancelMethod(route.method) && supervisor.socketOf(route.threadId) === undefined) {
          return local.handle(request);
        }
        // 收尾中不開新一輪（#1787），同本地那支：`subagent.send` 一律擋；`run.start` 只擋沒有行程的（有行程的轉過去，
        // 窗前收過的重送由對話行程照 request_id 去重、拿回原本的 run_id）。不為一句不會收的話起一個對話行程。
        // 嵌入路由的 `thread.fork` 與讀不出 id 的照一般轉送；後者封包的錯由對話行程照 single 回。
        const forkId =
          route.method === 'thread.fork' && embedded === undefined
            ? await envelopeId(request, route)
            : null;
        if (forkId !== null) {
          if (admissionStopped) return serverClosing(forkId);
          return forkAcross(request, route, forkId);
        }
        if (admissionStopped) {
          if (route.method === SUBAGENT_SEND_METHOD) {
            return serverClosing(await envelopeId(request, route));
          }
          if (route.method === 'run.start' && supervisor.socketOf(route.threadId) === undefined) {
            return serverClosing(await envelopeId(request, route));
          }
        }
      }
      return forwardTo(
        request,
        route,
        READ_ONLY_KINDS.has(route.kind) ? 'read-only' : 'run',
        principal,
        embedded !== undefined,
      );
    },
  };
}

/**
 * 前台封存時問對話行程的那一組（{@link WireHandlerOptions.threadActivityElsewhere}）：沒有行程就是閒著、停無可停；
 * 連不上而行程剛好走了也一樣。其餘的錯照拋：`activity` 拋了封存不寫，`stop` 拋了封存照舊、由封存那一側講一聲（`ArchiveDeps.stop`）。
 */
export function threadActivityOverSocket(
  supervisor: SupervisorClient,
  forwarder: FrontForwarder,
): NonNullable<WireHandlerOptions['threadActivityElsewhere']> {
  async function call(
    threadId: string,
    action: 'activity' | 'stop',
  ): Promise<Response | undefined> {
    const socket = supervisor.socketOf(threadId);
    if (socket === undefined) return undefined;
    const request = new Request(`http://localhost${internalThreadPath(threadId, action)}`, {
      method: action === 'activity' ? 'GET' : 'POST',
    });
    let response: Response;
    try {
      response = await forwarder.forward(request, socket);
    } catch (error) {
      if (supervisor.socketOf(threadId) === undefined) return undefined;
      throw error;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`thread "${threadId}" 的對話行程回 ${String(response.status)}（${action}）`);
    }
    return response;
  }
  return {
    activity: async (threadId) => {
      const response = await call(threadId, 'activity');
      if (response === undefined) return [];
      const body = (await response.json()) as { activity?: unknown };
      if (!Array.isArray(body.activity)) {
        throw new Error(`thread "${threadId}" 的對話行程回的 activity 認不得`);
      }
      return body.activity as ThreadActivityKind[];
    },
    stop: async (threadId) => {
      const response = await call(threadId, 'stop');
      await response?.body?.cancel();
    },
  };
}

function identity(principal: EmbedPrincipal) {
  return {
    embedder: principal.embedder,
    subject: principal.subject,
    userId: principal.userId,
    sessionIdSha256: principal.sessionIdSha256,
  };
}
