import { readFileSync } from 'node:fs';

import { ProjectionDetailError } from '@nexus/core';
import type { ProjectionUnit } from '@nexus/core';
import type { Context } from '@nexus/cordis';
import { checkConformance, defineManifest, injectOf, need, service } from '@nexus/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as definition from './index.js';
import { PROJECTIONS_CONTRACT_VERSION, projectionsToken } from './index.js';
import { createProjectionsProvider } from './provider.js';

const unit: ProjectionUnit<number, number> = {
  key: 'probe-view',
  stateVersion: 1,
  init: () => 0,
  apply: (state) => state,
  view: (state) => state,
};

const config = z.strictObject({});

/** 只相依 `@nexus/projections` 與 `@nexus/sdk` 的消費者（三角色紀律的消費者那一角）。 */
const consumer = {
  name: 'projections-consumer',
  inject: injectOf(need(projectionsToken, '^1.0.0')),
  Config: config,
  manifest: defineManifest({
    id: 'projections-consumer',
    version: '1.0.0',
    owner: '平台團隊',
    provides: [],
    consumes: [{ token: projectionsToken.name, range: '^1.0.0' }],
    config,
    reload: { code: 'restart', config: 'next-thread' },
    capabilities: [],
  }),
  apply(ctx: Context) {
    service(ctx, projectionsToken).register(unit);
  },
};

describe('@nexus/projections 的定義', () => {
  it('token 名是 projections，契約版本是 semver 常數', () => {
    expect(projectionsToken).toEqual({
      name: 'projections',
      version: PROJECTIONS_CONTRACT_VERSION,
    });
    expect(PROJECTIONS_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('轉出 isLogicalTurnStart 與 ProjectionDetailError（執行期的值），型別由 @nexus/core 單向轉出', () => {
    expect(typeof definition.isLogicalTurnStart).toBe('function');
    // 同一個類別（instanceof 才成立），不是複製。
    expect(definition.ProjectionDetailError).toBe(ProjectionDetailError);
  });

  it('一致性套件跑在 projections 接縫上：載入→卸載後登記處回到空的、缺件指名', async () => {
    let latest = createProjectionsProvider();
    const failures = await checkConformance({
      row: 'projections-consumer',
      module: consumer,
      config: {},
      providers: {
        projections: () => {
          latest = createProjectionsProvider();
          return latest.Provider;
        },
      },
      residue: () => latest.registrations(),
    });
    expect(failures).toEqual([]);
  });
});

describe('相依關係（#1421 Q2 (a)、PM 決策 3）', () => {
  it('相依只有 SDK、cordis 與 core；core 放 peer，devDependencies 留 workspace 版本', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
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
