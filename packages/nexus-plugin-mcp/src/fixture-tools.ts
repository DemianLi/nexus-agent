/**
 * 測試用 MCP server 的工具，**舊協議**（單包 `@modelcontextprotocol/sdk` 1.x）那一代的定義。
 *
 * 抽出來是因為同一組工具要掛在兩個載具上：stdio 子行程（[`fixture-server.ts`](./fixture-server.ts)）與 loopback 的
 * HTTP server（[`http-fixtures.ts`](./http-fixtures.ts)）。兩邊跑同一組斷言才算「工具名與結果與 stdio 路徑一致」，
 * 各寫一份的話兩份各自綠也證明不了一致。新協議那一代見 [`modern-tools.ts`](./modern-tools.ts)，名字與行為對齊。
 *
 * 不進 `index.ts` 的匯出——它是測試素材，不是這個套件對外的東西。
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/** 一台假 server 回的「外部資料」。測試斷言這個字串一路到得了工具結果。 */
export const RELEASE_NOTE = 'nexus-agent 0.1.0：plugin 契約與 MCP 接入。';

/** `fail` 回的錯誤原文。 */
export const FAILURE_TEXT = 'upstream exploded: 503';

/** 一張 1×1 的 PNG，base64。`snapshot` 回它。 */
export const SNAPSHOT_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * `cite_sources` 回的兩條 resource link（[#1319](https://github.com/DemianLi/nexus-agent/issues/1319)）：一條帶 `title`、一條不帶，
 * URI 是 http 網址。模型能拿來標出處的，就是這兩個名字加網址。
 */
export const CITE_LINKS = [
  {
    name: '請假辦法（第 42 號公告）',
    title: '員工請假辦法',
    uri: 'https://wiki.example.test/policy/42',
  },
  { name: 'Q3 營收報表', uri: 'https://bi.example.test/reports/q3' },
] as const;

/** `cite_sources` 回的那一句正文。 */
export const CITE_TEXT = '查到兩筆相關資料。';

/** 把這一組工具掛到一台舊協議的 server 上。 */
export function registerFixtureTools(server: McpServer): void {
  server.registerTool(
    'fetch_release_note',
    {
      description: '回一則發行說明，模擬 MCP server 從外部拿到的資料。',
      inputSchema: { topic: z.string().describe('要查的主題') },
    },
    ({ topic }) => ({ content: [{ type: 'text', text: `${topic}｜${RELEASE_NOTE}` }] }),
  );

  // 名字裡有句點，而供應商的 function name 契約不收它。這一支存在的唯一理由是讓
  // `publicToolName` 的正規化在真的走過一趟 `tools/list` 之後仍然成立——純函式單測
  // 證明不了 server 真的可以公告這種名字。
  server.registerTool(
    'legacy.ping',
    { description: '回一聲，名字刻意帶了句點。', inputSchema: {} },
    () => ({ content: [{ type: 'text', text: 'pong' }] }),
  );

  // server 自己說「失敗了」（`isError`），不是協定層的錯。adapter 2.0.0 對這種結果回 `status: 'error'` 的訊息、不拋，
  // 文字是原文沒有前綴（#1074）；這一支讓外掛層的測試釘住「我們把它變回拋錯」。
  server.registerTool('fail', { description: '一定失敗，回 isError。', inputSchema: {} }, () => ({
    isError: true,
    content: [{ type: 'text', text: FAILURE_TEXT }],
  }));

  // 欄位可為 null、又有可省略的聯集：2.0.0 起 adapter 不再簡化 schema，`anyOf` 與 `$schema` 原樣送給模型供應商。
  server.registerTool(
    'nullable_args',
    {
      description: '收一個可為 null 的字串與一個字串或數字的聯集。',
      inputSchema: {
        label: z.string().nullable().describe('標籤，可為 null'),
        value: z.union([z.string(), z.number()]).optional().describe('字串或數字'),
      },
    },
    ({ label, value }) => ({ content: [{ type: 'text', text: JSON.stringify({ label, value }) }] }),
  );

  // 文字夾著一張圖。模型那一側收不下圖（#642），這一支驗圖被換成說明、兩段文字與順序原樣。
  server.registerTool(
    'snapshot',
    { description: '回一張截圖，前後各一句說明。', inputSchema: {} },
    () => ({
      content: [
        { type: 'text', text: '畫面之前' },
        { type: 'image', data: SNAPSHOT_PNG, mimeType: 'image/png' },
        { type: 'text', text: '畫面之後' },
      ],
    }),
  );

  // 子行程拿到了哪些環境變數（#726）。回一份 JSON：問到的每個名字對到它的值，沒有就是 `null`——「沒有」與「空字串」
  // 要分得開。
  server.registerTool(
    'read_env',
    {
      description: '回報這個行程看得到的環境變數。',
      inputSchema: { names: z.array(z.string()).describe('要看的變數名') },
    },
    ({ names }) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            Object.fromEntries(names.map((name) => [name, process.env[name] ?? null])),
          ),
        },
      ],
    }),
  );

  // 子行程自己往外連一次（#746）。回它收到的狀態碼或錯誤——連到哪裡由測試在假代理那側量。
  server.registerTool(
    'fetch_url',
    {
      description: '用這個行程自己的 fetch 連一個網址。',
      inputSchema: { url: z.string().describe('要連的網址') },
    },
    async ({ url }) => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
        return { content: [{ type: 'text', text: `status ${String(response.status)}` }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `error ${String(error)}` }] };
      }
    },
  );

  // 回 `resource_link`（#1319）：內部系統查到資料時，最自然的回法是一句正文加幾條連結。
  server.registerTool(
    'cite_sources',
    { description: '查內部知識庫，回一句說明與兩條資料連結。', inputSchema: {} },
    () => ({
      content: [
        { type: 'text', text: CITE_TEXT },
        ...CITE_LINKS.map((link) => ({ type: 'resource_link' as const, ...link })),
      ],
    }),
  );
}
