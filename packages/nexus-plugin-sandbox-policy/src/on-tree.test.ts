/**
 * sandbox-policy 在樹上的那一半：一致性套件、行程級的 `apply`、宿主缺接縫時當場拋。登記落在相容層 registry 的哪裡（四樣順序、
 * 日誌位元組）在 `apps/harness/src/sandbox-policy-on-tree.test.ts`。
 *
 * @module
 */
import { Context } from '@nexus/cordis';
import { checkConformance } from '@nexus/sdk';
import { toolsToken } from '@nexus/tools';
import { createToolsProvider } from '@nexus/tools/provider';
import type { ToolThread } from '@nexus/tools';
import { describe, expect, it } from 'vitest';

import * as sandboxPolicy from './index.js';
import {
  apply,
  CONTAINED_FILESYSTEM,
  mountSandboxPolicy,
  SANDBOX_POLICY_SERVICE,
} from './index.js';
import { SandboxModeController } from './sandbox-mode.js';

/** 一條假的 thread：服務照 `services` 給，沒有 `on`／`join`／`provide`（契約 2.7.0 以前的宿主）。 */
function threadWithout(services: Record<string, unknown>): ToolThread {
  return {
    services: { get: (name) => services[name] },
    register: () => () => {},
    gate: () => () => {},
    admit: () => () => {},
    section: () => () => {},
    onDispose: () => {},
    logger: { warn: () => {} },
    shared: {},
  };
}

describe('apply（行程級）', () => {
  it('宿主的工具接縫沒有 threadSource：拋', () => {
    const ctx = new Context();
    ctx.provide(toolsToken.name, { register: () => () => {} } as never);
    expect(() => {
      apply(ctx);
    }).toThrow('sandbox-policy 要宿主的 tools.threadSource()');
  });
});

describe('mountSandboxPolicy：宿主的 ToolThread 沒有 on、join、provide', () => {
  it('有圍堵：當場拋，指名要 2.7.0', () => {
    const thread = threadWithout({
      fsContainment: CONTAINED_FILESYSTEM,
      [SANDBOX_POLICY_SERVICE]: {
        controller: new SandboxModeController('read-only'),
        rootDir: '/w',
      },
    });
    expect(() => {
      mountSandboxPolicy(thread);
    }).toThrow('@nexus/tools 2.7.0');
  });

  it('沒有圍堵：用不到那三個方法，照樣只登記那一段', () => {
    const sections: string[] = [];
    const thread = {
      ...threadWithout({}),
      section(section: { name: string }) {
        sections.push(section.name);
        return () => {};
      },
    };
    mountSandboxPolicy(thread);
    expect(sections).toEqual(['sandbox:policy']);
  });
});

describe('一致性', () => {
  it('一致性套件全格通過：manifest、匯出形式、卸載後登記處回到掛載前、缺提供者停在 PENDING', async () => {
    // 宿主的授權表給 sandbox-policy 那五格；這裡全授權，量的是插件本身。
    const provider = () => createToolsProvider({ authorizeThreadServices: () => [] });
    let latest = provider();
    const failures = await checkConformance({
      row: 'sandbox-policy',
      module: sandboxPolicy,
      config: {},
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
