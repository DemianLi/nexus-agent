/**
 * 代理的安裝：真的 `fetch` 到不到假代理（[#746](https://github.com/DemianLi/nexus-agent/issues/746)）。
 * 移植自 dsh 的 `packages/util/http-proxy/tests/install.spec.ts` 與 `matcher-parity.spec.ts`（`477b4f4`）。
 *
 * **只驗「有呼叫設定函式」不算**：每一條都讓內建的全域 `fetch` 打出去，看假代理有沒有收到。
 * dsh 的 `proxyRouteFor` 我們沒有，所以那組換成直接看全域派送器。
 */

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getGlobalDispatcher } from 'undici';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { installProxyFromEnvironment, proxyEnvironmentForChild } from './install.js';
import { POLICY_ENV_NAMES, proxyForUrl, resolveProxyPolicy } from './policy.js';
import type { EnvLookup } from './policy.js';

/** 假代理收到的絕對形式請求目標；有東西就證明請求走了隧道。 */
let proxied: string[] = [];
let proxy: Server;
let origin: Server;
let proxyUrl: string;
let originUrl: string;

/**
 * 每個「走隧道」斷言的目標。**刻意不是本機**：任何政策都不會讓本機走代理，本機目標只能證明直連。
 * 這個主機不會解析——客戶端連的是代理，由它回答絕對形式的請求。
 */
const proxyTarget = 'http://origin.test/probe';

const PROXY_NAMES = [
  ...Object.values(POLICY_ENV_NAMES).flat(),
  'all_proxy',
  'ALL_PROXY',
  'NODE_USE_ENV_PROXY',
];

function listen(server: Server): Promise<AddressInfo> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(server.address() as AddressInfo);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

beforeAll(async () => {
  proxy = createServer((request, response) => {
    proxied.push(`${request.method ?? ''} ${request.url ?? ''}`);
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('VIA-PROXY');
  });
  proxy.on('connect', (request, socket) => {
    proxied.push(`CONNECT ${request.url ?? ''}`);
    socket.end();
  });
  origin = createServer((_request, response) => {
    response.end('DIRECT');
  });
  const [proxyAddress, originAddress] = await Promise.all([listen(proxy), listen(origin)]);
  proxyUrl = `http://127.0.0.1:${String(proxyAddress.port)}`;
  originUrl = `http://127.0.0.1:${String(originAddress.port)}/probe`;
});

afterAll(async () => {
  await Promise.all([close(proxy), close(origin)]);
});

afterEach(() => {
  proxied = [];
});

/** 從不撥號的第二個代理網址：只需要在斷言裡跟 {@link proxyUrl} 不同。 */
const nestedUrl = 'http://127.0.0.1:9';

function env(values: Record<string, string>): EnvLookup {
  return {
    get: (name) => {
      const value = values[name];
      return value === undefined ? undefined : { value };
    },
  };
}

/** 使用者替兩個協定匯出同一個代理。 */
function proxyAll(noProxy?: string): EnvLookup {
  return env({
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ...(noProxy === undefined ? {} : { NO_PROXY: noProxy }),
  });
}

/** 安裝並收集解析回報的訊息，讓一條測試兩件事都能斷言。 */
async function install(
  lookup: EnvLookup,
): Promise<{ dispose: () => Promise<void>; reported: string[] }> {
  const reported: string[] = [];
  const dispose = await installProxyFromEnvironment(lookup, (message) => {
    reported.push(message);
  });
  return { dispose, reported };
}

/** 從空的代理環境跑一條測試，跑完還原這台機器原有的。 */
async function withCleanProxyEnv(run: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(PROXY_NAMES.map((name) => [name, process.env[name]]));
  for (const name of PROXY_NAMES) Reflect.deleteProperty(process.env, name);
  try {
    await run();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }
}

