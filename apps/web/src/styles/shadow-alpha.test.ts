// @vitest-environment node
import { describe, expect, test } from 'vitest';

import { parseColor } from './color-math';
import { readCascade } from './css-cascade';

/**
 * 亮色陰影不刺眼（#1307；`COMPONENTS.md`「外觀原則」陰影那段）：亮色時 `:root` 上**實際生效**的陰影顏色 token，透明度不超過各自的上限
 * （{@link ALPHA_TOKENS}）。只准一樣或更淡；想更明顯就多一層，不是把一層調濃。
 *
 * - **量疊出來的結果**：`index.css` 照 import 順序展開、算過 cascade 的值（`css-cascade.ts`，#1498），後面載入的 `tokens.generated.css`、覆寫檔改了值也量得到。
 * - **只管亮色**：暗底上投影要更濃才看得到，不套這些數字。
 * - **顏色寫法都認得**：`rgb()`、`rgba()`、`hsl()`、`oklch(… / 28%)`……透明度交給 colorjs.io 解（`color-math.ts`，#1512）。
 *
 * 量的是 token；元素上實際的 `box-shadow` 由瀏覽器那一層（`guard/`）量。
 */

/**
 * 當作陰影顏色用的 token 與各自的透明度上限（亮色）。之後誰把它調深就紅。
 *
 * solid-glass 的投影（#1512，#1468 Q8「外觀照 SG」）：上限釘在 SG 原檔現值：SG 的玻璃靠較深的投影浮起來（Q8）。
 * 只列**投影**（shade、lift、contact、under）；rim、edge、inner 是畫在邊上的亮線與細邊，不是投影。
 */
const ALPHA_TOKENS: Record<string, number> = {
  '--glass-shade': 0.28,
  '--glass-lift': 0.14,
  '--glass-contact': 0.06,
  '--knob-shade': 0.3,
  '--well-shade': 0.14,
  '--popover-under': 0.16,
  '--primary-under': 0.45,
};

/** 亮色時 `<html>` 只符合 `:root`。 */
const LIGHT = [':root'];

/** {@link ALPHA_TOKENS} 裡超過上限或根本不存在的 token。 */
function alphaTokenViolations(
  properties: Map<string, string>,
  limits: Record<string, number>,
): string[] {
  return Object.entries(limits).flatMap(([name, max]) => {
    const value = properties.get(name);
    if (value === undefined) return [`${name} 不存在`];
    const { alpha } = parseColor(value);
    return alpha <= max ? [] : [`${name} ${alpha} > ${max}`];
  });
}

describe('亮色陰影顏色 token 的透明度', () => {
  const properties = readCascade().customProperties(LIGHT);

  test('當作陰影顏色的 token 都在、都不超過各自的上限', () => {
    expect(alphaTokenViolations(properties, ALPHA_TOKENS)).toEqual([]);
  });

  test('判準：只讀亮色，暗色區塊不算', () => {
    const css =
      ':root {\n--x-shadow: rgb(0 0 0 / 0.01);\n}\n.dark {\n--x-shadow: rgb(0 0 0 / 0.5);\n}';
    expect(
      readCascade('/v/index.css', () => css)
        .customProperties(LIGHT)
        .get('--x-shadow'),
    ).not.toContain('0.5');
  });

  test('判準：token 超過上限、或改了名找不到，都紅', () => {
    const properties = new Map([
      ['--glass-shade', 'oklch(0.2 0.02 260 / 28%)'],
      ['--glass-lift', 'oklch(1 0 0 / 0.5)'],
    ]);
    expect(
      alphaTokenViolations(properties, {
        '--glass-shade': 0.28,
        '--glass-lift': 0.4,
        '--glass-contact': 0.1,
      }),
    ).toEqual(['--glass-lift 0.5 > 0.4', '--glass-contact 不存在']);
  });
});
