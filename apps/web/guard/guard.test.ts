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
 * 量這幾件事，亮暗各一次：
 * 1. **焦點**：鍵盤聚焦後 `box-shadow` 看得見的層跟沒聚焦時一樣（不帶 ring），外框是 2px 實線、顏色是頁面的字色（`.docs/web-ui-spec.md`、#1279），
 *    外框對它畫在上面的底色過非文字門檻 {@link NON_TEXT_MIN}（#1468 Q5）。
 * 2. **對比**：每個字的顏色對它實際的底色（往上疊到不透明為止，漸層取最差的停點）過門檻（文字 4.5，`data-guard-min` 另給）。
 *    量具只疊底色、不算 `opacity`（祖先半透明時字與底整組一起淡掉），所以元素自己或任一祖先的 `opacity` 不是 1 就直接判不合格（#1523：
 *    vendor 的輸入框群組在送出鈕停用時整組 50%，只看色值的量具漏掉了）。字、chip、hover、焦點外框四種都照這條。
 * 3. **欄位聚焦**：文字欄位（`Input`、`Textarea`、輸入框群組）鍵盤聚焦後，邊框四邊都是頁面的字色（#1468 Q5 焦點用字色；
 *    SG 畫的是 `--focus-line` 灰線，`solid-glass.overrides.css` 換回來，靜態那一層 `focus-line-suppression.test.ts` 列舉）。
 * 4. **貼在輸入框上方的卡片是平的**：`Surface tone="docked"` 的邊是 1px、沒有投影（SG 的 `.bg-card` 會把它變成浮起來的卡片，
 *    `solid-glass.overrides.css` 補回來）。
 * 5. **chip 三階**：`data-guard-chip` 裡那顆按鈕平常、滑鼠移上去、按下去三種狀態，字對它實際的底色過門檻。develop 就沒到 4.5 的那幾對
 *    只守「不比 develop 差」（既有缺口 #1515，{@link CHIP_FLOORS}）；warning 用量表平常狀態的字直接疊在頁面上，是狀態色對底色，
 *    守 {@link STATUS_MIN}（同靜態那一層的狀態色門檻）。
 * 6. **對話裡被定位的那一則有圓角**：`[data-located]` 的圓角是 `var(--radius-3xl)`，這個變數只宣告在 SG 的 `@theme inline`；
 *    Tailwind 沒輸出或修剪掉它的話，圓角會靜靜變成 0。量 `border-radius` 不是 0。
 * 7. **亮色陰影**：每層投影的透明度不超過該元素的上限 {@link SHADOW_LIMITS}（#1468 Q8 外觀照 SG：上限就是 SG 現在的值，誰再調深就紅）。
 * 8. **destructive 按鈕的 hover**：平常與滑鼠移上去，字對底色都過 4.5（vendor 的 hover 底太深，覆寫檔調淡，#1523）。
 * 9. **SG 的按鈕規則真的命中 vendor 的 Button**（#1523）：outline、secondary、glass 有 `backdrop-filter`（`solid-glass.css:640-677`
 *    靠 `data-variant`）；Radix 浮層 Trigger 用 asChild 包著、開著的 outline 按鈕，底色換成按下去的樣子（SG 認 `aria-expanded`）。
 * 10. **輸入框群組只在欄位停用時變淡**（#1523 本地修改第 18 條）：只有按鈕停用的群組（輸入框沒字時送出鈕就是停用的）`opacity` 是 1、
 *    底色跟一般的群組相同；欄位停用的照 vendor 是 0.5。
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

/** 往上疊的一層，加上那一層自己的 `opacity`（#1523）：{@link worstOn} 遇到不是 1 的就判不合格，見檔頭第 2 條。 */
type MeasuredLayer = BackgroundLayer & { opacity: string };

/**
 * 亮色時有看得見的投影的元素（`data-guard-shadow`）與各自每層投影的透明度上限。上限是 SG 現在的值（#1512 量到的）：
 * 0.28 是 `--glass-shade`（浮起來的那一層），0.06 是 `--glass-contact`（貼地的那一層）；靜態那一層 `shadow-alpha.test.ts` 釘 token 本身。
 * 投影整個消失、搬到別的元素上、或調深，都紅。
 */