describe('installProxyFromEnvironment', () => {
  it('內建的全域 fetch 走代理', async () => {
    await withCleanProxyEnv(async () => {
      const { dispose } = await install(proxyAll());
      try {
        await expect((await fetch(proxyTarget)).text()).resolves.toBe('VIA-PROXY');
        expect(proxied).toEqual([`GET ${proxyTarget}`]);
      } finally {
        await dispose();
      }
    });
  });

  it('放行清單蓋到目標時直連', async () => {
    await withCleanProxyEnv(async () => {
      const { dispose } = await install(env({ HTTP_PROXY: proxyUrl, NO_PROXY: 'origin.test' }));
      try {
        await expect(fetch(proxyTarget, { signal: AbortSignal.timeout(1500) })).rejects.toThrow();
        expect(proxied).toEqual([]);
      } finally {
        await dispose();
      }
    });
  });

  it('用不了的值報出來、其餘照裝；訊息點名變數、不含值', async () => {
    await withCleanProxyEnv(async () => {
      const { dispose, reported } = await install(
        env({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: 'socks5://127.0.0.1:1080' }),
      );
      try {
        expect(reported).toHaveLength(1);
        expect(reported[0]).toContain('HTTPS_PROXY');
        expect(reported[0]).toContain('SOCKS');
        expect(reported[0]).not.toContain('1080');
        await expect((await fetch(proxyTarget)).text()).resolves.toBe('VIA-PROXY');
      } finally {
        await dispose();
      }
    });
  });

  it('把政策用兩種大小寫寫進代理環境變數', async () => {
    await withCleanProxyEnv(async () => {
      const { dispose } = await install(proxyAll('example.com'));
      try {
        expect(process.env.http_proxy).toBe(proxyUrl);
        expect(process.env.HTTP_PROXY).toBe(proxyUrl);
        expect(process.env.no_proxy).toContain('example.com');
        expect(process.env.NO_PROXY).toContain('example.com');
      } finally {
        await dispose();
      }
    });
  });

  it('政策沒有設的名字會被移除，收尾時還原', async () => {
    await withCleanProxyEnv(async () => {
      process.env.HTTPS_PROXY = 'http://stale.example';
      // 使用者沒有為 HTTPS 指名可用的代理（只有被拒的 SOCKS），所以名字被移除，不留著上一個行程的值。
      const { dispose } = await install(
        env({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: 'socks5://127.0.0.1:1080' }),
      );
      try {
        expect(process.env.HTTPS_PROXY).toBeUndefined();
      } finally {
        await dispose();
        expect(process.env.HTTPS_PROXY).toBe('http://stale.example');
      }
    });
  });

  it('收尾時還原派送器與環境，之後的 fetch 直連', async () => {
    await withCleanProxyEnv(async () => {
      const before = getGlobalDispatcher();
      const beforeEnv = process.env.HTTP_PROXY;
      const { dispose } = await install(proxyAll());
      expect(getGlobalDispatcher()).not.toBe(before);
      await dispose();
      expect(getGlobalDispatcher()).toBe(before);
      expect(process.env.HTTP_PROXY).toBe(beforeEnv);
      await expect((await fetch(originUrl)).text()).resolves.toBe('DIRECT');
    });
  });

  it('使用者什麼都沒匯出：不裝派送器、不動環境', async () => {
    await withCleanProxyEnv(async () => {
      const before = getGlobalDispatcher();
      process.env.HTTP_PROXY = 'http://untouched.example';
      const { dispose, reported } = await install(env({}));
      try {
        expect(getGlobalDispatcher()).toBe(before);
        expect(process.env.HTTP_PROXY).toBe('http://untouched.example');
        expect(reported).toEqual([]);
        expect(proxyEnvironmentForChild()).toEqual({});
      } finally {
        await dispose();
      }
    });
  });

  it('被拒的協定維持直連：不會借用另一個協定的代理', async () => {
    await withCleanProxyEnv(async () => {
      // `HTTPS_PROXY=socks5://…` 加 `HTTP_PROXY=http://p` 解成 http 走代理、https 直連。
      // undici 自己的 EnvHttpProxyAgent 表達不出來：沒有 HTTPS 代理時它會重用 HTTP 的。
      const { dispose } = await install(
        env({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: 'socks5://127.0.0.1:1080' }),
      );
      try {
        await expect(
          fetch('https://refused-scheme.invalid/', { signal: AbortSignal.timeout(1500) }),
        ).rejects.toThrow();
        expect(proxied).toEqual([]);
        // 同一份政策仍然讓 http 走隧道，所以上面那個空的斷言不是空轉。
        await expect((await fetch(proxyTarget)).text()).resolves.toBe('VIA-PROXY');
        expect(proxied).toEqual([`GET ${proxyTarget}`]);
      } finally {
        await dispose();
      }
    });
  });

  it('本機目標在「全部走代理」的政策下也直連', async () => {
    await withCleanProxyEnv(async () => {
      const { dispose } = await install(proxyAll());
      try {
        await expect((await fetch(originUrl)).text()).resolves.toBe('DIRECT');
        expect(proxied).toEqual([]);
      } finally {
        await dispose();
      }
    });
  });
});

