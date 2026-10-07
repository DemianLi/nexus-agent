import type { ConversationState } from '@nexus/wire';
import {
  COMPACTION,
  CONTEXT_MEASURE,
  emptyConversation,
  MODEL_USAGE,
  reduceAll,
  reduceConversation,
  SESSION_STATS,
  TOKEN_USAGE,
} from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { COST_NO_USAGE, COST_RELOAD_LABEL } from '@/components/cost/panel';
import { RightSidebarToggle } from '@/components/sidebar/right-sidebar';
import { PANELS } from '@/components/sidebar/right-sidebar-panels';
import type { PanelBodyProps } from '@/lib/right-sidebar-api';
import { COST_HEADLINE, COST_LIMITS } from '@/lib/cost-view';
import { createConversationStore } from '@/lib/conversation-store';
import { LAYOUT_KEY_PREFIX } from '@/lib/right-sidebar';
import type { SidebarLayout } from '@/lib/right-sidebar';
import type { SubagentUsageLoader, SubagentUsageOutcome } from '@/lib/subagent-usage';
import { axeViolations } from '@/test/axe';
import { Script } from '@/test/conversation-frames';
import { memoryStorage, WithRightSidebar } from '@/test/right-sidebar';

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const costOpen = (): SidebarLayout => ({ open: true, tabs: [{ kind: 'cost' }], active: 'cost' });
const bothTabs = (active: 'trace' | 'cost'): SidebarLayout => ({
  open: true,
  tabs: [{ kind: 'trace' }, { kind: 'cost' }],
  active,
});

function mount(
  state: ConversationState,
  loader?: SubagentUsageLoader,
  layout: SidebarLayout = costOpen(),
) {
  localStorage.setItem(LAYOUT_KEY_PREFIX + 't', JSON.stringify(layout));
  const store = createConversationStore(state);
  const view = render(
    <WithRightSidebar
      sources={{ conversation: store, ...(loader === undefined ? {} : { subagentUsage: loader }) }}
    >
      <RightSidebarToggle />
    </WithRightSidebar>,
  );
  return { store, ...view };
}

/** root 的總帳（輸入 5000／輸出 500）加兩個背景子代理的委派卡。 */
function conversation(withSubagents = true, script = new Script()): ConversationState {
  return reduceAll(emptyConversation(), [
    script.running(),
    ...script.human('history-0', '幫我查兩件事'),
    ...(withSubagents
      ? [
          script.started('d1', 'subagent', { description: '查 A' }),
          script.finishedWith('d1', '已派出', {
            kind: 'background-subagent',
            runId: 'bg-1',
            subagentType: 'researcher',
          }),
          script.started('d2', 'subagent', { description: '查 B' }),
          script.finishedWith('d2', '已派出', {
            kind: 'background-subagent',
            runId: 'bg-2',
            subagentType: 'writer',
          }),
        ]
      : []),
    ...script.ai('a', { text: '派出去了。' }),
    script.custom(TOKEN_USAGE, { inputTokens: 5_000, outputTokens: 500 }),
    script.custom(SESSION_STATS, { turns: 2, steps: 4, llmMs: 8_000, toolMs: 1_500 }),
    script.custom(MODEL_USAGE, { inputTokens: 4_800 }),
    script.custom(CONTEXT_MEASURE, {
      approxTokens: 4_900,
      messageCount: 6,
      thresholds: [{ type: 'tokens', value: 10_000 }],
    }),
    script.custom(COMPACTION, { seq: 3, cutoff: 1, saved: true }),
    script.completed(),
  ]);
}

const ok = (input: number, output: number): SubagentUsageOutcome => ({
  ok: true,
  usage: {
    tokenUsage: { inputTokens: input, outputTokens: output },
    sessionStats: { turns: 1, steps: 2, llmMs: 2_000, toolMs: 500 },
  },
});

/** 每個子代理一組分得開的數字：bg-1 是 100／10，bg-2 是 7／3（跟 root 的 5000／500 都不同）。 */
function loaderOf(
  outcomes: Record<string, SubagentUsageOutcome> = { 'bg-1': ok(100, 10), 'bg-2': ok(7, 3) },
) {
  return vi.fn<SubagentUsageLoader>(async (runId) => {
    const outcome = outcomes[runId];
    if (outcome === undefined) throw new Error(`沒有 ${runId}`);
    return outcome;
  });
}

const text = (id: string) => screen.getByTestId(id).textContent ?? '';

