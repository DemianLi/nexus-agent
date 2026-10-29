/**
 * 右側欄（[#640](https://github.com/DemianLi/nexus-agent/issues/640)）：改動比對與交付預覽住的地方，一格停靠＋分頁。
 *
 * - **1024 以上停靠**：會話區讓出寬度，左緣可以拖寬（會話區至少留 480、面板至少 320）。收起時整欄藏起來但不卸載，
 *   分頁裡的捲動位置與切換鈕留著。Esc 不做事——它是頁面的一欄，不是蓋在上面的東西。
 * - **1024 以下全螢幕覆蓋**：用 `Sheet`，Esc 或收起鈕關掉；關掉等同收起，分頁照樣留著（斷點同左側欄，`use-mobile.ts`）。
 *   **窄螢幕載入時一律從收起開始**，不照存下來的「開著」恢復：一進來整個對話就被蓋住不是人要的。
 * - **分頁第一次被選中才掛上**：重新整理後恢復十個分頁，不該一口氣打十份讀取。掛過之後切走只是藏起來。
 * - **計劃（#654）**：審核面板與計劃卡按「查看全文」打開同一個分頁，焦點進分頁，停靠時收起鈕把焦點交回按下去的那顆；
 *   待審時 1024 以上自動停靠一次（`autoOpenPlan`），1024 以下不自動開。內容先讀對話裡那一份（`sources.plans`）；
 *   不在載入的對話裡時往前掃歷史找它（#1798），見 `PlanTab`。
 *
 * 檔案分工：契約型別（`RightSidebarSources`、`RightSidebarApi`、`PanelBodyProps`、`TurnReveal`）在 `lib/right-sidebar-api.ts`，
 * context 與卡片用的 `useRightSidebar` 在 `right-sidebar-context.ts`；面板與卡片只取這兩處，不 import 回這個檔（#1127）。
 *
 * 狀態與記在 `localStorage` 的那一半在 `lib/right-sidebar.ts`。面向參考 dsh `ui-sidebar-right`（面板沒有標題行、
 * 分頁列就是上緣、收起鈕在分頁列末端），分格、浮窗、拖放、復原、快捷鍵、引導頁不做（#640 決定 1）。
 *
 * ## 分頁的關閉鈕不能聚焦
 *
 * `tablist` 裡只能有 `tab`，多一顆可聚焦的關閉鈕 axe 就報 `aria-required-children`（實測）。所以 × 只給滑鼠，
 * 鍵盤在分頁上按 Delete 關（`aria-keyshortcuts` 讓讀屏講出來）。
 */

import {
  FileDiff,
  FileText,
  LocateFixed,
  PanelRight,
  PanelRightClose,
  ScrollText,
  X,
} from 'lucide-react';
import {
  useCallback,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode, RefObject } from 'react';

import { ChangesReviewTab } from '@/components/changes/review';
import { DeliverablePreviewTab } from '@/components/deliverable/preview';
import { PlanPreviewTab } from '@/components/plan/preview-tab';
import { Control, useControl } from '@/components/sidebar/right-sidebar-context';
import type { RightSidebarControl } from '@/components/sidebar/right-sidebar-context';
import { PANELS } from '@/components/sidebar/right-sidebar-panels';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { REVIEW_PLAN_ID_PREFIX } from '@/lib/plan-review';
import type { PlanScanOutcome } from '@/lib/plan-review';
import { basename } from '@/lib/present-view';
import { TRACE_LOCATE_LOADING_TEXT } from '@/lib/trace-view';
import {
  findOrExpandTranscriptItem,
  focusTranscriptItem,
  revealTranscriptItem,
} from '@/lib/transcript-locate';
import {
  MIN_PANEL_WIDTH,
  clampPanelWidth,
  closeTab,
  isPanelTab,
  openTab,
  planTab,
  readLayout,
  readWidth,
  selectTab,
  setChangesIndex,
  setOpen,
  setPlanTitle,
  tabKey,
  writeLayout,
  writeWidth,
} from '@/lib/right-sidebar';
import { PANEL_KINDS } from '@/lib/right-sidebar';
import type { RightSidebarApi, RightSidebarSources, TurnReveal } from '@/lib/right-sidebar-api';
import type { SidebarLayout, SidebarTab } from '@/lib/right-sidebar';
import { cn } from '@/lib/utils';

/** 停靠面板的 id：開關鈕的 `aria-controls` 指它。 */
export const RIGHT_SIDEBAR_ID = 'right-sidebar';