describe('疊在已裝的安裝之上', () => {
  it('後掛上的政策什麼都不代理時，真的停止代理，收尾後又回到代理', async () => {
    await withCleanProxyEnv(async () => {
      const outer = await install(proxyAll());
      try {
        await expect((await fetch(proxyTarget)).text()).resolves.toBe('VIA-PROXY');
        const off = await install(env({}));
        try {
          // 「關掉」要真的停止代理，不能只回報直連、而外層的 agent 還在走隧道。
          await expect((await fetch(originUrl)).text()).resolves.toBe('DIRECT');
        } finally {
          await off.dispose();
        }
        await expect((await fetch(proxyTarget)).text()).resolves.toBe('VIA-PROXY');
      } finally {
        await outer.dispose();
      }
    });
  });

  it('直連政策疊在代理之上的期間，子行程拿到使用者自己的值；結束後外層的正規化回來', async () => {
    await withCleanProxyEnv(async () => {
      process.env.HTTP_PROXY = proxyUrl;
      process.env.https_proxy = 'socks5://127.0.0.1:1080';
      const outer = await install(
        env({ HTTP_PROXY: proxyUrl, https_proxy: 'socks5://127.0.0.1:1080' }),
      );
      try {
        expect([process.env.HTTPS_PROXY, process.env.https_proxy]).toEqual([undefined, undefined]);
        const off = await install(env({}));
        try {
          expect(process.env.HTTP_PROXY).toBe(proxyUrl);
          expect([process.env.HTTPS_PROXY, process.env.https_proxy]).toContain(
            'socks5://127.0.0.1:1080',
          );
          expect(proxyEnvironmentForChild()).toEqual({});
        } finally {
          await off.dispose();
        }
        expect([process.env.HTTPS_PROXY, process.env.https_proxy]).toEqual([undefined, undefined]);
        expect(process.env.HTTP_PROXY).toBe(proxyUrl);
      } finally {
        await outer.dispose();
      }
    });
  });
});

describe('proxyEnvironmentForChild', () => {
  it('沒有安裝政策時是空的', () => {
    expect(proxyEnvironmentForChild()).toEqual({});
  });

  it('交給子行程的是使用者匯出的值，不是這個行程的正規化', async () => {
    await withCleanProxyEnv(async () => {
      // 使用者只設了 HTTP_PROXY，另外設了一個這裡拒絕、但 `curl` 用得了的 SOCKS 代理。
      process.env.HTTP_PROXY = proxyUrl;
      process.env.https_proxy = 'socks5://127.0.0.1:1080';
      const { dispose } = await install(
        env({
          HTTP_PROXY: proxyUrl,
          https_proxy: 'socks5://127.0.0.1:1080',
          NO_PROXY: 'example.com',
        }),
      );
      try {
        const child = proxyEnvironmentForChild();
        // 兩種大小寫都看：哪個寫法承載值是平台的事，但一定是使用者的值、不是推導出來的那個。
        const https = [child.https_proxy, child.HTTPS_PROXY];
        expect(https).toContain('socks5://127.0.0.1:1080');
        expect(https).not.toContain(proxyUrl);
        expect(child.HTTP_PROXY).toBe(proxyUrl);
        // 放行清單是解析後的：只會在使用者寫的之上加項目，沒有本機項目的話子行程會把本機流量送給連不到的代理。
        expect(child.no_proxy).toBe('example.com,localhost,127.0.0.1,::1,[::1]');
        expect(child.NO_PROXY).toBe('example.com,localhost,127.0.0.1,::1,[::1]');
        // 留給 `curl` 的 SOCKS 值是 Node 啟動時會拒絕的，所以讓 Node 讀它的旗標不補，Node 子行程直連而不是起不來。
        expect(child.NODE_USE_ENV_PROXY).toBeUndefined();
      } finally {
        await dispose();
      }
    });
  });

  it('使用者兩種寫法都沒點名的協定拿到解析出來的值，Node 子行程才不會被留在直連', async () => {
    await withCleanProxyEnv(async () => {
      // 使用者只匯出 ALL_PROXY；`NODE_USE_ENV_PROXY` 不讀這個名字，子行程會直連而父行程走代理。
      process.env.ALL_PROXY = proxyUrl;
      const { dispose } = await install(env({ ALL_PROXY: proxyUrl }));
      try {
        const child = proxyEnvironmentForChild();
        expect(child.HTTP_PROXY).toBe(proxyUrl);
        expect(child.http_proxy).toBe(proxyUrl);
        expect(child.HTTPS_PROXY).toBe(proxyUrl);
        expect(child.https_proxy).toBe(proxyUrl);
        expect(child.NODE_USE_ENV_PROXY).toBe('1');
      } finally {
        await dispose();
      }
    });
  });

  it.each(['socks4://127.0.0.1:1080', 'ftp://p:1', 'not a url'])(
    '子行程收到 %s 時不補 NODE_USE_ENV_PROXY，Node 子行程還是起得來',
    async (refused) => {
      await withCleanProxyEnv(async () => {
        process.env.HTTP_PROXY = proxyUrl;
        process.env.HTTPS_PROXY = refused;
        const { dispose } = await install(env({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: refused }));
        try {
          const child = proxyEnvironmentForChild();
          // 值照樣交出去（`curl` 可能讀它），但 Node 在那個旗標下啟動前就解析這兩個名字，所以旗標不能補。
          expect(child.HTTPS_PROXY).toBe(refused);
          expect(child.HTTP_PROXY).toBe(proxyUrl);
          expect(child).not.toHaveProperty('NODE_USE_ENV_PROXY');
          // 在真的子行程上證明，不是推論：同樣的環境帶著旗標，每個我們支援的 Node 都會在程式跑起來之前結束。
          const childEnv: Record<string, string> = { PATH: process.env.PATH ?? '' };
          for (const [name, value] of Object.entries(child)) {
            if (value !== undefined) childEnv[name] = value;
          }
          const run = spawnSync(process.execPath, ['-e', 'process.stdout.write("started")'], {
            env: childEnv,
            encoding: 'utf8',
          });
          expect({ status: run.status, stdout: run.stdout }).toEqual({
            status: 0,
            stdout: 'started',
          });
        } finally {
          await dispose();
        }
      });
    },
  );

  it('巢狀安裝時，最外層記的「使用者匯出了什麼」不被內層蓋掉', async () => {
    await withCleanProxyEnv(async () => {
      process.env.HTTP_PROXY = proxyUrl;
      const outer = await install(
        env({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: 'example.com' }),
      );
      try {
        const inner = await install(env({ HTTP_PROXY: nestedUrl, HTTPS_PROXY: nestedUrl }));
        try {
          const child = proxyEnvironmentForChild();
          // 使用者沒有點名 HTTPS 代理，所以這個協定帶生效中的政策。把外層寫出來的環境當成使用者的，
          // 就會被釘在外層的代理上。
          expect(child.https_proxy).toBe(nestedUrl);
          expect(child.HTTPS_PROXY).toBe(nestedUrl);
        } finally {
          await inner.dispose();
        }
        // 內層收掉之後，外層仍要描述得出那份環境。
        expect(proxyEnvironmentForChild().HTTP_PROXY).toBe(proxyUrl);
        expect(proxyEnvironmentForChild().https_proxy).toBe(proxyUrl);
      } finally {
        await outer.dispose();
      }
    });
  });
});

