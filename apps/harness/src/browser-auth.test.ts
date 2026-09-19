/**
 * 行程 token 的交換與簽章 cookie 的驗證（#424）。案例照 dsh
 * `packages/client/connection/tests/browser-auth.host.spec.ts`（`ddefc45`）逐條移植；密鑰的載入
 * 另外在 `browser-session-secret.test.ts`。
 */

import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_SESSION_MAX_AGE_DAYS, BrowserAuth } from './browser-auth.js';

const SECRET = Buffer.alloc(32, 3);
const AUTHORITY = '127.0.0.1:3080';
const UNAUTHORIZED_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'text/plain; charset=utf-8',
};

function request(
  path: string,
  authority = AUTHORITY,
  init: { readonly cookie?: string; readonly method?: string } = {},
): Request {
  return new Request(new URL(path, `http://${authority}`), {
    method: init.method ?? 'GET',
    headers: { host: authority, ...(init.cookie === undefined ? {} : { cookie: init.cookie }) },
  });
}

function headers(authority: string | undefined, cookie?: string): Headers {
  const result = new Headers();
  if (authority !== undefined) result.set('host', authority);
  if (cookie !== undefined) result.set('cookie', cookie);
  return result;
}

function exchange(
  auth: BrowserAuth,
  authority = AUTHORITY,
): { readonly cookie: string; readonly launchUrl: string; readonly response: Response } {
  const launchUrl = auth.authenticatedUrl(`http://${authority}`);
  const response = auth.authorizeIndex(request(launchUrl, authority));
  const setCookie = response?.headers.get('set-cookie');
  if (response === undefined || setCookie === null || setCookie === undefined) {
    throw new Error('token 交換沒有換到 cookie');
  }
  return { cookie: setCookie.split(';', 1)[0]!, launchUrl, response };
}

function signedBodyCookie(name: string, body: string): string {
  return `${name}=v1.${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`;
}

