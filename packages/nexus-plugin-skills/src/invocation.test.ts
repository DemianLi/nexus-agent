/**
 * 薄測試：`/名字` 那一列的一致性、manifest 與手勢。listener 本身（真的訊息、真的 backend、樹上的落點、日誌的來源）在
 * `apps/harness/src/skill-invocation-on-tree.test.ts`：這個套件不相依 `@langchain/core`，造不出真的訊息。
 */

import { createAgentLoopProvider } from '@nexus/agent-loop/provider';
import { createFsLookupProvider } from '@nexus/fs/provider';
import { checkConformance } from '@nexus/sdk';
import { createSkillSourcesProvider } from '@nexus/skills/provider';
import { describe, expect, it } from 'vitest';

import * as invocation from './invocation.js';
import { SKILL_GESTURE, SKILL_INVOCATION_LISTENER_NAME } from './invocation.js';

describe('一致性套件：真的提供者、真的 Loader', () => {
  it('skill-invocation 全格通過：manifest、匯出形式、載入→卸載後 listener 撤掉、缺提供者停在 PENDING', async () => {
    let latest = createAgentLoopProvider();
    const failures = await checkConformance({
      row: 'skill-invocation',
      module: invocation,
      config: {},
      providers: {
        agentLoop: () => {
          latest = createAgentLoopProvider();
          return latest.Provider;
        },
        fs: () => createFsLookupProvider(() => ({ kind: 'not-attached' })).Provider,
        skillSources: () => createSkillSourcesProvider().Provider,
      },
      residue: () => latest.registrations(),
    });
    expect(failures).toEqual([]);
  });

  it('manifest 宣告三個必要依賴：agentLoop（^1.2.0，要帶 source）、fs（^2.0.0）、skillSources（^1.0.0）；沒有設定、沒有 default 匯出', () => {
    expect(invocation.manifest.consumes).toEqual([
      { token: 'agentLoop', range: '^1.2.0' },
      { token: 'fs', range: '^2.0.0' },
      { token: 'skillSources', range: '^1.0.0' },
    ]);
    expect(invocation.manifest.provides).toEqual([]);
    expect(() => invocation.Config.parse({ sources: ['/skills/'] })).toThrow(/sources/);
    expect('default' in invocation).toBe(false);
    expect(SKILL_INVOCATION_LISTENER_NAME).toBe('SkillInvocationMiddleware');
  });
});

describe('手勢：逐字照 dsh 的 SKILL_GESTURE', () => {
  const names = (text: string) => [...text.matchAll(SKILL_GESTURE)].map((match) => match[2]);

  it('行首、行尾、前後空白才算；名字是小寫英數以 - 連接', () => {
    expect(names('/deploy')).toEqual(['deploy']);
    expect(names('請 /deploy 一下\n/release-notes')).toEqual(['deploy', 'release-notes']);
  });

  it('路徑、分數、帶子路徑、大寫、結尾連字號都不算', () => {
    expect(names('跑 /usr/bin/env 看看')).toEqual([]);
    expect(names('5/8 開會')).toEqual([]);
    expect(names('/deploy/x')).toEqual([]);
    expect(names('/Deploy')).toEqual([]);
    expect(names('/deploy-')).toEqual([]);
    expect(names('a/deploy')).toEqual([]);
  });
});
