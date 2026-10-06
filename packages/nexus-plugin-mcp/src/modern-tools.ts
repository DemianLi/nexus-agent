/**
 * 測試用 MCP server 的工具，**新協議**（`2026-07-28`，`@modelcontextprotocol/server` 2.x）那一代的定義
 * （[#1095](https://github.com/DemianLi/nexus-agent/issues/1095)）。
 *
 * 與 [`fixture-tools.ts`](./fixture-tools.ts) 同名同行為——同一組斷言才跑得兩邊——另加兩支新協議才有的：
 *
 * - `protocol_info`：回**這一次請求在 server 那一側看到的**協議版本與 client 宣告的能力。「協商到新協議」與
 *   「沒宣告 elicitation」都量在 server 端，而不是在 client 端看我們自己傳了什麼。
 * - `ask`：要問使用者。新協議不再有 server 主動的 `elicitation/create` 請求，而是回一個 `inputRequired(...)` 結果，
 *   由 client 補完後重試（多輪往返）；client 沒宣告 elicitation 能力時，server 端的 SDK 就拒絕這一輪。
 *
 * 不進 `index.ts` 的匯出——它是測試素材。
 */

import { acceptedContent, inputRequired } from '@modelcontextprotocol/server';
import type { CallToolResult, InputRequiredResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { FAILURE_TEXT, RELEASE_NOTE, SNAPSHOT_PNG } from './fixture-tools.js';

/** `ask` 問使用者的問題。 */
export const ASK_MESSAGE = '要不要繼續？';

/** `protocol_info` 回的東西。 */
export interface ProtocolInfo {
  /** 這一次請求帶的協議版本（新協議每個請求都自帶）。 */
  readonly protocolVersion: unknown;
  /** client 宣告的能力。沒宣告 elicitation 時沒有 `elicitation` 這個鍵。 */
  readonly clientCapabilities: Readonly<Record<string, unknown>>;
}

/** 把這一組工具掛到一台新協議的 server 上。 */
export function registerModernTools(server: McpServer): void {
  server.registerTool(
    'fetch_release_note',
    {
      description: '回一則發行說明，模擬 MCP server 從外部拿到的資料。',
      inputSchema: z.object({ topic: z.string().describe('要查的主題') }),
    },
    ({ topic }): CallToolResult => ({
      content: [{ type: 'text', text: `${topic}｜${RELEASE_NOTE}` }],
    }),
  );

  server.registerTool(
    'legacy.ping',
    { description: '回一聲，名字刻意帶了句點。', inputSchema: z.object({}) },
    (): CallToolResult => ({ content: [{ type: 'text', text: 'pong' }] }),
  );

  server.registerTool(
    'fail',
    { description: '一定失敗，回 isError。', inputSchema: z.object({}) },
    (): CallToolResult => ({ isError: true, content: [{ type: 'text', text: FAILURE_TEXT }] }),
  );

  server.registerTool(
    'nullable_args',
    {
      description: '收一個可為 null 的字串與一個字串或數字的聯集。',
      inputSchema: z.object({
        label: z.string().nullable().describe('標籤，可為 null'),
        value: z.union([z.string(), z.number()]).optional().describe('字串或數字'),
      }),
    },
    ({ label, value }): CallToolResult => ({
      content: [{ type: 'text', text: JSON.stringify({ label, value }) }],
    }),
  );

  server.registerTool(
    'snapshot',
    { description: '回一張截圖，前後各一句說明。', inputSchema: z.object({}) },
    (): CallToolResult => ({
      content: [
        { type: 'text', text: '畫面之前' },
        { type: 'image', data: SNAPSHOT_PNG, mimeType: 'image/png' },
        { type: 'text', text: '畫面之後' },
      ],
    }),
  );

  server.registerTool(
    'protocol_info',
    {
      description: '回報這一次請求在 server 端看到的協議版本與 client 宣告的能力。',
      inputSchema: z.object({}),
    },
    (_args, ctx): CallToolResult => {
      const envelope = ctx.mcpReq.envelope as Readonly<Record<string, unknown>>;
      const info: ProtocolInfo = {
        protocolVersion: envelope['io.modelcontextprotocol/protocolVersion'],
        clientCapabilities: (envelope['io.modelcontextprotocol/clientCapabilities'] ??
          {}) as Record<string, unknown>,
      };
      return { content: [{ type: 'text', text: JSON.stringify(info) }] };
    },
  );

  // 要問使用者的工具。client 宣告了 elicitation 才會有人回答；沒宣告時，server 端的 SDK 拒絕這一輪、工具呼叫失敗。
  server.registerTool(
    'ask',
    { description: '要先問使用者一個是非題才做事。', inputSchema: z.object({}) },
    (_args, ctx): CallToolResult | InputRequiredResult => {
      const schema = z.object({ confirm: z.boolean() });
      const answer = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', schema);
      if (answer === undefined) {
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({ message: ASK_MESSAGE, requestedSchema: schema }),
          },
        });
      }
      return { content: [{ type: 'text', text: `使用者答了 ${String(answer.confirm)}` }] };
    },
  );
}
