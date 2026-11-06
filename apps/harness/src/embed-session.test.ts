/**
 * 嵌入 cookie 與兌換（[#2370](https://github.com/DemianLi/nexus-agent/issues/2370)）：cookie 跟獨立頁面那顆不能互換、兌換的每一種結果。
 * 接線（路由、`admit` 的放行範圍）在 `serve-embed-login.test.ts`。
 */

import { describe, expect, it } from 'vitest';

import { BrowserAuth } from './browser-auth.js';
import { memoryAudit } from './embed-audit.fixture.js';
import type { EmbedIdentityResolver } from './embed-login.js';
import { EmbedTicketStore } from './embed-login.js';
import {
  createEmbedSession,
  EMBED_SESSION_PATH,
  EmbedSessionCookies,
  MAX_SESSION_BODY_BYTES,
} from './embed-session.js';
import type { EmbedIdentityCheck, EmbedSessionOptions } from './embed-session.js';

const SECRET = Buffer.alloc(32, 7);
const AUTHORITY = '127.0.0.1:8787';
const IDENTITY = {
  embedder: 'crm',
  subject: 'alice',
  userId: 'u-alice',
  sessionIdSha256: 'h'.repeat(64),
};

/** 表上什麼都有：只量 cookie 本身的那幾條。 */
const ALL_MAPPED: EmbedIdentityCheck = { has: () => true };

/** 從 `Set-Cookie` 取出 `name=value`。 */
function cookiePair(setCookie: string): string {
  return setCookie.split(';', 1)[0]!;
}

function headersWith(cookie: string, host = AUTHORITY): Headers {
  return new Headers({ host, cookie });
}

