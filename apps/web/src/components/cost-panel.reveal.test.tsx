import type { ConversationState } from '@nexus/wire';
import { emptyConversation, reduceAll } from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { COST_REVEAL_GONE_TEXT, COST_REVEAL_LABEL } from '@/components/cost-panel';
import { RightSidebarToggle, useRightSidebar } from '@/components/right-sidebar';
import {
  REVEAL_HIGHLIGHT_MS,
  TRACE_REVEAL_MISSING_TEXT,
  TURN_PAGE,
} from '@/components/trace-panel';
import { createConversationStore } from '@/lib/conversation-store';
import { LAYOUT_KEY_PREFIX } from '@/lib/right-sidebar';
import type { SidebarLayout } from '@/lib/right-sidebar';
import { Script } from '@/test/conversation-frames';
import { memoryStorage, WithRightSidebar } from '@/test/right-sidebar';
import { meterTurn, meterView, withMeter } from '@/test/token-meter-fixtures';
import { call, digest, turn, view, withTrajectory } from '@/test/trajectory-fixtures';

const scrolled: Element[] = [];

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  scrolled.length = 0;
  // jsdom 沒有 scrollIntoView；記下是哪個元素被捲到。
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const bothTabs = (active: 'trace' | 'cost'): SidebarLayout => ({
  open: true,
  tabs: [{ kind: 'trace' }, { kind: 'cost' }],
  active,
});

/** 在測試裡直接呼叫 `revealTurn`：模擬「按鈕按下之後才發現那一輪已經不在」那種競爭。 */
function RevealProbe({ seq }: { seq: number }) {
  const api = useRightSidebar();
  return (
    <button type="button" onClick={() => api?.revealTurn(seq)}>
      直接要求
    </button>
  );
}

function mount(state: ConversationState, layout = bothTabs('cost'), probeSeq?: number) {
  localStorage.setItem(LAYOUT_KEY_PREFIX + 't', JSON.stringify(layout));
  const store = createConversationStore(state);
  return render(
    <WithRightSidebar sources={{ conversation: store }}>
      <RightSidebarToggle />
      {probeSeq !== undefined && <RevealProbe seq={probeSeq} />}
    </WithRightSidebar>,
  );
}

const revealButtons = () => screen.getAllByRole('button', { name: COST_REVEAL_LABEL });
const group = (seq: number) =>
  document.querySelector<HTMLElement>(`section[data-testid="trace-turn"][data-seq="${seq}"]`);

/** 一場有三輪（其中第二輪是核准續接）的對話：兩個投影用同一組 seq。 */
function scenario() {
  const script = new Script();
  const state = reduceAll(emptyConversation(), [script.running(), script.completed()]);
  const trajectory = view([
    turn(1, { seq: 100, calls: [call(1)] }),
    turn(2, { seq: 200, kind: 'resume', logical: false, calls: [call(2)] }),
    turn(3, { seq: 300, calls: [call(3)] }),
  ]);
  const meter = meterView({
    turns: [
      meterTurn(0, { seq: 100, end: 'completed' }),
      meterTurn(1, { seq: 300, kind: 'message' }),
    ],
  });
  return withMeter(withTrajectory(state, script, trajectory), script, meter);
}