/**
 * `proxyForUrl` 回答網址走哪；這一組拿它的答案去對真的 `fetch` 實際去了哪，涵蓋文件寫明的每一種放行寫法。
 * 裝上去的派送器問的是同一個判準，所以兩者不會因為解析兩次而漂開；能抓到的是 `bypassesProxy` 讀某種寫法的方式
 * 跟文件不同，以及日後有人另外引進第二個比對器。
 */
const PARITY_CASES: readonly {
  readonly noProxy: string;
  readonly path: string;
  readonly bypassed: boolean;
}[] = [
  { noProxy: '', path: '/plain', bypassed: false },
  { noProxy: 'probe.invalid', path: '/exact', bypassed: true },
  { noProxy: '.probe.invalid', path: '/dot-suffix', bypassed: true },
  { noProxy: '*.probe.invalid', path: '/star-suffix', bypassed: true },
  { noProxy: 'other.invalid', path: '/miss', bypassed: false },
  { noProxy: '*', path: '/all', bypassed: true },
  { noProxy: 'probe.invalid:80', path: '/with-default-port', bypassed: true },
  { noProxy: 'probe.invalid:8443', path: '/wrong-port', bypassed: false },
  { noProxy: 'a.invalid, probe.invalid', path: '/comma-list', bypassed: true },
];

describe('放行比對器與真的 fetch 一致', () => {
  it.each(PARITY_CASES)('$noProxy 對 $path', async ({ noProxy, path, bypassed }) => {
    await withCleanProxyEnv(async () => {
      const url = new URL(`http://probe.invalid${path}`);
      const lookup = env({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: noProxy });
      const { policy } = resolveProxyPolicy(lookup);
      const { dispose } = await install(lookup);
      try {
        // 被放行的目標沒有路由，fetch 會失敗；走代理的幾毫秒內就到記錄器。時限只綁住失敗的那條路，蓋不住走代理的。
        await fetch(url, { signal: AbortSignal.timeout(1500) })
          .then((response) => response.text())
          .catch(() => undefined);
        const agentProxied = proxied.length > 0;
        expect({ ours: proxyForUrl(policy, url) !== undefined, agent: agentProxied }).toEqual({
          ours: !bypassed,
          agent: !bypassed,
        });
      } finally {
        await dispose();
      }
    });
  });
});
