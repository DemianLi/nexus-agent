import type { ConversationState } from '@nexus/wire';
import { emptyConversation, reduceAll } from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useMemo, useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePlanLibrary } from '@/components/plan/review';
import {
  PLAN_TAB_LOCATE_LABEL,
  PLAN_TAB_MISSING_TEXT,
  PLAN_TAB_READ_FAILED_LEAD,
  PLAN_TAB_SCANNING_TEXT,
  PLAN_TAB_STILL_MISSING_TEXT,
  RightSidebarToggle,
} from '@/components/sidebar/right-sidebar';
import { useRightSidebar } from '@/components/sidebar/right-sidebar-context';
import { createConversationStore } from '@/lib/conversation-store';
import type { WritableConversationStore } from '@/lib/conversation-store';
import { planDocument } from '@/lib/plan-review';
import type { PlanScanOutcome } from '@/lib/plan-review';
import { LAYOUT_KEY_PREFIX } from '@/lib/right-sidebar';
import type { SidebarLayout } from '@/lib/right-sidebar';
import { Script } from '@/test/conversation-frames';
import { memoryStorage, WithRightSidebar } from '@/test/right-sidebar';

/**
 * 計劃分頁指到的那一份不在載入的對話裡（#1798）：另外往前讀歷史找它（`findPlan`），找到先顯示
 * 全文，按鈕 `loadThrough(那一頁的 firstSeq)` 再定位到對話裡那張計劃卡。這裡驗畫面，`findPlan` 用替身；掃描本身（一頁接一頁、
 * 固定切點、換代、中止、不動條目）驗在 `hooks/use-conversation-history-window.test.tsx`。
 */

const PLAN = '# 改登入頁\n\n先把文案改成中文。';
const CALL_ID = 'call_plan';
/** 掃描找到它的那一頁的 `firstSeq`。 */
const FOUND_AT = 120;
const FOUND: PlanScanOutcome = { kind: 'found', plan: planDocument(PLAN), firstSeq: FOUND_AT };

function layout(id = CALL_ID): SidebarLayout {
  return { open: true, tabs: [{ kind: 'plan', id }], active: `plan:${id}` };
}

/** 載入前：條目裡沒有這份計劃。載入後：那張計劃卡在對話裡。 */
function states() {
  const script = new Script();
  const before = reduceAll(emptyConversation(), [script.running(), script.completed()]);
  const after = reduceAll(emptyConversation(), [
    script.running(),
    script.started(CALL_ID, 'exit_plan_mode', { plan: PLAN }),
    script.finished(CALL_ID, '同意'),
    script.completed(),
  ]);
  return { before, after };
}

type FindPlan = (callId: string, signal: AbortSignal) => Promise<PlanScanOutcome>;

/** 計劃卡「查看全文」的替身：再打開同一個分頁。 */
function OpenAgain() {
  const sidebar = useRightSidebar();
  return (
    <button type="button" onClick={() => sidebar?.openPlan(CALL_ID)}>
      再打開
    </button>
  );
}

/** 跟 `App` 一樣：計劃庫由對話狀態推出來（`usePlanLibrary`），不是手動換一個 Map。 */
function Live({
  store,
  findPlan,
  loadThrough,
}: {
  store: WritableConversationStore;
  findPlan?: FindPlan;
  loadThrough?: (seq: number) => Promise<void>;
}) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const plans = usePlanLibrary(state.entries, state.pendings);
  const sources = useMemo(
    () => ({
      conversation: store,
      plans,
      ...(findPlan === undefined ? {} : { findPlan }),
      ...(loadThrough === undefined ? {} : { loadThrough }),
    }),
    [store, plans, findPlan, loadThrough],
  );
  return (
    <WithRightSidebar sources={sources}>
      <RightSidebarToggle />
      <OpenAgain />
    </WithRightSidebar>
  );
}

