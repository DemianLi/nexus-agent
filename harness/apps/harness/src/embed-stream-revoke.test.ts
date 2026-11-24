/**
 * 撤權後切掉已開的嵌入版下行（[#2489](https://github.com/DemianLi/nexus-agent/issues/2489)，#1827 D239）：wire handler 的登記、掃描、
 * 切掉之後已經排著的事件不送，與 `stream`／`access` 兩種稽核紀錄。
 *
 * 多數用替身的身分驗證與重驗（請求帶 `x-who` 指名身分，`cookie` 是替身重驗查判決的鍵、也是掃描的快取鍵），
 * 掃描間隔縮到 20 ms；「2 秒內」與「續上的不切」用真的 `EmbedSessionCookies`，前者再加真的對應表檔。
 */

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { commandPath, EMBED_PATH_PREFIX, historyPath, streamPath } from '@nexus/wire';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { memoryAudit } from './embed-audit.fixture.js';
import { EMBED_IDENTITIES_FILE, EmbedIdentityTable } from './embed-identities.js';
import type { ThreadProfile } from './embed-profile.js';
import { EmbedSessionCookies } from './embed-session.js';
import type { EmbedCookieVerdict } from './embed-session.js';
import type { EmbedThreadOwner } from './embed-thread-owner.js';
import { emptyCommandPoint, loopbackRequest } from './fixtures.js';
import { PrunedMemorySaver } from './pruned-memory-saver.js';
import { ScriptedChatModel } from './scripted-model.js';
import { composeAttachSessions } from './session-attach.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { EmbedStreamGuard, ThreadAgent, WireAuth } from './wire-handler.js';
import { OWNER_PRINCIPAL } from './wire-principal.js';
import type { EmbedPrincipal, WirePrincipal } from './wire-principal.js';

const BASE = 'http://embed-revoke.test';
const SECRET = Buffer.alloc(32, 9);

function embed(userId: string, session: string): EmbedPrincipal {
  return { kind: 'embed', embedder: 'crm', subject: userId, userId, sessionIdSha256: session };
}

const ALICE = embed('alice', 'a'.repeat(64));
const BOB = embed('bob', 'b'.repeat(64));

const WHO: Readonly<Record<string, WirePrincipal>> = {
  owner: OWNER_PRINCIPAL,
  alice: ALICE,
  'alice-2': ALICE,
  bob: BOB,
};

const temporary: string[] = [];
const handlers: ReturnType<typeof createWireHandler>[] = [];

afterEach(async () => {
  await Promise.all(handlers.splice(0).map((handler) => handler.close().catch(() => undefined)));
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function realAgent(
  profile: ThreadProfile | undefined,
  owner: EmbedThreadOwner | undefined,
): Promise<ThreadAgent> {
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns: [{ content: '好' }, { content: '好' }] }),
    checkpointer: new PrunedMemorySaver(),
    plugins: [],
  });
  return {
    agent: built.agent as unknown as PumpAgent,
    commands: emptyCommandPoint(),
    attachSessions: composeAttachSessions(built),
    dispose: built.dispose,
    ...(profile === undefined ? {} : { profile }),
    ...(owner === undefined ? {} : { owner }),
  };
}

/**
 * @param options.auth - 省略就照 `x-who` 認。
 * @param options.recheck - 省略就照回傳的 `verdicts` 判（`cookie` 標頭當鍵，沒列的算過）。
 * @param options.intervalMs - 省略是 20 ms；給 0 是不帶這個欄位，用出廠的間隔。
 */
function rig(
  options: {
    readonly auth?: WireAuth;
    readonly recheck?: EmbedStreamGuard['recheck'];
    readonly intervalMs?: number;
    readonly now?: () => number;
  } = {},
) {
  const recorded = memoryAudit();
  const verdicts = new Map<string, EmbedCookieVerdict>();
  let rechecks = 0;
  const warnings: string[] = [];
  const handler = createWireHandler({
    auth: options.auth ?? { authenticate: (headers) => WHO[headers.get('x-who') ?? 'owner'] },
    createAgent: (_threadId, _fork, profile, owner) => realAgent(profile, owner),
    storedAccess: async () => undefined,
    embedStreams: {
      recheck: (headers) => {
        rechecks += 1;
        if (options.recheck !== undefined) return options.recheck(headers);
        return verdicts.get(headers.get('cookie') ?? '') ?? { ok: true, principal: ALICE };
      },
      audit: () => recorded.audit,
      ...(options.intervalMs !== 0 && { intervalMs: options.intervalMs ?? 20 }),
    },
    warn: (line) => warnings.push(line),
    ...(options.now !== undefined && { now: options.now }),
  });
  handlers.push(handler);
  return { handler, ...recorded, verdicts, rechecks: () => rechecks, warnings };
}

