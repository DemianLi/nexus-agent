/**
 * server 指引與資源工具的驗收（[#431](https://github.com/DemianLi/nexus-agent/issues/431)、
 * [#430](https://github.com/DemianLi/nexus-agent/issues/430)）。
 *
 * 跟 [`protocols.test.ts`](./protocols.test.ts) 一樣：**真的 stdio 子行程**，舊協議與新協議各一台，同一組斷言各跑一遍。
 * 指引是否宣告、資源能力是否宣告由環境變數決定（[`resource-fixtures.ts`](./resource-fixtures.ts)），所以「沒有資源能力」
 * 與「沒有指引」量的是真的 server 行為，不是 mock。
 */

import { fileURLToPath } from 'node:url';
import { SystemMessage } from '@langchain/core/messages';
import type { PluginRegistry } from '@nexus/core';
import { loadPlugins } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { RESOURCE_TOOL_NAMES } from './hub.js';
import { CITATION_PROMPT, ensureHub, hubPromptText, renderResourceResult } from './hub.js';
import type { McpResourceRequest, McpSource } from './hub.js';
import { createMcpPlugin } from './index.js';
import {
  LOGO_BASE64,
  LOGO_URI,
  MEMO_TEXT,
  MEMO_URI,
  NOTE_TEMPLATE,
  noteText,
} from './resource-fixtures.js';
import { modelToolNames } from './tool-names.js';

const LEGACY_SERVER = fileURLToPath(new URL('./fixture-server.ts', import.meta.url));
const MODERN_SERVER = fileURLToPath(new URL('./modern-stdio-server.ts', import.meta.url));

interface Target {
  readonly label: string;
  readonly script: string;
}
const TARGETS: readonly Target[] = [
  { label: '舊協議 stdio', script: LEGACY_SERVER },
  { label: '新協議 stdio', script: MODERN_SERVER },
];

/** 帶指引／資源環境變數的一列。 */
function row(
  target: Target,
  env: Record<string, string>,
  extra: { serverName?: string; maxInstructionBytes?: number; failOnStartupError?: boolean } = {},
) {
  return createMcpPlugin({
    serverName: extra.serverName ?? 'srv',
    connection: {
      transport: 'stdio',
      command: process.execPath,
      args: ['--import', 'tsx', target.script],
      env,
    },
    ...(extra.maxInstructionBytes !== undefined && {
      maxInstructionBytes: extra.maxInstructionBytes,
    }),
    ...(extra.failOnStartupError !== undefined && { failOnStartupError: extra.failOnStartupError }),
  });
}

/** 起不來的一列。 */
function brokenRow(serverName = 'srv', failOnStartupError = false) {
  return createMcpPlugin({
    serverName,
    connection: { transport: 'stdio', command: '/nonexistent/nexus-mcp-fixture' },
    failOnStartupError,
  });
}

function resourceTool(registry: PluginRegistry, name: (typeof RESOURCE_TOOL_NAMES)[number]) {
  const found = registry.tools.resolve(name)?.value;
  if (found === undefined) throw new Error(`沒有註冊 ${name}`);
  return found;
}

/** 模擬一次模型呼叫：回 middleware 交給下一層的 system 文字。 */
async function systemTextOf(registry: PluginRegistry, base = '基底提示詞'): Promise<string> {
  let text = base;
  for (const entry of registry.middleware.list()) {
    const registration = entry.value as { middleware?: { wrapModelCall?: unknown } };
    const wrap = registration.middleware?.wrapModelCall as
      | ((
          request: { systemMessage?: SystemMessage },
          handler: (request: { systemMessage?: SystemMessage; systemPrompt?: string }) => unknown,
        ) => unknown)
      | undefined;
    if (wrap === undefined) continue;
    await wrap({ systemMessage: new SystemMessage(text) }, (request) => {
      text = request.systemMessage?.text ?? request.systemPrompt ?? text;
      return undefined;
    });
  }
  return text;
}

const INSTRUCTIONS = '先讀 {model} 與 {cwd} 的說明。\n不要改檔。  \n';

