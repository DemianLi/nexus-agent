import { readFileSync } from 'node:fs';

import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { Context } from '@nexus/cordis';
import { checkConformance, defineManifest, injectOf, need, service } from '@nexus/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { TOOLS_CONTRACT_VERSION, toolsToken } from './index.js';
import { createToolsProvider } from './provider.js';

const echoTool = (name: string): StructuredToolInterface =>
  tool(({ message }) => message, {
    name,
    description: '測試用',
    schema: z.object({ message: z.string() }),
  });

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
    let latest = createToolsProvider();
    const failures = await checkConformance({
      row: 'row-tools-consumer',
      module: consumer,
      providers: {
        tools: () => {
          latest = createToolsProvider();
          return latest.Provider;
        },
      },
      residue: () => latest.entries().length,
    });
    expect(failures).toEqual([]);
  });

  it('三角色：定義套件只相依 SDK 與工具的型別，不相依 @nexus/core；SDK 是 peer（同一份 ContractError 的 instanceof）', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      dependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    // dsh 的做法：插件與服務定義套件把框架／規範套件放 peerDependencies，開發時由 devDependencies 補上。
    // `ContractError` 的 `instanceof` 靠「宿主與這個套件看到同一份 `@nexus/sdk`」，放進 dependencies 就可能各裝一份。
    expect(Object.keys(manifest.dependencies)).toEqual(['@langchain/core']);
    expect(manifest.peerDependencies).toEqual({ '@nexus/sdk': 'workspace:*' });
    expect(manifest.devDependencies['@nexus/sdk']).toBe('workspace:*');
    const all = Object.keys({
      ...manifest.dependencies,
      ...manifest.peerDependencies,
      ...manifest.devDependencies,
    });
    expect(all).not.toContain('@nexus/core');
  });
});
