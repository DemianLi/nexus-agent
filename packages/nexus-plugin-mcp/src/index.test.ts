/**
 * MCP plugin 的驗收。
 *
 * 分兩段：{@link publicToolName} 是純函式，用單測；其餘全部走一台**真的 stdio
 * 子行程**（[`fixture-server.ts`](./fixture-server.ts)）。判準照 dsh 的政策 4——
 * 「test denial through the executor」的同一條精神：要證明的是那條線真的通，而 mock
 * 掉 `MultiServerMCPClient` 之後連線、`tools/list`、`tools/call`、關機四件事一件都驗不到。
 *
 * **不打網路、不需要任何 key**，所以進得了 CI（[#31](https://github.com/DemianLi/nexus-agent/issues/31)：
 * CI 不放模型 secret）。
 */

import { fileURLToPath } from 'node:url';
import type { ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { installProxyFromEnvironment, loadPlugins } from '@nexus/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createMcpPlugin,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  mcpConfigSchema,
  mcpPlugin,
} from './index.js';
import { RELEASE_NOTE } from './fixture-server.js';
import { publicToolName } from './names.js';

const FIXTURE_SERVER = fileURLToPath(new URL('./fixture-server.ts', import.meta.url));

/**
 * 連上假 server 的 plugin。
 *
 * 用 `node --import tsx` 而不是直接跑 `tsx`：`process.execPath` 一定是正在跑測試的那個
 * node，不必猜 `.bin` 在哪裡，也不會因為 PATH 不同而在 CI 上換一個行為。
 */