function headersFor(who: string, cookie = `who=${who}`): Record<string, string> {
  return { 'content-type': 'application/json', 'x-who': who, cookie };
}

function openStream(
  handler: ReturnType<typeof createWireHandler>,
  who: string,
  thread: string,
  init: { readonly cookie?: string; readonly signal?: AbortSignal; readonly prefix?: string } = {},
): Promise<Response> {
  return handler.handle(
    loopbackRequest(`${BASE}${init.prefix ?? EMBED_PATH_PREFIX}${streamPath(thread)}`, {
      method: 'POST',
      headers: headersFor(who, init.cookie),
      body: JSON.stringify({ channels: ['messages', 'lifecycle'] }),
      ...(init.signal !== undefined && { signal: init.signal }),
    }),
  );
}

async function startRun(
  handler: ReturnType<typeof createWireHandler>,
  who: string,
  thread: string,
): Promise<void> {
  const response = await handler.handle(
    loopbackRequest(`${BASE}${EMBED_PATH_PREFIX}${commandPath(thread, 'run.start')}`, {
      method: 'POST',
      headers: headersFor(who),
      body: JSON.stringify({
        id: 1,
        method: 'run.start',
        params: {
          assistant_id: 'nexus',
          input: { messages: [{ role: 'human', content: '嗨' }] },
        },
      }),
    }),
  );
  expect(((await response.json()) as { type: string }).type).toBe('success');
}

/** 一條 SSE 下行的讀者：`next` 讀一段文字，讀完回 `undefined`；被切掉的線讀到錯誤（handler 層；經 HTTP 是正常結束，見 `serve-embed-login.test.ts`）。 */
function sse(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  return {
    async next(): Promise<string | undefined> {
      const chunk = await reader.read();
      return chunk.done ? undefined : decoder.decode(chunk.value);
    },
    /** 一直讀到文字裡出現 `marker`。 */
    async until(marker: string): Promise<string> {
      let text = '';
      while (!text.includes(marker)) {
        const chunk = await this.next();
        if (chunk === undefined) throw new Error(`下行在出現 ${marker} 之前就結束了`);
        text += chunk;
      }
      return text;
    },
  };
}

const ROOT_COMPLETED = '"event":"completed"';

describe('掃描切掉驗不過的下行', () => {
  it('切掉之後，已經排著、還沒送出的事件一顆都不送；同一條 thread 驗得過的那條照收', async () => {
    const { handler, verdicts, streams } = rig();
    const cutting = sse(await openStream(handler, 'alice', 'e1'));
    const staying = sse(await openStream(handler, 'alice-2', 'e1'));
    expect(await cutting.next()).toBe(': connected\n\n');
    // 讀完開線那一行之後不再讀：這一輪的事件全排在 `cutting` 的佇列裡。
    await startRun(handler, 'alice', 'e1');
    await staying.until(ROOT_COMPLETED);

    verdicts.set('who=alice', { ok: false, reason: 'not_mapped' });
    await vi.waitFor(() => {
      expect(streams.some((record) => record.outcome === 'cut')).toBe(true);
    });
    await expect(cutting.next()).rejects.toThrow('重驗沒過');

    expect(streams.filter((record) => record.outcome === 'cut')).toEqual([
      expect.objectContaining({ threadId: 'e1', userId: 'alice', reason: 'not_mapped' }),
    ]);
    // 同一人、同一條 thread 開了兩條：`cut` 靠 `streamId` 配回先開的那一條。
    const [first, second] = streams.filter((record) => record.outcome === 'opened');
    expect(streams.find((record) => record.outcome === 'cut')?.streamId).toBe(first?.streamId);
    expect(second?.streamId).not.toBe(first?.streamId);
    await startRun(handler, 'alice-2', 'e1');
    expect(await staying.until(ROOT_COMPLETED)).toContain(ROOT_COMPLETED);
  });

  it('同一輪裡同一顆 cookie 只重驗一次', async () => {
    // 一輪是同步跑完的一個迴圈：同一個同步段落裡的重驗算同一輪。
    const rounds: string[][] = [];
    let current: string[] | undefined;
    const { handler } = rig({
      intervalMs: 50,
      recheck: (headers) => {
        if (current === undefined) {
          current = [];
          rounds.push(current);
          queueMicrotask(() => {
            current = undefined;
          });
        }
        current.push(headers.get('cookie') ?? '');
        return { ok: true, principal: ALICE };
      },
    });
    await openStream(handler, 'alice', 'e1');
    await openStream(handler, 'alice', 'e2');
    await openStream(handler, 'alice-2', 'e3');
    // 三條都登記好之後才數：在那之前跑的輪只看得到一部分。
    const registered = rounds.length;
    await vi.waitFor(() => {
      expect(rounds.length).toBeGreaterThan(registered);
    });
    expect([...rounds[registered]!].sort()).toEqual(['who=alice', 'who=alice-2']);
  });

  it('從對應表拿掉之後 2 秒內切掉（真的 cookie、真的表檔，掃描間隔用出廠的 1 秒）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-embed-revoke-'));
    temporary.push(dir);
    const file = join(dir, EMBED_IDENTITIES_FILE);
    const mapping = { embedder: 'crm', subject: 'alice', userId: 'alice' };
    writeFileSync(file, JSON.stringify({ version: 1, mappings: [mapping] }), { mode: 0o600 });
    const table = EmbedIdentityTable.load(file, ['crm']);
    const cookies = new EmbedSessionCookies(SECRET, 900, ['crm'], table);
    const pair = cookies.issue('localhost', ALICE).setCookie.split(';', 1)[0]!;
    const { handler, streams } = rig({
      auth: { authenticate: (headers) => cookies.authenticate(headers) },
      recheck: (headers) => cookies.recheckOpenStream(headers),
      intervalMs: 0,
    });
    const downlink = sse(await openStream(handler, 'alice', 'e1', { cookie: pair }));
    expect(await downlink.next()).toBe(': connected\n\n');

    writeFileSync(file, JSON.stringify({ version: 1, mappings: [] }), { mode: 0o600 });
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);
    const revokedAt = performance.now();
    await expect(downlink.next()).rejects.toThrow('重驗沒過');
    expect(performance.now() - revokedAt).toBeLessThan(2_000);
    expect(streams.at(-1)).toMatchObject({ outcome: 'cut', reason: 'not_mapped' });
  }, 10_000);
});

