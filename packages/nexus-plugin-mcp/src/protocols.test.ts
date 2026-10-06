/**
 * 新協議（`2026-07-28`）的 server 與 HTTP 傳輸對 `@langchain/mcp-adapters` 2.0.0 的驗收
 * （[#1095](https://github.com/DemianLi/nexus-agent/issues/1095)，補 [#1074](https://github.com/DemianLi/nexus-agent/issues/1074)
 * 那張 PR 自己標明沒測的兩格）。
 *
 * [`index.test.ts`](./index.test.ts) 的夾具是單包 SDK 1.x 的舊協議 stdio server；adapter 對每台 server 預設 `auto`
 * 協商，新協議那一側整條路徑原本沒有任何測試走過。這裡補三台：新協議 stdio、新協議 HTTP、舊協議 HTTP，
 * 工具定義與舊 stdio 那台同名同行為，所以**同一組行為斷言**在每一台上各跑一遍。
 *
 * **每條斷言都量在 server 那一側可觀察的東西**：server 收到的協議版本、標頭、client 宣告的能力、還沒結束的請求。
 * 在 client 那邊看我們自己傳了什麼，守不住「設定寫了但沒生效」那一類。零外部連線、不需要任何 key。
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { ToolMessage } from '@langchain/core/messages';
import { loadPlugins } from '@nexus/core';
import type { PluginEntry } from '@nexus/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpPlugin } from './index.js';
import { FAILURE_TEXT, RELEASE_NOTE } from './fixture-tools.js';
import { startLegacyHttp, startModernHttp } from './http-fixtures.js';
import type { HttpFixture } from './http-fixtures.js';
import type { ProtocolInfo } from './modern-tools.js';

const MODERN_STDIO_SERVER = fileURLToPath(new URL('./modern-stdio-server.ts', import.meta.url));

/** 新協議的版本字串。 */
const MODERN_VERSION = '2026-07-28';

/** 一台跑著的 server 與連它的 plugin 條目。 */
interface Running {
  readonly plugin: PluginEntry;
  /** HTTP 的 server 看到的東西；stdio 沒有。 */
  readonly http?: HttpFixture;
  stop(): Promise<void>;
}

interface Target {
  readonly label: string;
  /** 這一台講新協議。 */
  readonly modern: boolean;
  readonly transport: 'stdio' | 'http';
  start(options?: { headers?: Record<string, string> }): Promise<Running>;
}

const TARGETS: readonly Target[] = [
  {
    label: '新協議 stdio',
    modern: true,
    transport: 'stdio',
    start: () =>
      Promise.resolve({
        plugin: createMcpPlugin({
          serverName: 'srv',
          connection: {
            transport: 'stdio',
            command: process.execPath,
            args: ['--import', 'tsx', MODERN_STDIO_SERVER],
          },
        }),
        stop: () => Promise.resolve(),
      }),
  },
  {
    label: '新協議 HTTP',
    modern: true,
    transport: 'http',
    start: async (options) => httpRunning(await startModernHttp(), options?.headers),
  },
  {
    label: '舊協議 HTTP',
    modern: false,
    transport: 'http',
    start: async (options) => httpRunning(await startLegacyHttp(), options?.headers),
  },
];

