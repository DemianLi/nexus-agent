import type { ModelCatalog } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import {
  effectiveSelection,
  effortOf,
  findModel,
  parseModelLine,
  parseSelectionProjection,
  seatText,
  selectionForModel,
} from '@/lib/model-selection';

const CATALOG: ModelCatalog = {
  default: { modelId: 'alpha' },
  models: [
    { id: 'alpha', name: 'Alpha' },
    { id: 'alpine', name: 'Alpine' },
    {
      id: 'beta',
      name: 'Beta Max',
      reasoning: {
        efforts: [
          { id: 'low', name: '低' },
          { id: 'high', name: '高' },
        ],
        defaultEffort: 'low',
      },
    },
  ],
};

describe('effectiveSelection', () => {
  it('依序取第一個型錄上有的；都沒有就是部署預設', () => {
    expect(effectiveSelection(CATALOG, [{ modelId: 'beta' }, { modelId: 'alpine' }])).toEqual({
      modelId: 'beta',
    });
    expect(effectiveSelection(CATALOG, [undefined, null, { modelId: 'alpine' }])).toEqual({
      modelId: 'alpine',
    });
    expect(effectiveSelection(CATALOG, [null, undefined])).toEqual({ modelId: 'alpha' });
  });

  it('型錄上沒有的模型 id 跳過，退到下一個', () => {
    expect(effectiveSelection(CATALOG, [{ modelId: 'gone' }, { modelId: 'beta' }])).toEqual({
      modelId: 'beta',
    });
    expect(effectiveSelection(CATALOG, [{ modelId: 'gone' }])).toEqual({ modelId: 'alpha' });
  });
});

describe('強度與座位文字', () => {
  it('沒宣告強度的模型沒有強度；宣告了就是帶的那個、否則預設等級', () => {
    expect(
      effortOf(findModel(CATALOG, 'alpha')!, { modelId: 'alpha', reasoningEffort: 'high' }),
    ).toBe(undefined);
    const beta = findModel(CATALOG, 'beta')!;
    expect(effortOf(beta, { modelId: 'beta' })).toBe('low');
    expect(effortOf(beta, { modelId: 'beta', reasoningEffort: 'high' })).toBe('high');
    // 帶了那顆沒宣告的強度：退回預設，不照單全收。
    expect(effortOf(beta, { modelId: 'beta', reasoningEffort: 'turbo' })).toBe('low');
  });

  it('座位文字：模型名，有強度再加強度名；型錄沒有的 id 原樣顯示', () => {
    expect(seatText(CATALOG, { modelId: 'alpha' })).toBe('Alpha');
    expect(seatText(CATALOG, { modelId: 'beta' })).toBe('Beta Max · 低');
    expect(seatText(CATALOG, { modelId: 'beta', reasoningEffort: 'high' })).toBe('Beta Max · 高');
    expect(seatText(CATALOG, { modelId: 'ghost' })).toBe('ghost');
  });

  it('換模型時沿用強度，但新模型也宣告了它才算', () => {
    const beta = findModel(CATALOG, 'beta')!;
    const alpha = findModel(CATALOG, 'alpha')!;
    expect(selectionForModel(beta, { modelId: 'x', reasoningEffort: 'high' })).toEqual({
      modelId: 'beta',
      reasoningEffort: 'high',
    });
    expect(selectionForModel(beta, { modelId: 'x', reasoningEffort: 'turbo' })).toEqual({
      modelId: 'beta',
    });
    expect(selectionForModel(alpha, { modelId: 'x', reasoningEffort: 'high' })).toEqual({
      modelId: 'alpha',
    });
  });
});

describe('parseModelLine', () => {
  const current = { modelId: 'alpha' };
  const parse = (line: string) => parseModelLine(line, CATALOG, current);

  it('不是 /model 開頭就不歸它', () => {
    expect(parse('hello')).toBeUndefined();
    expect(parse('/models')).toBeUndefined();
    expect(parse('/modelx beta')).toBeUndefined();
    expect(parse('please /model beta')).toBeUndefined();
  });

  it('光打 /model 是打開座位', () => {
    expect(parse('/model')).toEqual({ kind: 'open' });
    expect(parse('  /model   ')).toEqual({ kind: 'open' });
  });

  it('模型先比 id、再比名字、最後比唯一的前綴，不分大小寫', () => {
    expect(parse('/model BETA')).toEqual({ kind: 'pick', selection: { modelId: 'beta' } });
    // 名字有空白的模型用 id 打：空白後面的字會被當成強度。
    expect(parse('/model beta max')).toEqual({ kind: 'unknown', query: 'max' });
    expect(parse('/model alp')).toEqual({ kind: 'unknown', query: 'alp' });
    expect(parse('/model alpha')).toEqual({ kind: 'pick', selection: { modelId: 'alpha' } });
    expect(parse('/model be')).toEqual({ kind: 'pick', selection: { modelId: 'beta' } });
  });

  it('第二個字是強度（id 或名字）；沒宣告的強度是 unknown', () => {
    expect(parse('/model beta high')).toEqual({
      kind: 'pick',
      selection: { modelId: 'beta', reasoningEffort: 'high' },
    });
    expect(parse('/model beta 高')).toEqual({
      kind: 'pick',
      selection: { modelId: 'beta', reasoningEffort: 'high' },
    });
    expect(parse('/model beta turbo')).toEqual({ kind: 'unknown', query: 'turbo' });
    expect(parse('/model alpha high')).toEqual({ kind: 'unknown', query: 'high' });
  });
});

describe('parseSelectionProjection', () => {
  const projection = (view: unknown) => ({ version: 1, view });

  it('收 { lastUsed, next }，兩格都可以是 null', () => {
    expect(
      parseSelectionProjection(
        projection({ lastUsed: null, next: { modelId: 'beta', reasoningEffort: 'high' } }),
      ),
    ).toEqual({ lastUsed: null, next: { modelId: 'beta', reasoningEffort: 'high' } });
  });

  it.each([
    ['沒收到', undefined],
    ['失敗的投影', { version: 1, view: null, failed: true as const }],
    ['不是物件', projection('x')],
    ['缺 next', projection({ lastUsed: null })],
    ['modelId 空字串', projection({ lastUsed: null, next: { modelId: '' } })],
    ['modelId 不是字串', projection({ lastUsed: null, next: { modelId: 3 } })],
  ])('形狀不對就當沒收到：%s', (_case, value) => {
    expect(parseSelectionProjection(value)).toBeUndefined();
  });
});
