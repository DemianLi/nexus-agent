/**
 * 出處量測的 MCP 夾具 server（stdio，舊協議）。`CITATION_FIXTURE_MODE` 決定回 A、B 還是 C，見 [`fixture.ts`](./fixture.ts)。
 *
 * 不進 CI 的量測用它，單元測試也用它證明「三組的工具定義逐字相同」。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { GROUPS, linksFor, MODE_ENV, textFor, TOOL_DESCRIPTION, TOOL_NAME } from './fixture.js';
import type { Group } from './fixture.js';

const mode = process.env[MODE_ENV];
const group = GROUPS.find((candidate) => candidate === mode);
if (group === undefined) {
  process.stderr.write(`${MODE_ENV} 必須是 ${GROUPS.join('、')} 之一，拿到 ${String(mode)}\n`);
  process.exit(1);
}

function build(selected: Group): McpServer {
  const server = new McpServer({ name: 'citation-fixture', version: '0.0.0' });
  server.registerTool(
    TOOL_NAME,
    { description: TOOL_DESCRIPTION, inputSchema: { query: z.string().describe('要搜尋的內容') } },
    () => ({
      content: [
        { type: 'text' as const, text: textFor(selected) },
        ...linksFor(selected).map((link) => ({ type: 'resource_link' as const, ...link })),
      ],
    }),
  );
  return server;
}

await build(group).connect(new StdioServerTransport());
