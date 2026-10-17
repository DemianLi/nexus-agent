// @vitest-environment node
import { writeFileSync } from 'node:fs';

import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
  backdrops,
  composite,
  contrastRatio,
  parseColor,
  shadowLayers,
  type BackgroundLayer,
} from '../src/styles/color-math';
import { startGuardServer, type GuardServer } from './server';

/**
 * 瀏覽器那一層的樣式護欄（#1512）：用真的 Chrome 開測試頁（`guard/main.tsx`），量元件在**出貨 CSS**（`dist/`）下的計算值。
 * 靜態那一層（`src/styles/*.test.ts`）量的是 token 與選擇器文字，量不到 specificity、`color-mix()` 現場合成的底色、
 * 半透明的面實際疊在什麼上面；這裡量的是畫出來的結果。
 *
 * 量三件事，亮暗各一次：
 * 1. **焦點**：鍵盤聚焦後 `box-shadow` 看得見的層跟沒聚焦時一樣（不帶 ring），外框是 2px 實線、顏色是頁面的字色（`.docs/web-ui-spec.md`、#1279）。
 * 2. **對比**：每個字的顏色對它實際的底色（往上疊到不透明為止，漸層取最差的停點）過門檻（文字 4.5，`data-guard-min` 另給）。
 * 3. **亮色陰影**：每層投影的透明度不超過 {@link MAX_SHADOW_ALPHA}（同 `src/styles/shadow-alpha.test.ts`）。
 *
 * 跑法：先 `pnpm --filter @nexus/web run build`，再 `pnpm --filter @nexus/web run test:guard`（CI 在 static job 的 build 之後）。
 * 瀏覽器用本機裝的 Chrome（`channel: 'chrome'`），不另外下載。`GUARD_REPORT=<檔案>` 會把量到的數字寫成 JSON。
 */

type Theme = 'light' | 'dark';

const MAX_SHADOW_ALPHA = 0.06;

/** 亮色時有看得見的投影的元素（`data-guard-shadow`）。 */
const SHADOWED = ['button-outline', 'card', 'input-group', 'popover'];
const TEXT_MIN = 4.5;

interface TextSample {
  name: string;
  min: number;
  color: string;
  chain: BackgroundLayer[];
}

interface FocusSample {
  name: string;
  focusVisible: boolean;
  shadowBefore: string;
  shadowAfter: string;
  hostShadowBefore: string;
  hostShadowAfter: string;
  outlineStyle: string;
  outlineWidth: string;
  outlineColor: string;
  pageColor: string;
}

interface ShadowSample {
  name: string;
  boxShadow: string;
}

let server: GuardServer | undefined;
let browser: Browser | undefined;
const report: Record<string, unknown> = {};

beforeAll(async () => {
  server = await startGuardServer();
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch (error) {
    await server.close();
    server = undefined;
    throw error;
  }
}, 60_000);

afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    await server?.close();
  }
  const target = process.env.GUARD_REPORT;
  if (target) writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
});

