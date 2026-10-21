/**
 * MCP 那一列的核准宣告（[#1622](https://github.com/DemianLi/nexus-agent/issues/1622)）在插件這一層的驗收：設定的形狀、閘門對哪些
 * 工具回 `ask`、閘門跟工具同進同退。
 *
 * 「核准前 server 收不到 `tools/call`」量在 harness 那一側（`apps/harness/src/mcp-approval-wire.test.ts`）：那裡才有核准中介層、
 * 政策與管道。這裡只量閘門自己的決定，走一台**真的 stdio 子行程**，名字對照才是 `tools/list` 真的公告出來的那一份。
 */

import { fileURLToPath } from 'node:url';
import { loadPlugins } from '@nexus/core';
import type { PreToolDecision, PreToolListener } from '@nexus/core';
import { describe, expect, it } from 'vitest';

import { mcpApprovalGate, mcpApprovalSchema, unknownExempt } from './approval.js';
import { createMcpPlugin, mcpConfigSchema, mcpPlugin } from './index.js';
import type { McpPluginOptions } from './index.js';
import { publicToolName } from './names.js';

const FIXTURE_SERVER = fileURLToPath(new URL('./fixture-server.ts', import.meta.url));
const MODERN_SERVER = fileURLToPath(new URL('./modern-stdio-server.ts', import.meta.url));

/** 鏈底：真的走到 waterfall 尾巴時的那一格。用一個認得出來的值，才分得出「委派了」與「自己回 allow」。 */
const BOTTOM: PreToolDecision = { kind: 'deny', reason: '鏈底' };

async function decide(gate: PreToolListener, name: string): Promise<PreToolDecision> {
  return gate({ name, args: {}, callId: 'c' }, () => Promise.resolve(BOTTOM));
}

function fixtureRow(approval?: McpPluginOptions['approval'], env?: Record<string, string>) {
  return createMcpPlugin({
    serverName: 'fixture',
    connection: {
      transport: 'stdio',
      command: process.execPath,
      args: ['--import', 'tsx', FIXTURE_SERVER],
      ...(env !== undefined && { env }),
    },
    ...(approval !== undefined && { approval }),
  });
}

function onlyGate(listeners: readonly { value: PreToolListener }[]): PreToolListener {
  expect(listeners).toHaveLength(1);
  return listeners[0]!.value;
}

describe('設定', () => {
  it('沒寫 approval 等同 default: ask（Q2 (a)）', () => {
    const parsed = mcpConfigSchema.parse({
      serverName: 'x',
      connection: { transport: 'stdio', command: 'x' },
    });
    expect(parsed.approval).toEqual({ default: 'ask' });
  });

  it('default: allow 又寫了 exempt：載入失敗，訊息指名那一列與 exempt（J）', async () => {
    const bad = [
      {
        plugin: mcpPlugin,
        config: {
          serverName: 'x',
          connection: { transport: 'stdio', command: 'x' },
          approval: { default: 'allow', exempt: ['get_order'] },
        },
      },
    ];
    await expect(loadPlugins(bad)).rejects.toThrow('mcp#0 (mcp)');
    await expect(loadPlugins(bad)).rejects.toThrow(/approval\.exempt/);
  });

  it('exempt 寫成空陣列也算寫了：default: allow 配 exempt: [] 一樣拒絕', () => {
    expect(mcpApprovalSchema.safeParse({ default: 'allow', exempt: [] }).success).toBe(false);
    expect(mcpApprovalSchema.safeParse({ default: 'ask', exempt: [] }).success).toBe(true);
  });

  it('不認得的欄位、不認得的 default 都拒絕', () => {
    expect(mcpApprovalSchema.safeParse({ default: 'ask', require: ['x'] }).success).toBe(false);
    expect(mcpApprovalSchema.safeParse({ default: 'never' }).success).toBe(false);
    expect(mcpApprovalSchema.safeParse({ exempt: [''] }).success).toBe(false);
  });
});

describe('閘門的決定', () => {
  const rawNameOf = new Map([
    [publicToolName('crm', 'update_order'), 'update_order'],
    [publicToolName('crm', 'get_order'), 'get_order'],
    [publicToolName('crm', 'orders.search'), 'orders.search'],
  ]);
  const gate = mcpApprovalGate(
    'crm',
    mcpApprovalSchema.parse({ exempt: ['get_order', 'orders.search'] }),
    rawNameOf,
  )!;

  it('要問的工具回 ask，理由帶 server 名與 raw name', async () => {
    expect(await decide(gate, 'mcp__crm__update_order')).toEqual({
      kind: 'ask',
      reason: 'MCP server crm 的工具 update_order 要先讓人看過（設定 approval）',
    });
  });

  it('exempt 用 raw name 比對：被補了指紋的那一支照樣免問，委派給下一位', async () => {
    const fingerprinted = publicToolName('crm', 'orders.search');
    expect(fingerprinted).not.toBe('mcp__crm__orders.search');
    expect(await decide(gate, fingerprinted)).toBe(BOTTOM);
    expect(await decide(gate, 'mcp__crm__get_order')).toBe(BOTTOM);
  });

  it('不是這一列的工具一律委派，不回 allow', async () => {
    expect(await decide(gate, 'submit_record')).toBe(BOTTOM);
    expect(await decide(gate, 'mcp__other__update_order')).toBe(BOTTOM);
  });

  it('default: allow 不建閘門；default: ask 沒有 exempt 時整台都問', async () => {
    expect(mcpApprovalGate('crm', mcpApprovalSchema.parse({ default: 'allow' }), rawNameOf)).toBe(
      undefined,
    );
    const all = mcpApprovalGate('crm', mcpApprovalSchema.parse({}), rawNameOf)!;
    for (const name of rawNameOf.keys()) expect((await decide(all, name)).kind).toBe('ask');
  });

  it('unknownExempt 只挑出沒列出的名字', () => {
    expect(
      unknownExempt(mcpApprovalSchema.parse({ exempt: ['get_order', 'get_ordr'] }), [
        'get_order',
        'update_order',
      ]),
    ).toEqual(['get_ordr']);
  });
});

