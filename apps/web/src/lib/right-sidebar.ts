/**
 * 右側欄的狀態（[#640](https://github.com/DemianLi/nexus-agent/issues/640)）：一條會話一套分頁，開著哪些、選中哪一個、
 * 面板開或收；寬度全站一個值。這裡只有純函式與 `localStorage` 的讀寫，畫面在 `components/right-sidebar.tsx`。
 *
 * **形狀是一格停靠＋分頁**（#640 決定 1）：dsh `ui-sidebar-right` 的分格、浮窗、拖放、復原都不做。以後多一種
 * 內容（計劃審核、檔案樹）只是 {@link SidebarTab} 多一支。
 *
 * **去重的鍵就是內容的座標**（決定 8、9）：改動一輪一個分頁（`seq`），同一輪換檔只改 `index`；交付一個檔一個分頁
 * （`seq`、`index`），不同輪交付的同名檔是兩個分頁。
 *
 * ## 記在哪裡
 *
 * 每條會話一個鍵 `nexus.right-sidebar.v1.<threadId>`，另一個鍵記最近用過的順序，只留 {@link MAX_REMEMBERED_THREADS}
 * 條（決定的預設）；寬度一個鍵。**失敗的約定跟 `remembered-thread.ts` 一樣**：讀不到、寫不進、存的東西形狀不對，
 * 都只是記不住，畫面照常。
 *
 * @module
 */

import type { LocatedFile } from '@/lib/deliverables-view';

/** 一個分頁的內容座標。 */
export type SidebarTab =
  | {
      readonly kind: 'changes';
      /** 那一輪改動摘要的日誌位置。 */
      readonly seq: number;
      /** 正在看的檔在摘要 `files` 裡的位置。 */
      readonly index: number;
    }
  | { readonly kind: 'deliverable'; readonly file: LocatedFile };

export interface SidebarLayout {
  readonly open: boolean;
  readonly tabs: readonly SidebarTab[];
  /** 選中那個分頁的 {@link tabKey}；沒有分頁時是 `undefined`。 */
  readonly active: string | undefined;
}

export const EMPTY_LAYOUT: SidebarLayout = { open: false, tabs: [], active: undefined };

/** 分頁的身分：同一個鍵只開一個。 */
export function tabKey(tab: SidebarTab): string {
  return tab.kind === 'changes'
    ? `changes:${tab.seq}`
    : `deliverable:${tab.file.seq}:${tab.file.index}`;
}

/**
 * 打開一個分頁：已經開著就換上新的座標（改動換檔）並選中它，沒有就接在最後；面板一律展開（決定 10）。
 */
export function openTab(layout: SidebarLayout, tab: SidebarTab): SidebarLayout {
  const key = tabKey(tab);
  const at = layout.tabs.findIndex((existing) => tabKey(existing) === key);
  const tabs =
    at === -1
      ? [...layout.tabs, tab]
      : layout.tabs.map((existing, i) => (i === at ? tab : existing));
  return { open: true, tabs, active: key };
}

/**
 * 關掉一個分頁。關掉的是選中的那個時，選它右邊那個，沒有就左邊那個。**面板不跟著收**：最後一個關掉之後面板
 * 顯示空狀態（驗收），收不收由人決定。
 */
export function closeTab(layout: SidebarLayout, key: string): SidebarLayout {
  const at = layout.tabs.findIndex((tab) => tabKey(tab) === key);
  if (at === -1) return layout;
  const tabs = layout.tabs.filter((_, i) => i !== at);
  if (layout.active !== key) return { ...layout, tabs };
  const next = tabs[at] ?? tabs[at - 1];
  return { ...layout, tabs, active: next === undefined ? undefined : tabKey(next) };
}

export function selectTab(layout: SidebarLayout, key: string): SidebarLayout {
  return layout.tabs.some((tab) => tabKey(tab) === key) ? { ...layout, active: key } : layout;
}

export function setOpen(layout: SidebarLayout, open: boolean): SidebarLayout {
  return layout.open === open ? layout : { ...layout, open };
}

