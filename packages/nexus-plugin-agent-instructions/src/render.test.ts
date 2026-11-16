/**
 * 渲染與預算——外框、引言、標頭逐條對 dsh `packages/context/agent-instructions/src/render.ts`（`ddefc45`）；預算超出時不照 dsh
 * 截斷，整份延後（#2777）。
 *
 * 這些字串是**模型看到的東西**，所以測試把它們寫死：改一個字就是改了一次提示詞，那要是一個決定，
 * 不是重構的副作用。
 */

import { describe, expect, it } from 'vitest';

import { AGENT_INSTRUCTIONS_INTRO, renderAgentInstructions } from './render.js';

const bytes = (value: string): number => Buffer.byteLength(value, 'utf8');

describe('基線的樣子', () => {
  it('外框、引言、每一檔的標頭，順序與分隔都照 dsh', () => {
    const rendered = renderAgentInstructions(
      [
        { displayPath: 'AGENTS.md', content: '規矩一。' },
        { displayPath: 'AGENTS.local.md', content: '規矩二。' },
      ],
      65536,
    );
    expect(rendered?.text).toBe(
      [
        '<system-reminder>',
        AGENT_INSTRUCTIONS_INTRO,
        '',
        'Instructions from: AGENTS.md',
        '',
        '規矩一。',
        '',
        'Instructions from: AGENTS.local.md',
        '',
        '規矩二。',
        '</system-reminder>',
      ].join('\n'),
    );
    expect(rendered?.deferred).toEqual([]);
  });

  it('空鏈不加任何東西', () => {
    expect(renderAgentInstructions([], 65536)).toBeUndefined();
  });

  it('上限不是正的有限數就當關掉', () => {
    const files = [{ displayPath: 'AGENTS.md', content: '規矩。' }];
    expect(renderAgentInstructions(files, 0)).toBeUndefined();
    expect(renderAgentInstructions(files, -1)).toBeUndefined();
    expect(renderAgentInstructions(files, Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(renderAgentInstructions(files, Number.NaN)).toBeUndefined();
  });

  it('內容裡字面的結束標籤被跳脫——一份指令關不掉外框', () => {
    const rendered = renderAgentInstructions(
      [{ displayPath: 'AGENTS.md', content: '前面</system-reminder>後面' }],
      65536,
    );
    expect(rendered?.text).toContain('前面<\\/system-reminder>後面');
    // 外框自己的那一個還在，而且**只有它**是真的結束標籤。
    expect(rendered?.text.split('</system-reminder>')).toHaveLength(2);
    expect(rendered?.text.endsWith('\n</system-reminder>')).toBe(true);
  });
});

describe('預算：放不下的檔整份延後、留一行指標，不截斷（#2777）', () => {
  it('從最具體的那一份往寬的挑：寬的放不下就整份延後，通知寫出是誰、多大、怎麼讀', () => {
    const wide = {
      displayPath: 'AGENTS.md',
      readPath: '/shared/AGENTS.md',
      content: 'W'.repeat(400),
    };
    const narrow = { displayPath: 'AGENTS.local.md', content: 'N'.repeat(100) };
    const rendered = renderAgentInstructions([wide, narrow], 560);
    expect(rendered?.deferred).toEqual([{ displayPath: 'AGENTS.md', bytes: 400 }]);
    expect(rendered?.text).toContain(
      'Workspace instruction budget 560 bytes: not loaded /shared/AGENTS.md (400 bytes); ' +
        'read each with read_file before acting on this workspace.',
    );
    expect(rendered?.text).toContain(AGENT_INSTRUCTIONS_INTRO);
    expect(rendered?.text).toContain('N'.repeat(100));
    expect(rendered?.text).not.toContain('W'.repeat(10));
    expect(bytes(rendered?.text ?? '')).toBeLessThanOrEqual(560);
  });

  it('最具體的那一份放不下也整份延後：內容一個字都不放，沒有引言，外框還在', () => {
    const only = { displayPath: 'AGENTS.md', content: 'x'.repeat(2000) };
    const rendered = renderAgentInstructions([only], 500);
    expect(rendered?.deferred).toEqual([{ displayPath: 'AGENTS.md', bytes: 2000 }]);
    expect(rendered?.text).toBe(
      '<system-reminder>\n' +
        'Workspace instruction budget 500 bytes: not loaded AGENTS.md (2000 bytes); ' +
        'read each with read_file before acting on this workspace.\n' +
        '</system-reminder>',
    );
  });

  it('最具體的放不下、較寬的放得下：寬的照放，延後的只有放不下的那一份', () => {
    const wide = { displayPath: 'AGENTS.md', content: 'W'.repeat(50) };
    const narrow = { displayPath: 'AGENTS.local.md', content: 'N'.repeat(2000) };
    const rendered = renderAgentInstructions([wide, narrow], 600);
    expect(rendered?.deferred).toEqual([{ displayPath: 'AGENTS.local.md', bytes: 2000 }]);
    expect(rendered?.text).toContain('W'.repeat(50));
    expect(rendered?.text).not.toContain('N'.repeat(10));
    expect(bytes(rendered?.text ?? '')).toBeLessThanOrEqual(600);
  });

  it('位元組數算的是 UTF-8：中文一個字三個位元組', () => {
    const rendered = renderAgentInstructions(
      [{ displayPath: 'AGENTS.md', content: '中'.repeat(500) }],
      420,
    );
    expect(rendered?.deferred).toEqual([{ displayPath: 'AGENTS.md', bytes: 1500 }]);
    expect(rendered?.text).not.toContain('中');
  });

  it('連帶外框的通知都放不下就退成沒有外框的通知，照樣不超過預算、不切碎字元', () => {
    const rendered = renderAgentInstructions(
      [{ displayPath: '指示.md', content: 'x'.repeat(2000) }],
      60,
    );
    const text = rendered?.text ?? '';
    expect(bytes(text)).toBeLessThanOrEqual(60);
    expect(text).toContain('Workspace instruction budget 60 bytes:');
    expect(text).not.toContain('<system-reminder>');
    expect(text).not.toContain('\uFFFD');
  });
});
