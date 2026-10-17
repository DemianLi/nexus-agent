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
 * 1. **焦點**：鍵盤聚焦後 `box-shadow` 看得見的層跟沒聚焦時一樣（不帶 ring），外框是 2px 實線、顏色是頁面的字色（`.docs/web-ui-spec.md`、#1279），
 *    外框對它畫在上面的底色過非文字門檻 {@link NON_TEXT_MIN}（#1468 Q5）。
 * 2. **對比**：每個字的顏色對它實際的底色（往上疊到不透明為止，漸層取最差的停點）過門檻（文字 4.5，`data-guard-min` 另給）。
 * 3. **欄位聚焦**：文字欄位（`Input`、`Textarea`、輸入框群組）鍵盤聚焦後，邊框四邊都是頁面的字色（#1468 Q5 焦點用字色；
 *    SG 畫的是 `--focus-line` 灰線，`solid-glass.overrides.css` 換回來，靜態那一層 `focus-line-suppression.test.ts` 列舉）。
 * 4. **亮色陰影**：每層投影的透明度不超過該元素的上限 {@link SHADOW_LIMITS}（#1468 Q8 外觀照 SG：上限就是 SG 現在的值，誰再調深就紅）。
 *
 * 面有三種狀態（{@link MODES}）：平常的半透明、`prefers-reduced-transparency: reduce`（CDP 模擬）、`<html data-glass="opaque">`。
 * 後兩種是不透明的退路，對比要一樣達標，面也要真的不透明。
 *
 * 量不到的：brand 與 SG 的 `status-*` 這幾個顏色，測試頁上沒有元件不寫 class 就會用到它們（只有 `Counts` 的增刪數用到 success／destructive），
 * 由靜態那一層（`tokens-contrast.test.ts`）量。
 *
 * 跑法：先 `pnpm --filter @nexus/web run build`，再 `pnpm --filter @nexus/web run test:guard`（CI 在 static job 的 build 之後）。
 * 瀏覽器用本機裝的 Chrome（`channel: 'chrome'`），不另外下載。`GUARD_REPORT=<檔案>` 會把量到的數字與瀏覽器版本寫成 JSON。
 */

type Theme = 'light' | 'dark';

/**
 * 亮色時有看得見的投影的元素（`data-guard-shadow`）與各自每層投影的透明度上限。上限是 SG 現在的值（#1512 量到的）：
 * 0.28 是 `--glass-shade`（浮起來的那一層），0.06 是 `--glass-contact`（貼地的那一層）；靜態那一層 `shadow-alpha.test.ts` 釘 token 本身。
 * 投影整個消失、搬到別的元素上、或調深，都紅。
 */
const SHADOW_LIMITS: Record<string, number> = {
  'button-default': 0.28,
  'button-outline': 0.06,
  'button-secondary': 0.06,
  card: 0.28,
  popover: 0.28,
};
const SHADOWED = Object.keys(SHADOW_LIMITS);
const TEXT_MIN = 4.5;
const NON_TEXT_MIN = 3;

type Mode = 'translucent' | 'reduced-transparency' | 'opaque';
const MODES: Mode[] = ['translucent', 'reduced-transparency', 'opaque'];

interface TextSample {
  name: string;
  min: number;
  color: string;
  chain: BackgroundLayer[];
}

interface FocusSample {
  name: string;
  focusVisible: boolean;
  /** 外框畫在上面的那一層往上的底色（外框在元素外面，所以從它的父元素算）。 */
  outlineChain: BackgroundLayer[];
  shadowBefore: string;
  shadowAfter: string;
  hostShadowBefore: string;
  hostShadowAfter: string;
  outlineStyle: string;
  outlineWidth: string;
  outlineColor: string;
  pageColor: string;
}

