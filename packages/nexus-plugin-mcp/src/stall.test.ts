/**
 * 卡死的 stdio server 能恢復嗎（[#2194](https://github.com/DemianLi/nexus-agent/issues/2194)）：**真的起子行程、真的讓事件迴圈空轉**，兩種協議各跑。
 * 要分得出兩件事：`spin` 之後什麼都收不到，要收掉重連；`hang` 只是那個呼叫不回，連線還活著，不能收。
 *
 * 每台子行程帶一個獨一無二的記號參數，用 `pgrep -f` 只數自己的（同 `reconnect.test.ts`）。
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { MultiServerMCPClient } from '@langchain/mcp-adapters';
import type { PluginRegistry } from '@nexus/core';
import { createHostServicesPlugin, loadPlugins, TURN_CANCEL_CONFIG_KEY } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';
import { connectGeneration, generationOf, isRequestTimeout, probeLiveness } from './connection.js';
import type { Generation, SdkClient } from './connection.js';
import { RELEASE_NOTE } from './fixture-tools.js';
import { createMcpPlugin, MCP_POOL_SERVICE, McpConnectionPool, mcpConfigSchema } from './index.js';
import type { McpPluginOptions } from './index.js';

const SERVERS = [
  ['舊協議', fileURLToPath(new URL('./fixture-server.ts', import.meta.url))],
  ['新協議', fileURLToPath(new URL('./modern-stdio-server.ts', import.meta.url))],
] as const;
const OLD_PROTOCOL = SERVERS[0][1];
const TOOL = 'mcp__srv__fetch_release_note';
const WINDOW_MS = 500;

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

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

async function waitFor(check: () => boolean, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function options(file: string, marker: string, extra: Partial<McpPluginOptions> = {}) {
  return {
    serverName: 'srv',
    connection: {
      transport: 'stdio',
      command: process.execPath,
      args: ['--import', 'tsx', file, marker],
      env: { FIXTURE_STALL_TOOLS: '1', FIXTURE_RESOURCES: '1' },
    },
    reconnect: { initialDelayMs: 40, maxDelayMs: 160, maxAttempts: 5 },
    toolCallTimeoutMs: WINDOW_MS,
    livenessTimeoutMs: WINDOW_MS,
    ...extra,
  } as McpPluginOptions;
}

async function assemble(file: string, extra: Partial<McpPluginOptions> = {}) {
  const marker = `--marker-${randomUUID()}`;
  const { registry, dispose } = await loadPlugins([createMcpPlugin(options(file, marker, extra))]);
  cleanup.push(dispose);
  return { registry, pids: () => pidsOf(marker), marker };
}

function invoke(registry: PluginRegistry, name: string, stop?: AbortController) {
  const found = registry.tools.resolve(name)?.value;
  if (found === undefined) throw new Error(`沒有註冊 ${name}`);
  return found.invoke(
    { topic: 'x' } as never,
    stop === undefined ? undefined : { configurable: { [TURN_CANCEL_CONFIG_KEY]: stop.signal } },
  );
}

/** 叫 `spin`，等它回完真的空轉起來。 */
async function spin(registry: PluginRegistry): Promise<void> {
  await invoke(registry, 'mcp__srv__spin');
  await sleep(100);
}

const warned = (registry: PluginRegistry) =>
  registry.logger.warnings().map(({ message }) => message);

/** 重連回來、叫得動為止；重連期間的呼叫回 `server is disconnected`。 */
async function recovered(registry: PluginRegistry): Promise<string> {
  for (let tries = 0; tries < 200; tries += 1) {
    const result = await invoke(registry, TOOL).catch(() => undefined);
    if (result !== undefined) return String(result);
    await sleep(25);
  }
  throw new Error('一直沒恢復');
}

