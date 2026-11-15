/**
 * `<nexus-chat>` 讓宿主頁覆寫的設計 token（#2366，地圖 #2365 第 11 點）：只有主色、字型、圓角、底色四個，宿主頁在元素上寫
 * CSS 自訂屬性（`--nexus-primary` 之類，見 {@link THEME_TOKENS}）。顏色覆寫之後跟它上面那一層字的對比度不到 4.5（`.docs/web-ui-spec.md`
 * §5 文字的門檻）就不套，退回預設，並在 console 講是哪一個。
 *
 * @module
 */
import Color from 'colorjs.io';

/** 文字的對比度門檻（`.docs/web-ui-spec.md` §5）。 */
export const TEXT_CONTRAST_MIN = 4.5;

/**
 * 宿主頁寫的屬性名 → 套到元素裡的哪裡。顏色的 `against` 是畫在它上面的那一色：主色上是主按鈕的字，底色上是內文。
 * 字型直接設 `font-family`：網頁的 `--font-sans` 在建置時就展開了（`@theme inline`），改變數沒有用。
 */
export const THEME_TOKENS = [
  { property: '--nexus-primary', target: '--primary', against: '--primary-foreground' },
  { property: '--nexus-background', target: '--background', against: '--foreground' },
  { property: '--nexus-radius', target: '--radius' },
  { property: '--nexus-font', target: 'font-family' },
] as const;

/** 讀出來的值：`host` 是宿主頁寫在元素上的，`root` 是元素裡預設的 token（給對比度算）。 */
export interface TokenReader {
  host(property: string): string;
  root(property: string): string;
}

/**
 * 算出要套的覆寫，`[目標, 值]`。沒寫的不套；顏色解不出來、或對比度不到門檻的不套，各在 console 講一句。
 *
 * @param scheme - 現在是亮還是暗，只用在 console 那句話：同一個主色可能亮色過、暗色不過。
 */
export function themeOverrides(
  read: TokenReader,
  scheme: 'light' | 'dark',
): readonly (readonly [string, string])[] {
  const accepted: (readonly [string, string])[] = [];
  for (const token of THEME_TOKENS) {
    const value = read.host(token.property).trim();
    if (value === '') continue;
    if ('against' in token) {
      const ratio = contrast(value, read.root(token.against).trim());
      if (ratio === undefined) {
        console.warn(`<nexus-chat> 的 ${token.property} 解不出顏色（${value}），用預設值。`);
        continue;
      }
      if (ratio < TEXT_CONTRAST_MIN) {
        console.warn(
          `<nexus-chat> 的 ${token.property}（${value}）在${scheme === 'dark' ? '暗' : '亮'}色下跟 ${token.against} ` +
            `的對比度是 ${ratio.toFixed(2)}，不到 ${TEXT_CONTRAST_MIN}，用預設值。`,
        );
        continue;
      }
    }
    accepted.push([token.target, value]);
  }
  return accepted;
}

function contrast(a: string, b: string): number | undefined {
  try {
    return new Color(a).contrast(new Color(b), 'WCAG21');
  } catch {
    return undefined;
  }
}