interface FieldSample {
  name: string;
  focusVisible: boolean;
  /** 上、右、下、左四邊的 `border-*-color`。 */
  borderBefore: string[];
  borderAfter: string[];
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
    // 計算值的字串格式（`oklch()` 還是 `rgb()`、小數位數）跟著瀏覽器版本走，日後格式變了要查得到是哪一版量的。
    report.browser = browser.version();
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

async function open(theme: Theme, mode: Mode = 'translucent'): Promise<Page> {
  if (browser === undefined || server === undefined) throw new Error('瀏覽器或伺服器沒起來');
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  if (mode === 'reduced-transparency') {
    // Playwright 的 emulateMedia 沒有這一項，直接下 CDP。
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
    });
  }
  await page.goto(`${server.url}?theme=${theme}${mode === 'opaque' ? '&glass=opaque' : ''}`);
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
        const outlineChain = [];
        for (let node = host.parentElement; node !== null; node = node.parentElement) {
          const style = getComputedStyle(node);
          outlineChain.push({
            backgroundColor: style.backgroundColor,
            backgroundImage: style.backgroundImage,
          });
        }
        return {
          outlineChain,
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
      outlineChain: after.outlineChain,
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

async function collectFields(page: Page): Promise<FieldSample[]> {
  await page.keyboard.press('Tab');
  const names = await page.$$eval('[data-guard-field]', (els) =>
    els.map((el) => el.getAttribute('data-guard-field') ?? ''),
  );
  const samples: FieldSample[] = [];
  for (const name of names) {
    const target = page.locator(`[data-guard-field="${name}"]`);
    const read = () =>
      target.evaluate((el) => {
        const style = getComputedStyle(el.closest('[data-guard-outline-host]') ?? el);
        return {
          focusVisible: el.matches(':focus-visible'),
          border: [
            style.borderTopColor,
            style.borderRightColor,
            style.borderBottomColor,
            style.borderLeftColor,
          ],
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
      borderBefore: before.border,
      borderAfter: after.border,
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

/** 某個顏色疊在每一個候選底色上的對比，取最差的。 */
function worstOn(color: string, chain: BackgroundLayer[]): { ratio: number; on: string } {
  const fg = parseColor(color);
  return backdrops(chain)
    .map((b) => ({ on: b.label, ratio: contrastRatio(composite(fg, b.rgb), b.rgb) }))
    .reduce((worst, next) => (next.ratio < worst.ratio ? next : worst));
}

const worstContrast = (sample: TextSample) => worstOn(sample.color, sample.chain);

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
  let fields: FieldSample[];
  let shadows: ShadowSample[];

  beforeAll(async () => {
    page = await open(theme);
    texts = await collectTexts(page);
    shadows = await collectShadows(page);
    focus = await collectFocus(page);
    fields = await collectFields(page);
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
    const outlines = focus.map((f) => ({
      name: f.name,
      ...worstOn(f.outlineColor, f.outlineChain),
    }));
    report[`${theme}:focus-outline-contrast`] = outlines.map((o) => ({
      ...o,
      ratio: round(o.ratio),
    }));
    expect(
      outlines
        .filter((o) => !(o.ratio >= NON_TEXT_MIN))
        .map((o) => `${o.name} 外框 ${round(o.ratio)} < ${NON_TEXT_MIN}（${o.on}）`),
    ).toEqual([]);
  });

  test('欄位聚焦：邊框四邊都換成頁面的字色', () => {
    report[`${theme}:fields`] = fields;
    // 量具自檢：三種欄位都量到、真的在 `:focus-visible`，而且聚焦前後邊框有變（量到的是聚焦的樣子，不是平常的邊框）。
    expect(fields.map((f) => f.name).sort()).toEqual(['input', 'input-group', 'textarea']);
    expect(fields.filter((f) => !f.focusVisible).map((f) => f.name)).toEqual([]);
    expect(
      fields
        .filter((f) => JSON.stringify(f.borderBefore) === JSON.stringify(f.borderAfter))
        .map((f) => f.name),
    ).toEqual([]);
    expect(
      fields
        .filter((f) => f.borderAfter.some((c) => c !== f.pageColor))
        .map((f) => `${f.name}：${f.borderAfter.join(' ')}（字色 ${f.pageColor}）`),
    ).toEqual([]);
  });

  // 只有亮色有上限：暗底上投影要更濃才看得到（同 `shadow-alpha.test.ts`）。暗色不定義這條，不是跳過。
  if (theme === 'light')
    test('亮色陰影：每層投影的透明度不超過該元素的上限（邊緣那一層、inset 的高光與凹槽不算）', () => {
      const layers = shadows.flatMap((s) =>
        shadowLayers(s.boxShadow)
          .filter((l) => !l.edge && !l.inset && l.color !== undefined)
          .map((l) => ({ name: s.name, alpha: parseColor(l.color ?? '').alpha })),
      );
      report[`${theme}:shadow`] = layers;
      // 量具自檢：Tailwind 清掉的層是全透明的（alpha 0），不算數；看得見的投影要正好落在這幾個元素上，
      // 投影整個消失或搬到別的元素上都紅，不讓「沒量到」看起來像「全部達標」。
      expect(new Set(layers.filter((l) => l.alpha > 0).map((l) => l.name))).toEqual(
        new Set(SHADOWED),
      );
      expect(
        layers
          .filter((l) => !(l.alpha <= (SHADOW_LIMITS[l.name] ?? 0)))
          .map((l) => `${l.name} ${l.alpha} > ${SHADOW_LIMITS[l.name]}`),
      ).toEqual([]);
    });
});

/** 不透明的兩種退路：面真的不透明、字一樣過門檻。 */
describe.each(
  MODES.filter((m) => m !== 'translucent').flatMap((mode) =>
    (['light', 'dark'] as const).map((theme) => [mode, theme] as const),
  ),
)('瀏覽器量出貨的 CSS：%s、%s', (mode, theme) => {
  let page: Page;
  let texts: TextSample[];
  let surfaces: { name: string; backgroundColor: string; backdropFilter: string }[];

  beforeAll(async () => {
    page = await open(theme, mode);
    texts = await collectTexts(page);
    surfaces = await page.$$eval('[data-guard-surface]', (els) =>
      els.map((el) => {
        const style = getComputedStyle(el);
        return {
          name: el.getAttribute('data-guard-surface') ?? '',
          backgroundColor: style.backgroundColor,
          backdropFilter: style.backdropFilter,
        };
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await page?.close();
  });

  test('面是不透明的、沒有 blur', () => {
    report[`${mode}:${theme}:surfaces`] = surfaces;
    expect(surfaces.map((s) => s.name).sort()).toEqual(['card', 'popover', 'sidebar']);
    expect(
      surfaces
        .filter((s) => parseColor(s.backgroundColor).alpha !== 1 || s.backdropFilter !== 'none')
        .map((s) => `${s.name}：${s.backgroundColor}、backdrop-filter ${s.backdropFilter}`),
    ).toEqual([]);
  });

  test('每個字對它實際的底色過門檻', () => {
    const measured = texts.map((t) => ({ name: t.name, min: t.min, ...worstContrast(t) }));
    report[`${mode}:${theme}:contrast`] = measured.map((m) => ({ ...m, ratio: round(m.ratio) }));
    expect(
      measured
        .filter((m) => !(m.ratio >= m.min))
        .map((m) => `${m.name} ${round(m.ratio)} < ${m.min}（${m.on}）`),
    ).toEqual([]);
  });
});
