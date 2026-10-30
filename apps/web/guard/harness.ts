/**
 * 瀏覽器護欄（#1512、#2091）各測試檔共用的量具：瀏覽器與靜態伺服器的生命週期、開頁、量測的 helper。
 * 每個 `*.test.ts` import 這裡時各自登記一組 `beforeAll`／`afterAll`，所以每個檔自己開一個 Chrome、一台伺服器，vitest 才能平行跑。
 *
 * 瀏覽器那一層的樣式護欄（#1512）：用真的 Chrome 開測試頁（`guard/main.tsx`），量元件在**出貨 CSS**（`dist/`）下的計算值。
 * 靜態那一層（`src/styles/*.test.ts`）量的是 token 與選擇器文字，量不到 specificity、`color-mix()` 現場合成的底色、
 * 半透明的面實際疊在什麼上面；這裡量的是畫出來的結果。
 *
 * 量這幾件事，亮暗各一次：
 * 1. **焦點**：鍵盤聚焦後 `box-shadow` 看得見的層跟沒聚焦時一樣（不帶 ring），外框是 2px 實線、顏色是頁面的字色（`.docs/web-ui-spec.md`、#1279），
 *    外框對它畫在上面的底色過非文字門檻 {@link NON_TEXT_MIN}（#1468 Q5）。
 * 2. **對比**：每個字的顏色對它實際的底色（往上疊到不透明為止，漸層取最差的停點）過門檻（文字 4.5，`data-guard-min` 另給）。
 *    量具只疊底色、不算 `opacity`（祖先半透明時字與底整組一起淡掉），所以元素自己或任一祖先的 `opacity` 不是 1 就直接判不合格（#1523：
 *    vendor 的輸入框群組在送出鈕停用時整組 50%，只看色值的量具漏掉了）。字、按鈕的各種狀態、焦點外框都照這條。
 * 3. **欄位聚焦**：文字欄位（`Input`、`Textarea`、輸入框群組）鍵盤聚焦後，邊框四邊都是頁面的字色（#1468 Q5 焦點用字色；
 *    SG 畫的是 `--focus-line` 灰線，`solid-glass.overrides.css` 換回來，靜態那一層 `focus-line-suppression.test.ts` 列舉）。
 * 4. **貼在輸入框上方的卡片是平的**：`Surface tone="docked"` 的邊是 1px、沒有投影（SG 的 `.bg-card` 會把它變成浮起來的卡片，
 *    `solid-glass.overrides.css` 補回來）。
 * 5. **Pick 與用量鈕的三種狀態**：`data-guard-chip` 裡那顆按鈕平常、滑鼠移上去、清單開著三種狀態，字對它實際的底色過門檻。量的是輸入框
 *    底列的 Pick（#1591，12px 次要字，4.5）；權限「全開」那顆是警示色直接疊在頁面上，是狀態色對底色，守 {@link STATUS_MIN}（同靜態那一層
 *    的狀態色門檻）。Pick 按下去就打開清單，量不到單純按著的樣子；`data-guard-press` 那顆頂列用量鈕量平常、移上去、按著
 *    （`:active`）：平常是次要字疊在頁面上，移上去與按著照 SG ghost 是同一階（SG 的 `--hover`），字換成 foreground，都過 4.5（#1689）。
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
 * 19. **對話流裡的列**（#1695 PR A，`?overlay=transcript-rows`）：重試提示、往前翻、空白畫面的字過 4.5，往前翻三顆鈕（含讀取中）的焦點外框；
 *    SG `DotLoader` 的點 3px、`--status-running` 色，平常在閃、減少動態時停在全亮；往前翻待命與讀取中一樣高，375 與 1280 寬不橫向溢出。
 * 20. **會話引用與 G2 圓角**（#1695 PR B，`?overlay=transcript-refs`，產品的 `Transcript`＋`StatusLine`）：能點的引用一直帶 brand 色底線、
 *    底線對泡泡底過 3，不能點的沒有底線；兩種引用與決定紀錄 chip 的字過 4.5；引用與「立刻重連」的焦點外框；決定紀錄的 chip 是 SG Badge 的圓角，
 *    捲到底的鈕與「立刻重連」是 SG Button 的圓角。
 * 21. **核准與換手**（#1694，`?overlay=handoff`）：背景子代理面板的字過 4.5（「子代理的對話」、「只停這個子代理」、送出鈕）；重讀、停止、
 *    輸入框（外框畫在群組上）、送出、核准卡兩顆與「停止這一輪」、換手面板的收起鈕、委派 chip 的取消鈕都有焦點外框；核准卡兩顆鈕（含只剩「停止這一輪」那張）、
 *    收起鈕是 SG Button 的 `rounded-md`，輸入框群組也是 `rounded-md`，取消委派的小鈕是 `rounded-sm`；375 寬時面板的輸入框與三顆鈕 44px 高。核准卡的呼吸光有幾圈只記在報告裡，看截圖。
 * 22. **計劃與目標**（#1692，`?overlay=plan`）：計劃模式的 SG Badge 不在 Tab 順序裡，按 Tab 走過一遍只停在「退出」、「查看全文」、審核兩顆、
 *    目標的暫停鈕；跑著時「退出」停用、`title` 寫原因，而且滑鼠移得上去（`pointer-events` 不是 none）、移上去底色不變；Badge、「退出」、失敗那句、審核兩顆、結果 chip 的字過 4.5，幾顆鈕有焦點外框；
 *    Badge 與結果 chip 是 `rounded-4xl`，「退出」與「查看全文」是 `rounded-sm`，審核兩顆與暫停鈕是 `rounded-md`；375 寬時「退出」至少 44px 寬、
 *    「退出」、「查看全文」、審核兩顆 44px 高，頁面不橫向溢出。
 * 23. **觀測分頁**（#1690 PR A，`?overlay=trace-*`）：一輪標頭的狀態膠囊九種收法的色調與字過 4.5、圓角是 `rounded-4xl`，完成與停在中斷點
 *    字前面的圓點對膠囊底過 3，只有進行中帶 `DotLoader`；
 *    空狀態的標題與說明過 4.5；計劃那一列的結果 chip 是 `rounded-4xl`、定位鈕是 `rounded-md`、有焦點外框；載入細節的鈕（待命、重試）與失敗原因過 4.5、
 *    鈕是 `rounded-sm`、有焦點外框，讀取中是一顆停用的鈕（`aria-disabled`，#2009）、畫成 `DotLoader` 加待命那一句、不覆寫名稱，只有摘要的組、
 *    更早的摘要、子代理三處都量，分頁只有一格
 *    `role=status`；375 寬時重試鈕與讀取中的鈕 44px 高、頁面不橫向溢出。
 * 24. **觀測分頁的列**（#1690 PR B，`?overlay=trace-steps`）：不能展開的列、SG `StepRow` 的列與它的失敗字、展開後的時刻、模型呼叫的數字格與欄位表、
 *    系統提示詞的 `OutputBlock`、子代理那一輪的 `StepGroup` 計數過 4.5；列、計數、結果框有焦點外框；分頁只有一格 `role=status`；
 *    1280 寬時列的字與定位鈕對齊；375 寬時列 44px 高，失敗那一列的標題沒被截、後面那段不壓到箭頭與定位鈕，頁面不橫向溢出。
 * 25. **成本分頁與頂列用量鈕**（#1691，`?overlay=cost`，產品的 `RightSidebarPanel`＋`SessionUsage`）：用量鈕的圓角跟 SG Badge 一樣是 `rounded-4xl`
 *    （#1827 G2）、字過 4.5、有焦點外框；成本分頁裡總計的欄名與數字、子代理列的數字過 4.5。
 * 26. **沒有分頁的右側欄**（#1696，`?overlay=right-empty`，產品的 `RightSidebarPanel`）：收起鈕與兩顆「打開某面板」的鈕跟 SG Button 一樣是
 *    `rounded-md`（#1827 G2）、有焦點外框；空狀態那句說明與鈕上的字過 4.5。
 * 27. **會話清單的狀態**（#1696 S1-C，`?overlay=thread-statuses`，產品的 `AppSidebar`）：能點的每列（目前這條停用，不量）的標題與狀態字過 4.5、有焦點外框；
 *    色條 3px、顏色是該狀態的 token，沒有狀態的列是透明；每列的報讀名稱只唸一次狀態；手機抽屜（375）與桌面最窄的側欄（1024）裡，
 *    標題獨佔一行、寬度不少於 150px；第二行在釘住的時鐘（`THREAD_CLOCK`）下只有目前這條放不下、被截掉。
 *
 * 面有三種狀態（{@link MODES}）：平常的半透明、`prefers-reduced-transparency: reduce`（CDP 模擬）、`<html data-glass="opaque">`。
 * 後兩種是不透明的退路，對比要一樣達標，面也要真的不透明。
 *
 * 量不到的：brand 當字色與 SG 的 `status-*` 這幾個顏色，測試頁上沒有元件不寫 class 就會用到它們（例外：`DiffStats` 的增刪數用到 success／destructive（覆寫檔第 75 條）、`DotLoader` 的點用到 status-running（這裡只量色值是那個 token）、會話引用的底線用到 brand（第 20 條，只量底線、不量字色）），
 * 由靜態那一層（`tokens-contrast.test.ts`）量。
 *
 * 跑法：先 `pnpm --filter @nexus/web run build`，再 `pnpm --filter @nexus/web run test:guard`（CI 在 static job 的 build 之後）。
 * 瀏覽器用本機裝的 Chrome（`channel: 'chrome'`），不另外下載。`GUARD_REPORT=<檔案>` 會把量到的數字與瀏覽器版本寫成 JSON，每個測試檔一份（檔名插上測試檔名）。
 */
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, expect } from 'vitest';
import {
  backdrops,
  composite,
  contrastRatio,
  parseColor,
  shadowLayers,
  type BackgroundLayer,
} from '../src/styles/color-math';
import { startGuardServer, type GuardServer } from './server';

