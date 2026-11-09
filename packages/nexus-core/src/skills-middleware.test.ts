/**
 * skills 那一段由這一層記下的清單渲染：state 裡已經有清單時（同一條 thread 換了一個組裝），基座沿用它、不重掃，這一層也跟著沿用。
 * 掃描、空清單、只給人叫的技能這幾條走真的檔案系統，在 `apps/harness/src/skills.test.ts`。
 */

import { SystemMessage } from '@langchain/core/messages';
import { StateBackend } from 'deepagents';
import { describe, expect, it } from 'vitest';

import { createSkillsMiddlewareQuietWhenEmpty } from './skills-middleware.js';

type Hook = (state: unknown, runtime: unknown) => Promise<unknown>;
type Wrap = (request: unknown, handler: (request: unknown) => unknown) => unknown;

describe('state 裡已經有的技能清單', () => {
  it('沿用它渲染，不讀模型請求上的 state', async () => {
    const middleware = createSkillsMiddlewareQuietWhenEmpty({
      backend: () => new StateBackend(),
      sources: ['/skills/'],
    }) as unknown as { beforeAgent: Hook; wrapModelCall: Wrap };
    const inState = [{ name: 'deploy', description: '部署。', path: '/skills/deploy/SKILL.md' }];

    expect(await middleware.beforeAgent({ skillsMetadata: inState }, {})).toBeUndefined();

    let sent: SystemMessage | undefined;
    middleware.wrapModelCall({ systemMessage: new SystemMessage(''), state: {} }, (request) => {
      sent = (request as { systemMessage: SystemMessage }).systemMessage;
    });
    expect(sent?.text).toContain('- **deploy**: 部署。');
  });
});
