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
import { loadPlugins } from '@nexus/core';
import { describe, expect, it, vi } from 'vitest';
import { createMcpPlugin, MCP_CAPABILITY } from './index.js';
import { RELEASE_NOTE } from './fixture-server.js';
import { publicToolName } from './names.js';

const FIXTURE_SERVER = fileURLToPath(new URL('./fixture-server.ts', import.meta.url));

/**
 * 連上假 server 的 plugin。
 *
 * 用 `node --import tsx` 而不是直接跑 `tsx`：`process.execPath` 一定是正在跑測試的那個
 * node，不必猜 `.bin` 在哪裡，也不會因為 PATH 不同而在 CI 上換一個行為。
 */
function fixturePlugin(serverName = 'fixture') {
  return createMcpPlugin({
    serverName,
    connection: {
      transport: 'stdio',
      command: process.execPath,
      args: ['--import', 'tsx', FIXTURE_SERVER],
    },
  });
}

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

describe('createMcpPlugin 的設定檢查', () => {
  it('serverName 不合法時當場報錯，不必等到連線', () => {
    expect(() => createMcpPlugin({ serverName: 'has space', connection: emptyStdio() })).toThrow(
      'serverName "has space"',
    );
    expect(() => createMcpPlugin({ serverName: '', connection: emptyStdio() })).toThrow(
      '[A-Za-z0-9_-]',
    );
  });
});

describe('接上一台真的 MCP server', () => {
  it('工具以 mcp__<server>__<raw> 註冊，能力也宣告了', async () => {
    const { registry, dispose } = await loadPlugins([fixturePlugin()]);
    try {
      expect([...registry.tools.effective().keys()]).toEqual([
        'mcp__fixture__fetch_release_note',
        expect.stringMatching(/^mcp__fixture__legacy_ping_[0-9a-f]{12}$/),
      ]);
      expect(registry.capabilities.has(MCP_CAPABILITY)).toBe(true);
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

  it('同一台 server 掛兩次撞在工具那一層，訊息指名兩個 plugin', async () => {
    // `name` 不唯一是刻意的，所以撞不在 plugin 清單那一層——撞在它們註冊的東西上。
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

  it('連不上就讓整份清單載入失敗，不是安靜地少幾個工具', async () => {
    // 一個立刻結束、什麼都不印的子行程：連得上 stdio、握不成手。用它而不是一個不存在
    // 的檔案，是為了讓這條測試通過時 CI 的輸出是乾淨的——子行程的 stderr 預設 inherit。
    const plugin = createMcpPlugin({
      serverName: 'missing',
      connection: { transport: 'stdio', command: process.execPath, args: ['-e', ''] },
    });
    await expect(loadPlugins([plugin])).rejects.toThrow('mcp#0 (mcp)');
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

/** 只用來餵設定檢查，不會真的去連。 */
function emptyStdio() {
  return { transport: 'stdio', command: process.execPath, args: [] } as const;
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
