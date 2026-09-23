/**
 * 一個交付檔的預覽（[#452](https://github.com/DemianLi/nexus-agent/issues/452) web 第二刀；
 * [#543](https://github.com/DemianLi/nexus-agent/issues/543) 改成接續瀏覽）：拿卡片上那組 `(seq, index)`
 * 座標去讀檔，一段一段往下接。
 *
 * 外殼跟隔壁的改動審查同一個（`Sheet`：桌面從右側滑出、手機全螢幕，#443 決議 3）。
 *
 * ## 接續，不是換頁
 *
 * 形狀照 dsh `ui-sidebar-documentpreview`（`TextBody.tsx`、`store.ts`、`text/lines.ts`，`ddefc45`）：讀過的段
 * 累積往下長，畫面是一條從第 0 行開始的**連續前綴**（{@link loadedChain}），捲到接近底才接下一段。舊的做法是
 * 換頁 —— 按下去前一段就沒了，也沒有上一段，來回看一個檔做不到。
 *
 * ## 畫面上的上限：{@link BLOCK_LINES} 行一塊的 `content-visibility`
 *
 * **dsh 在這裡沒有上限**，累積多少段就畫多少。這一處不照抄（UI 不在技術實現標準的射程內，見 AGENTS.md）：
 * 渲染成本按字元**出現次數**算，不是按位元組 —— 同樣 1000 行，ASCII 27ms，每行結尾一個裸 `🏳`（U+1F3F3
 * 沒有 VS16）就是 1.6–1.8 秒（headless Chrome，2026-09-23，#543 的量測留言）。路由那道「一頁最多 2 MiB」
 * 擋得住記憶體，擋不住主執行緒。
 *
 * 所以每 {@link BLOCK_LINES} 行包成一塊、各自 `content-visibility: auto`，畫面外的塊不 layout、不 paint。
 * **邊界必須比視窗小**：一段一個邊界的話，「打開預覽」那一段正好就在畫面裡，照付全額（量到 1634ms，等於
 * 沒加）。20 行一塊把同一份病理內容壓到 152–167ms。
 *
 * 估計尺寸由 `styles/preview.css` 依換不換行給（塊只帶 `--block-lines`／`--block-cols`）：換行時用「欄數 ÷ 一列
 * 放得下幾個字」估，不換行時每行剛好一列、給確切的高度。
 *
 * ## 長行（[#555](https://github.com/DemianLi/nexus-agent/issues/555)）
 *
 * `content-visibility` 切不進一行。超過 `LONG_LINE_CHARS` 字的行在畫面上切成幾段，每段一個
 * `content-visibility: auto` 的 inline-block（見 `line-segments.ts`）：同一條 199 萬字夾 5142 個 🏳 的行，換行
 * 模式從 1873ms 降到 35ms。**段與段之間不加任何字元**，複製出來就是原行。
 *
 * 超過頁上限、文字頁讀不動的行由 store 改走位元組窗口（見 `deliverable-file.ts`），在鏈上是一格
 * {@link DeliverableLongLine}：一個行號，內容隨捲動一個窗口一個窗口接長。
 *
 * ## 行號
 *
 * `offset + i + 1`：`offset` 是路由給的權威值（0 起算），畫面上的行號因此不會跟檔案的行號分岔。dsh 算同一個數
 * 但不顯示（只拿來跳行）；這裡畫出來，用 `::before` 畫，所以複製文字時不會被帶走。
 *
 * ## 讀不到的幾種
 *
 * 各自有話講（見 {@link DeliverableFileState}）：座標不對是 bug、錨不住是正常的、太大是拒絕不是截斷、不是文字要
 * 改走下載。發生在第一段就佔滿整個面；發生在後面，已經讀到的照畫，失敗接在最後。**只有真的讀壞了才給重試，
 * 而且不自動重試** —— 自動重試會對著一個永遠不會成功的錯誤一直打。
 *
 * **兩格有下載鈕**：`'not-text'` 是它本來就該去的地方；`'too-large'` 則是「這一段超過頁的位元組上限」，而下載
 * 吃的是另一道整檔上限（`maxFileBytes`，預設 32 MiB）。#555 之後文字頁的 413 先縮 `limit`、再改走位元組窗口，
 * 這一格只剩窗口本身回 413 才到得了。**那顆鈕不保證成功**：整檔超過下載的上限時它會撞 413，而下載的 413 是
 * 終局。那句話由 {@link DownloadAction} 自己講，這裡不預測。
 *
 * **`'not-text'` 可能讀到一半才出現**：server 只判它讀到的那一頁（NUL 只掃當頁，UTF-8 讀到哪判到哪），所以前面
 * 幾段畫得出來、後面某一段才被拒。那時話要講「接下來這一段」，跟 `'too-large'` 同一個道理。
 */

