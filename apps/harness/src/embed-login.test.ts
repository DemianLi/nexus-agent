/**
 * 嵌入換票的處理器與票（[#2370](https://github.com/DemianLi/nexus-agent/issues/2370)）：服務憑證、身分、一次性票、稽核。
 * 接線（設定列、憑證檔、路由、披露）在 `serve-embed-login.test.ts`。
 */

import { describe, expect, it } from 'vitest';

import { sessionIdDigest } from './embed-audit.js';
import { memoryAudit } from './embed-audit.fixture.js';
import {
  createEmbedLogin,
  EMBED_EXCHANGE_PATH,
  EmbedTicketStore,
  MAX_EXCHANGE_BODY_BYTES,
  rejectAllIdentities,
} from './embed-login.js';
import type { EmbedIdentityResolver } from './embed-login.js';

const CRM = 'c'.repeat(43);
const ERP = 'e'.repeat(43);

/** 對應表：`alice` 對到 `u-alice`，其他拒。 */
const aliceOnly: EmbedIdentityResolver = {
  resolve: (_embedder, subject) =>
    subject === 'alice'
      ? { kind: 'accepted', userId: 'u-alice' }
      : { kind: 'rejected', reason: 'not_mapped' },
};

function setup(
  identity: EmbedIdentityResolver = aliceOnly,
  tickets = new EmbedTicketStore(60_000),
) {
  const recorded = memoryAudit();
  const login = createEmbedLogin({
    embedders: [
      { id: 'crm', credential: CRM },
      { id: 'erp', credential: ERP },
    ],
    identity,
    tickets,
    audit: recorded.audit,
  });
  return { login, tickets, ...recorded };
}

function exchange(
  init: {
    credential?: string;
    authorization?: string;
    body?: unknown;
    rawBody?: string;
    method?: string;
    host?: string;
    contentType?: string;
  } = {},
): Request {
  const headers = new Headers({ host: init.host ?? '127.0.0.1:8787' });
  if (init.authorization !== undefined) headers.set('authorization', init.authorization);
  else if (init.credential !== undefined) headers.set('authorization', `Bearer ${init.credential}`);
  headers.set('content-type', init.contentType ?? 'application/json');
  const method = init.method ?? 'POST';
  return new Request(`http://127.0.0.1:8787${EMBED_EXCHANGE_PATH}`, {
    method,
    headers,
    ...(method !== 'GET' &&
      method !== 'HEAD' && {
        body: init.rawBody ?? JSON.stringify(init.body ?? { subject: 'alice', sessionId: 's-1' }),
      }),
  });
}

describe('服務憑證', () => {
  it('缺憑證、憑證錯、不是 Bearer 的形狀：同一種 401、同一個本文，不記成任何嵌入方', async () => {
    const { login, records, unauthenticatedCount } = setup();
    const responses = await Promise.all([
      login.handle(exchange()),
      login.handle(exchange({ credential: 'x'.repeat(43) })),
      login.handle(exchange({ credential: CRM.slice(0, 42) })),
      login.handle(exchange({ authorization: `Basic ${CRM}` })),
      login.handle(exchange({ authorization: `Bearer ${CRM} extra` })),
      login.handle(exchange({ authorization: 'Bearer ' })),
    ]);
    const shapes = await Promise.all(
      responses.map(async (response) => [response.status, await response.text()]),
    );
    expect(new Set(shapes.map((shape) => JSON.stringify(shape)))).toEqual(
      new Set([JSON.stringify([401, 'unauthorized'])]),
    );
    expect(records).toEqual([]);
    expect(unauthenticatedCount()).toBe(6);
  });

  it('憑證決定是哪一個嵌入方：兩把各自記成自己的', async () => {
    const { login, records } = setup();
    expect((await login.handle(exchange({ credential: CRM }))).status).toBe(200);
    expect((await login.handle(exchange({ credential: ERP }))).status).toBe(200);
    expect(records.map((record) => record.embedder)).toEqual(['crm', 'erp']);
  });

  it('圍欄先於憑證：Host 不是 loopback 回 403，不計成憑證錯', async () => {
    const { login, unauthenticatedCount } = setup();
    const response = await login.handle(exchange({ credential: CRM, host: 'evil.example' }));
    expect(response.status).toBe(403);
    expect(unauthenticatedCount()).toBe(0);
  });

  it('只收 POST', async () => {
    const { login } = setup();
    const response = await login.handle(exchange({ credential: CRM, method: 'GET' }));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });
});

describe('身分', () => {
  it('出廠的 rejectAllIdentities：憑證對也換不到票，回 403 並記一筆', async () => {
    const { login, records, tickets } = setup(rejectAllIdentities);
    const response = await login.handle(exchange({ credential: CRM }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'identity_rejected' });
    expect(tickets.size).toBe(0);
    expect(records).toEqual([
      {
        outcome: 'identity_rejected',
        embedder: 'crm',
        subject: 'alice',
        sessionIdSha256: sessionIdDigest('s-1'),
        reason: 'identity_mapping_unavailable',
      },
    ]);
  });

  it('對不上帳號：403，記下對方帳號與原因', async () => {
    const { login, records } = setup();
    const response = await login.handle(
      exchange({ credential: CRM, body: { subject: 'mallory', sessionId: 's-9' } }),
    );
    expect(response.status).toBe(403);
    expect(records[0]).toMatchObject({
      outcome: 'identity_rejected',
      subject: 'mallory',
      reason: 'not_mapped',
    });
  });
});