const SHADOW_LIMITS: Record<string, number> = {
  'button-default': 0.28,
  'button-outline': 0.06,
  'button-secondary': 0.06,
  'button-glass': 0.06,
  card: 0.28,
  popover: 0.28,
};
const SHADOWED = Object.keys(SHADOW_LIMITS);
const TEXT_MIN = 4.5;
/** 字樣本一定要量到的幾個（量具自檢）：少了就是頁面沒畫出來或選擇器沒中，對比那條會靜靜變成空的綠。 */
const REQUIRED_TEXTS = [
  'body',
  'input-group-send-hint',
  'button-default',
  'card-title',
  'card-counts-0',
  'card-counts-1',
  'popover',
  'tooltip',
  'sidebar-menu-button',
];
const NON_TEXT_MIN = 3;

type ChipState = 'rest' | 'hover' | 'pressed';
const CHIP_STATES: ChipState[] = ['rest', 'hover', 'pressed'];

/**
 * chip 三階上 develop 就沒到 4.5 的那幾對（既有缺口 #1515）：只守「不比 develop 差」，數字同 `tokens-contrast.test.ts` 的
 * `NOT_WORSE_THAN_DEVELOP`（develop c9b957b6 照同一套算法重算、截到小數第四位）。沒列的一律 {@link TEXT_MIN}。
 */
/**
 * 狀態色對底色的門檻（`.docs/web-ui-spec.md` §5，#1468 Q5）。warning 用量表平常狀態沒有 chip 底，字是 warning 色直接疊在頁面上，
 * 所以守這一條而不是文字的 4.5。不扣靜態那一層的 `ROUNDING`：瀏覽器量的是出貨的值，跟靜態那層對到小數第四位。
 */
const STATUS_MIN = 5.2;
/** chip 三階裡守 {@link STATUS_MIN} 的那幾格。 */
const CHIP_STATUS_ON_PAGE = new Set(['context-meter-warning:rest']);

const CHIP_FLOORS: Record<string, Record<Theme, number>> = {
  'context-meter:pressed': { light: 4.3325, dark: 4.2964 },
  'context-meter-warning:hover': { light: 4.0084, dark: 3.9642 },
  'context-meter-warning:pressed': { light: 3.7081, dark: 3.6952 },
};

type Mode = 'translucent' | 'reduced-transparency' | 'opaque';
const MODES: Mode[] = ['translucent', 'reduced-transparency', 'opaque'];

interface TextSample {
  name: string;
  min: number;
  color: string;
  chain: MeasuredLayer[];
}

interface FocusSample {
  name: string;
  focusVisible: boolean;
  /** 外框畫在上面的那一層往上的底色（外框在元素外面，所以從它的父元素算）。 */
  outlineChain: MeasuredLayer[];
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

interface ChipSample {
  name: string;
  state: ChipState;
  /** 真的在那個狀態（`:hover`／`:active`）。 */
  inState: boolean;
  color: string;
  backgroundColor: string;
  chain: MeasuredLayer[];
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
          opacity: style.opacity,
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
            opacity: style.opacity,
          });
        }
        // 外框是 host 自己畫的，host 的 opacity 也算：前面墊一層透明的底，只帶 opacity。
        outlineChain.unshift({
          backgroundColor: 'rgba(0, 0, 0, 0)',
          backgroundImage: 'none',
          opacity: hostStyle.opacity,
        });
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

async function collectChips(page: Page): Promise<ChipSample[]> {
  const names = await page.$$eval('[data-guard-chip]', (els) =>
    els.map((el) => el.getAttribute('data-guard-chip') ?? ''),
  );
  const samples: ChipSample[] = [];
  for (const name of names) {
    const target = page.locator(`[data-guard-chip="${name}"] button`);
    const read = async (state: ChipState) => {
      await settle(page);
      const measured = await target.evaluate((el, state) => {
        const chain = [];
        for (let node: Element | null = el; node !== null; node = node.parentElement) {
          const style = getComputedStyle(node);
          chain.push({
            backgroundColor: style.backgroundColor,
            backgroundImage: style.backgroundImage,
            opacity: style.opacity,
          });
        }
        const hover = el.matches(':hover');
        const active = el.matches(':active');
        return {
          inState:
            state === 'rest' ? !hover && !active : state === 'hover' ? hover && !active : active,
          color: getComputedStyle(el).color,
          backgroundColor: getComputedStyle(el).backgroundColor,
          chain,
        };
      }, state);
      samples.push({ name, state, ...measured });
    };
    await page.mouse.move(0, 0);
    await read('rest');
    await target.hover();
    await read('hover');
    await page.mouse.down();
    await read('pressed');
    // 游標移開再放開：click 要按下與放開在同一個元素上才會觸發，這樣浮層不會打開。
    await page.mouse.move(0, 0);
    await page.mouse.up();
  }
  await settle(page);
  return samples;
}

