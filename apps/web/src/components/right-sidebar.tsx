/**
 * 右側欄（[#640](https://github.com/DemianLi/nexus-agent/issues/640)）：改動比對與交付預覽住的地方，一格停靠＋分頁。
 *
 * - **1024 以上停靠**：會話區讓出寬度，左緣可以拖寬（會話區至少留 480、面板至少 320）。收起時整欄藏起來但不卸載，
 *   分頁裡的捲動位置與切換鈕留著。Esc 不做事——它是頁面的一欄，不是蓋在上面的東西。
 * - **1024 以下全螢幕覆蓋**：用 `Sheet`，Esc 或收起鈕關掉；關掉等同收起，分頁照樣留著（斷點同左側欄，`use-mobile.ts`）。
 *   **窄螢幕載入時一律從收起開始**，不照存下來的「開著」恢復：一進來整個對話就被蓋住不是人要的。
 * - **分頁第一次被選中才掛上**：重新整理後恢復十個分頁，不該一口氣打十份讀取。掛過之後切走只是藏起來。
 *
 * 狀態與記在 `localStorage` 的那一半在 `lib/right-sidebar.ts`。面向參考 dsh `ui-sidebar-right`（面板沒有標題行、
 * 分頁列就是上緣、收起鈕在分頁列末端），分格、浮窗、拖放、復原、快捷鍵、引導頁不做（#640 決定 1）。
 *
 * ## 分頁的關閉鈕不能聚焦
 *
 * `tablist` 裡只能有 `tab`，多一顆可聚焦的關閉鈕 axe 就報 `aria-required-children`（實測）。所以 × 只給滑鼠，
 * 鍵盤在分頁上按 Delete 關（`aria-keyshortcuts` 讓讀屏講出來）。
 */

import { FileDiff, FileText, PanelRight, PanelRightClose, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode, RefObject } from 'react';

import { ChangesReviewTab } from '@/components/changes-review';
import { DeliverablePreviewTab } from '@/components/deliverable-preview';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import type { ChangesStores } from '@/lib/changes-diff';
import type { DeliverableDownloader } from '@/lib/deliverable-download';
import type { DeliverableFileStore } from '@/lib/deliverable-file';
import type { LocatedFile } from '@/lib/deliverables-view';
import { basename } from '@/lib/present-view';
import {
  MIN_PANEL_WIDTH,
  clampPanelWidth,
  closeTab,
  openTab,
  readLayout,
  readWidth,
  selectTab,
  setChangesIndex,
  setOpen,
  tabKey,
  writeLayout,
  writeWidth,
} from '@/lib/right-sidebar';
import type { SidebarLayout, SidebarTab } from '@/lib/right-sidebar';
import { cn } from '@/lib/utils';

/** 停靠面板的 id：開關鈕的 `aria-controls` 指它。 */
export const RIGHT_SIDEBAR_ID = 'right-sidebar';

/** 空狀態那一句（#640 決定 3）。 */
export const RIGHT_SIDEBAR_EMPTY_TEXT =
  '這裡會顯示改動比對與交付預覽。從對話裡的改動卡或交付卡打開。';

/** 鍵盤調寬一次幾像素。 */
const KEYBOARD_STEP = 16;

/** 內容從哪裡讀：跟著這條會話的畫面走（`App.tsx` 建）。 */
export interface RightSidebarSources {
  readonly changes?: ChangesStores | undefined;
  readonly deliverableFiles?: DeliverableFileStore | undefined;
  readonly deliverableDownload?: DeliverableDownloader | undefined;
}

/** 卡片用得到的那一半。 */
export interface RightSidebarApi {
  openChanges(seq: number, index: number): void;
  /** 沒有讀檔的 store 時是 `undefined`：交付卡就不畫預覽鈕。 */
  readonly openDeliverable: ((file: LocatedFile) => void) | undefined;
}

interface RightSidebarControl {
  readonly api: RightSidebarApi;
  readonly layout: SidebarLayout;
  readonly sources: RightSidebarSources;
  readonly isMobile: boolean;
  readonly width: number;
  /** 標頭的開關鈕：停靠時從面板裡收起，焦點交回這裡。 */
  readonly toggle: RefObject<HTMLButtonElement | null>;
  update(change: (layout: SidebarLayout) => SidebarLayout): void;
  setWidth(width: number, commit: boolean): void;
}

const Control = createContext<RightSidebarControl | undefined>(undefined);

/**
 * 卡片打開分頁用。**沒有右側欄時是 `undefined`**，卡片就不畫那顆鈕：一顆按了沒反應的鈕比不給更糟
 * （同 `deliverable-download-button.tsx`）。
 */