function mount(
  initial: ConversationState,
  options: {
    findPlan?: FindPlan;
    loadThrough?: (seq: number) => Promise<void>;
    id?: string;
    layout?: SidebarLayout;
  } = {},
) {
  localStorage.setItem(
    LAYOUT_KEY_PREFIX + 't',
    JSON.stringify(options.layout ?? layout(options.id)),
  );
  const store = createConversationStore(initial);
  const view = render(
    <Live
      store={store}
      {...(options.findPlan === undefined ? {} : { findPlan: options.findPlan })}
      {...(options.loadThrough === undefined ? {} : { loadThrough: options.loadThrough })}
    />,
  );
  return { store, view };
}

/** 對話區那張計劃卡的替身（`Transcript` 畫的就是這兩個屬性）。 */
function transcriptItem(id: string) {
  const item = document.createElement('div');
  item.setAttribute('data-slot', 'message-scroller-item');
  item.setAttribute('data-message-id', id);
  document.body.append(item);
  return item;
}

const locateButton = () => screen.queryByRole('button', { name: PLAN_TAB_LOCATE_LABEL });

function pending() {
  let resolve!: (outcome: PlanScanOutcome) => void;
  const promise = new Promise<PlanScanOutcome>((done) => (resolve = done));
  return { promise, resolve };
}

/** 一直不回的掃描，記下每一次的 signal。 */
function hangingScan(signals: AbortSignal[]): FindPlan {
  return (_id, signal) => {
    signals.push(signal);
    return new Promise<never>(() => undefined);
  };
}

