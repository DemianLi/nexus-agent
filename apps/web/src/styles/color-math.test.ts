// @vitest-environment node
import { describe, expect, test } from 'vitest';

import {
  backdrops,
  colorsIn,
  composite,
  contrastRatio,
  parseColor,
  shadowLayers,
  splitTopLevel,
  surfaceContrast,
} from './color-math';

const tokens =
  (values: Record<string, string>) =>
  (name: string): string | undefined =>
    values[name];

describe('surfaceContrast：半透明的面疊到最差的底上', () => {
  test('面不透明時不用疊，跟直接算一樣', () => {
    const result = surfaceContrast(
      tokens({ fg: 'rgb(0 0 0)', bg: 'rgb(255 255 255)', background: 'rgb(0 0 0)' }),
      'fg',
      'bg',
      [['background']],
    );
    expect(result).toEqual({ ratio: 21, on: undefined });
  });

  test('面半透明時每一疊底各算一次，回報最差的那一疊；漸層停點本身半透明，疊在底色上', () => {
    const lookup = tokens({
      fg: 'rgb(0 0 0)',
      card: 'rgb(255 255 255 / 0.5)',
      background: 'rgb(255 255 255)',
      'light-1': 'rgb(0 0 0 / 0.5)',
    });
    const result = surfaceContrast(lookup, 'fg', 'card', [
      ['background'],
      ['background', 'light-1'],
    ]);
    expect(result.on).toBe('background+light-1');
    // 底色白、停點黑 50% → 灰 0.5；白 50% 的面疊上去 → 0.75。
    const face = composite(parseColor('rgb(255 255 255 / 0.5)'), [0.5, 0.5, 0.5]);
    expect(face).toEqual([0.75, 0.75, 0.75]);
    expect(result.ratio).toBeCloseTo(contrastRatio([0, 0, 0], face), 10);
    expect(result.ratio).toBeLessThan(
      surfaceContrast(lookup, 'fg', 'card', [['background']]).ratio,
    );
  });

  test('面就是底的最底層（字直接寫在頁面上）時，量的是疊上漸層停點的結果，不是平的底色', () => {
    const lookup = tokens({
      fg: 'rgb(255 255 255)',
      background: 'rgb(0 0 0)',
      'light-1': 'rgb(255 255 255 / 0.5)',
    });
    const result = surfaceContrast(lookup, 'fg', 'background', [
      ['background'],
      ['background', 'light-1'],
    ]);
    // 黑底疊白 50% → 灰 0.5；白字對它比對純黑差。
    expect(result.on).toBe('background+light-1');
    expect(result.ratio).toBeCloseTo(contrastRatio([1, 1, 1], [0.5, 0.5, 0.5]), 10);
    expect(result.ratio).toBeLessThan(21);
    // 沒有停點時跟直接算一樣，`on` 標出疊的是哪一疊。
    expect(surfaceContrast(lookup, 'fg', 'background', [['background']])).toEqual({
      ratio: 21,
      on: 'background',
    });
  });

  test('文字本身半透明時疊在合成好的面上', () => {
    const result = surfaceContrast(
      tokens({ fg: 'rgb(0 0 0 / 0.5)', bg: 'rgb(255 255 255)' }),
      'fg',
      'bg',
      [],
    );
    expect(result.ratio).toBeCloseTo(contrastRatio([0.5, 0.5, 0.5], [1, 1, 1]), 10);
  });

  test('沒有答案的就拋錯，不猜：最底下那層半透明、半透明的面沒給底、token 不存在', () => {
    const lookup = tokens({
      fg: 'rgb(0 0 0)',
      card: 'rgb(255 255 255 / 0.5)',
      glass: 'rgb(255 255 255 / 0.2)',
    });
    expect(() => surfaceContrast(lookup, 'fg', 'card', [['glass']])).toThrow(
      '--glass 是半透明的，不能當最底下的底',
    );
    expect(() => surfaceContrast(lookup, 'fg', 'card', [])).toThrow(
      '--card 是半透明的，要指定疊在什麼上面',
    );
    expect(() => surfaceContrast(lookup, 'fg', 'missing', [])).toThrow('沒有 --missing');
  });
});

