/**
 * 注入源延後評估的題目與執行器（[#2929](https://github.com/DemianLi/nexus-agent/issues/2929)），用照稿回話的替身模型跑產品的組裝。
 * 真模型那一輪不進 CI，由 `injection-deferral-cli.ts` 跑。
 */

import { describe, expect, it } from 'vitest';

import { withScriptedModel } from '../../fixtures.js';
import type { ScriptedChatModel, ScriptedTurn } from '../../scripted-model.js';
import {
  DEFERRAL_CASES,
  DEFERRAL_FILE_BYTES,
  DEFERRAL_INLINE_MAX_BYTES,
  DEFERRAL_MARKER,
  DEFERRAL_RULE,
  DEFERRAL_TASK,
  deferralAgentsMd,
} from './fixture.js';
import { DEFERRAL_MAX_REQUESTS, runDeferralCase } from './runner.js';

const scripted = (turns: readonly ScriptedTurn[]) => ({
  live: false,
  plugins: (shipped: Parameters<typeof withScriptedModel>[0]) => withScriptedModel(shipped, turns),
});

const readAgentsMd = (offset?: number): ScriptedTurn => ({
  content: '',
  toolCalls: [
    {
      name: 'read_file',
      args: { file_path: '/AGENTS.md', ...(offset !== undefined && { offset }) },
    },
  ],
});

describe('題目', () => {
  it('那份檔超過出貨的 65536、放得進不延後那一邊的上限，規則只出現一次', () => {
    for (const position of ['head', 'tail'] as const) {
      const text = deferralAgentsMd(position);
      const bytes = Buffer.byteLength(text, 'utf8');
      expect(bytes).toBeGreaterThan(DEFERRAL_FILE_BYTES);
      expect(bytes).toBeLessThan(DEFERRAL_INLINE_MAX_BYTES - 4096);
      expect(text.split(DEFERRAL_MARKER)).toHaveLength(2);
      expect(deferralAgentsMd(position)).toBe(text);
    }
  });

  it('規則在檔頭那一份的第四行、檔尾那一份的倒數第四行', () => {
    expect(deferralAgentsMd('head').split('\n')[3]).toBe(DEFERRAL_RULE);
    expect(deferralAgentsMd('tail').trimEnd().split('\n').at(-4)).toBe(DEFERRAL_RULE);
  });

  it('四格：延後與否 × 規則的位置', () => {
    expect(DEFERRAL_CASES.map((item) => `${item.arm}/${item.position}`)).toEqual([
      'inline/head',
      'inline/tail',
      'deferred/head',
      'deferred/tail',
    ]);
  });
});

describe('執行器（產品的組裝，替身模型）', () => {
  it('不延後：規則隨指示檔進了請求；模型直接答，照做與否看回覆', async () => {
    const run = await runDeferralCase(
      { arm: 'inline', position: 'tail' },
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

  it('延後：請求裡有題目與指標、沒有規則；模型沒去讀就答，算沒照做', async () => {
    let model: ScriptedChatModel | undefined;
    const run = await runDeferralCase(
      { arm: 'deferred', position: 'head' },
      {
        ...scripted([{ content: 'AGENTS.md、README.md、data.csv' }]),
        onModel: (used) => {
          model = used as ScriptedChatModel;
        },
      },
    );
    const sent = (model?.prompts[0] ?? []).map((message) => message.text);
    expect(sent.filter((text) => text === DEFERRAL_TASK)).toHaveLength(1);
    expect(sent.some((text) => text.includes('not loaded /AGENTS.md (70170 bytes)'))).toBe(true);
    expect(sent.some((text) => text.includes(DEFERRAL_MARKER))).toBe(false);
    expect(run).toMatchObject({
      deferred: true,
      ruleInjected: false,
      readCalls: 0,
      ruleRead: false,
      followed: false,
      requests: 1,
    });
  }, 60000);

  it('延後、規則在檔頭：讀一次就讀到規則', async () => {
    const run = await runDeferralCase(
      { arm: 'deferred', position: 'head' },
      scripted([readAgentsMd(), { content: `檔名如下。\n核可編號 ${DEFERRAL_MARKER}` }]),
    );
    expect(run).toMatchObject({
      deferred: true,
      ruleInjected: false,
      readCalls: 1,
      ruleRead: true,
      followed: true,
      requests: 2,
    });
  }, 60000);

  it('延後、規則在檔尾：只讀第一頁讀不到規則', async () => {
    const run = await runDeferralCase(
      { arm: 'deferred', position: 'tail' },
      scripted([readAgentsMd(), { content: '檔名如下。' }]),
    );
    expect(run).toMatchObject({ deferred: true, readCalls: 1, ruleRead: false, followed: false });
  }, 60000);

  it(`一直叫工具不收尾：到 ${DEFERRAL_MAX_REQUESTS} 個請求就中止這一次`, async () => {
    const run = await runDeferralCase(
      { arm: 'deferred', position: 'head' },
      scripted(Array.from({ length: DEFERRAL_MAX_REQUESTS + 4 }, () => readAgentsMd())),
    );
    expect(run.capped).toBe(true);
  }, 60000);
});