const scrollIntoView = vi.fn();
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('計劃分頁：計劃不在載入的對話裡（#1798）', () => {
  it('分頁標籤：掃描找到之前寫「計劃」，找到之後寫計劃標題，不必等定位', async () => {
    const scan = pending();
    mount(states().before, { findPlan: () => scan.promise, loadThrough: vi.fn(async () => {}) });
    await act(async () => {});
    const tabNames = () => screen.queryAllByRole('tab').map((tab) => tab.textContent);
    expect(tabNames()).toEqual(['計劃']);
    await act(async () => scan.resolve(FOUND));
    expect(tabNames()).toEqual(['改登入頁']);
    // 計劃還不在對話裡：標題來自掃描，不是計劃庫。
    expect(screen.getByTestId('plan-tab-scanned')).toBeTruthy();
  });

  it('掃描找到：先顯示全文；按下去載到那一頁，計劃出現在對話裡之後捲到那張計劃卡，焦點交給全文', async () => {
    const { before, after } = states();
    let item: HTMLElement | undefined;
    // `loadThrough` 要在 mount 之前建好，store 卻是 mount 建的：先放一個盒子。
    const box: { store?: WritableConversationStore } = {};
    const findPlan = vi.fn<FindPlan>(async () => FOUND);
    const loadThrough = vi.fn(async (_seq: number) => {
      box.store!.set(after);
      item = transcriptItem(`tool-${CALL_ID}`);
    });
    box.store = mount(before, { findPlan, loadThrough }).store;
    await act(async () => {});
    expect(findPlan).toHaveBeenCalledExactlyOnceWith(CALL_ID, expect.any(AbortSignal));
    // 照 dsh：找到就先顯示全文，不必等定位。
    expect(screen.getByTestId('plan-preview').textContent).toContain('先把文案改成中文');
    expect(loadThrough).not.toHaveBeenCalled();
    const button = locateButton()!;
    button.focus();
    fireEvent.click(button);
    await act(async () => {});
    expect(loadThrough).toHaveBeenCalledExactlyOnceWith(FOUND_AT);
    expect(item?.hasAttribute('data-located')).toBe(true);
    expect(scrollIntoView.mock.contexts).toContain(item);
    // 那顆鈕跟著卸掉了：焦點交給全文，不掉到 body。
    expect(locateButton()).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('plan-preview'));
  });

  it('掃描進行中講一句；掃完沒有：維持原本那一句、沒有鈕、不載入', async () => {
    const { before } = states();
    const scan = pending();
    const loadThrough = vi.fn(async () => {});
    mount(before, { findPlan: () => scan.promise, loadThrough });
    await act(async () => {});
    expect(screen.getByTestId('plan-tab-missing').textContent).toBe(PLAN_TAB_SCANNING_TEXT);
    await act(async () => scan.resolve({ kind: 'not-found' }));
    expect(screen.getByTestId('plan-tab-missing').textContent).toBe(PLAN_TAB_MISSING_TEXT);
    expect(locateButton()).toBeNull();
    expect(loadThrough).not.toHaveBeenCalled();
  });

  it('讀取失敗：講原因，不定位', async () => {
    const { before } = states();
    const loadThrough = vi.fn(async () => {});
    mount(before, {
      findPlan: async () => ({ kind: 'failed', message: '這個組裝沒有落盤' }),
      loadThrough,
    });
    await act(async () => {});
    expect(screen.getByTestId('plan-tab-missing').textContent).toBe(
      `${PLAN_TAB_READ_FAILED_LEAD}這個組裝沒有落盤`,
    );
    expect(locateButton()).toBeNull();
    expect(loadThrough).not.toHaveBeenCalled();
  });

  it('載完了計劃還是沒出現在對話裡（中途失敗、或重連換代被丟掉）：不定位，講一聲，全文與鈕留著', async () => {
    const { before } = states();
    const item = transcriptItem(`tool-${CALL_ID}`);
    const loadThrough = vi.fn(async () => {});
    mount(before, { findPlan: async () => FOUND, loadThrough });
    await act(async () => {});
    fireEvent.click(locateButton()!);
    await act(async () => {});
    expect(loadThrough).toHaveBeenCalledTimes(1);
    expect(item.hasAttribute('data-located')).toBe(false);
    expect(scrollIntoView).not.toHaveBeenCalledWith({ block: 'center', behavior: 'auto' });
    expect(screen.getByTestId('plan-tab-still-missing').textContent).toBe(
      PLAN_TAB_STILL_MISSING_TEXT,
    );
    // 焦點交給說明那一句（讀屏唸得到），不另開 live region（#1290）。
    expect(document.activeElement).toBe(screen.getByTestId('plan-tab-still-missing'));
    expect(screen.getByTestId('plan-preview').textContent).toContain('先把文案改成中文');
    expect(locateButton()).not.toBeNull();
  });

  it('分頁關掉：中止這一次掃描', async () => {
    const { before } = states();
    const signals: AbortSignal[] = [];
    const { view } = mount(before, { findPlan: hangingScan(signals) });
    await act(async () => {});
    expect(signals.map((signal) => signal.aborted)).toEqual([false]);
    view.unmount();
    expect(signals.map((signal) => signal.aborted)).toEqual([true]);
  });

  it('計劃自己出現在條目裡（例如往上捲到了）：中止掃描，直接顯示', async () => {
    const { before, after } = states();
    const signals: AbortSignal[] = [];
    const { store } = mount(before, { findPlan: hangingScan(signals) });
    await act(async () => {});
    act(() => store.set(after));
    expect(signals.map((signal) => signal.aborted)).toEqual([true]);
    expect(screen.getByTestId('plan-preview').textContent).toContain('先把文案改成中文');
    expect(locateButton()).toBeNull();
  });

  it('掃到一半換代（`stale`）：從新的游標重掃', async () => {
    const { before } = states();
    const answers: PlanScanOutcome[] = [{ kind: 'stale' }, FOUND];
    const findPlan = vi.fn<FindPlan>(async () => answers.shift()!);
    mount(before, { findPlan, loadThrough: async () => {} });
    await act(async () => {});
    expect(findPlan).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('plan-preview').textContent).toContain('先把文案改成中文');
  });

  it('沒帶工具呼叫 id 的審核（`review:`）不在日誌裡：不掃', async () => {
    const { before } = states();
    const findPlan = vi.fn<FindPlan>(async () => ({ kind: 'not-found' }));
    mount(before, { findPlan, id: 'review:int-1' });
    await act(async () => {});
    expect(findPlan).not.toHaveBeenCalled();
    expect(screen.getByTestId('plan-tab-missing').textContent).toBe(PLAN_TAB_MISSING_TEXT);
  });

  it('沒給 `findPlan`（第一頁歷史還沒到）：維持原樣，只講那一句', async () => {
    const { before } = states();
    mount(before);
    await act(async () => {});
    expect(screen.getByTestId('plan-tab-missing').textContent).toBe(PLAN_TAB_MISSING_TEXT);
    expect(locateButton()).toBeNull();
  });
});

