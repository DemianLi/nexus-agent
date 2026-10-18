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
 * 5. **chip 三階**：`data-guard-chip` 裡那顆按鈕平常、滑鼠移上去、清單開著三種狀態，字對它實際的底色過門檻。#1591 起量的是輸入框
 *    底列的 Pick（12px 次要字，4.5）；權限「全開」那顆是警示色直接疊在頁面上，是狀態色對底色，守 {@link STATUS_MIN}（同靜態那一層
 *    的狀態色門檻）。#1591 之前量的是用量表的 chip（既有缺口 #1515 那幾對守 develop 的值），換成用量環之後沒有字了。
 * 6. **對話裡被定位的那一則有圓角**：`[data-located]` 的圓角是 `var(--radius-3xl)`，這個變數只宣告在 SG 的 `@theme inline`；
 *    Tailwind 沒輸出或修剪掉它的話，圓角會靜靜變成 0。量 `border-radius` 不是 0。
 * 7. **亮色陰影**：每層投影的透明度不超過該元素的上限 {@link SHADOW_LIMITS}（#1468 Q8 外觀照 SG：上限就是 SG 現在的值，誰再調深就紅）。
 * 8. **destructive 按鈕的 hover**：平常與滑鼠移上去，字對底色都過 4.5（vendor 的 hover 底太深，覆寫檔調淡，#1523）。
 * 9. **SG 的按鈕規則真的命中 vendor 的 Button**（#1523）：outline、secondary、glass 有 `backdrop-filter`（`solid-glass.css:640-677`
 *    靠 `data-variant`）；浮層 Trigger 用 `render` 接的、開著的 outline 按鈕，底色換成按下去的樣子（SG 認 `aria-expanded`）。
 * 10. **輸入框群組只在欄位停用時變淡**（#1523 本地修改第 18 條）：只有按鈕停用的群組（輸入框沒字時送出鈕就是停用的）`opacity` 是 1、
 *    底色跟一般的群組相同；欄位停用的照 vendor 是 0.5。
 * 11. **modal 浮層**（#1583，`?overlay=`，見 {@link OVERLAYS}）：dialog、sheet 的關閉鈕焦點、標題與說明的對比、陰影上限；手機側欄的抽屜
 *    沒有邊（本地修改第 21 條）；不透明的退路下面與遮罩都沒有 blur（第 22 條）；呼叫端的寬度跟 develop 一樣；reduced-motion 下
 *    sheet 與手機側欄的抽屜不位移、時長 ≤ 150ms（第 23 條）。alert-dialog 的兩顆按鈕（footer 底帶上）的焦點與對比；下拉選單的選項
 *    （平常與 highlighted）對比、觸控高度（第 25 條）、「⋯」開著時看得見；command 清單的選項（選中與沒選中）對比、只有一顆勾（第 27 條）、
 *    搜尋框的焦點外框畫在群組上（第 15 條的擴充）；鍵盤 Enter 打開選單、在選項上按 Enter 觸發（驗收 D）。
 * 12. **輸入框的底列**（#1591 PR 2）：三顆 Pick 與用量環的焦點；Pick 的 12px 次要字（含兩種退路）；環三個色階是 status token、
 *    過 3:1（第 37 條）；「全開」的警示色（第 35 條）；鎖住的樣子（第 39 條）；清單開著時選項的字與高度（第 25 條擴充）；環的明細；
 *    reduced-motion 下弧長不走 transition（第 38 條）；375 寬 44px、不溢出、不重疊（第 36、40 條）。
 * 13. **展開收合**（#1638 PR A，`?overlay=collapsibles`）：展開途中的高度介於 0 與最終值之間（Q1：keyframes 讀 Base UI 的
 *    `--collapsible-panel-height`，Panel 的 `data-open:` 命中動效）；reduced-motion 下沒有高度動效、第一幀就到位；箭頭跟著 Trigger 的
 *    `data-panel-open` 轉半圈、思考過程展開後藏「·」與摘要（Q2）。
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

/** `open`：清單開著（`aria-expanded`）。Pick 是選單的 Trigger，按下去就打開清單，量不到單純「按著」的樣子（#1591）。 */
type ChipState = 'rest' | 'hover' | 'open';
const CHIP_STATES: ChipState[] = ['rest', 'hover', 'open'];

/**
 * 狀態色對底色的門檻（`.docs/web-ui-spec.md` §5，#1468 Q5）。權限「全開」的 Pick 沒有 chip 底，字是 warning 色直接疊在頁面上，
 * 所以守這一條而不是文字的 4.5。不扣靜態那一層的 `ROUNDING`：瀏覽器量的是出貨的值，跟靜態那層對到小數第四位。
 */
const STATUS_MIN = 5.2;
/**
 * chip 三階裡的狀態色：權限「全開」的 Pick 平常與滑鼠移上去是警示色（本地修改第 35 條），守 {@link STATUS_MIN}。清單開著時
 * 換回字色（開著的底上警示色不到 4.5），守文字的 4.5。
 */