describe.each(TARGETS)('$label：指引與資源', (target) => {
  const env = { FIXTURE_INSTRUCTIONS: INSTRUCTIONS, FIXTURE_RESOURCES: '1' };

  it('指引帶出處標頭接在 system message 後面，大括號原樣，每一輪逐位元組相同', async () => {
    const { registry, dispose } = await loadPlugins([row(target, env)]);
    try {
      const first = await systemTextOf(registry);
      expect(first).toBe(
        '基底提示詞\n\n' +
          '## MCP resource servers\n\n' +
          'Use list_mcp_resources, list_mcp_resource_templates, read_mcp_resource with one of these names as the server argument: ["srv"].' +
          `\n\n${CITATION_PROMPT}` +
          '\n\n### MCP server: srv\n\n先讀 {model} 與 {cwd} 的說明。\n不要改檔。',
      );
      expect(await systemTextOf(registry)).toBe(first);
    } finally {
      await dispose();
    }
  });

  // #1319：引用要求跟著「有 server 登記」走，不跟著「宣告了 resources 能力」走。這一台沒有設 FIXTURE_RESOURCES，
  // 也沒有指引，連 `resources/list` 都會被拒——提示詞裡仍然要有這一段。
  it('只掛 tools、沒有 resources 能力的 server 也有引用要求', async () => {
    const { registry, dispose } = await loadPlugins([row(target, {})]);
    try {
      const text = await systemTextOf(registry);
      expect(text).toContain(CITATION_PROMPT);
      expect(text).toContain('say which MCP server (the system) it came from');
      expect(text).toContain('cite the relevant resource links in that result as markdown links');
    } finally {
      await dispose();
    }
  });

  it('起不來的那一列也登記，引用要求照在（跟 hub 的其他文字一起）', async () => {
    const { registry, dispose } = await loadPlugins([brokenRow()]);
    try {
      expect(await systemTextOf(registry)).toContain(CITATION_PROMPT);
    } finally {
      await dispose();
    }
  });

  it('列資源、列模板、讀文字：照 server 的結果，頭一行標出處', async () => {
    const { registry, dispose } = await loadPlugins([row(target, env)]);
    try {
      const list = (await resourceTool(registry, 'list_mcp_resources').invoke({
        server: 'srv',
      })) as string;
      expect(list.startsWith('MCP server: srv\n')).toBe(true);
      const listed = JSON.parse(list.slice(list.indexOf('\n') + 1)) as {
        resources: { uri: string }[];
      };
      expect(listed.resources.map((r) => r.uri).sort()).toEqual([LOGO_URI, MEMO_URI].sort());

      const templates = (await resourceTool(registry, 'list_mcp_resource_templates').invoke({
        server: 'srv',
      })) as string;
      expect(JSON.parse(templates.slice(templates.indexOf('\n') + 1))).toMatchObject({
        resourceTemplates: [{ uriTemplate: NOTE_TEMPLATE }],
      });

      const read = (await resourceTool(registry, 'read_mcp_resource').invoke({
        server: 'srv',
        uri: MEMO_URI,
      })) as string;
      expect(JSON.parse(read.slice(read.indexOf('\n') + 1))).toMatchObject({
        contents: [{ uri: MEMO_URI, text: MEMO_TEXT }],
      });
      // 模板展開之後的 uri 讀得到。
      const note = (await resourceTool(registry, 'read_mcp_resource').invoke({
        server: 'srv',
        uri: 'memo://note/7',
      })) as string;
      expect(note).toContain(noteText('7'));
    } finally {
      await dispose();
    }
  });

  it('讀二進位：給模型的文字不含 base64，完整結果在 artifact', async () => {
    const { registry, dispose } = await loadPlugins([row(target, env)]);
    try {
      const message = (await resourceTool(registry, 'read_mcp_resource').invoke({
        type: 'tool_call',
        id: 'call_1',
        name: 'read_mcp_resource',
        args: { server: 'srv', uri: LOGO_URI },
      })) as { content: string; artifact: unknown };
      expect(message.content).not.toContain(LOGO_BASE64);
      expect(message.content).toContain(
        `[binary resource: ${String(LOGO_BASE64.length)} base64 characters; available to programmatic callers]`,
      );
      expect(JSON.stringify(message.artifact)).toContain(LOGO_BASE64);
    } finally {
      await dispose();
    }
  });

  it('沒宣告資源也沒指引：提示詞只有名字那一段；列回空清單，讀拋', async () => {
    const { registry, dispose } = await loadPlugins([row(target, {})]);
    try {
      const text = await systemTextOf(registry);
      expect(text).toContain('["srv"]');
      expect(text).not.toContain('### MCP server');
      const listed = (await resourceTool(registry, 'list_mcp_resources').invoke({
        server: 'srv',
      })) as string;
      expect(JSON.parse(listed.slice(listed.indexOf('\n') + 1))).toEqual({ resources: [] });
      await expect(
        resourceTool(registry, 'read_mcp_resource').invoke({ server: 'srv', uri: MEMO_URI }),
      ).rejects.toThrow();
    } finally {
      await dispose();
    }
  });

  it('指引超過上限（算位元組不是字數）：這一列沒有工具、子行程收掉、警告指名上限；寫 true 則整列拋', async () => {
    // 出處標頭 21 位元組 + 10 個中文字 30 位元組 = 51 位元組，字數只有 31。
    const instructions = '字'.repeat(10);
    const opts = { FIXTURE_INSTRUCTIONS: instructions };
    const { registry, dispose } = await loadPlugins([
      row(target, opts, { maxInstructionBytes: 40 }),
    ]);
    try {
      expect(modelToolNames(registry)).toEqual([]);
      expect(registry.logger.warnings()[0]?.message).toContain('maxInstructionBytes (40)');
      // 起不來的列：提示詞沒有它的指引，但名字照列、叫它得到固定的不可用。
      expect(await systemTextOf(registry)).not.toContain('字');
      await expect(
        resourceTool(registry, 'list_mcp_resources').invoke({ server: 'srv' }),
      ).rejects.toThrow('mcp-client(srv): server is disconnected');
    } finally {
      await dispose();
    }
    // 邊界：51 位元組剛好夠、50 差一個。上限算的是**含出處標頭**的整串（dsh `connection.ts:320`），不是 server 回的原文
    // （30 位元組）——只算原文的話 40 也過得去。
    const edge = await loadPlugins([row(target, opts, { maxInstructionBytes: 50 })]);
    try {
      expect(modelToolNames(edge.registry)).toEqual([]);
      expect(edge.registry.logger.warnings()[0]?.message).toContain('maxInstructionBytes (50)');
    } finally {
      await edge.dispose();
    }
    // 剛好夠的不拒。
    const ok = await loadPlugins([row(target, opts, { maxInstructionBytes: 51 })]);
    try {
      expect(modelToolNames(ok.registry).length).toBeGreaterThan(0);
      expect(await systemTextOf(ok.registry)).toContain(`### MCP server: srv\n\n${instructions}`);
    } finally {
      await ok.dispose();
    }
    await expect(
      loadPlugins([row(target, opts, { maxInstructionBytes: 40, failOnStartupError: true })]),
    ).rejects.toThrow('server instructions exceed maxInstructionBytes (40)');
  });

  it('關閉之後才叫：固定的不可用，而且提示詞不再提它', async () => {
    const { registry, dispose } = await loadPlugins([row(target, env)]);
    const list = resourceTool(registry, 'list_mcp_resources');
    await dispose();
    await expect(list.invoke({ server: 'srv' })).rejects.toThrow(
      'MCP resource server "srv" is unavailable in this agent\'s scope',
    );
    expect(await systemTextOf(registry)).toBe('基底提示詞');
  });

  it('兩台 server：共用一組工具，靠 server 參數分流，指引各一段', async () => {
    const { registry, dispose } = await loadPlugins([
      row(
        target,
        { FIXTURE_INSTRUCTIONS: '甲的指引', FIXTURE_RESOURCES: '1' },
        { serverName: 'alpha' },
      ),
      row(target, { FIXTURE_INSTRUCTIONS: '乙的指引' }, { serverName: 'beta' }),
    ]);
    try {
      // 三支只註冊一次，沒撞名。
      expect(
        [...registry.tools.effective().keys()].filter((name) =>
          (RESOURCE_TOOL_NAMES as readonly string[]).includes(name),
        ),
      ).toEqual([...RESOURCE_TOOL_NAMES]);
      const text = await systemTextOf(registry);
      expect(text).toContain('["alpha","beta"]');
      expect(text.indexOf('甲的指引')).toBeGreaterThan(-1);
      expect(text.indexOf('乙的指引')).toBeGreaterThan(text.indexOf('甲的指引'));
      expect(
        await resourceTool(registry, 'read_mcp_resource').invoke({
          server: 'alpha',
          uri: MEMO_URI,
        }),
      ).toContain(MEMO_TEXT);
      // beta 沒宣告資源：問它拋，不影響 alpha。
      await expect(
        resourceTool(registry, 'read_mcp_resource').invoke({ server: 'beta', uri: MEMO_URI }),
      ).rejects.toThrow();
      await expect(
        resourceTool(registry, 'read_mcp_resource').invoke({ server: 'nope', uri: MEMO_URI }),
      ).rejects.toThrow('MCP resource server "nope" is unavailable in this agent\'s scope');
    } finally {
      await dispose();
    }
  });
});