describe('計劃分頁：記下的標題（#2014）', () => {
  const tabNames = () => screen.queryAllByRole('tab').map((tab) => tab.textContent);
  const saved = () =>
    JSON.parse(localStorage.getItem(LAYOUT_KEY_PREFIX + 't') ?? 'null') as SidebarLayout;
  const titled = (title: string): SidebarLayout => ({
    open: true,
    tabs: [{ kind: 'plan', id: CALL_ID, title }],
    active: `plan:${CALL_ID}`,
  });

  it('還原的計劃分頁帶著標題：沒選過的標籤也寫計劃標題，不往前掃', async () => {
    const findPlan = vi.fn<FindPlan>(async () => FOUND);
    mount(states().before, {
      findPlan,
      layout: {
        open: true,
        tabs: [
          { kind: 'plan', id: 'call_a', title: '改登入頁' },
          { kind: 'plan', id: 'call_b', title: '補測試' },
          { kind: 'changes', seq: 3, index: 0 },
        ],
        active: 'changes:3',
      },
    });
    await act(async () => {});
    expect(tabNames().slice(0, 2)).toEqual(['改登入頁', '補測試']);
    expect(findPlan).not.toHaveBeenCalled();
  });

  it('沒記標題的舊版面：掛上時照樣掃，掃到補進版面；這一下不落盤，人動過右側欄才寫', async () => {
    const before = JSON.stringify(layout());
    mount(states().before, { findPlan: async () => FOUND, loadThrough: async () => {} });
    await act(async () => {});
    expect(tabNames()).toEqual(['改登入頁']);
    expect(localStorage.getItem(LAYOUT_KEY_PREFIX + 't')).toBe(before);
    fireEvent.click(screen.getByRole('tab', { name: '改登入頁' }));
    await act(async () => {});
    expect(saved().tabs).toEqual([{ kind: 'plan', id: CALL_ID, title: '改登入頁' }]);
  });

  it('掃完沒有：清掉記下的標題，標籤退回「計劃」，跟分頁裡那一句一致', async () => {
    mount(states().before, {
      findPlan: async () => ({ kind: 'not-found' }),
      layout: titled('改登入頁'),
    });
    await act(async () => {});
    expect(tabNames()).toEqual(['計劃']);
    expect(screen.getByTestId('plan-tab-missing').textContent).toBe(PLAN_TAB_MISSING_TEXT);
  });

  it('再打開同一個分頁（計劃不在載入的對話裡）：記下的標題留著', async () => {
    mount(states().before, {
      findPlan: async () => ({ kind: 'failed', message: '斷線' }),
      layout: titled('改登入頁'),
    });
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '再打開' }));
    await act(async () => {});
    expect(tabNames()).toEqual(['改登入頁']);
    expect(saved().tabs).toEqual([{ kind: 'plan', id: CALL_ID, title: '改登入頁' }]);
  });

  it('讀取失敗：留著記下的標題，讀不到不代表它不在了', async () => {
    mount(states().before, {
      findPlan: async () => ({ kind: 'failed', message: '斷線' }),
      layout: titled('改登入頁'),
    });
    await act(async () => {});
    expect(tabNames()).toEqual(['改登入頁']);
    expect(screen.getByTestId('plan-tab-missing').textContent).toBe(
      `${PLAN_TAB_READ_FAILED_LEAD}斷線`,
    );
  });
});
