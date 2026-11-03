import { readFileSync } from 'node:fs';

import { Context } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import { checkConformance } from '@nexus/sdk';
import { createToolsProvider } from '@nexus/tools/provider';
import { describe, expect, it } from 'vitest';

import { isNexusTool } from '@nexus/tools';
import type { ToolExec } from '@nexus/tools';

import * as echo from './index.js';
import { createEchoTool, DEFAULT_ECHO_PREFIX, ECHO_TOOL_NAME } from './index.js';

const exec: ToolExec = {
  callId: 'c1',
  threadId: undefined,
  agent: undefined,
  signal: undefined,
  concludeTurn: () => {},
  deferContext: () => {},
  interrupt: () => Promise.resolve(undefined),
};

/**
 * 這個套件的驗收分三塊：工具本身、一致性套件（G）、相依關係。
 *
 * 組裝點那一側（一份清單 fold 出的 agent 真的呼叫得到這個工具、設定一改下一條 thread 看到新值）在
 * `apps/harness` 的 `echo-on-tree.test.ts`；這裡不重跑。
 */
describe('echo 工具', () => {
  it('回聲帶上前綴', async () => {
    await expect(createEchoTool('聽到了').execute({ message: '嗨' }, exec)).resolves.toEqual({
      ok: true,
      content: '聽到了：嗨',
    });
  });

  it('不給前綴就用 schema 的預設值', async () => {
    await expect(createEchoTool().execute({ message: '嗨' }, exec)).resolves.toEqual({
      ok: true,
      content: `${DEFAULT_ECHO_PREFIX}：嗨`,
    });
    expect(createEchoTool().name).toBe(ECHO_TOOL_NAME);
  });

  it('參數 schema 是 JSON（模型可以送的形狀：多帶的鍵收下丟掉，所以不寫 additionalProperties）', () => {
    expect(createEchoTool().parameters).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { message: { type: 'string', description: '要回聲的訊息' } },
      required: ['message'],
    });
  });

  it('設定：預設值寫在 schema、未知欄位拒收（登記的偏離）', () => {
    expect(echo.Config.parse({})).toEqual({ prefix: DEFAULT_ECHO_PREFIX });
    expect(echo.Config.parse({ prefix: '甲' })).toEqual({ prefix: '甲' });
    expect(() => echo.Config.parse({ prefixx: '甲' })).toThrow(/prefixx/);
    expect(() => echo.Config.parse({ prefix: 7 })).toThrow(/prefix/);
  });
});

describe('一致性套件（驗收 G）：真的提供者、真的 Loader', () => {
  it('echo 全格通過：manifest、匯出形式、載入→卸載後登記處回到掛載前、缺提供者停在 PENDING、schema 是 JSON', async () => {
    let latest = createToolsProvider();
    const failures = await checkConformance({
      row: 'echo',
      module: echo,
      config: {},
      providers: {
        tools: () => {
          latest = createToolsProvider();
          return latest.Provider;
        },
      },
      residue: () => latest.entries().length,
      tools: () => latest.entries().map((entry) => entry.tool),
    });
    expect(failures).toEqual([]);
  });

  it('掛上之後登記處裡是 echo 這一個工具，登記者是那一列', async () => {
    // 不重複 `checkConformance` 內部的步驟，只量它不給的那一面：登記的東西對不對。
    const provider = createToolsProvider();
    const root = new Context();
    try {
      await root.plugin(Loader);
      Object.assign(root.loader.builtins, { tools: provider.Provider, echo });
      await root.loader.create({ id: 'tools', name: 'cordis:tools' } as never, null);
      await root.loader.create(
        { id: 'row-echo', name: 'cordis:echo', config: { prefix: '甲' } } as never,
        null,
      );
      await root.loader.await();
      const entries = provider.entries();
      expect(entries.map((entry) => [entry.tool.name, entry.source])).toEqual([
        [ECHO_TOOL_NAME, 'row-echo'],
      ]);
      const registered = entries[0]?.tool;
      if (registered === undefined || !isNexusTool(registered))
        throw new Error('登記的不是 NexusTool');
      await expect(registered.execute({ message: '嗨' }, exec)).resolves.toEqual({
        ok: true,
        content: '甲：嗨',
      });
    } finally {
      await root.fiber.dispose();
    }
  });
});

describe('相依關係（#30）', () => {
  it('不相依 @nexus/core 與 @nexus/harness：外部插件只看見 SDK 與服務定義；框架與規範套件走 peer', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const all = Object.keys({
      ...pkg.dependencies,
      ...pkg.peerDependencies,
      ...pkg.devDependencies,
    });
    expect(all).not.toContain('@nexus/core');
    expect(all).not.toContain('@nexus/harness');
    // 宿主給的套件放 peerDependencies（同一份 `@nexus/sdk` 才有 ContractError 的 instanceof、同一份 Cordis
    // 才有同一個 Context 類別），開發時由 devDependencies 補上 workspace 版本；自己才用的第三方留在 dependencies。
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['zod']);
    const peers = ['@nexus/cordis', '@nexus/sdk', '@nexus/tools'];
    expect(Object.keys(pkg.peerDependencies).sort()).toEqual(peers);
    for (const name of peers) expect(pkg.devDependencies[name]).toBe('workspace:*');
  });

  it('沒有 default 匯出（Loader 的 unwrapExports 有 default 就取 default）', () => {
    expect('default' in echo).toBe(false);
  });
});