function httpRunning(http: HttpFixture, headers?: Record<string, string>): Running {
  return {
    plugin: createMcpPlugin({
      serverName: 'srv',
      connection: { transport: 'http', url: http.url, ...(headers !== undefined && { headers }) },
    }),
    http,
    stop: () => http.close(),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

/** 用一台 server 跑一段測試，收尾一定關。 */
async function withServer<T>(
  target: Target,
  body: (mounted: Awaited<ReturnType<typeof loadPlugins>>, running: Running) => Promise<T>,
  options?: { headers?: Record<string, string> },
): Promise<T> {
  // loopback 不該走代理：機器上設了 HTTP(S)_PROXY 時請求會被送到代理去，而不是這台假 server。
  vi.stubEnv('NO_PROXY', '127.0.0.1');
  const running = await target.start(options);
  try {
    const mounted = await loadPlugins([running.plugin]);
    try {
      return await body(mounted, running);
    } finally {
      await mounted.dispose();
    }
  } finally {
    await running.stop();
  }
}

type Mounted = Awaited<ReturnType<typeof loadPlugins>>;

function tool(mounted: Mounted, name: string) {
  const found = mounted.registry.tools.resolve(`mcp__srv__${name}`)?.value;
  if (found === undefined) throw new Error(`沒有註冊 mcp__srv__${name}`);
  return found;
}

/** 呼叫 `protocol_info`：server 端看到的協議版本與 client 宣告的能力。 */
async function protocolInfo(mounted: Mounted): Promise<ProtocolInfo> {
  return JSON.parse(String(await tool(mounted, 'protocol_info').invoke({}))) as ProtocolInfo;
}

describe.each(TARGETS)('$label：同一組行為斷言', (target) => {
  it('工具以 mcp__<server>__<raw> 註冊', async () => {
    await withServer(target, async ({ registry }) => {
      const names = [...registry.tools.effective().keys()];
      expect(names.slice(0, 5)).toEqual([
        'mcp__srv__fetch_release_note',
        expect.stringMatching(/^mcp__srv__legacy_ping_[0-9a-f]{12}$/),
        'mcp__srv__fail',
        'mcp__srv__nullable_args',
        'mcp__srv__snapshot',
      ]);
      // 新協議那兩台多了兩支只有它們才有的；舊協議 HTTP 掛的是整組舊工具。
      expect(names.slice(5)).toEqual(
        target.modern
          ? ['mcp__srv__protocol_info', 'mcp__srv__ask']
          : ['mcp__srv__read_env', 'mcp__srv__fetch_url'],
      );
    });
  });

  it('呼叫得到，而且送上線的是 raw name', async () => {
    await withServer(target, async (mounted) => {
      const { registry } = mounted;
      const result = await tool(mounted, 'fetch_release_note').invoke({ topic: '發行說明' });
      expect(String(result)).toContain(RELEASE_NOTE);
      // 名字被正規化過的那一支：server 認得的仍是 `legacy.ping`。
      const renamed = [...registry.tools.effective().keys()].find((name) =>
        name.startsWith('mcp__srv__legacy_ping_'),
      );
      expect(String(await registry.tools.resolve(renamed ?? '')?.value.invoke({}))).toContain(
        'pong',
      );
    });
  });

  it('server 回 isError：兩種呼叫形狀都拋，帶原文', async () => {
    await withServer(target, async (mounted) => {
      const fail = tool(mounted, 'fail');
      await expect(
        fail.invoke({ type: 'tool_call', id: 'call_fail', name: 'mcp__srv__fail', args: {} }),
      ).rejects.toThrow(FAILURE_TEXT);
      await expect(fail.invoke({})).rejects.toThrow(FAILURE_TEXT);
    });
  });

  it('回圖的工具：圖換成說明文字，前後的文字與順序原樣', async () => {
    await withServer(target, async (mounted) => {
      const message = (await tool(mounted, 'snapshot').invoke({
        type: 'tool_call',
        id: 'call_snapshot',
        name: 'mcp__srv__snapshot',
        args: {},
      })) as ToolMessage;
      expect(message.content).toEqual([
        { type: 'text', text: '畫面之前' },
        { type: 'text', text: '[image unavailable: image/png; no attachment store is mounted]' },
        { type: 'text', text: '畫面之後' },
      ]);
    });
  });

  it('可為 null 與聯集的參數：anyOf 原樣，呼叫也走得通', async () => {
    await withServer(target, async (mounted) => {
      const nullable = tool(mounted, 'nullable_args');
      expect(JSON.stringify((nullable as unknown as { schema: unknown }).schema)).toContain(
        'anyOf',
      );
      const text = String(await nullable.invoke({ label: null, value: 3 }));
      expect(JSON.parse(text)).toEqual({ label: null, value: 3 });
    });
  });
});

describe('協商到的協議（量在 server 端）', () => {
  it.each(TARGETS.filter((target) => target.modern))(
    '$label：server 看到的請求是 2026-07-28',
    async (target) => {
      await withServer(target, async (mounted) => {
        expect((await protocolInfo(mounted)).protocolVersion).toBe(MODERN_VERSION);
      });
    },
  );

  // 沒有這一條，「新舊各一台」可能兩台都落在同一個模式，等於只測了一種。
  it('舊協議 HTTP：握手之後的請求帶的是舊版號，不是新協議', async () => {
    const legacy = TARGETS.find((target) => !target.modern);
    if (legacy === undefined) throw new Error('找不到舊協議 HTTP 那一台');
    await withServer(legacy, async ({ registry }, { http }) => {
      await registry.tools.resolve('mcp__srv__fetch_release_note')?.value.invoke({ topic: 'x' });
      const afterHandshake = (http?.requests ?? []).filter((request) =>
        request.rpcMethods.some((method) => method === 'tools/list' || method === 'tools/call'),
      );
      expect(afterHandshake.length).toBeGreaterThanOrEqual(2);
      for (const request of afterHandshake) {
        expect(request.protocolVersion).toMatch(/^2025-/u);
      }
      expect(http?.requests.some((request) => request.rpcMethods.includes('initialize'))).toBe(
        true,
      );
    });
  });
});

/**
 * 每條連線都寫了 `elicitation: false`（nexus 沒有 LangGraph interrupt 的續行路徑）。這一組讓它**有人守**：
 * 把任何一行改成 `true`，下面至少兩條會紅。stdio 與 http 是 `toAdapterConnection` 裡**各自**一行，所以兩種載具
 * 都要有新協議的 server。
 */
describe.each(TARGETS.filter((target) => target.modern))('$label：不接 elicitation', (target) => {
  it('server 看到 client 沒宣告 elicitation 能力', async () => {
    await withServer(target, async (mounted) => {
      const { clientCapabilities } = await protocolInfo(mounted);
      expect(Object.keys(clientCapabilities)).not.toContain('elicitation');
    });
  });

  it('會問使用者的工具：落成普通的工具失敗，不卡住、不產生 interrupt，之後的呼叫照常', async () => {
    await withServer(target, async (mounted) => {
      const message = await tool(mounted, 'ask')
        .invoke({})
        .then(
          () => '沒有拋',
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
      // server 端的 SDK 拒絕這一輪：client 沒宣告能力。要是 elicitation 是 true，這裡會是
      // 「Called interrupt() outside the context of a graph」——那才是 nexus 接不住的路徑。
      expect(message).toMatch(/elicitation\/create/u);
      expect(message).toMatch(/capabilit/u);
      expect(message).not.toMatch(/interrupt/iu);

      // 失敗是這一次呼叫的事，連線沒被拖垮。
      expect(String(await tool(mounted, 'fetch_release_note').invoke({ topic: '之後' }))).toContain(
        RELEASE_NOTE,
      );
    });
  });
});

describe.each(TARGETS.filter((target) => target.transport === 'http'))(
  '$label：HTTP 傳輸',
  (target) => {
    it('設定的標頭真的到得了 server：每一個請求都帶，連握手與常駐的串流', async () => {
      await withServer(
        target,
        async ({ registry }, { http }) => {
          await registry.tools
            .resolve('mcp__srv__fetch_release_note')
            ?.value.invoke({ topic: 'x' });
          const seen = http?.requests ?? [];
          expect(seen.length).toBeGreaterThanOrEqual(3);
          // 在 server 端記下收到的標頭；只在 client 端看設定證明不了它被送出。
          expect(seen.map((request) => request.authorization)).toEqual(
            seen.map(() => 'Bearer s3cret'),
          );
        },
        { headers: { Authorization: 'Bearer s3cret' } },
      );
    });

    it('tools/list 失敗：照樣掛上、沒有工具、交出一則警告', async () => {
      const http = await (target.modern ? startModernHttp() : startLegacyHttp());
      http.failRpcMethod('tools/list');
      const { registry, dispose } = await loadPlugins([httpRunning(http).plugin]);
      try {
        expect(registry.tools.effective().size).toBe(0);
        expect(registry.logger.warnings()).toHaveLength(1);
        expect(registry.logger.warnings()[0]?.message).toMatch(
          /^MCP 伺服器 "srv" 連不上、列不出工具或工具註冊不上/u,
        );
        // 它真的走到了 tools/list（而不是更早就連不上）：失敗是我們注入在這個方法上的。
        expect(http.requests.some((request) => request.rpcMethods.includes('tools/list'))).toBe(
          true,
        );
      } finally {
        await dispose();
        await http.close();
      }
    });

    it('tools/list 失敗又寫 failOnStartupError: true：在 apply 裡拋', async () => {
      const http = await (target.modern ? startModernHttp() : startLegacyHttp());
      http.failRpcMethod('tools/list');
      try {
        await expect(
          loadPlugins([
            createMcpPlugin({
              serverName: 'srv',
              connection: { transport: 'http', url: http.url },
              failOnStartupError: true,
            }),
          ]),
        ).rejects.toThrow('mcp#0 (mcp)');
      } finally {
        await http.close();
      }
    });

    it('dispose 之後常駐的串流在 server 端結束，第二次呼叫是 no-op', async () => {
      const http = await (target.modern ? startModernHttp() : startLegacyHttp());
      try {
        const { registry, dispose } = await loadPlugins([httpRunning(http).plugin]);
        await registry.tools.resolve('mcp__srv__fetch_release_note')?.value.invoke({ topic: 'x' });
        // 常駐的那條（舊協議的 GET 串流、新協議的 subscriptions/listen）還開著：沒有它，下面的「結束」是空話。
        await vi.waitFor(() => expect(http.activeRequests()).toBe(1));

        await dispose();
        await dispose();

        // 量的是 server 那一側「還沒結束的請求」。TCP 連線是 undici 的 keep-alive 池，閒置的會留著，不算收線。
        await vi.waitFor(() => expect(http.activeRequests()).toBe(0));
      } finally {
        await http.close();
      }
    });
  },
);

describe('HTTP 連不上', () => {
  /** 一個剛關掉的埠：連它會被拒絕。 */
  async function closedPort(): Promise<string> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return `http://127.0.0.1:${String(port)}/mcp`;
  }

  it('預設：照樣掛上、沒有工具、交出一則警告', async () => {
    vi.stubEnv('NO_PROXY', '127.0.0.1');
    const url = await closedPort();
    const { registry, dispose } = await loadPlugins([
      createMcpPlugin({ serverName: 'srv', connection: { transport: 'http', url } }),
    ]);
    try {
      expect(registry.tools.effective().size).toBe(0);
      expect(registry.logger.warnings()).toHaveLength(1);
      expect(registry.logger.warnings()[0]?.message).toMatch(/^MCP 伺服器 "srv" 連不上/u);
    } finally {
      await dispose();
    }
  });

  it('寫 failOnStartupError: true：在 apply 裡拋', async () => {
    vi.stubEnv('NO_PROXY', '127.0.0.1');
    const url = await closedPort();
    await expect(
      loadPlugins([
        createMcpPlugin({
          serverName: 'srv',
          connection: { transport: 'http', url },
          failOnStartupError: true,
        }),
      ]),
    ).rejects.toThrow('mcp#0 (mcp)');
  });
});
