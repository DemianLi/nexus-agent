import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import {
  A_TEXT,
  B_TEXT,
  C_TEXT,
  GROUPS,
  LINKS,
  MODE_ENV,
  TOOL_DESCRIPTION,
  TOOL_NAME,
} from './fixture.js';
import type { Group } from './fixture.js';

const SERVER = fileURLToPath(new URL('./fixture-server.ts', import.meta.url));

function transportFor(mode: string): StdioClientTransport {
  return new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', SERVER],
    env: { ...process.env, [MODE_ENV]: mode } as Record<string, string>,
  });
}

async function withServer<T>(group: Group, body: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'citation-fixture-test', version: '0.0.0' });
  await client.connect(transportFor(group));
  try {
    return await body(client);
  } finally {
    await client.close();
  }
}

describe('出處量測的夾具 server', () => {
  it('三組的工具定義逐字相同：名稱、描述、參數', async () => {
    const definitions = await Promise.all(
      GROUPS.map((group) => withServer(group, async (client) => (await client.listTools()).tools)),
    );
    const [first, ...rest] = definitions.map((tools) => JSON.stringify(tools));
    for (const other of rest) expect(other).toBe(first);
    const tools = definitions[0] ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: TOOL_NAME, description: TOOL_DESCRIPTION });
  }, 30_000);

  it('描述與工具名不洩漏答案：沒有「知識庫」「連結」「文件」「資源」或 server 名', () => {
    for (const word of ['知識庫', '連結', '文件', '資源', 'kb']) {
      expect(TOOL_DESCRIPTION).not.toContain(word);
      expect(TOOL_NAME).not.toContain(word);
    }
  });

  it('A：正文加兩條 resource_link', async () => {
    const result = await withServer('A', (c) =>
      c.callTool({ name: TOOL_NAME, arguments: { query: '特休' } }),
    );
    const content = result.content as { type: string; text?: string; uri?: string }[];
    expect(content[0]).toMatchObject({ type: 'text', text: A_TEXT });
    expect(content.slice(1).map((block) => [block.type, block.uri])).toEqual(
      LINKS.map((link) => ['resource_link', link.uri]),
    );
  }, 30_000);

  it('B：一句話加同樣兩條連結，A 與 B 的連結逐字相同', async () => {
    const [a, b] = await Promise.all(
      (['A', 'B'] as const).map((group) =>
        withServer(group, (c) => c.callTool({ name: TOOL_NAME, arguments: { query: 'x' } })),
      ),
    );
    const links = (r: typeof a): string => JSON.stringify((r?.content as unknown[]).slice(1));
    expect(links(b)).toBe(links(a));
    expect((b?.content as { text?: string }[])[0]?.text).toBe(B_TEXT);
  }, 30_000);

  it('C：只有「查無相關資料」，沒有連結', async () => {
    const result = await withServer('C', (c) =>
      c.callTool({ name: TOOL_NAME, arguments: { query: 'x' } }),
    );
    expect(result.content).toEqual([{ type: 'text', text: C_TEXT }]);
  }, 30_000);

  it('模式不認得就起不來', async () => {
    const client = new Client({ name: 'citation-fixture-test', version: '0.0.0' });
    await expect(client.connect(transportFor('Z'))).rejects.toThrow();
    await client.close().catch(() => undefined);
  }, 30_000);
});