describe('EmbedSessionCookies', () => {
  it('簽出來的 cookie 驗得回同一個身分；屬性同獨立頁面那顆', () => {
    const cookies = new EmbedSessionCookies(SECRET, 900, ['crm'], ALL_MAPPED, () => 1_000_000);
    const { setCookie, expiresAt } = cookies.issue(AUTHORITY, IDENTITY);
    expect(expiresAt).toBe(1_000_000 + 900_000);
    expect(setCookie).toMatch(/^nexus-embed-[A-Za-z0-9_-]+=e1\./u);
    expect(setCookie).toContain('Max-Age=900; Path=/;');
    expect(setCookie).toContain('HttpOnly; SameSite=Strict');
    expect(setCookie).not.toContain('Domain');
    expect(cookies.authenticate(headersWith(cookiePair(setCookie)))).toEqual({
      kind: 'embed',
      ...IDENTITY,
    });
  });

  it('到期、換了 authority、被改過、別的密鑰簽的：都驗不過', () => {
    let now = 1_000_000;
    const cookies = new EmbedSessionCookies(SECRET, 900, ['crm'], ALL_MAPPED, () => now);
    const pair = cookiePair(cookies.issue(AUTHORITY, IDENTITY).setCookie);
    expect(cookies.authenticate(headersWith(pair, '127.0.0.1:9999'))).toBeUndefined();
    const [name, value] = pair.split('=') as [string, string];
    const [tag, body, signature] = value.split('.') as [string, string, string];
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body, 'base64url').toString('utf8')),
        userId: 'u-admin',
      }),
    ).toString('base64url');
    expect(
      cookies.authenticate(headersWith(`${name}=${tag}.${forged}.${signature}`)),
    ).toBeUndefined();
    expect(
      new EmbedSessionCookies(
        Buffer.alloc(32, 8),
        900,
        ['crm'],
        ALL_MAPPED,
        () => now,
      ).authenticate(headersWith(pair)),
    ).toBeUndefined();
    now += 900_000;
    expect(cookies.authenticate(headersWith(pair))).toBeUndefined();
  });

  it('嵌入方從設定拿掉之後，它簽出去還沒到期的 cookie 驗不過', () => {
    const pair = cookiePair(
      new EmbedSessionCookies(SECRET, 900, ['crm', 'erp'], ALL_MAPPED).issue(AUTHORITY, IDENTITY)
        .setCookie,
    );
    expect(
      new EmbedSessionCookies(SECRET, 900, ['erp'], ALL_MAPPED).authenticate(headersWith(pair)),
    ).toBeUndefined();
  });

  it('從表上拿掉之後，手上沒到期的 cookie 下一次就驗不過；問表時帶的是 cookie 上的那組對應', () => {
    const asked: unknown[] = [];
    let mapped = true;
    const cookies = new EmbedSessionCookies(SECRET, 900, ['crm'], {
      has: (identity) => {
        asked.push({ ...identity });
        return mapped;
      },
    });
    const pair = cookiePair(cookies.issue(AUTHORITY, IDENTITY).setCookie);
    expect(cookies.authenticate(headersWith(pair))).toMatchObject({ userId: 'u-alice' });
    mapped = false;
    expect(cookies.authenticate(headersWith(pair))).toBeUndefined();
    expect(asked).toEqual([
      expect.objectContaining({ embedder: 'crm', subject: 'alice', userId: 'u-alice' }),
      expect.objectContaining({ embedder: 'crm', subject: 'alice', userId: 'u-alice' }),
    ]);
  });

  it('同一把密鑰：嵌入 cookie 的值放到獨立頁面的名字底下不是擁有者，反過來也不是嵌入身分', () => {
    const browser = new BrowserAuth(SECRET);
    const cookies = new EmbedSessionCookies(SECRET, 900, ['crm'], ALL_MAPPED);
    const embedPair = cookiePair(cookies.issue(AUTHORITY, IDENTITY).setCookie);
    const minted = browser.authorizeIndex(
      new Request(browser.authenticatedUrl(`http://${AUTHORITY}/`), {
        headers: { host: AUTHORITY },
      }),
    );
    const ownerPair = cookiePair(minted!.headers.get('set-cookie')!);
    const embedName = embedPair.split('=')[0]!;
    const embedValue = embedPair.slice(embedName.length + 1);
    const ownerName = ownerPair.split('=')[0]!;
    const ownerValue = ownerPair.slice(ownerName.length + 1);

    expect(browser.authenticate(headersWith(ownerPair))).toEqual({ kind: 'owner' });
    expect(browser.authenticate(headersWith(embedPair))).toBeUndefined();
    expect(browser.authenticate(headersWith(`${ownerName}=${embedValue}`))).toBeUndefined();
    expect(cookies.authenticate(headersWith(ownerPair))).toBeUndefined();
    expect(cookies.authenticate(headersWith(`${embedName}=${ownerValue}`))).toBeUndefined();
  });
});

const aliceOnly: EmbedIdentityResolver = {
  resolve: (_embedder, subject) =>
    subject === 'alice'
      ? { kind: 'accepted', userId: 'u-alice' }
      : { kind: 'rejected', reason: 'not_mapped' },
};

function setup(
  options: {
    identity?: EmbedIdentityResolver;
    tickets?: EmbedTicketStore;
    now?: () => number;
    latestThread?: EmbedSessionOptions['latestThread'];
    warn?: (line: string) => void;
  } = {},
) {
  const recorded = memoryAudit();
  const tickets = options.tickets ?? new EmbedTicketStore(60_000);
  const cookies = new EmbedSessionCookies(SECRET, 900, ['crm'], ALL_MAPPED, options.now);
  const session = createEmbedSession({
    tickets,
    cookies,
    identity: options.identity ?? aliceOnly,
    audit: recorded.audit,
    ...(options.latestThread !== undefined && { latestThread: options.latestThread }),
    ...(options.warn !== undefined && { warn: options.warn }),
  });
  const issue = (subject = 'alice') =>
    tickets.issue({ embedder: 'crm', subject, userId: 'u-alice', sessionIdSha256: 'h' })!.ticket;
  return { session, tickets, cookies, issue, ...recorded };
}