describe('解析', () => {
  test('parseColor 認得 oklch 的百分比透明度與 transparent', () => {
    expect(parseColor('oklch(0 0 0 / 28%)').alpha).toBe(0.28);
    expect(parseColor('transparent').alpha).toBe(0);
    expect(parseColor('rgba(0, 0, 0, 0.04)')).toEqual({ rgb: [0, 0, 0], alpha: 0.04 });
  });

  test('splitTopLevel 只切最外層的逗號', () => {
    expect(splitTopLevel('rgba(0, 0, 0, 0.1) 0px 1px, oklch(0 0 0 / 5%) 0 2px')).toEqual([
      'rgba(0, 0, 0, 0.1) 0px 1px',
      'oklch(0 0 0 / 5%) 0 2px',
    ]);
  });

  test('colorsIn 只抓寫死的顏色函式，不抓 var() 與 color-mix() 本身', () => {
    expect(colorsIn('color-mix(in oklch, var(--a) 50%, transparent) rgb(0 0 0 / 0.1)')).toEqual([
      'rgb(0 0 0 / 0.1)',
    ]);
  });

  test('shadowLayers 認得宣告值與計算值兩種寫法、inset、邊緣那一層、none', () => {
    expect(shadowLayers('none')).toEqual([]);
    expect(
      shadowLayers(
        'rgba(0, 0, 0, 0.06) 0px 1px 2px 0px, oklch(0 0 0 / 0.14) 0px 0px 0px 1px, inset 0 1px 0 rgb(255 255 255 / 0.04), 0 0 0 1px var(--x)',
      ).map(({ inset, edge, color }) => ({ inset, edge, color })),
    ).toEqual([
      { inset: false, edge: false, color: 'rgba(0, 0, 0, 0.06)' },
      { inset: false, edge: true, color: 'oklch(0 0 0 / 0.14)' },
      { inset: true, edge: false, color: 'rgb(255 255 255 / 0.04)' },
      { inset: false, edge: true, color: undefined },
    ]);
  });

  test('shadowLayers 標出什麼都不畫的層：四個長度全是 0（ring-0 留下的那層，#1523）', () => {
    expect(
      shadowLayers(
        'oklch(0.16 0 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, oklch(0 0 0 / 0.14) 0px 0px 0px 1px, inset 0 0 0 0 red',
      ).map((l) => l.empty),
    ).toEqual([true, true, false, true]);
  });
});

describe('backdrops：元素實際的底色', () => {
  const layer = (backgroundColor: string, backgroundImage = 'none') => ({
    backgroundColor,
    backgroundImage,
  });

  test('往上找到第一個不透明的底，中間半透明的各層疊回來', () => {
    expect(
      backdrops([
        layer('rgba(0, 0, 0, 0)'),
        layer('rgba(255, 255, 255, 0.5)'),
        layer('rgb(0, 0, 0)'),
        layer('rgb(255, 0, 0)'),
      ]),
    ).toEqual([{ label: 'base', rgb: [0.5, 0.5, 0.5] }]);
  });

  test('漸層的每個停點各是一個候選，不畫漸層的地方也是', () => {
    const result = backdrops([
      layer('rgba(0, 0, 0, 0)'),
      layer(
        'rgb(255, 255, 255)',
        'radial-gradient(10px at 0 0, rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0) 60%)',
      ),
    ]);
    expect(result.map((c) => c.label)).toEqual(['base', '1:stop0', '1:stop1']);
    expect(result[1]?.rgb).toEqual([0.5, 0.5, 0.5]);
    expect(result[2]?.rgb).toEqual([1, 1, 1]);
  });

  test('一路往上都沒有不透明的底就拋錯', () => {
    expect(() => backdrops([layer('rgba(0, 0, 0, 0)'), layer('transparent')])).toThrow(
      '一路往上都沒有不透明的底色',
    );
  });
});
