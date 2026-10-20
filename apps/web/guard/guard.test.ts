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
 *    的狀態色門檻）。Pick 按下去就打開清單，量不到單純按著的樣子；`data-guard-press` 那顆頂列用量鈕量平常、移上去、按著
 *    （`:active`），次要字疊在 `chip-hover`、`chip-pressed` 上過 4.5。
 * 6. **對話裡被定位的那一則有圓角**：`[data-located]` 的圓角是 `var(--radius-3xl)`，這個變數只宣告在 SG 的 `@theme inline`；
 *    Tailwind 沒輸出或修剪掉它的話，圓角會靜靜變成 0。量 `border-radius` 不是 0。
 * 7. **亮色陰影**：每層投影的透明度不超過該元素的上限 {@link SHADOW_LIMITS}（#1468 Q8 外觀照 SG：上限就是 SG 現在的值，誰再調深就紅）。
 * 8. **destructive 按鈕的 hover**：平常與滑鼠移上去，字對底色都過 4.5（vendor 的 hover 底太深，覆寫檔調淡，#1523）。
 * 9. **SG 的按鈕規則真的命中 vendor 的 Button**（#1523）：outline、secondary、glass 有 `backdrop-filter`（`solid-glass.css:642-679`
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
 * 13. **展開收合**（#1638 PR A，`?overlay=collapsibles`）：摘要列照 SG 沒有高度動效、點開的第一幀就到位（#1687，平常與
 *    reduced-motion 各一格）；箭頭照 SG 跟著 Trigger 的 `data-panel-open` 轉 90 度，平常 150ms、reduced-motion 不轉場。思考過程（#1683 換成 SG 的原生 `<details>`）的箭頭跟著 `details[open]` 轉 90 度、展開後藏「·」與摘要（Q2）。
 * 14. **對話區**（#1638 PR B，`?overlay=messages`，產品的 `Transcript`）：泡泡字、表尾、捲到最新的按鈕圖示的對比與按鈕的焦點（亮暗加兩種退路，
 *    {@link OVERLAYS}）；每一則的 `content-visibility` 是 `visible`（第 42 條）；按鈕的動效照 vendor 原樣（#1687 撤掉第 41 條），
 *    reduced-motion 下沒有 transition；按鈕位移之後避讓（`data-obscuring`）照終點的框算；外殼的行高是 SG 的 20px、泡泡維持 23px；底部淡出捲到底時收成 0。
 * 15. **桌面側欄的收合**（#1680 PR B，`?overlay=desktop-sidebar`）：gap 與 container 的 transition 是 SG 的 200ms linear，
 *    reduced-motion 下整個關掉（`motion.css`）。手機抽屜的寬度在 375 與 768 都是 `--sidebar-width`（本地修改第 55 條，見 {@link WIDTHS}）。
 * 16. **tool-steps**（#1682 PR A，`?overlay=tool-steps`）：列、群組那一列、結果框的字過 4.5，結果框聚焦時 2px 外框畫在外層、offset 2px
 *    （第 62 條）；執行中不閃（第 61 條）；375 寬按鈕至少 44px、1280 寬照 SG（第 63 條）；減少動態時箭頭不轉場（第 64 條）；疊在清單裡的
 *    結果框沒有 blur、清單與單獨放的結果框照 SG 有（第 65 條）。
 * 17. **增刪行數**（#1685 PR A，`?overlay=diff-stats`）：`+`／`−` 在頁面、`StepList` 的 `--panel`、改動卡、審查頁與選檔器上過 4.5，
 *    顏色就是 `--success`／`--destructive`（第 75 條）；375 寬時包裝層不被擠（第 76 條）。
 * 18. **工具卡的 diff**（#1685 PR B，`?overlay=diff-view`，產品的 `ToolRun`＋`ToolCard`）：SG `DiffView` 每一種行（`diff --git`、`@@`、
 *    新增、刪除、上下文、`... 還有 N 行沒畫`）在 `StepList` 裡與單獨放在頁面上都過 4.5；疊在清單裡的沒有 blur、單獨的照 SG 有（第 65 條）；
 *    聚焦時 2px 外框沒被切掉、方向鍵捲得動（patch `0024`）。
 *
 * 面有三種狀態（{@link MODES}）：平常的半透明、`prefers-reduced-transparency: reduce`（CDP 模擬）、`<html data-glass="opaque">`。
 * 後兩種是不透明的退路，對比要一樣達標，面也要真的不透明。
 *
 * 量不到的：brand 與 SG 的 `status-*` 這幾個顏色，測試頁上沒有元件不寫 class 就會用到它們（只有 `DiffStats` 的增刪數用到 success／destructive，覆寫檔第 75 條），
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

/**
 * 等有限長度的動畫與轉場跑完（無限的，例如呼吸光，不等）。只等跟著時間跑的：scroll-driven 的（對話區的底部淡出，#1638 PR B）
 * 跟著捲動位置走，沒捲到底就永遠不會 finished。
 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter(
        (a) =>
          a.timeline instanceof DocumentTimeline &&
          a.effect?.getComputedTiming().endTime !== Infinity,
      );
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
      // 兩種都量，照文件順序。`DiffStats` 的 `aria-hidden` 掛在包裝層上（#1685 第 76 條），那一層自己沒有字、字色在裡面的
      // `+`／`−` 兩個 span（第 75 條換的就是這兩個），所以量那兩個 span、不量包裝層：量包裝層只會量到繼承下來的字色。
      const targets = group.querySelectorAll(
        '[aria-hidden]:not(:has(> [data-slot="diff-stats"])), [data-slot="diff-stats"] > span',
      );
      targets.forEach((el, i) => {
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

type PressState = 'rest' | 'hover' | 'pressed';
const PRESS_STATES: PressState[] = ['rest', 'hover', 'pressed'];

interface PressSample {
  readonly name: string;
  readonly state: PressState;
  /** 真的在那個狀態（`:hover`、`:active`）。 */
  readonly inState: boolean;
  readonly color: string;
  readonly backgroundColor: string;
  readonly chain: MeasuredLayer[];
}

/**
 * `data-guard-press` 裡那顆按鈕：游標移開、移上去、按著三種狀態各量一次字色與往上疊的底。按著時量完先把游標移開再放開，
 * 放開的位置不在按鈕上就不算點擊，不會打開它的 popover。
 */
