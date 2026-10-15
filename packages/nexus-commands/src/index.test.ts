import { readFileSync } from 'node:fs';

import type { Context } from '@nexus/cordis';
import { checkConformance, defineManifest, injectOf, need, service } from '@nexus/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { COMMANDS_CONTRACT_VERSION, commandsToken } from './index.js';
import { createCommandsProvider } from './provider.js';

const config = z.strictObject({});

/** 只相依 `@nexus/commands` 與 `@nexus/sdk` 的消費者（三角色紀律的消費者那一角）。 */
const consumer = {
  name: 'commands-consumer',
  inject: injectOf(need(commandsToken, '^1.0.0')),
  Config: config,
  manifest: defineManifest({
    id: 'commands-consumer',
    version: '1.0.0',
    owner: '平台團隊',
    provides: [],
    consumes: [{ token: commandsToken.name, range: '^1.0.0' }],
    config,
    reload: { code: 'restart', config: 'next-thread' },
    capabilities: [],
  }),
  apply(ctx: Context) {
    service(ctx, commandsToken).register({
      name: 'hello',
      description: '打招呼',
      handler: () => ({ kind: 'success', text: '嗨' }),
    });
  },
};

describe('@nexus/commands 的定義', () => {
  it('token 名是 commands，契約版本是 semver 常數', () => {
    expect(commandsToken).toEqual({ name: 'commands', version: COMMANDS_CONTRACT_VERSION });
    expect(COMMANDS_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('一致性套件跑在 commands 接縫上：載入→卸載後登記處回到空的、缺件指名', async () => {
    let latest = createCommandsProvider();
    const failures = await checkConformance({
      row: 'commands-consumer',
      module: consumer,
      config: {},
      providers: {
        commands: () => {
          latest = createCommandsProvider();
          return latest.Provider;
        },
      },
      residue: () => latest.registrations(),
    });
    expect(failures).toEqual([]);
  });
});

describe('相依關係', () => {
  it('core 放 peer、devDependencies 留 workspace 版本；主入口只轉出型別，不帶 core 的執行期值', () => {
    const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    // 主入口對 core 只有 `import type`／`export type`：消費者載入定義套件不會拖進整個 core 的執行期。
    expect(read('./index.ts')).not.toMatch(/^(import|export) \{[^}]*\} from '@nexus\/core'/mu);
    expect(read('./provider.ts')).toMatch(/normalizeCommandDefinition/u);
    const pkg = JSON.parse(read('../package.json')) as {
      dependencies?: Record<string, string>;
      peerDependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
    const peers = ['@nexus/cordis', '@nexus/core', '@nexus/sdk'].sort();
    expect(Object.keys(pkg.peerDependencies).sort()).toEqual(peers);
    for (const name of peers) expect(pkg.devDependencies[name]).toBe('workspace:*');
  });
});
