/**
 * 掛上之後連線掉了會恢復嗎（[#1099](https://github.com/DemianLi/nexus-agent/issues/1099)）：**真的殺 stdio 子行程**。
 *
 * 退避與預算的逐毫秒判準在 [`supervisor.test.ts`](./supervisor.test.ts)（假計時器）；這裡量接線——已註冊的舊工具物件
 * 在重連之後又叫得動、定義逐位元組不變、關閉之後不再起新子行程、放棄之後工具對模型隱藏。零外部連線、不需要任何 key。
 *
 * 每台子行程帶一個獨一無二的記號參數，用 `pgrep -f` 只數自己的，所以同時跑的別的測試檔不會互相干擾。
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginRegistry } from '@nexus/core';
import { loadPlugins } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { createMcpPlugin } from './index.js';
import type { McpPluginOptions } from './index.js';
import { RELEASE_NOTE } from './fixture-tools.js';
import { MEMO_URI } from './resource-fixtures.js';
import { modelToolNames } from './tool-names.js';

const FIXTURE_SERVER = fileURLToPath(new URL('./fixture-server.ts', import.meta.url));
const MODERN_SERVER = fileURLToPath(new URL('./modern-stdio-server.ts', import.meta.url));
const FAST = { initialDelayMs: 40, maxDelayMs: 160, maxAttempts: 5 } as const;
const TOOL = 'mcp__srv__fetch_release_note';

/**
 * 命令列含記號的行程。**不經 shell**：`sh -c "pgrep … || true"` 在 Linux 的 dash 上不會 exec，shell 自己的命令列也含記號，
 * 會多數到一個（CI 上實際發生過）。`pgrep` 沒有任何命中時以 1 結束。
 */
