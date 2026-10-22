/**
 * `execution.taskSupport: 'required'` 的工具在叫用時當場拒絕（[#1572](https://github.com/DemianLi/nexus-agent/issues/1572) N0516），
 * 照 dsh `mcp-client/src/tools.ts:277-281`。**量在 server 那一側**：假 server 把每個收到的 `tools/call` 記到檔案（`FIXTURE_CALL_LOG`），
 * 「拒絕」的證據是檔案裡沒有那支工具，而不是 client 自己說沒送。
 *
 * CLI（plugin 自己連）與池（serve）兩條路各一組：兩邊都走 `connectGeneration`，但各自有一條紅燈，任何一邊拿掉包裝都會紅。
 * 只用舊協議那台：新協議（`2026-07-28`）的編碼會把 `execution.taskSupport` 當已刪欄位剝掉，那一代 server 根本公告不出來。
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANNEL_SERVICE, createHostServicesPlugin, loadPlugins } from '@nexus/core';
import type { PluginRegistry } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpPlugin, MCP_POOL_SERVICE, McpConnectionPool } from './index.js';
import type { McpPluginOptions } from './index.js';

const FIXTURE_SERVER = fileURLToPath(new URL('./fixture-server.ts', import.meta.url));
const REQUIRED = 'mcp__srv__needs_task';
const OPTIONAL = 'mcp__srv__task_optional';
const REFUSAL =
  'Tool "needs_task" requires task-based execution, which this bridge does not support';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** 一列接假 server 的設定；`calls()` 讀 server 那一側收到的 `tools/call` 工具名。 */
function row() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-mcp-task-'));
  cleanup.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const log = join(dir, 'calls.log');
  const options: McpPluginOptions = {
    serverName: 'srv',
    connection: {
      transport: 'stdio',
      command: process.execPath,
      args: ['--import', 'tsx', FIXTURE_SERVER, `--marker-${randomUUID()}`],
      env: { FIXTURE_TASK_TOOLS: '1', FIXTURE_CALL_LOG: log },
    },
    approval: { default: 'allow' },
  };
  const calls = (): string[] =>
    existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  return { options, calls };
}

function invoke(registry: PluginRegistry, name: string) {
  const found = registry.tools.resolve(name)?.value;
  if (found === undefined) throw new Error(`沒有註冊 ${name}`);
  return found.invoke({});
}

/** 兩條路共用的斷言：必須用 task 的被擋在 client 這一側，可選的照常送到 server。 */
async function expectRefusal(registry: PluginRegistry, calls: () => string[]): Promise<void> {
  // 兩支都照常列給模型（dsh 也是列出來、叫了才拒絕）。
  expect([...registry.tools.effective().keys()]).toEqual(
    expect.arrayContaining([REQUIRED, OPTIONAL]),
  );
  await expect(invoke(registry, REQUIRED)).rejects.toThrow(REFUSAL);
  // 對照：`optional` 照常執行，記錄檔也量得到——證明記錄檔不是永遠空的。
  expect(String(await invoke(registry, OPTIONAL))).toContain('ran');
  expect(calls()).toEqual(['task_optional']);
}

describe('taskSupport: required 的工具（#1572 N0516）', () => {
  it('CLI（plugin 自己連）：叫用當場拒絕，server 沒收到 tools/call', async () => {
    const { options, calls } = row();
    const { registry, dispose } = await loadPlugins([createMcpPlugin(options)]);
    cleanup.push(dispose);
    await expectRefusal(registry, calls);
  }, 30_000);

  it('池（serve）：叫用當場拒絕，server 沒收到 tools/call', async () => {
    const { options, calls } = row();
    const shared = new McpConnectionPool({ log: () => {} });
    cleanup.push(() => shared.close());
    const { registry, dispose } = await loadPlugins([
      createHostServicesPlugin({ [MCP_POOL_SERVICE]: shared, [CHANNEL_SERVICE]: undefined }),
      createMcpPlugin(options),
    ]);
    cleanup.push(dispose);
    await expectRefusal(registry, calls);
  }, 30_000);
});
