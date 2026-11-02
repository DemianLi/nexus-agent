import { readFileSync } from 'node:fs';

import type { Context } from '@nexus/cordis';
import { checkConformance, defineManifest, injectOf, need, service } from '@nexus/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AGENT_LOOP_CONTRACT_VERSION, agentLoopToken } from './index.js';
import { createAgentLoopProvider } from './provider.js';

const config = z.strictObject({});

/** 只相依 `@nexus/agent-loop` 與 `@nexus/sdk` 的消費者（三角色紀律的消費者那一角）。 */
const consumer = {
  name: 'agent-loop-consumer',
  inject: injectOf(need(agentLoopToken, '^1.0.0')),
  Config: config,
  manifest: defineManifest({
    id: 'agent-loop-consumer',
    version: '1.0.0',
    owner: '平台團隊',
    provides: [],
    consumes: [{ token: agentLoopToken.name, range: '^1.0.0' }],
    config,
    reload: { code: 'restart', config: 'next-thread' },
    capabilities: [],
  }),
  apply(ctx: Context) {
    service(ctx, agentLoopToken).preStep('ConsumerPreStep', () => undefined);
  },
};

describe('@nexus/agent-loop 的定義', () => {
  it('token 名是 agentLoop，契約版本是 semver 常數', () => {
    expect(agentLoopToken).toEqual({ name: 'agentLoop', version: AGENT_LOOP_CONTRACT_VERSION });
    expect(AGENT_LOOP_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('一致性套件跑在 agentLoop 接縫上：載入→卸載後登記處回到空的、缺件指名', async () => {
    let latest = createAgentLoopProvider();
    const failures = await checkConformance({
      row: 'agent-loop-consumer',
      module: consumer,
      config: {},
      providers: {
        agentLoop: () => {
          latest = createAgentLoopProvider();
          return latest.Provider;
        },
      },
      residue: () => latest.registrations(),
    });
    expect(failures).toEqual([]);
  });
});

describe('相依關係', () => {
  it('兩個入口都不 import @nexus/core（定義與提供者都不依賴核心）；建 middleware 的程式在宿主', () => {
    const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(read('./index.ts')).not.toMatch(/from '@nexus\/core'/u);
    expect(read('./provider.ts')).not.toMatch(/from '@nexus\/core'/u);
    // 建 middleware 要 langchain 的 `createMiddleware`：不在這個套件裡。
    expect(read('./index.ts')).not.toMatch(/from 'langchain'/u);
    expect(read('./provider.ts')).not.toMatch(/from 'langchain'/u);
    const pkg = JSON.parse(read('../package.json')) as {
      dependencies?: Record<string, string>;
      peerDependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['@langchain/core']);
    expect(Object.keys(pkg.peerDependencies)).toEqual(['@nexus/sdk']);
  });
});
