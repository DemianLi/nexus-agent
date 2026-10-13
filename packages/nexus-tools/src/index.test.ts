import { readFileSync } from 'node:fs';

import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { Context } from '@nexus/cordis';
import {
  ContractService,
  checkConformance,
  defineManifest,
  injectOf,
  need,
  service,
} from '@nexus/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { TOOLS_CONTRACT_VERSION, toolsToken } from './index.js';
import type { ToolRegistry } from './index.js';

const echoTool = (name: string): StructuredToolInterface =>
  tool(({ message }) => message, {
    name,
    description: '測試用',
    schema: z.object({ message: z.string() }),
  });

/** 測試專用的提供者：真正的提供者在 #1416 PR 2。這裡只驗定義套件的接縫形狀。 */
function createProvider() {
  const items: StructuredToolInterface[] = [];
  class TestRegistry extends ContractService<ToolRegistry> implements ToolRegistry {
    constructor(ctx: Context) {
      super(ctx, toolsToken);
    }
    register(registered: StructuredToolInterface): () => void {
      return this.ctx.effect(() => {
        if (items.some((item) => item.name === registered.name)) {
          throw new Error(`重名：${registered.name}`);
        }
        items.push(registered);
        return () => {
          const index = items.indexOf(registered);
          if (index >= 0) items.splice(index, 1);
        };
      }, 'tools.register()');
    }
    list(): readonly StructuredToolInterface[] {
      return [...items];
    }
  }
  return { TestRegistry, items };
}

const config = z.strictObject({ name: z.string().default('probe_tool') });

/** 只相依 `@nexus/tools` 與 `@nexus/sdk` 的消費者（三角色紀律的消費者那一角）。 */
const consumer = {
  name: 'tools-consumer',
  inject: injectOf(need(toolsToken, '^1.0.0')),
  Config: config,
  manifest: defineManifest({
    id: 'tools-consumer',
    version: '1.0.0',
    owner: '平台團隊',
    provides: [],
    consumes: [{ token: toolsToken.name, range: '^1.0.0' }],
    config,
    reload: { code: 'restart', config: 'next-thread' },
    capabilities: [],
  }),
  apply(ctx: Context, cfg: z.infer<typeof config>) {
    service(ctx, toolsToken).register(echoTool(cfg.name));
  },
};

describe('@nexus/tools 的定義', () => {
  it('token 名是 tools，契約版本是 semver 常數', () => {
    expect(toolsToken).toEqual({ name: 'tools', version: TOOLS_CONTRACT_VERSION });
    expect(TOOLS_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('一致性套件跑在 tools 接縫上：載入→卸載後登記處回到空的、缺件指名', async () => {
    let latest = createProvider();
    const failures = await checkConformance({
      row: 'row-tools-consumer',
      module: consumer,
      providers: {
        tools: () => {
          latest = createProvider();
          return latest.TestRegistry;
        },
      },
      residue: () => latest.items.length,
    });
    expect(failures).toEqual([]);
  });

  it('三角色：定義套件只相依 SDK 與工具的型別，不相依 @nexus/core', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(manifest.dependencies).sort()).toEqual(['@langchain/core', '@nexus/sdk']);
  });
});