/** 空狀態那一句（#640 決定 3；#1031 加上觀測與成本的入口鈕）。 */
export const RIGHT_SIDEBAR_EMPTY_TEXT =
  '這裡會顯示改動比對、交付預覽與計劃，從對話裡的卡片打開。觀測與成本可以直接打開：';

/** 計劃分頁找不到那一份時（還沒載入到那一段對話，或存下來的分頁指到別處）。 */
export const PLAN_TAB_MISSING_TEXT =
  '這份計劃不在目前載入的對話裡。往上捲載入更早的對話，或從計劃卡重新打開。';

/** 計劃分頁那顆「先載到那一輪再定位」的鈕（#1798）。說法同觀測分頁的定位鈕。 */
export const PLAN_TAB_LOCATE_LABEL = '載入那一段對話並在對話裡定位';

/** 旁路掃描還在讀歷史（#1798）。 */
export const PLAN_TAB_SCANNING_TEXT = '正在從更早的對話裡找這份計劃…';

/** 掃描讀取失敗時那一句的開頭，後面接伺服器給的原因。 */
export const PLAN_TAB_READ_FAILED_LEAD = '讀不到這份計劃：';

/** 掃描找到了，但對話裡還沒載到它：全文上方那一句。 */
export const PLAN_TAB_SCANNED_TEXT = '這份計劃在更早的對話裡，還沒載入對話區。';

/** 載完了還是沒有這份計劃（載入失敗、換代被丟掉）。 */
export const PLAN_TAB_STILL_MISSING_TEXT =
  '載完了，這份計劃仍不在載入的對話裡。載入失敗的原因寫在對話區上方「載入更早的對話」旁邊。';

/** 鍵盤調寬一次幾像素。 */
const KEYBOARD_STEP = 16;

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
  const focusTab = useRef<string | undefined>(undefined);
  const returnFocus = useRef<HTMLElement | null>(null);
  const locateFocus = useRef<HTMLElement | null>(null);
  const [reveal, setReveal] = useState<TurnReveal | undefined>(undefined);
  const revealCount = useRef(0);
  const notePlanTitle = useCallback(
    (id: string, title: string | undefined) =>
      setLayout((current) => setPlanTitle(current, id, title)),
    [],
  );
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

  const settleReveal = useCallback(
    (nonce: number) => setReveal((current) => (current?.nonce === nonce ? undefined : current)),
    [],
  );
  const canPreview = sources.deliverableFiles !== undefined;
  const api = useMemo<RightSidebarApi>(() => {
    /** 已經開著就留著它記下的標題：再打開不該把它洗掉。標題由掛上之後的 `PlanTab` 記（`notePlanTitle`）。 */
    const openPlanTab = (current: SidebarLayout, id: string) =>
      openTab(
        current,
        current.tabs.find((tab) => tab.kind === 'plan' && tab.id === id) ?? planTab(id, undefined),
      );
    return {
      openChanges: (seq, index) =>
        update((current) => openTab(current, { kind: 'changes', seq, index })),
      openDeliverable: canPreview
        ? (file) => update((current) => openTab(current, { kind: 'deliverable', file }))
        : undefined,
      openPlan: (id, from) => {
        focusTab.current = tabKey({ kind: 'plan', id });
        returnFocus.current = from ?? null;
        update((current) => openPlanTab(current, id));
      },
      autoOpenPlan: (id) => {
        if (isMobile) return false;
        update((current) => openPlanTab(current, id));
        return true;
      },
      openPanel: (kind, from) => {
        const tab: SidebarTab = { kind };
        focusTab.current = tabKey(tab);
        returnFocus.current = from ?? null;
        update((current) => openTab(current, tab));
      },
      revealTurn: (seq) => {
        revealCount.current += 1;
        setReveal({ seq, nonce: revealCount.current });
        update((current) => openTab(current, { kind: 'trace' }));
      },
      revealReply: (messageId, from) => {
        // 先把焦點交給分頁（那一輪找不到時就停在這）；找得到時觀測分頁隨後把焦點放到那一輪的標題。
        focusTab.current = tabKey({ kind: 'trace' });
        returnFocus.current = from ?? null;
        revealCount.current += 1;
        setReveal({ messageId, nonce: revealCount.current });
        update((current) => openTab(current, { kind: 'trace' }));
      },
      locate: (entryId) => {
        // 收在一段工具呼叫裡的（#1309）先展開再捲過去。
        const item = findOrExpandTranscriptItem(entryId);
        if (item === undefined) return false;
        revealTranscriptItem(item);
        if (isMobile) {
          locateFocus.current = item;
          update((current) => setOpen(current, false));
        }
        return true;
      },
    };
  }, [update, canPreview, isMobile]);
  const control = useMemo<RightSidebarControl>(
    () => ({
      api,
      layout,
      sources,
      isMobile,
      width,
      toggle,
      focusTab,
      returnFocus,
      locateFocus,
      notePlanTitle,
      reveal,
      settleReveal,
      update,
      setWidth,
    }),
    [api, layout, sources, isMobile, width, notePlanTitle, reveal, settleReveal, update, setWidth],
  );
  return <Control.Provider value={control}>{children}</Control.Provider>;
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