const CHIP_STATUS = new Set(['pick-danger:rest', 'pick-danger:hover']);

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
        const open = el.getAttribute('aria-expanded') === 'true';
        return {
          inState: state === 'rest' ? !hover && !open : state === 'hover' ? hover && !open : open,
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
    await target.click();
    await page.waitForSelector('[role="menu"]');
    await page.mouse.move(0, 0);
    await read('open');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[role="menu"]', { state: 'detached' });
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

/** 鍵盤焦點：box-shadow 不帶 ring（跟沒聚焦時一樣），外框是 2px 實線、頁面的字色，外框對底色過 {@link NON_TEXT_MIN}。 */
function expectFocus(focus: FocusSample[], key: string): void {
  report[`${key}:focus`] = focus;
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
          f.outlineStyle !== 'solid' || f.outlineWidth !== '2px' || f.outlineColor !== f.pageColor,
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
  report[`${key}:focus-outline-contrast`] = outlines.map((o) => ({
    ...o,
    ratio: round(o.ratio),
  }));
  expect(
    outlines
      .filter((o) => !(o.ratio >= NON_TEXT_MIN))
      .map((o) => `${o.name} 外框 ${round(o.ratio)} < ${NON_TEXT_MIN}（${o.on}）`),
  ).toEqual([]);
}

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
  let expanded: Record<
    string,
    { backgroundColor: string; ariaExpanded: string | null; popupOpen: boolean }
  >;
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
            popupOpen: el.hasAttribute('data-popup-open'),
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
    expectFocus(focus, theme);
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

  test('chip 三階：輸入框底列的 Pick 平常、滑鼠移上去、清單開著，12px 的次要字過 4.5；「全開」平常與移上去是警示色、清單開著換回字色（#1591）', () => {
    const measured = chips.map((c) => ({
      key: `${c.name}:${c.state}`,
      ...c,
      min: CHIP_STATUS.has(`${c.name}:${c.state}`) ? STATUS_MIN : TEXT_MIN,
      ...worstOn(c.color, c.chain),
    }));
    report[`${theme}:chips`] = measured.map((m) => ({
      key: m.key,
      min: m.min,
      color: m.color,
      backgroundColor: m.backgroundColor,
      on: m.on,
      ratio: Math.round(m.ratio * 10000) / 10000,
    }));
    // 量具自檢：兩顆 Pick 都量到三種狀態、真的在那個狀態。
    expect(measured.map((m) => m.key)).toEqual(
      ['pick', 'pick-danger'].flatMap((name) => CHIP_STATES.map((state) => `${name}:${state}`)),
    );
    expect(measured.filter((m) => !m.inState).map((m) => m.key)).toEqual([]);
    // 一般的 Pick 移上去換成字色（vendor 的 `hover:text-foreground`，量具自檢：量到的確實是 hover）；「全開」那顆平常與移上去
    // 是同一個警示色，跟一般那顆的次要色、字色都不同（拿掉覆寫檔第 35 條，它會跟一般那顆一樣）；開著時跟一般那顆一樣是字色。
    const color = (key: string) => measured.find((m) => m.key === key)?.color;
    expect(color('pick:hover')).not.toBe(color('pick:rest'));
    expect(color('pick-danger:hover')).toBe(color('pick-danger:rest'));
    expect(color('pick-danger:rest')).not.toBe(color('pick:rest'));
    expect(color('pick-danger:rest')).not.toBe(color('pick:hover'));
    expect(color('pick-danger:open')).toBe(color('pick:open'));
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

  test('浮層 Trigger（render 接 Base UI 的 Button）開著時掛 data-popup-open 與 aria-expanded，SG 換成按下去的底色（#1523、#1583）', () => {
    report[`${theme}:expanded`] = expanded;
    expect(expanded.trigger?.ariaExpanded).toBe('true');
    expect(expanded.trigger?.popupOpen).toBe(true);
    expect(expanded.reference?.ariaExpanded).toBeNull();
    expect(expanded.reference?.popupOpen).toBe(false);
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
    expect(surfaces.map((s) => s.name).sort()).toEqual(['card', 'popover', 'sidebar', 'tooltip']);
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

/**
 * modal 浮層（#1583）：每個浮層自己開一頁（`?overlay=<名字>`），modal 會把其他部分設成 inert，跟主頁放不到一起。
 * `viewport` 給手機側欄用（`useIsMobile` 的斷點是 1024），`marks` 把屬性補到 vendor 自己畫的元素上（關閉鈕、遮罩、抽屜）。
 */
interface Overlay {
  name: string;
  viewport?: { width: number; height: number };
  marks: Record<string, Record<string, string>>;
  /** 補完屬性之後、量之前要做的操作（例如滑鼠移到選項上，讓它變成 highlighted）。 */
  prepare?: (page: Page) => Promise<void>;
  /** 一定要量到的字、焦點、面、遮罩（量具自檢）。 */
  texts: string[];
  focus: string[];
  surfaces: string[];
  backdrops: string[];
}

const OVERLAYS: Overlay[] = [
  {
    name: 'dialog',
    marks: {
      '[data-slot="dialog-close"], [data-slot="dialog-footer"] button': {
        'data-guard-focus': 'dialog-close',
      },
      '[data-slot="dialog-overlay"]': { 'data-guard-backdrop': 'dialog-overlay' },
    },
    texts: ['dialog-title', 'dialog-description'],
    focus: ['dialog-close-0', 'dialog-close-1'],
    surfaces: ['dialog'],
    backdrops: ['dialog-overlay'],
  },
  {
    name: 'sheet',
    marks: {
      '[data-slot="sheet-close"]': { 'data-guard-focus': 'sheet-close' },
      '[data-slot="sheet-overlay"]': { 'data-guard-backdrop': 'sheet-overlay' },
    },
    texts: ['sheet-title', 'sheet-description'],
    focus: ['sheet-close-0'],
    surfaces: ['sheet'],
    backdrops: ['sheet-overlay'],
  },
  {
    name: 'mobile-sidebar',
    viewport: { width: 375, height: 812 },
    marks: {
      '[data-slot="sidebar"][data-mobile="true"]': {
        'data-guard-shadow': 'mobile-sidebar',
        'data-guard-border': 'mobile-sidebar',
        'data-guard-width': 'mobile-sidebar',
        'data-guard-motion': 'mobile-sidebar',
        'data-guard-surface': 'mobile-sidebar',
        'data-guard-text': 'mobile-sidebar',
      },
      '[data-slot="sheet-overlay"]': { 'data-guard-backdrop': 'mobile-sidebar-overlay' },
    },
    texts: ['mobile-sidebar'],
    focus: [],
    surfaces: ['mobile-sidebar'],
    backdrops: ['mobile-sidebar-overlay'],
  },
  {
    name: 'alert-dialog',
    marks: {
      '[data-slot="alert-dialog-overlay"]': { 'data-guard-backdrop': 'alert-dialog-overlay' },
    },
    texts: [
      'alert-dialog-title',
      'alert-dialog-description',
      'alert-dialog-cancel',
      'alert-dialog-action',
    ],
    focus: ['alert-dialog-cancel', 'alert-dialog-action'],
    surfaces: ['alert-dialog'],
    backdrops: ['alert-dialog-overlay'],
  },
  {
    name: 'dropdown',
    marks: {},
    // 滑鼠移到第二項上，它掛 `data-highlighted`（Base UI），量 highlighted 的底色。
    prepare: async (page) => {
      await page.hover('[data-guard-text="dropdown-item-highlighted"]');
      await settle(page);
    },
    texts: ['dropdown-item', 'dropdown-item-highlighted'],
    focus: [],
    surfaces: ['dropdown'],
    backdrops: [],
  },
  {
    name: 'command',
    marks: {
      '[data-slot="command-input"]': { 'data-guard-focus': 'command-input' },
      '[data-slot="command-input-wrapper"] [data-slot="input-group"]': {
        'data-guard-outline-host': '',
      },
      '[data-slot="command-item"][data-selected="true"]': {
        'data-guard-text': 'command-item-selected',
      },
      '[data-slot="command-item"]:not([data-selected="true"])': {
        'data-guard-text': 'command-item',
      },
      '[data-slot="command-item"][data-checked="true"]': { 'data-guard-checks': 'checked' },
      '[data-slot="popover-content"]': { 'data-guard-surface': 'command' },
    },
    texts: ['command-item-selected', 'command-item'],
    focus: ['command-input-0'],
    surfaces: ['command'],
    backdrops: [],
  },
];

/** 亮色時 modal 浮層每層投影的透明度上限：SG 現在的值（#1583 量到的），規則同 {@link SHADOW_LIMITS}。 */
const OVERLAY_SHADOW_LIMITS: Record<string, number> = {
  dialog: 0.28,
  sheet: 0.28,
  'mobile-sidebar': 0.1,
  'alert-dialog': 0.28,
  dropdown: 0.28,
};

/**
 * 呼叫端的寬度（#1583 PM 決定第 4 點）：跟 develop 畫出來的一樣。回饋框 develop 是窄螢幕 28rem、640 以上 32rem
 * （`max-w-md` 加 registry 的 `sm:max-w-lg`）；手機側欄是 `--sidebar-width` 的 18rem（SG 的 `w-3/4` 不能蓋掉它）。
 */
const WIDTHS: {
  overlay: string;
  viewport: { width: number; height: number };
  mark: string;
  px: number;
}[] = [
  { overlay: 'feedback', viewport: { width: 1280, height: 1000 }, mark: 'feedback', px: 512 },
  { overlay: 'feedback', viewport: { width: 600, height: 1000 }, mark: 'feedback', px: 448 },
  {
    overlay: 'mobile-sidebar',
    viewport: { width: 375, height: 812 },
    mark: 'mobile-sidebar',
    px: 288,
  },
];
const WIDTH_MARKS: Record<string, Record<string, Record<string, string>>> = {
  feedback: { '[data-slot="dialog-content"]': { 'data-guard-width': 'feedback' } },
  'mobile-sidebar': OVERLAYS.find((o) => o.name === 'mobile-sidebar')!.marks,
};

async function openOverlay(
  name: string,
  theme: Theme,
  options: {
    mode?: Mode;
    viewport?: { width: number; height: number };
    reducedMotion?: boolean;
    marks: Record<string, Record<string, string>>;
    prepare?: (page: Page) => Promise<void>;
  },
): Promise<Page> {
  if (browser === undefined || server === undefined) throw new Error('瀏覽器或伺服器沒起來');
  const mode = options.mode ?? 'translucent';
  const page = await browser.newPage({
    viewport: options.viewport ?? { width: 1280, height: 1000 },
  });
  if (options.reducedMotion === true) await page.emulateMedia({ reducedMotion: 'reduce' });
  if (mode === 'reduced-transparency') {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
    });
  }
  await page.goto(
    `${server.url}?theme=${theme}&overlay=${name}${mode === 'opaque' ? '&glass=opaque' : ''}`,
  );
  const selectors = Object.keys(options.marks);
  await Promise.all(selectors.map((selector) => page.waitForSelector(selector)));
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await settle(page);
  // 同一個選擇器命中多個（dialog 的兩顆關閉鈕）時，名字後面接序號。
  await page.evaluate((marks) => {
    for (const [selector, attributes] of Object.entries(marks)) {
      const els = [...document.querySelectorAll(selector)];
      els.forEach((el, i) => {
        for (const [attribute, value] of Object.entries(attributes)) {
          const suffix = attribute === 'data-guard-focus' ? `-${i}` : '';
          el.setAttribute(attribute, `${value}${suffix}`);
        }
      });
    }
  }, options.marks);
  await options.prepare?.(page);
  return page;
}

function collectBackdrops(page: Page): Promise<{ name: string; backdropFilter: string }[]> {
  return page.$$eval('[data-guard-backdrop]', (els) =>
    els.map((el) => ({
      name: el.getAttribute('data-guard-backdrop') ?? '',
      backdropFilter: getComputedStyle(el).backdropFilter,
    })),
  );
}

function collectSurfaces(
  page: Page,
): Promise<{ name: string; backgroundColor: string; backdropFilter: string }[]> {
  return page.$$eval('[data-guard-surface]', (els) =>
    els.map((el) => {
      const style = getComputedStyle(el);
      return {
        name: el.getAttribute('data-guard-surface') ?? '',
        backgroundColor: style.backgroundColor,
        backdropFilter: style.backdropFilter,
      };
    }),
  );
}

function expectTexts(texts: TextSample[], required: string[], key: string): void {
  // 量具自檢：該量的字都量到了，不然下面那條在空陣列上會綠。
  expect(texts.map((t) => t.name)).toEqual(expect.arrayContaining(required));
  const measured = texts.map((t) => ({ name: t.name, min: t.min, ...worstContrast(t) }));
  report[`${key}:contrast`] = measured.map((m) => ({ ...m, ratio: round(m.ratio) }));
  expect(
    measured
      .filter((m) => !(m.ratio >= m.min))
      .map((m) => `${m.name} ${round(m.ratio)} < ${m.min}（${m.on}）`),
  ).toEqual([]);
}

describe.each(
  OVERLAYS.flatMap((overlay) =>
    (['light', 'dark'] as const).map((theme) => [overlay.name, theme, overlay] as const),
  ),
)('瀏覽器量 modal 浮層（#1583）：%s、%s', (_name, theme, overlay) => {
  const key = `${overlay.name}:${theme}`;
  let page: Page;
  let texts: TextSample[];
  let focus: FocusSample[];
  let shadows: ShadowSample[];
  let backdrops: { name: string; backdropFilter: string }[];
  let borders: { name: string; widths: string[] }[];
  let rows: { name: string; backgroundColor: string; highlighted: boolean; selected: boolean }[];
  let shown: Record<string, string>;
  let checks: { name: string; visible: string[]; hidden: number }[];

  beforeAll(async () => {
    page = await openOverlay(overlay.name, theme, {
      ...(overlay.viewport === undefined ? {} : { viewport: overlay.viewport }),
      marks: overlay.marks,
      ...(overlay.prepare === undefined ? {} : { prepare: overlay.prepare }),
    });
    texts = await collectTexts(page);
    rows = await page.$$eval(
      '[data-guard-text^="dropdown-item"], [data-guard-text^="command-item"]',
      (els) =>
        els.map((el) => ({
          name: el.getAttribute('data-guard-text') ?? '',
          backgroundColor: getComputedStyle(el).backgroundColor,
          highlighted: el.hasAttribute('data-highlighted'),
          selected: el.getAttribute('data-selected') === 'true',
        })),
    );
    shown = Object.fromEntries(
      await page.$$eval('[data-guard-shown]', (els) =>
        els.map((el) => [el.getAttribute('data-guard-shown') ?? '', getComputedStyle(el).opacity]),
      ),
    );
    checks = await page.$$eval('[data-guard-checks]', (els) =>
      els.map((el) => {
        const svgs = [...el.querySelectorAll('svg')];
        const isVisible = (svg: Element) => {
          const box = svg.getBoundingClientRect();
          return getComputedStyle(svg).display !== 'none' && box.width > 0 && box.height > 0;
        };
        return {
          name: el.getAttribute('data-guard-checks') ?? '',
          visible: svgs.filter(isVisible).map((svg) => svg.getAttribute('aria-label') ?? ''),
          hidden: svgs.filter((svg) => !isVisible(svg)).length,
        };
      }),
    );
    shadows = await collectShadows(page);
    backdrops = await collectBackdrops(page);
    borders = await page.$$eval('[data-guard-border]', (els) =>
      els.map((el) => {
        const style = getComputedStyle(el);
        return {
          name: el.getAttribute('data-guard-border') ?? '',
          widths: [
            style.borderTopWidth,
            style.borderRightWidth,
            style.borderBottomWidth,
            style.borderLeftWidth,
          ],
        };
      }),
    );
    focus = await collectFocus(page);
  }, 60_000);

  afterAll(async () => {
    await page?.close();
  });

  test('字對它實際的底色過門檻', () => {
    expectTexts(texts, overlay.texts, key);
  });

  if (overlay.focus.length > 0)
    test('鍵盤焦點（關閉鈕、確認框的按鈕、搜尋框）：不帶 ring，外框是 2px 實線、頁面的字色', () => {
      expect(focus.map((f) => f.name).sort()).toEqual([...overlay.focus].sort());
      expectFocus(focus, key);
    });

  if (overlay.backdrops.length > 0)
    test('遮罩照 SG 有 blur（量具自檢：不透明的退路那邊量到 none 才算數）', () => {
      report[`${key}:backdrops`] = backdrops;
      expect(backdrops.map((b) => b.name)).toEqual(overlay.backdrops);
      expect(backdrops.filter((b) => b.backdropFilter === 'none').map((b) => b.name)).toEqual([]);
    });

  if (overlay.name === 'dropdown') {
    test('滑鼠移上去的選項掛 data-highlighted、底色跟平常的不同（量具自檢：上面量的確實是兩種狀態）', () => {
      report[`${key}:rows`] = rows;
      expect(rows.map((r) => [r.name, r.highlighted])).toEqual([
        ['dropdown-item', false],
        ['dropdown-item-highlighted', true],
      ]);
      expect(rows[0]!.backgroundColor).not.toBe(rows[1]!.backgroundColor);
    });

    test('「⋯」選單開著時看得見（Trigger 開著掛 data-popup-open，ui/sidebar.tsx 的 SidebarMenuAction）', () => {
      report[`${key}:shown`] = shown;
      // 量具自檢：lg 寬度下沒開的「⋯」照樣藏著（滑過那一列才現身）。
      expect(shown).toEqual({ open: '1', closed: '0' });
    });
  }

  if (overlay.name === 'command') {
    test('選中與沒選中的選項底色不同（量具自檢：上面量的確實是兩種狀態）', () => {
      report[`${key}:rows`] = rows;
      const selected = rows.filter((r) => r.selected);
      expect(selected.map((r) => r.name)).toEqual(['command-item-selected']);
      expect(rows.filter((r) => !r.selected).length).toBeGreaterThan(0);
      expect(
        rows.filter((r) => !r.selected && r.backgroundColor === selected[0]!.backgroundColor),
      ).toEqual([]);
    });

    test('勾選的那一列只有一顆看得見的勾，報讀名稱是「目前選的」（vendor 附的那顆藏掉，本地修改第 27 條）', () => {
      report[`${key}:checks`] = checks;
      // 量具自檢：vendor 那顆確實在 DOM 裡、只是看不見。
      expect(checks).toEqual([{ name: 'checked', visible: ['目前選的'], hidden: 1 }]);
    });
  }

  if (overlay.name === 'mobile-sidebar')
    test('手機側欄的抽屜只留陰影、四邊都沒有邊（本地修改第 21 條）', () => {
      report[`${key}:borders`] = borders;
      expect(borders).toEqual([{ name: 'mobile-sidebar', widths: ['0px', '0px', '0px', '0px'] }]);
    });

  if (theme === 'light' && overlay.name in OVERLAY_SHADOW_LIMITS)
    test('亮色陰影：每層投影的透明度不超過上限', () => {
      const layers = shadows.flatMap((s) =>
        shadowLayers(s.boxShadow)
          .filter((l) => !l.edge && !l.inset && l.color !== undefined)
          .map((l) => ({ name: s.name, alpha: parseColor(l.color ?? '').alpha })),
      );
      report[`${key}:shadow`] = layers;
      // 量具自檢：這個浮層真的有看得見的投影。
      expect(new Set(layers.filter((l) => l.alpha > 0).map((l) => l.name))).toEqual(
        new Set([overlay.name]),
      );
      expect(
        layers
          .filter((l) => !(l.alpha <= (OVERLAY_SHADOW_LIMITS[l.name] ?? 0)))
          .map((l) => `${l.name} ${l.alpha} > ${OVERLAY_SHADOW_LIMITS[l.name]}`),
      ).toEqual([]);
    });
});

/** modal 浮層在不透明的兩種退路下：面不透明、面與遮罩都沒有 blur（本地修改第 22 條）、字照樣過門檻。 */
describe.each(
  MODES.filter((m) => m !== 'translucent').flatMap((mode) =>
    OVERLAYS.flatMap((overlay) =>
      (['light', 'dark'] as const).map((theme) => [mode, overlay.name, theme, overlay] as const),
    ),
  ),
)('瀏覽器量 modal 浮層（#1583）：%s、%s、%s', (mode, _name, theme, overlay) => {
  const key = `${mode}:${overlay.name}:${theme}`;
  let page: Page;
  let texts: TextSample[];
  let surfaces: { name: string; backgroundColor: string; backdropFilter: string }[];
  let backdrops: { name: string; backdropFilter: string }[];

  beforeAll(async () => {
    page = await openOverlay(overlay.name, theme, {
      mode,
      ...(overlay.viewport === undefined ? {} : { viewport: overlay.viewport }),
      marks: overlay.marks,
      ...(overlay.prepare === undefined ? {} : { prepare: overlay.prepare }),
    });
    texts = await collectTexts(page);
    surfaces = await collectSurfaces(page);
    backdrops = await collectBackdrops(page);
  }, 60_000);

  afterAll(async () => {
    await page?.close();
  });

  test('面不透明、面與遮罩都沒有 blur', () => {
    report[`${key}:surfaces`] = surfaces;
    report[`${key}:backdrops`] = backdrops;
    expect(surfaces.map((s) => s.name)).toEqual(overlay.surfaces);
    expect(backdrops.map((b) => b.name)).toEqual(overlay.backdrops);
    expect(
      surfaces
        .filter((s) => parseColor(s.backgroundColor).alpha !== 1 || s.backdropFilter !== 'none')
        .map((s) => `${s.name}：${s.backgroundColor}、backdrop-filter ${s.backdropFilter}`),
    ).toEqual([]);
    expect(backdrops.filter((b) => b.backdropFilter !== 'none').map((b) => b.name)).toEqual([]);
  });

  test('字對它實際的底色過門檻', () => {
    expectTexts(texts, overlay.texts, key);
  });
});

describe('瀏覽器量 modal 浮層的版面與動效（#1583）', () => {
  test.each(WIDTHS)(
    '呼叫端的寬度：$overlay 在 $viewport.width 寬是 $px px',
    async ({ overlay, viewport, mark, px }) => {
      const page = await openOverlay(overlay, 'light', { viewport, marks: WIDTH_MARKS[overlay]! });
      try {
        const width = await page.$eval(
          `[data-guard-width="${mark}"]`,
          (el) => el.getBoundingClientRect().width,
        );
        report[`width:${overlay}:${viewport.width}`] = width;
        expect(width).toBe(px);
      } finally {
        await page.close();
      }
    },
  );

  test.each(['sheet', 'mobile-sidebar'])(
    'reduced-motion 下 %s 的抽屜不位移、transition 時長 ≤ 150ms（本地修改第 23 條）',
    async (name) => {
      const overlay = OVERLAYS.find((o) => o.name === name)!;
      const marks =
        name === 'sheet'
          ? { ...overlay.marks, '[data-slot="sheet-content"]': { 'data-guard-motion': 'sheet' } }
          : overlay.marks;
      const read = async (reducedMotion: boolean) => {
        const page = await openOverlay(name, 'light', {
          ...(overlay.viewport === undefined ? {} : { viewport: overlay.viewport }),
          reducedMotion,
          marks,
        });
        try {
          // 位移只寫在 `data-ending-style`／`data-starting-style` 上（開好之後本來就是 none），掛上那個屬性再量才看得到；
          // 掛的當下 transition 才剛開始，計算值是起點，所以先把 transition 關掉再量目標位移。時長在關掉之前讀。
          return await page.$eval('[data-guard-motion]', (el) => {
            const target = el as HTMLElement;
            const transitionDuration = getComputedStyle(target).transitionDuration;
            target.style.transition = 'none';
            target.setAttribute('data-ending-style', '');
            const translate = getComputedStyle(target).translate;
            target.removeAttribute('data-ending-style');
            target.style.transition = '';
            return { translate, transitionDuration };
          });
        } finally {
          await page.close();
        }
      };
      const normal = await read(false);
      const reduced = await read(true);
      report[`motion:${name}`] = { normal, reduced };
      // 量具自檢：平常是 SG 的 200ms、離場時位移 2.5rem，量到的確實是那條 transition。
      expect(normal.transitionDuration).toBe('0.2s');
      expect(normal.translate).toBe(name === 'sheet' ? '40px' : '-40px');
      expect(reduced.translate).toBe('none');
      expect(Number.parseFloat(reduced.transitionDuration)).toBeLessThanOrEqual(0.15);
    },
  );

  test.each([
    { width: 375, px: 44 },
    { width: 1280, px: 32 },
  ])(
    '下拉選單的選項在 $width 寬是 $px px 高（觸控高度，本地修改第 25 條）',
    async ({ width, px }) => {
      const page = await openOverlay('dropdown', 'light', {
        viewport: { width, height: 812 },
        marks: {},
      });
      try {
        const height = await page.$eval(
          '[data-guard-height="dropdown-item"]',
          (el) => el.getBoundingClientRect().height,
        );
        report[`height:dropdown-item:${width}`] = height;
        expect(height).toBe(px);
      } finally {
        await page.close();
      }
    },
  );

  test('鍵盤：Trigger 上按 Enter 打開選單，選項上按 Enter 觸發、選單收起（驗收 D）', async () => {
    const page = await openOverlay('dropdown-keyboard', 'light', { marks: {} });
    try {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('開選單');
      expect(await page.$('[role="menu"]')).toBeNull();
      await page.keyboard.press('Enter');
      await page.waitForSelector('[role="menu"]');
      // 鍵盤打開時 Base UI 把第一項設成 highlighted；往下一項再按 Enter。
      await page.keyboard.press('ArrowDown');
      const highlighted = await page.$eval(
        '[role="menuitem"][data-highlighted]',
        (el) => el.textContent,
      );
      await page.keyboard.press('Enter');
      await page.waitForSelector('[role="menu"]', { state: 'detached' });
      const picked = await page.$eval('[data-guard-picked]', (el) =>
        el.getAttribute('data-guard-picked'),
      );
      report['keyboard:dropdown'] = { highlighted, picked };
      expect(picked).toBe(highlighted);
      expect(picked).not.toBe('');
    } finally {
      await page.close();
    }
  });
});

/**
 * 輸入框（SG 的 `Composer`，#1591 驗收 D）。vendor 自己畫的 textarea、主按鈕掛不了屬性，開頁後補（同 modal 浮層）。
 * 主按鈕停用時（閒著、草稿空）不量焦點與對比：停用的控制項不在 WCAG 的對比門檻裡，也聚焦不到。
 */
const COMPOSER_STATES = ['idle', 'draft', 'running', 'running-draft', 'menu'] as const;
type ComposerState = (typeof COMPOSER_STATES)[number];
const COMPOSER_MAIN_ENABLED: readonly ComposerState[] = ['draft', 'running', 'running-draft'];

function composerMarks(state: ComposerState): Record<string, Record<string, string>> {
  const main: Record<string, Record<string, string>> = COMPOSER_MAIN_ENABLED.includes(state)
    ? {
        '[data-slot="composer"] textarea + [data-slot="button"]': {
          'data-guard-focus': 'composer-main',
          // 外框是按鈕自己畫的：`collectFocus` 找最近的 outline-host，不掛的話會找到外殼。
          'data-guard-outline-host': '',
          // 送出與停止都是非文字的圖示：3:1（WCAG 1.4.11）。
          'data-guard-text': 'composer-main',
          'data-guard-min': '3',
        },
      }
    : {};
  return {
    '[data-slot="composer"]': { 'data-guard-outline-host': '', 'data-guard-surface': 'composer' },
    '[data-slot="composer"] textarea': { 'data-guard-focus': 'composer-input' },
    '[data-slot="composer"] [aria-label="加入附件"]': {
      'data-guard-focus': 'composer-add',
      'data-guard-outline-host': '',
    },
    ...main,
    ...(state === 'menu'
      ? { '[data-slot="command-item"]': { 'data-guard-text': 'composer-menu-item' } }
      : {}),
  };
}

describe.each(
  COMPOSER_STATES.flatMap((state) =>
    (['light', 'dark'] as const).map((theme) => [state, theme] as const),
  ),
)('瀏覽器量輸入框（#1591）：%s、%s', (state, theme) => {
  const key = `composer-${state}:${theme}`;
  let page: Page;
  let texts: TextSample[];
  let focus: FocusSample[];

  beforeAll(async () => {
    page = await openOverlay(`composer-${state}`, theme, { marks: composerMarks(state) });
    texts = await collectTexts(page);
    focus = await collectFocus(page);
  }, 60_000);

  afterAll(async () => {
    await page?.close();
  });

  test('鍵盤焦點：輸入框的外框畫在外殼上（本地修改第 30 條）、「＋」與主按鈕，都不帶 ring、2px 字色外框', () => {
    const expected = [
      'composer-add-0',
      'composer-input-0',
      ...(COMPOSER_MAIN_ENABLED.includes(state) ? ['composer-main-0'] : []),
    ];
    expect(focus.map((f) => f.name).sort()).toEqual(expected);
    expectFocus(focus, key);
  });

  test('主按鈕的圖示（非文字 3:1）與選單的字過門檻', () => {
    const required = [
      ...(COMPOSER_MAIN_ENABLED.includes(state) ? ['composer-main'] : []),
      ...(state === 'menu' ? ['composer-menu-item'] : []),
    ];
    if (required.length === 0) {
      expect(texts.filter((t) => t.name.startsWith('composer'))).toEqual([]);
      return;
    }
    expectTexts(
      texts.filter((t) => t.name.startsWith('composer')),
      required,
      key,
    );
  });
});

describe.each(
  MODES.filter((m) => m !== 'translucent').flatMap((mode) =>
    (['light', 'dark'] as const).map((theme) => [mode, theme] as const),
  ),
)('瀏覽器量輸入框（#1591）：%s、%s', (mode, theme) => {
  test('不透明的退路：輸入框的面不透明、沒有 blur', async () => {
    const page = await openOverlay('composer-draft', theme, {
      mode,
      marks: composerMarks('draft'),
    });
    try {
      const surfaces = await collectSurfaces(page);
      report[`${mode}:composer:${theme}:surfaces`] = surfaces;
      expect(surfaces.map((s) => s.name)).toEqual(['composer']);
      expect(
        surfaces
          .filter((s) => parseColor(s.backgroundColor).alpha !== 1 || s.backdropFilter !== 'none')
          .map((s) => `${s.name}：${s.backgroundColor}、backdrop-filter ${s.backdropFilter}`),
      ).toEqual([]);
    } finally {
      await page.close();
    }
  });
});

/**
 * 輸入框的底列（#1591 PR 2，驗收 C、D）：左邊權限、右邊模型、推理強度兩顆 SG 的 `ComposerPick`，最右邊用量環（SG 的 `ContextRing`）。
 * 都是 vendor 畫的、掛不了屬性，開頁後補。
 */
const PICK = '[data-slot="composer-footer"] [data-slot="dropdown-menu-trigger"]';
const RING = '[data-slot="composer-footer"] [data-slot="context-ring"]';
const footerMarks: Record<string, Record<string, string>> = {
  [PICK]: { 'data-guard-focus': 'footer-pick', 'data-guard-text': 'footer-pick' },
  [RING]: { 'data-guard-focus': 'footer-ring' },
};

describe.each(['light', 'dark'] as const)('瀏覽器量輸入框的底列（#1591）：%s', (theme) => {
  test('鍵盤焦點：三顆 Pick 與用量環都不帶 ring、2px 字色外框；Pick 的 12px 次要字過 4.5', async () => {
    const page = await openOverlay('composer-idle', theme, { marks: footerMarks });
    try {
      const texts = await collectTexts(page);
      const focus = await collectFocus(page);
      expect(focus.map((f) => f.name).sort()).toEqual([
        'footer-pick-0',
        'footer-pick-1',
        'footer-pick-2',
        'footer-ring-0',
      ]);
      expectFocus(focus, `footer:${theme}`);
      // 量具自檢：三顆 Pick 都量到。
      expect(texts.filter((t) => t.name === 'footer-pick')).toHaveLength(3);
      expectTexts(texts, ['footer-pick'], `footer:${theme}`);
    } finally {
      await page.close();
    }
  });

  test('用量環的三個色階（50%、70%、90%）都是 status token、對底色過非文字 3:1（本地修改第 37 條）', async () => {
    const page = await openOverlay('composer-tones', theme, {
      marks: {
        [`${RING} svg`]: { 'data-guard-text': 'ring', 'data-guard-min': String(NON_TEXT_MIN) },
      },
    });
    try {
      const texts = (await collectTexts(page)).filter((t) => t.name === 'ring');
      const tokens = await page.evaluate(() =>
        ['--info', '--warning', '--destructive'].map((token) => {
          const probe = document.createElement('span');
          probe.style.color = `var(${token})`;
          document.body.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        }),
      );
      report[`footer:${theme}:ring-tones`] = { tokens, colors: texts.map((t) => t.color) };
      // 三個環依序是 info、warning、destructive（拿掉覆寫檔第 37 條，前兩個會是 Tailwind 色板的藍與琥珀）。
      expect(texts.map((t) => t.color)).toEqual(tokens);
      expect(new Set(tokens).size).toBe(3);
      expectTexts(texts, ['ring'], `footer:${theme}:ring`);
    } finally {
      await page.close();
    }
  });

  test('權限「全開」：Pick 是警示色，滑鼠移上去不變、清單開著換回字色；模型那顆照常是次要色（本地修改第 35 條）', async () => {
    const page = await openOverlay('composer-danger', theme, { marks: {} });
    try {
      const danger = page.locator(
        '[data-slot="permission-pick"] [data-slot="dropdown-menu-trigger"]',
      );
      const model = page.locator('[data-slot="model-pick"] [data-slot="dropdown-menu-trigger"]');
      const warning = await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--warning)';
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      const colorOf = (target: typeof danger) =>
        target.evaluate((el) => getComputedStyle(el).color);
      const rest = await colorOf(danger);
      await danger.hover();
      await settle(page);
      const hover = await colorOf(danger);
      await page.mouse.move(0, 0);
      await danger.click();
      await page.waitForSelector('[role="menu"]');
      await settle(page);
      const open = await colorOf(danger);
      await page.keyboard.press('Escape');
      await page.waitForSelector('[role="menu"]', { state: 'detached' });
      const others = await colorOf(model);
      report[`footer:${theme}:danger`] = { warning, rest, hover, open, others };
      expect([rest, hover]).toEqual([warning, warning]);
      expect(open).not.toBe(warning);
      expect(others).not.toBe(warning);
    } finally {
      await page.close();
    }
  });

  test('權限鎖住：Trigger 半透明、聚焦得到（名稱帶原因），點了清單不開（本地修改第 39 條）', async () => {
    const page = await openOverlay('composer-locked', theme, { marks: {} });
    try {
      const locked = page.locator(
        '[data-slot="permission-pick"] [data-slot="dropdown-menu-trigger"]',
      );
      const model = page.locator('[data-slot="model-pick"] [data-slot="dropdown-menu-trigger"]');
      const opacityOf = (target: typeof locked) =>
        target.evaluate((el) => getComputedStyle(el).opacity);
      await locked.focus();
      const state = await locked.evaluate((el) => ({
        focused: document.activeElement === el,
        disabled: el.hasAttribute('disabled'),
        ariaDisabled: el.getAttribute('aria-disabled'),
        name: el.getAttribute('aria-label'),
      }));
      // `force`：Playwright 把 `aria-disabled` 當成不能點、會一直等；這裡要的正是「點了也不開」。
      await locked.click({ force: true });
      await settle(page);
      const menus = await page.locator('[role="menu"]').count();
      const opacities = { locked: await opacityOf(locked), model: await opacityOf(model) };
      report[`footer:${theme}:locked`] = { ...state, menus, opacities };
      expect(state).toEqual({
        focused: true,
        disabled: false,
        ariaDisabled: 'true',
        name: '權限：可寫工作區，這一輪結束後才能切換',
      });
      expect(menus).toBe(0);
      // 量具自檢：沒鎖的那顆是 1。
      expect(opacities).toEqual({ locked: '0.5', model: '1' });
    } finally {
      await page.close();
    }
  });

  test('模型的清單開著：選項名稱、12px 的說明、11px 的標題都過 4.5，選項 32px 高（1024 以上）', async () => {
    const page = await openOverlay('composer-pick-open', theme, {
      marks: {
        '[role="menuitemradio"]': { 'data-guard-text': 'pick-item' },
        '[role="menuitemradio"] .text-muted-foreground': { 'data-guard-text': 'pick-hint' },
        '[data-slot="dropdown-menu-label"]': { 'data-guard-text': 'pick-label' },
      },
    });
    try {
      const texts = await collectTexts(page);
      const heights = await page.$$eval('[role="menuitemradio"]', (els) =>
        els.map((el) => el.getBoundingClientRect().height),
      );
      report[`footer:${theme}:pick-open:heights`] = heights;
      expectTexts(texts, ['pick-item', 'pick-hint', 'pick-label'], `footer:${theme}:pick-open`);
      expect(heights.length).toBeGreaterThan(1);
      expect(heights.filter((h) => h < 32)).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test('用量環點開：明細的標題、每一行（含不會觸發的那一行與它底下的小字）、說明都過 4.5', async () => {
    const page = await openOverlay('composer-dormant', theme, {
      marks: { [RING]: {} },
      prepare: async (p) => {
        await p.click(RING);
        await p.waitForSelector('[data-testid="context-meter-note"]');
        await settle(p);
        await p.evaluate(() => {
          const mark = (selector: string, name: string) =>
            document
              .querySelectorAll(selector)
              .forEach((el) => el.setAttribute('data-guard-text', name));
          mark('[data-slot="popover-title"]', 'ring-title');
          mark('[data-testid="context-meter-percent"]', 'ring-percent');
          mark('[data-testid="context-meter-row"]', 'ring-row');
          mark('[data-testid="context-meter-dormant"]', 'ring-dormant');
          mark('[data-testid="context-meter-note"]', 'ring-note');
        });
      },
    });
    try {
      const texts = await collectTexts(page);
      // 量具自檢：兩道門檻都量到，其中一道是不會觸發的。
      expect(texts.filter((t) => t.name === 'ring-row')).toHaveLength(2);
      expectTexts(
        texts,
        ['ring-title', 'ring-percent', 'ring-row', 'ring-dormant', 'ring-note'],
        `footer:${theme}:ring-open`,
      );
    } finally {
      await page.close();
    }
  });
});

describe.each(
  MODES.filter((m) => m !== 'translucent').flatMap((mode) =>
    (['light', 'dark'] as const).map((theme) => [mode, theme] as const),
  ),
)('瀏覽器量輸入框的底列（#1591）：%s、%s', (mode, theme) => {
  test('不透明的退路：Pick 的 12px 次要字過 4.5、用量環三個色階過 3:1', async () => {
    const pick = await openOverlay('composer-idle', theme, { mode, marks: footerMarks });
    const tones = await openOverlay('composer-tones', theme, {
      mode,
      marks: {
        [`${RING} svg`]: { 'data-guard-text': 'ring', 'data-guard-min': String(NON_TEXT_MIN) },
      },
    });
    try {
      const texts = [
        ...(await collectTexts(pick)).filter((t) => t.name === 'footer-pick'),
        ...(await collectTexts(tones)).filter((t) => t.name === 'ring'),
      ];
      // 量具自檢：三顆 Pick、三個環都量到。
      expect(texts.map((t) => t.name)).toEqual([
        ...Array(3).fill('footer-pick'),
        ...Array(3).fill('ring'),
      ]);
      expectTexts(texts, ['footer-pick', 'ring'], `${mode}:footer:${theme}`);
    } finally {
      await pick.close();
      await tones.close();
    }
  });
});

test('375 寬：模型清單的選項 44px 高（觸控高度，本地修改第 25 條擴充到 RadioItem）', async () => {
  const page = await openOverlay('composer-pick-open', 'light', {
    viewport: { width: 375, height: 812 },
    marks: { '[role="menuitemradio"]': {} },
  });
  try {
    const heights = await page.$$eval('[role="menuitemradio"]', (els) =>
      els.map((el) => el.getBoundingClientRect().height),
    );
    report['footer:pick-open:375:heights'] = heights;
    expect(heights.length).toBeGreaterThan(1);
    expect(heights.filter((h) => h < 44)).toEqual([]);
  } finally {
    await page.close();
  }
});

test('減少動態：用量環的弧長不走 transition（本地修改第 38 條）', async () => {
  const duration = async (reducedMotion: boolean) => {
    const page = await openOverlay('composer-idle', 'light', {
      reducedMotion,
      marks: { [RING]: {} },
    });
    try {
      return await page.$eval(
        `${RING} circle:last-child`,
        (el) => getComputedStyle(el).transitionDuration,
      );
    } finally {
      await page.close();
    }
  };
  const measured = { normal: await duration(false), reduced: await duration(true) };
  report['footer:ring-motion'] = measured;
  // 量具自檢：平常是 vendor 的 500ms（量到的確實是弧長那一圈）。
  expect(measured).toEqual({ normal: '0.5s', reduced: '0s' });
});

describe('瀏覽器量輸入框的版面（#1591）', () => {
  test.each([
    { width: 375, px: 44 },
    { width: 1280, px: 32 },
  ])(
    '$width 寬：底列不溢出、按鈕不重疊、主按鈕在框內；「＋」與主按鈕 $px px、單行的字跟它們置中（第 31 條）；底列的 Pick 與用量環 1024 以下 44px（第 36 條）',
    async ({ width, px }) => {
      const page = await openOverlay('composer-running-draft', 'light', {
        viewport: { width, height: 812 },
        marks: composerMarks('running-draft'),
      });
      try {
        const layout = await page.evaluate(() => {
          const box = (el: Element | null) => {
            if (el === null) throw new Error('量不到元素');
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height };
          };
          const composer = document.querySelector('[data-slot="composer"]');
          const footer = document.querySelector('[data-slot="composer-footer"]');
          const main = document.querySelector(
            '[data-slot="composer"] textarea + [data-slot="button"]',
          );
          const add = document.querySelector('[data-slot="composer"] [aria-label="加入附件"]');
          const textarea = document.querySelector('[data-slot="composer"] textarea');
          return {
            viewport: window.innerWidth,
            composer: box(composer),
            footer: box(footer),
            footerOverflow: footer === null ? 0 : footer.scrollWidth - footer.clientWidth,
            footerChildren: [...(footer?.querySelectorAll('button') ?? [])].map(box),
            main: box(main),
            add: box(add),
            textarea: box(textarea),
          };
        });
        report[`layout:composer:${width}`] = layout;
        const { composer, footer, main } = layout;
        expect(layout.footerOverflow).toBeLessThanOrEqual(0);
        // 底列每顆按鈕都在畫面裡、不超出輸入框的左右（底列在框外，跟框同寬）。
        expect(
          layout.footerChildren.filter(
            (b) => b.left < composer.left - 0.5 || b.right > composer.right + 0.5,
          ),
        ).toEqual([]);
        expect(footer.right).toBeLessThanOrEqual(layout.viewport);
        expect(main.left).toBeGreaterThanOrEqual(composer.left);
        expect(main.right).toBeLessThanOrEqual(composer.right);
        expect(main.top).toBeGreaterThanOrEqual(composer.top);
        expect(main.bottom).toBeLessThanOrEqual(composer.bottom);
        expect([layout.add.height, main.height]).toEqual([px, px]);
        // 底列的按鈕依序排、不互相蓋住（窄的時候只有模型那顆縮，其餘的包裝層不縮，見 `model-seat.tsx`）。
        expect(
          layout.footerChildren.filter((b, i, all) => i > 0 && b.left < all[i - 1]!.right - 0.5),
        ).toEqual([]);
        // 底列的三顆 Pick 與用量環：1024 以下 44px（本地修改第 36 條），以上照 SG 是 24px。
        expect(layout.footerChildren.map((b) => b.height)).toEqual(
          Array(4).fill(px === 44 ? 44 : 24),
        );
        // 單行的草稿：字（textarea 的盒子）跟「＋」、主按鈕同高、同一條中線，不會沉在按鈕下緣。
        const middle = (b: { top: number; bottom: number }) => (b.top + b.bottom) / 2;
        expect(layout.textarea.height).toBe(px);
        expect(Math.abs(middle(layout.textarea) - middle(main))).toBeLessThanOrEqual(0.5);
        expect(Math.abs(middle(layout.textarea) - middle(layout.add))).toBeLessThanOrEqual(0.5);
      } finally {
        await page.close();
      }
    },
  );
});

describe('瀏覽器量展開收合（#1638 PR A，`?overlay=collapsibles`）', () => {
  // 這幾件都靠真的 CSS 命中 Base UI 的屬性（Panel 的 `data-open`、Trigger 的 `data-panel-open`、`--collapsible-panel-height`），
  // jsdom 不載 CSS，元件測試量不到。量思考過程那一列：箭頭、摘要、內容的高度動效都在它身上。
  const ROW = '[data-testid="reasoning-row"]';
  const openRow = (reducedMotion: boolean) =>
    openOverlay('collapsibles', 'light', { reducedMotion, marks: { [ROW]: {} } });

  /** 點開那一列，回傳內容在展開動效 40% 時的高度、第一幀的高度與動效跑完的高度。 */
  async function expand(page: Page) {
    await page.click(`${ROW} button[aria-expanded]`);
    return page.evaluate(async (row) => {
      const panel = () =>
        document.querySelector<HTMLElement>(`${row} [data-slot="collapsible-content"]`);
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      while (panel() === null) await frame();
      const el = panel()!;
      const first = el.getBoundingClientRect().height;
      const grow = el
        .getAnimations()
        .find((a) => (a as CSSAnimation).animationName === 'collapsible-down');
      let mid: number | undefined;
      if (grow !== undefined) {
        grow.pause();
        grow.currentTime = Number(grow.effect?.getComputedTiming().duration) * 0.4;
        mid = el.getBoundingClientRect().height;
        grow.finish();
      }
      await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined)));
      return {
        animations: el.getAnimations().length,
        grows: grow !== undefined,
        first,
        mid,
        final: el.getBoundingClientRect().height,
        variable: el.style.getPropertyValue('--collapsible-panel-height'),
      };
    }, ROW);
  }

  test('展開途中的高度介於 0 與最終值之間（Q1：keyframes 讀 Base UI 的 --collapsible-panel-height）', async () => {
    const page = await openRow(false);
    try {
      const measured = await expand(page);
      report['collapsible:expand'] = measured;
      // 量具自檢：真的有那條高度動效、展開後有高度。
      expect(measured.grows).toBe(true);
      expect(measured.final).toBeGreaterThan(0);
      expect(measured.mid).toBeGreaterThan(0);
      expect(measured.mid).toBeLessThan(measured.final);
    } finally {
      await page.close();
    }
  });

  test('減少動態：沒有高度動效，點開的第一幀就到位', async () => {
    const page = await openRow(true);
    try {
      const measured = await expand(page);
      report['collapsible:expand-reduced'] = measured;
      expect(measured.grows).toBe(false);
      expect(measured.final).toBeGreaterThan(0);
      expect(measured.first).toBe(measured.final);
    } finally {
      await page.close();
    }
  });

  test('箭頭跟著 Trigger 開著時的 data-panel-open 轉半圈；思考過程展開後藏「·」與摘要（Q2）', async () => {
    const page = await openRow(false);
    try {
      const read = () =>
        page.$eval(ROW, (row) => {
          const trigger = row.querySelector('button[aria-expanded]')!;
          return {
            expanded: trigger.getAttribute('aria-expanded'),
            panelOpen: trigger.hasAttribute('data-panel-open'),
            // Tailwind v4 的 `rotate-180` 寫的是獨立的 `rotate` 屬性，不是 `transform`。
            chevron: getComputedStyle(trigger.querySelector('svg[data-motion-rotate]')!).rotate,
            hidden: [...trigger.querySelectorAll('span[aria-hidden]')]
              .filter((el) => el.textContent?.trim() !== '')
              .map((el) => getComputedStyle(el).display === 'none'),
          };
        });
      const closed = await read();
      await page.click(`${ROW} button[aria-expanded]`);
      await settle(page);
      const opened = await read();
      report['collapsible:trigger'] = { closed, opened };
      expect(closed).toEqual({
        expanded: 'false',
        panelOpen: false,
        chevron: 'none',
        hidden: [false, false],
      });
      // 量具自檢：「·」與摘要兩個都量到了。
      expect(opened).toEqual({
        expanded: 'true',
        panelOpen: true,
        chevron: '180deg',
        hidden: [true, true],
      });
    } finally {
      await page.close();
    }
  });
});
