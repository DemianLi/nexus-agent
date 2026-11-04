/**
 * 瀏覽器信任圍欄的判準（#387）。
 *
 * 線上四條路徑有沒有真的先過這道圍欄，在 `wire.test.ts`。
 * 檔尾三組（#2369）：指名的公開 authority（`trustedHosts`）、Origin 依自己的 scheme 比對、`assertTrustedAuthority`。
 */

import { describe, expect, it } from 'vitest';
import { assertTrustedAuthority, isTrustedWireRequest } from './request-trust.js';

function trusted(headers: Record<string, string>, trustedHosts: readonly string[] = []): boolean {
  return isTrustedWireRequest(new Headers(headers), trustedHosts);
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

describe('isTrustedWireRequest：指名的公開 authority（#2369）', () => {
  it('帶 port 的條目要 port 也對上，不帶 port 的條目任何 port 都算', () => {
    const headers = { host: 'harness.internal:3080', origin: 'http://harness.internal:3080' };
    expect(trusted(headers, ['harness.internal:3080'])).toBe(true);
    expect(trusted(headers, ['harness.internal'])).toBe(true);
    expect(trusted(headers, ['harness.internal:9999'])).toBe(false);
    expect(trusted(headers, [])).toBe(false);
    expect(trusted({ host: '192.168.1.5:3080' }, ['192.168.1.5'])).toBe(true);
    // 不帶 port 的條目只放寬 port，hostname 照樣要對上。
    expect(trusted({ host: 'evil.example:3080' }, ['harness.internal'])).toBe(false);
    expect(trusted({ host: 'evil.example' }, ['harness.internal', 'harness.internal:3080'])).toBe(
      false,
    );
  });

  it('Host、Origin 與條目都走 WHATWG 正規化；解析不了的條目不比、也不影響其他條目', () => {
    expect(
      trusted({ host: 'Harness.INTERNAL:3080', origin: 'http://harness.internal:3080' }, [
        'harness.internal:3080',
      ]),
    ).toBe(true);
    const plain = { host: 'harness.internal', origin: 'http://harness.internal' };
    expect(trusted(plain, ['HARNESS.internal:80'])).toBe(true);
    expect(trusted(plain, ['bad entry', 'harness.internal'])).toBe(true);
    expect(trusted(plain, ['bad entry'])).toBe(false);
  });

  it('條目尾巴多一個空白，也不會把指定 port 放寬成任何 port', () => {
    const entries = ['harness.internal:3080 '];
    expect(
      trusted({ host: 'harness.internal:9999', origin: 'http://harness.internal:9999' }, entries),
    ).toBe(false);
    expect(
      trusted({ host: 'harness.internal:3080', origin: 'http://harness.internal:3080' }, entries),
    ).toBe(true);
  });

  it('指名了也照樣擋跨站標記與不同源的 Origin', () => {
    const entries = ['harness.internal'];
    expect(
      trusted(
        {
          host: 'harness.internal',
          origin: 'https://harness.internal',
          'sec-fetch-site': 'cross-site',
        },
        entries,
      ),
    ).toBe(false);
    expect(trusted({ host: 'harness.internal', origin: 'https://evil.example' }, entries)).toBe(
      false,
    );
  });
});

describe('isTrustedWireRequest：Origin 依自己的 scheme 比對 Host（#2369）', () => {
  const entries = ['harness.internal'];

  it('前面是終止 TLS 的代理：https 的 Origin 對上沒寫 port 或寫 443 的 Host', () => {
    expect(trusted({ host: 'harness.internal', origin: 'https://harness.internal' }, entries)).toBe(
      true,
    );
    expect(
      trusted({ host: 'harness.internal:443', origin: 'https://harness.internal' }, entries),
    ).toBe(true);
    expect(
      trusted({ host: 'harness.internal', origin: 'https://harness.internal:443' }, entries),
    ).toBe(true);
    expect(
      trusted({ host: 'harness.internal:80', origin: 'http://harness.internal' }, entries),
    ).toBe(true);
  });

  it('hostname 或 port 真的不同，兩個方向都不信', () => {
    expect(
      trusted({ host: 'harness.internal:443', origin: 'https://harness.internal:444' }, entries),
    ).toBe(false);
    expect(
      trusted({ host: 'harness.internal:80', origin: 'https://harness.internal' }, entries),
    ).toBe(false);
    expect(
      trusted({ host: 'harness.internal:443', origin: 'http://harness.internal' }, entries),
    ).toBe(false);
  });

  it('只有 http(s) 的 Origin 能指到這台；其他 scheme 與 null 都不信', () => {
    for (const origin of [
      'ftp://harness.internal',
      'file://harness.internal',
      'ws://harness.internal',
      'null',
    ]) {
      expect(trusted({ host: 'harness.internal', origin }, entries), origin).toBe(false);
    }
  });
});

describe('assertTrustedAuthority', () => {
  it('收裸的 host[:port]', () => {
    for (const entry of [
      'harness.internal',
      'harness.internal:3080',
      'HARNESS.internal:80',
      '10.0.0.9',
      '[::1]:3080',
    ]) {
      expect(() => assertTrustedAuthority(entry), entry).not.toThrow();
    }
  });

  it('解析時會被悄悄改寫的寫法一律拒收：多了路徑或帳號、前後空白、空的或補零的 port、非正規的位址', () => {
    for (const entry of [
      'harness.internal/path',
      'harness.internal/',
      'user@harness.internal',
      'harness.internal?x',
      'harness.internal#f',
      'harness.internal\\path',
      'bad entry',
      '',
      'harness.internal:3080 ',
      ' harness.internal',
      'harness.internal:30\t80',
      'harness.internal:',
      '[::1]:',
      'harness.internal:0080',
      '0x7f.0.0.1',
      '[0:0:0:0:0:0:0:1]',
    ]) {
      expect(() => assertTrustedAuthority(entry), JSON.stringify(entry)).toThrow(/host\[:port\]/);
    }
  });
});
