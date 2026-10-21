/**
 * 宿主的 MCP 連線池（[#1677](https://github.com/DemianLi/nexus-agent/issues/1677)）：**真的起 stdio 子行程**，用 `pgrep -f` 數
 * server 那一側。plugin 經 `createHostServicesPlugin` 拿到池，跟 serve 交池的方式一樣；每一次 `loadPlugins` 是一份組裝（一條 thread）。
 *
 * 退避的逐毫秒判準在 [`supervisor.test.ts`](./supervisor.test.ts)；serve 上的行程數在 harness 的 `mcp-shared-connection.test.ts`。
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHostServicesPlugin, loadPlugins } from '@nexus/core';
import type { PluginRegistry, PreToolDecision, PreToolListener } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';
import { RELEASE_NOTE } from './fixture-tools.js';
import { createMcpPlugin, MCP_POOL_SERVICE, McpConnectionPool, mcpConfigSchema } from './index.js';
import type { McpPluginOptions } from './index.js';
import { poolKey } from './pool.js';
import { modelToolNames } from './tool-names.js';

const FIXTURE_SERVER = fileURLToPath(new URL('./fixture-server.ts', import.meta.url));
const FAST = { initialDelayMs: 40, maxDelayMs: 160, maxAttempts: 5 } as const;
const TOOL = 'mcp__srv__fetch_release_note';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** 命令列含記號的行程；不經 shell（同 `reconnect.test.ts`）。 */
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

