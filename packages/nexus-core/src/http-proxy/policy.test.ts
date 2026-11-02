/**
 * 代理政策的解析與比對（[#746](https://github.com/DemianLi/nexus-agent/issues/746)）。
 * 移植自 dsh 的 `packages/util/http-proxy/tests/policy.spec.ts`（`477b4f4`），訊息換成中文。
 */

import { describe, expect, it } from 'vitest';

import {
  bypassesProxy,
  DIRECT_POLICY,
  isLoopbackHost,
  proxyForUrl,
  resolveProxyPolicy,
} from './policy.js';
import type { EnvLookup } from './policy.js';

const PROXY = 'http://127.0.0.1:7897';
const OTHER = 'http://127.0.0.1:8080';

/** 只回答有給的名字：大小寫要分開，跟真的環境一樣。 */
function env(values: Record<string, string>): EnvLookup {
  return {
    get: (name) => {
      const value = values[name];
      return value === undefined ? undefined : { value };
    },
  };
}

describe('本機位址不走代理', () => {
  const proxied = { httpProxy: PROXY, httpsProxy: PROXY, noProxy: '', source: 'env' } as const;

  // 放行清單只有四個字面項目給讀環境的消費者；只比它們的話，`127.0.0.0/8` 其餘的位址（包括 `127.0.0.53`
  // 那個解析器）會走代理，而代理可以替呼叫端連上它們。
  it.each([
    '127.0.0.1',
    '127.0.0.2',
    '127.0.0.53',
    '127.255.255.254',
    'localhost',
    'app.localhost',
    '[::1]',
    '[::ffff:127.0.0.1]',
    '0.0.0.0',
  ])('%s 永遠不走代理', (host) => {
    expect(proxyForUrl(proxied, new URL(`http://${host}:8080/`))).toBeUndefined();
  });

  it.each(['128.0.0.1', '10.0.0.5', '[::ffff:10.0.0.1]', 'notlocalhost', 'example.com'])(
    '%s 不是這台機器，照走代理',
    (host) => {
      expect(proxyForUrl(proxied, new URL(`http://${host}:8080/`))).toBe(PROXY);
    },
  );

  it('位元組超出範圍不會被當成本機', () => {
    expect(isLoopbackHost('127.999.1.1')).toBe(false);
    expect(isLoopbackHost('1270.0.0.1')).toBe(false);
  });

  it('IPv4-mapped 位址兩種寫法都認得', () => {
    expect(isLoopbackHost('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::ffff:7f00:1')).toBe(true);
    expect(isLoopbackHost('::ffff:10.0.0.1')).toBe(false);
    expect(isLoopbackHost('::ffff:a00:1')).toBe(false);
  });
});