describe('連不上的那一列', () => {
  it('照樣登記：資源工具在、名字照列，叫它得到固定的不可用；另一台好的不受影響', async () => {
    const { registry, dispose } = await loadPlugins([
      brokenRow('down'),
      row(TARGETS[1] as Target, { FIXTURE_RESOURCES: '1' }, { serverName: 'up' }),
    ]);
    try {
      expect(await systemTextOf(registry)).toContain('["down","up"]');
      await expect(
        resourceTool(registry, 'list_mcp_resources').invoke({ server: 'down' }),
      ).rejects.toThrow('mcp-client(down): server is disconnected');
      expect(
        await resourceTool(registry, 'read_mcp_resource').invoke({ server: 'up', uri: MEMO_URI }),
      ).toContain(MEMO_TEXT);
    } finally {
      await dispose();
    }
  });

  it('寫了 failOnStartupError: true 的那一列拋出去，不在 hub 留下任何東西', async () => {
    await expect(loadPlugins([brokenRow('down', true)])).rejects.toThrow();
  });
});

describe('hub：翻頁與中止訊號原樣交給 server', () => {
  /** 一個只記錄收到什麼的假來源，掛在真的 loader 上。 */
  async function withStub() {
    const seen: { request: McpResourceRequest; signal: AbortSignal | undefined }[] = [];
    const source: McpSource = {
      serverName: 'stub',
      instructions: '',
      request: (request, signal) => {
        seen.push({ request, signal });
        return Promise.resolve({ resources: [], nextCursor: 'c2' });
      },
    };
    const loaded = await loadPlugins([
      {
        plugin: {
          name: 'stub-host',
          apply(registry: PluginRegistry) {
            ensureHub(registry).add(source);
          },
        },
        config: {},
      },
    ]);
    return { ...loaded, seen };
  }

  it('有 cursor 就單頁透傳，沒有就不帶這個鍵；signal 是工具呼叫的那一個', async () => {
    const { registry, dispose, seen } = await withStub();
    try {
      const controller = new AbortController();
      await resourceTool(registry, 'list_mcp_resources').invoke(
        { server: 'stub', cursor: 'c1' },
        { signal: controller.signal },
      );
      await resourceTool(registry, 'list_mcp_resource_templates').invoke({ server: 'stub' });
      expect(seen[0]?.request).toEqual({ method: 'resources/list', cursor: 'c1' });
      expect(seen[0]?.signal).toBeDefined();
      expect(seen[1]?.request).toEqual({ method: 'resources/templates/list' });
      expect(seen[1]?.request).not.toHaveProperty('cursor');
    } finally {
      await dispose();
    }
  });
});

