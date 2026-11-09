/**
 * MCP 連線池前後測（#2570）的 stdio server：一支 `lookup` 工具，回一小段固定文字。
 *
 * 用純 `node` 跑（Node 的型別剝除，不經 tsx），子行程的 RSS 與起動 CPU 才是一個普通 node 行程的量，不含轉譯器。
 * 所以這一檔只能用可剝除的語法，也不 import 本 repo 的其他檔。
 *
 * 每個事件追加一行 JSON 到 `MCP_POOL_LOG`：`start`（行程起來）、`initialized`（握手完成）、`call`（收到一次 `tools/call`）。
 * 驅動拿它數 initialize 次數、算首次呼叫延遲。`--tag <字串>` 只是讓 cmdline 分得出是哪一組起的。
 */

import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const logPath = process.env.MCP_POOL_LOG;
const name = process.env.MCP_POOL_SERVER ?? 'stdio';

function record(ev: string, extra: Record<string, unknown> = {}): void {
  if (logPath === undefined) return;
  appendFileSync(
    logPath,
    `${JSON.stringify({ server: name, pid: process.pid, ev, at: Date.now(), ...extra })}\n`,
  );
}

record('start');
const server = new McpServer({ name: `mcp-pool-${name}`, version: '0.0.0' });
server.server.oninitialized = () => {
  record('initialized');
};
server.registerTool(
  'lookup',
  { description: '查一筆資料，回一小段文字。', inputSchema: { q: z.string() } },
  ({ q }) => {
    record('call');
    return {
      content: [{ type: 'text', text: `${name} 查到 ${q}：狀態正常，最近一次更新在上週。` }],
    };
  },
);
await server.connect(new StdioServerTransport());