describe('成本分頁 →「在觀測分頁看這一輪」', () => {
  it('跨面板對得上：成本的 seq、觀測分頁那一組的 seq、兩邊的編號是同一套（含核准續接併回前一輪）', async () => {
    mount(scenario());
    await act(async () => {});
    const turns = screen.getAllByTestId('cost-turn');
    expect(
      turns.map((row) => [row.getAttribute('data-seq'), row.querySelector('h4')!.textContent]),
    ).toEqual([
      ['100', '第 1 輪'],
      ['300', '第 2 輪'],
    ]);
    fireEvent.click(revealButtons()[1]!);
    await act(async () => {});
    const target = group(300)!;
    expect(target).not.toBeNull();
    // 續接（seq 200）併回第 1 輪，所以只有兩組，第二組是「第 2 輪」，和成本那邊一致。
    expect(screen.getAllByTestId('trace-turn')).toHaveLength(2);
    expect(target.querySelector('[data-reveal-target]')!.textContent).toContain('第 2 輪');
    expect(group(100)!.querySelector('[data-reveal-target]')!.textContent).toContain('第 1 輪');
  });

  it('一輪在軌跡的 turns 裡：選中觀測分頁、捲到那一組、焦點在它的標題、標示一下後自己消失', async () => {
    vi.useFakeTimers();
    mount(scenario());
    await act(async () => {});
    expect(screen.getByRole('tab', { name: '成本' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(revealButtons()[0]!);
    await act(async () => {});
    expect(screen.getByRole('tab', { name: '觀測' }).getAttribute('aria-selected')).toBe('true');
    const target = group(100)!;
    expect(scrolled).toContain(target);
    expect(document.activeElement).toBe(target.querySelector('[data-reveal-target]'));
    expect(target.hasAttribute('data-revealed')).toBe(true);
    act(() => {
      vi.advanceTimersByTime(REVEAL_HIGHLIGHT_MS + 10);
    });
    expect(target.hasAttribute('data-revealed')).toBe(false);
  });

  it('消費掉就清掉：切去成本再切回觀測，不會又被捲一次', async () => {
    mount(scenario());
    await act(async () => {});
    fireEvent.click(revealButtons()[0]!);
    await act(async () => {});
    const turnScrolls = () =>
      scrolled.filter((node) => node.matches('[data-testid="trace-turn"]')).length;
    expect(turnScrolls()).toBe(1);
    fireEvent.click(screen.getByRole('tab', { name: '成本' }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('tab', { name: '觀測' }));
    await act(async () => {});
    expect(turnScrolls()).toBe(1);
  });

  it('同一輪連按兩次也算兩次：第二次再捲一次', async () => {
    mount(scenario());
    await act(async () => {});
    fireEvent.click(revealButtons()[0]!);
    await act(async () => {});
    const first = scrolled.length;
    fireEvent.click(screen.getByRole('tab', { name: '成本' }));
    await act(async () => {});
    fireEvent.click(revealButtons()[0]!);
    await act(async () => {});
    expect(scrolled.length).toBeGreaterThan(first);
  });

  it('一輪只剩摘要（在 digests 裡）：展開摘要區塊、展到那一頁、捲到那一列並放焦點', async () => {
    const script = new Script();
    const base = reduceAll(emptyConversation(), [script.running(), script.completed()]);
    // 一百多輪摘要，成本那一輪在最舊的那一頁以外（要按「顯示更早的」才看得到）。
    const digests = Array.from({ length: 45 }, (_, i) => digest(i + 1, { seq: (i + 1) * 100 }));
    const trajectory = view([turn(50, { seq: 5000, calls: [call(1)] })], { digests });
    const meter = meterView({ turns: [meterTurn(0, { seq: 200 }), meterTurn(49, { seq: 5000 })] });
    mount(withMeter(withTrajectory(base, script, trajectory), script, meter));
    await act(async () => {});
    const buttons = revealButtons();
    expect(buttons[0]!.hasAttribute('disabled')).toBe(false);
    expect(screen.queryByTestId('trace-digest')).toBeNull();
    fireEvent.click(buttons[0]!);
    await act(async () => {});
    const block = screen.getByTestId('trace-digests');
    const row = block.querySelector<HTMLElement>('[data-seq="200"]')!;
    expect(row).not.toBeNull();
    expect(scrolled).toContain(row);
    expect(document.activeElement).toBe(row);
    expect(row.hasAttribute('data-revealed')).toBe(true);
    // 展開到那一頁：不是只展開區塊而已。
    expect(within(block).getAllByTestId('trace-digest').length).toBeGreaterThan(20);
  });

  it('觀測分頁已經沒有那一輪：成本列的鈕停用並講原因，不跳去錯的地方', async () => {
    const script = new Script();
    const base = reduceAll(emptyConversation(), [script.running(), script.completed()]);
    const trajectory = view([turn(3, { seq: 300, calls: [call(3)] })]);
    const meter = meterView({ turns: [meterTurn(0, { seq: 100 }), meterTurn(1, { seq: 300 })] });
    mount(withMeter(withTrajectory(base, script, trajectory), script, meter));
    await act(async () => {});
    const [gone, here] = revealButtons();
    expect(gone!.hasAttribute('disabled')).toBe(true);
    expect(here!.hasAttribute('disabled')).toBe(false);
    const turns = screen.getAllByTestId('cost-turn');
    expect(turns[0]!.textContent).toContain(COST_REVEAL_GONE_TEXT);
    expect(turns[1]!.textContent).not.toContain(COST_REVEAL_GONE_TEXT);
    expect(gone!.getAttribute('aria-describedby')).toBe(turns[0]!.querySelector('p[id]')!.id);
    fireEvent.click(gone!);
    expect(screen.getByRole('tab', { name: '成本' }).getAttribute('aria-selected')).toBe('true');
  });

  it('按下去的當下才發現那一輪不在（競爭）：觀測分頁自己講，不捲、不標示', async () => {
    mount(scenario(), bothTabs('cost'), 9_999);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '直接要求' }));
    await act(async () => {});
    expect(screen.getByRole('tab', { name: '觀測' }).getAttribute('aria-selected')).toBe('true');
    // 讀屏的 status 與畫面上的說明各一份。
    expect(screen.getAllByText(TRACE_REVEAL_MISSING_TEXT)).toHaveLength(2);
    expect(screen.getByTestId('trace-reveal-notice').textContent).toBe(TRACE_REVEAL_MISSING_TEXT);
    expect(document.querySelector('[data-revealed]')).toBeNull();
    // 分頁列自己可能把選中的分頁捲進視野；要緊的是沒有任何一輪被捲到。
    expect(
      scrolled.filter((node) =>
        node.closest('[data-testid="trace-turn"], [data-testid="trace-digest"]'),
      ),
    ).toEqual([]);
  });

  it('那一組在「顯示更早的輪」那一頁之前：先展開到它再捲', async () => {
    const script = new Script();
    const base = reduceAll(emptyConversation(), [script.running(), script.completed()]);
    const count = TURN_PAGE + 5;
    const trajectory = view(
      Array.from({ length: count }, (_, i) =>
        turn(i + 1, { seq: (i + 1) * 100, calls: [call(i + 1)] }),
      ),
    );
    const meter = meterView({
      turns: [meterTurn(0, { seq: 100 }), meterTurn(count - 1, { seq: count * 100 })],
    });
    mount(withMeter(withTrajectory(base, script, trajectory), script, meter));
    await act(async () => {});
    fireEvent.click(revealButtons()[0]!);
    await act(async () => {});
    expect(group(100)).not.toBeNull();
    expect(scrolled).toContain(group(100));
  });

  it('1024 以下（同在一個抽屜裡）：不收抽屜，分頁換成觀測，焦點在那一輪的標題', async () => {
    vi.stubGlobal(
      'matchMedia',
      (query: string) =>
        ({
          matches: true,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
    mount(scenario());
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '打開右側欄' }));
    await act(async () => {});
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(revealButtons()[0]!);
    await act(async () => {});
    expect(screen.getByRole('dialog')).toBeTruthy();
    const target = group(100)!;
    expect(document.activeElement).toBe(target.querySelector('[data-reveal-target]'));
  });
});
