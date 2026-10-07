import type { ConversationState } from '@nexus/wire';
import {
  appendDecision,
  COMPACTION,
  emptyConversation,
  reduceAll,
  reduceConversation,
} from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PANELS } from '@/components/sidebar/right-sidebar-panels';
import type { PanelBodyProps } from '@/lib/right-sidebar-api';
import { TRACE_LOCATED_TEXT } from '@/components/trace/panel';
import { TRACE_LOCATE_LABEL } from '@/components/trace/row';
import { createConversationStore } from '@/lib/conversation-store';
import { LAYOUT_KEY_PREFIX } from '@/lib/right-sidebar';
import type { SidebarLayout } from '@/lib/right-sidebar';
import { LOCATED_MS } from '@/lib/transcript-locate';
import { TRACE_HEADLINE, TRACE_LIMITS, TRACE_TARGET_MISSING_TEXT } from '@/lib/trace-view';
import { axeViolations } from '@/test/axe';
import { Script } from '@/test/conversation-frames';
import { memoryStorage, WithRightSidebar } from '@/test/right-sidebar';
import { RightSidebarToggle } from '@/components/sidebar/right-sidebar';

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const traceOpen = (): SidebarLayout => ({ open: true, tabs: [{ kind: 'trace' }], active: 'trace' });
const bothTabs = (active: 'trace' | 'cost'): SidebarLayout => ({
  open: true,
  tabs: [{ kind: 'trace' }, { kind: 'cost' }],
  active,
});

function mount(state: ConversationState, layout: SidebarLayout = traceOpen()) {
  localStorage.setItem(LAYOUT_KEY_PREFIX + 't', JSON.stringify(layout));
  const store = createConversationStore(state);
  const view = render(
    <WithRightSidebar sources={{ conversation: store }}>
      <RightSidebarToggle />
    </WithRightSidebar>,
  );
  return { store, ...view };
}

/**
 * 一整輪真實形狀的對話（折真的 frame）：人說話、思考、讀檔、回覆、核准、改檔、失敗、壓縮、收尾。
 * `decided` 為 false 時沒有那則本地的決定——那是重新整理之後的樣子。
 */
function conversation(decided = true): ConversationState {
  const script = new Script();
  const asked = reduceAll(emptyConversation(), [
    script.running(),
    ...script.human('history-0', '幫我整理 README\n順便檢查連結'),
    ...script.ai('a', { reasoning: '先看檔案結構\n再決定怎麼改' }),
    script.started('c1', 'read_file', { file_path: 'README.md' }),
    script.finished('c1', '# 專案'),
    ...script.ai('b', { text: '讀完了。\n接下來改寫。' }),
    script.started('c2', 'edit_file', { file_path: 'README.md' }),
    script.approval('int-1', 'edit_file'),
  ]);
  return reduceAll(decided ? appendDecision(asked, 'int-1', 'approve') : asked, [
    script.finished('c2', '已改'),
    script.started('c3', 'glob', { pattern: '**/*.md' }),
    script.failed('c3', '沒有權限', 'EACCES'),
    script.custom(COMPACTION, { seq: 9, cutoff: 4, saved: true }),
    ...script.ai('c', { text: '都處理好了。' }),
    script.completed(),
  ]);
}

const rows = () => screen.getAllByTestId('trace-row');
const kinds = () => rows().map((row) => row.getAttribute('data-kind'));

