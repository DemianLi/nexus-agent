/**
 * 注入源預算評估的題目與執行器（[#2929](https://github.com/DemianLi/nexus-agent/issues/2929)），用照稿回話的替身模型跑產品的組裝。
 * 真模型那一輪不進 CI，由 `injection-deferral-cli.ts` 跑。
 */

import { injectionLimitFor } from '@nexus/core';
import { describe, expect, it } from 'vitest';

import { withScriptedModel } from '../../fixtures.js';
import type { ScriptedChatModel, ScriptedTurn } from '../../scripted-model.js';
import {
  DEFERRAL_CASES,
  DEFERRAL_FILE_BYTES,
  DEFERRAL_INLINE_MAX_BYTES,
  DEFERRAL_MARKER,
  DEFERRAL_RULE,
  DEFERRAL_SMALL_MAX_BYTES,
  deferralCaseId,
  deferralMaxBytesOverride,
  DEFERRAL_TASK,
  deferralAgentsMd,
} from './fixture.js';
import { DEFERRAL_MAX_REQUESTS, runDeferralCase } from './runner.js';

const scripted = (turns: readonly ScriptedTurn[]) => ({
  live: false,
  plugins: (shipped: Parameters<typeof withScriptedModel>[0]) => withScriptedModel(shipped, turns),
});

const readAgentsMd = (): ScriptedTurn => ({
  content: '',
  toolCalls: [
    {
      name: 'read_file',
      args: { file_path: '/AGENTS.md' },
    },
  ],
});

describe('題目', () => {
  it('那份檔超過出貨的上限、放得進不延後那一邊的上限，規則只出現一次', () => {
    expect(DEFERRAL_FILE_BYTES).toBeGreaterThan(injectionLimitFor('agent-instructions'));
    for (const position of ['head', 'tail'] as const) {
      const text = deferralAgentsMd(position);
      const bytes = Buffer.byteLength(text, 'utf8');
      expect(bytes).toBeGreaterThan(DEFERRAL_FILE_BYTES);
      // 留給外框與引言的餘裕。
      expect(bytes).toBeLessThan(DEFERRAL_INLINE_MAX_BYTES - 4096);
      expect(text.split(DEFERRAL_MARKER)).toHaveLength(2);
      expect(deferralAgentsMd(position)).toBe(text);
    }
  });

  it('規則在檔頭那一份的第四行、檔尾那一份的倒數第四行', () => {
    expect(deferralAgentsMd('head').split('\n')[3]).toBe(DEFERRAL_RULE);
    expect(deferralAgentsMd('tail').trimEnd().split('\n').at(-4)).toBe(DEFERRAL_RULE);
  });

  it('七格：大檔四格、小檔三格；各自只有一邊蓋掉上限', () => {
    expect(
      DEFERRAL_CASES.map((item) => [deferralCaseId(item), deferralMaxBytesOverride(item)]),
    ).toEqual([
      ['large/inline/head', DEFERRAL_INLINE_MAX_BYTES],
      ['large/inline/tail', DEFERRAL_INLINE_MAX_BYTES],
      ['large/deferred/head', undefined],
      ['large/deferred/tail', undefined],
      ['small/inline/head', undefined],
      ['small/deferred/head', DEFERRAL_SMALL_MAX_BYTES],
      ['small/deferred/tail', DEFERRAL_SMALL_MAX_BYTES],
    ]);
  });

  it('小檔比蓋掉的上限大、比出貨的上限小得多，規則在第四行', () => {
    const text = deferralAgentsMd('head', 'small');
    const bytes = Buffer.byteLength(text, 'utf8');
    expect(bytes).toBeGreaterThan(DEFERRAL_SMALL_MAX_BYTES);
    expect(bytes).toBeLessThan(4096);
    expect(text.split('\n')[3]).toBe(DEFERRAL_RULE);
  });
});

describe('小檔放不下、規則在檔尾', () => {
  it('檔比蓋掉的上限大，規則在倒數第四行、不在前 1024 位元組', () => {
    const text = deferralAgentsMd('tail', 'small');
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(DEFERRAL_SMALL_MAX_BYTES);
    expect(text.trimEnd().split('\n').at(-4)).toBe(DEFERRAL_RULE);
    expect(
      Buffer.from(text, 'utf8').subarray(0, DEFERRAL_SMALL_MAX_BYTES).toString('utf8'),
    ).not.toContain(DEFERRAL_MARKER);
    expect(deferralMaxBytesOverride({ file: 'small', arm: 'deferred', position: 'tail' })).toBe(
      DEFERRAL_SMALL_MAX_BYTES,
    );
  });
});

