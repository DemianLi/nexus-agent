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
 * - **前台自己答的**：列表、搜尋、全域下行（不指名 thread）；釘選與封存（整理檔只有前台一個寫的人）；`run.cancel` 在那條
 *   thread 沒有行程時（嵌入路由也一樣，本地答受理，同 single 取消一條沒在跑的）。評分一律轉送：它要寫那條 thread 的日誌，
 *   前台不載 thread，本地答只會是「還沒開過」。
 * - **打開方式**：讀歷史、附件、引用、變更的是 `read-only`，其餘（開下行、送指令、上傳）是 `run`。
 *
 * @module
 */

import {
  errorResponse,
  isRunCancelMethod,
  isThreadManagementMethod,
  THREAD_AT_CAPACITY,
} from '@nexus/wire';

import { randomUUID } from 'node:crypto';

import type { EmbedAccessRoute, StreamRecord } from './embed-audit.js';
import { IDENTITY_TABLE_STAT_INTERVAL_MS } from './embed-identities.js';
import { EMBED_ROUTE_KINDS, withoutEmbedPrefix } from './embed-profile.js';
import type { EmbedCookieRefusal } from './embed-session.js';
import { EMBED_REFUSED_HEADER, principalHeaders } from './forwarded-principal.js';
import type { FrontForwarder } from './front-forward.js';
import { StreamCutError } from './sse-response.js';
import type { EnsureOutcome, SupervisorClient } from './supervisor-client.js';
import type { OpenMode } from './supervisor-protocol.js';
import {
  parsePath,
  type EmbedStreamGuard,
  type IdleSweepingWireHandler,
  type WireAuth,
} from './wire-handler.js';
import type { EmbedPrincipal, WirePrincipal } from './wire-principal.js';

type Route = NonNullable<ReturnType<typeof parsePath>>;

/** 用 `read-only` 打開的路由：監督行程給它較短的閒置時間（`--read-only-idle-ms`），名額滿時先逐出（設計 §7-3）。 */
const READ_ONLY_KINDS: ReadonlySet<Route['kind']> = new Set([
  'history',
  'subagent-history',
  'trajectory-turn',
  'file-references',
  'session-references',
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
  readonly warn?: (message: string) => void;
}

/** 前台登記中的一條嵌入版下行。 */
interface ForwardedEmbedStream {
  readonly headers: Headers;
  cut(reason: EmbedCookieRefusal): void;
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
  return json(
    errorResponse(
      id,
      'unknown_error',
      `thread "${threadId}" 的對話行程沒起來（${outcome.cause}），原因記在監督行程的稽核檔。`,
    ),
  );
}

/**
 * 包成前台的 handler。`admit` 與其餘欄位照本地那一支，只換 `handle`；收尾由 serve 收本地那一支，轉送器由入口收。
 */
export function createFrontWireHandler(options: FrontWireOptions): IdleSweepingWireHandler {
  const { local, supervisor, forwarder, auth, embedStreams: guard } = options;
  const warn = options.warn ?? (() => {});
  const streams = new Set<ForwardedEmbedStream>();
  let scan: ReturnType<typeof setInterval> | undefined;

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
      response = await forwarder.forward(outgoing, outcome.socket, principalHeaders(principal));
    } catch (error) {
      if (request.signal.aborted) throw error;
      // 連不上：行程剛走、`down` 還沒到。換掉這個 socket 的連線，回暫時性的錯，客戶端重試會再 `ensure` 一次。
      forwarder.forget(outcome.socket);
      return json(
        errorResponse(id, 'unknown_error', `thread "${route.threadId}" 的對話行程連不上，請重試。`),
      );
    }
    const refused = response.headers.get(EMBED_REFUSED_HEADER);
    if (refused !== null) {
      response.headers.delete(EMBED_REFUSED_HEADER);
      if (principal.kind === 'embed') await recordAccess(principal, route.threadId, route, refused);
    }
    if (
      guarded &&
      response.body !== null &&
      (response.headers.get('content-type') ?? '').startsWith('text/event-stream')
    ) {
      return guardStream(guard, response, upstream, request, route.threadId, principal);
    }
    return response;
  }

  return {
    ...local,
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

function identity(principal: EmbedPrincipal) {
  return {
    embedder: principal.embedder,
    subject: principal.subject,
    userId: principal.userId,
    sessionIdSha256: principal.sessionIdSha256,
  };
}
