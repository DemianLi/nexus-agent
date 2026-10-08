/**
 * 各台 MCP server 共用的那一份：資源工具與 server 指引的提示詞（[#430](https://github.com/DemianLi/nexus-agent/issues/430)、
 * [#431](https://github.com/DemianLi/nexus-agent/issues/431)）。
 *
 * **一個 plugin 實例對一台 server，但資源工具只有一組。** dsh 的 `mcp-resources` 是獨立套件：三支工具
 * （`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`）由 `McpResourceRuntime` 在第一台 server
 * 登記時註冊，之後每台 server 只把自己的 provider 登記進去，工具以 `server` 參數選要問哪一台
 * （`packages/mcp/mcp-resources/src/index.ts`，`5badb150`）。我們沒有 cordis 的 context 樹，所以退到最接近的表達：
 * 第一個走到登記那一步的 `mcp` 列用 `services`（`mcp:hub`）建這個 hub 並註冊三支工具與一顆 middleware，後面的列
 * 只 {@link McpHub.add} 自己的 {@link McpSource}。
 *
 * ## 偏離登記
 *
 * 1. **載體**：dsh 的 server 指引與「可用的資源 server 有哪些」是 `systemPrompt.section(...)` 兩種段落
 *    （`mcp-client/src/server-context.ts`、`mcp-resources/src/index.ts`）。我們的提示詞是 middleware 一層層接出來的，
 *    沒有段落註冊點，所以退到 `wrapModelCall` 把文字接到 system message 後面（同 plan-mode、sandbox-policy，
 *    與 goal 登記過的同一條偏離）。**`concat` 不取代**，記憶與摘要器也在這份 system message 上加東西。
 * 2. **提示詞只在載入期定下來**：dsh 的 `instructions()` 讀「最近一次成功連線」的快照，重連會換；我們不重連
 *    （`index.ts` 檔頭的偏離），所以文字在登記那一刻就定了，每一輪逐位元組相同（不吃 KV cache）。disposal 才會移掉。
 * 3. **起不來的那一列也登記**：dsh 的 provider 登記不看連線成敗，呼叫時才報 `disconnected`；這裡一樣——名字照列、
 *    工具照在，叫它得到一句固定的「不可用」。
 *
 * 其餘照 dsh：三支工具的名字、描述、參數一字不差；`list` 是**單頁**，`cursor` 原樣交給 server，下一頁怎麼翻由模型
 * 帶 `nextCursor` 再叫一次；`read` 的二進位 `blob` 在給模型的文字裡換成一句描述。
 *
 * @module
 */

import type { StructuredTool } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import type { AgentMiddleware, PluginRegistry } from '@nexus/core';
import { createMiddleware } from 'langchain';
import { z } from 'zod';

/** hub 在 `services` 上的名字。 */
export const MCP_HUB_SERVICE = 'mcp:hub';

/** 一個資源操作；cursor 與 uri 都是 server 自己的，原樣交過去。 */
export type McpResourceRequest =
  | { readonly method: 'resources/list' | 'resources/templates/list'; readonly cursor?: string }
  | { readonly method: 'resources/read'; readonly uri: string };

/** 一台 server 登記進 hub 的東西。 */
export interface McpSource {
  /** 設定的 `serverName`，也是工具 `server` 參數認的名字。 */
  readonly serverName: string;
  /**
   * 這台 server 的指引，已含出處標頭（`### MCP server: <name>\n\n<內容>`）；沒有就是空字串。登記那一刻就定了。
   */
  readonly instructions: string;
  /**
   * 對這台 server 做一個資源操作，回協議的原始結果。
   * @param request - 操作。
   * @param signal - 這次工具呼叫的中止訊號。
   * @throws 連不上、已關閉、server 不支援這個方法，或逾時。
   */
  request(request: McpResourceRequest, signal: AbortSignal | undefined): Promise<unknown>;
}

/** 共用的那一份。 */
export interface McpHub {
  /** 登記一台 server；回的函式撤銷這一次登記（冪等）。同名重複登記由呼叫端用 `mcp:server:<name>` 先擋掉。 */
  add(source: McpSource): () => void;
}

/** 三支工具的名字，給提示詞段落與測試用。 */
export const RESOURCE_TOOL_NAMES = [
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
] as const;

/**
 * 協議在結果上加的、對模型沒有用處的欄位（新協議的 `_meta`、快取提示 `ttlMs`／`cacheScope`）。只在**頂層**拿掉，
 * 完整的結果仍在工具的 artifact 裡。
 */
const ENVELOPE_KEYS: ReadonlySet<string> = new Set(['_meta', 'ttlMs', 'cacheScope']);

