/**
 * 樹上那一條路（#2533）：{@link mountServer} 在同一條 thread 上的撞名與 hub 的共用，和 {@link apply} 要宿主的 `threadSource`。
 * 用一條假的 {@link ToolThread}，不經宿主；宿主那一側的語意在 `apps/harness/src/thread-source.test.ts`。
 */
import { Context } from '@nexus/cordis';
import { checkConformance } from '@nexus/sdk';
import { toolsToken } from '@nexus/tools';
import { createToolsProvider } from '@nexus/tools/provider';
import type { ToolThread } from '@nexus/tools';
import { describe, expect, it } from 'vitest';

import { RESOURCE_TOOL_NAMES } from './hub.js';
import * as mcp from './index.js';
import { apply, mcpConfigSchema, mountServer } from './index.js';

interface FakeThread {
  readonly thread: ToolThread;
  readonly tools: string[];
  readonly sections: string[];
  readonly warnings: string[];
  dispose(): Promise<void>;
}

function fakeThread(): FakeThread {
  const tools: string[] = [];
  const sections: string[] = [];
  const warnings: string[] = [];
  const disposers: (() => unknown)[] = [];
  const thread: ToolThread = {
    services: { get: () => undefined },
    register(tool) {
      tools.push(tool.name);
      return () => {};
    },
    gate: () => () => {},
    admit: () => () => {},
    section(section) {
      sections.push(section.name);
      return () => {};
    },
    onDispose(dispose) {
      disposers.push(dispose);
    },
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
    shared: {},
  };
  return {
    thread,
    tools,
    sections,
    warnings,
    async dispose() {
      for (const dispose of disposers.splice(0).reverse()) await dispose();
    },
  };
}

/** 一台連不上的 server：spawn 當場失敗，走「收成警告、這一次沒有工具」那條路，不起子行程。 */
function unreachableConfig(serverName: string) {
  return mcpConfigSchema.parse({
    serverName,
    connection: { transport: 'stdio', command: '/nonexistent/nexus-mcp-on-tree' },
  });
}

describe('mountServer（樹上）', () => {
  it('同一條 thread 上同一個 serverName 掛兩次：後來那一次在連線之前就拋，收掉之後名字釋放', async () => {
    const t = fakeThread();
    await mountServer(t.thread, unreachableConfig('srv'));
    expect(t.warnings).toHaveLength(1);

    await expect(mountServer(t.thread, unreachableConfig('srv'))).rejects.toThrow(
      'MCP 伺服器 "srv" 在這條 thread 上已經有一列掛了，同一個 serverName 不能掛兩次',
    );
    // 拋在連線之前：沒有第二則連不上的警告。
    expect(t.warnings).toHaveLength(1);

    await t.dispose();
    await mountServer(t.thread, unreachableConfig('srv'));
    expect(t.warnings).toHaveLength(2);
  });

  it('不同的 thread 各自預留：同一個 serverName 在兩條 thread 上都掛得上', async () => {
    const a = fakeThread();
    const b = fakeThread();
    await mountServer(a.thread, unreachableConfig('srv'));
    await mountServer(b.thread, unreachableConfig('srv'));
    expect([a.warnings.length, b.warnings.length]).toEqual([1, 1]);
  });

  it('同一條 thread 上兩台共用一個 hub：資源工具與提示詞段只登記一次；建它的那一列收掉之後，hub 不再留在 shared', async () => {
    const t = fakeThread();
    await mountServer(t.thread, unreachableConfig('srv'));
    await mountServer(t.thread, unreachableConfig('srv2'));
    expect([...t.tools].sort()).toEqual([...RESOURCE_TOOL_NAMES].sort());
    expect(t.sections).toHaveLength(1);

    // 工具與段由宿主跟著 thread 撤，假 thread 不撤；這裡只看 hub 有沒有從 shared 拿掉：再掛會另建一個、再登記一段。
    await t.dispose();
    await mountServer(t.thread, unreachableConfig('srv'));
    expect(t.sections).toHaveLength(2);
  });
});

describe('apply（行程級）', () => {
  it('宿主的工具接縫沒有 threadSource：拋', () => {
    const ctx = new Context();
    ctx.provide(toolsToken.name, { register: () => () => {} } as never);
    expect(() => {
      apply(ctx, unreachableConfig('srv'));
    }).toThrow('mcp 要宿主的 tools.threadSource()');
  });
});

describe('一致性', () => {
  it('一致性套件全格通過：manifest、匯出形式、卸載後登記處回到掛載前、缺提供者停在 PENDING、schema 是 JSON', async () => {
    // 宿主的授權表給 mcp 那五格；這裡全授權，量的是插件本身。
    const provider = () => createToolsProvider({ authorizeThreadServices: () => [] });
    let latest = provider();
    const failures = await checkConformance({
      row: 'mcp',
      module: mcp,
      config: {
        serverName: 'srv',
        connection: { transport: 'stdio', command: '/nonexistent/nexus-mcp-on-tree' },
      },
      providers: {
        tools: () => {
          latest = provider();
          return latest.Provider;
        },
      },
      residue: () => latest.entries().length + latest.threadSources().length,
    });
    expect(failures).toEqual([]);
  });
});