export function useRightSidebar(): RightSidebarApi | undefined {
  return useContext(Control)?.api;
}

export function RightSidebarProvider({
  threadId,
  sources,
  children,
}: {
  threadId: string;
  sources: RightSidebarSources;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  // 初始化器只讀不寫（StrictMode 會跑兩次）。窄螢幕從收起開始，見檔頭。
  const [layout, setLayout] = useState(() => {
    const saved = readLayout(threadId);
    return isMobile ? setOpen(saved, false) : saved;
  });
  const [width, setWidthState] = useState(readWidth);
  // **人動過才寫**：打開一條會話看一眼不算用過右側欄，不該佔掉記憶的一格（`writeLayout`）。
  const touched = useRef(false);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (touched.current) writeLayout(threadId, layout);
  }, [threadId, layout]);

  const update = useCallback((change: (layout: SidebarLayout) => SidebarLayout) => {
    touched.current = true;
    setLayout(change);
  }, []);
  const setWidth = useCallback((next: number, commit: boolean) => {
    setWidthState(next);
    if (commit) writeWidth(next);
  }, []);

  const canPreview = sources.deliverableFiles !== undefined;
  const api = useMemo<RightSidebarApi>(
    () => ({
      openChanges: (seq, index) =>
        update((current) => openTab(current, { kind: 'changes', seq, index })),
      openDeliverable: canPreview
        ? (file) => update((current) => openTab(current, { kind: 'deliverable', file }))
        : undefined,
    }),
    [update, canPreview],
  );
  const control = useMemo<RightSidebarControl>(
    () => ({ api, layout, sources, isMobile, width, toggle, update, setWidth }),
    [api, layout, sources, isMobile, width, update, setWidth],
  );
  return <Control.Provider value={control}>{children}</Control.Provider>;
}

function useControl(): RightSidebarControl {
  const control = useContext(Control);
  if (control === undefined) throw new Error('右側欄的元件要放在 RightSidebarProvider 裡');
  return control;
}

/** 會話標頭那一列右端的開關鈕（#640 決定 2；#655 確認不用再搬）。 */
export function RightSidebarToggle({ className }: { className?: string }) {
  const { layout, isMobile, toggle, update } = useControl();
  const label = layout.open ? '收起右側欄' : '打開右側欄';
  return (
    <Button
      ref={toggle}
      type="button"
      variant="ghost"
      size="icon"
      className={className}
      aria-label={label}
      title={label}
      aria-expanded={layout.open}
      {...(isMobile ? {} : { 'aria-controls': RIGHT_SIDEBAR_ID })}
      onClick={() => update((current) => setOpen(current, !current.open))}
    >
      <PanelRight />
    </Button>
  );
}

/** 面板本體：寬螢幕停靠，窄螢幕全螢幕覆蓋。放在 `SidebarInset` 後面、同一排。 */
export function RightSidebarPanel() {
  const { layout, isMobile, width, update } = useControl();
  if (isMobile) {
    return (
      <Sheet
        open={layout.open}
        onOpenChange={(open) => update((current) => setOpen(current, open))}
      >
        <SheetContent
          side="right"
          showCloseButton={false}
          className="w-full gap-0 p-0 sm:max-w-none"
          data-testid="right-sidebar"
        >
          <SheetTitle className="sr-only">右側欄</SheetTitle>
          <SheetDescription className="sr-only">改動比對與交付預覽</SheetDescription>
          <PanelContents />
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <aside
      id={RIGHT_SIDEBAR_ID}
      aria-label="右側欄"
      hidden={!layout.open}
      data-testid="right-sidebar"
      className="bg-background relative flex h-svh min-w-80 flex-col border-l"
      // 收縮的權重壓在面板這一側：視窗變窄時面板先縮到 320，才輪到會話區讓（1024 寬、左側欄展開時兩個下限
      // 放不下，見 `clampPanelWidth`）。
      style={{ flex: `0 100 ${width}px` }}
    >
      <ResizeHandle />
      <PanelContents />
    </aside>
  );
}

/** 會話區與面板加起來多寬：拖寬的上限從這裡算。量不到（jsdom）時是 `undefined`。 */
function measureRoom(aside: HTMLElement | null): number | undefined {
  const main = aside?.previousElementSibling;
  if (aside === null || !(main instanceof HTMLElement)) return undefined;
  const room = main.getBoundingClientRect().width + aside.getBoundingClientRect().width;
  return room > 0 ? room : undefined;
}

function ResizeHandle() {
  const { width, setWidth } = useControl();
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number; room: number | undefined } | undefined>(
    undefined,
  );
  const latest = useRef(width);
  latest.current = width;

  const clamp = (next: number, room: number | undefined) =>
    room === undefined ? Math.max(MIN_PANEL_WIDTH, Math.round(next)) : clampPanelWidth(next, room);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const aside = handle.current?.parentElement ?? null;
    drag.current = {
      x: event.clientX,
      width: aside?.getBoundingClientRect().width || width,
      room: measureRoom(aside),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.style.userSelect = 'none';
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (start === undefined) return;
    // 把手在面板左緣：往左拉是變寬。
    setWidth(clamp(start.width + (start.x - event.clientX), start.room), false);
  };
  const onPointerUp = () => {
    if (drag.current === undefined) return;
    drag.current = undefined;
    document.body.style.userSelect = '';
    setWidth(latest.current, true);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const room = measureRoom(handle.current?.parentElement ?? null);
    const step = { ArrowLeft: KEYBOARD_STEP, ArrowRight: -KEYBOARD_STEP }[event.key];
    let next: number | undefined;
    if (step !== undefined) next = width + step;
    else if (event.key === 'Home') next = MIN_PANEL_WIDTH;
    else if (event.key === 'End') next = room ?? width;
    if (next === undefined) return;
    event.preventDefault();
    setWidth(clamp(next, room), true);
  };

  const room = measureRoom(handle.current?.parentElement ?? null);
  return (
    <div
      ref={handle}
      role="separator"
      aria-orientation="vertical"
      aria-label="調整右側欄寬度"
      aria-valuemin={MIN_PANEL_WIDTH}
      aria-valuemax={room === undefined ? width : Math.max(width, clampPanelWidth(room, room))}
      aria-valuenow={width}
      tabIndex={0}
      className="hover:bg-border focus-visible:bg-ring absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize outline-none transition-colors duration-(--duration-quick)"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    />
  );
}