/** 給模型看的那一份：出處標頭加 JSON，二進位內容換成描述。 */
export function renderResourceResult(serverName: string, value: unknown): string {
  const rendered = JSON.stringify(value, function (this: unknown, key: string, item: unknown) {
    if (key === 'blob' && typeof item === 'string') {
      return `[binary resource: ${String(item.length)} base64 characters; available to programmatic callers]`;
    }
    // 頂層：`this` 是 JSON.stringify 包的那個 `{ '': value }`。
    if (ENVELOPE_KEYS.has(key) && isRoot(this, value)) return undefined;
    return item;
  });
  return `MCP server: ${serverName}\n${rendered}`;
}

function isRoot(holder: unknown, root: unknown): boolean {
  return holder === root;
}

/** 提示詞要接在 system message 後面的文字；沒有任何 server 登記時是空字串。 */
export function hubPromptText(sources: Iterable<McpSource>): string {
  const all = [...sources];
  if (all.length === 0) return '';
  const names = all.map((source) => source.serverName).sort();
  const sections = [
    '## MCP resource servers\n\n' +
      `Use ${RESOURCE_TOOL_NAMES.join(', ')} with one of these names as the server argument: ${JSON.stringify(names)}.`,
  ];
  for (const source of all) if (source.instructions !== '') sections.push(source.instructions);
  return sections.join('\n\n');
}

const listParameters = z.object({
  server: z.string().describe('Configured MCP server name.'),
  cursor: z.string().optional().describe('Continuation cursor returned by this server.'),
});

/**
 * 取這次組裝的 hub；第一次叫就建（註冊三支工具與 middleware，並提供 `mcp:hub`）。
 *
 * 建到一半拋錯的話，已經註冊的撤掉再拋，不留下半套。
 */
export function ensureHub(registry: PluginRegistry): McpHub {
  const existing = registry.services.get<McpHub>(MCP_HUB_SERVICE);
  if (existing !== undefined) return existing;

  const sources = new Map<string, McpSource>();
  const undos: (() => void)[] = [];
  try {
    const find = (server: string): McpSource => {
      const source = sources.get(server);
      if (source === undefined) throw new Error(`MCP resource server "${server}" is unavailable`);
      return source;
    };
    const resourceTool = (
      name: string,
      description: string,
      schema: z.ZodObject,
      build: (args: Record<string, string | undefined>) => McpResourceRequest,
    ): StructuredTool =>
      tool(
        async (args: Record<string, string | undefined>, config?: { signal?: AbortSignal }) => {
          const server = args['server'] ?? '';
          const value = await find(server).request(build(args), config?.signal);
          return [renderResourceResult(server, value), value];
        },
        { name, description, schema, responseFormat: 'content_and_artifact' },
      ) as unknown as StructuredTool;

    undos.push(
      registry.tools.register(
        resourceTool(
          'list_mcp_resources',
          'List resources available from an MCP server.',
          listParameters,
          (args) => ({
            method: 'resources/list',
            ...(args['cursor'] === undefined ? {} : { cursor: args['cursor'] }),
          }),
        ),
      ),
      registry.tools.register(
        resourceTool(
          'list_mcp_resource_templates',
          'List parameterized resource URI templates from an MCP server.',
          listParameters,
          (args) => ({
            method: 'resources/templates/list',
            ...(args['cursor'] === undefined ? {} : { cursor: args['cursor'] }),
          }),
        ),
      ),
      registry.tools.register(
        resourceTool(
          'read_mcp_resource',
          'Read an MCP resource by URI from the named server. Use a listed URI or an expanded resource template.',
          z.object({
            server: listParameters.shape.server,
            uri: z.string().describe('Resource URI to read.'),
          }),
          (args) => ({ method: 'resources/read', uri: args['uri'] ?? '' }),
        ),
      ),
      registry.middleware.use(promptMiddleware(sources)),
    );

    const hub: McpHub = {
      add(source) {
        sources.set(source.serverName, source);
        return () => {
          if (sources.get(source.serverName) === source) sources.delete(source.serverName);
        };
      },
    };
    undos.push(registry.services.provide(MCP_HUB_SERVICE, hub));
    return hub;
  } catch (error) {
    for (const undo of undos.reverse()) undo();
    throw error;
  }
}

/** 每次模型呼叫前把 {@link hubPromptText} 接到 system message 後面；沒有東西可接就原樣穿過。 */
function promptMiddleware(sources: ReadonlyMap<string, McpSource>): AgentMiddleware {
  return createMiddleware({
    name: 'mcp-prompt',
    wrapModelCall: (request, handler) => {
      const text = hubPromptText(sources.values());
      if (text === '') return handler(request);
      // 兩個入口是同一件事：`systemMessage` 在就接在它後面，不在就由 `systemPrompt` 字串承接。
      const { systemMessage } = request;
      return handler(
        systemMessage === undefined
          ? { ...request, systemPrompt: text }
          : { ...request, systemMessage: systemMessage.concat(`\n\n${text}`) },
      );
    },
  }) as AgentMiddleware;
}