describe('接上一台真的 MCP server', () => {
  it('沒寫 approval：登記一位閘門，每支工具都問，包括被補了指紋的 legacy.ping（L）', async () => {
    const { registry, dispose } = await loadPlugins([fixtureRow()]);
    try {
      const gate = onlyGate(registry.approvals.listeners());
      expect(await decide(gate, 'mcp__fixture__fetch_release_note')).toMatchObject({
        kind: 'ask',
      });
      expect(await decide(gate, publicToolName('fixture', 'legacy.ping'))).toEqual({
        kind: 'ask',
        reason: 'MCP server fixture 的工具 legacy.ping 要先讓人看過（設定 approval）',
      });
      expect(registry.logger.warnings()).toEqual([]);
    } finally {
      await dispose();
    }
  });

  it('exempt 寫 raw name：那幾支委派，其餘照問（E）', async () => {
    const { registry, dispose } = await loadPlugins([
      fixtureRow({ exempt: ['fetch_release_note', 'legacy.ping'] }),
    ]);
    try {
      const gate = onlyGate(registry.approvals.listeners());
      expect(await decide(gate, 'mcp__fixture__fetch_release_note')).toBe(BOTTOM);
      expect(await decide(gate, publicToolName('fixture', 'legacy.ping'))).toBe(BOTTOM);
      expect((await decide(gate, 'mcp__fixture__snapshot')).kind).toBe('ask');
    } finally {
      await dispose();
    }
  });

  it('default: allow：不登記閘門', async () => {
    const { registry, dispose } = await loadPlugins([fixtureRow({ default: 'allow' })]);
    try {
      expect(registry.approvals.listeners()).toEqual([]);
    } finally {
      await dispose();
    }
  });

  it('exempt 有不存在的名字：警告一則指名它，其餘照常（K）', async () => {
    const { registry, dispose } = await loadPlugins([
      fixtureRow({ exempt: ['fetch_release_note', 'no_such_tool'] }),
    ]);
    try {
      expect(registry.logger.warnings()).toHaveLength(1);
      expect(registry.logger.warnings()[0]).toMatchObject({
        origin: { name: 'mcp' },
        message: expect.stringContaining('no_such_tool'),
      });
      expect(registry.logger.warnings()[0]?.message).not.toContain('fetch_release_note');
      const gate = onlyGate(registry.approvals.listeners());
      expect(await decide(gate, 'mcp__fixture__fetch_release_note')).toBe(BOTTOM);
      expect((await decide(gate, 'mcp__fixture__snapshot')).kind).toBe('ask');
    } finally {
      await dispose();
    }
  });

  it('列出工具之後才失敗（指引超過上限）：閘門跟工具一起撤掉', async () => {
    const plugin = createMcpPlugin({
      serverName: 'fixture',
      connection: {
        transport: 'stdio',
        command: process.execPath,
        args: ['--import', 'tsx', FIXTURE_SERVER],
        env: { FIXTURE_INSTRUCTIONS: '字'.repeat(10) },
      },
      maxInstructionBytes: 40,
    });
    const { registry, dispose } = await loadPlugins([plugin]);
    try {
      expect(registry.logger.warnings()[0]?.message).toContain('maxInstructionBytes (40)');
      expect(registry.approvals.listeners()).toEqual([]);
    } finally {
      await dispose();
    }
  });

  it('tools/list 回零支：沒有工具可擋，不登記閘門', async () => {
    const { registry, dispose } = await loadPlugins([
      createMcpPlugin({
        serverName: 'empty',
        connection: {
          transport: 'stdio',
          command: process.execPath,
          args: ['--import', 'tsx', MODERN_SERVER],
          env: { FIXTURE_NO_TOOLS: '1' },
        },
      }),
    ]);
    try {
      expect(
        [...registry.tools.effective().keys()].filter((name) => name.startsWith('mcp__')),
      ).toEqual([]);
      // 連上了、沒有出錯：不是走「連不上」那條路才沒有閘門。
      expect(registry.logger.warnings()).toEqual([]);
      expect(registry.approvals.listeners()).toEqual([]);
    } finally {
      await dispose();
    }
  });

  it('連不上：沒有工具，也沒有閘門', async () => {
    const { registry, dispose } = await loadPlugins([
      createMcpPlugin({
        serverName: 'missing',
        connection: { transport: 'stdio', command: process.execPath, args: ['-e', ''] },
      }),
    ]);
    try {
      expect(registry.approvals.listeners()).toEqual([]);
    } finally {
      await dispose();
    }
  });
});