import type { DeliverableFilePage } from '@nexus/wire';
import { WrapText } from 'lucide-react';
import {
  Fragment,
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';

import { DownloadAction } from '@/components/deliverable-download-button';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { DeliverableDownloader } from '@/lib/deliverable-download';
import type {
  DeliverableFileEntry,
  DeliverableFileFailure,
  DeliverableFileState,
  DeliverableFileStore,
  DeliverableLongLine,
} from '@/lib/deliverable-file';
import { isLongLine, isPage } from '@/lib/deliverable-file';
import type { LocatedFile } from '@/lib/deliverables-view';
import { LONG_LINE_CHARS, columnsOf, layoutOf } from '@/lib/line-segments';
import { basename } from '@/lib/present-view';
import { cn } from '@/lib/utils';

/**
 * 幾行包成一塊 `content-visibility` 邊界。病理內容量過：50 行 178–201ms、20 行 152–167ms、再切小壓不下去
 * （快速跳著捲的下限是「一個視窗加預留邊距」要畫的行數，跟塊多大無關）。
 */
export const BLOCK_LINES = 20;

/** 離底部還有多遠就先讀下一段。 */
const PREFETCH_PX = 600;

/** 讀到的地方之後是什麼。 */
export type ChainTail =
  | { readonly kind: 'end' }
  | { readonly kind: 'next'; readonly offset: number }
  | {
      readonly kind: 'loading';
      readonly offset: number;
      /** 讀的是一條長行的下一個窗口，不是下一段。 */
      readonly window: boolean;
    }
  | { readonly kind: 'failed'; readonly offset: number; readonly state: DeliverableFileFailure };

/**
 * 從第 0 行開始走，把已經讀到的**連續前綴**走出來，停在第一個還沒讀、正在讀、或讀不到的地方。
 *
 * 下一段從**請求的 offset 加上這一段的 `lines`** 開始：`lines` 取自回應（每段幾行由路由決定），offset 取自
 * 我們自己的鍵，保證每一步都往前走。**`lines` 是 0 卻沒到檔尾**的一段會讓 offset 停在原地、這個迴圈永遠
 * 不結束，所以那一格當成檔尾。
 *
 * 不會拼出兩個版本：store 在新版本的頁落地時丟掉同一個檔其他版本的頁，鏈在斷掉的地方重讀。
 *
 * **長行佔一行**（#555）：它還沒讀完時，鏈停在它身上——它照樣畫出讀到的部分，尾巴是它的下一個窗口（`load`
 * 同一個 offset 讀的就是下一個窗口）。讀完才往下一行走。
 */
export function loadedChain(
  store: DeliverableFileStore,
  seq: number,
  index: number,
): { entries: readonly DeliverableFileEntry[]; tail: ChainTail } {
  const entries: DeliverableFileEntry[] = [];
  let offset = 0;
  for (;;) {
    const state: DeliverableFileState | undefined = store.read(seq, index, offset);
    if (state === undefined) return { entries, tail: { kind: 'next', offset } };
    if (state === 'loading') return { entries, tail: { kind: 'loading', offset, window: false } };
    if (isLongLine(state)) {
      entries.push(state);
      if (!state.done) {
        const tail: ChainTail =
          state.next === undefined
            ? { kind: 'next', offset }
            : state.next === 'loading'
              ? { kind: 'loading', offset, window: true }
              : { kind: 'failed', offset, state: state.next };
        return { entries, tail };
      }
      if (state.eof) return { entries, tail: { kind: 'end' } };
      offset += 1;
      continue;
    }
    if (!isPage(state)) return { entries, tail: { kind: 'failed', offset, state } };
    entries.push(state);
    if (state.eof || state.lines === 0) return { entries, tail: { kind: 'end' } };
    offset += state.lines;
  }
}

/**
 * 一段的每一行，照 dsh `linesOf`：路由的 `text` 是 `join('\n')`、結尾沒有換行，所以切出來剛好 `lines` 行；
 * `lines` 是 0 的一段是空陣列，不是一個空行。
 */
export function linesOf(page: DeliverableFilePage): string[] {
  return page.lines === 0 ? [] : page.text.split('\n');
}

function Status({ children, busy = false }: { children: ReactNode; busy?: boolean }) {
  return (
    <div
      className="text-muted-foreground flex items-center gap-3 px-4 py-4 text-sm"
      role={busy ? 'status' : undefined}
    >
      {children}
    </div>
  );
}

/**
 * 每一種結局講的話。分開寫是承重的：攤平成一句「讀不到」就分不出該不該重試、該不該改走下載。
 *
 * **窮盡列舉，沒有 fallthrough**：之後多一種失敗狀態時這裡是型別錯誤，而不是靜靜多一顆對著
 * 永遠不會成功的請求打的重試鈕。
 *
 * `midway`：失敗發生在第一段之後。上面已經畫了一部分，所以話要講成「接下來」，不能講得像整個檔都讀不到。
 */
function Failure({
  state,
  file,
  downloader,
  midway,
  onRetry,
}: {
  state: DeliverableFileFailure;
  file: LocatedFile;
  downloader: DeliverableDownloader | undefined;
  midway: boolean;
  onRetry: () => void;
}) {
  const download =
    downloader === undefined ? null : <DownloadAction file={file} downloader={downloader} />;
  switch (state) {
    case 'missing':
      return <Status>{midway ? '這個檔讀到一半就讀不到了' : '這個檔已經讀不到了'}</Status>;
    case 'too-large':
      // 上限是拒絕不是截斷，所以不能講成「只顯示前面一段」——那會讓人以為看到的是全部。
      return (
        <Status>
          {midway ? '接下來這一段太大，沒辦法在這裡預覽' : '檔案太大，沒辦法在這裡預覽'}
          {download}
        </Status>
      );
    case 'not-text':
      // 不只二進位：Big5 之類不是 UTF-8 的文字檔也落在這裡，所以不說「二進位」。
      return (
        <Status>
          {midway ? '接下來這一段不是文字，沒辦法預覽' : '不是文字檔，沒辦法預覽'}
          {download}
        </Status>
      );
    case 'invalid':
      // 座標是程式給的，不是人打的——會走到這裡就是我們算錯了，所以講法跟其他三種不同。
      return <Status>讀不到這個檔：座標不對</Status>;
    case 'error':
      return (
        <Status>
          {midway ? '沒辦法讀取下一段' : '沒辦法讀取這個檔'}
          <Button type="button" size="sm" variant="secondary" onClick={onRetry}>
            重試
          </Button>
        </Status>
      );
  }
}

/**
 * 一段，切成 {@link BLOCK_LINES} 行一塊。
 *
 * **`memo` 是承重的**：接上新的一段時，舊的每一段拿到的是同一個 `page` 物件（store 裡的頁不會被改），所以
 * 不重畫 —— 否則每接一段都要把前面所有段重新 reconcile 一次，接得越多越慢。換不換行也不經過這裡（容器上的
 * class 管），所以切換時不重建幾萬個節點。
 */
/** 現在換不換行。只有 {@link PerMode} 讀它：其他地方讀的話，切換一次就要重畫整份。 */
const WrapMode = createContext(true);

/**
 * 換不換行一變就把底下整個重掛（#555）。
 *
 * `content-visibility: auto` 會記住元素上一次畫出來的尺寸，畫面外時拿它當估計值；**這個「記住」關不掉**——
 * `styles/preview.css` 沒寫 `auto`，Chrome 算出來的 `contain-intrinsic-size` 仍是 `auto …`（2026-09-23 實測）。
 * 而長行在兩個模式下的尺寸差好幾個數量級：換行時畫過再切成不換行，一條 600 萬字的行捲動寬只剩 29.6 萬 px
 * （應該約 720 萬）；反過來則每段都記著 20px 的高度。新節點沒有記住的尺寸，會回到估計值。
 *
 * **只包有長行的地方**：一般的塊不重掛，切換時才不必重建幾萬個節點。
 */
function PerMode({ children }: { children: ReactNode }) {
  const wrap = useContext(WrapMode);
  return <Fragment key={wrap ? 'wrap' : 'nowrap'}>{children}</Fragment>;
}

const Page = memo(function Page({ page }: { page: DeliverableFilePage }) {
  const lines = linesOf(page);
  const blocks: ReactNode[] = [];
  for (let at = 0; at < lines.length; at += BLOCK_LINES) {
    const slice = lines.slice(at, at + BLOCK_LINES);
    // 估計尺寸在 `styles/preview.css`，這裡只給它要的兩個數。寬度交給排版（不換行時要由真的內容撐出捲動寬度）。
    const style = {
      '--block-lines': slice.length,
      '--block-cols': slice.reduce((sum, text) => sum + columnsOf(text), 0),
    } as CSSProperties;
    const block = (
      <div style={style} data-preview-block="">
        {slice.map((text, i) => (
          <Line key={at + i} number={page.offset + at + i + 1} text={text} complete />
        ))}
      </div>
    );
    const long = slice.some((text) => text.length > LONG_LINE_CHARS);
    blocks.push(long ? <PerMode key={at}>{block}</PerMode> : <Fragment key={at}>{block}</Fragment>);
  }
  return <>{blocks}</>;
});

/**
 * 一行。行號在 `::before`，不會被複製。
 *
 * `complete`：這一行讀完了。行尾的換行讓複製出來的文字一行一行的，同 dsh——還沒讀完的長行不加，
 * 否則複製到一半的那一截會多一個原檔沒有的換行。
 */
function Line({ number, text, complete }: { number: number; text: string; complete: boolean }) {
  const end = complete ? '\n' : '';
  return (
    <div
      data-line={number}
      className="before:text-muted-foreground flex px-4 tabular-nums before:w-[calc(var(--gutter)+0.75rem)] before:shrink-0 before:pr-3 before:text-right before:whitespace-nowrap before:content-[attr(data-line)]"
    >
      {text.length > LONG_LINE_CHARS ? <Segments text={text} end={end} /> : `${text}${end}`}
    </div>
  );
}

/**
 * 一條長行的段（#555，見 `line-segments.ts`）。段是 inline-block、各自 `content-visibility: auto`，估計尺寸吃
 * `--cols`（`styles/preview.css`）。超過 `ROW_CHARS` 字時再分成幾列，不換行時每列折一次（2²⁵ px 的上限）。
 *
 * **段與段之間不加任何字元**；行尾的換行放在最後一段裡。
 */
const Segments = memo(function Segments({ text, end }: { text: string; end: string }) {
  const rows = layoutOf(text);
  let index = 0;
  const last = rows.reduce((sum, row) => sum + row.length, 0) - 1;
  const rendered = rows.map((row) =>
    row.map((segment) => {
      const at = index++;
      return (
        <span
          key={at}
          data-preview-segment=""
          style={{ '--cols': segment.columns } as CSSProperties}
        >
          {at === last ? `${segment.text}${end}` : segment.text}
        </span>
      );
    }),
  );
  return (
    <span className="min-w-0 flex-1">
      {rendered.length === 1
        ? rendered[0]
        : rendered.map((row, r) => (
            <span key={r} data-preview-row="">
              {row}
            </span>
          ))}
    </span>
  );
});

/** 一條用位元組窗口讀的長行（#555）：一個行號，讀到哪畫到哪。 */
const LongLineView = memo(function LongLineView({ line }: { line: DeliverableLongLine }) {
  return (
    <PerMode>
      <Line number={line.offset + 1} text={line.text} complete={line.done} />
    </PerMode>
  );
});

/**
 * 捲到接近底的時候叫 `onNear`。`onNear` 是 `undefined` 就不掛 —— 呼叫端只在「還有下一段可讀」的時候給，
 * 所以正在讀、讀壞了、到檔尾都不會觸發，**讀壞了不會自動重打**。
 *
 * 沒有 `IntersectionObserver` 的環境（jsdom）直接叫，同 `use-viewport-highlighting.ts`。
 */
function useNearBottom(
  sentinel: RefObject<Element | null>,
  root: RefObject<Element | null>,
  onNear: (() => void) | undefined,
) {
  useEffect(() => {
    const element = sentinel.current;
    if (onNear === undefined || element === null) return;
    if (typeof IntersectionObserver === 'undefined') {
      onNear();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onNear();
      },
      { root: root.current, rootMargin: `0px 0px ${PREFETCH_PX}px 0px` },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [sentinel, root, onNear]);
}

/**
 * 一列放得下幾欄，掛在文字容器的 `--cpr` 上，給 `styles/preview.css` 估換行時的高度。
 *
 * **量的是捲動容器，不是文字容器**：不換行時文字容器是 `w-max`，一條長行就把它撐到上千萬 px，量它會得到
 * 「一列放得下兩百萬欄」。切回換行的那一幀還拿著這個數，每段都估成一列高，視窗附近一次擠進幾十段、每段
 * 4000 字全部排版——實測 1.9 MiB 夾 🏳 的行切回換行卡 213ms，其中樣式與排版 205ms、腳本 7ms。
 *
 * **直接寫 style，不進 React state**：寬度一變就重畫的話，每一個 memo 過的段都要重新 reconcile。量字寬用一個
 * 藏起來的探針，不用 `1ch` 硬算——字型換了也對。沒有 `ResizeObserver` 的環境（jsdom）不量，CSS 用預設值。
 */
function useCharsPerRow(
  target: RefObject<HTMLElement | null>,
  scroller: RefObject<HTMLElement | null>,
  digits: number,
  mounted: boolean,
) {
  useLayoutEffect(() => {
    const element = target.current;
    const frame = scroller.current;
    if (!mounted || element === null || frame === null || typeof ResizeObserver === 'undefined') {
      return;
    }
    const probe = document.createElement('span');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;left:-9999px';
    // 掛在 body、抄文字容器的字型：掛在容器裡的話，全選複製會把這串 0 一起帶走。
    probe.style.font = getComputedStyle(element).font;
    probe.textContent = '0'.repeat(100);
    document.body.append(probe);
    const measure = () => {
      const char = probe.getBoundingClientRect().width / 100;
      if (char <= 0) return;
      // 左右各 `px-4`，行號欄是位數加 `pr-3`。
      const room = frame.clientWidth - 32 - (digits * char + 12);
      element.style.setProperty('--cpr', String(Math.max(1, Math.floor(room / char))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => {
      observer.disconnect();
      probe.remove();
    };
  }, [target, scroller, digits, mounted]);
}

function PreviewBody({
  file,
  store,
  downloader,
  scroller,
  wrap,
}: {
  file: LocatedFile;
  store: DeliverableFileStore;
  downloader: DeliverableDownloader | undefined;
  scroller: RefObject<HTMLDivElement | null>;
  wrap: boolean;
}) {
  const { seq, index } = file;
  // 訂閱整個 store；鏈每一次都從 `read` 重新走出來（便宜：步數是已讀的段數）。
  useSyncExternalStore(store.subscribe, store.revision);
  const { entries, tail } = loadedChain(store, seq, index);
  const next = tail.kind === 'next' ? tail.offset : undefined;
  const started = entries.length > 0;

  // **第一段一打開就讀，不靠捲動**：看不見的頁面（例如被藏起來的分頁）不會觸發 IntersectionObserver，
  // 第一段不能等它。後面的段才等捲到接近底。**判準是「什麼都還沒讀到」，不是 `next === 0`**：第 0 行是一條
  // 長行時，它每讀完一個窗口 `next` 又回到 0，那樣會不等捲動就把整條長行讀完。
  useEffect(() => {
    if (!started && next === 0) store.load(seq, index, 0);
  }, [store, seq, index, next, started]);

  const sentinel = useRef<HTMLDivElement>(null);
  const loadNext = useCallback(() => {
    if (next !== undefined) store.load(seq, index, next);
  }, [store, seq, index, next]);
  useNearBottom(sentinel, scroller, started && next !== undefined ? loadNext : undefined);

  const text = useRef<HTMLDivElement>(null);
  const last = entries[entries.length - 1];
  const lastLine =
    last === undefined ? 0 : isLongLine(last) ? last.offset + 1 : last.offset + last.lines;
  const digits = String(lastLine).length;
  useCharsPerRow(text, scroller, digits, started);

  if (!started) {
    if (tail.kind === 'failed') {
      return (
        <Failure
          state={tail.state}
          file={file}
          downloader={downloader}
          midway={false}
          onRetry={() => store.load(seq, index, tail.offset)}
        />
      );
    }
    return <Status busy>正在讀取檔案…</Status>;
  }

  if (lastLine === 0) return <Status>這個檔是空的</Status>;

  // 行號欄的寬度跟著讀到的最後一行長：一千行的檔不需要留七位數的空白。`--gutter` 只是數字本身的寬度，
  // 右邊的 `pr-3` 另外加在 `::before` 的寬度上 —— 以前寫成「位數 + 1ch」，那 1ch（`text-xs` 約 7px）比 `pr-3`
  // 的 12px 窄，最大位數的行號放不下，換行時被 `overflow-wrap:anywhere` 折成兩行，每行變兩倍高。
  // `::before` 另外設 `nowrap`，寬度再算錯也只會溢出，不會折行。
  const gutter = { '--gutter': `${digits}ch` } as CSSProperties;
  return (
    <>
      <div
        className={cn(
          'py-2 font-mono text-xs leading-5',
          wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'w-max min-w-full whitespace-pre',
        )}
        style={gutter}
        ref={text}
        data-preview-wrap={wrap || undefined}
        data-testid="preview-text"
      >
        <WrapMode.Provider value={wrap}>
          {entries.map((entry) =>
            isLongLine(entry) ? (
              <LongLineView key={`long:${entry.offset}`} line={entry} />
            ) : (
              <Page key={entry.offset} page={entry} />
            ),
          )}
        </WrapMode.Provider>
      </div>
      {tail.kind === 'loading' && (
        <Status busy>{tail.window ? '正在讀取這一行的下一段…' : '正在讀取下一段…'}</Status>
      )}
      {tail.kind === 'failed' && (
        <Failure
          state={tail.state}
          file={file}
          downloader={downloader}
          midway
          onRetry={() => store.load(seq, index, tail.offset)}
        />
      )}
      <div ref={sentinel} aria-hidden="true" />
    </>
  );
}

export function DeliverablePreview({
  file,
  store,
  downloader,
  open,
  onOpenChange,
}: {
  file: LocatedFile | undefined;
  store: DeliverableFileStore;
  /** 沒給就不畫下載鈕——讀不到的那幾格仍然講得出發生了什麼事。 */
  downloader?: DeliverableDownloader;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // **預設換行**，同 dsh 文字預覽的 `wrap`（由讀的人關掉）。隔壁改動審查預設不換行 —— 那是比較兩側，這裡是讀。
  const [wrap, setWrap] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="pr-12">
          <SheetTitle className="truncate">
            {file === undefined ? '預覽' : basename(file.path)}
          </SheetTitle>
          <SheetDescription className="font-mono text-xs break-all">
            {file?.path ?? ''}
          </SheetDescription>
        </SheetHeader>
        <div className="flex items-center justify-end border-b px-4 pb-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={wrap}
            onClick={() => setWrap((value) => !value)}
          >
            <WrapText />
            自動換行
          </Button>
        </div>
        {/* 換一個檔就整個重掛：捲動位置回到頂端。`(seq, index)` 是座標，不是列表位置。 */}
        <div
          key={file === undefined ? '' : `${file.seq}:${file.index}`}
          ref={scroller}
          className="min-h-0 flex-1 overflow-auto"
        >
          {file !== undefined && (
            <PreviewBody
              file={file}
              store={store}
              downloader={downloader}
              scroller={scroller}
              wrap={wrap}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