describe('成本分頁：主對話', () => {
  it('累計、context、壓縮都照總帳與 frame；口徑與標語寫在畫面上', async () => {
    mount(conversation(false), loaderOf());
    await act(async () => {});
    const totals = text('cost-totals');
    expect(totals).toContain('5,000 token');
    expect(totals).toContain('500 token');
    expect(totals).toContain('5,500 token');
    expect(totals).toContain('輪數2');
    expect(totals).toContain('模型呼叫4 次');
    expect(totals).toContain('8 秒');
    expect(totals).toContain('1.5 秒');
    const context = text('cost-context');
    expect(context).toContain('約 49%');
    expect(context).toContain('4,800 token');
    expect(text('cost-compactions')).toContain('1 次');
    expect(text('cost-headline')).toBe(COST_HEADLINE);
    const limits = within(screen.getByTestId('cost-limits')).getAllByRole('listitem');
    expect(limits.map((item) => item.textContent)).toEqual(Object.values(COST_LIMITS));
  });

  it('只有 frame、一則對話都沒載入（entries 為空）時數字仍照 frame', async () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [
      script.custom(TOKEN_USAGE, { inputTokens: 1_234_567, outputTokens: 89 }),
    ]);
    expect(state.entries).toHaveLength(0);
    mount(state);
    await act(async () => {});
    expect(text('cost-totals')).toContain('1,234,567 token');
    expect(text('cost-totals')).toContain('1,234,656 token');
  });

  it('一次用量都沒有：講「還沒有用量」，不畫 0', async () => {
    mount(reduceAll(emptyConversation(), []));
    await act(async () => {});
    expect(text('cost-totals')).toContain(COST_NO_USAGE);
    expect(text('cost-totals')).not.toContain('0 token');
    expect(screen.queryByTestId('cost-context')).toBeNull();
  });

  it('沒有對話可看就是空狀態', async () => {
    localStorage.setItem(LAYOUT_KEY_PREFIX + 't', JSON.stringify(costOpen()));
    render(
      <WithRightSidebar sources={{}}>
        <RightSidebarToggle />
      </WithRightSidebar>,
    );
    await act(async () => {});
    expect(text('right-sidebar-panel-cost')).toBe('尚無資料');
    expect(screen.queryByTestId('cost-limits')).toBeNull();
  });
});

describe('成本分頁：背景子代理分列', () => {
  it('每個 runId 一列、數字是各自讀回來的，root 的數字不含它們', async () => {
    const load = loaderOf();
    mount(conversation(), load);
    await act(async () => {});
    const rows = screen.getAllByTestId('cost-subagent');
    expect(rows.map((row) => row.getAttribute('data-run-id'))).toEqual(['bg-1', 'bg-2']);
    expect(rows[0]!.textContent).toContain('researcher');
    expect(rows[0]!.textContent).toContain('100 token');
    expect(rows[0]!.textContent).toContain('110 token');
    expect(rows[1]!.textContent).toContain('writer');
    expect(rows[1]!.textContent).toContain('7 token');
    expect(rows[1]!.textContent).toContain('10 token');
    expect(load.mock.calls.map(([id]) => id)).toEqual(['bg-1', 'bg-2']);
    // 累計那一段是 root 自己的總帳，沒有加上子代理。
    expect(text('cost-totals')).toContain('5,500 token');
    expect(text('cost-totals')).not.toContain('5,610');
  });

  it('讀不回來的那一列講原因、不畫 0；別列不受影響', async () => {
    mount(
      conversation(),
      loaderOf({
        'bg-1': ok(100, 10),
        'bg-2': { ok: false, message: '沒有編號 bg-2 的背景子代理' },
      }),
    );
    await act(async () => {});
    const [first, second] = screen.getAllByTestId('cost-subagent');
    expect(first!.textContent).toContain('110 token');
    expect(within(second!).getByTestId('cost-subagent-error').textContent).toContain(
      '沒有編號 bg-2 的背景子代理',
    );
    expect(second!.textContent).not.toContain('token');
  });

  it('子代理一次都沒記到帳：講「還沒有用量」', async () => {
    mount(
      conversation(),
      loaderOf({
        'bg-1': { ok: true, usage: { tokenUsage: null, sessionStats: null } },
        'bg-2': ok(7, 3),
      }),
    );
    await act(async () => {});
    expect(screen.getAllByTestId('cost-subagent')[0]!.textContent).toContain(COST_NO_USAGE);
  });

  it('還在讀時畫「讀取中」；重讀鈕讀完才能按，按了每個子代理再讀一次', async () => {
    const pending = new Map<string, (outcome: SubagentUsageOutcome) => void>();
    const load = vi.fn<SubagentUsageLoader>(
      (runId) => new Promise((resolve) => pending.set(runId, resolve)),
    );
    mount(conversation(), load);
    await act(async () => {});
    expect(screen.getAllByTestId('cost-subagent')[0]!.textContent).toContain('讀取中');
    const reload = screen.getByRole('button', { name: COST_RELOAD_LABEL }) as HTMLButtonElement;
    expect(reload.disabled).toBe(true);

    await act(async () => {
      pending.get('bg-1')!(ok(100, 10));
      pending.get('bg-2')!(ok(7, 3));
    });
    expect(reload.disabled).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);

    fireEvent.click(reload);
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(4);
    // 重讀時舊數字不先清成空白。
    expect(screen.getAllByTestId('cost-subagent')[0]!.textContent).toContain('110 token');
    await act(async () => {
      pending.get('bg-1')!(ok(200, 20));
      pending.get('bg-2')!(ok(7, 3));
    });
    expect(screen.getAllByTestId('cost-subagent')[0]!.textContent).toContain('220 token');
  });

  it('沒有派出過背景子代理：講一句，不發請求', async () => {
    const load = loaderOf();
    mount(conversation(false), load);
    await act(async () => {});
    expect(text('cost-subagents')).toContain('還沒有派出背景子代理');
    expect(load).not.toHaveBeenCalled();
  });
});