describe('執行器（產品的組裝，替身模型）', () => {
  it('放得下：規則隨指示檔進了請求；模型直接答，照做與否看回覆', async () => {
    const run = await runDeferralCase(
      { file: 'large', arm: 'inline', position: 'tail' },
      scripted([{ content: `AGENTS.md、README.md、data.csv\n核可編號 ${DEFERRAL_MARKER}` }]),
    );
    expect(run).toMatchObject({
      deferred: false,
      ruleInjected: true,
      readCalls: 0,
      ruleRead: false,
      followed: true,
      requests: 1,
      capped: false,
    });
  }, 60000);

  it('大檔放不下、規則在檔頭：請求裡有題目與截斷通知、規則在截留的檔頭裡；模型沒去讀就答，算沒照做', async () => {
    let model: ScriptedChatModel | undefined;
    const run = await runDeferralCase(
      { file: 'large', arm: 'deferred', position: 'head' },
      {
        ...scripted([{ content: 'AGENTS.md、README.md、data.csv' }]),
        onModel: (used) => {
          model = used as ScriptedChatModel;
        },
      },
    );
    const sent = (model?.prompts[0] ?? []).map((message) => message.text);
    expect(sent.filter((text) => text === DEFERRAL_TASK)).toHaveLength(1);
    expect(sent.some((text) => /truncated \/AGENTS\.md from 70170 to \d+ bytes/.test(text))).toBe(
      true,
    );
    expect(sent.some((text) => text.includes(DEFERRAL_MARKER))).toBe(true);
    expect(run).toMatchObject({
      deferred: true,
      ruleInjected: true,
      readCalls: 0,
      ruleRead: false,
      followed: false,
      requests: 1,
    });
  }, 60000);

  it('大檔放不下、規則在檔頭：讀一次就讀到規則', async () => {
    const run = await runDeferralCase(
      { file: 'large', arm: 'deferred', position: 'head' },
      scripted([readAgentsMd(), { content: `檔名如下。\n核可編號 ${DEFERRAL_MARKER}` }]),
    );
    expect(run).toMatchObject({
      deferred: true,
      ruleInjected: true,
      readCalls: 1,
      ruleRead: true,
      followed: true,
      requests: 2,
    });
  }, 60000);

  it('大檔放不下、規則在檔尾：請求裡沒有規則，只讀第一頁也讀不到', async () => {
    const run = await runDeferralCase(
      { file: 'large', arm: 'deferred', position: 'tail' },
      scripted([readAgentsMd(), { content: '檔名如下。' }]),
    );
    expect(run).toMatchObject({
      deferred: true,
      ruleInjected: false,
      readCalls: 1,
      ruleRead: false,
      followed: false,
    });
  }, 60000);

  it('小檔放不下、規則在檔頭：規則在截留的檔頭裡；去讀整份也讀得到', async () => {
    const run = await runDeferralCase(
      { file: 'small', arm: 'deferred', position: 'head' },
      scripted([readAgentsMd(), { content: `檔名如下。\n核可編號 ${DEFERRAL_MARKER}` }]),
    );
    expect(run).toMatchObject({
      deferred: true,
      ruleInjected: true,
      readCalls: 1,
      ruleRead: true,
      followed: true,
    });
  }, 60000);

  it('小檔放不下、規則在檔尾：請求裡沒有規則；去讀才讀得到', async () => {
    const answered = await runDeferralCase(
      { file: 'small', arm: 'deferred', position: 'tail' },
      scripted([{ content: '檔名如下。' }]),
    );
    expect(answered).toMatchObject({
      deferred: true,
      ruleInjected: false,
      readCalls: 0,
      followed: false,
    });
    const read = await runDeferralCase(
      { file: 'small', arm: 'deferred', position: 'tail' },
      scripted([readAgentsMd(), { content: `檔名如下。\n核可編號 ${DEFERRAL_MARKER}` }]),
    );
    expect(read).toMatchObject({
      deferred: true,
      ruleInjected: false,
      readCalls: 1,
      ruleRead: true,
      followed: true,
    });
  }, 60000);

  it('小檔放得下：出貨的上限放得下，規則進了請求', async () => {
    const run = await runDeferralCase(
      { file: 'small', arm: 'inline', position: 'head' },
      scripted([{ content: '檔名如下。' }]),
    );
    expect(run).toMatchObject({ deferred: false, ruleInjected: true, followed: false });
  }, 60000);

  it(`一直叫工具不收尾：超過 ${DEFERRAL_MAX_REQUESTS} 個請求就中止這一次，請求數照數`, async () => {
    const run = await runDeferralCase(
      { file: 'large', arm: 'deferred', position: 'head' },
      scripted(Array.from({ length: DEFERRAL_MAX_REQUESTS + 4 }, () => readAgentsMd())),
    );
    expect(run.capped).toBe(true);
    expect(run.requests).toBeGreaterThanOrEqual(DEFERRAL_MAX_REQUESTS);
  }, 60000);
});