describe('換票', () => {
  it('發票：200 帶票與到期時間；稽核記對應到的身分與 session id 的雜湊，不記原文與票', async () => {
    const { login, records, tickets } = setup();
    const response = await login.handle(exchange({ credential: CRM }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as { ticket: string; expiresAt: number };
    expect(body.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    expect(records).toEqual([
      {
        outcome: 'issued',
        embedder: 'crm',
        subject: 'alice',
        userId: 'u-alice',
        sessionIdSha256: sessionIdDigest('s-1'),
      },
    ]);
    expect(JSON.stringify(records)).not.toContain('s-1"');
    expect(JSON.stringify(records)).not.toContain(body.ticket);
    expect(tickets.redeem(body.ticket)).toMatchObject({
      kind: 'redeemed',
      grant: { userId: 'u-alice', embedder: 'crm' },
    });
  });

  it('續期：同一個 session id 再換一次，拿到另一張票，兩張都記', async () => {
    const { login, records } = setup();
    const first = (await (await login.handle(exchange({ credential: CRM }))).json()) as {
      ticket: string;
    };
    const second = (await (await login.handle(exchange({ credential: CRM }))).json()) as {
      ticket: string;
    };
    expect(second.ticket).not.toBe(first.ticket);
    expect(records.map((record) => record.sessionIdSha256)).toEqual([
      sessionIdDigest('s-1'),
      sessionIdDigest('s-1'),
    ]);
  });

  it.each([
    ['content-type 不是 JSON', { contentType: 'text/plain' }, 'content_type'],
    ['不是 JSON', { rawBody: '{' }, 'body_json'],
    ['少欄位', { body: { subject: 'alice' } }, 'body_shape'],
    ['多欄位', { body: { subject: 'alice', sessionId: 's', extra: 1 } }, 'body_shape'],
    ['空字串', { body: { subject: '', sessionId: 's' } }, 'body_shape'],
    ['太長', { body: { subject: 'a'.repeat(257), sessionId: 's' } }, 'body_shape'],
    ['本文超過上限', { rawBody: ' '.repeat(MAX_EXCHANGE_BODY_BYTES + 1) }, 'body_too_large'],
  ])('本文不對（%s）：400 並記一筆', async (_name, init, reason) => {
    const { login, records, tickets } = setup();
    const response = await login.handle(exchange({ credential: CRM, ...init }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'bad_request', reason });
    expect(records).toMatchObject([{ outcome: 'bad_request', embedder: 'crm', reason }]);
    expect(tickets.size).toBe(0);
  });

  it('在手的票滿了：503 並記一筆', async () => {
    const { login, records } = setup(aliceOnly, new EmbedTicketStore(60_000, 1));
    expect((await login.handle(exchange({ credential: CRM }))).status).toBe(200);
    const response = await login.handle(exchange({ credential: CRM }));
    expect(response.status).toBe(503);
    expect(records.map((record) => record.outcome)).toEqual(['issued', 'capacity']);
  });

  it('稽核寫不進去：500，不回票，剛發的那張作廢', async () => {
    const { login, tickets, failNextWrite } = setup();
    failNextWrite();
    const response = await login.handle(exchange({ credential: CRM }));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/[A-Za-z0-9_-]{43}/u);
    expect(tickets.size).toBe(0);
  });
});

describe('EmbedTicketStore', () => {
  const grant = { embedder: 'crm', subject: 'alice', userId: 'u-alice', sessionIdSha256: 'h' };

  it('只能兌換一次', () => {
    const store = new EmbedTicketStore(60_000);
    const issued = store.issue(grant)!;
    expect(store.redeem(issued.ticket)).toMatchObject({ kind: 'redeemed', grant });
    expect(store.redeem(issued.ticket)).toEqual({ kind: 'unknown' });
    expect(store.redeem('not-a-ticket')).toEqual({ kind: 'unknown' });
  });

  it('兩個請求同時兌換同一張票，只有一個拿到', async () => {
    const store = new EmbedTicketStore(60_000);
    const issued = store.issue(grant)!;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => Promise.resolve().then(() => store.redeem(issued.ticket))),
    );
    expect(results.filter((result) => result.kind === 'redeemed')).toHaveLength(1);
  });

  it('過期的票兌換不到、分得出是過期，而且會從記憶體清掉', () => {
    let now = 1_000;
    const store = new EmbedTicketStore(60_000, 1024, () => now);
    const stale = store.issue(grant)!;
    store.issue(grant);
    now += 60_000;
    expect(store.redeem(stale.ticket)).toMatchObject({ kind: 'expired', grant });
    expect(store.size).toBe(0);
  });

  it('系統時間往回調：到期照單調時鐘判，過期的票照樣清掉', () => {
    let monotonic = 0;
    let wall = Date.UTC(2026, 10, 6);
    const store = new EmbedTicketStore(
      1_000,
      1024,
      () => monotonic,
      () => wall,
    );
    const first = store.issue(grant)!;
    expect(first.expiresAt).toBe(wall + 1_000);
    monotonic += 500;
    wall -= 3_600_000;
    store.issue(grant);
    monotonic += 2_000;
    store.issue(grant);
    expect(store.size).toBe(1);
    expect(store.redeem(first.ticket)).toEqual({ kind: 'unknown' });
  });

  it('發新票時先清過期的：不兌換的票不會無限累積', () => {
    let now = 0;
    const store = new EmbedTicketStore(1_000, 4, () => now);
    for (let round = 0; round < 100; round += 1) {
      expect(store.issue(grant)).toBeDefined();
      now += 400;
    }
    expect(store.size).toBeLessThanOrEqual(3);
  });

  it('還沒過期的票到上限就不再發', () => {
    const store = new EmbedTicketStore(60_000, 2);
    expect(store.issue(grant)).toBeDefined();
    expect(store.issue(grant)).toBeDefined();
    expect(store.issue(grant)).toBeUndefined();
  });
});