describe('觀測分頁：內容', () => {
  it('每種條目各有一列、順序照對話；限制與「只有順序、沒有時間」寫在畫面上', async () => {
    mount(conversation());
    await act(async () => {});
    expect(kinds()).toEqual([
      'input',
      'thinking',
      'tool',
      'reply',
      'tool',
      'decision',
      'tool',
      'compaction',
      'reply',
    ]);
    expect(screen.getByTestId('trace-headline').textContent).toBe(TRACE_HEADLINE);
    const limits = within(screen.getByTestId('trace-limits')).getAllByRole('listitem');
    expect(limits.map((item) => item.textContent)).toEqual(Object.values(TRACE_LIMITS));
    expect(screen.getByRole('heading', { name: '這一版的限制' })).toBeTruthy();
  });

  it('工具列：名稱、一行摘要、狀態、失敗碼；收著時不掛 ToolCard，展開才掛', async () => {
    mount(conversation());
    await act(async () => {});
    const tools = rows().filter((row) => row.getAttribute('data-kind') === 'tool');
    const failed = tools[2]!;
    expect(failed.textContent).toContain('搜尋');
    expect(failed.textContent).toContain('**/*.md');
    expect(failed.textContent).toContain('失敗');
    expect(within(failed).getByTestId('trace-error-code').textContent).toBe('EACCES');
    expect(tools[0]!.textContent).toContain('完成');
    expect(screen.queryAllByTestId('tool-entry')).toHaveLength(0);

    fireEvent.click(within(tools[0]!).getByRole('button', { name: /^讀取/ }));
    await act(async () => {});
    const cards = screen.getAllByTestId('tool-entry');
    expect(cards).toHaveLength(1);
    // 一點就看得到內容：卡一掛上就是展開的，不必再點第二下。
    expect(within(cards[0]!).getByRole('button', { expanded: true })).toBeTruthy();
  });

  it('輸入與回覆收著只有第一行，展開才有全文', async () => {
    mount(conversation());
    await act(async () => {});
    const input = rows()[0]!;
    expect(input.textContent).toContain('幫我整理 README');
    expect(input.textContent).not.toContain('順便檢查連結');
    fireEvent.click(within(input).getByRole('button', { name: /輸入/ }));
    await act(async () => {});
    expect(input.textContent).toContain('順便檢查連結');

    const reply = rows()[3]!;
    expect(reply.textContent).toContain('讀完了。');
    expect(reply.textContent).not.toContain('接下來改寫');
  });

  it('決定只存本地（限制 2）：重新整理之後決定那一列不見，畫面上的那句話還在', async () => {
    const { unmount } = mount(conversation(true));
    await act(async () => {});
    const decision = rows().find((row) => row.getAttribute('data-kind') === 'decision');
    expect(decision?.textContent).toContain('已核准：edit_file');
    unmount();
    cleanup();

    mount(conversation(false));
    await act(async () => {});
    expect(kinds()).not.toContain('decision');
    // 工具卡照樣在，只是看不到人按了什麼；那句限制講得清楚。
    expect(kinds().filter((kind) => kind === 'tool')).toHaveLength(3);
    const text = screen.getByTestId('trace-limits').textContent ?? '';
    expect(text).toContain('重新整理之後看不到你當時按了什麼');
  });

  it('只看得到已載入的那幾頁（限制 3）有字', async () => {
    mount(conversation());
    await act(async () => {});
    expect(screen.getByTestId('trace-limits').textContent).toContain(TRACE_LIMITS.loaded);
  });

  it('沒有對話可看就是空狀態，限制不假裝有內容', async () => {
    mount(emptyConversation());
    await act(async () => {});
    expect(screen.getByTestId('right-sidebar-panel-trace').textContent).toBe('尚無資料');
    expect(screen.queryByTestId('trace-limits')).toBeNull();
  });
});

describe('觀測分頁：藏起來就不重算', () => {
  /** 數面板內容被畫了幾次：把真的內容包進 `Profiler`，只有它底下有東西提交才算。 */
  function countCommits() {
    const counter = { commits: 0 };
    const Real = PANELS.trace.Body;
    (PANELS.trace as unknown as { Body: unknown }).Body = (props: PanelBodyProps) => (
      <Profiler id="trace" onRender={() => (counter.commits += 1)}>
        <Real {...props} />
      </Profiler>
    );
    return { counter, restore: () => ((PANELS.trace as unknown as { Body: unknown }).Body = Real) };
  }

  function stream(script: Script, state: ConversationState, text: string) {
    return reduceConversation(state, script.delta('live', text));
  }

  it('逐字片段：看得見時照畫（對照），切到別的分頁、收起右側欄之後都不再畫，再打開是最新的', async () => {
    const { counter, restore } = countCommits();
    try {
      const script = new Script();
      let state = reduceAll(emptyConversation(), [
        script.running(),
        ...script.human('history-0', '寫一篇'),
        script.openAi('live'),
      ]);
      const { store } = mount(state, bothTabs('trace'));
      await act(async () => {});
      const push = async (text: string) => {
        state = stream(script, state, text);
        await act(async () => store.set(state));
      };

      // 對照：看得見時逐字片段會讓它重畫，量具沒壞。
      const start = counter.commits;
      await push('一');
      expect(counter.commits).toBeGreaterThan(start);

      // 切到成本分頁：觀測分頁藏起來（不卸載）。
      fireEvent.click(screen.getByRole('tab', { name: '成本' }));
      await act(async () => {});
      const hidden = counter.commits;
      for (const piece of ['二', '三', '四', '五', '六']) await push(piece);
      expect(counter.commits).toBe(hidden);

      // 回到觀測：直接是最新的一份，不是凍住的那一份。
      fireEvent.click(screen.getByRole('tab', { name: '觀測' }));
      await act(async () => {});
      expect(screen.getByTestId('right-sidebar-panel-trace').textContent).toContain('一二三四五六');

      // 收起整個右側欄（停靠時整欄藏起來、不卸載）：同樣不重畫。
      fireEvent.click(screen.getAllByRole('button', { name: '收起右側欄' })[0]!);
      await act(async () => {});
      const collapsed = counter.commits;
      for (const piece of ['七', '八', '九']) await push(piece);
      expect(counter.commits).toBe(collapsed);
    } finally {
      restore();
    }
  });
});