interface HoverSample {
  readonly name: string;
  readonly state: 'rest' | 'hover';
  readonly inState: boolean;
  readonly color: string;
  readonly backgroundColor: string;
  readonly chain: MeasuredLayer[];
}

/** `data-guard-hover` 的元素：游標移開與移上去各量一次字色與往上疊的底（#1523）。 */
async function collectHovers(page: Page): Promise<HoverSample[]> {
  const names = await page.$$eval('[data-guard-hover]', (els) =>
    els.map((el) => el.getAttribute('data-guard-hover') ?? ''),
  );
  const samples: HoverSample[] = [];
  for (const name of names) {
    const target = page.locator(`[data-guard-hover="${name}"]`);
    for (const state of ['rest', 'hover'] as const) {
      if (state === 'rest') await page.mouse.move(0, 0);
      else await target.hover();
      await settle(page);
      const measured = await target.evaluate((el) => {
        const chain = [];
        for (let node: Element | null = el; node !== null; node = node.parentElement) {
          const style = getComputedStyle(node);
          chain.push({
            backgroundColor: style.backgroundColor,
            backgroundImage: style.backgroundImage,
            opacity: style.opacity,
          });
        }
        return {
          hover: el.matches(':hover'),
          color: getComputedStyle(el).color,
          backgroundColor: getComputedStyle(el).backgroundColor,
          chain,
        };
      });
      samples.push({
        name,
        state,
        inState: measured.hover === (state === 'hover'),
        color: measured.color,
        backgroundColor: measured.backgroundColor,
        chain: measured.chain,
      });
    }
  }
  await page.mouse.move(0, 0);
  await settle(page);
  return samples;
}

interface ChoiceSample {
  readonly name: string;
  readonly rest: string;
  readonly hover: string;
  readonly hovered: boolean;
  readonly indicator: string;
  readonly opacity: string;
  readonly pointerEvents: string;
  readonly cursor: string;
}