const domId = (key: string) => `right-sidebar-${key.replace(/:/g, '-')}`;

function PanelContents() {
  const { layout, isMobile, toggle, update } = useControl();
  const { tabs, active } = layout;
  // 選中過的分頁才掛上（見檔頭）。用 render 期間的衍生 state，選中的那一刻就掛，不等 effect 多畫一格空白。
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set());
  if (active !== undefined && !visited.has(active)) setVisited(new Set(visited).add(active));
  const collapse = useRef<HTMLButtonElement>(null);

  return (
    <>
      <div className="flex h-14 shrink-0 items-center gap-1 border-b px-2">
        <TabStrip collapseRef={collapse} />
        <Button
          ref={collapse}
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 shrink-0 rounded-full lg:size-9"
          aria-label="收起右側欄"
          title="收起右側欄"
          onClick={() => {
            update((current) => setOpen(current, false));
            // 停靠時面板一藏，焦點就掉到 body；交回標頭的開關鈕。覆蓋那一種由 Sheet 自己還焦點。
            if (!isMobile) toggle.current?.focus();
          }}
        >
          <PanelRightClose />
        </Button>
      </div>
      {tabs.length === 0 ? (
        <p className="text-muted-foreground flex flex-1 items-center justify-center px-6 text-center text-sm">
          {RIGHT_SIDEBAR_EMPTY_TEXT}
        </p>
      ) : (
        tabs.map((tab) => {
          const key = tabKey(tab);
          if (!visited.has(key) && key !== active) return null;
          return (
            <div
              key={key}
              role="tabpanel"
              id={`${domId(key)}-panel`}
              aria-labelledby={domId(key)}
              hidden={key !== active}
              className="flex min-h-0 flex-1 flex-col"
            >
              <TabBody tab={tab} />
            </div>
          );
        })
      )}
    </>
  );
}

function TabBody({ tab }: { tab: SidebarTab }) {
  const { sources, update } = useControl();
  if (tab.kind === 'changes') {
    return sources.changes === undefined ? null : (
      <ChangesReviewTab
        seq={tab.seq}
        index={tab.index}
        changes={sources.changes}
        onSelect={(index) => update((current) => setChangesIndex(current, tab.seq, index))}
      />
    );
  }
  return sources.deliverableFiles === undefined ? null : (
    <DeliverablePreviewTab
      file={tab.file}
      store={sources.deliverableFiles}
      downloader={sources.deliverableDownload}
    />
  );
}