const killAll = (pids: number[]) => {
  for (const pid of pids) {
    if (!(Number.isInteger(pid) && pid > 1))
      throw new RangeError(`不是可以送訊號的 pid：${String(pid)}`);
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
};

async function waitFor(check: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** 一份池，測試結束時關；`logged` 是池的日誌（serve 給伺服器日誌）。 */
function pool(): { pool: McpConnectionPool; logged: string[] } {
  const logged: string[] = [];
  const created = new McpConnectionPool({ log: (message) => logged.push(message) });
  cleanup.push(() => created.close());
  return { pool: created, logged };
}

/** 一列設定，帶獨一無二的記號；`flag` 存在時 server 一啟動就退出（模擬起不來）。 */
function row(overrides: Partial<McpPluginOptions> = {}) {
  const marker = `--marker-${randomUUID()}`;
  const dir = mkdtempSync(join(tmpdir(), 'nexus-mcp-pool-'));
  cleanup.push(() => {
    killAll(pidsOf(marker));
    rmSync(dir, { recursive: true, force: true });
  });
  const flag = join(dir, 'down');
  const options: McpPluginOptions = {
    serverName: 'srv',
    connection: {
      transport: 'stdio',
      command: process.execPath,
      args: ['--import', 'tsx', FIXTURE_SERVER, marker],
      env: { FIXTURE_EXIT_IF_FILE: flag },
    },
    approval: { default: 'allow' },
    reconnect: FAST,
    ...overrides,
  };
  return {
    options,
    pids: () => pidsOf(marker),
    down: () => writeFileSync(flag, ''),
    up: () => unlinkSync(flag),
  };
}

/** 一份組裝（一條 thread）：池經宿主服務交進去。 */
async function assemble(shared: McpConnectionPool, options: McpPluginOptions) {
  const loaded = await loadPlugins([
    createHostServicesPlugin({ [MCP_POOL_SERVICE]: shared }),
    createMcpPlugin(options),
  ]);
  cleanup.push(() => loaded.dispose());
  return loaded;
}

function invoke(registry: PluginRegistry, name = TOOL, args: unknown = { topic: 'x' }) {
  const found = registry.tools.resolve(name)?.value;
  if (found === undefined) throw new Error(`沒有註冊 ${name}`);
  return found.invoke(args as never);
}

const warned = (registry: PluginRegistry): string[] =>
  registry.logger.warnings().map(({ message }) => message);

/** 放棄後隱藏工具的那顆 middleware 現在讓模型看到哪些名字（同 `reconnect.test.ts`）。 */
function visible(registry: PluginRegistry): string[] {
  const guard = registry.middleware
    .list()
    .map(
      (entry) =>
        (entry.value as { middleware?: { name?: string; wrapModelCall?: unknown } }).middleware,
    )
    .find((middleware) => middleware?.name === 'mcp-tools-guard:srv');
  if (guard === undefined) return [];
  const wrap = guard.wrapModelCall as (
    request: { tools: { name: string }[] },
    handler: (request: { tools: { name: string }[] }) => unknown,
  ) => unknown;
  let names: string[] = [];
  void wrap({ tools: [{ name: TOOL }] }, (request) => {
    names = request.tools.map((t) => t.name);
    return undefined;
  });
  return names;
}

describe('同一份設定整個池一份連線', () => {
  it('三份組裝同時取用：只起 1 個子行程；各有自己的工具物件、名字與定義相同、都叫得動；撤掉一份不關連線', async () => {
    const { pool: shared } = pool();
    const r = row();
    const [a, b, c] = await Promise.all([
      assemble(shared, r.options),
      assemble(shared, r.options),
      assemble(shared, r.options),
    ]);
    expect(r.pids()).toHaveLength(1);
    for (const { registry } of [a, b, c]) {
      // 池裡的物件沒被第一份改過名：每一份都是 `mcp__srv__<raw>`，不是疊兩層前綴。
      expect(modelToolNames(registry)).toContain(TOOL);
      expect(String(await invoke(registry))).toContain(RELEASE_NOTE);
    }
    const objects = [a, b, c].map(({ registry }) => registry.tools.resolve(TOOL)?.value);
    expect(new Set(objects).size).toBe(3);
    const definition = (registry: PluginRegistry) => {
      const tool = registry.tools.resolve(TOOL)?.value;
      return JSON.stringify({ description: tool?.description, schema: tool?.schema });
    };
    expect(new Set([a, b, c].map(({ registry }) => definition(registry))).size).toBe(1);

    await a.dispose();
    expect(r.pids()).toHaveLength(1);
    expect(String(await invoke(b.registry))).toContain(RELEASE_NOTE);

    await shared.close();
    await waitFor(() => r.pids().length === 0);
  }, 30_000);

  it('同時取用共用同一次連線：同一份物件', async () => {
    const { pool: shared } = pool();
    const config = mcpConfigSchema.parse(row().options);
    const [first, second] = await Promise.all([
      shared.acquire(config, false),
      shared.acquire(config, false),
    ]);
    expect(second).toBe(first);
  }, 30_000);
});

describe('池的鍵', () => {
  const base = mcpConfigSchema.parse(row().options);

  it('只改 approval：同一份（核准宣告只管每份註冊表的閘門）', () => {
    const changed = mcpConfigSchema.parse({ ...base, approval: { default: 'ask', exempt: ['x'] } });
    expect(poolKey(changed, true)).toBe(poolKey(base, true));
  });

  it('改連線設定、改 serverName、elicitation 旗標不同：各一份', () => {
    const args = mcpConfigSchema.parse({
      ...base,
      connection: { ...base.connection, args: ['--version'] },
    });
    const renamed = mcpConfigSchema.parse({ ...base, serverName: 'other' });
    const keys = [
      poolKey(base, true),
      poolKey(base, false),
      poolKey(args, true),
      poolKey(renamed, true),
    ];
    expect(new Set(keys).size).toBe(4);
  });

  it('鍵與物件的欄位順序無關', () => {
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as typeof base;
    expect(poolKey(reordered, true)).toBe(poolKey(base, true));
  });

  it('elicitation 旗標不同的兩次取用各起一個子行程', async () => {
    const { pool: shared } = pool();
    const r = row();
    const config = mcpConfigSchema.parse(r.options);
    const [human, none] = await Promise.all([
      shared.acquire(config, true),
      shared.acquire(config, false),
    ]);
    expect(human).not.toBe(none);
    expect(r.pids()).toHaveLength(2);
  }, 30_000);
});

describe('第一次就連不上', () => {
  it('failOnStartupError: true：拋，池裡不留；server 恢復之後下一次取用重新連', async () => {
    const { pool: shared } = pool();
    const r = row({ failOnStartupError: true });
    r.down();
    await expect(assemble(shared, r.options)).rejects.toThrow();
    // 不在背景重試：過了好幾個退避間隔也沒有新的子行程。
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(r.pids()).toEqual([]);

    r.up();
    const { registry } = await assemble(shared, r.options);
    expect(String(await invoke(registry))).toContain(RELEASE_NOTE);
  }, 30_000);

  it('沒寫 failOnStartupError：這份組裝沒有工具並警告；背景重試連上之後新組裝有、舊的照偏離 2 沒有', async () => {
    const { pool: shared, logged } = pool();
    const r = row({ reconnect: { ...FAST, maxAttempts: 1000 } });
    r.down();
    const before = await assemble(shared, r.options);
    expect(modelToolNames(before.registry)).toEqual([]);
    expect(
      warned(before.registry).some((m) => m.includes('連不上、列不出工具或工具註冊不上')),
    ).toBe(true);

    r.up();
    await waitFor(() => logged.some((m) => m.startsWith('mcp-client(srv): reconnected')));
    expect(r.pids()).toHaveLength(1);
    const after = await assemble(shared, r.options);
    expect(String(await invoke(after.registry))).toContain(RELEASE_NOTE);
    expect(modelToolNames(before.registry)).toEqual([]);
    // 重試的進度寫進池的日誌，不寫進哪一份組裝。
    expect(logged.some((m) => m.startsWith('mcp-client(srv): connection failed; retrying'))).toBe(
      true,
    );
    expect(warned(after.registry)).toEqual([]);
    expect(r.pids()).toHaveLength(1);
  }, 30_000);
});

describe('放棄重連之後（Q5 (b)）', () => {
  it('開著的組裝照舊隱藏工具、呼叫說已放棄；下一份組裝取用時重開，拿得到工具', async () => {
    const { pool: shared, logged } = pool();
    const r = row({ reconnect: { initialDelayMs: 20, maxDelayMs: 40, maxAttempts: 2 } });
    const old = await assemble(shared, r.options);
    expect(visible(old.registry)).toEqual([TOOL]);

    r.down();
    killAll(r.pids());
    await waitFor(() => logged.some((m) => m.includes('giving up after 2 consecutive')));
    expect(visible(old.registry)).toEqual([]);

    r.up();
    const fresh = await assemble(shared, r.options);
    expect(visible(fresh.registry)).toEqual([TOOL]);
    expect(String(await invoke(fresh.registry))).toContain(RELEASE_NOTE);
    // 開著的那一份停在舊的監督者上：重開不讓它的工具又露出來、又叫得動。
    expect(visible(old.registry)).toEqual([]);
    await expect(invoke(old.registry)).rejects.toThrow('reconnection was given up');
    expect(r.pids()).toHaveLength(1);
  }, 30_000);
});

describe('關池', () => {
  it('收掉每一份（含被重開取代的），之後取用被拒', async () => {
    const { pool: shared } = pool();
    const one = row();
    const two = row();
    await assemble(shared, one.options);
    await assemble(shared, two.options);
    expect(one.pids()).toHaveLength(1);
    expect(two.pids()).toHaveLength(1);
    await shared.close();
    await waitFor(() => one.pids().length === 0 && two.pids().length === 0);
    await expect(shared.acquire(mcpConfigSchema.parse(one.options), false)).rejects.toThrow(
      '已經關了',
    );
  }, 30_000);
});

describe('核准閘門（#1622；#1677 驗收 L）', () => {
  const BOTTOM: PreToolDecision = { kind: 'deny', reason: '鏈底' };
  const decide = (gate: PreToolListener, name: string) =>
    gate({ name, args: {}, callId: 'c' }, () => Promise.resolve(BOTTOM));

  it('掛上當下連不上、背景重試連上之後：新組裝的閘門照樣生效；連不上那段的組裝不留閘門；閘門一份註冊表一顆', async () => {
    const { pool: shared, logged } = pool();
    const r = row({ approval: { default: 'ask' }, reconnect: { ...FAST, maxAttempts: 1000 } });
    r.down();
    const before = await assemble(shared, r.options);
    expect(before.registry.approvals.listeners()).toEqual([]);

    r.up();
    await waitFor(() => logged.some((m) => m.startsWith('mcp-client(srv): reconnected')));
    const [one, two] = await Promise.all([
      assemble(shared, r.options),
      assemble(shared, r.options),
    ]);
    for (const { registry } of [one, two]) {
      const listeners = registry.approvals.listeners();
      expect(listeners).toHaveLength(1);
      expect((await decide(listeners[0]!.value, TOOL)).kind).toBe('ask');
    }
    expect(before.registry.approvals.listeners()).toEqual([]);
  }, 30_000);
});