function signedCookie(name: string, payload: unknown): string {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return signedBodyCookie(name, Buffer.from(text, 'utf8').toString('base64url'));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('BrowserAuth', () => {
  it('一個行程一個 token，換到的是綁 authority、跨重啟有效的 cookie', () => {
    const first = new BrowserAuth(SECRET);
    const login = exchange(first);

    expect(login.response.status).toBe(303);
    expect(login.response.headers.get('cache-control')).toBe('no-store');
    expect(login.response.headers.get('location')).toBe('/');
    expect(login.response.headers.get('referrer-policy')).toBe('no-referrer');
    const setCookie = login.response.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^nexus-auth-[A-Za-z0-9_-]+=v1\./);
    expect(setCookie).toMatch(
      /; Max-Age=2592000; Path=\/; Expires=.*; HttpOnly; SameSite=Strict$/u,
    );
    expect(setCookie).not.toContain('Secure');
    expect(setCookie).not.toContain('Domain');
    expect(BROWSER_SESSION_MAX_AGE_DAYS * 24 * 60 * 60).toBe(2592000);

    expect(first.isAuthenticated(headers(AUTHORITY, login.cookie))).toBe(true);
    expect(first.isAuthenticated(new Headers())).toBe(false);
    // 同一台機器、別的名字或別的 port：cookie 不分 port，所以綁的是 authority。
    expect(first.isAuthenticated(headers('localhost:3080', login.cookie))).toBe(false);
    expect(first.isAuthenticated(headers('127.0.0.1:3081', login.cookie))).toBe(false);

    // 同一把密鑰、新的行程：token 換了，cookie 照樣有效。
    const restarted = new BrowserAuth(SECRET);
    expect(
      new URL(restarted.authenticatedUrl(`http://${AUTHORITY}`)).searchParams.get('token'),
    ).not.toBe(new URL(login.launchUrl).searchParams.get('token'));
    expect(restarted.isAuthenticated(headers(AUTHORITY, login.cookie))).toBe(true);

    // 舊 token 配上有效 cookie：只轉回乾淨的 `/`，不再發 cookie。
    const cleaned = restarted.authorizeIndex(
      request(login.launchUrl, AUTHORITY, { cookie: login.cookie }),
    );
    expect(cleaned?.status).toBe(303);
    expect(cleaned?.headers.get('location')).toBe('/');
    expect(cleaned?.headers.get('cache-control')).toBe('no-store');
    expect(cleaned?.headers.get('referrer-policy')).toBe('no-referrer');
    expect(cleaned?.headers.get('set-cookie')).toBeNull();

    // 舊 token 沒有 cookie：401。
    expect(restarted.authorizeIndex(request(login.launchUrl))?.status).toBe(401);
  });

  it('有 cookie 就給 index；其他每一種都拿同一個最小的 401', async () => {
    const auth = new BrowserAuth(SECRET);
    const { cookie, launchUrl } = exchange(auth);
    expect(auth.authorizeIndex(request('/index.html', AUTHORITY, { cookie }))).toBeUndefined();
    expect(auth.authorizeIndex(request('/', AUTHORITY, { cookie }))).toBeUndefined();

    const token = new URL(launchUrl).searchParams.get('token') ?? '';
    const candidates: readonly Request[] = [
      request('/'),
      request('/index.html'),
      request('/?token=wrong'),
      request('/?token=wrong&token=again'),
      request(`/?token=${token}&token=${token}`),
      request(`/index.html?token=${token}`),
      request(launchUrl, AUTHORITY, { method: 'HEAD' }),
      request(launchUrl, AUTHORITY, { method: 'POST' }),
      new Request(launchUrl),
    ];
    for (const candidate of candidates) {
      const denied = auth.authorizeIndex(candidate);
      expect(denied?.status).toBe(401);
      expect(Object.fromEntries(denied?.headers.entries() ?? [])).toEqual(UNAUTHORIZED_HEADERS);
      const body = await denied?.text();
      if (candidate.method === 'HEAD') expect(body).toBe('');
      else expect(body).toContain('在瀏覽器開 serve 啟動時印出的那個網址');
    }
  });

  it('改過、過期、未來才簽發、比設定的期限長的 cookie 一律不認', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T00:00:00.000Z'));
    const auth = new BrowserAuth(SECRET);
    const { cookie } = exchange(auth);
    const [name, value] = cookie.split('=') as [string, string];

    expect(auth.isAuthenticated(headers(AUTHORITY, `${name}=broken`))).toBe(false);
    expect(auth.isAuthenticated(headers(AUTHORITY, `${name}=${value.slice(0, -1)}x`))).toBe(false);
    expect(auth.isAuthenticated(headers(AUTHORITY, `${name}=%`))).toBe(false);
    expect(auth.isAuthenticated(headers(AUTHORITY, signedBodyCookie(name, 'a')))).toBe(false);
    expect(auth.isAuthenticated(headers(undefined, cookie))).toBe(false);
    expect(auth.isAuthenticated(headers('bad host', cookie))).toBe(false);
    expect(auth.isAuthenticated(headers(AUTHORITY))).toBe(false);

    const now = Date.now();
    const invalidPayloads: unknown[] = [
      'not json',
      null,
      { version: 2, authority: AUTHORITY, issuedAt: now, expiresAt: now + 1000 },
      { version: 1, authority: 42, issuedAt: now, expiresAt: now + 1000 },
      { version: 1, authority: AUTHORITY, issuedAt: 'now', expiresAt: now + 1000 },
      { version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: 'later' },
      { version: 1, authority: 'localhost:3080', issuedAt: now, expiresAt: now + 1000 },
      { version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: now },
    ];
    for (const payload of invalidPayloads) {
      expect(auth.isAuthenticated(headers(AUTHORITY, signedCookie(name, payload)))).toBe(false);
    }
    // 對照：同一個簽法、合格的 payload 會過——上面那幾條紅的是 payload，不是簽法。
    expect(
      auth.isAuthenticated(
        headers(
          AUTHORITY,
          signedCookie(name, {
            version: 1,
            authority: AUTHORITY,
            issuedAt: now,
            expiresAt: now + 1000,
          }),
        ),
      ),
    ).toBe(true);

    // 別把密鑰簽的。
    const foreign = exchange(new BrowserAuth(Buffer.alloc(32, 4)));
    expect(auth.isAuthenticated(headers(AUTHORITY, foreign.cookie))).toBe(false);

    // 過期的邊界精確到毫秒：到期前一毫秒還認，到期那一刻就不認。
    const boundary = new BrowserAuth(SECRET);
    vi.setSystemTime(new Date('2026-09-19T00:00:00.000Z'));
    const issued = exchange(boundary).cookie;
    vi.setSystemTime(new Date('2026-10-18T23:59:59.999Z'));
    expect(boundary.isAuthenticated(headers(AUTHORITY, issued))).toBe(true);
    vi.setSystemTime(new Date('2026-10-19T00:00:00.000Z'));
    expect(boundary.isAuthenticated(headers(AUTHORITY, issued))).toBe(false);
    vi.setSystemTime(new Date('2026-09-19T00:00:00.000Z'));

    // 設定的期限比 cookie 帶的短：不認。
    expect(new BrowserAuth(SECRET, 1).isAuthenticated(headers(AUTHORITY, cookie))).toBe(false);
    // 過期。
    vi.setSystemTime(new Date('2026-10-20T00:00:00.000Z'));
    expect(auth.isAuthenticated(headers(AUTHORITY, cookie))).toBe(false);
    // 未來才簽發。
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    expect(auth.isAuthenticated(headers(AUTHORITY, cookie))).toBe(false);
  });

  it('帶 token 的網址只留根路徑與 token', () => {
    const auth = new BrowserAuth(SECRET);
    const url = new URL(auth.authenticatedUrl('http://127.0.0.1:8787/some/path?x=1#frag'));
    expect(url.pathname).toBe('/');
    expect(url.hash).toBe('');
    expect([...url.searchParams.keys()]).toEqual(['token']);
    expect(url.searchParams.get('token')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('期限換算成毫秒超出安全整數就拒絕建立', () => {
    expect(() => new BrowserAuth(SECRET, Number.MAX_SAFE_INTEGER)).toThrow(/安全的時間戳範圍/);
  });
});
