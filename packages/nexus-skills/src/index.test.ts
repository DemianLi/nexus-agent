import { readFileSync } from 'node:fs';

import type { Context } from '@nexus/cordis';
import { checkConformance, defineManifest, injectOf, need, service } from '@nexus/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { SKILL_SOURCES_CONTRACT_VERSION, skillSourcesToken } from './index.js';
import { createSkillSourcesProvider } from './provider.js';

const config = z.strictObject({});

/** 只相依 `@nexus/skills` 與 `@nexus/sdk` 的消費者（三角色紀律的消費者那一角）。 */
const consumer = {
  name: 'skill-sources-consumer',
  inject: injectOf(need(skillSourcesToken, '^1.0.0')),
  Config: config,
  manifest: defineManifest({
    id: 'skill-sources-consumer',
    version: '1.0.0',
    owner: '平台團隊',
    provides: [],
    consumes: [{ token: skillSourcesToken.name, range: '^1.0.0' }],
    config,
    reload: { code: 'restart', config: 'next-thread' },
    capabilities: [],
  }),
  apply(ctx: Context) {
    service(ctx, skillSourcesToken).addSource('/skills/');
  },
};

describe('@nexus/skills 的定義', () => {
  it('token 名是 skillSources，契約版本是 semver 常數', () => {
    expect(skillSourcesToken).toEqual({
      name: 'skillSources',
      version: SKILL_SOURCES_CONTRACT_VERSION,
    });
    expect(SKILL_SOURCES_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('一致性套件跑在 skillSources 接縫上：載入→卸載後登記處回到空的、缺件指名', async () => {
    let latest = createSkillSourcesProvider();
    const failures = await checkConformance({
      row: 'skill-sources-consumer',
      module: consumer,
      config: {},
      providers: {
        skillSources: () => {
          latest = createSkillSourcesProvider();
          return latest.Provider;
        },
      },
      residue: () => latest.registrations(),
    });
    expect(failures).toEqual([]);
  });
});

describe('相依關係', () => {
  it('主入口不 import @nexus/core（定義不依賴核心）；core 只在提供者入口，放 peer、devDependencies 留 workspace 版本', () => {
    const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(read('./index.ts')).not.toMatch(/from '@nexus\/core'/u);
    expect(read('./provider.ts')).toMatch(/from '@nexus\/core'/u);
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
