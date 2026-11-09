import { readFileSync } from 'node:fs';

import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { Context } from '@nexus/cordis';
import { checkConformance, defineManifest, injectOf, need, service } from '@nexus/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isNexusTool, TOOLS_CONTRACT_VERSION, toolsToken } from './index.js';
import type { NexusTool } from './index.js';
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
  inject: injectOf(need(toolsToken, '^2.0.0')),
  Config: config,
  manifest: defineManifest({
    id: 'tools-consumer',
    version: '1.0.0',
    owner: '平台團隊',
    provides: [],
    consumes: [{ token: toolsToken.name, range: '^2.0.0' }],
    config,
    reload: { code: 'restart', config: 'next-thread' },
    capabilities: [],
  }),
  apply(ctx: Context, cfg: z.infer<typeof config>) {
    service(ctx, toolsToken).register(echoTool(cfg.name));
  },
};

describe('@nexus/tools 的定義', () => {
  it('isNexusTool 分得出 NexusTool 與 LangChain 的工具', () => {
    const nexus: NexusTool = {
      name: 'n',
      description: 'd',
      parameters: { type: 'object', properties: {} },
      execute: () => Promise.resolve({ ok: true, content: '' }),
    };
    expect(isNexusTool(nexus)).toBe(true);
    expect(isNexusTool(echoTool('lc'))).toBe(false);
  });

  it('token 名是 tools，契約版本是 semver 常數', () => {
    expect(toolsToken).toEqual({ name: 'tools', version: TOOLS_CONTRACT_VERSION });
    expect(TOOLS_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    // 1.1.0（#1458）：`register` 多選填的第二個參數。1.2.0（#1466）：`ToolRegistry` 多選填方法 `gate`。1.3.0（#1469）：多選填方法 `onResult`。1.4.0（#1607）：多選填方法 `concludeTurn`。
    // 2.0.0（#2351）：`register` 也收 `NexusTool`，主版號跳 major，`^1.x` 的消費者停在 PENDING（`provider.test.ts` 量）。
    // 2.1.0（#2352）：`ToolExec` 多 `deferContext` 與 `interrupt`。2.2.0（#2353）：`NexusTool` 多選填的 `concludesTurn`。
    // 2.3.0（#2353）：`rawParameters`、`timeoutMs`、成功結果的 `artifact`。2.4.0（#2416）：`onResult` 看得到 `signal`、`blocks`、`content`。2.5.0（#2533）：多選填方法 `threadSource`。2.6.0（#2533）：`ToolThread` 多 `section`。
    // 2.6.1（#2416）：`tools/execute` 交回沿用原 `blocks` 的結果時，內容形狀照本體那則。2.7.0（#2533）：`ToolThread` 多選填的 `on`、`join`、`provide`。
    // 2.8.0（#2551）：`ToolThreadSection.text` 的函式收這一次模型呼叫的 `call`。
    // 2.9.0（#2575）：工具事件的視圖帶 `shape`、`command` 視圖帶內容、execute 能只換 `Command` 裡那一則；三顆改成 core 監聽者。
    // 2.10.0（#2358）：`exec.interrupt` 多一種寫明的拒絕 `HumanInputUnavailable`。
    // 2.11.0（#2358）：`ToolThread.on` 多收 `'agent/pre-step'`。
    expect(TOOLS_CONTRACT_VERSION).toBe('2.11.0');
    expect(TOOLS_CONTRACT_VERSION.split('.')[0]).toBe('2');
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
