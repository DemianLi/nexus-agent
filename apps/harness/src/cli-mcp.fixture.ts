/**
 * 手動驗證用的 plugin：假的 MCP server。
 *
 * ```bash
 * pnpm --filter @nexus/harness run cli --patch src/cli-mcp.patch.yml "回聲一下"
 * ```
 *
 * 它要證明的是自動測試證明不了的那一件事：**這支程式跑完會退出。** MCP server 是
 * stdio 子行程，它的 pipe 是活的 handle，沒有 `lifecycle` 通道把 client 收掉的話，CLI
 * 印完答案會停在那裡不動——而那個症狀在 vitest 裡看不到（worker 自己會被收掉）。
 *
 * 出貨清單裡已經有 `echo`，所以這一份不再自己列一顆。MCP 的工具在這條路徑上只需要**被
 * 註冊起來**——它證明的是連線開了、然後被收掉。
 *
 * **為什麼包一層，而不是把 config 寫進 patch 檔**（[#455](https://github.com/DemianLi/nexus-agent/issues/455)）：
 * server 的路徑要從 `import.meta.url` 在執行期算出來，而 patch 檔只寫得下字面值。絕對路徑
 * 是機器相關的，寫進版控就換一台機器就壞。代價是這一顆的設定不會出現在 `--dump-config` 的
 * 樹上——手動 fixture 收得下這個代價，正式的 plugin 不該這樣掛。
 */

import { fileURLToPath } from 'node:url';

import type { NexusPlugin } from '@nexus/core';
import { mcpConfigSchema, mcpPlugin } from '@nexus/plugin-mcp';

const FIXTURE_SERVER = fileURLToPath(new URL('./mcp-fixture-server.ts', import.meta.url));

/**
 * 原封不動地委派給真的 MCP plugin，只是設定在這裡算。
 *
 * **`Config` 刻意不轉出去**：轉出去的話 patch 檔就得給一份設定，而那份設定裡有一個它寫不
 * 出來的值。設定在這裡 `parse` 一次，走的是跟 `resolveEntries` 同一份 schema，所以預設值
 * （例如 `toolCallTimeoutMs`）不會因為繞過組裝而不一樣。
 */
const mcpFixture: NexusPlugin = {
  name: 'mcp-fixture',
  apply: async (registry) =>
    mcpPlugin.apply(
      registry,
      mcpConfigSchema.parse({
        serverName: 'docs',
        connection: {
          transport: 'stdio',
          command: process.execPath,
          args: ['--import', 'tsx', FIXTURE_SERVER],
        },
      }),
    ),
};

export default mcpFixture;