function fixturePlugin(serverName = 'fixture', env?: Record<string, string>) {
  return createMcpPlugin({
    serverName,
    connection: {
      transport: 'stdio',
      command: process.execPath,
      args: ['--import', 'tsx', FIXTURE_SERVER],
      ...(env !== undefined && { env }),
    },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('publicToolName', () => {
  it('乾淨的名字就是 mcp__<server>__<raw>，不動它', () => {
    expect(publicToolName('github', 'create_issue')).toBe('mcp__github__create_issue');
  });

  it('不合法的字元換掉，並補一段指紋——換過就補，長度沒超過也一樣', () => {
    const name = publicToolName('fixture', 'legacy.ping');
    expect(name).toMatch(/^mcp__fixture__legacy_ping_[0-9a-f]{12}$/);
  });

  it('超過 64 字元就截斷，截斷後仍在契約內', () => {
    const name = publicToolName('fixture', 'a'.repeat(120));
    expect(name).toHaveLength(64);
    expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it('是 (serverName, rawName) 的純函式：同樣的輸入永遠同一個名字', () => {
    expect(publicToolName('fixture', 'legacy.ping')).toBe(publicToolName('fixture', 'legacy.ping'));
  });

  // 沒有指紋的話這兩個都會被壓成 `mcp__fixture__a_b`，而模型呼叫到另一個工具是不會
  // 有任何錯誤的——它只會拿到別人的結果。
  it('兩個原本會壓成同一個名字的工具不會併成一個', () => {
    expect(publicToolName('fixture', 'a.b')).not.toBe(publicToolName('fixture', 'a-b'));
  });

  // 最長的 serverName 加最長的 raw name 是預算最緊的那一格：`mcp__` ＋ 32 ＋ `__` 已經
  // 佔掉 39 字元，指紋再拿走 13，raw name 只剩 12 字元的位置。指紋雜的是完整的
  // `(serverName, rawName)`，所以看得見的那 12 字元一樣不代表兩個工具會併起來。
  it('serverName 用到上限也還在契約內，且兩個長名字仍然分得開', () => {
    const server = 'a'.repeat(32);
    const first = publicToolName(server, `${'b'.repeat(80)}-one`);
    const second = publicToolName(server, `${'b'.repeat(80)}-two`);

    expect(first).toHaveLength(64);
    expect(first).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(first).toContain(`mcp__${server}__`);
    expect(first).not.toBe(second);
  });
});

describe('設定的檢查（#453：驗在載入的時候，不在工廠裡）', () => {
  it('serverName 不合法時載入就失敗，不必等到連線', async () => {
    // **翻面過的絆索**：原本是 `createMcpPlugin()` 當場拋。工廠現在只是薄薄一層，檢查搬到
    // schema，所以訊息帶得出是清單裡哪一個條目——那正是從 YAML 載入時唯一指得到的東西。
    for (const serverName of ['has space', '', 'x'.repeat(33)]) {
      const bad = [createMcpPlugin({ serverName, connection: emptyStdio() })];
      await expect(loadPlugins(bad)).rejects.toThrow('mcp#0 (mcp)');
      await expect(loadPlugins(bad)).rejects.toThrow('[A-Za-z0-9_-]');
    }
  });

  it('連線那一層的未知欄位也擋得住，而且路徑指得到那一層', async () => {
    const typo = [
      {
        plugin: mcpPlugin,
        config: { serverName: 'x', connection: { ...emptyStdio(), commnd: 'npx' } },
      },
    ];
    await expect(loadPlugins(typo)).rejects.toThrow('mcp#0 (mcp)');
    await expect(loadPlugins(typo)).rejects.toThrow(/connection(\.|:)/);
  });

  it('判別式聯集：stdio 那格打錯時只抱怨 stdio，不連 http 分支一起念', async () => {
    // **這一條才擋得住「換成一般 `z.union`」**：一般聯集會把兩個分支的抱怨一起印出來，
    // 於是使用者被告知「少了 url」——而他根本沒打算走 http。
    const typo = [
      {
        plugin: mcpPlugin,
        config: { serverName: 'x', connection: { transport: 'stdio', commnd: 'npx' } },
      },
    ];
    await expect(loadPlugins(typo)).rejects.toThrow(/commnd|command/);
    await expect(loadPlugins(typo)).rejects.not.toThrow(/url/);
  });

  it('transport 自己打錯時，訊息講的是 transport', async () => {
    const bad = [
      { plugin: mcpPlugin, config: { serverName: 'x', connection: { transport: 'stdout' } } },
    ];
    await expect(loadPlugins(bad)).rejects.toThrow(/transport/);
  });

  it('逾時省略時由 schema 補上預設值', async () => {
    expect(mcpConfigSchema.parse({ serverName: 'x', connection: emptyStdio() })).toMatchObject({
      toolCallTimeoutMs: DEFAULT_TOOL_CALL_TIMEOUT_MS,
    });
  });
});

describe('接上一台真的 MCP server', () => {
  it('工具以 mcp__<server>__<raw> 註冊，能力也宣告了', async () => {
    const { registry, dispose } = await loadPlugins([fixturePlugin()]);
    try {
      expect([...registry.tools.effective().keys()]).toEqual([
        'mcp__fixture__fetch_release_note',
        expect.stringMatching(/^mcp__fixture__legacy_ping_[0-9a-f]{12}$/),
        'mcp__fixture__snapshot',
        'mcp__fixture__read_env',
        'mcp__fixture__fetch_url',
      ]);
    } finally {
      await dispose();
    }
  });

  it('呼叫得到，而且送上線的是 raw name——改掉的只是註冊給模型看的那個', async () => {
    const { registry, dispose } = await loadPlugins([fixturePlugin()]);
    try {
      const entry = registry.tools.resolve('mcp__fixture__fetch_release_note');
      const result = await entry?.value.invoke({ topic: '發行說明' });
      expect(String(result)).toContain(RELEASE_NOTE);

      // 名字被正規化過的那一支同樣呼叫得到：server 那端認得的仍是 `legacy.ping`。
      const renamed = [...registry.tools.effective().keys()].find((name) =>
        name.startsWith('mcp__fixture__legacy_ping_'),
      );
      const pong = await registry.tools.resolve(renamed ?? '')?.value.invoke({});
      expect(String(pong)).toContain('pong');
    } finally {
      await dispose();
    }
  });

  // 模型那一側的工具訊息只收文字（#642：NVIDIA 對 `role: tool` 帶圖回 400，`image_url` 也一樣）。照 dsh 的
  // `mcp-client`（`src/tools.ts:376-435`，`477b4f4`）：收不下的圖換成一段說明，其餘原樣、順序不變。**換在工具本體
  // 裡**，所以日誌、state、續接與 web 的工具卡拿到的是同一份。
  it('回圖的工具：圖換成說明文字，前後的文字與順序原樣', async () => {
    const { registry, dispose } = await loadPlugins([fixturePlugin()]);
    try {
      const message = (await registry.tools.resolve('mcp__fixture__snapshot')?.value.invoke({
        type: 'tool_call',
        id: 'call_snapshot',
        name: 'mcp__fixture__snapshot',
        args: {},
      })) as ToolMessage;
      expect(message.content).toEqual([
        { type: 'text', text: '畫面之前' },
        { type: 'text', text: '[image unavailable: image/png; no attachment store is mounted]' },
        { type: 'text', text: '畫面之後' },
      ]);
    } finally {
      await dispose();
    }
  });

  /**
   * 同一個 `serverName` 掛兩次：照 dsh 在連線之前就讓後來那一個失敗，**不管 `failOnStartupError`**——那是設定寫錯，
   * 不是伺服器不在，不收成警告（#751）。
   */
  it('同一台 server 掛兩次：後來那一個在連線之前就拋，訊息指名兩個 plugin', async () => {
    // `name` 不唯一是刻意的，所以撞不在 plugin 清單那一層——撞在它們預留的伺服器名上。
    await expect(loadPlugins([fixturePlugin(), fixturePlugin()])).rejects.toThrow(
      /mcp#0 \(mcp\)[\s\S]*mcp#1 \(mcp\)/,
    );
  });

  it('不同 serverName 的兩台各自有命名空間，互不干擾', async () => {
    const { registry, dispose } = await loadPlugins([
      fixturePlugin('github'),
      fixturePlugin('linear'),
    ]);
    try {
      expect(registry.tools.resolve('mcp__github__fetch_release_note')).toBeDefined();
      expect(registry.tools.resolve('mcp__linear__fetch_release_note')).toBeDefined();
    } finally {
      await dispose();
    }
  });

  /**
   * 卡上的驗收（#751）：**連不上照 dsh 照樣掛上**——那台伺服器沒有工具、交出一則警告，不是整份清單載入失敗。子行程
   * 收掉了：沒有工具就沒有理由留著它，而收住的那條路沒登記 `onDispose`，漏收的話它會活過整個行程。
   */
  it('連不上：照樣掛上、沒有那台的工具、交出一則警告，子行程收掉了', async () => {
    const { registry, dispose } = await loadPlugins([missingServer()]);
    try {
      expect(registry.tools.effective().size).toBe(0);
      expect(registry.logger.warnings()).toHaveLength(1);
      expect(registry.logger.warnings()[0]).toMatchObject({
        origin: { name: 'mcp' },
        message: expect.stringMatching(/^MCP 伺服器 "missing" 連不上、列不出工具或工具註冊不上/u),
      });
      await vi.waitFor(() => expect(childProcessCount()).toBe(0));
    } finally {
      await dispose();
    }
  });

  it('寫 `failOnStartupError: true`：連不上就在 `apply` 裡拋，手搭清單整個載入失敗', async () => {
    await expect(loadPlugins([missingServer({ failOnStartupError: true })])).rejects.toThrow(
      'mcp#0 (mcp)',
    );
    await vi.waitFor(() => expect(childProcessCount()).toBe(0));
  });

  /**
   * 工具註冊不上（外來的 plugin 先佔了這台伺服器命名空間裡的一個名字）也收成警告，而且**整台一個都不註冊**，照 dsh：
   * 模型看到的是整台的工具或一個都沒有，不會是一半。
   */
  it('工具名被別的 plugin 佔了：收成警告，這台的工具一個都不留，佔名的那個照樣在', async () => {
    const squatter = {
      plugin: {
        name: 'squatter',
        apply: (r: Parameters<typeof mcpPlugin.apply>[0]) =>
          void r.tools.register(
            tool(() => '別人的', {
              name: 'mcp__fixture__snapshot',
              description: '佔名',
              schema: z.object({}),
            }),
          ),
      },
    };
    const { registry, dispose } = await loadPlugins([squatter, fixturePlugin()]);
    try {
      expect([...registry.tools.effective().keys()]).toEqual(['mcp__fixture__snapshot']);
      expect(registry.tools.resolve('mcp__fixture__snapshot')?.origin.name).toBe('squatter');
      expect(registry.logger.warnings()[0]?.message).toMatch(/squatter/u);
    } finally {
      await dispose();
    }
  });

  it('dispose 之後子行程收掉了，而且呼叫第二次是 no-op', async () => {
    const { dispose } = await loadPlugins([fixturePlugin()]);
    expect(childProcessCount()).toBe(1);

    await dispose();
    await dispose();

    // 這條是整個 lifecycle 通道存在的理由：沒收掉的話 `pnpm cli` 印完答案不會退出。
    // 等一下是必要的：`close()` 送出的是 kill，handle 要到子行程真的結束才會從 event
    // loop 上掉下來——而「行程退不退得出去」問的正是 handle 還在不在。
    await vi.waitFor(() => expect(childProcessCount()).toBe(0));
  });
});

/**
 * 一台連不上的 server：一個立刻結束、什麼都不印的子行程，連得上 stdio、握不成手。用它而不是一個不存在的檔案，是為了讓
 * 測試通過時 CI 的輸出是乾淨的——子行程的 stderr 預設 inherit。
 */
function missingServer(extra: { failOnStartupError?: boolean } = {}) {
  return createMcpPlugin({
    serverName: 'missing',
    connection: { transport: 'stdio', command: process.execPath, args: ['-e', ''] },
    ...extra,
  });
}

/** 只用來餵設定檢查，不會真的去連。 */
function emptyStdio() {
  return { transport: 'stdio' as const, command: process.execPath, args: [] };
}

/**
 * 這個行程手上還有幾個活的子行程。
 *
 * 用 `process.getActiveResourcesInfo()` 而不是自己記 pid：關機有沒有真的收掉，答案在
 * event loop 還抓著什麼 handle 上——那正是「印完答案卻不退出」的成因。子行程在那份
 * 清單裡叫 `ProcessWrap`（它的 stdio 另外算成 `PipeWrap`）。
 */
function childProcessCount(): number {
  return process.getActiveResourcesInfo().filter((kind) => kind === 'ProcessWrap').length;
}

/**
 * 卡上的驗收（#726）：stdio 子行程的環境**照 dsh 以清洗過的父環境為底**，設定裡的 `env` 疊在後面
 * （dsh `packages/mcp/mcp-client/src/transport.ts:22`，`477b4f4`）。走真的子行程，問假 server 它看得到什麼。
 *
 * 這幾條同時是上游的絆索：底是 adapter（有 `env` 才傳、只補 `PATH`）與 SDK（`getDefaultEnvironment()` 只有六個
 * 名字）兩層合出來的，哪天它們改了合併方式，這裡會紅。
 */
describe('子行程的環境（#726）', () => {
  const ASKED = ['KEEP_ME', 'HTTPS_PROXY', 'FAKE_API_TOKEN', 'NEXUS_X', 'GITHUB_TOKEN'];

  /** 用這份 `connection.env` 起一台假 server，回它看得到的那幾個變數。 */
  async function childEnv(env?: Record<string, string>): Promise<Record<string, string | null>> {
    const { registry, dispose } = await loadPlugins([fixturePlugin('fixture', env)]);
    try {
      const result = await registry.tools
        .resolve('mcp__fixture__read_env')
        ?.value.invoke({ names: ASKED });
      return JSON.parse(String(result)) as Record<string, string | null>;
    } finally {
      await dispose();
    }
  }

  function stubParent(): void {
    vi.stubEnv('KEEP_ME', 'yes');
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.internal:3128');
    vi.stubEnv('FAKE_API_TOKEN', 'leak');
    vi.stubEnv('NEXUS_X', 'harness');
  }

  it('沒設 env：一般變數與代理照繼承，名字像憑證的與 `NEXUS_*` 拿掉', async () => {
    stubParent();
    expect(await childEnv()).toEqual({
      KEEP_ME: 'yes',
      HTTPS_PROXY: 'http://proxy.internal:3128',
      FAKE_API_TOKEN: null,
      NEXUS_X: null,
      GITHUB_TOKEN: null,
    });
  });

  it('設了 env：疊在清洗過的底上，明著轉傳的憑證到得了', async () => {
    stubParent();
    expect(await childEnv({ GITHUB_TOKEN: 'x' })).toEqual({
      KEEP_ME: 'yes',
      HTTPS_PROXY: 'http://proxy.internal:3128',
      FAKE_API_TOKEN: null,
      NEXUS_X: null,
      GITHUB_TOKEN: 'x',
    });
  });

  it('設定裡的值蓋過父行程的同名變數', async () => {
    stubParent();
    expect((await childEnv({ KEEP_ME: 'explicit' }))['KEEP_ME']).toBe('explicit');
  });

  /**
   * 行程裝了代理（#746）：子行程裡的 Node 不看代理變數，除非帶著旗標。問真的子行程看得到什麼，而不是直接呼叫 core 的函式——
   * 要驗的是這個 plugin 讀到的，跟 harness 裝的是同一份行程層狀態。
   */
  describe('行程裝了代理（#746）', () => {
    const PROXY_NAMES = [
      'HTTP_PROXY',
      'http_proxy',
      'HTTPS_PROXY',
      'https_proxy',
      'ALL_PROXY',
      'all_proxy',
    ];

    async function withProxy(
      values: Record<string, string>,
      body: () => Promise<Record<string, string | null>>,
    ): Promise<Record<string, string | null>> {
      for (const name of [...PROXY_NAMES, 'NODE_USE_ENV_PROXY']) {
        vi.stubEnv(name, undefined);
        Reflect.deleteProperty(process.env, name);
      }
      for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
      const dispose = await installProxyFromEnvironment(
        { get: (name) => (name in values ? { value: values[name]! } : undefined) },
        () => undefined,
      );
      try {
        return await body();
      } finally {
        await dispose();
      }
    }

    const asked = async () => {
      const { registry, dispose } = await loadPlugins([fixturePlugin()]);
      try {
        const result = await registry.tools
          .resolve('mcp__fixture__read_env')
          ?.value.invoke({ names: ['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY'] });
        return JSON.parse(String(result)) as Record<string, string | null>;
      } finally {
        await dispose();
      }
    };

    it('補旗標；只設 ALL_PROXY 時子行程拿到解析後的 HTTP_PROXY 與 HTTPS_PROXY', async () => {
      expect(await withProxy({ ALL_PROXY: 'http://all.internal:3128' }, asked)).toEqual({
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: 'http://all.internal:3128',
        HTTPS_PROXY: 'http://all.internal:3128',
      });
    });

    it('有一個代理值被拒絕（SOCKS）：不補旗標，否則子行程裡的 Node 會在跑程式之前就結束', async () => {
      const seen = await withProxy(
        { HTTP_PROXY: 'http://proxy.internal:3128', HTTPS_PROXY: 'socks5://proxy.internal:1080' },
        asked,
      );
      expect(seen['NODE_USE_ENV_PROXY']).toBeNull();
      expect(seen['HTTPS_PROXY']).toBe('socks5://proxy.internal:1080');
    });
  });
});