export type Theme = 'light' | 'dark';

/** 往上疊的一層，加上那一層自己的 `opacity`（#1523）：{@link worstOn} 遇到不是 1 的就判不合格，見檔頭第 2 條。 */
export type MeasuredLayer = BackgroundLayer & { opacity: string };

/**
 * 亮色時有看得見的投影的元素（`data-guard-shadow`）與各自每層投影的透明度上限。上限是 SG 現在的值（#1512 量到的）：
 * 0.28 是 `--glass-shade`（浮起來的那一層），0.06 是 `--glass-contact`（貼地的那一層）；靜態那一層 `shadow-alpha.test.ts` 釘 token 本身。
 * 投影整個消失、搬到別的元素上、或調深，都紅。
 */
export const SHADOW_LIMITS: Record<string, number> = {
  'button-default': 0.28,
  'button-outline': 0.06,
  'button-secondary': 0.06,
  'button-glass': 0.06,
  card: 0.28,
  popover: 0.28,
};

export const SHADOWED = Object.keys(SHADOW_LIMITS);

export const TEXT_MIN = 4.5;

/** 字樣本一定要量到的幾個（量具自檢）：少了就是頁面沒畫出來或選擇器沒中，對比那條會靜靜變成空的綠。 */
export const REQUIRED_TEXTS = [
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

export const NON_TEXT_MIN = 3;

/** `open`：清單開著（`aria-expanded`）。Pick 是選單的 Trigger，按下去就打開清單，量不到單純「按著」的樣子（#1591）。 */
export type ChipState = 'rest' | 'hover' | 'open';

export const CHIP_STATES: ChipState[] = ['rest', 'hover', 'open'];

/**
 * 狀態色對底色的門檻（`.docs/web-ui-spec.md` §5，#1468 Q5）。權限「全開」的 Pick 沒有 chip 底，字是警示色（`status-interrupted`）直接疊在頁面上，
 * 所以守這一條而不是文字的 4.5。不扣靜態那一層的 `ROUNDING`：瀏覽器量的是出貨的值，跟靜態那層對到小數第四位。
 */
export const STATUS_MIN = 5.2;

/**
 * Pick 三種狀態裡的狀態色：權限「全開」的 Pick 平常與滑鼠移上去是警示色（本地修改第 35 條），守 {@link STATUS_MIN}。清單開著時
 * 換回字色（開著的底上警示色不到 4.5），守文字的 4.5。
 */
export const CHIP_STATUS = new Set(['pick-danger:rest', 'pick-danger:hover']);

export type Mode = 'translucent' | 'reduced-transparency' | 'opaque';

export const MODES: Mode[] = ['translucent', 'reduced-transparency', 'opaque'];

export interface TextSample {
  name: string;
  min: number;
  color: string;
  chain: MeasuredLayer[];
}

export interface FocusSample {
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

export interface FieldSample {
  name: string;
  focusVisible: boolean;
  /** 上、右、下、左四邊的 `border-*-color`。 */
  borderBefore: string[];
  borderAfter: string[];
  pageColor: string;
}

export interface ChipSample {
  name: string;
  state: ChipState;
  /** 真的在那個狀態（`:hover`／`:active`）。 */
  inState: boolean;
  color: string;
  backgroundColor: string;
  chain: MeasuredLayer[];
}

export interface ShadowSample {
  name: string;
  boxShadow: string;
}

export let server: GuardServer | undefined;

export let browser: Browser | undefined;

export const report: Record<string, unknown> = {};

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

// eslint-disable-next-line no-empty-pattern -- vitest 要求 hook 的第一個參數寫成解構；這裡只用第二個參數 suite 拿測試檔名
afterAll(async ({}, suite) => {
  try {
    await browser?.close();
  } finally {
    await server?.close();
  }
  const target = process.env.GUARD_REPORT;
  // 每個測試檔各寫一份，平行跑時不互相蓋掉：`<檔案>.json` 寫成 `<檔案>.guard-tools.json` 這樣。
  const file = basename(suite.file?.name ?? suite.name, '.test.ts');
  if (target) {
    writeFileSync(
      `${target.replace(/\.json$/, '')}.${file}.json`,
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
});

/**
 * 等有限長度的動畫與轉場跑完（無限的，例如呼吸光，不等）。只等跟著時間跑的：scroll-driven 的（對話區的底部淡出，#1638 PR B）
 * 跟著捲動位置走，沒捲到底就永遠不會 finished。
 */
export async function settle(page: Page): Promise<void> {
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

export async function open(theme: Theme, mode: Mode = 'translucent'): Promise<Page> {
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

export function collectTexts(page: Page): Promise<TextSample[]> {
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

export async function collectFocus(page: Page): Promise<FocusSample[]> {
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

export async function collectFields(page: Page): Promise<FieldSample[]> {
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

export async function collectChips(page: Page): Promise<ChipSample[]> {
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

export interface HoverSample {
  readonly name: string;
  readonly state: 'rest' | 'hover';
  readonly inState: boolean;
  readonly color: string;
  readonly backgroundColor: string;
  readonly chain: MeasuredLayer[];
}

/** `data-guard-hover` 的元素：游標移開與移上去各量一次字色與往上疊的底（#1523）。 */
export async function collectHovers(page: Page): Promise<HoverSample[]> {
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

export type PressState = 'rest' | 'hover' | 'pressed';

export const PRESS_STATES: PressState[] = ['rest', 'hover', 'pressed'];

export interface PressSample {
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
export async function collectPresses(page: Page): Promise<PressSample[]> {
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

export interface ChoiceSample {
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
export async function collectChoices(page: Page): Promise<ChoiceSample[]> {
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

export function collectShadows(page: Page): Promise<ShadowSample[]> {
  return page.$$eval('[data-guard-shadow]', (els) =>
    els.map((el) => ({
      name: el.getAttribute('data-guard-shadow') ?? '',
      boxShadow: getComputedStyle(el).boxShadow,
    })),
  );
}

/** 某個顏色疊在每一個候選底色上的對比，取最差的。 */
export function worstOn(color: string, chain: MeasuredLayer[]): { ratio: number; on: string } {
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

export const worstContrast = (sample: TextSample) => worstOn(sample.color, sample.chain);

export const round = (n: number) => Math.round(n * 100) / 100;

/**
 * `box-shadow` 裡看得見的層。Tailwind 的 ring／shadow 清掉時留下的是全透明的層（`rgba(0, 0, 0, 0) 0px 0px 0px 0px`），
 * 跟 `none` 畫起來一樣，比的時候拿掉；四個長度全是 0 的層（`ring-0` 留下的，帶著字色但寬 0）也什麼都不畫，同樣拿掉（#1523）。
 * 有寬度、有顏色的 ring 就留著，聚焦前後一比就看得出來。
 */
export function visibleShadow(value: string): string[] {
  return shadowLayers(value)
    .filter((l) => !l.empty && (l.color === undefined || parseColor(l.color).alpha > 0))
    .map((l) => l.text);
}

export const sameShadow = (a: string, b: string) =>
  JSON.stringify(visibleShadow(a)) === JSON.stringify(visibleShadow(b));

/** 鍵盤焦點：box-shadow 不帶 ring（跟沒聚焦時一樣），外框是 2px 實線、頁面的字色，外框對底色過 {@link NON_TEXT_MIN}。 */
export function expectFocus(focus: FocusSample[], key: string): void {
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

/**
 * modal 浮層（#1583）：每個浮層自己開一頁（`?overlay=<名字>`），modal 會把其他部分設成 inert，跟主頁放不到一起。
 * `viewport` 給手機側欄用（`useIsMobile` 的斷點是 1024），`marks` 把屬性補到 vendor 自己畫的元素上（關閉鈕、遮罩、抽屜）。
 */
export interface Overlay {
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

export const SCROLL_BUTTON = '[data-slot="message-scroller-button"]';

export const QUESTIONNAIRE_CHOICE = '[data-slot="questionnaire-choice"]';

export const QUESTIONNAIRE_INPUT = `${QUESTIONNAIRE_CHOICE} > input`;

/** 放不下的那一排草稿附件裡每一顆按鈕：看原圖（縮圖）、移除、取消上傳。 */
export const ATTACHMENT_BUTTONS =
  '[data-guard-rail="overflows"] :is([data-slot="attachment-action"], [data-slot="attachment-media"] > button)';

/** 把對話區捲到頂端或最底，等捲到最新的按鈕換好狀態、動效跑完。 */
export async function scrollMessages(page: Page, to: 'top' | 'end'): Promise<void> {
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

export const OVERLAYS: Overlay[] = [
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
export const OVERLAY_SHADOW_LIMITS: Record<string, number> = {
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
export const WIDTHS: {
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

export const WIDTH_MARKS: Record<string, Record<string, Record<string, string>>> = {
  feedback: { '[data-slot="dialog-content"]': { 'data-guard-width': 'feedback' } },
  'mobile-sidebar': OVERLAYS.find((o) => o.name === 'mobile-sidebar')!.marks,
};

/**
 * 圓角拿 SG 的 class 做探針比：探針的值取自出貨 CSS 裡 `.rounded-4xl`、`.rounded-md`、`.rounded-sm` 那幾條規則的原文（guard 底下
 * 不寫 class，`src/guard-page.test.ts`）；`targets` 每個選擇器命中的元素各量一個圓角。自檢三條規則都抓到了，而且值兩兩不同。
 */
export async function readRadii<K extends string>(
  page: Page,
  targets: Record<K, string>,
): Promise<{ probe: { capsule: string; md: string; sm: string }; radii: Record<K, string[]> }> {
  const result = await page.evaluate(
    (targets) => {
      const rules = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]);
      const find = (selector: string): CSSStyleRule | undefined => {
        for (const rule of rules) {
          if (rule instanceof CSSStyleRule && rule.selectorText === selector) return rule;
          if (rule instanceof CSSGroupingRule)
            for (const inner of rule.cssRules)
              if (inner instanceof CSSStyleRule && inner.selectorText === selector) return inner;
        }
        return undefined;
      };
      const radiusOf = (selector: string) => {
        const probe = document.createElement('div');
        probe.style.borderRadius = find(selector)?.style.borderRadius ?? '';
        document.body.append(probe);
        const radius = getComputedStyle(probe).borderTopLeftRadius;
        probe.remove();
        return radius;
      };
      return {
        probe: {
          capsule: radiusOf('.rounded-4xl'),
          md: radiusOf('.rounded-md'),
          sm: radiusOf('.rounded-sm'),
        },
        radii: Object.fromEntries(
          Object.entries(targets).map(([key, selector]) => [
            key,
            [...document.querySelectorAll(selector)].map(
              (el) => getComputedStyle(el).borderTopLeftRadius,
            ),
          ]),
        ),
      };
    },
    targets as Record<string, string>,
  );
  const { capsule, md, sm } = result.probe;
  expect(new Set([capsule, md, sm, '0px']).size).toBe(4);
  return result as { probe: typeof result.probe; radii: Record<K, string[]> };
}

export async function openOverlay(
  name: string,
  theme: Theme,
  options: {
    mode?: Mode;
    viewport?: { width: number; height: number };
    reducedMotion?: boolean;
    marks: Record<string, Record<string, string>>;
    prepare?: (page: Page) => Promise<void>;
    /** 頁面的時鐘與時區釘在這裡，載入之前就生效：畫出來的日期時間不跟著跑的當下變。 */
    clock?: { readonly at: Date; readonly timezoneId: string };
  },
): Promise<Page> {
  if (browser === undefined || server === undefined) throw new Error('瀏覽器或伺服器沒起來');
  const mode = options.mode ?? 'translucent';
  const page = await browser.newPage({
    viewport: options.viewport ?? { width: 1280, height: 1000 },
    ...(options.clock === undefined ? {} : { timezoneId: options.clock.timezoneId }),
  });
  if (options.clock !== undefined) await page.clock.setFixedTime(options.clock.at);
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

export function collectBackdrops(page: Page): Promise<{ name: string; backdropFilter: string }[]> {
  return page.$$eval('[data-guard-backdrop]', (els) =>
    els.map((el) => ({
      name: el.getAttribute('data-guard-backdrop') ?? '',
      backdropFilter: getComputedStyle(el).backdropFilter,
    })),
  );
}

export function collectSurfaces(
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

export function expectTexts(texts: TextSample[], required: string[], key: string): void {
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

/**
 * 輸入框（SG 的 `Composer`，#1591 驗收 D）。vendor 自己畫的 textarea、主按鈕掛不了屬性，開頁後補（同 modal 浮層）。
 * 主按鈕停用時（閒著、草稿空）不量焦點與對比：停用的控制項不在 WCAG 的對比門檻裡，也聚焦不到。
 */
export const COMPOSER_STATES = ['idle', 'draft', 'running', 'running-draft', 'menu'] as const;

export type ComposerState = (typeof COMPOSER_STATES)[number];

export const COMPOSER_MAIN_ENABLED: readonly ComposerState[] = [
  'draft',
  'running',
  'running-draft',
];

export function composerMarks(state: ComposerState): Record<string, Record<string, string>> {
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

/**
 * 輸入框的底列（#1591 PR 2，驗收 C、D）：左邊權限、右邊模型、推理強度兩顆 SG 的 `ComposerPick`，最右邊用量環（SG 的 `ContextRing`）。
 * 都是 vendor 畫的、掛不了屬性，開頁後補。
 */
export const PICK = '[data-slot="composer-footer"] [data-slot="dropdown-menu-trigger"]';

export const RING = '[data-slot="composer-footer"] [data-slot="context-ring"]';

export const footerMarks: Record<string, Record<string, string>> = {
  [PICK]: { 'data-guard-focus': 'footer-pick', 'data-guard-text': 'footer-pick' },
  [RING]: { 'data-guard-focus': 'footer-ring' },
};

/**
 * SG 的 tool-steps（#1682 PR A，`?overlay=tool-steps`）：README 本地修改第 61–65 條的覆寫真的命中 vendor 畫出來的元素，
 * 字與焦點過門檻。vendor 元件掛不了屬性，開頁後補。
 */
export const TOOL_GROUP = '[data-guard-tool="group"]';

export const TOOL_STANDALONE = '[data-guard-tool="standalone"]';

export const toolStepsMarks: Record<string, Record<string, string>> = {
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

/**
 * 產品的工具卡與工具段（#1682 PR B 驗收 C，`?overlay=tool-cards`）：三種底上的字都過 4.5——列的字疊在頁面底色與漸層上（單獨的卡，含背景子代理的狀態字）、
 * 疊在 `StepList` 的 `--panel` 上（段裡的卡）、結果框的標題與內文、錯誤框的紅字、Badge；列、群組、結果框的焦點是 2px 字色外框。
 * 亮暗加兩種不透明退路都量。vendor 元件掛不了屬性，開頁後補。
 */
export const CARDS = '[data-guard-cards]';

export const toolCardsMarks: Record<string, Record<string, string>> = {
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

/**
 * 推理列（#1683，`?overlay=reasoning`）：SG 的 `Reasoning` 接上產品的轉接層。三塊：講完的一列（`done`）、還在想的一列（`running`，
 * 摘要很長）、工具段裡的一列（`panel`，疊在 `StepList` 的 `--panel` 上）。vendor 元件掛不了屬性，開頁後補。
 * 標題、「·」、摘要量收著的時候；內文（段落、清單、粗體、連結、行內 code）打開 `done` 與 `panel` 再量。
 */
export const REASONING_ROWS = '[data-guard-reasoning]';

export const reasoningIn = (block: 'done' | 'running' | 'panel') =>
  `[data-guard-reasoning="${block}"] [data-slot="reasoning"]`;

/** 收著時看得見的（標題、「·」、摘要、summary 的焦點）交給 `openOverlay` 等；內文收著時看不見，打開之後才補標記（`markReasoningBody`）。 */
export const reasoningMarks: Record<string, Record<string, string>> = Object.fromEntries(
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

export const REASONING_BODY = ['body', 'li', 'strong', 'link', 'code'];

export const markReasoningBody = (page: Page) =>
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

export const openReasoningRows = (page: Page, blocks: ('done' | 'running' | 'panel')[]) =>
  page.evaluate((selectors) => {
    for (const selector of selectors)
      document.querySelector<HTMLDetailsElement>(selector)!.open = true;
  }, blocks.map(reasoningIn));

export const REASONING_HEAD = ['title', 'dot', 'trailing'];

// ---------- 狀態列（#1684，`?overlay=turn-status`） ----------

export const STATUS_RUNNING = '[data-guard-status="running"]';

export const TURN = `${STATUS_RUNNING} [data-slot="turn-status"]`;

export const TURN_LABEL = `${TURN} .status-shimmer`;

export const TURN_ELAPSED = `${STATUS_RUNNING} [data-testid="running-elapsed"]`;

export const TURN_GLYPH = `${TURN} [data-slot="status-glyph"]`;

/** glyph 三個 circle 的 `[[cx, cy, r, opacity], …]`：vendor `draw` 每幀改這四個（同 `scripts/measure-frames.mjs`）。 */
export const readPose = (page: Page) =>
  page.$$eval(`${TURN_GLYPH} circle`, (circles) =>
    circles.map((c) => ['cx', 'cy', 'r', 'opacity'].map((a) => c.getAttribute(a) ?? '')),
  );

export const openingPoseIn = (page: Page, activity: string) =>
  page.evaluate(
    (a) => (window as unknown as { __openingPose: (a: string) => string[][] }).__openingPose(a),
    activity,
  );

export const setActivity = (page: Page, activity: string) =>
  page.evaluate(
    (a) => (window as unknown as { __setTurnActivity: (a: string) => void }).__setTurnActivity(a),
    activity,
  );

/** label 的字色、漸層與往上疊的底（漸層畫在 label 自己身上、只透過字露出來，底從上一層開始疊；自己那層只帶 opacity）。 */
export const readLabel = (page: Page) =>
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

/**
 * 增刪行數（#1685 PR A 驗收 3、4，`?overlay=diff-stats`）：SG `DiffStats` 的 `+`／`−` 疊在每一種底上都過 4.5——頁面底與漸層、
 * 工具段 `StepList` 的 `--panel`、改動卡、審查頁（標頭與選檔器的清單）；亮暗加兩種不透明退路。兩色是覆寫檔第 75 條換的
 * `--success`／`--destructive`：另外比對算出來的顏色就是那兩個 token，拿掉覆寫要紅（就算 SG 的原色剛好在某一格過了 4.5）。
 * 375 寬時包裝層（第 76 條）不被擠：寬度跟 vendor 那顆單獨放著一樣。
 */
export const DIFF_STATS = '[data-slot="diff-stats"] > span';

export const DIFF_REVIEW = '[data-testid="changes-review"]';

export const diffStatsMarks: Record<string, Record<string, string>> = {
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
export async function openDiffReview(page: Page): Promise<void> {
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

/**
 * 工具卡的 diff（#1685 PR B 驗收 9、10、11，`?overlay=diff-view`）：產品的工具卡給了 `step.patch` 之後畫 SG 的 `DiffView`。
 * 每一行照開頭分成六種（`diff --git` 路徑、`@@`、新增、刪除、上下文、`... 還有 N 行沒畫`），疊在 `StepList` 裡（`group`）與單獨放在
 * 頁面上（`standalone`）各量一次；亮暗加兩種不透明退路。
 */
export const DIFF_VIEW = '[data-guard-diffview] [data-slot="diff-view"]';

export const DIFF_VIEW_KINDS = ['file', 'hunk', 'add', 'del', 'context', 'more'] as const;

export const diffViewMarks: Record<string, Record<string, string>> = {
  '[data-guard-diffview="group"] [data-slot="diff-view"]': {},
  '[data-guard-diffview="standalone"] [data-slot="diff-view"]': {},
};

/** 每一行依開頭標上 `data-guard-text="diffview-<group|standalone>-<種類>"`。 */
export async function markDiffViewLines(page: Page): Promise<void> {
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

/**
 * 對話流裡的列（#1695 PR A，`?overlay=transcript-rows`）：重試提示（X3-B）、往前翻（X4-B）、空白畫面（E1-C）。
 * 字過 4.5、往前翻三顆鈕（待命、讀取中、失敗）的焦點外框（讀取中也停得上焦點，#2009）；SG `DotLoader` 的點是 3px、`--status-running` 色，平常在閃、減少動態時停在全亮；
 * 往前翻待命與讀取中一樣高（接上一頁之前畫面不跳）。
 */
export const transcriptRowMarks: Record<string, Record<string, string>> = {
  '[data-guard-rows="retry"] [data-testid="llm-retry"] > span[aria-hidden]': {
    'data-guard-text': 'retry-text',
  },
  '[data-guard-pager="idle"] button': {
    'data-guard-text': 'pager-idle',
    'data-guard-focus': 'pager-idle',
  },
  '[data-guard-pager="loading"] button': {
    'data-guard-text': 'pager-loading',
    'data-guard-focus': 'pager-loading',
  },
  '[data-guard-pager="fail"] button': {
    'data-guard-text': 'pager-fail',
    'data-guard-focus': 'pager-fail',
  },
  '[data-guard-pager="fail"] p': { 'data-guard-text': 'pager-error' },
  '[data-slot="empty-title"]': { 'data-guard-text': 'empty-title' },
  '[data-slot="empty-description"]': { 'data-guard-text': 'empty-description' },
};

/**
 * 會話引用與 G2 圓角（#1695 PR B，`?overlay=transcript-refs`）。能點的引用不靠 hover 也看得出來：一直帶 brand 色底線，底線對
 * 泡泡底過 {@link NON_TEXT_MIN}（非文字的辨識門檻）；不能點的沒有底線。圓角拿 SG 的 class 做探針比：chip 是 Badge 的
 * `rounded-4xl`，捲到底的鈕（`icon-sm`）與「立刻重連」（`sm`）是 Button 的 `rounded-sm`。
 */
export const REF_LINK = 'button[data-session-reference]';

export const REF_PLAIN = 'span[data-session-reference]';

export const transcriptRefsMarks: Record<string, Record<string, string>> = {
  [REF_LINK]: { 'data-guard-text': 'ref-link', 'data-guard-focus': 'ref-link' },
  [REF_PLAIN]: { 'data-guard-text': 'ref-plain' },
  '[data-testid="decision-entry"]': { 'data-guard-text': 'decision-chip' },
  '[data-guard-rows="status"] button': { 'data-guard-focus': 'reconnect' },
};

/**
 * 核准與換手（#1694，`?overlay=handoff`）。量跑著那一張子代理面板（頂端狀態列＋SG `InputGroup`）的字與焦點外框，以及核准卡、
 * 換手面板收起鈕、取消委派小鈕的圓角。送出鈕要有字才按得到，量之前先打一句。
 */
export const HANDOFF_RUNNING = '[data-guard-handoff="subagent-running"]';

export const handoffMarks: Record<string, Record<string, string>> = {
  [`${HANDOFF_RUNNING} [data-subagent-panel] > div:first-child > span`]: {
    'data-guard-text': 'sub-caption',
  },
  [`${HANDOFF_RUNNING} button[aria-label="重新讀取子代理的對話"]`]: {
    'data-guard-focus': 'sub-reload',
  },
  [`${HANDOFF_RUNNING} button[aria-label="只停這個子代理"]`]: {
    'data-guard-text': 'sub-stop',
    'data-guard-focus': 'sub-stop',
  },
  [`${HANDOFF_RUNNING} [data-slot="input-group"]`]: { 'data-guard-outline-host': '' },
  [`${HANDOFF_RUNNING} [data-slot="input-group"] input`]: { 'data-guard-focus': 'sub-input' },
  [`${HANDOFF_RUNNING} button[aria-label="送出給背景子代理"]`]: {
    'data-guard-text': 'sub-send',
    'data-guard-focus': 'sub-send',
    // 送出鈕在群組裡：自己當外框宿主，不然 `closest` 會找到外面的群組。
    'data-guard-outline-host': '',
  },
  '[data-guard-handoff="approval"] [data-testid="approval-card"] button': {
    'data-guard-focus': 'approval',
  },
  '[data-guard-handoff="approval-stuck"] [data-testid="approval-card"] > div:last-child > button': {
    'data-guard-focus': 'approval-stop',
  },
  '[data-guard-handoff="question"] [data-slot="pending-panel"] button[aria-label="收起這些問題"]': {
    'data-guard-focus': 'pending-collapse',
  },
  '[data-guard-handoff="chips"] button[aria-label^="取消委派"]': {
    'data-guard-focus': 'mention-remove',
  },
};

export async function typeIntoSubagent(page: Page): Promise<void> {
  await page.fill(`${HANDOFF_RUNNING} [data-slot="input-group"] input`, '先看部署那段');
  // 停用到可按，`transition-all` 讓 opacity 淡上來；等它到 1 再量字。
  await page.waitForFunction(
    (selector) => getComputedStyle(document.querySelector(selector)!).opacity === '1',
    `${HANDOFF_RUNNING} button[aria-label="送出給背景子代理"]`,
  );
}

/**
 * 計劃與目標（#1692，`?overlay=plan`）。失敗那句要先按一次「退出」才出現，`prepare` 裡按、等它出來再標。
 */
export const PLAN_EXIT = 'button[aria-label="退出計劃模式"]';

export const planMarks: Record<string, Record<string, string>> = {
  '[data-guard-plan="chip"] [data-slot="badge"]': { 'data-guard-text': 'plan-badge' },
  [`[data-guard-plan="chip"] ${PLAN_EXIT}`]: {
    'data-guard-text': 'plan-exit',
    'data-guard-focus': 'plan-exit',
  },
  [`[data-guard-plan="chip-failed"] ${PLAN_EXIT}`]: { 'data-guard-focus': 'plan-exit-failed' },
  '[data-guard-plan] button[aria-label^="查看全文"]': { 'data-guard-focus': 'plan-open' },
  '[data-guard-plan="review"] [data-testid="plan-review-panel"] > div:last-child > button:first-child':
    { 'data-guard-text': 'plan-revise', 'data-guard-focus': 'plan-revise' },
  '[data-guard-plan="review"] [data-testid="plan-review-panel"] > div:last-child > button:last-child':
    { 'data-guard-text': 'plan-approve', 'data-guard-focus': 'plan-approve' },
  '[data-guard-plan="card"] [data-testid="plan-outcome"]': { 'data-guard-text': 'plan-outcome' },
  '[data-guard-plan="goal"] [data-testid="goal-pause"]': { 'data-guard-focus': 'goal-pause' },
};

export async function failPlanExit(page: Page): Promise<void> {
  await page.click(`[data-guard-plan="chip-failed"] ${PLAN_EXIT}`);
  const failure = page.locator('[data-guard-plan="chip-failed"] p');
  await failure.waitFor();
  await failure.evaluate((el) => el.setAttribute('data-guard-text', 'plan-failure'));
  // 按過之後游標還停在鈕上，hover 會換底色；移開再量字的對比與焦點。
  await page.mouse.move(0, 0);
}

/**
 * 觀測分頁（#1690 PR A，`?overlay=trace-*`）。`trace-groups` 要先按「看第 1 輪」，前三輪才會從「更早的」摘要變成只有摘要的組；
 * 假端點讓第 2 輪預拉失敗、第 3 輪預拉回空的，所以第 3 輪停在待命，按它的鈕就停在讀取中（同一個 seq 的第二次查詢不回）。按出來的東西在 `prepare` 裡等、再標。
 */
export const TRACE_TONES = {
  done: 'done',
  waiting: 'waiting',
  question: 'waiting',
  failed: 'failed',
  running: 'running',
  aborted: 'neutral',
  interrupted: 'neutral',
  'max-tokens': 'neutral',
  blocked: 'neutral',
};

export const TRACE_PILL = '[data-testid="trace-head-status"]';

export const tracePillMarks: Record<string, Record<string, string>> = Object.fromEntries(
  Object.keys(TRACE_TONES).map((name) => [
    `[data-guard-head="${name}"] ${TRACE_PILL}`,
    { 'data-guard-text': `pill-${name}` },
  ]),
);

export const traceTurn = (seq: number) => `section[data-testid="trace-turn"][data-seq="${seq}"]`;

export const TRACE_PULL = '[data-testid="trace-pull"]';

export const TRACE_LOADING = `${TRACE_PULL}[data-status="loading"]`;

export async function revealTraceGroups(page: Page): Promise<void> {
  await page.click('[data-guard-reveal]');
  const idle = page.locator(`${traceTurn(300)} ${TRACE_PULL}[data-status="idle"] button`);
  const retry = page.locator(`${traceTurn(200)} ${TRACE_PULL}[data-status="failed"] button`);
  await Promise.all([idle.waitFor(), retry.waitFor()]);
  await idle.evaluate((el) => {
    el.setAttribute('data-guard-text', 'pull-idle');
    el.setAttribute('data-guard-focus', 'pull-idle');
  });
  await retry.evaluate((el) => {
    el.setAttribute('data-guard-text', 'pull-retry');
    el.setAttribute('data-guard-focus', 'pull-retry');
  });
  await page
    .locator('[data-testid="trace-pull-failed"]')
    .evaluate((el) => el.setAttribute('data-guard-text', 'pull-failure'));
  await page.mouse.move(0, 0);
}

export async function loadTraceGroup(page: Page): Promise<void> {
  await revealTraceGroups(page);
  await page.click(`${traceTurn(300)} ${TRACE_PULL} button`);
  await page.locator(`${traceTurn(300)} ${TRACE_LOADING}`).waitFor();
  await page.mouse.move(0, 0);
}

/** 讀取中那幾格：一顆停用的鈕（有沒有覆寫名稱）、一個 `DotLoader`（三個點）、字；外加整頁 `role=status` 有幾格。 */
export function readTraceLoading(page: Page) {
  return page.evaluate(
    (loading) => ({
      rows: [...document.querySelectorAll(loading)].map((el) => ({
        buttons: el.querySelectorAll('button').length,
        disabled: el.querySelector('button')?.getAttribute('aria-disabled') ?? null,
        ariaLabel: el.querySelector('button')?.getAttribute('aria-label') ?? null,
        dots: el.querySelectorAll('.animate-dot-flash').length,
        text: el.textContent,
      })),
      status: document.querySelectorAll('[role="status"]').length,
    }),
    TRACE_LOADING,
  );
}

export const TRACE_ROW = '[data-testid="trace-row"]';

export const TRACE_STEP = '[data-slot="step-row"] > button';

/**
 * 觀測分頁的列（#1690 PR B，`?overlay=trace-steps`）。量之前展開第 1 次模型呼叫、它的系統提示詞全文，以及派出子代理的那顆工具與
 * 「子代理的呼叫結構」；展開才掛上的元素在 `prepare` 裡等、再標。
 */
export async function openTraceSteps(page: Page): Promise<void> {
  const call = page.locator(`${TRACE_ROW}[data-kind="call"] ${TRACE_STEP}`).first();
  await call.click();
  await page.locator('[data-testid="trace-system-text"] button').click();
  await page
    .locator(`${TRACE_ROW}[data-kind="tool"] ${TRACE_STEP}`, { hasText: '委派子代理' })
    .click();
  await page.click('[data-testid="trace-subagent-block"] button[aria-expanded="false"]');
  await page.locator('[data-slot="step-group"]').waitFor();
  await page.evaluate(
    ([row, step]) => {
      const mark = (selector: string, attributes: Record<string, string>) => {
        const el = document.querySelector(selector);
        if (el === null) throw new Error(`找不到 ${selector}`);
        for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
      };
      mark(`${row}[data-kind="call"] ${step}`, {
        'data-guard-text': 'step-row',
        'data-guard-focus': 'step-row',
      });
      // 展開區有時刻的只剩工具列，量已經展開的那顆子代理工具。
      mark(
        `${row}[data-kind="tool"]:has([data-testid="trace-subagent-block"]) [data-testid="trace-time"]`,
        {
          'data-guard-text': 'step-time',
        },
      );
      mark(`${row}[data-kind="retry"] p`, { 'data-guard-text': 'static-row' });
      mark(
        `${row}[data-kind="tool"] span:has(> [data-testid="trace-error-code"]) > span:first-child`,
        {
          'data-guard-text': 'step-failed',
        },
      );
      mark('[data-testid="trace-call-tiles"] dt', { 'data-guard-text': 'tile-term' });
      mark('[data-testid="trace-call-tiles"] dd', { 'data-guard-text': 'tile-value' });
      mark('[data-testid="trace-call-details"] > dl:last-child dt', {
        'data-guard-text': 'field-term',
      });
      mark('[data-testid="trace-call-details"] > dl:last-child dd', {
        'data-guard-text': 'field-value',
      });
      mark('[data-testid="trace-system-text"] pre', {
        'data-guard-text': 'output',
        'data-guard-focus': 'output',
      });
      mark('[data-slot="step-group"] > button', {
        'data-guard-text': 'group',
        'data-guard-focus': 'group',
      });
    },
    [TRACE_ROW, TRACE_STEP] as const,
  );
}

/**
 * 會話清單頁的時鐘（#2051）：夾具的更新時間是 `Date.now()` 往前推，第二行印成 zh-TW 的日期時間，字寬隨時刻變。
 * 釘在這個時刻，目前這條的「目前這條 · 執行中 · 2026/10/26 中午12:00」在兩種寬度都放不下，其餘列都放得下。
 */
export const THREAD_CLOCK = {
  at: new Date('2026-10-26T12:00:00+08:00'),
  timezoneId: 'Asia/Taipei',
};