describe('過期：續上的不切，沒續上的切（#1827 D239 Q5 (c)）', () => {
  it('同一條登入兌換過一顆還沒到期的就不切；沒兌換過的在到期後切；舊 cookie 照樣開不了新的下行', async () => {
    let clock = 1_000_000;
    const now = () => clock;
    const cookies = new EmbedSessionCookies(
      SECRET,
      900,
      ['crm'],
      { resolve: (_embedder, subject) => ({ kind: 'accepted', userId: subject }) },
      now,
    );
    const renewing = embed('alice', 'r'.repeat(64));
    const lapsing = embed('alice', 'l'.repeat(64));
    const pairOf = (who: EmbedPrincipal) =>
      cookies.issue('localhost', who).setCookie.split(';', 1)[0]!;
    const oldRenewing = pairOf(renewing);
    const oldLapsing = pairOf(lapsing);
    const { handler, streams } = rig({
      auth: { authenticate: (headers) => cookies.authenticate(headers) },
      recheck: (headers) => cookies.recheckOpenStream(headers),
      now,
    });
    const kept = sse(await openStream(handler, 'alice', 'e1', { cookie: oldRenewing }));
    const dropped = sse(await openStream(handler, 'alice', 'e2', { cookie: oldLapsing }));
    expect(await kept.next()).toBe(': connected\n\n');
    expect(await dropped.next()).toBe(': connected\n\n');

    // 到期前 60 秒續期：同一條登入換到一顆新的（兌換成功時 `embed-session.ts` 叫這一支）。
    clock += 840_000;
    cookies.recordRenewal(renewing, cookies.issue('localhost', renewing).expiresAt);
    clock += 60_001;

    await expect(dropped.next()).rejects.toThrow('重驗沒過');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(streams.filter((record) => record.outcome === 'cut')).toEqual([
      expect.objectContaining({ threadId: 'e2', reason: 'expired' }),
    ]);
    expect((await openStream(handler, 'alice', 'e1', { cookie: oldRenewing })).status).toBe(401);
  });
});

