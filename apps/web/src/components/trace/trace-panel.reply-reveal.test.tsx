import type { ConversationState, TrajectoryReply } from '@nexus/wire';
import { emptyConversation, reduceAll } from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRightSidebar } from '@/components/sidebar/right-sidebar-context';
import { RightSidebarToggle } from '@/components/sidebar/right-sidebar';
import {
  REVEAL_HIGHLIGHT_MS,
  TRACE_REPLY_OLDER_TEXT,
  TRACE_REPLY_UNPLACED_TEXT,
  TRACE_REVEALED_TEXT,
} from '@/components/trace/trace-panel';
import { createConversationStore } from '@/lib/conversation-store';
import { LAYOUT_KEY_PREFIX } from '@/lib/right-sidebar';
import type { SidebarLayout } from '@/lib/right-sidebar';
import { Script } from '@/test/conversation-frames';
import { memoryStorage, WithRightSidebar } from '@/test/right-sidebar';
import { call, digest, turn, view, withTrajectory } from '@/test/trajectory-fixtures';

const scrolled: Element[] = [];

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  scrolled.length = 0;
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

const closed: SidebarLayout = { open: false, tabs: [], active: undefined };

const reply = (seq: number, messageId: string): TrajectoryReply => ({
  seq,
  time: 1_700_000_000_000 + seq,
  messageId,
  textChars: 5,
  reasoningChars: 0,
  toolCalls: 0,
});

/** 回覆底下的「這一輪的過程」按下去的事：用探針直接叫 `revealReply`，訊息 id 由測試指定。 */
function Probe({ messageId }: { messageId: string }) {
  const api = useRightSidebar();
  return (
    <button type="button" onClick={(event) => api?.revealReply(messageId, event.currentTarget)}>
      這一輪的過程
    </button>
  );
}

function mount(state: ConversationState, messageId: string) {
  localStorage.setItem(LAYOUT_KEY_PREFIX + 't', JSON.stringify(closed));
  return render(
    <WithRightSidebar sources={{ conversation: createConversationStore(state) }}>
      <RightSidebarToggle />
      <Probe messageId={messageId} />
    </WithRightSidebar>,
  );
}

const sidebar = () => document.getElementById('right-sidebar')!;
const group = (seq: number) =>
  document.querySelector<HTMLElement>(`section[data-testid="trace-turn"][data-seq="${seq}"]`);
const status = () =>
  document.querySelector('[data-testid="right-sidebar-panel-trace"] [role=status]');

/**
 * 兩個邏輯輪：第一輪（seq 100）停在核准點、續接（seq 200，併回第一輪）；第二輪（seq 300）。
 * 另有一則投影裡沒有的舊回覆（`run-old`，窗口之前）。
 */
function scenario(withProjection = true, digests = false) {
  const script = new Script();
  const state = reduceAll(emptyConversation(), [
    script.running(),
    ...script.human('inbox:r0', '很久以前'),
    ...script.ai('old', { text: '舊回覆' }),
    script.completed(),
    script.running(),
    ...script.human('inbox:r1', '第一輪'),
    ...script.ai('a', { text: '先做這個' }),
    ...script.ai('b', { text: '續接後的回覆' }),
    script.completed(),
    script.running(),
    ...script.human('inbox:r2', '第二輪'),
    ...script.ai('c', { text: '好' }),
    script.completed(),
  ]);
  if (!withProjection) return state;
  const trajectory = view([
    turn(1, { seq: 100, calls: [call(5, { reply: reply(11, 'run-a') })] }),
    turn(2, {
      seq: 200,
      kind: 'resume',
      logical: false,
      calls: [call(16, { reply: reply(18, 'run-b') })],
    }),
    turn(3, { seq: 300, calls: [call(30, { reply: reply(32, 'run-c') })] }),
  ]);
  return withTrajectory(
    state,
    script,
    digests ? { ...trajectory, digests: [digest(0)], omitted: 2 } : trajectory,
  );
}

const press = async () => {
  fireEvent.click(screen.getByRole('button', { name: '這一輪的過程' }));
  await act(async () => {});
};