describe('resolveProxyPolicy', () => {
  it('環境裡沒有代理就什麼都不解出來', () => {
    const { policy, diagnostics } = resolveProxyPolicy(env({}));
    expect(policy).toEqual(DIRECT_POLICY);
    expect(diagnostics).toEqual([]);
  });

  it('兩個協定都讀，放行清單併入本機項目', () => {
    const { policy } = resolveProxyPolicy(
      env({ HTTP_PROXY: PROXY, HTTPS_PROXY: OTHER, NO_PROXY: 'example.com' }),
    );
    expect(policy.httpProxy).toBe(PROXY);
    expect(policy.httpsProxy).toBe(OTHER);
    expect(policy.noProxy).toBe('example.com,localhost,127.0.0.1,::1,[::1]');
    expect(policy.source).toBe('env');
  });

  it('小寫的名字優先，跟 undici 一致', () => {
    const { policy } = resolveProxyPolicy(env({ http_proxy: PROXY, HTTP_PROXY: OTHER }));
    expect(policy.httpProxy).toBe(PROXY);
  });

  it('空白的小寫值當沒設，不會蓋住有值的大寫', () => {
    const { policy } = resolveProxyPolicy(env({ http_proxy: '   ', HTTP_PROXY: PROXY }));
    expect(policy.httpProxy).toBe(PROXY);
  });

  it('只設 https 變數時 http 維持直連', () => {
    // 退路只往一個方向走：只點名 HTTPS，就只代理這個協定。
    const { policy } = resolveProxyPolicy(env({ HTTPS_PROXY: PROXY }));
    expect(policy.httpProxy).toBeUndefined();
    expect(policy.httpsProxy).toBe(PROXY);
    expect(proxyForUrl(policy, new URL('http://example.com/'))).toBeUndefined();
    expect(proxyForUrl(policy, new URL('https://example.com/'))).toBe(PROXY);
  });

  it('ALL_PROXY 墊在兩個協定底下（Node 與 undici 都不讀它）', () => {
    const { policy } = resolveProxyPolicy(env({ ALL_PROXY: PROXY }));
    expect(policy.httpProxy).toBe(PROXY);
    expect(policy.httpsProxy).toBe(PROXY);
  });

  it('協定專屬的值贏過 ALL_PROXY', () => {
    const { policy } = resolveProxyPolicy(env({ ALL_PROXY: PROXY, HTTPS_PROXY: OTHER }));
    expect(policy.httpProxy).toBe(PROXY);
    expect(policy.httpsProxy).toBe(OTHER);
  });

  it('HTTPS 最後才退回 HTTP 的代理', () => {
    const { policy } = resolveProxyPolicy(env({ HTTP_PROXY: PROXY }));
    expect(policy.httpsProxy).toBe(PROXY);
  });

  it('放行清單是 * 就原樣保留', () => {
    const { policy } = resolveProxyPolicy(env({ HTTP_PROXY: PROXY, NO_PROXY: '*' }));
    expect(policy.noProxy).toBe('*');
  });

  it('使用者已經列了的本機項目不重複加', () => {
    const { policy } = resolveProxyPolicy(
      env({ HTTP_PROXY: PROXY, NO_PROXY: 'localhost, 127.0.0.1' }),
    );
    expect(policy.noProxy).toBe('localhost,127.0.0.1,::1,[::1]');
  });

  it('一個協定自己的值被拒，就維持直連而不是退回別的', () => {
    const { policy, diagnostics } = resolveProxyPolicy(
      env({ HTTPS_PROXY: 'socks5://127.0.0.1:1080', HTTP_PROXY: PROXY }),
    );
    expect(policy.httpProxy).toBe(PROXY);
    // 診斷說 HTTPS 直連，路由就得同意，不能借用使用者從沒替 HTTPS 指名的 HTTP 代理。
    expect(policy.httpsProxy).toBeUndefined();
    expect(proxyForUrl(policy, new URL('https://example.com/'))).toBeUndefined();
    expect(diagnostics[0]?.message).toContain('這個協定改直連');
  });

  it('自己的值格式錯，連 ALL_PROXY 也不退回', () => {
    const { policy } = resolveProxyPolicy(env({ HTTPS_PROXY: 'not a url', ALL_PROXY: PROXY }));
    expect(policy.httpProxy).toBe(PROXY);
    expect(policy.httpsProxy).toBeUndefined();
  });

  it('SOCKS 代理要報出來，不默默略過；訊息點名變數、不帶值', () => {
    const { policy, diagnostics } = resolveProxyPolicy(
      env({ HTTP_PROXY: 'socks5://user:secret@127.0.0.1:7890' }),
    );
    expect(policy).toEqual(DIRECT_POLICY);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.kind).toBe('socks');
    expect(diagnostics[0]?.message).toContain('SOCKS');
    expect(diagnostics[0]?.message).toContain('HTTP_PROXY');
    expect(diagnostics[0]?.message).not.toContain('secret');
  });

  it('解析不了的代理網址要報出來', () => {
    const { policy, diagnostics } = resolveProxyPolicy(env({ HTTP_PROXY: 'not a url' }));
    expect(policy).toEqual(DIRECT_POLICY);
    expect(diagnostics[0]?.kind).toBe('invalid');
    expect(diagnostics[0]?.origin).toBe('HTTP_PROXY');
  });

  it('協定既不是 http(s) 也不是 SOCKS 的也要報', () => {
    const { diagnostics } = resolveProxyPolicy(env({ HTTP_PROXY: 'ftp://proxy.example' }));
    expect(diagnostics[0]?.message).toContain('ftp://');
  });
});