describe.each(SERVERS)('%s', (_name, file) => {
  it('事件迴圈空轉：呼叫逾時之後收掉重連，舊行程不留，同一個工具物件又叫得動', async () => {
    const { registry, pids } = await assemble(file);
    const [before] = pids();
    await spin(registry);

    await expect(invoke(registry, TOOL)).rejects.toThrow();
    await waitFor(() => pids().length === 1 && pids()[0] !== before);

    expect(await recovered(registry)).toContain(RELEASE_NOTE);
    expect(pids()).toHaveLength(1);
    expect(warned(registry).join('\n')).toContain('mcp-client(srv): server stopped responding');
  });

  it('工具不回但事件迴圈活著：逾時之後不收，別的呼叫照常，等過窗口也一樣', async () => {
    const { registry, pids } = await assemble(file);
    const before = pids();

    await expect(invoke(registry, 'mcp__srv__hang')).rejects.toThrow();
    expect(String(await invoke(registry, TOOL))).toContain(RELEASE_NOTE);
    await sleep(WINDOW_MS * 3);

    expect(pids()).toEqual(before);
    expect(String(await invoke(registry, TOOL))).toContain(RELEASE_NOTE);
    expect(warned(registry).join('\n')).not.toContain('stopped responding');
  });

  it('按停止也探活：卡死的不用等下一個呼叫逾時，不回的工具照舊不收', async () => {
    const { registry, pids } = await assemble(file, { toolCallTimeoutMs: 60_000 });
    const [before] = pids();

    const stopHang = new AbortController();
    const hanging = invoke(registry, 'mcp__srv__hang', stopHang);
    await sleep(100);
    stopHang.abort();
    await expect(hanging).rejects.toThrow();
    await sleep(WINDOW_MS * 2);
    expect(pids()).toEqual([before]);

    await spin(registry);
    const stop = new AbortController();
    const stuck = invoke(registry, TOOL, stop);
    await sleep(100);
    stop.abort();
    await expect(stuck).rejects.toThrow();
    await waitFor(() => pids().length === 1 && pids()[0] !== before);
  });
});

describe('卡死之後', () => {
  it('進行中的別的呼叫回連線關閉，不等滿自己的逾時；重連期間的呼叫當場失敗', async () => {
    const { registry, pids } = await assemble(OLD_PROTOCOL, { toolCallTimeoutMs: 8_000 });
    const [before] = pids();
    await spin(registry);

    const start = Date.now();
    const stop = new AbortController();
    const first = invoke(registry, TOOL, stop);
    const second = invoke(registry, 'mcp__srv__hang').catch((error: unknown) => error);
    await sleep(50);
    stop.abort();
    await expect(first).rejects.toThrow();
    const failure = await second;

    expect(String(failure)).toMatch(/Connection closed|-32000/u);
    expect(Date.now() - start).toBeLessThan(8_000);
    expect(await recovered(registry)).toContain(RELEASE_NOTE);
    expect(pids()).not.toContain(before);
  });

  it('資源請求逾時也探活', async () => {
    const { registry, pids } = await assemble(OLD_PROTOCOL);
    const [before] = pids();
    await spin(registry);

    const found = registry.tools.resolve('list_mcp_resources')?.value;
    await expect(found?.invoke({ server: 'srv' } as never)).rejects.toThrow();

    await waitFor(() => pids().length === 1 && pids()[0] !== before);
  });

  it('連線池那條：一樣收掉重連，已經組好的對話叫得動', async () => {
    const pool = new McpConnectionPool({ log: () => {} });
    cleanup.push(() => pool.close());
    const marker = `--marker-${randomUUID()}`;
    const { registry, dispose } = await loadPlugins([
      createHostServicesPlugin({ [MCP_POOL_SERVICE]: pool }),
      createMcpPlugin(options(OLD_PROTOCOL, marker)),
    ]);
    cleanup.push(dispose);
    const [before] = pidsOf(marker);
    await spin(registry);

    await expect(invoke(registry, TOOL)).rejects.toThrow();
    await waitFor(() => pidsOf(marker).length === 1 && pidsOf(marker)[0] !== before);

    expect(await recovered(registry)).toContain(RELEASE_NOTE);

    const [second] = pidsOf(marker);
    await spin(registry);
    const found = registry.tools.resolve('list_mcp_resources')?.value;
    await expect(found?.invoke({ server: 'srv' } as never)).rejects.toThrow();
    await waitFor(() => pidsOf(marker).length === 1 && pidsOf(marker)[0] !== second);
  });

  it('只有 stdio 的一代帶探活窗口', async () => {
    const client = {
      getTools: () => Promise.resolve([]),
      getClient: () => Promise.resolve(undefined),
    } as unknown as MultiServerMCPClient;
    const base = { serverName: 'srv', livenessTimeoutMs: 7 };
    const stdio = await connectGeneration(
      client,
      mcpConfigSchema.parse({ ...base, connection: { transport: 'stdio', command: 'x' } }),
    );
    const http = await connectGeneration(
      client,
      mcpConfigSchema.parse({ ...base, connection: { transport: 'http', url: 'http://x.test' } }),
    );
    expect(stdio.livenessTimeoutMs).toBe(7);
    expect(http.livenessTimeoutMs).toBeUndefined();
  });

  it('省略時窗口是 15 秒', () => {
    const parsed = mcpConfigSchema.parse({
      serverName: 'srv',
      connection: { transport: 'stdio', command: 'x' },
    });
    expect(parsed.livenessTimeoutMs).toBe(15_000);
  });
});