/**
 * 面板本體：寬螢幕停靠，窄螢幕全螢幕覆蓋。放在 `SidebarInset` 後面、同一排。
 *
 * **`memo` 是承重的**（#1031）：它跟會話一起在 `App` 裡畫，沒有 props，而 `App` 每收一格串流就重畫一次——沒有 `memo` 的話，
 * 每一格都連分頁列、所有已掛上的分頁內容一起重畫（實測：5 次無關的父層重畫，面板提交 5 次）。有 `memo` 之後只有 context
 * 變了（版面、寬度、`sources`）才重畫，所以 `sources` 的身分要穩（`App` 用 `useMemo`），別把隨串流變的東西放進去。
 */
export const RightSidebarPanel = memo(function RightSidebarPanel() {
  const { layout, isMobile, width, locateFocus, returnFocus, toggle, update } = useControl();
  if (isMobile) {
    return (
      <Sheet
        open={layout.open}
        onOpenChange={(open) => update((current) => setOpen(current, open))}
      >
        <SheetContent
          side="right"
          showCloseButton={false}
          // 寬度：窄螢幕整面、`sm` 以上不設上限（交給外層）。前綴跟 SG 的 `data-[side=right]:w-3/4`、`data-[side=right]:sm:max-w-sm`
          // 同一組，cn 才蓋得掉（#1583）。
          className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-none"
          data-testid="right-sidebar"
          // 沒有 Trigger（受控開啟），焦點自己還（spec §8）：從觀測分頁定位時交給對話裡那一則；其餘交回從哪裡打開的那顆
          // （「查看全文」、「這一輪的過程」），不在了就交回標頭的開關鈕。Radix 的預設在沒有 Trigger 時什麼都不還，焦點掉到 body
          // （實機量到，#1034）。Base UI 用 Popup 的 `finalFocus`（#1583）：回傳 false 是「不要再搬」，焦點已經自己交了。
          finalFocus={() => {
            const target = locateFocus.current;
            if (target !== null) {
              locateFocus.current = null;
              focusTranscriptItem(target);
              return false;
            }
            const back = returnFocus.current;
            returnFocus.current = null;
            return (back?.isConnected === true ? back : toggle.current) ?? false;
          }}
        >
          <SheetTitle className="sr-only">右側欄</SheetTitle>
          <SheetDescription className="sr-only">
            改動比對、交付預覽、計劃、觀測與成本
          </SheetDescription>
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
});

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
      data-focus="custom"
      className="hover:bg-border focus-visible:bg-ring absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize transition-colors duration-(--duration-quick)"
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
  const { layout, isMobile, toggle, returnFocus, update } = useControl();
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
          className="size-11 shrink-0 lg:size-9"
          aria-label="收起右側欄"
          title="收起右側欄"
          onClick={() => {
            update((current) => setOpen(current, false));
            // 停靠時面板一藏，焦點就掉到 body；交回從哪裡打開的那顆（「查看全文」，#654），不在了就交回標頭的開關鈕。
            // 覆蓋那一種由 Sheet 的 `onCloseAutoFocus` 還焦點（要等抽屜真的關掉）。
            if (isMobile) return;
            const back = returnFocus.current;
            returnFocus.current = null;
            (back?.isConnected === true ? back : toggle.current)?.focus();
          }}
        >
          <PanelRightClose />
        </Button>
      </div>
      {tabs.length === 0 ? (
        <EmptyState />
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
              <TabBody tab={tab} visible={layout.open && key === active} />
            </div>
          );
        })
      )}
    </>
  );
}

/**
 * 沒有分頁時：一句話加兩顆入口鈕（#1031，#1017 Q3 ①）。**鈕在分頁列外面**：`tablist` 裡只能有 `tab`（見檔頭）。
 */