describe('bypassesProxy', () => {
  const cases: [string, string, boolean][] = [
    ['example.com', 'http://example.com/a', true],
    ['example.com', 'http://sub.example.com/a', true],
    ['example.com', 'http://notexample.com/a', false],
    ['.example.com', 'http://sub.example.com/a', true],
    ['*.example.com', 'http://sub.example.com/a', true],
    ['example.com', 'http://example.com./a', true],
    ['*', 'http://anything.example/a', true],
    ['example.com:8080', 'http://example.com:8080/a', true],
    ['example.com:8080', 'http://example.com:9090/a', false],
    ['example.com:80', 'http://example.com/a', true],
    ['example.com:443', 'https://example.com/a', true],
    ['EXAMPLE.com', 'http://example.COM/a', true],
    ['localhost', 'http://localhost:3000/a', true],
    ['127.0.0.1', 'http://127.0.0.1:7777/a', true],
  ];
  it.each(cases)('放行 %j 對 %j 是 %s', (noProxy, url, expected) => {
    expect(bypassesProxy(noProxy, new URL(url))).toBe(expected);
  });

  it('裸的 IPv6 loopback 放行得了（undici 會把它讀成主機 ":"、埠 "1"）', () => {
    expect(bypassesProxy('::1', new URL('http://[::1]:3000/a'))).toBe(true);
  });

  it('有中括號的寫法也放行', () => {
    expect(bypassesProxy('[::1]', new URL('http://[::1]/a'))).toBe(true);
  });

  it('中括號 IPv6 項目的埠要比', () => {
    expect(bypassesProxy('[::1]:3000', new URL('http://[::1]:3000/a'))).toBe(true);
    expect(bypassesProxy('[::1]:3000', new URL('http://[::1]:4000/a'))).toBe(false);
  });

  it('不比對 CIDR，所以作業系統的放行清單要改寫成網域尾巴', () => {
    expect(bypassesProxy('10.0.0.0/8', new URL('http://10.1.2.3/a'))).toBe(false);
  });

  it('空白與只有括號的項目略過', () => {
    expect(bypassesProxy(' , , [ , .', new URL('http://example.com/a'))).toBe(false);
  });
});

describe('proxyForUrl', () => {
  const { policy } = resolveProxyPolicy(
    env({ HTTP_PROXY: PROXY, HTTPS_PROXY: OTHER, NO_PROXY: 'direct.example' }),
  );

  it('http 走 http 的代理', () => {
    expect(proxyForUrl(policy, new URL('http://example.com/'))).toBe(PROXY);
  });

  it('https 走 https 的代理', () => {
    expect(proxyForUrl(policy, new URL('https://example.com/'))).toBe(OTHER);
  });

  it('被放行的主機沒有代理', () => {
    expect(proxyForUrl(policy, new URL('https://direct.example/'))).toBeUndefined();
  });

  it('本機一律沒有代理', () => {
    expect(proxyForUrl(policy, new URL('http://127.0.0.1:9000/'))).toBeUndefined();
  });

  it('不是 http(s) 的協定沒有代理', () => {
    expect(proxyForUrl(policy, new URL('ws://example.com/'))).toBeUndefined();
  });

  it('直連政策下沒有代理', () => {
    expect(proxyForUrl(DIRECT_POLICY, new URL('https://example.com/'))).toBeUndefined();
  });
});