function pidsOf(marker: string): number[] {
  try {
    return execFileSync('pgrep', ['-f', '--', marker])
      .toString()
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

/** 一台帶獨一無二記號的假 server；`pids()` 只數它自己的子行程。 */
function server(
  overrides: Partial<McpPluginOptions> = {},
  env: Record<string, string> = {},
): { plugin: ReturnType<typeof createMcpPlugin>; pids: () => number[]; marker: string } {
  const marker = `--marker-${randomUUID()}`;
  return {
    marker,
    pids: () => pidsOf(marker),
    plugin: createMcpPlugin({
      serverName: 'srv',
      connection: {
        transport: 'stdio',
        command: process.execPath,
        args: ['--import', 'tsx', FIXTURE_SERVER, marker],
        env: { FIXTURE_RESOURCES: '1', ...env },
      },
      reconnect: FAST,
      ...overrides,
    }),
  };
}

async function waitFor(check: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** 到目前為止這個 registry 的 logger 收到的話（只取訊息，不看是誰說的）。 */
const loggedBy = (registry: PluginRegistry): string[] =>
  registry.logger.warnings().map(({ message }) => message);

function invoke(registry: PluginRegistry, name: string, args: unknown = { topic: 'x' }) {
  const found = registry.tools.resolve(name)?.value;
  if (found === undefined) throw new Error(`沒有註冊 ${name}`);
  return found.invoke(args as never);
}

/** 給模型看的定義：名字、描述、參數 schema。 */
function definitions(registry: PluginRegistry): string {
  return JSON.stringify(
    modelToolNames(registry).map((name) => {
      const tool = registry.tools.resolve(name)?.value;
      return { name, description: tool?.description, schema: tool?.schema };
    }),
  );
}

/**
 * 對這些行程各送一次 SIGKILL。pid 不是大於 1 的整數就丟錯、不送：`process.kill(0, …)` 殺整個行程群組（含 vitest 主行程與外層 shell），
 * 而 `Number('')` 就是 0（#1712；`apps/harness/src/test-pids.fixture.ts` 是同一份）。
 */
const killAll = (pids: number[]) => {
  for (const pid of pids) {
    if (!(Number.isInteger(pid) && pid > 1))
      throw new RangeError(`不是可以送訊號的 pid：${String(pid)}`);
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      // 已經不在了（ESRCH）以外的錯不吞。
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
};

describe('殺掉 stdio 子行程', () => {
  it('舊工具物件在重連之後又叫得動，定義逐位元組不變，資源工具也恢復；進度寫進日誌', async () => {
    const s = server();
    const { registry, dispose } = await loadPlugins([s.plugin]);
    try {
      const before = registry.tools.resolve(TOOL)?.value;
      const defsBefore = definitions(registry);
      expect(String(await invoke(registry, TOOL))).toContain(RELEASE_NOTE);
      const pidsBefore = s.pids();
      expect(pidsBefore).toHaveLength(1);

      killAll(pidsBefore);
      // 斷線期間：工具照樣列在清單上，但呼叫失敗。
      expect(registry.tools.resolve(TOOL)).toBeDefined();
      await expect(invoke(registry, TOOL)).rejects.toThrow(
        /Not connected|Connection closed|server is disconnected/u,
      );

      await waitFor(async () => {
        try {
          await invoke(registry, TOOL);
          return true;
        } catch {
          return false;
        }
      });
      expect(String(await invoke(registry, TOOL))).toContain(RELEASE_NOTE);
      // 同一個物件、同樣的定義：重連沒有換掉註冊表上的任何東西，所以提示詞前綴不會因此失效。
      expect(registry.tools.resolve(TOOL)?.value).toBe(before);
      expect(definitions(registry)).toBe(defsBefore);
      // 資源工具走同一代 SDK client，重連之後也通。
      expect(
        String(await invoke(registry, 'read_mcp_resource', { server: 'srv', uri: MEMO_URI })),
      ).toContain('memo://readme');
      // 起的是新子行程。
      const pidsAfter = s.pids();
      expect(pidsAfter).toHaveLength(1);
      expect(pidsAfter[0]).not.toBe(pidsBefore[0]);

      const messages = loggedBy(registry);
      expect(
        messages.some((m) => m.includes('connection lost; reconnecting in 40ms (attempt 1/5)')),
      ).toBe(true);
      expect(messages.some((m) => m.includes('reconnected (attempt 1/5)'))).toBe(true);
      // 話記的是這顆外掛說的（`apply` 裡綁定的 origin），不是匿名的。
      expect(new Set(registry.logger.warnings().map(({ origin }) => origin.name))).toEqual(
        new Set(['mcp']),
      );
    } finally {
      await dispose();
    }
    expect(s.pids()).toEqual([]);
  }, 30_000);

  /**
   * **接收端壞了不能打斷重連**：重連的進度經 `registry.logger` 交給宿主的接收端，而 `report` 就在 `Supervisor.schedule` 裡、排計時器
   * **之前**呼叫。接收端拋錯若一路傳出來，`down()`（SDK 的 `onclose` 回呼）在排計時器之前就拋了，這台 server 再也不會重連。
   */
  it('宿主的接收端拋錯：照樣重連，不被打斷', async () => {
    const s = server();
    const { registry, dispose } = await loadPlugins([s.plugin]);
    try {
      registry.logger.exporter({
        export: () => {
          throw new Error('接收端壞了');
        },
      });
      killAll(s.pids());
      await waitFor(async () => {
        try {
          await invoke(registry, TOOL);
          return true;
        } catch {
          return false;
        }
      });
      expect(String(await invoke(registry, TOOL))).toContain(RELEASE_NOTE);
    } finally {
      await dispose();
    }
  }, 30_000);

  it('殺了立刻關閉：之後不再起新的子行程', async () => {
    const s = server({ reconnect: { initialDelayMs: 200, maxDelayMs: 400, maxAttempts: 5 } });
    const { dispose } = await loadPlugins([s.plugin]);
    killAll(s.pids());
    await new Promise((resolve) => setTimeout(resolve, 50)); // 讓 close 事件進來、重連排進計時器
    await dispose();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(s.pids()).toEqual([]);
  }, 30_000);

  it('reconnect.enabled: false：不重連，工具照列但呼叫失敗並講明', async () => {
    const s = server({ reconnect: { ...FAST, enabled: false } });
    const { registry, dispose } = await loadPlugins([s.plugin]);
    try {
      killAll(s.pids());
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(s.pids()).toEqual([]);
      expect(registry.tools.resolve(TOOL)).toBeDefined();
      await expect(invoke(registry, TOOL)).rejects.toThrow('reconnection was given up');
      expect(loggedBy(registry).some((m) => m.includes('reconnect is disabled'))).toBe(true);
    } finally {
      await dispose();
    }
  }, 30_000);

  it('連續失敗用完次數：放棄重連，工具對模型隱藏、註冊表上仍在，呼叫得到說明', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-mcp-giveup-'));
    const flag = join(dir, 'down');
    const s = server(
      { reconnect: { initialDelayMs: 20, maxDelayMs: 40, maxAttempts: 2 } },
      { FIXTURE_EXIT_IF_FILE: flag },
    );
    const { registry, dispose } = await loadPlugins([s.plugin]);
    try {
      const guard = registry.middleware
        .list()
        .map(
          (entry) =>
            (entry.value as { middleware?: { name?: string; wrapModelCall?: unknown } }).middleware,
        )
        .find((middleware) => middleware?.name === 'mcp-tools-guard:srv');
      const wrap = guard?.wrapModelCall as (
        request: { tools: { name: string }[] },
        handler: (request: { tools: { name: string }[] }) => unknown,
      ) => unknown;
      const tools = [{ name: TOOL }, { name: 'other_tool' }];
      const seen = (): string[] => {
        let names: string[] = [];
        void wrap({ tools }, (request) => {
          names = request.tools.map((t) => t.name);
          return undefined;
        });
        return names;
      };
      expect(seen()).toEqual([TOOL, 'other_tool']); // 沒放棄：原樣穿過

      writeFileSync(flag, '');
      killAll(s.pids());
      await waitFor(() =>
        loggedBy(registry).some((m) => m.includes('giving up after 2 consecutive')),
      );
      expect(seen()).toEqual(['other_tool']);
      expect(registry.tools.resolve(TOOL)).toBeDefined();
      await expect(invoke(registry, TOOL)).rejects.toThrow('reconnection was given up');
      const attempts = loggedBy(registry).filter((m) => m.includes('connection attempt failed'));
      expect(attempts).toHaveLength(2);
    } finally {
      await dispose();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(s.pids()).toEqual([]);
  }, 30_000);
});

/**
 * **收尾有期限**（[#1543](https://github.com/DemianLi/nexus-agent/issues/1543)）：重連卡在一台不回 initialize 的 server 上時，
 * 關閉不被它拖住。改之前同樣的布置要等 SDK 的請求逾時（實測約 120 秒）：dispose 先等進行中的握手，adapter 的 `close()` 也先等它。
 */
describe('握手卡住時關閉', () => {
  it('重連卡在握手：dispose 6 秒內回來，並記一句確認不到', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-mcp-hang-'));
    const flag = join(dir, 'hang');
    const marker = `--marker-${randomUUID()}`;
    const pids = () => pidsOf(marker);
    const { registry, dispose } = await loadPlugins([
      createMcpPlugin({
        serverName: 'srv',
        connection: {
          transport: 'stdio',
          command: process.execPath,
          args: ['--import', 'tsx', MODERN_SERVER, marker],
          env: { FIXTURE_HANG_IF_FILE: flag },
        },
        reconnect: FAST,
      }),
    ]);
    try {
      const first = pids();
      expect(first).toHaveLength(1);
      writeFileSync(flag, '');
      killAll(first);
      // 重連起了新的子行程，它正卡在握手。
      await waitFor(() => pids().some((pid) => !first.includes(pid)));
      const started = Date.now();
      await dispose();
      const elapsed = Date.now() - started;
      console.log(`#1543 dispose 花了 ${String(elapsed)} ms`);
      expect(elapsed).toBeLessThan(6000);
      expect(
        loggedBy(registry).some((m) =>
          m.includes(
            'mcp-client(srv): transport closure could not be confirmed during disposal — server shutdown may be incomplete',
          ),
        ),
      ).toBe(true);
    } finally {
      // 被丟下的握手要等到 SDK 的請求逾時才有人收；測試自己收掉，不留給別的測試檔的 pgrep。
      killAll(pids());
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * **重連前的關閉屏障**（#1543）：server 包在會起孫行程的 wrapper 裡（例如 `npx`），孫行程握著 stdout 時，SDK stdio 的 `close()`
 * 等 2 秒就回（送了訊號、不等 close 事件），子行程的 close 事件要等孫行程放手才來（實測：`close()` 2002 ms 回來，`onclose` 8 秒內
 * 沒來；沒有孫行程時兩者都是 6 ms）。這時起第二代，兩代 server 會同時活著，所以要停下來。
 */
describe('重連前的關閉屏障', () => {
  it('close 回來了、上一代卻確認不到關掉（孫行程握著 stdout）：不重連、標成放棄、記一句', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-mcp-grandchild-'));
    const grandchildren = join(dir, 'grandchildren');
    const marker = `--marker-${randomUUID()}`;
    const pids = () => pidsOf(marker);
    const { registry, dispose } = await loadPlugins([
      createMcpPlugin({
        serverName: 'srv',
        connection: {
          transport: 'stdio',
          command: process.execPath,
          args: ['--import', 'tsx', MODERN_SERVER, marker],
          env: { FIXTURE_GRANDCHILD_PID_FILE: grandchildren, FIXTURE_DROP_TOOL: '1' },
        },
        reconnect: FAST,
      }),
    ]);
    try {
      const first = pids();
      expect(first).toHaveLength(1);
      // 工具呼叫回「Connection closed」：外掛把這一代判成斷線、走 down()，而 transport 這時還開著。
      await expect(invoke(registry, 'mcp__srv__drop_connection', {})).rejects.toThrow(
        'Connection closed',
      );
      await waitFor(() =>
        loggedBy(registry).some((m) =>
          m.includes(
            'mcp-client(srv): failed generation could not confirm transport closure — reconnect stopped to avoid overlapping server processes',
          ),
        ),
      );
      // 先確認再排：沒有先冒一句「reconnecting in」，也沒有起第二代。
      expect(loggedBy(registry).some((m) => m.includes('reconnecting in'))).toBe(false);
      expect(pids().filter((pid) => !first.includes(pid))).toEqual([]);
      await expect(invoke(registry, TOOL)).rejects.toThrow('reconnection was given up');
    } finally {
      await dispose();
      // 孫行程會自己活 30 秒；測試自己收掉，不留孤兒。
      if (existsSync(grandchildren)) {
        killAll(readFileSync(grandchildren, 'utf8').split('\n').filter(Boolean).map(Number));
      }
      killAll(pids());
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