function EmptyState() {
  const { api } = useControl();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-muted-foreground text-body" data-testid="right-sidebar-empty">
        {RIGHT_SIDEBAR_EMPTY_TEXT}
      </p>
      <div className="flex gap-2">
        {PANEL_KINDS.map((kind) => {
          const { title, Icon } = PANELS[kind];
          return (
            <Button
              key={kind}
              type="button"
              variant="outline"
              className="h-11 lg:h-9"
              data-testid={`right-sidebar-open-${kind}`}
              onClick={(event) => api.openPanel(kind, event.currentTarget)}
            >
              <Icon aria-hidden />
              {title}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 計劃分頁（#654）。那一份不在載入的對話裡時（重新整理後還原的分頁、計劃在更早的輪），另外往前讀歷史找它
 *（#1798，`Conversation.findPlan`），**不動對話窗口**：找到先在這裡顯示全文，旁邊一顆鈕先 `loadThrough` 載到那一頁
 * （同觀測分頁，#1601）、計劃出現在對話裡之後再捲到那張計劃卡。掃完沒有、讀取失敗都只講一句。**「待定位」記在這一層**：載完之後
 * 計劃庫裡有了它，鈕那一格卸掉。知道標題（條目裡有、或掃到了）就記進版面（`notePlanTitle`，#2014），分頁標籤在定位之前、
 * 重新整理之後都寫得出標題；掃完沒有就清掉，標籤退回「計劃」，跟這裡那一句一致。讀取失敗不清：讀不到不代表它不在了。
 */
function PlanTab({ id }: { id: string }) {
  const { api, sources, isMobile, notePlanTitle } = useControl();
  /** 對話條目裡的那一份：有它才定位得到。 */
  const entriesPlan = sources.plans?.get(id);
  const { findPlan, loadThrough } = sources;
  const [scan, setScan] = useState<PlanScanOutcome | 'scanning' | undefined>(undefined);
  /** 換代（`stale`）時加一，從新的游標重掃。 */
  const [attempt, setAttempt] = useState(0);
  // 沒帶工具呼叫 id 的審核（`review:`）不在日誌裡，掃完整份也找不到，不掃。
  const scannable =
    entriesPlan === undefined && findPlan !== undefined && !id.startsWith(REVIEW_PLAN_ID_PREFIX);
  // 分頁關掉（卸載）、換 thread（`findPlan` 換身分）、計劃自己出現在條目裡（例如往上捲到了）都中止這一次掃描。
  useEffect(() => {
    if (!scannable || findPlan === undefined) return;
    const abort = new AbortController();
    setScan('scanning');
    void findPlan(id, abort.signal).then((outcome) => {
      if (abort.signal.aborted || outcome.kind === 'aborted') return;
      if (outcome.kind === 'stale') {
        setAttempt((n) => n + 1);
        return;
      }
      setScan(outcome);
    });
    return () => abort.abort();
  }, [scannable, findPlan, id, attempt]);
  const found =
    entriesPlan === undefined && scan !== 'scanning' && scan?.kind === 'found' ? scan : undefined;
  const shown = entriesPlan ?? found?.plan;
  const knownTitle = shown?.title;
  const gone = entriesPlan === undefined && scan !== 'scanning' && scan?.kind === 'not-found';
  useEffect(() => {
    if (knownTitle !== undefined) notePlanTitle(id, knownTitle);
    else if (gone) notePlanTitle(id, undefined);
  }, [knownTitle, gone, id, notePlanTitle]);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'settled' | 'missing'>('idle');
  const preview = useRef<HTMLElement>(null);
  const stillMissing = useRef<HTMLParagraphElement>(null);
  const onLocate = useCallback(() => {
    if (loadThrough === undefined || found === undefined || phase === 'loading') return;
    setPhase('loading');
    void loadThrough(found.firstSeq).then(() => setPhase('settled'));
  }, [loadThrough, found, phase]);
  // 載完、畫出來之後才定位：`await` 回來時對話區與計劃庫都還沒重畫。**只看條目裡的那一份**：掃描找到的全文一直都在，拿它判斷的話
  // 載入失敗（原因在 `history.error`）或換代被丟掉（`historyEpoch`）時也會去定位一張不存在的卡。
  //
  // **結果靠焦點交代，不另開 live region**（#1290 只准狀態列掛 `role="status"`）：成功時那顆鈕卸掉、焦點掉到 body，停靠時交給全文
  // （spec §8「只在焦點本來會丟掉時才搬」，讀屏唸計劃標題）；窄螢幕由 `locate` 收抽屜、交給對話裡那一則。仍找不到時焦點交給說明那一句。
  useEffect(() => {
    if (phase === 'missing') {
      stillMissing.current?.focus();
      return;
    }
    if (phase !== 'settled') return;
    if (entriesPlan === undefined) {
      setPhase('missing');
      return;
    }
    setPhase('idle');
    api.locate(`tool-${id}`);
    const active = document.activeElement;
    if (!isMobile && (active === null || active === document.body)) {
      preview.current?.focus({ preventScroll: true });
    }
  }, [phase, entriesPlan, api, id, isMobile]);
  if (shown === undefined) {
    const failed = scan !== 'scanning' && scan?.kind === 'failed' ? scan : undefined;
    return (
      <p
        className="text-muted-foreground flex flex-1 items-center justify-center px-6 text-center text-body"
        data-testid="plan-tab-missing"
      >
        {scan === 'scanning' && scannable
          ? PLAN_TAB_SCANNING_TEXT
          : failed !== undefined
            ? `${PLAN_TAB_READ_FAILED_LEAD}${failed.message}`
            : PLAN_TAB_MISSING_TEXT}
      </p>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {found !== undefined && loadThrough !== undefined && (
        <div
          className="flex flex-col items-start gap-2 border-b border-border px-6 py-3"
          data-testid="plan-tab-scanned"
        >
          <p className="text-muted-foreground text-tip">{PLAN_TAB_SCANNED_TEXT}</p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 lg:min-h-9"
            // 載入中不用 `disabled`：焦點在這顆鈕上，disabled 會把焦點丟掉。
            aria-disabled={phase === 'loading' ? true : undefined}
            data-testid="plan-tab-locate"
            onClick={onLocate}
          >
            <LocateFixed aria-hidden />
            {phase === 'loading' ? TRACE_LOCATE_LOADING_TEXT : PLAN_TAB_LOCATE_LABEL}
          </Button>
          {phase === 'missing' && (
            <p
              ref={stillMissing}
              tabIndex={-1}
              className="text-muted-foreground text-tip"
              data-testid="plan-tab-still-missing"
            >
              {PLAN_TAB_STILL_MISSING_TEXT}
            </p>
          )}
        </div>
      )}
      <PlanPreviewTab ref={preview} plan={shown} />
    </div>
  );
}

function TabBody({ tab, visible }: { tab: SidebarTab; visible: boolean }) {
  const { api, sources, update, reveal, settleReveal } = useControl();
  if (isPanelTab(tab)) {
    const { Body } = PANELS[tab.kind];
    const mine = tab.kind === 'trace' ? reveal : undefined;
    return (
      <Body
        visible={visible}
        sources={sources}
        locate={api.locate}
        reveal={mine}
        onRevealed={settleReveal}
      />
    );
  }
  if (tab.kind === 'plan') return <PlanTab id={tab.id} />;
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
  const { layout, focusTab, update } = useControl();
  // 從卡片或面板按「查看全文」打開的（#654 二-Q5）：分頁畫出來之後焦點進去。看整份版面，不只看選中哪一個：那一份
  // 已經自動打開、選中了的話，再按一次選中的分頁不變，版面卻是新的一份（`openTab` 一律回新的）。
  useEffect(() => {
    if (focusTab.current === undefined || focusTab.current !== layout.active) return;
    focusTab.current = undefined;
    document.getElementById(domId(layout.active))?.focus();
  }, [layout, focusTab]);
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
  if (isPanelTab(tab)) return { label: PANELS[tab.kind].title, detail: undefined };
  if (tab.kind === 'deliverable') return { label: basename(tab.file.path), detail: tab.file.path };
  if (tab.kind === 'plan') {
    const title = sources.plans?.get(tab.id)?.title ?? tab.title ?? '計劃';
    return { label: title, detail: title };
  }
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
  const Icon = isPanelTab(tab)
    ? PANELS[tab.kind].Icon
    : tab.kind === 'changes'
      ? FileDiff
      : tab.kind === 'plan'
        ? ScrollText
        : FileText;
  return (
    <div
      role="none"
      className={cn(
        'group flex h-9 max-w-56 min-w-28 shrink items-center rounded-lg transition-colors duration-(--duration-quick)',
        selected
          ? 'glass-chosen text-foreground'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
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
        className="flex h-full min-w-0 items-center gap-2 rounded-lg pr-1 pl-3 text-body focus-visible:-outline-offset-2"
        onClick={onSelect}
        onKeyDown={onKeyDown}
      >
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </button>
      {/* 不可聚焦、讀屏看不到：鍵盤用 Delete 關（見檔頭）。 */}
      <span
        aria-hidden
        className="hover:bg-muted mr-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md"
        onClick={onClose}
        data-testid="right-sidebar-tab-close"
      >
        <X className="size-3.5" />
      </span>
    </div>
  );
}