/** 改動分頁換檔（選檔器）。 */
export function setChangesIndex(layout: SidebarLayout, seq: number, index: number): SidebarLayout {
  return {
    ...layout,
    tabs: layout.tabs.map((tab) =>
      tab.kind === 'changes' && tab.seq === seq ? { ...tab, index } : tab,
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// 寬度

/** 面板最窄（決定 7）。 */
export const MIN_PANEL_WIDTH = 320;
/** 拖寬時會話區至少留多少（決定 7）。 */
export const MIN_CONVERSATION_WIDTH = 480;
/** 沒記過時的寬度：改動比對開左右對照時夠用，又留得下會話區。 */
export const DEFAULT_PANEL_WIDTH = 560;

/**
 * 拖寬時的夾限。`room` 是會話區與面板加起來的寬度；放不下兩個下限時，面板的下限優先。
 */
export function clampPanelWidth(width: number, room: number): number {
  const max = Math.max(MIN_PANEL_WIDTH, room - MIN_CONVERSATION_WIDTH);
  return Math.round(Math.min(max, Math.max(MIN_PANEL_WIDTH, width)));
}

// ---------------------------------------------------------------------------------------------
// localStorage

export const LAYOUT_KEY_PREFIX = 'nexus.right-sidebar.v1.';
export const RECENT_KEY = 'nexus.right-sidebar.v1.recent';
export const WIDTH_KEY = 'nexus.right-sidebar.v1.width';
/** 記幾條會話的版面（決定的預設）。 */
export const MAX_REMEMBERED_THREADS = 50;

/** 同 `remembered-thread.ts`：光讀這個全域就可能拋。 */
function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

const isIndex = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

function parseTab(value: unknown): SidebarTab | undefined {
  const tab = value as Record<string, unknown> | null;
  if (typeof tab !== 'object' || tab === null) return undefined;
  if (tab.kind === 'changes') {
    return isIndex(tab.seq) && isIndex(tab.index)
      ? { kind: 'changes', seq: tab.seq, index: tab.index }
      : undefined;
  }
  if (tab.kind !== 'deliverable') return undefined;
  const file = tab.file as Record<string, unknown> | null;
  if (typeof file !== 'object' || file === null) return undefined;
  const { path, description, seq, index } = file;
  if (typeof path !== 'string' || !isIndex(seq) || !isIndex(index)) return undefined;
  if (description !== undefined && typeof description !== 'string') return undefined;
  return {
    kind: 'deliverable',
    file: { path, seq, index, ...(description === undefined ? {} : { description }) },
  };
}

/**
 * 存下來的版面。形狀不對的一律當成沒有——不留半套：一個分頁壞了，整份版面都不信。
 */
export function parseLayout(value: unknown): SidebarLayout | undefined {
  const raw = value as Record<string, unknown> | null;
  if (typeof raw !== 'object' || raw === null) return undefined;
  if (typeof raw.open !== 'boolean' || !Array.isArray(raw.tabs)) return undefined;
  const tabs: SidebarTab[] = [];
  const keys = new Set<string>();
  for (const entry of raw.tabs) {
    const tab = parseTab(entry);
    if (tab === undefined || keys.has(tabKey(tab))) return undefined;
    keys.add(tabKey(tab));
    tabs.push(tab);
  }
  const active = raw.active;
  if (active !== undefined && (typeof active !== 'string' || !keys.has(active))) return undefined;
  if (active === undefined && tabs.length > 0) return undefined;
  return { open: raw.open, tabs, active };
}

function readJson(key: string): unknown {
  try {
    const raw = storage()?.getItem(key);
    return raw === null || raw === undefined ? undefined : (JSON.parse(raw) as unknown);
  } catch (error) {
    console.error(`讀不回 ${key}：`, error);
    return undefined;
  }
}

/** 這條會話上次的版面；沒有或讀不到是 {@link EMPTY_LAYOUT}。 */
export function readLayout(threadId: string): SidebarLayout {
  return parseLayout(readJson(LAYOUT_KEY_PREFIX + threadId)) ?? EMPTY_LAYOUT;
}

function readRecent(): string[] {
  const recent = readJson(RECENT_KEY);
  return Array.isArray(recent) ? recent.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * 記下這條會話的版面，並把它排到最近用過的最前面；超過 {@link MAX_REMEMBERED_THREADS} 條就清掉最舊的。
 *
 * **只在人動過之後呼叫**：打開一條會話看一眼不算用過右側欄，不該佔掉一格。
 */
export function writeLayout(threadId: string, layout: SidebarLayout): void {
  const store = storage();
  if (store === undefined) return;
  try {
    store.setItem(LAYOUT_KEY_PREFIX + threadId, JSON.stringify(layout));
    const recent = [threadId, ...readRecent().filter((id) => id !== threadId)];
    for (const evicted of recent.slice(MAX_REMEMBERED_THREADS)) {
      store.removeItem(LAYOUT_KEY_PREFIX + evicted);
    }
    store.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, MAX_REMEMBERED_THREADS)));
  } catch (error) {
    console.error(`寫不進右側欄的版面，下次載入不會記得：`, error);
  }
}

export function readWidth(): number {
  const width = readJson(WIDTH_KEY);
  return typeof width === 'number' && Number.isFinite(width) && width >= MIN_PANEL_WIDTH
    ? Math.round(width)
    : DEFAULT_PANEL_WIDTH;
}

export function writeWidth(width: number): void {
  try {
    storage()?.setItem(WIDTH_KEY, JSON.stringify(width));
  } catch (error) {
    console.error(`寫不進右側欄的寬度：`, error);
  }
}
