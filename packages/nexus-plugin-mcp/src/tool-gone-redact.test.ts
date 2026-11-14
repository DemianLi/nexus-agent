/**
 * 重連之後 server 少了一支工具，叫舊工具物件會拋 `no longer offered`（`index.ts`）：訊息帶著 server 當初給的工具名，
 * 工具名若含憑證值要遮掉（[#2669](https://github.com/DemianLi/nexus-agent/issues/2669)）。真的殺 stdio 子行程、真的重連。
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHostServicesPlugin } from '@nexus/core';
import { expect, it } from 'vitest';
import { MCP_CREDENTIALS_SERVICE } from './index.js';
import { loadPlugins, mcpEntry } from './load-with-adapter.js';

const FIXTURE_SERVER = fileURLToPath(new URL('./fixture-server.ts', import.meta.url));
const SECRET = 'FAKE-credential-0123456789';
const EXTRA = `extra_${SECRET}`;
const FAST = { initialDelayMs: 40, maxDelayMs: 160, maxAttempts: 5 } as const;

/** 只數命令列含這個記號的行程（不經 shell）。 */
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

it('重連後工具不見了：no longer offered 的訊息遮掉工具名裡的憑證值', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-gone-'));
  const dropFile = join(dir, 'drop');
  const marker = `--marker-${randomUUID()}`;
  const loaded = await loadPlugins([
    createHostServicesPlugin({
      [MCP_CREDENTIALS_SERVICE]: {
        resolve: (name) => (name === 'MCP_SECRET' ? SECRET : undefined),
      },
    }),
    mcpEntry({
      serverName: 'srv',
      connection: {
        transport: 'stdio',
        command: process.execPath,
        args: ['--import', 'tsx', FIXTURE_SERVER, marker],
        env: {
          FIXTURE_EXTRA_TOOL: EXTRA,
          FIXTURE_DROP_EXTRA_IF_FILE: dropFile,
          MCP_TOKEN: { credential: 'MCP_SECRET' },
        },
      },
      reconnect: FAST,
      approval: { default: 'allow' },
    }),
  ]);
  try {
    const name = `mcp__srv__${EXTRA}`;
    const tool = loaded.registry.tools.resolve(name)?.value;
    if (tool === undefined) throw new Error(`沒有註冊 ${name}`);
    writeFileSync(dropFile, '');
    const [pid] = pidsOf(marker);
    if (pid === undefined || !(Number.isInteger(pid) && pid > 1)) throw new Error('找不到子行程');
    process.kill(pid, 'SIGKILL');
    // 重連之後新的一代沒有這支工具：叫舊工具物件拿到 no longer offered。
    let message = '';
    const deadline = Date.now() + 10_000;
    while (!message.includes('no longer offered')) {
      if (Date.now() > deadline) throw new Error(`等太久了；最後一次訊息：${message}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
      message = await tool.invoke({}).then(
        () => '',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    }
    expect(message).not.toContain(SECRET);
    expect(message).toContain('[redacted]');
  } finally {
    await loaded.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
