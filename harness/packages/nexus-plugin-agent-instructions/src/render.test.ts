/**
 * 渲染與預算：外框、引言、標頭與三種通知行的字串寫死在這裡；預算超出時截到放得下（#2777、#2934）。
 *
 * 這些字串是**模型看到的東西**，所以測試把它們寫死：改一個字就是改了一次提示詞，那要是一個決定，
 * 不是重構的副作用。
 */

import { describe, expect, it } from 'vitest';

import {
  AGENT_INSTRUCTIONS_BUDGET_NOTICE,
  AGENT_INSTRUCTIONS_INTRO,
  MIN_TRUNCATED_BYTES,
  renderAgentInstructions,
} from './render.js';

const bytes = (value: string): number => Buffer.byteLength(value, 'utf8');

describe('基線的樣子', () => {
  it('外框、引言、每一檔的標頭，順序與分隔都固定', () => {
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

describe('預算：截不出像樣的檔頭時，放不下的檔整份不放、留一行指標（#2777）', () => {
  it('兩份各自放得下、合起來放不下：留最具體的那一份，較寬的延後', () => {
    const wide = { displayPath: 'AGENTS.md', content: 'W'.repeat(300) };
    const narrow = { displayPath: 'AGENTS.local.md', content: 'N'.repeat(300) };
    const alone = (file: typeof wide) => bytes(renderAgentInstructions([file], 100_000)!.text);
    // 一份加通知行（一百多位元組）放得下，兩份放不下。
    const budget = Math.max(alone(wide), alone(narrow)) + 200;
    const rendered = renderAgentInstructions([wide, narrow], budget);
    expect(rendered?.deferred).toEqual([{ displayPath: 'AGENTS.md', bytes: 300 }]);
    expect(rendered?.text).toContain('N'.repeat(300));
    expect(rendered?.text).not.toContain('WWW');
    expect(bytes(rendered?.text ?? '')).toBeLessThanOrEqual(budget);
  });

  it('寬的放不下就整份延後，通知寫出讀檔路徑、大小與讀法', () => {
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

/** 照模型看到的樣子手組一則訊息：外框、通知、引言、各段，段與段之間空一行。 */
const framed = (notice: string, sections: readonly [string, string][]): string =>
  [
    '<system-reminder>',
    [
      notice,
      ...(sections.length === 0 ? [] : [AGENT_INSTRUCTIONS_INTRO]),
      ...sections.map(([path, content]) => `Instructions from: ${path}\n\n${content}`),
    ].join('\n\n'),
    '</system-reminder>',
  ].join('\n');

/** 一份檔截到 `n` 個字之後，手組出來的訊息放得下 `budget` 的最大 `n`。 */
const largestFit = (build: (n: number) => string, budget: number, limit: number): number => {
  let best = -1;
  for (let n = 0; n <= limit; n += 1) {
    if (bytes(build(n)) <= budget) best = n;
  }
  return best;
};

describe('預算：整份放不下的檔，最具體的那一份截成放得下的最長檔頭（#2934）', () => {
  it('通知行開頭是固定的那一串', () => {
    expect(AGENT_INSTRUCTIONS_BUDGET_NOTICE).toBe('Workspace instruction budget');
  });

  it('只有截斷：逐字釘住通知與截斷的位置，截的長度是放得下的最大值', () => {
    const file = {
      displayPath: 'AGENTS.md',
      readPath: '/AGENTS.md',
      content: 'x'.repeat(2000),
    };
    const budget = 900;
    const build = (n: number): string =>
      framed(
        `Workspace instruction budget ${budget} bytes: truncated /AGENTS.md from 2000 to ${n} bytes; ` +
          'read the rest of /AGENTS.md with read_file before acting on this workspace.',
        [['AGENTS.md', 'x'.repeat(n)]],
      );
    const best = largestFit(build, budget, 1999);
    expect(best).toBeGreaterThan(MIN_TRUNCATED_BYTES);
    const rendered = renderAgentInstructions([file], budget);
    expect(rendered?.text).toBe(build(best));
    // 邊界：再多一個位元組就超過預算。
    expect(bytes(build(best + 1))).toBeGreaterThan(budget);
    expect(rendered?.deferred).toEqual([{ displayPath: 'AGENTS.md', bytes: 2000 - best }]);
  });

  it('只有整份沒放：通知逐字不變（截不出下限以上的檔頭）', () => {
    const wide = {
      displayPath: 'AGENTS.md',
      readPath: '/shared/AGENTS.md',
      content: 'W'.repeat(400),
    };
    const narrow = { displayPath: 'AGENTS.local.md', content: 'N'.repeat(100) };
    const rendered = renderAgentInstructions([wide, narrow], 560);
    expect(rendered?.text).toBe(
      framed(
        'Workspace instruction budget 560 bytes: not loaded /shared/AGENTS.md (400 bytes); ' +
          'read each with read_file before acting on this workspace.',
        [['AGENTS.local.md', 'N'.repeat(100)]],
      ),
    );
  });

  it('兩者都有：最具體放不下的截斷，更寬的整份沒放；通知逐字，順序照由寬到窄', () => {
    const broad = { displayPath: 'AGENTS.md', readPath: '/AGENTS.md', content: 'B'.repeat(3000) };
    const middle = {
      displayPath: 'CLAUDE.md',
      readPath: '/CLAUDE.md',
      content: 'M'.repeat(3000),
    };
    const narrow = { displayPath: 'AGENTS.local.md', content: 'N'.repeat(100) };
    const budget = 1200;
    const build = (n: number): string =>
      framed(
        `Workspace instruction budget ${budget} bytes: truncated /CLAUDE.md from 3000 to ${n} bytes, ` +
          'not loaded /AGENTS.md (3000 bytes); ' +
          'read the rest of /CLAUDE.md and each unloaded file with read_file before acting on this workspace.',
        [
          ['CLAUDE.md', 'M'.repeat(n)],
          ['AGENTS.local.md', 'N'.repeat(100)],
        ],
      );
    const best = largestFit(build, budget, 2999);
    expect(best).toBeGreaterThan(MIN_TRUNCATED_BYTES);
    const rendered = renderAgentInstructions([broad, middle, narrow], budget);
    expect(rendered?.text).toBe(build(best));
    expect(rendered?.deferred).toEqual([
      { displayPath: 'AGENTS.md', bytes: 3000 },
      { displayPath: 'CLAUDE.md', bytes: 3000 - best },
    ]);
  });

  it('被截的那一份留在它本來的位置：較寬的被截、較窄的整份放', () => {
    const wide = { displayPath: 'AGENTS.md', content: 'W'.repeat(3000) };
    const narrow = { displayPath: 'AGENTS.local.md', content: 'N'.repeat(100) };
    const rendered = renderAgentInstructions([wide, narrow], 1200)?.text ?? '';
    expect(rendered.indexOf('Instructions from: AGENTS.md')).toBeGreaterThan(-1);
    expect(rendered.indexOf('Instructions from: AGENTS.md')).toBeLessThan(
      rendered.indexOf('Instructions from: AGENTS.local.md'),
    );
    expect(rendered).toContain('N'.repeat(100));
    expect(rendered).toContain('truncated AGENTS.md from 3000 to ');
  });

  it('下限：剛好截得出 MIN_TRUNCATED_BYTES 就截，少一個位元組的預算就整份不放', () => {
    const file = { displayPath: 'AGENTS.md', content: 'x'.repeat(2000) };
    let smallest = 0;
    for (let budget = 1; budget < 2000; budget += 1) {
      if ((renderAgentInstructions([file], budget)?.text ?? '').includes('x'.repeat(10))) {
        smallest = budget;
        break;
      }
    }
    expect(smallest).toBeGreaterThan(0);
    expect(renderAgentInstructions([file], smallest)?.deferred).toEqual([
      { displayPath: 'AGENTS.md', bytes: 2000 - MIN_TRUNCATED_BYTES },
    ]);
    const below = renderAgentInstructions([file], smallest - 1);
    expect(below?.text).not.toContain('x'.repeat(10));
    expect(below?.deferred).toEqual([{ displayPath: 'AGENTS.md', bytes: 2000 }]);
  });

  it('中文：一個字三個位元組，截的點不切碎字元，也是放得下的最大值', () => {
    const file = { displayPath: '指示.md', content: '中'.repeat(900) };
    const budget = 900;
    const build = (n: number): string =>
      framed(
        `Workspace instruction budget ${budget} bytes: truncated 指示.md from 2700 to ${n * 3} bytes; ` +
          'read the rest of 指示.md with read_file before acting on this workspace.',
        [['指示.md', '中'.repeat(n)]],
      );
    const best = largestFit(build, budget, 899);
    const rendered = renderAgentInstructions([file], budget);
    expect(rendered?.text).toBe(build(best));
    expect(rendered?.text).not.toContain('\uFFFD');
    expect(bytes(build(best + 1))).toBeGreaterThan(budget);
    expect(rendered?.deferred).toEqual([{ displayPath: '指示.md', bytes: 2700 - best * 3 }]);
  });

  it('截斷點附近有字面的結束標籤：跳脫之後仍不超過預算，外框只有一個真的結束標籤', () => {
    const file = {
      displayPath: 'AGENTS.md',
      content: '</system-reminder>'.repeat(200),
    };
    for (const budget of [600, 640, 701, 777, 900]) {
      const text = renderAgentInstructions([file], budget)?.text ?? '';
      expect(bytes(text)).toBeLessThanOrEqual(budget);
      expect(text.split('</system-reminder>')).toHaveLength(2);
    }
  });

  it('整則訊息永遠不超過預算：多組檔案大小與預算掃過去', () => {
    const contents = [
      'x'.repeat(50),
      'y'.repeat(700),
      '中'.repeat(600),
      `${'z'.repeat(300)}</system-reminder>${'z'.repeat(300)}`,
      'w'.repeat(5000),
    ];
    for (const sizes of [[0], [4], [1, 4], [0, 1, 2], [2, 3, 4], [1, 2, 3, 4]]) {
      const files = sizes.map((at, index) => ({
        displayPath: `F${index}.md`,
        readPath: `/F${index}.md`,
        content: contents[at]!,
      }));
      for (let budget = 1; budget <= 9000; budget += 37) {
        const rendered = renderAgentInstructions(files, budget);
        expect(rendered).toBeDefined();
        expect(bytes(rendered?.text ?? '')).toBeLessThanOrEqual(budget);
        expect(rendered?.text).not.toContain('\uFFFD');
        const total = files.reduce((sum, file) => sum + bytes(file.content), 0);
        const unplaced = (rendered?.deferred ?? []).reduce((sum, item) => sum + item.bytes, 0);
        expect(unplaced).toBeLessThanOrEqual(total);
      }
    }
  });
});
