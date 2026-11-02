/**
 * 事件表的閘門（[#1217](https://github.com/DemianLi/nexus-agent/issues/1217)，S0）：每個宣告在 `Events` 上的事件要有 JSDoc、
 * 標 `@mode emit | serial | waterfall`、每個參數有 `@param`、waterfall 的最後一個參數叫 `next`。照 dsh 的規矩。
 *
 * S0 的事件表是空的，那時這條閘門對真實的樹是空轉的，所以它有一組**正向對照**：拿合成的原始碼餵同一個掃描器，每一種違規
 * 各一條，確認它真的報得出來。S1a（[#1248](https://github.com/DemianLi/nexus-agent/issues/1248)）落了第一批事件之後，真實的樹那條開始有東西可驗；
 * 正向對照留著，因為「閘門對著現在的樹是綠的」不能證明它報得出違規。
 *
 * **每個事件跟它的第一個生產者同一張 PR 落地**（S0 的規矩）：沒有生產者的宣告是沒人送的死事件。最後一條閘門就是這條——
 * 事件表上的每個名字，產品碼裡都要有一處 `emit`／`serial`／`waterfall`／`observe` 以字串字面量派發它。
 */

import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  scanEventProducers,
  scanEventProducersTree,
  scanEventTable,
  scanEventTableTree,
} from './event-table-scan.js';

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

  it('S1a：事件表上正好是工具四事件（再多一個，要在這裡改名字並說它的生產者是誰）', () => {
    expect(scanEventTableTree(REPO_ROOT).map((event) => event.name)).toEqual([
      'tools/pre-execute',
      'tools/execute',
      'tools/post-execute',
      'tools/result',
    ]);
  });

  it('每個事件都有生產者：事件表上的名字，產品碼裡有一處以字串字面量派發它', () => {
    const producers = scanEventProducersTree(REPO_ROOT);
    const dead = scanEventTableTree(REPO_ROOT)
      .map((event) => event.name)
      .filter((name) => (producers.get(name) ?? []).length === 0);
    expect(dead).toEqual([]);
  });

  it('工具事件的派發模式對得上宣告：pre／execute／post 是 waterfall，result 是 emit 類（observe）', () => {
    const modes = new Map(scanEventTableTree(REPO_ROOT).map((event) => [event.name, event.mode]));
    expect(modes.get('tools/pre-execute')).toBe('waterfall');
    expect(modes.get('tools/execute')).toBe('waterfall');
    expect(modes.get('tools/post-execute')).toBe('waterfall');
    expect(modes.get('tools/result')).toBe('emit');
  });
});

describe('生產者掃描器本身（正向對照）', () => {
  it('四個派發方法、字串字面量的事件名都認得；變數當事件名不算', () => {
    const text = `
      bus.emit('a/one', 1);
      bus.serial('a/two');
      await events.waterfall('a/three', exec, () => x);
      events.observe('a/four', onError, exec);
      dispatch.emit(name, 1);
      other.send('a/five');
    `;
    expect(scanEventProducers(text)).toEqual(['a/one', 'a/two', 'a/three', 'a/four']);
  });
});
