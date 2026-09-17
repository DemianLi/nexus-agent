/**
 * 瀏覽器信任圍欄的判準（#387）。
 *
 * 案例照抄 dsh `packages/client/connection/tests/api-request-trust.host.spec.ts`（`ddefc45`），
 * 拿掉 `trustedHosts` 那幾條（這一側沒有那個分支，見 `request-trust.ts` 的偏離）。
 * 線上四條路徑有沒有真的先過這道圍欄，在 `wire.test.ts`。
 */

import { describe, expect, it } from 'vitest';
import { isTrustedWireRequest } from './request-trust.js';

function trusted(headers: Record<string, string>): boolean {
  return isTrustedWireRequest(new Headers(headers));
}

describe('isTrustedWireRequest', () => {
  it('沒有瀏覽器標記的請求照樣要過 Host 那道——純 HTTP 的瀏覽器讀取什麼標記都不帶', () => {
    expect(trusted({ host: '127.0.0.1:3080' })).toBe(true);
    expect(trusted({ host: '192.168.1.5:3080' })).toBe(false);
    expect(trusted({ host: 'harness.example' })).toBe(false);
    expect(trusted({})).toBe(false);
  });

  it('loopback 的每種寫法都放行，有沒有 port、大小寫都一樣', () => {
    for (const host of [
      'localhost',
      'localhost:3080',
      '127.0.0.1',
      '127.0.0.1:3080',
      '127.8.9.10:80',
      '[::1]',
      '[::1]:3080',
      'LOCALHOST:3080',
    ]) {
      expect(trusted({ host, origin: `http://${host}` })).toBe(true);
    }
  });

  it('被 rebinding 的 Host 不信：攻擊者的網域指到了它不該到的 socket', () => {
    expect(
      trusted({
        host: 'evil.example:3080',
        origin: 'http://evil.example:3080',
        'sec-fetch-site': 'same-origin',
      }),
    ).toBe(false);
  });

  it('Host 是 loopback 也擋跨來源的瀏覽器標記', () => {
    expect(trusted({ host: '127.0.0.1:3080', origin: 'http://evil.example' })).toBe(false);
    expect(trusted({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' })).toBe(false);
    expect(trusted({ host: '127.0.0.1:3080', origin: 'null' })).toBe(false);
  });

  it('同源的瀏覽器請求放行，帶不帶 Origin 都一樣', () => {
    expect(
      trusted({
        host: 'localhost:3080',
        origin: 'http://localhost:3080',
        'sec-fetch-site': 'same-origin',
      }),
    ).toBe(true);
    expect(trusted({ host: 'localhost:3080', 'sec-fetch-site': 'same-origin' })).toBe(true);
  });

  it('Host 與 Origin 走 WHATWG 正規化比對（大小寫、預設 port）', () => {
    expect(trusted({ host: 'LocalHost:80', origin: 'http://localhost' })).toBe(true);
    expect(trusted({ host: 'localhost:3080', origin: 'http://localhost:3081' })).toBe(false);
  });

  it('壞掉或不是 loopback 的 authority 不信', () => {
    const markers = { 'sec-fetch-site': 'same-origin' };
    expect(trusted({ ...markers })).toBe(false);
    expect(trusted({ ...markers, host: '' })).toBe(false);
    expect(trusted({ ...markers, host: 'bad host' })).toBe(false);
    expect(trusted({ ...markers, host: '127.0.0.999' })).toBe(false);
    expect(trusted({ ...markers, host: '128.0.0.1' })).toBe(false);
  });
});