/** 等有限長度的動畫與轉場跑完（無限的，例如呼吸光，不等）。 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity);
    await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
  });
}

async function open(theme: Theme): Promise<Page> {
  if (browser === undefined || server === undefined) throw new Error('瀏覽器或伺服器沒起來');
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.goto(`${server.url}?theme=${theme}`);
  await page.waitForSelector('[data-guard-text="tooltip"]');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await settle(page);
  return page;
}

function collectTexts(page: Page): Promise<TextSample[]> {
  return page.evaluate((defaultMin) => {
    const chainOf = (el: Element) => {
      const chain = [];
      for (let node: Element | null = el; node !== null; node = node.parentElement) {
        const style = getComputedStyle(node);
        chain.push({
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
        });
      }
      return chain;
    };
    const sample = (el: Element, name: string, min: number) => ({
      name,
      min,
      color: getComputedStyle(el).color,
      chain: chainOf(el),
    });
    const samples = [];
    for (const el of document.querySelectorAll('[data-guard-text]')) {
      const min = Number(el.getAttribute('data-guard-min') ?? defaultMin);
      samples.push(sample(el, el.getAttribute('data-guard-text') ?? '', min));
    }
    for (const group of document.querySelectorAll('[data-guard-texts]')) {
      const name = group.getAttribute('data-guard-texts') ?? '';
      group.querySelectorAll('[aria-hidden]').forEach((el, i) => {
        samples.push(sample(el, `${name}-${i}`, defaultMin));
      });
    }
    return samples;
  }, TEXT_MIN);
}

async function collectFocus(page: Page): Promise<FocusSample[]> {
  // 鍵盤操作過，程式聚焦才會算 `:focus-visible`（瀏覽器的判斷看最後一次是鍵盤還是滑鼠）。
  await page.keyboard.press('Tab');
  const names = await page.$$eval('[data-guard-focus]', (els) =>
    els.map((el) => el.getAttribute('data-guard-focus') ?? ''),
  );
  const samples: FocusSample[] = [];
  for (const name of names) {
    const target = page.locator(`[data-guard-focus="${name}"]`);
    const read = () =>
      target.evaluate((el) => {
        const host = el.closest('[data-guard-outline-host]') ?? el;
        const hostStyle = getComputedStyle(host);
        return {
          focusVisible: el.matches(':focus-visible'),
          shadow: getComputedStyle(el).boxShadow,
          hostShadow: hostStyle.boxShadow,
          outlineStyle: hostStyle.outlineStyle,
          outlineWidth: hostStyle.outlineWidth,
          outlineColor: hostStyle.outlineColor,
          pageColor: getComputedStyle(document.body).color,
        };
      });
    await target.evaluate((el) => (el as HTMLElement).blur());
    await settle(page);
    const before = await read();
    await target.focus();
    await settle(page);
    const after = await read();
    samples.push({
      name,
      focusVisible: after.focusVisible,
      shadowBefore: before.shadow,
      shadowAfter: after.shadow,
      hostShadowBefore: before.hostShadow,
      hostShadowAfter: after.hostShadow,
      outlineStyle: after.outlineStyle,
      outlineWidth: after.outlineWidth,
      outlineColor: after.outlineColor,
      pageColor: after.pageColor,
    });
  }
  return samples;
}

function collectShadows(page: Page): Promise<ShadowSample[]> {
  return page.$$eval('[data-guard-shadow]', (els) =>
    els.map((el) => ({
      name: el.getAttribute('data-guard-shadow') ?? '',
      boxShadow: getComputedStyle(el).boxShadow,
    })),
  );
}

/** 字疊在每一個候選底色上的對比，取最差的。 */
function worstContrast(sample: TextSample): { ratio: number; on: string } {
  const text = parseColor(sample.color);
  return backdrops(sample.chain)
    .map((b) => ({ on: b.label, ratio: contrastRatio(composite(text, b.rgb), b.rgb) }))
    .reduce((worst, next) => (next.ratio < worst.ratio ? next : worst));
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * `box-shadow` 裡看得見的層。Tailwind 的 ring／shadow 清掉時留下的是全透明的層（`rgba(0, 0, 0, 0) 0px 0px 0px 0px`），
 * 跟 `none` 畫起來一樣，比的時候拿掉；有顏色的 ring 就留著，聚焦前後一比就看得出來。
 */
function visibleShadow(value: string): string[] {
  return shadowLayers(value)
    .filter((l) => l.color === undefined || parseColor(l.color).alpha > 0)
    .map((l) => l.text);
}

const sameShadow = (a: string, b: string) =>
  JSON.stringify(visibleShadow(a)) === JSON.stringify(visibleShadow(b));

describe.each<Theme>(['light', 'dark'])('瀏覽器量出貨的 CSS：%s', (theme) => {
  let page: Page;
  let texts: TextSample[];
  let focus: FocusSample[];
  let shadows: ShadowSample[];

  beforeAll(async () => {
    page = await open(theme);
    texts = await collectTexts(page);
    shadows = await collectShadows(page);
    focus = await collectFocus(page);
  }, 60_000);

  afterAll(async () => {
    await page?.close();
  });

  test('量具有抓到東西：每個標了的元素都量到', () => {
    expect(texts.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'body',
        'button-default',
        'card-title',
        'card-counts-0',
        'card-counts-1',
        'popover',
        'tooltip',
        'sidebar-menu-button',
      ]),
    );
    expect(focus.map((f) => f.name)).toEqual(
      expect.arrayContaining(['button-default', 'input-group', 'sidebar-menu-button']),
    );
    expect(shadows.length).toBeGreaterThan(0);
  });

  test('每個字對它實際的底色過門檻（往上疊到不透明為止、漸層取最差的停點）', () => {
    const measured = texts.map((t) => ({ name: t.name, min: t.min, ...worstContrast(t) }));
    report[`${theme}:contrast`] = measured.map((m) => ({ ...m, ratio: round(m.ratio) }));
    expect(
      measured
        .filter((m) => !(m.ratio >= m.min))
        .map((m) => `${m.name} ${round(m.ratio)} < ${m.min}（${m.on}）`),
    ).toEqual([]);
  });

  test('鍵盤焦點：box-shadow 不帶 ring（跟沒聚焦時一樣），外框是 2px 實線、頁面的字色', () => {
    report[`${theme}:focus`] = focus;
    expect(focus.filter((f) => !f.focusVisible).map((f) => f.name)).toEqual([]);
    expect(
      focus
        .filter(
          (f) =>
            !sameShadow(f.shadowBefore, f.shadowAfter) ||
            !sameShadow(f.hostShadowBefore, f.hostShadowAfter),
        )
        .map(
          (f) =>
            `${f.name}：${f.hostShadowBefore} → ${f.hostShadowAfter}；${f.shadowBefore} → ${f.shadowAfter}`,
        ),
    ).toEqual([]);
    expect(
      focus
        .filter(
          (f) =>
            f.outlineStyle !== 'solid' ||
            f.outlineWidth !== '2px' ||
            f.outlineColor !== f.pageColor,
        )
        .map(
          (f) =>
            `${f.name}：${f.outlineStyle} ${f.outlineWidth} ${f.outlineColor}（字色 ${f.pageColor}）`,
        ),
    ).toEqual([]);
  });

  // 只有亮色有上限：暗底上投影要更濃才看得到（同 `shadow-alpha.test.ts`）。暗色不定義這條，不是跳過。
  if (theme === 'light')
    test(`亮色陰影：每層投影的透明度 ≤ ${MAX_SHADOW_ALPHA}（邊緣那一層不算）`, () => {
      const layers = shadows.flatMap((s) =>
        shadowLayers(s.boxShadow)
          .filter((l) => !l.edge && l.color !== undefined)
          .map((l) => ({ name: s.name, alpha: parseColor(l.color ?? '').alpha })),
      );
      report[`${theme}:shadow`] = layers;
      // 量具自檢：Tailwind 清掉的層是全透明的（alpha 0），不算數；看得見的投影要正好落在這幾個元素上，
      // 投影整個消失或搬到別的元素上都紅，不讓「沒量到」看起來像「全部達標」。
      expect(new Set(layers.filter((l) => l.alpha > 0).map((l) => l.name))).toEqual(
        new Set(SHADOWED),
      );
      expect(
        layers.filter((l) => !(l.alpha <= MAX_SHADOW_ALPHA)).map((l) => `${l.name} ${l.alpha}`),
      ).toEqual([]);
    });
});
