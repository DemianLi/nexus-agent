/**
 * 測試用的 stdio MCP server：把它環境裡的一個變數回顯在失敗訊息裡（認證失敗的伺服器常這樣），原值與 URL 編碼各一次
 * （[#2669](https://github.com/DemianLi/nexus-agent/issues/2669)）。
 *
 * 另開一台、不加進 `fixture-tools.ts`：那份工具清單被好幾支測試逐項斷言，多一支會讓它們全部要改。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'nexus-echo-error', version: '0.0.0' });
server.registerTool(
  'echo_env_error',
  {
    description: '失敗，訊息回顯指定環境變數的值。',
    inputSchema: { name: z.string().describe('要回顯的變數名') },
  },
  ({ name }) => {
    const value = process.env[name] ?? '';
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `auth rejected: ${value} (as query: ?k=${encodeURIComponent(value)})`,
        },
      ],
    };
  },
);
await server.connect(new StdioServerTransport());