async function collectPresses(page: Page): Promise<PressSample[]> {
  const names = await page.$$eval('[data-guard-press]', (els) =>
    els.map((el) => el.getAttribute('data-guard-press') ?? ''),
  );
  const samples: PressSample[] = [];
  for (const name of names) {
    const target = page.locator(`[data-guard-press="${name}"] button`);
    for (const state of PRESS_STATES) {
      if (state === 'rest') await page.mouse.move(0, 0);
      else await target.hover();
      if (state === 'pressed') await page.mouse.down();
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
          active: el.matches(':active'),
          color: getComputedStyle(el).color,
          backgroundColor: getComputedStyle(el).backgroundColor,
          chain,
        };
      });
      if (state === 'pressed') {
        await page.mouse.move(0, 0);
        await page.mouse.up();
      }
      samples.push({
        name,
        state,
        inState:
          state === 'rest'
            ? !measured.hover && !measured.active
            : state === 'hover'
              ? measured.hover && !measured.active
              : measured.active,
        color: measured.color,
        backgroundColor: measured.backgroundColor,
        chain: measured.chain,
      });
    }
  }
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
  let presses: PressSample[];
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
    presses = await collectPresses(page);
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
      expect.arrayContaining([
        'button-default',
        'input-group',
        'sidebar-menu-button',
        'sidebar-menu-action',
        'sidebar-trigger',
      ]),
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
    // 量具自檢：四種欄位都量到、真的在 `:focus-visible`，而且聚焦前後邊框有變（量到的是聚焦的樣子，不是平常的邊框）。
    expect(fields.map((f) => f.name).sort()).toEqual([
      'input',
      'input-group',
      'sidebar-input',
      'textarea',
    ]);
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

  test('chip 的兩階上的次要字：頂列用量鈕平常、滑鼠移上去（chip-hover）、按著（chip-pressed）都過 4.5', () => {
    const measured = presses.map((p) => ({
      key: `${p.name}:${p.state}`,
      ...p,
      ...worstOn(p.color, p.chain),
    }));
    report[`${theme}:presses`] = measured.map((m) => ({
      key: m.key,
      color: m.color,
      backgroundColor: m.backgroundColor,
      on: m.on,
      ratio: Math.round(m.ratio * 10000) / 10000,
    }));
    // 量具自檢：三種狀態都量到、真的在那個狀態，而且三種底色都不一樣（移上去與按著真的換了底；`bg-card` 之類蓋掉的話會一樣）。
    expect(measured.map((m) => m.key)).toEqual(
      PRESS_STATES.map((state) => `session-usage:${state}`),
    );
    expect(measured.filter((m) => !m.inState).map((m) => m.key)).toEqual([]);
    expect(new Set(measured.map((m) => m.backgroundColor)).size).toBe(3);
    expect(
      measured
        .filter((m) => !(m.ratio >= TEXT_MIN))
        .map((m) => `${m.key} ${m.ratio.toFixed(4)} < ${TEXT_MIN}（${m.on}）`),
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

  test('SG 的玻璃按鈕吃到 SG 的規則：outline、secondary、glass 都有 backdrop-filter（data-variant 命中 solid-glass.css:642-679，#1523）', () => {
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

const SCROLL_BUTTON = '[data-slot="message-scroller-button"]';
const QUESTIONNAIRE_CHOICE = '[data-slot="questionnaire-choice"]';
const QUESTIONNAIRE_INPUT = `${QUESTIONNAIRE_CHOICE} > input`;
/** 放不下的那一排草稿附件裡每一顆按鈕：看原圖（縮圖）、移除、取消上傳。 */
const ATTACHMENT_BUTTONS =
  '[data-guard-rail="overflows"] :is([data-slot="attachment-action"], [data-slot="attachment-media"] > button)';

/** 把對話區捲到頂端或最底，等捲到最新的按鈕換好狀態、動效跑完。 */
async function scrollMessages(page: Page, to: 'top' | 'end'): Promise<void> {
  // 剛開頁時對話區還在定位，第一下捲動可能被 primitive 略過：捲完逐幀看按鈕換好狀態沒有，一秒沒換好就再捲一次。
  const settled = await page.$eval(
    '[data-slot="message-scroller-viewport"]',
    async (el, top) => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const button = el.parentElement!.querySelector('[data-slot="message-scroller-button"]')!;
      const target = top ? 0 : el.scrollHeight - el.clientHeight;
      for (let attempt = 0; attempt < 5; attempt++) {
        // 已經在目標位置時再設一次不會發 scroll 事件，先往回推 1px。
        if (attempt > 0) {
          el.scrollTop = top ? 1 : target - 1;
          await frame();
        }
        el.scrollTop = target;
        // 每捲一次只看不碰：一直改 scrollTop，primitive 等不到捲動停下來，按鈕的狀態不會換。
        for (let i = 0; i < 60; i++) {
          await frame();
          if (button.getAttribute('data-active') === String(top)) return true;
        }
      }
      return false;
    },
    to === 'top',
  );
  if (!settled) throw new Error(`對話區捲到${to === 'top' ? '頂端' : '最底'}之後，按鈕沒有換狀態`);
  await settle(page);
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
  {
    // 不是浮層，但要的量測一樣（字、焦點、兩種退路），所以掛在這張清單上（#1638 PR B）。
    name: 'messages',
    marks: {
      '[data-slot="message"][data-align="end"] [data-slot="bubble-content"]': {
        'data-guard-text': 'user-bubble',
      },
      '[data-testid="ai-entry"] [data-slot="bubble-content"]': { 'data-guard-text': 'ai-bubble' },
      '[data-slot="message-footer"]': { 'data-guard-text': 'message-footer' },
      // 圖示是 `aria-hidden` 的 svg，`data-guard-texts` 量它的顏色。
      [SCROLL_BUTTON]: { 'data-guard-focus': 'scroll-button', 'data-guard-texts': 'scroll-button' },
    },
    // 一開頁就捲在最底，按鈕是藏著的（opacity 0，量具會判不合格）：捲回頂端讓它出現再量。
    prepare: async (page) => {
      await scrollMessages(page, 'top');
    },
    texts: ['user-bubble', 'ai-bubble', 'message-footer', 'scroll-button-0'],
    focus: ['scroll-button-0'],
    surfaces: [],
    backdrops: [],
  },
  {
    name: 'questionnaire',
    marks: {
      // 真的 input 鋪滿選項、`opacity-0`，外框畫在選項上（本地修改第 46 條）：聚焦 input、量選項。
      [QUESTIONNAIRE_INPUT]: { 'data-guard-focus': 'questionnaire-choice' },
      [QUESTIONNAIRE_CHOICE]: { 'data-guard-outline-host': '' },
      '[data-slot="questionnaire-progress"]': { 'data-guard-text': 'questionnaire-progress' },
      '[data-slot="questionnaire-title"]': { 'data-guard-text': 'questionnaire-title' },
      '[data-slot="questionnaire-choice-label"]': { 'data-guard-text': 'questionnaire-choice' },
      '[data-slot="questionnaire-choice-description"]': {
        'data-guard-text': 'questionnaire-choice-description',
      },
      '[data-slot="questionnaire-next"]': {
        'data-guard-text': 'questionnaire-next',
        'data-guard-focus': 'questionnaire-next',
      },
    },
    texts: [
      'questionnaire-progress',
      'questionnaire-title',
      'questionnaire-choice',
      'questionnaire-choice-description',
      'questionnaire-next',
    ],
    focus: [
      'questionnaire-choice-0',
      'questionnaire-choice-1',
      'questionnaire-choice-2',
      'questionnaire-next-0',
    ],
    surfaces: [],
    backdrops: [],
  },
  {
    name: 'attachments',
    marks: {
      // 上傳中的標題是 shimmer（字是透明的、顏色來自漸層），讀 `color` 會量到完整字色、假綠：這裡不量，另一格量漸層每個色標。
      '[data-guard-rail] [data-slot="attachment"]:not([data-state="uploading"]) [data-slot="attachment-title"]':
        { 'data-guard-text': 'attachment-title' },
      '[data-guard-rail] [data-slot="attachment"]:not([data-state="error"]) [data-slot="attachment-description"]':
        { 'data-guard-text': 'attachment-description' },
      '[data-slot="attachment"][data-state="error"] [data-slot="attachment-description"]': {
        'data-guard-text': 'attachment-error',
      },
      [ATTACHMENT_BUTTONS]: { 'data-guard-focus': 'attachment-button' },
    },
    texts: ['attachment-title', 'attachment-description', 'attachment-error'],
    // 圖的看原圖與移除、檔案的移除、取消上傳（有進度）、取消上傳（不確定長度）、移除（失敗的）。
    focus: [0, 1, 2, 3, 4, 5].map((i) => `attachment-button-${i}`),
    surfaces: [],
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
  // 768–1023 也是手機抽屜（斷點 1024）：`w-3/4` 加 `sm:max-w-sm` 會變成 384（本地修改第 55 條擋住）。
  {
    overlay: 'mobile-sidebar',
    viewport: { width: 768, height: 1024 },
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

    test('「⋯」選單開著時看得見（Trigger 開著掛 aria-expanded，vendor 的 SidebarMenuAction 認它）', () => {
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

  /**
   * 進出場的時長照 SG（#1687 驗收 A1、A3）：vendor 的 dialog、alert-dialog（含遮罩）、popover 寫 `duration-100`，tooltip 沒寫、
   * 是 tw-animate 的預設 150。浮層一開頁就開著，進場已經跑完：計算值的 `animation-*` 還在，讀它；退場仿照上面抽屜那格，
   * 同一個 eval 裡把 `data-open` 換成 `data-closed` 再讀。分得出「`--animate-in` 只宣告在 `:root`、讀不到元素自己的
   * `--tw-duration`」的只有寫了 `duration-100` 的那幾格（那時量到 150）；tooltip 本來就是 150，只當對照。
   */
  const ENTER_EXIT = [
    { name: 'dialog', overlay: 'dialog', selector: '[data-slot="dialog-content"]', ms: 100 },
    {
      name: 'dialog-overlay',
      overlay: 'dialog',
      selector: '[data-slot="dialog-overlay"]',
      ms: 100,
    },
    {
      name: 'alert-dialog',
      overlay: 'alert-dialog',
      selector: '[data-slot="alert-dialog-content"]',
      ms: 100,
    },
    {
      name: 'alert-dialog-overlay',
      overlay: 'alert-dialog',
      selector: '[data-slot="alert-dialog-overlay"]',
      ms: 100,
    },
    { name: 'popover', overlay: undefined, selector: '[data-slot="popover-content"]', ms: 100 },
    { name: 'tooltip', overlay: undefined, selector: '[data-slot="tooltip-content"]', ms: 150 },
  ];

  async function readEnterExit(
    overlay: string | undefined,
    selector: string,
    reducedMotion: boolean,
  ) {
    const page =
      overlay === undefined
        ? await (async () => {
            const p = await open('light');
            if (reducedMotion) await p.emulateMedia({ reducedMotion: 'reduce' });
            return p;
          })()
        : await openOverlay(overlay, 'light', { reducedMotion, marks: { [selector]: {} } });
    try {
      return await page.$eval(selector, (el) => {
        const read = () => {
          const style = getComputedStyle(el);
          return {
            name: style.animationName,
            duration: style.animationDuration,
            easing: style.animationTimingFunction,
            fill: style.animationFillMode,
          };
        };
        /** 這個名字的 @keyframes 動到哪些屬性。 */
        const animated = (name: string) => {
          const props = new Set<string>();
          for (const sheet of document.styleSheets)
            for (const rule of sheet.cssRules)
              if (rule instanceof CSSKeyframesRule && rule.name === name)
                for (const frame of rule.cssRules)
                  for (const prop of (frame as CSSKeyframeRule).style) props.add(prop);
          return [...props].sort();
        };
        const enter = read();
        el.removeAttribute('data-open');
        el.setAttribute('data-closed', '');
        const exit = read();
        return {
          enter,
          exit,
          animates: { enter: animated(enter.name), exit: animated(exit.name) },
        };
      });
    } finally {
      await page.close();
    }
  }

  test.each(ENTER_EXIT)(
    '$name 的進出場照 SG：$ms ms、ease，fill-mode 是 backwards／both（#1687 A1）',
    async ({ name, overlay, selector, ms }) => {
      const measured = await readEnterExit(overlay, selector, false);
      report[`enter-exit:${name}`] = measured;
      expect(measured.enter).toEqual({
        name: 'enter',
        duration: `${ms / 1000}s`,
        easing: 'ease',
        fill: 'backwards',
      });
      expect(measured.exit).toEqual({
        name: 'exit',
        duration: `${ms / 1000}s`,
        easing: 'ease',
        fill: 'both',
      });
    },
  );

  test.each(ENTER_EXIT)(
    'reduced-motion 下 $name 只淡入淡出：≤ 150ms、只動 opacity（#1687 A3）',
    async ({ name, overlay, selector }) => {
      const measured = await readEnterExit(overlay, selector, true);
      report[`enter-exit-reduced:${name}`] = measured;
      expect(measured.enter).toMatchObject({ name: 'motion-fade-in', fill: 'backwards' });
      expect(measured.exit).toMatchObject({ name: 'motion-fade-out', fill: 'both' });
      for (const phase of [measured.enter, measured.exit])
        expect(Number.parseFloat(phase.duration)).toBeLessThanOrEqual(0.15);
      expect(measured.animates).toEqual({ enter: ['opacity'], exit: ['opacity'] });
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

describe('瀏覽器量桌面側欄的收合動效（#1680 PR B，`?overlay=desktop-sidebar`）', () => {
  // 收合照 SG 的 `duration-200 ease-linear`（#1468 Q8；規格 §7 的「桌面側欄收合」）；reduced-motion 下 `motion.css` 以
  // `data-slot` 命中 gap 與 container，transition 整個關掉。jsdom 不載 CSS，元件測試量不到。
  test('平常是 SG 的 200ms linear；reduced-motion 下 gap 與 container 都沒有 transition', async () => {
    const read = async (reducedMotion: boolean) => {
      const page = await openOverlay('desktop-sidebar', 'light', { reducedMotion, marks: {} });
      try {
        return await page.evaluate(() =>
          ['sidebar-gap', 'sidebar-container'].map((slot) => {
            const el = document.querySelector(`[data-slot="${slot}"]`);
            if (el === null) return { slot, missing: true };
            const style = getComputedStyle(el);
            return {
              slot,
              property: style.transitionProperty,
              duration: style.transitionDuration,
              easing: style.transitionTimingFunction,
            };
          }),
        );
      } finally {
        await page.close();
      }
    };
    const normal = await read(false);
    const reduced = await read(true);
    report['motion:desktop-sidebar'] = { normal, reduced };
    expect(normal).toEqual([
      { slot: 'sidebar-gap', property: 'width', duration: '0.2s', easing: 'linear' },
      {
        slot: 'sidebar-container',
        property: 'left, right, width',
        duration: '0.2s',
        easing: 'linear',
      },
    ]);
    for (const row of reduced) expect(row).toMatchObject({ property: 'none', duration: '0s' });
  });
});

describe('瀏覽器量展開收合（#1638 PR A，`?overlay=collapsibles`）', () => {
  // 這幾件都靠真的 CSS 命中 Base UI 的屬性（Panel 的 `data-open`、Trigger 的 `data-panel-open`），jsdom 不載 CSS，元件測試量不到。
  // 展開收合照 SG 沒有高度動效（#1687：SG 的 collapsible Panel 沒有任何 class；思考過程 #1683 起是原生 `<details>`）：
  // 量摘要列點開的第一幀就到位。思考過程只量箭頭與展開後藏「·」與摘要。
  const COMPACTION = '[data-testid="compaction-row"]';
  const REASONING = '[data-testid="reasoning-row"]';
  const TRIGGER = `${COMPACTION} [data-slot="collapsible-trigger"]`;
  const openRows = (reducedMotion: boolean) =>
    openOverlay('collapsibles', 'light', {
      reducedMotion,
      marks: { [COMPACTION]: {}, [REASONING]: {} },
    });

  /** 點開摘要列，回傳內容在展開動效 40% 時的高度、第一幀的高度與動效跑完的高度。 */
  async function expand(page: Page) {
    await page.click(TRIGGER);
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
    }, COMPACTION);
  }

  test.each([false, true])(
    '摘要列照 SG 沒有高度動效：點開的第一幀就到位、內容上沒有任何動畫（#1687 B1；reduced-motion %s）',
    async (reducedMotion) => {
      const page = await openRows(reducedMotion);
      try {
        const measured = await expand(page);
        report[`collapsible:expand${reducedMotion ? '-reduced' : ''}`] = measured;
        // 量具自檢：展開後有高度。
        expect(measured.final).toBeGreaterThan(0);
        expect(measured.grows).toBe(false);
        expect(measured.animations).toBe(0);
        expect(measured.first).toBe(measured.final);
      } finally {
        await page.close();
      }
    },
  );

  test.each([false, true])(
    '摘要列的箭頭照 SG：跟著 Trigger 開著時的 data-panel-open 轉 90 度，平常 150ms、減少動態不轉場（#1687 B4；reduced-motion %s）',
    async (reducedMotion) => {
      const page = await openRows(reducedMotion);
      try {
        const read = () =>
          page.$eval(TRIGGER, (trigger) => {
            const chevron = getComputedStyle(trigger.querySelector('svg[data-motion-rotate]')!);
            return {
              expanded: trigger.getAttribute('aria-expanded'),
              panelOpen: trigger.hasAttribute('data-panel-open'),
              // Tailwind v4 的 `rotate-90` 寫的是獨立的 `rotate` 屬性，不是 `transform`。
              chevron: chevron.rotate,
              transition: `${chevron.transitionProperty} ${chevron.transitionDuration}`,
            };
          });
        const closed = await read();
        await page.click(TRIGGER);
        await settle(page);
        const opened = await read();
        report[`collapsible:trigger${reducedMotion ? '-reduced' : ''}`] = { closed, opened };
        expect(closed).toMatchObject({ expanded: 'false', panelOpen: false, chevron: 'none' });
        expect(opened).toMatchObject({ expanded: 'true', panelOpen: true, chevron: '90deg' });
        expect(opened.transition).toBe(
          reducedMotion ? 'none 0s' : 'transform, translate, scale, rotate 0.15s',
        );
      } finally {
        await page.close();
      }
    },
  );

  test('思考過程的箭頭跟著 details[open] 轉 90 度，展開後藏「·」與摘要（#1638 Q2、#1683）', async () => {
    const page = await openRows(false);
    try {
      const read = () =>
        page.$eval(REASONING, (row) => {
          const summary = row.querySelector('details > summary')!;
          return {
            open: row.querySelector('details')!.open,
            chevron: getComputedStyle(summary.querySelector('svg')!).rotate,
            hidden: [...summary.querySelectorAll('span[aria-hidden]')]
              .filter((el) => el.textContent?.trim() !== '')
              .map((el) => getComputedStyle(el).display === 'none'),
          };
        });
      const closed = await read();
      await page.click(`${REASONING} details > summary`);
      await settle(page);
      const opened = await read();
      report['collapsible:reasoning'] = { closed, opened };
      expect(closed).toEqual({ open: false, chevron: 'none', hidden: [false, false] });
      // 量具自檢：「·」與摘要兩個都量到了。
      expect(opened).toEqual({ open: true, chevron: '90deg', hidden: [true, true] });
    } finally {
      await page.close();
    }
  });
});

describe('瀏覽器量對話區（#1638 PR B，`?overlay=messages`）', () => {
  const openMessages = (reducedMotion = false) =>
    openOverlay('messages', 'light', { reducedMotion, marks: { [SCROLL_BUTTON]: {} } });

  test('每一則的 content-visibility 是 visible：覆寫檔壓掉 vendor 的 auto（Q6，本地修改第 42 條）', async () => {
    const page = await openMessages();
    try {
      const items = await page.$$eval('[data-slot="message-scroller-item"]', (els) =>
        els.map((el) => {
          const style = getComputedStyle(el);
          return `${style.contentVisibility} ${style.containIntrinsicSize}`;
        }),
      );
      report['messages:content-visibility'] = items;
      // 量具自檢：十二則都量到了。
      expect(items).toHaveLength(12);
      expect(new Set(items)).toEqual(new Set(['visible none']));
    } finally {
      await page.close();
    }
  });

  test.each([false, true])(
    '捲到最新的按鈕照 vendor 原樣：藏著時往下位移一整個身高、縮 .95，出現 200ms、藏起來 400ms；reduced-motion 下沒有 transition（#1687 撤掉第 41 條；reduced-motion %s）',
    async (reducedMotion) => {
      const page = await openMessages(reducedMotion);
      try {
        const read = () =>
          page.$eval(SCROLL_BUTTON, (el) => {
            const style = getComputedStyle(el);
            return {
              active: el.getAttribute('data-active'),
              slot: el.getAttribute('data-slot'),
              translate: style.translate,
              scale: style.scale,
              transitionProperty: style.transitionProperty,
              transitionDuration: style.transitionDuration,
            };
          });
        const hidden = await read();
        await scrollMessages(page, 'top');
        const shown = await read();
        report[`messages:scroll-button:${reducedMotion ? 'reduced' : 'normal'}`] = {
          hidden,
          shown,
        };
        // 量具自檢：真的量到藏著與出現兩種狀態，元素是 reduced-motion 那條規則認得的 data-slot。
        expect([hidden.active, shown.active]).toEqual(['false', 'true']);
        expect(shown.slot).toBe('message-scroller-button');
        // 藏著時 vendor 的 `translate-y-full`（y 是身高的 100%）疊在置中用的 -50% 上；出現時只剩置中。
        expect(hidden.translate).toContain('100%');
        expect(shown.translate).toBe('-50%');
        expect([hidden.scale, shown.scale]).toEqual(['0.95', '1']);
        if (reducedMotion) {
          expect([hidden.transitionProperty, shown.transitionProperty]).toEqual(['none', 'none']);
        } else {
          expect(hidden).toMatchObject({
            transitionProperty: 'translate, scale, opacity',
            transitionDuration: '0.4s',
          });
          expect(shown).toMatchObject({
            transitionProperty: 'translate, scale, opacity',
            transitionDuration: '0.2s',
          });
        }
      } finally {
        await page.close();
      }
    },
  );

  /**
   * 浮鈕的避讓（`hooks/use-scroll-button-clearance.ts`，#1295）在浮鈕位移之後還對（#1687 驗收 C3）。浮鈕從藏著的位置
   * （往下一整個身高、縮 .95）過渡到出現的位置，hook 在過渡途中量到的是途中的框；它要在 `transitionend` 時重量，最後的
   * `data-obscuring` 才對得上終點的框。reduced-motion 下沒有過渡，靠捲動那次重量就量到終點：primitive 的 `data-active` 在 scroll
   * 事件之前就翻好（`@shadcn/react` 0.3.1 實測）；升 primitive 之後翻轉時機變了，reduced-motion 那一格會紅。
   *
   * 做法：先記下藏著與出現兩個框，在對話內容裡挑一個「壓得到出現的框、壓不到藏著的框」的元素標成要讓開的目標，
   * 再捲一次回頂端。平常的那一格先自檢：過渡暫停在 0 的框與 `finish()` 之後的框，用 `obscures()` 算出來的結論不同
   * （不然拿掉 `transitionend` 也不會紅）；再等兩幀讓 hook 的 rAF 跑完，讀 `data-obscuring`。
   */
  test.each([false, true])(
    '浮鈕過渡到終點之後，data-obscuring 照終點的框算（#1687 C3；reduced-motion %s）',
    async (reducedMotion) => {
      const page = await openMessages(reducedMotion);
      try {
        const hiddenBox = await page.$eval(SCROLL_BUTTON, (el) =>
          el.getBoundingClientRect().toJSON(),
        );
        await scrollMessages(page, 'top');
        // 挑目標：內容裡壓得到出現的框、壓不到藏著的框的元素（餘裕同 hook 的 4px）。
        const picked = await page.$eval(
          '[data-slot="message-scroller-viewport"]',
          (viewport, hidden) => {
            const button = viewport.parentElement!.querySelector(
              '[data-slot="message-scroller-button"]',
            )!;
            const shown = button.getBoundingClientRect();
            const hit = (a: DOMRect | typeof hidden, b: DOMRect) =>
              a.left < b.right + 4 &&
              b.left < a.right + 4 &&
              a.top < b.bottom + 4 &&
              b.top < a.bottom + 4;
            const target = [
              ...viewport.querySelectorAll<HTMLElement>('[data-slot="message-scroller-content"] *'),
            ]
              .reverse()
              .find((el) => {
                const box = el.getBoundingClientRect();
                return box.height > 0 && hit(shown, box) && !hit(hidden, box);
              });
            target?.setAttribute('data-scroll-button-avoid', '');
            return target !== undefined;
          },
          hiddenBox,
        );
        // 量具自檢：版面上挑得到這樣的目標。
        expect(picked).toBe(true);
        await scrollMessages(page, 'end');
        const measured = await page.$eval(
          '[data-slot="message-scroller-viewport"]',
          async (viewport, reduced) => {
            const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
            const button = viewport.parentElement!.querySelector<HTMLElement>(
              '[data-slot="message-scroller-button"]',
            )!;
            const target = viewport.querySelector('[data-scroll-button-avoid]')!;
            const hit = (a: DOMRect) => {
              const b = target.getBoundingClientRect();
              return (
                a.left < b.right + 4 &&
                b.left < a.right + 4 &&
                a.top < b.bottom + 4 &&
                b.top < a.bottom + 4
              );
            };
            viewport.scrollTop = 0;
            for (let i = 0; i < 120 && button.getAttribute('data-active') !== 'true'; i++)
              await frame();
            // 讓 hook 因捲動而排的那次重量先跑完（量到的是過渡剛開始的框），再把過渡推到終點：
            // 這樣終點要靠 `transitionend` 才量得到，拿掉它會紅。
            await frame();
            await frame();
            let start: boolean | undefined;
            if (!reduced) {
              const transitions = button.getAnimations();
              for (const t of transitions) {
                t.pause();
                t.currentTime = 0;
              }
              start = hit(button.getBoundingClientRect());
              for (const t of transitions) t.finish();
            }
            const end = hit(button.getBoundingClientRect());
            await frame();
            await frame();
            return {
              active: button.getAttribute('data-active'),
              start,
              end,
              obscuring: button.hasAttribute('data-obscuring'),
            };
          },
          reducedMotion,
        );
        report[`messages:clearance:${reducedMotion ? 'reduced' : 'normal'}`] = measured;
        expect(measured.active).toBe('true');
        expect(measured.end).toBe(true);
        // 自檢：過渡的起點與終點，壓不壓得到的結論不同。
        if (!reducedMotion) expect(measured.start).toBe(false);
        expect(measured.obscuring).toBe(measured.end);
      } finally {
        await page.close();
      }
    },
  );

  test('外殼的行高是 SG 的 text-sm（20px），泡泡由呼叫端維持 text-body（23px）', async () => {
    const page = await openMessages();
    try {
      const measured = await page.$eval('[data-testid="ai-entry"]', (el) => ({
        shell: getComputedStyle(el).lineHeight,
        bubble: getComputedStyle(el.querySelector('[data-slot="bubble-content"]')!).lineHeight,
      }));
      report['messages:line-height'] = measured;
      expect(measured).toEqual({ shell: '20px', bubble: '23px' });
    } finally {
      await page.close();
    }
  });

  test.each([false, true])(
    '底部淡出（scroll-fade-b，Q8 照 SG）捲到底時收成 0、往上捲才出現（reduced-motion %s）',
    async (reducedMotion) => {
      const page = await openMessages(reducedMotion);
      try {
        // 淡出的寬度由 scroll-driven 的 `scroll-fade-reveal-b` 帶：進度 1 是收成 0px，0 是整段（12%、最多 40px）。
        const read = () =>
          page.$eval('[data-slot="message-scroller-viewport"]', (el) => {
            const reveal = el
              .getAnimations()
              .find((a) => (a as CSSAnimation).animationName === 'scroll-fade-reveal-b');
            return {
              progress: reveal?.effect?.getComputedTiming().progress ?? null,
              value: getComputedStyle(el).getPropertyValue('--scroll-fade-b'),
            };
          });
        const end = await read();
        await scrollMessages(page, 'top');
        const top = await read();
        report[`messages:scroll-fade:${reducedMotion ? 'reduced' : 'normal'}`] = { end, top };
        expect(end.progress).toBe(1);
        expect(top.progress).toBe(0);
      } finally {
        await page.close();
      }
    },
  );
});

describe.each(['light', 'dark'] as const)('瀏覽器量問答與附件（#1638 PR C）：%s', (theme) => {
  test('問答選項聚焦：外框 2px、offset 2px 畫在選項上（本地修改第 46 條；外框顏色、box-shadow 不變由上面的浮層那組量）', async () => {
    const page = await openOverlay('questionnaire', theme, {
      marks: { [QUESTIONNAIRE_INPUT]: {} },
    });
    try {
      await page.keyboard.press('Tab');
      const input = page.locator(QUESTIONNAIRE_INPUT).first();
      await input.focus();
      await settle(page);
      const sample = await input.evaluate((el) => {
        const host = getComputedStyle(el.parentElement!);
        return {
          focusVisible: el.matches(':focus-visible'),
          hostSlot: el.parentElement!.getAttribute('data-slot'),
          outline: `${host.outlineStyle} ${host.outlineWidth}`,
          offset: host.outlineOffset,
        };
      });
      report[`questionnaire:${theme}:choice-outline`] = sample;
      expect(sample).toEqual({
        focusVisible: true,
        hostSlot: 'questionnaire-choice',
        outline: 'solid 2px',
        offset: '2px',
      });
    } finally {
      await page.close();
    }
  });

  test('附件的按鈕不管鍵盤或滑鼠聚焦，外殼都不出 ring（vendor 的 `focus-within:ring-1` 被 SG 的玻璃規則蓋掉；偏離 Q7 字面、PM 同意）', async () => {
    const page = await openOverlay('attachments', theme, { marks: { [ATTACHMENT_BUTTONS]: {} } });
    try {
      const buttons = page.locator(ATTACHMENT_BUTTONS);
      const count = await buttons.count();
      const read = (i: number) =>
        buttons.nth(i).evaluate((el) => {
          const shell = el.closest('[data-slot="attachment"]')!;
          return {
            name: el.getAttribute('aria-label') ?? '',
            shadow: getComputedStyle(shell).boxShadow,
            focusWithin: shell.matches(':focus-within'),
            focusVisible: el.matches(':focus-visible'),
          };
        });
      const samples = [];
      for (let i = 0; i < count; i++) {
        const button = buttons.nth(i);
        await button.evaluate((el) => (el as HTMLElement).blur());
        await page.mouse.move(0, 0);
        await settle(page);
        const rest = await read(i);
        await page.keyboard.press('Shift');
        await button.focus();
        await settle(page);
        const keyboard = await read(i);
        await button.evaluate((el) => (el as HTMLElement).blur());
        // 滑鼠：按下就聚焦；移開再放開，不觸發 click（看原圖會開 modal）。
        await button.hover({ force: true });
        await page.mouse.down();
        await settle(page);
        const mouse = await read(i);
        await page.mouse.move(0, 0);
        await page.mouse.up();
        samples.push({ name: rest.name, rest, keyboard, mouse });
      }
      report[`attachments:${theme}:shell-ring`] = samples;
      // 量具自檢：六顆都量到，鍵盤那次是 :focus-visible、滑鼠那次不是，兩次外殼都是 :focus-within。
      expect(samples).toHaveLength(6);
      expect(
        samples.filter(
          (s) =>
            !s.keyboard.focusVisible ||
            s.mouse.focusVisible ||
            !s.keyboard.focusWithin ||
            !s.mouse.focusWithin,
        ),
      ).toEqual([]);
      expect(
        samples
          .filter(
            (s) =>
              !sameShadow(s.rest.shadow, s.keyboard.shadow) ||
              !sameShadow(s.rest.shadow, s.mouse.shadow),
          )
          .map((s) => `${s.name}：${s.rest.shadow} → ${s.keyboard.shadow}／${s.mouse.shadow}`),
      ).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test('一排附件左右淡出：放得下時兩邊都不淡；放不下時捲在頭只淡尾、捲到尾只淡頭（Q8 照 SG；退路見本地修改第 47 條）', async () => {
    const page = await openOverlay('attachments', theme, { marks: { '[data-guard-rail]': {} } });
    try {
      const fade = (rail: string, to: 'start' | 'end') =>
        page.$eval(
          `[data-guard-rail="${rail}"] [data-slot="attachment-group"]`,
          async (el, end) => {
            const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
            el.scrollLeft = end ? el.scrollWidth : 0;
            for (let i = 0; i < 10; i++) await frame();
            // 計算值是 `calc(…)` 字串，放進一個跟它一樣寬的盒子裡解成像素。
            const style = getComputedStyle(el);
            const box = document.createElement('div');
            box.style.cssText = `position:absolute;visibility:hidden;width:${el.clientWidth}px`;
            const probe = document.createElement('div');
            box.append(probe);
            document.body.append(box);
            const px = (value: string) => {
              probe.style.width = value;
              return probe.getBoundingClientRect().width;
            };
            const result = {
              overflows: el.scrollWidth > el.clientWidth,
              start: px(style.getPropertyValue('--scroll-fade-s')),
              end: px(style.getPropertyValue('--scroll-fade-e')),
            };
            box.remove();
            return result;
          },
          to === 'end',
        );
      const fits = await fade('fits', 'start');
      const head = await fade('overflows', 'start');
      const tail = await fade('overflows', 'end');
      report[`attachments:${theme}:scroll-fade`] = { fits, head, tail };
      expect(fits).toEqual({ overflows: false, start: 0, end: 0 });
      expect(head).toMatchObject({ overflows: true, start: 0 });
      expect(head.end).toBeGreaterThan(0);
      expect(tail).toMatchObject({ overflows: true, end: 0 });
      expect(tail.start).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });

  test('上傳中的標題 shimmer：漸層每個色標對底色都過 4.5（亮色由本地修改第 48 條換掉亮面）', async () => {
    const page = await openOverlay('attachments', theme, {
      marks: { '[data-slot="attachment"][data-state="uploading"]': {} },
    });
    try {
      const titles = await page.$$eval(
        '[data-slot="attachment"][data-state="uploading"] [data-slot="attachment-title"]',
        (els) =>
          els.map((el) => {
            const own = getComputedStyle(el);
            // 漸層畫在標題自己身上、只透過字露出來：底色從上一層開始疊；自己那層只帶 opacity。
            const chain = [
              {
                backgroundColor: 'rgba(0, 0, 0, 0)',
                backgroundImage: 'none',
                opacity: own.opacity,
              },
            ];
            for (let node = el.parentElement; node !== null; node = node.parentElement) {
              const style = getComputedStyle(node);
              chain.push({
                backgroundColor: style.backgroundColor,
                backgroundImage: style.backgroundImage,
                opacity: style.opacity,
              });
            }
            return {
              name: el.textContent ?? '',
              fill: own.webkitTextFillColor,
              animation: own.animationName,
              image: own.backgroundImage,
              chain,
            };
          }),
      );
      const measured = titles.map((t) => {
        const stops = [...t.image.matchAll(/(?:oklch|oklab|rgba?)\([^)]*\)/g)].map((m) => m[0]);
        const ratios = stops.map((stop) => ({ stop, ...worstOn(stop, t.chain) }));
        const worst = ratios.reduce((a, b) => (b.ratio < a.ratio ? b : a));
        return {
          name: t.name,
          fill: t.fill,
          animation: t.animation,
          stops: ratios.map((r) => `${r.stop} ${round(r.ratio)}`),
          worst: round(worst.ratio),
          on: worst.on,
        };
      });
      report[`attachments:${theme}:shimmer`] = measured;
      // 量具自檢：兩張上傳中的卡都量到，字真的是透明的、顏色來自五個色標的漸層、動畫在跑。
      expect(measured.map((m) => m.name)).toEqual(['上傳中.csv', '不知道大小.txt']);
      for (const m of measured) {
        expect(m).toMatchObject({ fill: 'rgba(0, 0, 0, 0)', animation: 'tw-shimmer' });
        expect(m.stops).toHaveLength(5);
      }
      expect(
        measured
          .filter((m) => !(m.worst >= TEXT_MIN))
          .map((m) => `${m.name} ${m.worst}（${m.on}）`),
      ).toEqual([]);
    } finally {
      await page.close();
    }
  });
});

/**
 * SG 的 tool-steps（#1682 PR A，`?overlay=tool-steps`）：README 本地修改第 61–65 條的覆寫真的命中 vendor 畫出來的元素，
 * 字與焦點過門檻。vendor 元件掛不了屬性，開頁後補。
 */
const TOOL_GROUP = '[data-guard-tool="group"]';
const TOOL_STANDALONE = '[data-guard-tool="standalone"]';
const toolStepsMarks: Record<string, Record<string, string>> = {
  [`${TOOL_GROUP} [data-slot="step-row"] > button > span`]: {
    'data-guard-text': 'tool-step-label',
  },
  [`${TOOL_GROUP} [data-slot="step-group"] > button > span`]: {
    'data-guard-text': 'tool-group-label',
  },
  [`[data-guard-tool] [data-slot="output-block"] > div`]: {
    'data-guard-text': 'tool-output-label',
  },
  [`[data-guard-tool] [data-slot="output-block"] > pre`]: {
    'data-guard-text': 'tool-output-text',
    'data-guard-focus': 'tool-output',
  },
  [`[data-guard-tool] [data-slot="output-block"]`]: { 'data-guard-outline-host': '' },
};

describe.each(['light', 'dark'] as const)('瀏覽器量 tool-steps（#1682）：%s', (theme) => {
  test('列與群組的字、結果框的標題與內文過 4.5；結果框聚焦時外框畫在外層（第 62 條）', async () => {
    const page = await openOverlay('tool-steps', theme, { marks: toolStepsMarks });
    try {
      const texts = await collectTexts(page);
      const focus = await collectFocus(page);
      const offsets = await page.$$eval('[data-guard-tool] [data-slot="output-block"]', (els) =>
        els.map((el) => {
          (el.querySelector('pre') as HTMLElement).focus();
          return getComputedStyle(el).outlineOffset;
        }),
      );
      report[`tool-steps:${theme}:outline-offset`] = offsets;
      // 量具自檢：群組裡三列、群組那一列、展開的結果框（群組裡完成的參數與結果、失敗的錯誤，單獨那列的參數與結果）都量到。
      expect(texts.filter((t) => t.name === 'tool-step-label')).toHaveLength(3);
      expect(texts.filter((t) => t.name === 'tool-group-label')).toHaveLength(1);
      expect(texts.filter((t) => t.name === 'tool-output-text')).toHaveLength(5);
      expect(focus).toHaveLength(5);
      expectTexts(
        texts,
        ['tool-step-label', 'tool-group-label', 'tool-output-label', 'tool-output-text'],
        `tool-steps:${theme}`,
      );
      expectFocus(focus, `tool-steps:${theme}`);
      expect(offsets).toEqual(Array(5).fill('2px'));
    } finally {
      await page.close();
    }
  });
});

describe('瀏覽器量 tool-steps 的覆寫（#1682，第 61、63、64、65 條）', () => {
  test('第 61 條：執行中那一列掛著 vendor 的 animate-pulse，但 animation-name 是 none', async () => {
    const page = await openOverlay('tool-steps', 'light', { marks: { [TOOL_GROUP]: {} } });
    try {
      const rows = await page.$$eval(`${TOOL_GROUP} [data-slot="step-row"] > button`, (els) =>
        els.map((el) => ({
          pulse: el.classList.contains('animate-pulse'),
          animation: getComputedStyle(el).animationName,
        })),
      );
      report['tool-steps:pulse'] = rows;
      // 量具自檢：真的有一列帶 vendor 的 class（執行中那一列）。
      expect(rows.filter((r) => r.pulse)).toHaveLength(1);
      expect(rows.map((r) => r.animation)).toEqual(['none', 'none', 'none']);
    } finally {
      await page.close();
    }
  });

  test.each([
    [375, true],
    [1280, false],
  ] as const)('第 63 條：%i 寬時列與群組那一列的按鈕至少 44px：%s', async (width, touch) => {
    const page = await openOverlay('tool-steps', 'light', {
      viewport: { width, height: 900 },
      marks: { [TOOL_GROUP]: {} },
    });
    try {
      const heights = await page.$$eval(
        `${TOOL_GROUP} :is([data-slot="step-row"], [data-slot="step-group"]) > button`,
        (els) => els.map((el) => el.getBoundingClientRect().height),
      );
      report[`tool-steps:height:${width}`] = heights;
      expect(heights).toHaveLength(4);
      // 1280 寬照 SG（一行字高）：量具自檢，44px 不是本來就有的。
      for (const h of heights) expect(h >= 44).toBe(touch);
    } finally {
      await page.close();
    }
  });

  test.each([
    [true, '0s'],
    [false, 'not-0s'],
  ] as const)('第 64 條：減少動態（%s）時箭頭的轉場時長', async (reducedMotion, expected) => {
    const page = await openOverlay('tool-steps', 'light', {
      reducedMotion,
      marks: { [TOOL_GROUP]: {} },
    });
    try {
      const durations = await page.$$eval(
        `${TOOL_GROUP} :is([data-slot="step-row"], [data-slot="step-group"]) > button > svg`,
        (els) => els.map((el) => getComputedStyle(el).transitionDuration),
      );
      report[`tool-steps:chevron:${reducedMotion ? 'reduce' : 'normal'}`] = durations;
      expect(durations).toHaveLength(4);
      for (const d of durations) expect(d === '0s' ? '0s' : 'not-0s').toBe(expected);
    } finally {
      await page.close();
    }
  });

  test('第 65 條：疊在清單裡的結果框沒有 backdrop-filter；清單本身與單獨放的結果框照 SG 有', async () => {
    const page = await openOverlay('tool-steps', 'light', {
      marks: { [TOOL_GROUP]: {}, [TOOL_STANDALONE]: {} },
    });
    try {
      const filter = (selector: string) =>
        page.$$eval(selector, (els) => els.map((el) => getComputedStyle(el).backdropFilter));
      const measured = {
        nested: await filter(`${TOOL_GROUP} [data-slot="step-list"] [data-slot="output-block"]`),
        list: await filter(`${TOOL_GROUP} [data-slot="step-list"]`),
        standalone: await filter(`${TOOL_STANDALONE} [data-slot="output-block"]`),
      };
      report['tool-steps:backdrop'] = measured;
      expect(measured.nested).toEqual(['none', 'none', 'none']);
      expect(measured.list).toHaveLength(1);
      expect(measured.standalone).toHaveLength(2);
      for (const f of [...measured.list, ...measured.standalone]) expect(f).toMatch(/blur\(/);
    } finally {
      await page.close();
    }
  });
});

/**
 * 產品的工具卡與工具段（#1682 PR B 驗收 C，`?overlay=tool-cards`）：三種底上的字都過 4.5——列的字疊在頁面底色與漸層上（單獨的卡，含背景子代理的狀態字）、
 * 疊在 `StepList` 的 `--panel` 上（段裡的卡）、結果框的標題與內文、錯誤框的紅字、Badge；列、群組、結果框的焦點是 2px 字色外框。
 * 亮暗加兩種不透明退路都量。vendor 元件掛不了屬性，開頁後補。
 */
const CARDS = '[data-guard-cards]';
const toolCardsMarks: Record<string, Record<string, string>> = {
  [`${CARDS} > [data-testid="tool-entry"] [data-slot="step-row"] > button > span:first-child`]: {
    'data-guard-text': 'card-label-page',
  },
  [`${CARDS} [data-slot="step-list"] [data-slot="step-row"] > button > span:first-child`]: {
    'data-guard-text': 'card-label-panel',
  },
  [`${CARDS} [data-slot="step-group"] > button > span`]: { 'data-guard-text': 'run-label' },
  [`${CARDS} [data-slot="step-row"] > button > [data-slot="badge"]`]: {
    'data-guard-text': 'card-badge',
  },
  [`${CARDS} [data-slot="step-row"] > button > code`]: { 'data-guard-text': 'card-code' },
  [`${CARDS} [data-slot="step-row"] > button > span > [data-slot="badge"]`]: {
    'data-guard-text': 'card-attribution',
  },
  [`${CARDS} [data-slot="output-block"] > div`]: { 'data-guard-text': 'card-output-label' },
  [`${CARDS} [data-slot="output-block"] > pre`]: {
    'data-guard-text': 'card-output-text',
    'data-guard-focus': 'card-output',
  },
  [`${CARDS} [data-slot="output-block"]`]: { 'data-guard-outline-host': '' },
  [`${CARDS} [data-subagent-state]`]: { 'data-guard-text': 'card-subagent-state' },
  [`${CARDS} [data-testid="tool-entry"] p.text-destructive`]: {
    'data-guard-text': 'card-max-tokens',
  },
  [`${CARDS} :is([data-slot="step-row"], [data-slot="step-group"]) > button:not(:disabled)`]: {
    'data-guard-focus': 'card-button',
  },
};

describe.each(
  MODES.flatMap((mode) => (['light', 'dark'] as const).map((theme) => [mode, theme] as const)),
)('瀏覽器量產品的工具卡（#1682 PR B）：%s、%s', (mode, theme) => {
  test('頁面、清單、結果框三種底上的字與 Badge 過 4.5；錯誤框的紅字也過；列、群組、結果框的焦點', async () => {
    const page = await openOverlay('tool-cards', theme, { mode, marks: toolCardsMarks });
    try {
      const texts = await collectTexts(page);
      const focus = await collectFocus(page);
      const count = (name: string) => texts.filter((t) => t.name === name).length;
      // 量具自檢：單獨的卡 8 張、段裡 2 張、群組 1 列；Badge 10 顆；結果框（段裡展開那張的參數與結果、完成那張的參數與結果、
      // 失敗那張的參數與錯誤、撞到上限那張的參數）7 個，其中錯誤框 1 個；背景子代理的「跑著」1 個、撞到上限那段紅字說明 1 段
      // （#1682 審查：它直接疊在頁面底色上）。
      const names = [
        'card-label-page',
        'card-label-panel',
        'run-label',
        'card-badge',
        'card-output-text',
        'card-code',
        'card-attribution',
        'card-subagent-state',
        'card-max-tokens',
      ];
      expect(Object.fromEntries(names.map((name) => [name, count(name)]))).toEqual({
        'card-label-page': 8,
        'card-label-panel': 2,
        'run-label': 1,
        'card-badge': 10,
        'card-output-text': 7,
        'card-code': 10,
        'card-attribution': 1,
        'card-subagent-state': 1,
        'card-max-tokens': 1,
      });
      const error = await page.$$eval(
        `${CARDS} [data-slot="output-block"] > pre`,
        (els) => els.filter((el) => el.className.includes('text-destructive')).length,
      );
      expect(error).toBe(1);
      expectTexts(
        texts,
        [
          'card-label-page',
          'card-label-panel',
          'run-label',
          'card-badge',
          'card-output-label',
          'card-output-text',
          'card-code',
          'card-attribution',
          'card-subagent-state',
          'card-max-tokens',
        ],
        `tool-cards:${mode}:${theme}`,
      );
      expect(focus.filter((f) => f.name.startsWith('card-button'))).toHaveLength(11);
      expectFocus(focus, `tool-cards:${mode}:${theme}`);
    } finally {
      await page.close();
    }
  });
});

test('0019：結果框的 pre 鍵盤聚焦後，方向鍵捲得動（#1682 PR B）', async () => {
  const page = await openOverlay('tool-steps', 'light', { marks: { [TOOL_STANDALONE]: {} } });
  try {
    const pre = page.locator(`${TOOL_STANDALONE} [data-slot="output-block"]:last-child > pre`);
    // 鍵盤操作過，聚焦才算 `:focus-visible`；Tab 走到那一格。
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      if (await pre.evaluate((el) => el === document.activeElement)) break;
    }
    const before = await pre.evaluate((el) => ({
      focused: el === document.activeElement,
      scrollTop: el.scrollTop,
      overflow: el.scrollHeight > el.clientHeight,
    }));
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
    // 鍵盤捲動是平滑捲動，等它停下來。
    await page
      .waitForFunction((el) => el !== null && el.scrollTop > 0, await pre.elementHandle(), {
        timeout: 2000,
      })
      .catch(() => undefined);
    const after = await pre.evaluate((el) => el.scrollTop);
    report['tool-steps:arrow-scroll'] = { ...before, after };
    // 量具自檢：真的超出框高、真的停在那一格上。
    expect(before).toEqual({ focused: true, scrollTop: 0, overflow: true });
    expect(after).toBeGreaterThan(0);
  } finally {
    await page.close();
  }
});

test('第 66 條：工具段裡空的那一則不留空格，清單頂端就是第一張卡（#1682 PR B）', async () => {
  const page = await openOverlay('tool-cards', 'light', {
    marks: { [`${CARDS} [data-slot="step-list"]`]: {} },
  });
  try {
    const measured = await page.$eval(`${CARDS} [data-slot="step-list"]`, (list) => {
      const top = list.getBoundingClientRect().top;
      const cells = [...list.children].map((cell) => ({
        display: getComputedStyle(cell).display,
        card: cell.querySelector('[data-slot="step-row"]') !== null,
        empty: cell.querySelector('[data-slot="message-scroller-item"]:empty') !== null,
      }));
      const card = list.querySelector('[data-slot="step-row"]');
      return { cells, gap: card === null ? -1 : card.getBoundingClientRect().top - top };
    });
    report['tool-cards:empty-cell'] = measured;
    // 量具自檢：段首真的有一格空的（guard 頁放了只有思考的那一步）。
    expect(measured.cells).toEqual([
      { display: 'none', card: false, empty: true },
      { display: 'block', card: true, empty: false },
      { display: 'block', card: true, empty: false },
    ]);
    // 第一張卡離清單頂端只有它自己那格的上 padding（`py-1.5`）加邊線，空格在的時候多一整格。
    expect(measured.gap).toBeGreaterThan(0);
    expect(measured.gap).toBeLessThanOrEqual(8);
  } finally {
    await page.close();
  }
});

/**
 * 推理列（#1683，`?overlay=reasoning`）：SG 的 `Reasoning` 接上產品的轉接層。三塊：講完的一列（`done`）、還在想的一列（`running`，
 * 摘要很長）、工具段裡的一列（`panel`，疊在 `StepList` 的 `--panel` 上）。vendor 元件掛不了屬性，開頁後補。
 * 標題、「·」、摘要量收著的時候；內文（段落、清單、粗體、連結、行內 code）打開 `done` 與 `panel` 再量。
 */
const REASONING_ROWS = '[data-guard-reasoning]';
const reasoningIn = (block: 'done' | 'running' | 'panel') =>
  `[data-guard-reasoning="${block}"] [data-slot="reasoning"]`;
/** 收著時看得見的（標題、「·」、摘要、summary 的焦點）交給 `openOverlay` 等；內文收著時看不見，打開之後才補標記（`markReasoningBody`）。 */
const reasoningMarks: Record<string, Record<string, string>> = Object.fromEntries(
  (
    [
      ['done', 'page'],
      ['running', 'page'],
      ['panel', 'panel'],
    ] as const
  ).flatMap(([block, on]) => {
    const row = reasoningIn(block);
    return [
      [`${row} > summary`, { 'data-guard-focus': `reasoning-summary-${block}` }],
      [`${row} > summary > span:nth-child(2)`, { 'data-guard-text': `reasoning-dot-${on}` }],
      [
        `${row} [data-testid="reasoning-summary"]`,
        { 'data-guard-text': `reasoning-trailing-${on}` },
      ],
      ...(block === 'running'
        ? []
        : [
            [`${row} > summary > span:first-child`, { 'data-guard-text': `reasoning-title-${on}` }],
          ]),
    ];
  }),
);
const REASONING_BODY = ['body', 'li', 'strong', 'link', 'code'];
const markReasoningBody = (page: Page) =>
  page.evaluate((parts) => {
    const tags: Record<string, string> = {
      body: 'p',
      li: 'li',
      strong: 'strong',
      link: 'a',
      code: 'code',
    };
    for (const [block, on] of [
      ['done', 'page'],
      ['panel', 'panel'],
    ]) {
      const row = document.querySelector(
        `[data-guard-reasoning="${block}"] [data-slot="reasoning"]`,
      )!;
      for (const part of parts)
        for (const el of row.querySelectorAll(`.markdown ${tags[part]}`))
          el.setAttribute('data-guard-text', `reasoning-${part}-${on}`);
    }
  }, REASONING_BODY);
const openReasoningRows = (page: Page, blocks: ('done' | 'running' | 'panel')[]) =>
  page.evaluate((selectors) => {
    for (const selector of selectors)
      document.querySelector<HTMLDetailsElement>(selector)!.open = true;
  }, blocks.map(reasoningIn));
const REASONING_HEAD = ['title', 'dot', 'trailing'];

describe.each(
  MODES.flatMap((mode) => (['light', 'dark'] as const).map((theme) => [mode, theme] as const)),
)('瀏覽器量推理列（#1683）：%s、%s', (mode, theme) => {
  test('頁面與 --panel 兩種底上的標題、「·」、摘要、內文（段落、清單、粗體、連結、行內 code）過 4.5；summary 的焦點（外框 offset 2px）', async () => {
    const page = await openOverlay('reasoning', theme, { mode, marks: reasoningMarks });
    try {
      const head = (await collectTexts(page)).filter((t) =>
        REASONING_HEAD.some((part) => t.name.startsWith(`reasoning-${part}-`)),
      );
      const focus = await collectFocus(page);
      // 外框離 summary 2px（覆寫檔 base layer 那條 `:focus-visible` 的 offset；collectFocus 不量 offset）。
      const offsets = await page.$$eval(
        `${REASONING_ROWS} [data-slot="reasoning"] > summary`,
        (els) =>
          els.map((el) => {
            (el as HTMLElement).focus();
            return {
              focusVisible: el.matches(':focus-visible'),
              offset: getComputedStyle(el).outlineOffset,
            };
          }),
      );
      report[`reasoning:${mode}:${theme}:outline-offset`] = offsets;
      expect(offsets).toEqual(Array(3).fill({ focusVisible: true, offset: '2px' }));
      await openReasoningRows(page, ['done', 'panel']);
      await settle(page);
      await markReasoningBody(page);
      const body = (await collectTexts(page)).filter((t) =>
        REASONING_BODY.some((part) => t.name.startsWith(`reasoning-${part}-`)),
      );
      const count = (texts: TextSample[]) =>
        Object.fromEntries(
          [...new Set(texts.map((t) => t.name))].map((name) => [
            name,
            texts.filter((t) => t.name === name).length,
          ]),
        );
      // 量具自檢：收著時兩種底上的標題、三列的「·」與摘要；打開後兩種底上的兩段、兩項清單、粗體、連結、行內 code 都量到。
      expect(count(head)).toEqual({
        'reasoning-title-page': 1,
        'reasoning-title-panel': 1,
        'reasoning-dot-page': 2,
        'reasoning-dot-panel': 1,
        'reasoning-trailing-page': 2,
        'reasoning-trailing-panel': 1,
      });
      expect(count(body)).toEqual(
        Object.fromEntries(
          ['page', 'panel'].flatMap((on) => [
            [`reasoning-body-${on}`, 2],
            [`reasoning-li-${on}`, 2],
            [`reasoning-strong-${on}`, 1],
            [`reasoning-link-${on}`, 1],
            [`reasoning-code-${on}`, 1],
          ]),
        ),
      );
      expectTexts(
        [...head, ...body],
        Object.keys(count([...head, ...body])),
        `reasoning:${mode}:${theme}`,
      );
      expect(focus.map((f) => f.name)).toEqual([
        'reasoning-summary-done-0',
        'reasoning-summary-running-0',
        'reasoning-summary-panel-0',
      ]);
      expectFocus(focus, `reasoning:${mode}:${theme}`);
    } finally {
      await page.close();
    }
  });
});

describe.each(['light', 'dark'] as const)('瀏覽器量推理列的「思考中」（#1683）：%s', (theme) => {
  const TITLE = `${reasoningIn('running')} > summary > span:first-child`;
  const readTitle = (page: Page) =>
    page.$eval(TITLE, (el) => {
      const own = getComputedStyle(el);
      // 漸層畫在標題自己身上、只透過字露出來：底色從上一層開始疊；自己那層只帶 opacity。
      const chain = [
        { backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none', opacity: own.opacity },
      ];
      for (let node = el.parentElement; node !== null; node = node.parentElement) {
        const style = getComputedStyle(node);
        chain.push({
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          opacity: style.opacity,
        });
      }
      return {
        name: el.textContent ?? '',
        shimmer: el.classList.contains('status-shimmer'),
        color: own.color,
        clip: own.backgroundClip,
        image: own.backgroundImage,
        animation: `${own.animationName} ${own.animationDuration}`,
        chain,
      };
    });

  test('平常：SG 的 status-shimmer（sg-status-shimmer 2.4s），漸層每個色標對底色都過 4.5', async () => {
    const page = await openOverlay('reasoning', theme, { marks: { [TITLE]: {} } });
    try {
      const title = await readTitle(page);
      const stops = [...title.image.matchAll(/(?:oklch|oklab|rgba?)\([^)]*\)/g)].map((m) => m[0]);
      const ratios = stops.map((stop) => ({ stop, ...worstOn(stop, title.chain) }));
      report[`reasoning:${theme}:shimmer`] = {
        ...title,
        chain: undefined,
        stops: ratios.map((r) => `${r.stop} ${round(r.ratio)}（${r.on}）`),
      };
      // 量具自檢：字真的是透明的、顏色來自三個色標的漸層、動畫在跑。
      expect(title).toMatchObject({
        name: '思考中',
        shimmer: true,
        color: 'rgba(0, 0, 0, 0)',
        clip: 'text',
        animation: 'sg-status-shimmer 2.4s',
      });
      expect(stops).toHaveLength(3);
      expect(
        ratios
          .filter((r) => !(r.ratio >= TEXT_MIN))
          .map((r) => `${r.stop} ${round(r.ratio)}（${r.on}）`),
      ).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test('減少動態：停住、沒有漸層，字色照常過 4.5', async () => {
    const page = await openOverlay('reasoning', theme, {
      reducedMotion: true,
      marks: { [TITLE]: {} },
    });
    try {
      const title = await readTitle(page);
      const contrast = worstOn(title.color, title.chain);
      report[`reasoning:${theme}:shimmer-reduced`] = {
        ...title,
        chain: undefined,
        ratio: round(contrast.ratio),
      };
      expect(title).toMatchObject({
        name: '思考中',
        shimmer: true,
        image: 'none',
        animation: 'none 0s',
      });
      expect(contrast.ratio).toBeGreaterThanOrEqual(TEXT_MIN);
    } finally {
      await page.close();
    }
  });
});

describe('瀏覽器量推理列的行為與覆寫（#1683）', () => {
  const marks = { [REASONING_ROWS]: {} };

  test('AX 樹：三個 summary 是可展開的，名稱只有「思考過程」或「思考中」（摘要 aria-hidden 不進名稱），打開後報 expanded', async () => {
    const page = await openOverlay('reasoning', 'light', { marks });
    try {
      const cdp = await page.context().newCDPSession(page);
      const read = async () => {
        const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as {
          nodes: {
            ignored: boolean;
            role?: { value: string };
            name?: { value: string };
            properties?: { name: string; value: { value: unknown } }[];
          }[];
        };
        return nodes
          .filter((n) => !n.ignored && n.role?.value === 'DisclosureTriangle')
          .map((n) => ({
            name: n.name?.value,
            expanded: n.properties?.find((p) => p.name === 'expanded')?.value.value,
          }));
      };
      const closed = await read();
      await openReasoningRows(page, ['done', 'running', 'panel']);
      await settle(page);
      const opened = await read();
      report['reasoning:ax'] = { closed, opened };
      expect(closed).toEqual([
        { name: '思考過程', expanded: false },
        { name: '思考中', expanded: false },
        { name: '思考過程', expanded: false },
      ]);
      expect(opened.map((n) => n.expanded)).toEqual([true, true, true]);
    } finally {
      await page.close();
    }
  });

  test('推理列裡沒有 live region：推理不進 polite 區唸', async () => {
    const page = await openOverlay('reasoning', 'light', { marks });
    try {
      const live = await page.$$eval(
        `${REASONING_ROWS} [data-slot="reasoning"] :is([aria-live], [role="status"], [role="log"], [role="alert"])`,
        (els) => els.length,
      );
      const rows = await page.$$eval(
        `${REASONING_ROWS} [data-slot="reasoning"]`,
        (els) => els.length,
      );
      // 量具自檢：三列都在。
      expect(rows).toBe(3);
      expect(live).toBe(0);
    } finally {
      await page.close();
    }
  });

  test('內文的 .markdown 是 white-space: normal（轉接層那層 whitespace-normal 擋掉 SG 的 pre-wrap）', async () => {
    const page = await openOverlay('reasoning', 'light', { marks });
    try {
      const measured = await page.$eval(reasoningIn('done'), (row) => ({
        frame: getComputedStyle(row.querySelector(':scope > div')!).whiteSpace,
        markdown: getComputedStyle(row.querySelector('.markdown')!).whiteSpace,
      }));
      report['reasoning:white-space'] = measured;
      // 量具自檢：SG 的內文框真的是 pre-wrap。
      expect(measured).toEqual({ frame: 'pre-wrap', markdown: 'normal' });
    } finally {
      await page.close();
    }
  });

  test('打開後只有箭頭轉：沒有高度動效、沒有其他動畫（#1683 決定題 2）', async () => {
    const page = await openOverlay('reasoning', 'light', { marks });
    try {
      await openReasoningRows(page, ['done']);
      const animations = await page.$eval(reasoningIn('done'), (row) =>
        row.getAnimations({ subtree: true }).map((a) => ({
          kind: a.constructor.name,
          what:
            a instanceof CSSTransition
              ? a.transitionProperty
              : a instanceof CSSAnimation
                ? a.animationName
                : '',
          target: ((a.effect as KeyframeEffect | null)?.target?.tagName ?? '').toLowerCase(),
        })),
      );
      const open = await page.$eval(reasoningIn('done'), (row) => (row as HTMLDetailsElement).open);
      report['reasoning:animations'] = animations;
      expect(open).toBe(true);
      // 量具自檢：箭頭那條轉場量得到，代表打開的當下就在讀。
      expect(animations).toEqual([{ kind: 'CSSTransition', what: 'rotate', target: 'svg' }]);
    } finally {
      await page.close();
    }
  });

  test.each([
    [375, true],
    [1280, false],
  ] as const)('第 63 條（擴充）：%i 寬時 summary 至少 44px：%s', async (width, touch) => {
    const page = await openOverlay('reasoning', 'light', {
      viewport: { width, height: 900 },
      marks,
    });
    try {
      const heights = await page.$$eval(
        `${REASONING_ROWS} [data-slot="reasoning"] > summary`,
        (els) => els.map((el) => el.getBoundingClientRect().height),
      );
      report[`reasoning:height:${width}`] = heights;
      expect(heights).toHaveLength(3);
      // 1280 寬照 SG（一行字高）：量具自檢，44px 不是本來就有的。
      for (const h of heights) expect(h >= 44).toBe(touch);
    } finally {
      await page.close();
    }
  });

  test.each([
    [true, '0s'],
    [false, 'not-0s'],
  ] as const)(
    '第 64 條（擴充）：減少動態（%s）時 summary 箭頭的轉場時長',
    async (reducedMotion, expected) => {
      const page = await openOverlay('reasoning', 'light', { reducedMotion, marks });
      try {
        const durations = await page.$$eval(
          `${REASONING_ROWS} [data-slot="reasoning"] > summary > svg`,
          (els) => els.map((el) => getComputedStyle(el).transitionDuration),
        );
        report[`reasoning:chevron:${reducedMotion ? 'reduce' : 'normal'}`] = durations;
        expect(durations).toHaveLength(3);
        for (const d of durations) expect(d === '0s' ? '0s' : 'not-0s').toBe(expected);
      } finally {
        await page.close();
      }
    },
  );

  test('375 寬、還在想、摘要很長：第 70 條：summary 不超出欄寬、標題不折行，摘要往左裁、留著最新的字', async () => {
    const page = await openOverlay('reasoning', 'light', {
      viewport: { width: 375, height: 812 },
      marks,
    });
    try {
      const measured = await page.$eval('[data-guard-reasoning="running"]', (block) => {
        const summary = block.querySelector('summary')!;
        const title = summary.querySelector('span')!;
        const outer = block.querySelector('[data-testid="reasoning-summary"]')!;
        const inner = outer.firstElementChild!;
        const box = (el: Element) => el.getBoundingClientRect();
        return {
          summaryRight: box(summary).right,
          summaryHeight: box(summary).height,
          columnRight: box(block).right,
          titleHeight: box(title).height,
          titleLine: parseFloat(getComputedStyle(title).lineHeight),
          innerLeft: box(inner).left,
          outerLeft: box(outer).left,
          innerRight: box(inner).right,
          outerRight: box(outer).right,
          pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        };
      });
      report['reasoning:375-running'] = measured;
      expect(measured.summaryRight).toBeLessThanOrEqual(measured.columnRight + 0.5);
      // 第 70 條的第二個選擇器：標題不跟著摘要縮，只有一行、summary 仍是第 63 條的 44px。
      expect(measured.titleHeight).toBeLessThan(measured.titleLine * 1.5);
      expect(measured.summaryHeight).toBe(44);
      // 量具自檢：摘要真的放不下（裡面那層比外面寬、左邊被裁）。
      expect(measured.innerLeft).toBeLessThan(measured.outerLeft);
      expect(Math.abs(measured.innerRight - measured.outerRight)).toBeLessThanOrEqual(0.5);
      expect(measured.pageOverflow).toBe(false);
    } finally {
      await page.close();
    }
  });
});

// ---------- 狀態列（#1684，`?overlay=turn-status`） ----------

const STATUS_RUNNING = '[data-guard-status="running"]';
const TURN = `${STATUS_RUNNING} [data-slot="turn-status"]`;
const TURN_LABEL = `${TURN} .status-shimmer`;
const TURN_ELAPSED = `${STATUS_RUNNING} [data-testid="running-elapsed"]`;
const TURN_GLYPH = `${TURN} [data-slot="status-glyph"]`;

/** glyph 三個 circle 的 `[[cx, cy, r, opacity], …]`：vendor `draw` 每幀改這四個（同 `scripts/measure-frames.mjs`）。 */
const readPose = (page: Page) =>
  page.$$eval(`${TURN_GLYPH} circle`, (circles) =>
    circles.map((c) => ['cx', 'cy', 'r', 'opacity'].map((a) => c.getAttribute(a) ?? '')),
  );
const openingPoseIn = (page: Page, activity: string) =>
  page.evaluate(
    (a) => (window as unknown as { __openingPose: (a: string) => string[][] }).__openingPose(a),
    activity,
  );
const setActivity = (page: Page, activity: string) =>
  page.evaluate(
    (a) => (window as unknown as { __setTurnActivity: (a: string) => void }).__setTurnActivity(a),
    activity,
  );

/** label 的字色、漸層與往上疊的底（漸層畫在 label 自己身上、只透過字露出來，底從上一層開始疊；自己那層只帶 opacity）。 */
const readLabel = (page: Page) =>
  page.$eval(TURN_LABEL, (el) => {
    const own = getComputedStyle(el);
    const chain = [
      { backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none', opacity: own.opacity },
    ];
    for (let node = el.parentElement; node !== null; node = node.parentElement) {
      const style = getComputedStyle(node);
      chain.push({
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        opacity: style.opacity,
      });
    }
    return {
      name: el.textContent ?? '',
      color: own.color,
      clip: own.backgroundClip,
      image: own.backgroundImage,
      animation: `${own.animationName} ${own.animationDuration}`,
      mutedColor: (() => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--muted-foreground)';
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      })(),
      chain,
    };
  });

describe.each(
  MODES.flatMap((mode) => (['light', 'dark'] as const).map((theme) => [mode, theme] as const)),
)('瀏覽器量狀態列（#1684）：%s、%s', (mode, theme) => {
  test('平常：label 是 SG 的 status-shimmer（sg-status-shimmer 2.4s），三個色標對底色都過 4.5；經過時間過 4.5', async () => {
    const page = await openOverlay('turn-status', theme, {
      mode,
      marks: { [TURN_LABEL]: {}, [TURN_ELAPSED]: { 'data-guard-text': 'turn-elapsed' } },
    });
    try {
      const label = await readLabel(page);
      const stops = [...label.image.matchAll(/(?:oklch|oklab|rgba?)\([^)]*\)/g)].map((m) => m[0]);
      const ratios = stops.map((stop) => ({ stop, ...worstOn(stop, label.chain) }));
      report[`turn-status:${mode}:${theme}:shimmer`] = {
        ...label,
        chain: undefined,
        stops: ratios.map((r) => `${r.stop} ${round(r.ratio)}（${r.on}）`),
      };
      // 量具自檢：字真的是透明的、顏色來自三個色標的漸層、動畫在跑。
      expect(label).toMatchObject({
        name: '執行中…',
        color: 'rgba(0, 0, 0, 0)',
        clip: 'text',
        animation: 'sg-status-shimmer 2.4s',
      });
      expect(stops).toHaveLength(3);
      expect(
        ratios
          .filter((r) => !(r.ratio >= TEXT_MIN))
          .map((r) => `${r.stop} ${round(r.ratio)}（${r.on}）`),
      ).toEqual([]);
      const elapsed = (await collectTexts(page)).filter((t) => t.name === 'turn-elapsed');
      expect(elapsed).toHaveLength(1);
      expectTexts(elapsed, ['turn-elapsed'], `turn-status:${mode}:${theme}`);
    } finally {
      await page.close();
    }
  });

  test('減少動態：shimmer 停住、沒有漸層，字色等於 --muted-foreground、過 4.5', async () => {
    const page = await openOverlay('turn-status', theme, {
      mode,
      reducedMotion: true,
      marks: { [TURN_LABEL]: {} },
    });
    try {
      const label = await readLabel(page);
      const contrast = worstOn(label.color, label.chain);
      report[`turn-status:${mode}:${theme}:shimmer-reduced`] = {
        ...label,
        chain: undefined,
        ratio: round(contrast.ratio),
      };
      expect(label).toMatchObject({ name: '執行中…', image: 'none', animation: 'none 0s' });
      expect(label.color).toBe(label.mutedColor);
      expect(contrast.ratio).toBeGreaterThanOrEqual(TEXT_MIN);
    } finally {
      await page.close();
    }
  });
});

describe('瀏覽器量狀態列的行為（#1684）', () => {
  const onlyRunning = (page: Page) =>
    page.goto(`${page.url()}&only=running`).then(() => page.waitForSelector(TURN_GLYPH));

  test('live region 不變動：glyph 照常在動，[role="status"] 3 秒內沒有 childList／characterData 的變動', async () => {
    const page = await openOverlay('turn-status', 'light', { marks: { [TURN_GLYPH]: {} } });
    try {
      const result = await page.evaluate(
        (selector) =>
          new Promise<{ mutations: number; poses: number }>((resolve) => {
            const region = document.querySelector(`${selector} [role="status"]`)!;
            let mutations = 0;
            const observer = new MutationObserver((records) => {
              mutations += records.filter(
                (r) => r.type === 'childList' || r.type === 'characterData',
              ).length;
            });
            observer.observe(region, { childList: true, characterData: true, subtree: true });
            const poses = new Set<string>();
            const timer = setInterval(() => {
              poses.add(
                [...region.querySelectorAll('circle')]
                  .map((c) => ['cx', 'cy', 'r', 'opacity'].map((a) => c.getAttribute(a)).join(','))
                  .join(' '),
              );
            }, 250);
            setTimeout(() => {
              clearInterval(timer);
              observer.disconnect();
              resolve({ mutations, poses: poses.size });
            }, 3000);
          }),
        STATUS_RUNNING,
      );
      report['turn-status:live-region-mutations'] = result;
      // 量具自檢：這段期間 glyph 真的在動（不然「0 筆變動」是因為什麼都沒在跑）。
      expect(result.poses).toBeGreaterThan(1);
      expect(result.mutations).toBe(0);
    } finally {
      await page.close();
    }
  });

  test('AX 樹：只有一個 status 節點，讀得到的字只有「執行中…」，沒有數字；glyph 不在樹裡', async () => {
    const page = await openOverlay('turn-status', 'light', { marks: { [TURN_GLYPH]: {} } });
    try {
      await onlyRunning(page);
      await settle(page);
      const cdp = await page.context().newCDPSession(page);
      const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as {
        nodes: { ignored: boolean; role?: { value: string }; name?: { value: string } }[];
      };
      const visible = nodes.filter((n) => !n.ignored);
      const result = {
        status: visible.filter((n) => n.role?.value === 'status').length,
        texts: visible
          .filter((n) => n.role?.value === 'StaticText')
          .map((n) => n.name?.value ?? ''),
        graphics: visible
          .map((n) => n.role?.value ?? '')
          .filter((role) => /svg|graphics|image|img/i.test(role)),
      };
      report['turn-status:ax'] = result;
      // 量具自檢：經過時間真的畫出來了（aria-hidden，不在樹裡）。
      expect(await page.$eval(TURN_ELAPSED, (el) => el.textContent)).toMatch(/秒/);
      expect(result).toEqual({ status: 1, texts: ['執行中…'], graphics: [] });
    } finally {
      await page.close();
    }
  });

  test('glyph：平常在動；減少動態停在起始姿勢、1 秒內不動；換 activity 立刻跳到新的起始姿勢', async () => {
    const page = await openOverlay('turn-status', 'light', { marks: { [TURN_GLYPH]: {} } });
    try {
      const a = await readPose(page);
      await page.waitForTimeout(300);
      const b = await readPose(page);
      report['turn-status:glyph-normal'] = { a, b };
      expect(b).not.toEqual(a);
    } finally {
      await page.close();
    }
    const reduced = await openOverlay('turn-status', 'light', {
      reducedMotion: true,
      marks: { [TURN_GLYPH]: {} },
    });
    try {
      const a = await readPose(reduced);
      await reduced.waitForTimeout(1000);
      const b = await readPose(reduced);
      const thinking = await openingPoseIn(reduced, 'thinking');
      await setActivity(reduced, 'running');
      await reduced.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
      const running = await readPose(reduced);
      const expected = await openingPoseIn(reduced, 'running');
      report['turn-status:glyph-reduced'] = { a, b, thinking, running, expected };
      expect(thinking).not.toEqual(expected);
      expect([a, b]).toEqual([thinking, thinking]);
      expect(running).toEqual(expected);
    } finally {
      await reduced.close();
    }
  });

  test.each([375, 1280])(
    '高度不跳：%dpx 寬，就緒、執行中、等你回答三種狀態列一樣高',
    async (width) => {
      const page = await openOverlay('turn-status', 'light', {
        viewport: { width, height: 800 },
        marks: { '[data-guard-status]': {} },
      });
      try {
        const heights = await page.$$eval('[data-guard-status]', (els) =>
          els.map((el) => [
            el.getAttribute('data-guard-status'),
            Math.round(el.firstElementChild!.getBoundingClientRect().height * 100) / 100,
          ]),
        );
        report[`turn-status:${width}:heights`] = heights;
        expect(heights.map(([name]) => name)).toEqual(['idle', 'running', 'awaiting']);
        expect(new Set(heights.map(([, h]) => h)).size).toBe(1);
      } finally {
        await page.close();
      }
    },
  );

  test('375 寬：狀態列加經過時間不撐破欄寬、label 一行、整頁沒有橫向捲動', async () => {
    const page = await openOverlay('turn-status', 'light', {
      viewport: { width: 375, height: 800 },
      marks: { [TURN_ELAPSED]: {} },
    });
    try {
      const box = await page.evaluate(
        ({ row, label, elapsed }) => {
          const column = document.querySelector(row)!.getBoundingClientRect();
          const l = document.querySelector(label)!.getBoundingClientRect();
          const e = document.querySelector(elapsed)!.getBoundingClientRect();
          return {
            columnRight: column.right,
            elapsedRight: e.right,
            labelHeight: l.height,
            // TurnStatus 那一列是 `h-5`；label 折行就會比它高。
            rowHeight: document.querySelector(label)!.parentElement!.getBoundingClientRect().height,
            pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
          };
        },
        { row: STATUS_RUNNING, label: TURN_LABEL, elapsed: TURN_ELAPSED },
      );
      report['turn-status:375'] = box;
      expect(box.elapsedRight).toBeLessThanOrEqual(box.columnRight);
      expect(box.labelHeight).toBeLessThanOrEqual(box.rowHeight);
      expect(box.pageOverflow).toBeLessThanOrEqual(0);
    } finally {
      await page.close();
    }
  });
});

/**
 * 增刪行數（#1685 PR A 驗收 3、4，`?overlay=diff-stats`）：SG `DiffStats` 的 `+`／`−` 疊在每一種底上都過 4.5——頁面底與漸層、
 * 工具段 `StepList` 的 `--panel`、改動卡、審查頁（標頭與選檔器的清單）；亮暗加兩種不透明退路。兩色是覆寫檔第 75 條換的
 * `--success`／`--destructive`：另外比對算出來的顏色就是那兩個 token，拿掉覆寫要紅（就算 SG 的原色剛好在某一格過了 4.5）。
 * 375 寬時包裝層（第 76 條）不被擠：寬度跟 vendor 那顆單獨放著一樣。
 */
const DIFF_STATS = '[data-slot="diff-stats"] > span';
const DIFF_REVIEW = '[data-testid="changes-review"]';
const diffStatsMarks: Record<string, Record<string, string>> = {
  [`[data-guard-diffstats="page"] ${DIFF_STATS}`]: { 'data-guard-text': 'diff-page' },
  [`[data-guard-diffstats="panel"] [data-slot="step-list"] ${DIFF_STATS}`]: {
    'data-guard-text': 'diff-panel',
  },
  // 段收著那一列的合計（#1685 PR B 起 steps 帶 patch，vendor 的 `StepGroup` 畫在按鈕裡），疊在頁面底上。
  [`[data-guard-diffstats="panel"] [data-slot="step-group"] > button ${DIFF_STATS}`]: {
    'data-guard-text': 'diff-group',
  },
  [`[data-guard-diffstats="changes"] ${DIFF_STATS}`]: { 'data-guard-text': 'diff-changes' },
};

/** 點改動卡的標頭打開審查頁，再打開選檔器；兩處的 `DiffStats` 補上量具屬性。 */
async function openDiffReview(page: Page): Promise<void> {
  await page.click('[data-guard-diffstats="changes"] [data-testid="changes"] > button');
  await page.waitForSelector(`${DIFF_REVIEW} [data-slot="diff-stats"]`);
  await page.click(`${DIFF_REVIEW} [data-testid="review-file"]`);
  await page.waitForSelector(`[data-slot="popover-content"] [data-slot="diff-stats"]`);
  await settle(page);
  await page.evaluate((selector) => {
    for (const el of document.querySelectorAll(`[data-testid="changes-review"] ${selector}`))
      el.setAttribute('data-guard-text', 'diff-review');
    for (const el of document.querySelectorAll(`[data-slot="popover-content"] ${selector}`))
      el.setAttribute('data-guard-text', 'diff-review-picker');
  }, DIFF_STATS);
}

describe.each(
  MODES.flatMap((mode) => (['light', 'dark'] as const).map((theme) => [mode, theme] as const)),
)('瀏覽器量增刪行數（#1685 PR A）：%s、%s', (mode, theme) => {
  test('頁面、清單、改動卡、審查頁上的 +／− 過 4.5，顏色是 success／destructive', async () => {
    const page = await openOverlay('diff-stats', theme, {
      mode,
      marks: diffStatsMarks,
      prepare: openDiffReview,
    });
    try {
      const texts = await collectTexts(page);
      const names = [
        'diff-page',
        'diff-group',
        'diff-panel',
        'diff-changes',
        'diff-review',
        'diff-review-picker',
      ];
      // 量具自檢：頁面上 1 顆、段收著那一列的合計 1 顆、段裡寫檔那張 1 顆、改動卡標頭 1 顆加兩列（二進位那列寫字）、
      // 審查頁標頭的合計與這個檔各 1 顆、選檔器兩列；每顆兩個 span。
      expect(
        Object.fromEntries(
          names.map((name) => [name, texts.filter((t) => t.name === name).length]),
        ),
      ).toEqual({
        'diff-page': 2,
        'diff-group': 2,
        'diff-panel': 2,
        'diff-changes': 6,
        'diff-review': 4,
        'diff-review-picker': 4,
      });
      expectTexts(texts, names, `diff-stats:${mode}:${theme}`);
      // 覆寫檔第 75 條：`+` 是 `--success`、`−` 是 `--destructive`（拿一個 inline style 的探針讀 token 算出來的顏色）。
      const colors = await page.evaluate(() => {
        const probe = (token: string) => {
          const el = document.createElement('span');
          el.style.color = `var(${token})`;
          document.body.append(el);
          const color = getComputedStyle(el).color;
          el.remove();
          return color;
        };
        const success = probe('--success');
        const destructive = probe('--destructive');
        const wrong = [...document.querySelectorAll('[data-slot="diff-stats"]')].flatMap(
          (stats) => {
            const [plus, minus] = [...stats.querySelectorAll(':scope > span')];
            const pairs: [Element | undefined, string, string][] = [
              [plus, success, '+'],
              [minus, destructive, '−'],
            ];
            return pairs
              .filter(([el, want]) => el === undefined || getComputedStyle(el).color !== want)
              .map(
                ([el, want, sign]) =>
                  `${sign} ${el === undefined ? '沒有' : getComputedStyle(el).color} ≠ ${want}`,
              );
          },
        );
        return {
          success,
          destructive,
          count: document.querySelectorAll('[data-slot="diff-stats"]').length,
          wrong,
        };
      });
      report[`diff-stats:${mode}:${theme}:colors`] = colors;
      expect(colors.count).toBe(10);
      expect(colors.wrong).toEqual([]);
    } finally {
      await page.close();
    }
  });
});

test('第 76 條：375 寬時包裝層不被擠，寬度跟 vendor 那顆單獨放著一樣（#1685 PR A）', async () => {
  const page = await openOverlay('diff-stats', 'light', {
    viewport: { width: 375, height: 812 },
    marks: diffStatsMarks,
    prepare: openDiffReview,
  });
  try {
    const measured = await page.evaluate(() =>
      [...document.querySelectorAll('[data-slot="diff-stats"]')].map((stats) => {
        // 包裝層：`aria-hidden` 那層的外面（`components/ui/diff-view.tsx`）。
        const wrapper = stats.parentElement!.parentElement!;
        const alone = stats.cloneNode(true) as HTMLElement;
        const holder = document.createElement('div');
        holder.style.cssText = 'position:absolute;left:0;top:0;width:max-content;visibility:hidden';
        holder.append(alone);
        document.body.append(holder);
        const natural = alone.getBoundingClientRect().width;
        holder.remove();
        return {
          where:
            stats.closest('[data-guard-diffstats]')?.getAttribute('data-guard-diffstats') ??
            (stats.closest('[data-slot="popover-content"]') !== null ? 'picker' : 'review'),
          text: stats.textContent,
          wrapper: wrapper.getBoundingClientRect().width,
          inner: stats.getBoundingClientRect().width,
          natural,
        };
      }),
    );
    report['diff-stats:375-width'] = measured;
    // 量具自檢：十顆都量到了，而且單獨放著的寬度不是 0。
    expect(measured).toHaveLength(10);
    expect(measured.every((m) => m.natural > 0)).toBe(true);
    expect(
      measured
        .filter((m) => Math.abs(m.wrapper - m.natural) > 0.5 || Math.abs(m.inner - m.natural) > 0.5)
        .map(
          (m) =>
            `${m.where} ${m.text}：包裝層 ${round(m.wrapper)}、裡面 ${round(m.inner)}、單獨 ${round(m.natural)}`,
        ),
    ).toEqual([]);
  } finally {
    await page.close();
  }
});

/**
 * 工具卡的 diff（#1685 PR B 驗收 9、10、11，`?overlay=diff-view`）：產品的工具卡給了 `step.patch` 之後畫 SG 的 `DiffView`。
 * 每一行照開頭分成六種（`diff --git` 路徑、`@@`、新增、刪除、上下文、`... 還有 N 行沒畫`），疊在 `StepList` 裡（`group`）與單獨放在
 * 頁面上（`standalone`）各量一次；亮暗加兩種不透明退路。
 */
const DIFF_VIEW = '[data-guard-diffview] [data-slot="diff-view"]';
const DIFF_VIEW_KINDS = ['file', 'hunk', 'add', 'del', 'context', 'more'] as const;
const diffViewMarks: Record<string, Record<string, string>> = {
  '[data-guard-diffview="group"] [data-slot="diff-view"]': {},
  '[data-guard-diffview="standalone"] [data-slot="diff-view"]': {},
};

/** 每一行依開頭標上 `data-guard-text="diffview-<group|standalone>-<種類>"`。 */
async function markDiffViewLines(page: Page): Promise<void> {
  await page.evaluate((selector) => {
    for (const el of document.querySelectorAll(`${selector} > div`)) {
      const text = el.textContent ?? '';
      const where = el.closest('[data-guard-diffview]')?.getAttribute('data-guard-diffview');
      const kind = text.startsWith('diff --git ')
        ? 'file'
        : text.startsWith('@@')
          ? 'hunk'
          : text.startsWith('...')
            ? 'more'
            : text.startsWith('+')
              ? 'add'
              : text.startsWith('-')
                ? 'del'
                : 'context';
      el.setAttribute('data-guard-text', `diffview-${where}-${kind}`);
    }
  }, DIFF_VIEW);
}

describe.each(
  MODES.flatMap((mode) => (['light', 'dark'] as const).map((theme) => [mode, theme] as const)),
)('瀏覽器量工具卡的 diff（#1685 PR B）：%s、%s', (mode, theme) => {
  test('每一種行在清單裡與單獨放在頁面上都過 4.5', async () => {
    const page = await openOverlay('diff-view', theme, {
      mode,
      marks: diffViewMarks,
      prepare: markDiffViewLines,
    });
    try {
      const texts = await collectTexts(page);
      const names = (['group', 'standalone'] as const).flatMap((where) =>
        DIFF_VIEW_KINDS.map((kind) => `diffview-${where}-${kind}`),
      );
      // 量具自檢：兩處各兩張卡（改檔、寫檔），六種行都量到（`expectTexts` 檢查每個名字都在）。
      expect(await page.$$eval(DIFF_VIEW, (els) => els.length)).toBe(4);
      expectTexts(
        texts.filter((t) => t.name.startsWith('diffview-')),
        names,
        `diff-view:${mode}:${theme}`,
      );
    } finally {
      await page.close();
    }
  });
});

describe('瀏覽器量工具卡的 diff 的覆寫與焦點（#1685 PR B）', () => {
  test('第 65 條：疊在清單裡的 DiffView 沒有 backdrop-filter；單獨放的照 SG 有', async () => {
    const page = await openOverlay('diff-view', 'light', { marks: diffViewMarks });
    try {
      const filter = (selector: string) =>
        page.$$eval(selector, (els) => els.map((el) => getComputedStyle(el).backdropFilter));
      const measured = {
        nested: await filter(
          '[data-guard-diffview="group"] [data-slot="step-list"] [data-slot="diff-view"]',
        ),
        standalone: await filter('[data-guard-diffview="standalone"] [data-slot="diff-view"]'),
      };
      report['diff-view:backdrop'] = measured;
      expect(measured.nested).toEqual(['none', 'none']);
      expect(measured.standalone).toHaveLength(2);
      for (const f of measured.standalone) expect(f).toMatch(/blur\(/);
    } finally {
      await page.close();
    }
  });

  test.each(['light', 'dark'] as const)(
    'patch 0024（%s）：DiffView 停得上焦點、2px 外框沒被祖先切掉、方向鍵捲得動',
    async (theme) => {
      const page = await openOverlay('diff-view', theme, {
        marks: { ...diffViewMarks, [DIFF_VIEW]: { 'data-guard-focus': 'diff-view' } },
      });
      try {
        const focus = await collectFocus(page);
        expect(focus).toHaveLength(4);
        expectFocus(focus, `diff-view:${theme}`);
        const clipped = await page.$$eval(DIFF_VIEW, (els) =>
          els.flatMap((el, i) => {
            (el as HTMLElement).focus();
            const style = getComputedStyle(el);
            const reach = parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
            const rect = el.getBoundingClientRect();
            const out = [];
            for (let node = el.parentElement; node !== null; node = node.parentElement) {
              const s = getComputedStyle(node);
              if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
              const box = node.getBoundingClientRect();
              const left = box.left + parseFloat(s.borderLeftWidth);
              const right = box.right - parseFloat(s.borderRightWidth);
              const top = box.top + parseFloat(s.borderTopWidth);
              const bottom = box.bottom - parseFloat(s.borderBottomWidth);
              const sides = [
                rect.left - reach < left - 0.5 && s.overflowX !== 'visible' ? '左' : '',
                rect.right + reach > right + 0.5 && s.overflowX !== 'visible' ? '右' : '',
                rect.top - reach < top - 0.5 && s.overflowY !== 'visible' ? '上' : '',
                rect.bottom + reach > bottom + 0.5 && s.overflowY !== 'visible' ? '下' : '',
              ].join('');
              if (sides !== '')
                out.push(
                  `#${i} 被 ${node.tagName}[${node.getAttribute('data-slot') ?? ''}] 切掉（${sides}）`,
                );
            }
            return out;
          }),
        );
        report[`diff-view:${theme}:clipped`] = clipped;
        expect(clipped).toEqual([]);

        // 寫檔那張的行很寬、行數超過 max-h-80：鍵盤聚焦後方向鍵橫向與直向都捲得動。
        const wide = page
          .locator('[data-guard-diffview="standalone"] [data-slot="diff-view"]')
          .nth(1);
        await wide.focus();
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowDown');
        await page.waitForFunction(
          (el) => el !== null && el.scrollLeft > 0 && el.scrollTop > 0,
          await wide.elementHandle(),
        );
        const scrolled = await wide.evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop }));
        report[`diff-view:${theme}:scrolled`] = scrolled;
      } finally {
        await page.close();
      }
    },
  );
});