function TabStrip({ collapseRef }: { collapseRef: RefObject<HTMLButtonElement | null> }) {
  const { layout, update } = useControl();
  // 用鍵盤關掉或換分頁之後，焦點跟著到新選中的那一個（沒有分頁了就到收起鈕）。
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    const target =
      layout.active === undefined
        ? collapseRef.current
        : document.getElementById(domId(layout.active));
    target?.focus();
  }, [layout.active, layout.tabs, collapseRef]);

  // 選中的分頁捲進看得見的地方（分頁多到要橫向捲動時，從卡片開的那一個可能在畫面外）。
  useEffect(() => {
    if (layout.active === undefined) return;
    document
      .getElementById(domId(layout.active))
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [layout.active]);

  const keys = layout.tabs.map(tabKey);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, key: string) => {
    const at = keys.indexOf(key);
    let target: string | undefined;
    if (event.key === 'ArrowRight') target = keys[(at + 1) % keys.length];
    else if (event.key === 'ArrowLeft') target = keys[(at - 1 + keys.length) % keys.length];
    else if (event.key === 'Home') target = keys[0];
    else if (event.key === 'End') target = keys[keys.length - 1];
    else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      refocus.current = true;
      update((current) => closeTab(current, key));
      return;
    }
    if (target === undefined) return;
    event.preventDefault();
    refocus.current = true;
    update((current) => selectTab(current, target));
  };

  return (
    <div
      role="tablist"
      aria-label="右側欄分頁"
      // 分頁先像瀏覽器那樣縮（標題截斷，最窄 112），縮到底才捲；捲軸用細的，別讓傳統捲軸吃掉分頁列。
      className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:thin]"
    >
      {layout.tabs.map((tab) => {
        const key = tabKey(tab);
        return (
          <TabChip
            key={key}
            tab={tab}
            selected={key === layout.active}
            onSelect={() => update((current) => selectTab(current, key))}
            onClose={() => update((current) => closeTab(current, key))}
            onKeyDown={(event) => onKeyDown(event, key)}
          />
        );
      })}
    </div>
  );
}

/** 改動分頁的標題：光靠摘要算得出來，不需要輪次（#640 決定 11）。 */
export function changesTabTitle(
  summary: { files: readonly { display: string }[]; total: number } | undefined,
): { label: string; detail: string | undefined } {
  const first = summary?.files[0];
  if (summary === undefined || first === undefined) return { label: '改動', detail: undefined };
  const name = basename(first.display);
  const label = summary.total > 1 ? `改動 · ${name} 等 ${summary.total} 個` : `改動 · ${name}`;
  const unlisted = summary.total - summary.files.length;
  const detail = [
    ...summary.files.map((file) => file.display),
    ...(unlisted > 0 ? [`另有 ${unlisted} 個檔沒有列出`] : []),
  ].join('\n');
  return { label, detail };
}

function useTabTitle(tab: SidebarTab): { label: string; detail: string | undefined } {
  const { sources } = useControl();
  const store = sources.changes?.summary;
  const seq = tab.kind === 'changes' ? tab.seq : undefined;
  const summary = useSyncExternalStore(store?.subscribe ?? noSubscribe, () =>
    store === undefined || seq === undefined ? undefined : store.read(seq),
  );
  useEffect(() => {
    if (store !== undefined && seq !== undefined) store.load(seq);
  }, [store, seq]);
  if (tab.kind === 'deliverable') return { label: basename(tab.file.path), detail: tab.file.path };
  return changesTabTitle(typeof summary === 'object' ? summary : undefined);
}

const noSubscribe = () => () => {};

function TabChip({
  tab,
  selected,
  onSelect,
  onClose,
  onKeyDown,
}: {
  tab: SidebarTab;
  selected: boolean;
  onSelect: () => void;
  onClose: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const key = tabKey(tab);
  const { label, detail } = useTabTitle(tab);
  const Icon = tab.kind === 'changes' ? FileDiff : FileText;
  return (
    <div
      role="none"
      className={cn(
        'group flex h-9 max-w-56 min-w-28 shrink items-center rounded-lg transition-colors duration-(--duration-quick)',
        selected ? 'bg-chip-hover text-foreground' : 'text-muted-foreground hover:bg-chip-hover',
      )}
      data-testid="right-sidebar-tab"
    >
      <button
        type="button"
        role="tab"
        id={domId(key)}
        aria-selected={selected}
        aria-controls={`${domId(key)}-panel`}
        aria-keyshortcuts="Delete"
        tabIndex={selected ? 0 : -1}
        title={detail}
        className="focus-visible:ring-ring/50 flex h-full min-w-0 items-center gap-2 rounded-lg pr-1 pl-3 text-sm outline-none focus-visible:ring-[3px]"
        onClick={onSelect}
        onKeyDown={onKeyDown}
      >
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </button>
      {/* 不可聚焦、讀屏看不到：鍵盤用 Delete 關（見檔頭）。 */}
      <span
        aria-hidden
        className="hover:bg-chip-pressed mr-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md"
        onClick={onClose}
        data-testid="right-sidebar-tab-close"
      >
        <X className="size-3.5" />
      </span>
    </div>
  );
}