describe('觀測分頁：在對話裡定位', () => {
  /** 對話區那一格的替身：只有 `data-slot` 與 `data-message-id`，`Transcript` 畫的就是這兩個。 */
  function transcriptItem(id: string) {
    const item = document.createElement('div');
    item.setAttribute('data-slot', 'message-scroller-item');
    item.setAttribute('data-message-id', id);
    document.body.append(item);
    return item;
  }
  const scrollIntoView = vi.fn();
  // 分頁列選中時也會 `scrollIntoView`（`nearest`），只數捲到對話區那一次（`center`）。
  const revealed = () =>
    scrollIntoView.mock.calls.flatMap((call, at) =>
      (call[0] as { block?: string } | undefined)?.block === 'center'
        ? [scrollIntoView.mock.contexts[at]]
        : [],
    );
  beforeEach(() => {
    scrollIntoView.mockClear();
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  const locateButton = (index: number) =>
    within(rows()[index]!).getByRole('button', { name: new RegExp(TRACE_LOCATE_LABEL) });

  it('停靠時：捲到那一則並標示，焦點留在按鈕上（焦點沒丟，不搬）；標示過一陣子會收掉', async () => {
    const item = transcriptItem('tool-c1');
    mount(conversation());
    await act(async () => {});
    vi.useFakeTimers();
    const button = locateButton(2);
    button.focus();
    fireEvent.click(button);
    expect(revealed()).toEqual([item]);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' });
    expect(item.hasAttribute('data-located')).toBe(true);
    expect(document.activeElement).toBe(button);
    act(() => void vi.advanceTimersByTime(LOCATED_MS));
    expect(item.hasAttribute('data-located')).toBe(false);
    expect(screen.getByText(TRACE_LOCATED_TEXT)).toBeTruthy();
  });

  it('找不到那一則（沒載入）：什麼都不捲，在那一列底下講原因，說法沿用計劃分頁', async () => {
    mount(conversation());
    await act(async () => {});
    fireEvent.click(locateButton(2));
    expect(revealed()).toEqual([]);
    const note = within(rows()[2]!).getByTestId('trace-missing');
    expect(note.textContent).toBe(TRACE_TARGET_MISSING_TEXT);
    expect(note.textContent).toContain('往上捲載入更早的對話');

    // 之後找得到了，那句話收掉。
    transcriptItem('tool-c1');
    fireEvent.click(locateButton(2));
    expect(screen.queryByTestId('trace-missing')).toBeNull();
  });

  it('1024 以下：先收掉抽屜，再把焦點交給對話裡那一則', async () => {
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
    const item = transcriptItem('tool-c1');
    mount(conversation());
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '打開右側欄' }));
    await act(async () => {});
    expect(screen.getByTestId('right-sidebar')).toBeTruthy();

    fireEvent.click(locateButton(2));
    await waitFor(() => expect(screen.queryByTestId('right-sidebar')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(item));
    expect(item.getAttribute('tabindex')).toBe('-1');
    expect(revealed()).toEqual([item]);
  });

  it('配不到提問卡的答案沒有地方可定位：那一列不畫定位鈕', async () => {
    const script = new Script();
    const asked = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('history-0', '約個時間'),
      script.started('q1', 'ask_user_question', {
        questions: [{ id: 'day', question: '哪一天？', options: [{ label: '週一' }] }],
      }),
      script.question('int-q'),
    ]);
    const { appendQuestionCancel } = await import('@nexus/wire');
    mount(appendQuestionCancel(asked, 'int-q'));
    await act(async () => {});
    const answer = rows().find((row) => row.getAttribute('data-kind') === 'answer')!;
    expect(within(answer).queryByRole('button')).toBeNull();
  });
});

describe('觀測分頁：無障礙', () => {
  it('axe：1280 亮（含展開的工具卡）與 375 暗（窄螢幕覆蓋）', async () => {
    const { unmount } = mount(conversation());
    await act(async () => {});
    fireEvent.click(within(rows()[2]!).getByRole('button', { name: /^讀取/ }));
    await act(async () => {});
    expect(await axeViolations(document.body)).toEqual([]);
    unmount();
    cleanup();

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
    document.documentElement.classList.add('dark');
    mount(conversation());
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '打開右側欄' }));
    await act(async () => {});
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