describe('分頁：沒帶 cursor 收齊所有頁，帶了只回那一頁', () => {
  it('真的 server 分兩頁', async () => {
    const { registry, dispose } = await loadPlugins([
      row(TARGETS[0] as Target, { FIXTURE_PAGED: '1' }),
    ]);
    try {
      const list = resourceTool(registry, 'list_mcp_resources');
      const parse = (text: unknown) => {
        const body = String(text);
        return JSON.parse(body.slice(body.indexOf('\n') + 1)) as {
          resources: { uri: string }[];
          nextCursor?: string;
        };
      };
      const all = parse(await list.invoke({ server: 'srv' }));
      expect(all.resources.map((r) => r.uri)).toEqual(['page://one', 'page://two']);
      expect(all).not.toHaveProperty('nextCursor');
      const second = parse(await list.invoke({ server: 'srv', cursor: 'p2' }));
      expect(second.resources.map((r) => r.uri)).toEqual(['page://two']);
    } finally {
      await dispose();
    }
  });
});

describe('純函式', () => {
  it('renderResourceResult 只在頂層拿掉協議信封欄位，巢狀同名的不動', () => {
    const text = renderResourceResult('s', {
      _meta: { a: 1 },
      ttlMs: 5,
      cacheScope: 'x',
      contents: [{ _meta: { keep: true }, blob: 'QUJD' }],
    });
    expect(text).toBe(
      'MCP server: s\n{"contents":[{"_meta":{"keep":true},"blob":"[binary resource: 4 base64 characters; available to programmatic callers]"}]}',
    );
  });

  it('hubPromptText：沒有任何來源是空字串；名字排序，指引依登記順序', () => {
    expect(hubPromptText([])).toBe('');
    const mk = (serverName: string, instructions: string): McpSource => ({
      serverName,
      instructions,
      request: () => Promise.resolve(undefined),
    });
    const text = hubPromptText([mk('b', '### MCP server: b\n\nB'), mk('a', '')]);
    expect(text).toContain('["a","b"]');
    expect(text.endsWith('### MCP server: b\n\nB')).toBe(true);
    // 引用要求在名單之後、指引之前，只出現一次，不管登記幾台。
    expect(text.split(CITATION_PROMPT)).toHaveLength(2);
    expect(text.indexOf(CITATION_PROMPT)).toBeGreaterThan(text.indexOf('["a","b"]'));
    expect(text.indexOf(CITATION_PROMPT)).toBeLessThan(text.indexOf('### MCP server: b'));
  });
});
