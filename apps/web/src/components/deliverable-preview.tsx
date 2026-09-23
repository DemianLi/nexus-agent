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
 * ## 行號
 *
 * `offset + i + 1`：`offset` 是路由給的權威值（0 起算），畫面上的行號因此不會跟檔案的行號分岔。dsh 算同一個數
 * 但不顯示（只拿來跳行）；這裡畫出來，用 `::before` 畫，所以複製文字時不會被帶走。
 *
 * ## 讀不到的幾種
 *
 * 各自有話講（見 {@link DeliverableFileState}）：座標不對是 bug、錨不住是正常的、太大是拒絕不是截斷、二進位要
 * 改走下載。發生在第一段就佔滿整個面；發生在後面，已經讀到的照畫，失敗接在最後。**只有真的讀壞了才給重試，
 * 而且不自動重試** —— 自動重試會對著一個永遠不會成功的錯誤一直打。
 *
 * **兩格有下載鈕**：`'binary'` 是它本來就該去的地方，`'too-large'` 則是因為預覽的 413 有兩個成因（整檔超過
 * 32 MiB，或這一頁超過 2 MiB），下載只吃前者。**那顆鈕不保證成功**：整檔真的超過上限時它會再撞一次 413，而
 * 下載的 413 是終局。那句話由 {@link DownloadAction} 自己講，這裡不預測。
 */

import type { DeliverableFilePage } from '@nexus/wire';
import { WrapText } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
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
  DeliverableFileFailure,
  DeliverableFileState,
  DeliverableFileStore,
} from '@/lib/deliverable-file';
import { isPage } from '@/lib/deliverable-file';
import type { LocatedFile } from '@/lib/deliverables-view';
import { basename } from '@/lib/present-view';
import { cn } from '@/lib/utils';

/**
 * 幾行包成一塊 `content-visibility` 邊界。病理內容量過：50 行 178–201ms、20 行 152–167ms、再切小壓不下去
 * （快速跳著捲的下限是「一個視窗加預留邊距」要畫的行數，跟塊多大無關）。
 */
export const BLOCK_LINES = 20;

/** 一行多高（`leading-5`）。只拿來估畫面外那幾塊的高度；畫過一次之後 `auto` 會記住真的高度。 */
const LINE_HEIGHT_PX = 20;

/** 離底部還有多遠就先讀下一段。 */
const PREFETCH_PX = 600;

/** 讀到的地方之後是什麼。 */
export type ChainTail =
  | { readonly kind: 'end' }
  | { readonly kind: 'next'; readonly offset: number }
  | { readonly kind: 'loading'; readonly offset: number }
  | { readonly kind: 'failed'; readonly offset: number; readonly state: DeliverableFileFailure };

/**
 * 從第 0 行開始走，把已經讀到的**連續前綴**走出來，停在第一個還沒讀、正在讀、或讀不到的地方。
 *
 * 下一段從**請求的 offset 加上這一段的 `lines`** 開始：`lines` 取自回應（每段幾行由路由決定），offset 取自
 * 我們自己的鍵，保證每一步都往前走。**`lines` 是 0 卻沒到檔尾**的一段會讓 offset 停在原地、這個迴圈永遠
 * 不結束，所以那一格當成檔尾。
 *
 * 不會拼出兩個版本：store 在新版本的頁落地時丟掉同一個檔其他版本的頁，鏈在斷掉的地方重讀。
 */
export function loadedChain(
  store: DeliverableFileStore,
  seq: number,
  index: number,
): { pages: readonly DeliverableFilePage[]; tail: ChainTail } {
  const pages: DeliverableFilePage[] = [];
  let offset = 0;
  for (;;) {
    const state: DeliverableFileState | undefined = store.read(seq, index, offset);
    if (state === undefined) return { pages, tail: { kind: 'next', offset } };
    if (state === 'loading') return { pages, tail: { kind: 'loading', offset } };
    if (!isPage(state)) return { pages, tail: { kind: 'failed', offset, state } };
    pages.push(state);
    if (state.eof || state.lines === 0) return { pages, tail: { kind: 'end' } };
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
    case 'binary':
      return (
        <Status>
          二進位檔，沒辦法預覽
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
const Page = memo(function Page({ page }: { page: DeliverableFilePage }) {
  const lines = linesOf(page);
  const blocks: ReactNode[] = [];
  for (let at = 0; at < lines.length; at += BLOCK_LINES) {
    const slice = lines.slice(at, at + BLOCK_LINES);
    // 只估區塊方向的高度：寬度交給排版（不換行時要由真的內容撐出捲動寬度）。
    const style: CSSProperties = {
      containIntrinsicBlockSize: `auto ${slice.length * LINE_HEIGHT_PX}px`,
    };
    blocks.push(
      <div key={at} className="[content-visibility:auto]" style={style} data-preview-block="">
        {slice.map((text, i) => {
          const number = page.offset + at + i + 1;
          return (
            <div
              key={number}
              data-line={number}
              className="before:text-muted-foreground flex px-4 tabular-nums before:w-(--gutter) before:shrink-0 before:pr-3 before:text-right before:content-[attr(data-line)]"
            >
              {/* 行尾的換行讓複製出來的文字一行一行的，同 dsh；行號在 `::before`，不會被複製。 */}
              {`${text}\n`}
            </div>
          );
        })}
      </div>,
    );
  }
  return <>{blocks}</>;
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
  const { pages, tail } = loadedChain(store, seq, index);
  const next = tail.kind === 'next' ? tail.offset : undefined;

  // **第一段一打開就讀，不靠捲動**：看不見的頁面（例如被藏起來的分頁）不會觸發 IntersectionObserver，
  // 第一段不能等它。後面的段才等捲到接近底。
  useEffect(() => {
    if (next === 0) store.load(seq, index, 0);
  }, [store, seq, index, next]);

  const sentinel = useRef<HTMLDivElement>(null);
  const loadNext = useCallback(() => {
    if (next !== undefined) store.load(seq, index, next);
  }, [store, seq, index, next]);
  useNearBottom(sentinel, scroller, next !== undefined && next > 0 ? loadNext : undefined);

  if (pages.length === 0) {
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

  const last = pages[pages.length - 1]!;
  const lastLine = last.offset + last.lines;
  if (lastLine === 0) return <Status>這個檔是空的</Status>;

  // 行號欄的寬度跟著讀到的最後一行長：一千行的檔不需要留七位數的空白。
  const gutter = { '--gutter': `${String(lastLine).length + 1}ch` } as CSSProperties;
  return (
    <>
      <div
        className={cn(
          'py-2 font-mono text-xs leading-5',
          wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'w-max min-w-full whitespace-pre',
        )}
        style={gutter}
        data-preview-wrap={wrap || undefined}
        data-testid="preview-text"
      >
        {pages.map((page) => (
          <Page key={page.offset} page={page} />
        ))}
      </div>
      {tail.kind === 'loading' && <Status busy>正在讀取下一段…</Status>}
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