/** 問答的選項：平常與滑鼠移上去的底色、勾選框的底色、停用的樣子（停用的 `pointer-events: none`，移不上去，只量平常）。 */
async function collectChoices(page: Page): Promise<ChoiceSample[]> {
  const names = await page.$$eval('[data-guard-choice]', (els) =>
    els.map((el) => el.getAttribute('data-guard-choice') ?? ''),
  );
  const samples: ChoiceSample[] = [];
  for (const name of names) {
    const target = page.locator(`[data-guard-choice="${name}"]`);
    const read = () =>
      target.evaluate((el) => {
        const style = getComputedStyle(el);
        const indicator = el.querySelector('[data-slot=questionnaire-choice-indicator]');
        return {
          backgroundColor: style.backgroundColor,
          hovered: el.matches(':hover'),
          indicator: indicator === null ? '' : getComputedStyle(indicator).backgroundColor,
          opacity: style.opacity,
          pointerEvents: style.pointerEvents,
          cursor: style.cursor,
        };
      });
    await page.mouse.move(0, 0);
    await settle(page);
    const rest = await read();
    let hover = rest;
    if (name !== 'disabled') {
      await target.hover();
      await settle(page);
      hover = await read();
    }
    samples.push({
      name,
      rest: rest.backgroundColor,
      hover: hover.backgroundColor,
      hovered: hover.hovered,
      indicator: rest.indicator,
      opacity: rest.opacity,
      pointerEvents: rest.pointerEvents,
      cursor: rest.cursor,
    });
  }
  await page.mouse.move(0, 0);
  await settle(page);
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
function worstOn(color: string, chain: MeasuredLayer[]): { ratio: number; on: string } {
  const dimmed = chain.findIndex((layer) => layer.opacity !== '1');
  if (dimmed !== -1) {
    return {
      ratio: 0,
      on: `往上第 ${dimmed} 層的 opacity 是 ${chain[dimmed]!.opacity}，量具不算整組透明度`,
    };
  }
  const fg = parseColor(color);
  return backdrops(chain)
    .map((b) => ({ on: b.label, ratio: contrastRatio(composite(fg, b.rgb), b.rgb) }))
    .reduce((worst, next) => (next.ratio < worst.ratio ? next : worst));
}

const worstContrast = (sample: TextSample) => worstOn(sample.color, sample.chain);

test('量具自檢：往上任一層的 opacity 不是 1 就判不合格，全是 1 才照常算', () => {
  const layer = (backgroundColor: string, opacity = '1') => ({
    backgroundColor,
    backgroundImage: 'none',
    opacity,
  });
  expect(worstOn('rgb(0, 0, 0)', [layer('rgb(255, 255, 255)')]).ratio).toBe(21);
  expect(
    worstOn('rgb(0, 0, 0)', [layer('rgba(0, 0, 0, 0)'), layer('rgb(255, 255, 255)', '0.5')]),
  ).toEqual({ ratio: 0, on: '往上第 1 層的 opacity 是 0.5，量具不算整組透明度' });
});

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * `box-shadow` 裡看得見的層。Tailwind 的 ring／shadow 清掉時留下的是全透明的層（`rgba(0, 0, 0, 0) 0px 0px 0px 0px`），
 * 跟 `none` 畫起來一樣，比的時候拿掉；四個長度全是 0 的層（`ring-0` 留下的，帶著字色但寬 0）也什麼都不畫，同樣拿掉（#1523）。
 * 有寬度、有顏色的 ring 就留著，聚焦前後一比就看得出來。
 */
function visibleShadow(value: string): string[] {
  return shadowLayers(value)
    .filter((l) => !l.empty && (l.color === undefined || parseColor(l.color).alpha > 0))
    .map((l) => l.text);
}

const sameShadow = (a: string, b: string) =>
  JSON.stringify(visibleShadow(a)) === JSON.stringify(visibleShadow(b));

describe.each<Theme>(['light', 'dark'])('瀏覽器量出貨的 CSS：%s', (theme) => {
  let page: Page;
  let texts: TextSample[];
  let focus: FocusSample[];
  let fields: FieldSample[];
  let docked: { borderTopWidth: string; boxShadow: string }[];
  let located: { borderTopLeftRadius: string; backgroundColor: string }[];
  let shadows: ShadowSample[];
  let chips: ChipSample[];
  let choices: ChoiceSample[];
  let hovers: HoverSample[];
  let glass: { name: string; backdropFilter: string }[];
  let expanded: Record<string, { backgroundColor: string; ariaExpanded: string | null }>;
  let groups: Record<string, { opacity: string; backgroundColor: string }>;

  beforeAll(async () => {
    page = await open(theme);
    texts = await collectTexts(page);
    shadows = await collectShadows(page);
    chips = await collectChips(page);
    choices = await collectChoices(page);
    hovers = await collectHovers(page);
    glass = await page.$$eval('[data-guard-glass]', (els) =>
      els.map((el) => ({
        name: el.getAttribute('data-guard-glass') ?? '',
        backdropFilter: getComputedStyle(el).backdropFilter,
      })),
    );
    expanded = Object.fromEntries(
      await page.$$eval('[data-guard-expanded]', (els) =>
        els.map((el) => [
          el.getAttribute('data-guard-expanded') ?? '',
          {
            backgroundColor: getComputedStyle(el).backgroundColor,
            ariaExpanded: el.getAttribute('aria-expanded'),
          },
        ]),
      ),
    );
    groups = Object.fromEntries(
      await page.$$eval('[data-guard-opacity]', (els) =>
        els.map((el) => {
          const style = getComputedStyle(el);
          return [
            el.getAttribute('data-guard-opacity') ?? '',
            { opacity: style.opacity, backgroundColor: style.backgroundColor },
          ];
        }),
      ),
    );
    focus = await collectFocus(page);
    fields = await collectFields(page);
    docked = await page.$$eval('[data-guard-docked]', (els) =>
      els.map((el) => {
        const style = getComputedStyle(el);
        return { borderTopWidth: style.borderTopWidth, boxShadow: style.boxShadow };
      }),
    );
    located = await page.$$eval('[data-guard-located]', (els) =>
      els.map((el) => {
        const style = getComputedStyle(el);
        return {
          borderTopLeftRadius: style.borderTopLeftRadius,
          backgroundColor: style.backgroundColor,
        };
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await page?.close();
  });

  test('量具有抓到東西：每個標了的元素都量到', () => {
    expect(texts.map((t) => t.name)).toEqual(expect.arrayContaining(REQUIRED_TEXTS));
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

  test('chip 三階：平常、滑鼠移上去、按下去，字對它實際的底色過門檻（#1515 那幾對守 develop 的值）', () => {
    const measured = chips.map((c) => {
      const key = `${c.name}:${c.state}`;
      return {
        key,
        ...c,
        min: CHIP_FLOORS[key]?.[theme] ?? (CHIP_STATUS_ON_PAGE.has(key) ? STATUS_MIN : TEXT_MIN),
        ...worstOn(c.color, c.chain),
      };
    });
    report[`${theme}:chips`] = measured.map((m) => ({
      key: m.key,
      min: m.min,
      backgroundColor: m.backgroundColor,
      on: m.on,
      ratio: Math.round(m.ratio * 10000) / 10000,
    }));
    // 量具自檢：兩顆用量表都量到三種狀態、真的在那個狀態，而且三種狀態的底色都不一樣（量到的是 hover／按下的底，不是平常那一層）。
    expect(measured.map((m) => m.key)).toEqual(
      ['context-meter', 'context-meter-warning'].flatMap((name) =>
        CHIP_STATES.map((state) => `${name}:${state}`),
      ),
    );
    expect(measured.filter((m) => !m.inState).map((m) => m.key)).toEqual([]);
    for (const name of ['context-meter', 'context-meter-warning'])
      expect(
        new Set(measured.filter((m) => m.name === name).map((m) => m.backgroundColor)).size,
      ).toBe(3);
    expect(
      measured
        .filter((m) => !(m.ratio >= m.min))
        .map((m) => `${m.key} ${m.ratio.toFixed(4)} < ${m.min}（${m.on}）`),
    ).toEqual([]);
  });

  test('問答的選項：勾選的底蓋得過卡片、移上去不變，勾選框只填勾選的那個，停用的半透明、點不到（shadcn 的 data-* variant，#1523）', () => {
    report[`${theme}:choices`] = choices;
    const by = Object.fromEntries(choices.map((c) => [c.name, c]));
    const { checked, unchecked, disabled } = by;
    expect(Object.keys(by).sort()).toEqual(['checked', 'disabled', 'unchecked']);
    // 量具自檢：真的移上去了。
    expect([checked!.hovered, unchecked!.hovered]).toEqual([true, true]);
    // 勾選的底跟沒勾選的不一樣（data-checked 要蓋得過 SG 的 `.bg-card`），移上去也不變。
    // 沒勾選的移上去今天也不變：`hover:bg-chip-hover` 同樣蓋不過 SG 的 `.bg-card`（② 起就是這樣，不是這裡要守的行為，不斷言）。
    expect(checked!.rest).not.toBe(unchecked!.rest);
    expect(checked!.hover).toBe(checked!.rest);
    // group-data-checked：勾選框只有勾選的那一個填上 primary。
    expect(checked!.indicator).not.toBe(unchecked!.indicator);
    expect([disabled!.opacity, disabled!.pointerEvents, disabled!.cursor]).toEqual([
      '0.5',
      'none',
      'not-allowed',
    ]);
    expect([unchecked!.opacity, unchecked!.pointerEvents]).toEqual(['1', 'auto']);
  });

  test('destructive 按鈕：平常與 hover 的字對底色都過 4.5（hover 底由覆寫檔調淡，#1523 第 17 條）', () => {
    const measured = hovers.map((h) => ({
      key: `${h.name}:${h.state}`,
      ...h,
      ...worstOn(h.color, h.chain),
    }));
    report[`${theme}:hovers`] = measured.map((m) => ({
      key: m.key,
      backgroundColor: m.backgroundColor,
      on: m.on,
      ratio: round(m.ratio),
    }));
    // 量具自檢：兩顆都量到兩種狀態、真的在那個狀態，hover 的底跟平常不一樣（量到的是 hover 那一層）。
    expect(measured.map((m) => m.key)).toEqual(
      ['button-destructive', 'button-destructive-card'].flatMap((n) => [`${n}:rest`, `${n}:hover`]),
    );
    expect(measured.filter((m) => !m.inState).map((m) => m.key)).toEqual([]);
    for (const name of ['button-destructive', 'button-destructive-card'])
      expect(
        new Set(measured.filter((m) => m.name === name).map((m) => m.backgroundColor)).size,
      ).toBe(2);
    expect(
      measured
        .filter((m) => !(m.ratio >= TEXT_MIN))
        .map((m) => `${m.key} ${round(m.ratio)} < ${TEXT_MIN}（${m.on}）`),
    ).toEqual([]);
  });

  test('SG 的玻璃按鈕吃到 SG 的規則：outline、secondary、glass 都有 backdrop-filter（data-variant 命中 solid-glass.css:640-677，#1523）', () => {
    report[`${theme}:glass`] = glass;
    expect(glass.map((g) => g.name).sort()).toEqual(['glass', 'outline', 'secondary']);
    expect(glass.filter((g) => g.backdropFilter === 'none').map((g) => g.name)).toEqual([]);
  });

  test('混合期：Radix Trigger（asChild）包的 outline 按鈕開著時，SG 靠 aria-expanded 換成按下去的底色（#1523）', () => {
    report[`${theme}:expanded`] = expanded;
    expect(expanded.trigger?.ariaExpanded).toBe('true');
    expect(expanded.reference?.ariaExpanded).toBeNull();
    expect(expanded.trigger?.backgroundColor).not.toBe(expanded.reference?.backgroundColor);
  });

  test('輸入框群組只在欄位停用時變淡：只有送出鈕停用的不透明、底色跟一般的一樣，欄位停用的是 0.5（#1523 第 18 條）', () => {
    report[`${theme}:input-group-opacity`] = groups;
    expect(Object.keys(groups).sort()).toEqual(['control-disabled', 'reference', 'send-disabled']);
    expect(groups['send-disabled']).toEqual(groups.reference);
    expect(groups.reference!.opacity).toBe('1');
    expect(groups['control-disabled']!.opacity).toBe('0.5');
  });

  test('對話裡被定位的那一則：圓角真的畫出來（--radius-3xl 有宣告），底色換成 chip', () => {
    report[`${theme}:located`] = located;
    expect(located).toHaveLength(1);
    const [only] = located;
    // 量具自檢：規則真的套上了（底色不是透明），圓角是 0 才算數，不是整條規則沒中。
    expect(parseColor(only!.backgroundColor).alpha).toBeGreaterThan(0);
    expect(Number.parseFloat(only!.borderTopLeftRadius)).toBeGreaterThan(0);
  });

  test('貼在輸入框上方的卡片是平的：邊 1px、沒有投影', () => {
    report[`${theme}:docked`] = docked;
    expect(docked).toEqual([{ borderTopWidth: '1px', boxShadow: 'none' }]);
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
    // 量具自檢：不透明的頁面也真的量到字，不然下面那條在空陣列上會綠。
    expect(texts.map((t) => t.name)).toEqual(expect.arrayContaining(REQUIRED_TEXTS));
    const measured = texts.map((t) => ({ name: t.name, min: t.min, ...worstContrast(t) }));
    report[`${mode}:${theme}:contrast`] = measured.map((m) => ({ ...m, ratio: round(m.ratio) }));
    expect(
      measured
        .filter((m) => !(m.ratio >= m.min))
        .map((m) => `${m.name} ${round(m.ratio)} < ${m.min}（${m.on}）`),
    ).toEqual([]);
  });
});
