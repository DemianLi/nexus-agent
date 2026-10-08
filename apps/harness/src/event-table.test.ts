/**
 * 事件表的閘門（[#1217](https://github.com/DemianLi/nexus-agent/issues/1217)，S0）：每個宣告在 `Events` 上的事件要有 JSDoc、
 * 標 `@mode emit | serial | waterfall`、每個參數有 `@param`、waterfall 的最後一個參數叫 `next`。照 dsh 的規矩。
 *
 * **S0 的事件表是空的**，所以對真實的樹來說這條閘門今天是空轉的——空轉的閘門等於沒有，所以它有一組**正向對照**：
 * 拿合成的原始碼餵同一個掃描器，每一種違規各一條，確認它真的報得出來。S1 加第一個事件的那天，真實的樹那條才開始有東西可驗。
 */

import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { scanEventTable, scanEventTableTree } from './event-table-scan.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function scan(body: string, wrapper: 'direct' | 'augment' = 'augment') {
  const text =
    wrapper === 'direct'
      ? `export interface Events {\n${body}\n}`
      : `declare module '@nexus/core' {\n  interface Events {\n${body}\n  }\n}`;
  return scanEventTable('probe.ts', text);
}

describe('掃描器本身（正向對照）', () => {
  it('合規的成員：兩種宣告位置都找得到，沒有違規', () => {
    const good = `
      /**
       * 一步要開始了。
       * @mode waterfall
       * @param step - 步號。
       * @param next - 內建行為。
       */
      'x/pre-step'(step: number, next: () => void): void;
    `;
    for (const wrapper of ['direct', 'augment'] as const) {
      expect(scan(good, wrapper)).toEqual([
        { name: 'x/pre-step', file: 'probe.ts', mode: 'waterfall', problems: [] },
      ]);
    }
  });

  it.each([
    ['沒有 JSDoc', `'x/a'(): void;`, '沒有 JSDoc'],
    ['沒標 mode', `/** 說明。 */\n'x/a'(): void;`, '沒標 `@mode`'],
    [
      'mode 不在允許的集合',
      `/**\n * 說明。\n * @mode bail\n */\n'x/a'(): void;`,
      '不在 emit／serial／waterfall 裡',
    ],
    [
      '參數沒說明',
      `/**\n * 說明。\n * @mode emit\n */\n'x/a'(count: number): void;`,
      '參數 `count` 沒有 `@param`',
    ],
    [
      'waterfall 最後一個參數不是 next',
      `/**\n * 說明。\n * @mode waterfall\n * @param done - 完成。\n */\n'x/a'(done: () => void): void;`,
      '最後一個參數必須叫 `next`',
    ],
    ['宣告成屬性', `/**\n * 說明。\n * @mode emit\n */\n'x/a': () => void;`, '方法簽名'],
  ])('%s：報得出來', (_label, body, expected) => {
    const [declared] = scan(body);
    expect(declared?.problems.join('；')).toContain(expected);
  });

  it('不是 Events 的 interface 不掃', () => {
    expect(scanEventTable('probe.ts', `interface Other {\n  'x/a'(): void;\n}`)).toEqual([]);
  });
});

describe('真實的樹', () => {
  it('每個宣告的事件都合規', () => {
    const declared = scanEventTableTree(REPO_ROOT);
    const bad = declared.filter((event) => event.problems.length > 0);
    expect(
      bad.map((event) => `${event.file}：${event.name} — ${event.problems.join('；')}`),
    ).toEqual([]);
  });

  it('S0：事件表是空的（S1 的第一個事件落地時，這一條跟著改成它的名字）', () => {
    expect(scanEventTableTree(REPO_ROOT).map((event) => event.name)).toEqual([]);
  });
});