describe('成本分頁：藏起來就不讀、不重算', () => {
  /** 數面板內容被畫了幾次：把真的內容包進 `Profiler`，只有它底下有東西提交才算。 */
  function countCommits() {
    const counter = { commits: 0 };
    const Real = PANELS.cost.Body;
    (PANELS.cost as unknown as { Body: unknown }).Body = (props: PanelBodyProps) => (
      <Profiler id="cost" onRender={() => (counter.commits += 1)}>
        <Real {...props} />
      </Profiler>
    );
    return { counter, restore: () => ((PANELS.cost as unknown as { Body: unknown }).Body = Real) };
  }

  it('看得見時：逐字片段照畫但不重讀子代理；切走之後不畫也不讀；切回來讀一次最新的', async () => {
    const { counter, restore } = countCommits();
    try {
      const load = loaderOf();
      // 同一個 `Script`：frame 的 `seq` 要接著折疊器收過的往上，不然逐字片段被當成重複擋掉。
      const script = new Script();
      let state = reduceConversation(conversation(true, script), script.openAi('live'));
      const { store } = mount(state, load, bothTabs('cost'));
      await act(async () => {});
      expect(load).toHaveBeenCalledTimes(2);
      const push = async (piece: string) => {
        state = reduceConversation(state, script.delta('live', piece));
        await act(async () => store.set(state));
      };

      // 對照：看得見時逐字片段會讓內容重取快照，量具沒壞；但名單沒變，不重讀。
      const start = counter.commits;
      await push('一');
      expect(counter.commits).toBeGreaterThan(start);
      await push('二');
      expect(load).toHaveBeenCalledTimes(2);

      // 切到觀測分頁：成本分頁藏起來（不卸載）。
      fireEvent.click(screen.getByRole('tab', { name: '觀測' }));
      await act(async () => {});
      const hidden = counter.commits;
      for (const piece of ['三', '四', '五']) await push(piece);
      expect(counter.commits).toBe(hidden);
      expect(load).toHaveBeenCalledTimes(2);

      // 回到成本：看得見了，各讀一次最新的。
      fireEvent.click(screen.getByRole('tab', { name: '成本' }));
      await act(async () => {});
      expect(load).toHaveBeenCalledTimes(4);
    } finally {
      restore();
    }
  });

  it('從沒看見過：不讀（成本分頁掛著但選中的是觀測）', async () => {
    const load = loaderOf();
    mount(conversation(), load, bothTabs('trace'));
    await act(async () => {});
    expect(load).not.toHaveBeenCalled();
  });
});

describe('成本分頁：無障礙', () => {
  it('axe：1280 亮（含子代理分列與一列失敗）與 375 暗（窄螢幕覆蓋）', async () => {
    const outcomes = {
      'bg-1': ok(100, 10),
      'bg-2': { ok: false, message: '連線出了問題' },
    } as const;
    const { unmount } = mount(conversation(), loaderOf({ ...outcomes }));
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
    mount(conversation(), loaderOf({ ...outcomes }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '打開右側欄' }));
    await act(async () => {});
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
