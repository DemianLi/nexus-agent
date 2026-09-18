/**
 * 渲染與預算——字串與位元組帳逐條對 dsh `packages/context/agent-instructions/src/render.ts`（`ddefc45`）。
 *
 * 這些字串是**模型看到的東西**，所以測試把它們寫死：改一個字就是改了一次提示詞，那要是一個決定，
 * 不是重構的副作用。
 */

import { describe, expect, it } from 'vitest';

import {
  AGENT_INSTRUCTIONS_INTRO,
  COMPACT_AGENT_INSTRUCTIONS_INTRO,
  renderAgentInstructions,
} from './render.js';

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
    expect(rendered?.omitted).toEqual([]);
    expect(rendered?.truncated).toEqual([]);
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

describe('預算：寬的先整份省略，最具體的最後才截斷', () => {
  it('塞不下就從最寬的開始整份省略，通知寫出是誰', () => {
    const wide = { displayPath: 'AGENTS.md', content: 'W'.repeat(400) };
    const narrow = { displayPath: 'AGENTS.local.md', content: 'N'.repeat(100) };
    // 500：**剛好夠**讓「省略寬的那一份」這條路成立。再緊一點就會掉進截斷分支（引言自己就吃 240
    // 個位元組），而那是下一條在量的東西。
    const rendered = renderAgentInstructions([wide, narrow], 500);
    expect(rendered?.omitted).toEqual(['AGENTS.md']);
    expect(rendered?.truncated).toEqual([]);
    expect(rendered?.text).toContain('Workspace instruction budget 500 bytes: omitted AGENTS.md');
    expect(rendered?.text).toContain('N'.repeat(100));
    expect(rendered?.text).not.toContain('W'.repeat(10));
    expect(bytes(rendered?.text ?? '')).toBeLessThanOrEqual(500);
  });

  it('剩最後一份還是塞不下就截它，通知寫出原本與留下的位元組數', () => {
    const only = { displayPath: 'AGENTS.md', content: 'x'.repeat(2000) };
    const rendered = renderAgentInstructions([only], 500);
    expect(rendered?.omitted).toEqual([]);
    expect(rendered?.truncated).toHaveLength(1);
    expect(rendered?.truncated[0]?.originalBytes).toBe(2000);
    expect(rendered?.truncated[0]?.includedBytes).toBeGreaterThan(0);
    expect(rendered?.text).toContain(
      `Workspace instruction budget 500 bytes: truncated AGENTS.md from 2000 to ${String(
        rendered?.truncated[0]?.includedBytes,
      )} bytes`,
    );
    expect(bytes(rendered?.text ?? '')).toBeLessThanOrEqual(500);
  });

  it('截斷不會切碎一個字元', () => {
    const rendered = renderAgentInstructions(
      [{ displayPath: 'AGENTS.md', content: '中'.repeat(500) }],
      420,
    );
    const text = rendered?.text ?? '';
    expect(text).not.toContain('�');
    expect(bytes(text)).toBeLessThanOrEqual(420);
    // 留下來的位元組數一定是 3 的倍數：每個「中」三個位元組，切一半就會出現替換字元。
    expect((rendered?.truncated[0]?.includedBytes ?? 0) % 3).toBe(0);
  });

  it('預算緊到連引言都放不下時換成短引言', () => {
    const rendered = renderAgentInstructions(
      [{ displayPath: 'AGENTS.md', content: 'x'.repeat(2000) }],
      260,
    );
    const text = rendered?.text ?? '';
    expect(text).toContain(COMPACT_AGENT_INSTRUCTIONS_INTRO);
    expect(text).not.toContain(AGENT_INSTRUCTIONS_INTRO);
    expect(bytes(text)).toBeLessThanOrEqual(260);
  });

  it('連短引言都放不下就退成一則沒有外框的通知，而且照樣不超過預算', () => {
    const rendered = renderAgentInstructions(
      [{ displayPath: 'AGENTS.md', content: 'x'.repeat(2000) }],
      80,
    );
    const text = rendered?.text ?? '';
    expect(bytes(text)).toBeLessThanOrEqual(80);
    expect(text).toContain('Workspace instruction budget 80 bytes:');
    expect(text).not.toContain('<system-reminder>');
  });
});
