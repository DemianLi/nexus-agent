/**
 * `errorChain`：診斷文字要帶出 cause 鏈與聚合成員，而且任何奇怪的值都不能讓它拋（#1511）。
 */

import { describe, expect, it } from 'vitest';

import { errorChain } from './error-chain.js';

describe('errorChain', () => {
  it('一般錯誤只寫訊息；空訊息退回名字', () => {
    expect(errorChain(new Error('壞了'))).toBe('壞了');
    expect(errorChain(new TypeError(''))).toBe('TypeError');
  });

  it('cause 用冒號接在後面；跟外層逐字相同的不重複', () => {
    expect(errorChain(new Error('外', { cause: new Error('內') }))).toBe('外: 內');
    expect(errorChain(new Error('一樣', { cause: new Error('一樣') }))).toBe('一樣');
  });

  it('AggregateError 的成員用方括號包起來、分號隔開，再接它自己的 cause', () => {
    const aggregate = new AggregateError([new Error('甲'), new Error('乙')], '兩份失敗');
    expect(errorChain(aggregate)).toBe('兩份失敗 [甲; 乙]');
    const nested = new Error('外層', { cause: new AggregateError([new Error('丙')], '聚合') });
    expect(errorChain(nested)).toBe('外層: 聚合 [丙]');
  });

  it('非 Error：字串直接轉、有 message 欄位的物件取 message', () => {
    expect(errorChain('字串')).toBe('字串');
    expect(errorChain({ message: '物件' })).toBe('物件');
    expect(errorChain(42)).toBe('42');
  });

  it('環狀 cause 只標一次；菱形共用的 cause 照寫全', () => {
    const loop = new Error('環');
    loop.cause = loop;
    expect(errorChain(loop)).toContain('<circular cause>');
    const shared = new Error('共用');
    const diamond = new AggregateError(
      [new Error('左', { cause: shared }), new Error('右', { cause: shared })],
      '菱形',
    );
    expect(errorChain(diamond)).toBe('菱形 [左: 共用; 右: 共用]');
  });

  it('惡意的 getter 只讓那個節點塌掉，不拋', () => {
    const hostile = new Error('x');
    Object.defineProperty(hostile, 'message', {
      get() {
        throw new Error('炸');
      },
    });
    expect(errorChain(hostile)).toBe('<unrenderable value>');
    expect(errorChain(new Error('外', { cause: hostile }))).toBe('外: <unrenderable value>');
  });
});
