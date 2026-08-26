/**
 * 手動驗證用的 plugin 清單：echo ＋ 一台假的 MCP server。
 *
 * ```
 * pnpm --filter @nexus/harness run cli --plugins src/cli-mcp.fixture.ts "回聲一下"
 * ```
 *
 * 它要證明的是自動測試證明不了的那一件事：**這支程式跑完會退出。** MCP server 是
 * stdio 子行程，它的 pipe 是活的 handle，沒有 `lifecycle` 通道把 client 收掉的話，CLI
 * 印完答案會停在那裡不動——而那個症狀在 vitest 裡看不到（worker 自己會被收掉）。
 *
 * echo 也在清單裡是刻意的：CLI 的假模型腳本是對著預設清單寫的，會呼叫 `echo`。少了它
 * 那一輪會拿到一個看不懂的失敗，把要看的東西蓋掉。MCP 的工具在這條路徑上只需要**被
 * 註冊起來**——它證明的是連線開了、然後被收掉。
 */

import { fileURLToPath } from 'node:url';
import type { NexusPlugin } from '@nexus/core';
import { createEchoPlugin } from '@nexus/plugin-echo';
import { createMcpPlugin } from '@nexus/plugin-mcp';

const FIXTURE_SERVER = fileURLToPath(new URL('./mcp-fixture-server.ts', import.meta.url));

export default [
  createEchoPlugin(),
  createMcpPlugin({
    serverName: 'docs',
    connection: {
      transport: 'stdio',
      command: process.execPath,
      args: ['--import', 'tsx', FIXTURE_SERVER],
    },
  }),
] satisfies NexusPlugin[];