describe('稽核紀錄', () => {
  it('開線記 opened；對方放掉記 closed by client；從沒被讀過就放掉的也只記一筆', async () => {
    const { handler, streams } = rig();
    const read = new AbortController();
    const downlink = sse(await openStream(handler, 'alice', 'e1', { signal: read.signal }));
    expect(await downlink.next()).toBe(': connected\n\n');
    read.abort();
    const unread = new AbortController();
    await openStream(handler, 'alice', 'e2', { signal: unread.signal });
    unread.abort();
    await vi.waitFor(() => {
      expect(streams.filter((record) => record.outcome === 'closed')).toHaveLength(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const e1 = streams[0]?.streamId;
    const e2 = streams[2]?.streamId;
    expect(e1).toMatch(/^[0-9a-f-]{36}$/u);
    expect(e2).not.toBe(e1);
    expect(streams).toEqual([
      {
        outcome: 'opened',
        embedder: 'crm',
        subject: 'alice',
        userId: 'alice',
        sessionIdSha256: ALICE.sessionIdSha256,
        threadId: 'e1',
        streamId: e1,
      },
      expect.objectContaining({ outcome: 'closed', threadId: 'e1', streamId: e1, by: 'client' }),
      expect.objectContaining({ outcome: 'opened', threadId: 'e2', streamId: e2 }),
      expect.objectContaining({ outcome: 'closed', threadId: 'e2', streamId: e2, by: 'client' }),
    ]);
  });

  it('handler 收掉時，還開著的記 closed by server', async () => {
    const { handler, streams } = rig();
    await openStream(handler, 'alice', 'e1');
    await handler.close();
    expect(streams.at(-1)).toMatchObject({ outcome: 'closed', threadId: 'e1', by: 'server' });
  });

  it('opened 落盤期間請求被中止：記 closed by client，不訂閱、不登記、不起掃描', async () => {
    const { handler, streams, holdNextWrite, rechecks } = rig();
    const write = holdNextWrite();
    const request = new AbortController();
    const opening = openStream(handler, 'alice', 'e1', { signal: request.signal });
    await vi.waitFor(() => {
      expect(write.held()).toBe(true);
    });
    request.abort();
    write.release();
    await opening;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(handler.idleState('e1')?.idle).toBe(true);
    expect(rechecks()).toBe(0);
    expect(streams).toEqual([
      expect.objectContaining({ outcome: 'opened', threadId: 'e1' }),
      expect.objectContaining({ outcome: 'closed', threadId: 'e1', by: 'client' }),
    ]);
  });

  it('opened 落盤期間 handler 收掉：記 closed by server、不登記', async () => {
    const { handler, streams, holdNextWrite, rechecks } = rig();
    const write = holdNextWrite();
    const opening = openStream(handler, 'alice', 'e1');
    await vi.waitFor(() => {
      expect(write.held()).toBe(true);
    });
    const closing = handler.close();
    write.release();
    await opening;
    await closing;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(rechecks()).toBe(0);
    expect(streams).toEqual([
      expect.objectContaining({ outcome: 'opened', threadId: 'e1' }),
      expect.objectContaining({ outcome: 'closed', threadId: 'e1', by: 'server' }),
    ]);
  });

  it('opened 寫不進去：回 500、不開線、不登記給掃描', async () => {
    const { handler, streams, failNextWrite, rechecks, warnings } = rig();
    failNextWrite();
    const refused = await openStream(handler, 'alice', 'e1');
    expect(refused.status).toBe(500);
    expect(warnings.join('\n')).toContain('這條下行不開');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(rechecks()).toBe(0);
    expect(streams).toEqual([]);
    expect((await openStream(handler, 'alice', 'e1')).status).toBe(200);
  });

  it('嵌入身分碰到別人的、或不是嵌入版開的 thread：記 access；主機擁有者從嵌入路由打的不記', async () => {
    const { handler, accesses } = rig();
    expect((await openStream(handler, 'alice', 'e1')).status).toBe(200);
    const bobReads = await handler.handle(
      loopbackRequest(`${BASE}${EMBED_PATH_PREFIX}${historyPath('e1')}`, {
        method: 'GET',
        headers: headersFor('bob'),
      }),
    );
    expect(((await bobReads.json()) as { error: string }).error).toBe('thread_not_owned');
    // 主機擁有者在獨立頁面開的 thread，嵌入身分打不開；擁有者自己從嵌入路由打不是嵌入版開的，被拒也不記。
    expect((await openStream(handler, 'owner', 'h1', { prefix: '' })).status).toBe(200);
    expect((await openStream(handler, 'alice', 'h1')).status).toBe(200);
    await openStream(handler, 'owner', 'h1');
    expect(accesses).toEqual([
      {
        outcome: 'refused',
        embedder: 'crm',
        subject: 'bob',
        userId: 'bob',
        sessionIdSha256: BOB.sessionIdSha256,
        threadId: 'e1',
        route: 'history',
        reason: 'thread_not_owned',
      },
      expect.objectContaining({
        userId: 'alice',
        threadId: 'h1',
        route: 'stream',
        reason: 'not_embedded',
      }),
    ]);
  });
});