describe('probeLiveness', () => {
  /** 一代假連線；`listTools` 交給測試決定怎麼落定。 */
  function fake(livenessTimeoutMs: number | undefined, listTools: () => Promise<never>) {
    const calls: unknown[] = [];
    const sdk = {
      listTools: (_params: unknown, options: unknown) => {
        calls.push(options);
        return listTools();
      },
    } as unknown as SdkClient;
    const generation: Generation = Object.assign(generationOf(new Map(), sdk), {
      ...(livenessTimeoutMs !== undefined && { livenessTimeoutMs }),
    });
    return { generation, calls };
  }
  const timedOut = Object.assign(new Error('timeout'), { code: 'REQUEST_TIMEOUT' });
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('探活逾時才算卡死，帶上窗口、不讀快取', async () => {
    const { generation, calls } = fake(7, () => Promise.reject(timedOut));
    let stalled = 0;
    probeLiveness(generation, () => (stalled += 1));
    await flush();
    expect(stalled).toBe(1);
    expect(calls).toEqual([{ timeout: 7, cacheMode: 'refresh' }]);
  });

  it('錯誤回應算活著：有人讀才回得了', async () => {
    const { generation } = fake(7, () => Promise.reject(new Error('MCP error -32601')));
    let stalled = 0;
    probeLiveness(generation, () => (stalled += 1));
    await flush();
    expect(stalled).toBe(0);
  });

  it('沒有窗口的一代（HTTP）不探', () => {
    const { generation, calls } = fake(undefined, () => Promise.reject(timedOut));
    probeLiveness(generation, () => {});
    expect(calls).toEqual([]);
  });

  it('同一代一次只探一個，落定之後可以再探', async () => {
    const { generation, calls } = fake(7, () => Promise.reject(new Error('x')));
    probeLiveness(generation, () => {});
    probeLiveness(generation, () => {});
    expect(calls).toHaveLength(1);
    await flush();
    probeLiveness(generation, () => {});
    expect(calls).toHaveLength(2);
  });

  it('逾時的兩種長相都認，沿 cause 往下找；別的錯不認', () => {
    expect(isRequestTimeout(timedOut)).toBe(true);
    expect(isRequestTimeout(new Error('x', { cause: timedOut }))).toBe(true);
    expect(isRequestTimeout(new DOMException('t', 'TimeoutError'))).toBe(true);
    expect(isRequestTimeout(new Error('nope'))).toBe(false);
    expect(isRequestTimeout(null)).toBe(false);
  });
});