describe('回覆底下的「這一輪的過程」→ 觀測分頁那一輪（#1034）', () => {
  it('側邊欄本來關著：打開觀測分頁、捲到那則回覆所在的那一組、焦點在標題、標示一下後消失', async () => {
    vi.useFakeTimers();
    mount(scenario(), 'run-c');
    await act(async () => {});
    expect(screen.queryByRole('tab', { name: '觀測' })).toBeNull();
    await press();
    expect(screen.getByRole('tab', { name: '觀測' }).getAttribute('aria-selected')).toBe('true');
    const target = group(300)!;
    expect(target).not.toBeNull();
    expect(scrolled).toContain(target);
    expect(document.activeElement).toBe(target.querySelector('[data-reveal-target]'));
    expect(target.hasAttribute('data-revealed')).toBe(true);
    expect(status()?.textContent).toBe(TRACE_REVEALED_TEXT);
    // 另一組沒被標示。
    expect(group(100)!.hasAttribute('data-revealed')).toBe(false);
    act(() => {
      vi.advanceTimersByTime(REVEAL_HIGHLIGHT_MS + 10);
    });
    expect(target.hasAttribute('data-revealed')).toBe(false);
  });

  it('核准續接之後的那則回覆：答案是併起來的那一組（續接不另開一組）', async () => {
    mount(scenario(), 'run-b');
    await act(async () => {});
    await press();
    // 投影認得的組只有兩個（另一組是窗口之前、以人那一句切開的舊對話）：續接沒有另開一組。
    expect(document.querySelectorAll('section[data-testid="trace-turn"][data-seq]')).toHaveLength(
      2,
    );
    const target = group(100)!;
    expect(scrolled).toContain(target);
    expect(target.hasAttribute('data-revealed')).toBe(true);
    expect(group(300)!.hasAttribute('data-revealed')).toBe(false);
  });

  it.each([
    ['歸不進軌跡的輪（窗口之前的舊回覆）', 'run-old'],
    ['不在這份對話裡的訊息 id', 'run-nowhere'],
  ])('%s：講明白、不捲也不標示', async (_label, messageId) => {
    mount(scenario(), messageId);
    await act(async () => {});
    await press();
    expect(screen.getByRole('tab', { name: '觀測' }).getAttribute('aria-selected')).toBe('true');
    expect(status()?.textContent).toBe(TRACE_REPLY_UNPLACED_TEXT);
    expect(screen.getByTestId('trace-reveal-notice').textContent).toBe(TRACE_REPLY_UNPLACED_TEXT);
    expect(scrolled.filter((node) => node.matches('[data-testid="trace-turn"]'))).toEqual([]);
    expect(document.querySelector('[data-revealed]')).toBeNull();
  });

  it('軌跡有更早輪的摘要時：歸不進的那則多半是太舊，講「只剩摘要」；焦點在分頁上不掉到 body', async () => {
    mount(scenario(true, true), 'run-old');
    await act(async () => {});
    await press();
    expect(status()?.textContent).toBe(TRACE_REPLY_OLDER_TEXT);
    // 看得見的人也要看到說明（讀屏那份在 sr-only 的 status 裡）。
    expect(screen.getByTestId('trace-reveal-notice').textContent).toBe(TRACE_REPLY_OLDER_TEXT);
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: '觀測' }));
    expect(document.querySelector('[data-revealed]')).toBeNull();
  });

  it('沒有軌跡投影的會話（第 0 版）：同樣講明白，不跳錯地方', async () => {
    mount(scenario(false), 'run-c');
    await act(async () => {});
    await press();
    expect(status()?.textContent).toBe(TRACE_REPLY_UNPLACED_TEXT);
    expect(document.querySelector('[data-revealed]')).toBeNull();
  });

  it('停靠時收起右側欄：焦點交回按下去的那顆「這一輪的過程」', async () => {
    mount(scenario(), 'run-c');
    await act(async () => {});
    const opener = screen.getByRole('button', { name: '這一輪的過程' });
    await press();
    fireEvent.click(within(sidebar()).getByRole('button', { name: '收起右側欄' }));
    await act(async () => {});
    expect(document.activeElement).toBe(opener);
  });

  it('說明在下一次成功定位時收掉', async () => {
    const state = scenario();
    localStorage.setItem(LAYOUT_KEY_PREFIX + 't', JSON.stringify(closed));
    render(
      <WithRightSidebar sources={{ conversation: createConversationStore(state) }}>
        <RightSidebarToggle />
        <Probe messageId="run-old" />
        <Probe messageId="run-c" />
      </WithRightSidebar>,
    );
    await act(async () => {});
    const [old, latest] = screen.getAllByRole('button', { name: '這一輪的過程' });
    fireEvent.click(old!);
    await act(async () => {});
    expect(screen.getByTestId('trace-reveal-notice')).toBeTruthy();
    fireEvent.click(latest!);
    await act(async () => {});
    expect(screen.queryByTestId('trace-reveal-notice')).toBeNull();
    expect(group(300)!.hasAttribute('data-revealed')).toBe(true);
  });

  it('連按兩次也算兩次：第二次再捲一次', async () => {
    mount(scenario(), 'run-c');
    await act(async () => {});
    await press();
    const first = scrolled.length;
    await press();
    expect(scrolled.length).toBeGreaterThan(first);
  });

  it('消費掉就清掉：切到別的分頁再回來，不會又被捲一次', async () => {
    mount(scenario(), 'run-c');
    await act(async () => {});
    await press();
    const turnScrolls = () =>
      scrolled.filter((node) => node.matches('[data-testid="trace-turn"]')).length;
    expect(turnScrolls()).toBe(1);
    // 關掉再打開側邊欄：請求早就消費掉了。
    fireEvent.click(within(sidebar()).getByRole('button', { name: '收起右側欄' }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '打開右側欄' }));
    await act(async () => {});
    expect(turnScrolls()).toBe(1);
  });
});

/** Radix 在卸載的下一個 tick 才還焦點（FocusScope 的 `setTimeout(0)`）。 */
const settle = () =>
  act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));

describe('窄螢幕抽屜：關掉後焦點交回按下去的那顆（#1034）', () => {
  beforeEach(() => {
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
  });

  it.each([
    ['Esc', async () => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })],
    [
      '收起鈕',
      async () =>
        fireEvent.click(
          within(screen.getByRole('dialog')).getByRole('button', { name: '收起右側欄' }),
        ),
    ],
  ])('用 %s 關掉：焦點回到「這一輪的過程」', async (_name, close) => {
    mount(scenario(), 'run-c');
    await act(async () => {});
    const opener = screen.getByRole('button', { name: '這一輪的過程' });
    opener.focus();
    fireEvent.click(opener);
    await act(async () => {});
    expect(screen.getByRole('dialog')).toBeTruthy();
    // 抽屜開著時焦點在那一輪的標題。
    expect(document.activeElement).toBe(group(300)!.querySelector('[data-reveal-target]'));
    await close();
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('不是從按鈕打開的（標頭的開關鈕）：關掉後焦點回到開關鈕，不掉到 body', async () => {
    mount(scenario(), 'run-c');
    await act(async () => {});
    const toggle = screen.getByRole('button', { name: '打開右側欄' });
    toggle.focus();
    fireEvent.click(toggle);
    await act(async () => {});
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await settle();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '打開右側欄' }));
  });
});