function redeem(
  init: {
    body?: unknown;
    rawBody?: string;
    method?: string;
    host?: string;
    contentType?: string;
  } = {},
): Request {
  const method = init.method ?? 'POST';
  return new Request(`http://${AUTHORITY}${EMBED_SESSION_PATH}`, {
    method,
    headers: {
      host: init.host ?? AUTHORITY,
      'content-type': init.contentType ?? 'application/json',
    },
    ...(method !== 'GET' &&
      method !== 'HEAD' && { body: init.rawBody ?? JSON.stringify(init.body ?? {}) }),
  });
}

describe('POST /embed/session', () => {
  it('兌換成功：200 帶到期時間與 Set-Cookie，那顆 cookie 驗得回票上的身分；稽核記一筆、不記票', async () => {
    const { session, cookies, issue, redeems } = setup({ now: () => 5_000 });
    const ticket = issue();
    const response = await session.handle(redeem({ body: { ticket } }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ expiresAt: 5_000 + 900_000 });
    const setCookie = response.headers.get('set-cookie')!;
    expect(cookies.authenticate(headersWith(cookiePair(setCookie)))).toMatchObject({
      kind: 'embed',
      userId: 'u-alice',
      embedder: 'crm',
    });
    expect(redeems).toEqual([
      {
        outcome: 'redeemed',
        embedder: 'crm',
        subject: 'alice',
        userId: 'u-alice',
        sessionIdSha256: 'h',
        cookieExpiresAt: new Date(5_000 + 900_000).toISOString(),
      },
    ]);
    expect(JSON.stringify(redeems)).not.toContain(ticket);
  });

  it('這一次登入開過對話：200 多帶最新那條的 threadId；問的是票上的身分與登入', async () => {
    const asked: unknown[] = [];
    const { session, issue } = setup({
      now: () => 5_000,
      latestThread: async (owner) => {
        asked.push(owner);
        return 't-latest';
      },
    });
    const response = await session.handle(redeem({ body: { ticket: issue() } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ expiresAt: 5_000 + 900_000, threadId: 't-latest' });
    expect(asked).toEqual([{ userId: 'u-alice', embedder: 'crm', loginSessionSha256: 'h' }]);
  });

  it('查最新那條失敗：兌換照常，不帶 threadId，講進伺服器日誌', async () => {
    const lines: string[] = [];
    const { session, issue } = setup({
      latestThread: async () => {
        throw new Error('磁碟讀不動');
      },
      warn: (line) => lines.push(line),
    });
    const response = await session.handle(redeem({ body: { ticket: issue() } }));
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty('threadId');
    expect(response.headers.get('set-cookie')).not.toBeNull();
    expect(lines.join('\n')).toContain('磁碟讀不動');
  });

  it('同一張票兌換第二次：401 ticket_invalid，不設 cookie，合併計數', async () => {
    const { session, issue, unattributed } = setup();
    const ticket = issue();
    expect((await session.handle(redeem({ body: { ticket } }))).status).toBe(200);
    const again = await session.handle(redeem({ body: { ticket } }));
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: 'ticket_invalid' });
    expect(again.headers.get('set-cookie')).toBeNull();
    expect(unattributed).toEqual(['redeem']);
  });

  it('沒有這張票與用過的票，回的一模一樣', async () => {
    const { session, issue } = setup();
    const ticket = issue();
    await session.handle(redeem({ body: { ticket } }));
    const used = await session.handle(redeem({ body: { ticket } }));
    const unknown = await session.handle(redeem({ body: { ticket: 'x'.repeat(43) } }));
    expect([used.status, await used.text()]).toEqual([unknown.status, await unknown.text()]);
  });

  it('票過期：401 ticket_expired，記一筆', async () => {
    let monotonic = 0;
    const tickets = new EmbedTicketStore(60_000, 1024, () => monotonic);
    const { session, issue, redeems } = setup({ tickets });
    const ticket = issue();
    monotonic += 60_000;
    const response = await session.handle(redeem({ body: { ticket } }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'ticket_expired' });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(redeems.map((record) => record.outcome)).toEqual(['ticket_expired']);
  });

  it('換票之後對應被撤掉：403 identity_rejected，不設 cookie，記原因', async () => {
    let mapped = true;
    const identity: EmbedIdentityResolver = {
      resolve: () =>
        mapped
          ? { kind: 'accepted', userId: 'u-alice' }
          : { kind: 'rejected', reason: 'not_mapped' },
    };
    const { session, issue, redeems } = setup({ identity });
    const ticket = issue();
    mapped = false;
    const response = await session.handle(redeem({ body: { ticket } }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'identity_rejected' });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(redeems).toMatchObject([{ outcome: 'identity_rejected', reason: 'not_mapped' }]);
  });

  it('換票之後對應到別人：403，原因是 user_changed', async () => {
    const identity: EmbedIdentityResolver = {
      resolve: () => ({ kind: 'accepted', userId: 'u-bob' }),
    };
    const { session, issue, redeems } = setup({ identity });
    const response = await session.handle(redeem({ body: { ticket: issue() } }));
    expect(response.status).toBe(403);
    expect(redeems).toMatchObject([{ outcome: 'identity_rejected', reason: 'user_changed' }]);
  });

  it.each([
    ['content-type 不是 JSON', { contentType: 'text/plain' }, 'content_type'],
    ['不是 JSON', { rawBody: '{' }, 'body_json'],
    ['沒有 ticket', { body: {} }, 'body_shape'],
    ['多欄位', { body: { ticket: 't', extra: 1 } }, 'body_shape'],
    ['ticket 不是字串', { body: { ticket: 1 } }, 'body_shape'],
    ['ticket 太長', { body: { ticket: 'a'.repeat(257) } }, 'body_shape'],
    ['本文超過上限', { rawBody: ' '.repeat(MAX_SESSION_BODY_BYTES + 1) }, 'body_too_large'],
  ])('本文不對（%s）：400，合併計數、不寫一筆一行', async (_name, init, reason) => {
    const { session, redeems, unattributed } = setup();
    const response = await session.handle(redeem(init));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'bad_request', reason });
    expect(redeems).toEqual([]);
    expect(unattributed).toEqual(['redeem']);
  });

  it('圍欄先於一切：Host 不是 loopback 回 403，票不會被用掉', async () => {
    const { session, tickets, issue, unattributed } = setup();
    const ticket = issue();
    const response = await session.handle(redeem({ body: { ticket }, host: 'evil.example' }));
    expect(response.status).toBe(403);
    expect(tickets.size).toBe(1);
    expect(unattributed).toEqual([]);
  });

  it('只收 POST', async () => {
    const { session } = setup();
    const response = await session.handle(redeem({ method: 'GET' }));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('稽核寫不進去：500，不設 cookie', async () => {
    const { session, issue, failNextWrite } = setup();
    const ticket = issue();
    failNextWrite();
    const response = await session.handle(redeem({ body: { ticket } }));
    expect(response.status).toBe(500);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('續期：同一個人再兌換一張新票，拿到一顆新的 cookie', async () => {
    let now = 0;
    const { session, issue } = setup({ now: () => now });
    const first = await session.handle(redeem({ body: { ticket: issue() } }));
    now += 600_000;
    const second = await session.handle(redeem({ body: { ticket: issue() } }));
    expect(second.status).toBe(200);
    expect(((await second.json()) as { expiresAt: number }).expiresAt).toBeGreaterThan(
      ((await first.json()) as { expiresAt: number }).expiresAt,
    );
    expect(second.headers.get('set-cookie')!.split('=', 1)[0]).toBe(
      first.headers.get('set-cookie')!.split('=', 1)[0],
    );
  });
});
