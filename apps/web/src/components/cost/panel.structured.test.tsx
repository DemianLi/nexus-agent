import type { ConversationState, TokenMeterSpan } from '@nexus/wire';
import {
  TOKEN_METER_PROJECTION,
  TOKEN_METER_VERSION,
  emptyConversation,
  reduceAll,
} from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { COST_NO_USAGE, COST_SUBAGENT_PENDING } from '@/components/cost/panel';
import { RightSidebarToggle } from '@/components/sidebar/right-sidebar';
import { createConversationStore } from '@/lib/conversation-store';
import { COST_HEADLINE, COST_LIMITS } from '@/lib/cost-view';
import { LAYOUT_KEY_PREFIX } from '@/lib/right-sidebar';
import type { SidebarLayout } from '@/lib/right-sidebar';
import type { SubagentUsageLoader } from '@/lib/subagent-usage';
import {
  COST_STRUCTURED_HEADLINE,
  COST_STRUCTURED_LIMITS,
  caliberOf,
} from '@/lib/token-meter-view';
import { axeViolations } from '@/test/axe';
import { Script } from '@/test/conversation-frames';
import { memoryStorage, WithRightSidebar } from '@/test/right-sidebar';
import {
  meterLink,
  meterTurn,
  meterView,
  span,
  withMeter,
  withSubagentMeter,
} from '@/test/token-meter-fixtures';
import { projectionFrame } from '@/test/trajectory-fixtures';

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

function mount(state: ConversationState, loader?: SubagentUsageLoader) {
  localStorage.setItem(LAYOUT_KEY_PREFIX + 't', JSON.stringify(costOpen()));
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

function base(script = new Script()): ConversationState {
  return reduceAll(emptyConversation(), [script.running(), script.completed()]);
}

const text = (id: string) => screen.getByTestId(id).textContent ?? '';
const numberIn = (node: Element | null | undefined): number =>
  Number((node?.querySelector('dd')?.textContent ?? '').replace(/[^\d-]/gu, ''));

/** 每一輪不一樣的數字：加總對得上才有意義。 */
function sample() {
  const script = new Script();
  const earlier = {
    ...span({ steps: 7, inputTokens: 7_000, outputTokens: 700, modelMs: 7_000 }),
    turns: 4,
  };
  const outside = span({ steps: 2, inputTokens: 222, outputTokens: 22, modelMs: 2_000 });
  const turns = [
    meterTurn(4, { seq: 400, steps: 3, inputTokens: 3_333, outputTokens: 333 }),
    meterTurn(5, { seq: 500, steps: 1, inputTokens: 11, outputTokens: 1, kind: 'goal' }),
  ];
  return { script, view: meterView({ turns, outside, earlier, totalTurns: 6 }) };
}

describe('成本分頁：有用量投影的四桶與命中率（#724）', () => {
  /** 兩輪，各自帶四桶；`inputTokens` 由呼叫端決定是完整 prompt 還是只算未快取。 */
  function bucketed(inputOf: (turn: 'a' | 'b') => number, over: Partial<TokenMeterSpan> = {}) {
    const script = new Script();
    const a = meterTurn(0, {
      seq: 100,
      steps: 1,
      inputTokens: inputOf('a'),
      uncachedInputTokens: 200,
      cacheReadTokens: 700,
      cacheWriteTokens: 100,
      outputTokens: 50,
      ...over,
    });
    const b = meterTurn(1, {
      seq: 200,
      steps: 1,
      inputTokens: inputOf('b'),
      uncachedInputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 10,
    });
    // 輪外沒有任何呼叫：四桶都是 0（一個呼叫都沒有，「每次都報了」成立），不是缺席。
    const outside = span({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    return { script, view: meterView({ turns: [a, b], outside, totalTurns: 2 }) };
  }
  const turnAt = (seq: number) =>
    document.querySelector(`[data-testid=cost-turn][data-seq="${seq}"]`)!;
  const field = (root: Element, name: string) => root.querySelector(`[data-field="${name}"]`);

  it('會話總計與每一輪都畫四桶與命中率：總計 800 ÷ 1,100（兩輪加起來算，不是 70% 與 0% 的平均）', async () => {
    const { script, view } = bucketed((turn) => (turn === 'a' ? 1_000 : 100));
    mount(withMeter(base(script), script, view));
    await act(async () => {});
    const totals = screen.getByTestId('cost-totals');
    expect(numberIn(field(totals, 'uncachedInputTokens'))).toBe(300);
    expect(numberIn(field(totals, 'cacheReadTokens'))).toBe(700);
    expect(numberIn(field(totals, 'cacheWriteTokens'))).toBe(100);
    expect(numberIn(field(totals, 'tokensTotalBuckets'))).toBe(1_160);
    expect(field(totals, 'cacheHitRate')?.querySelector('dd')?.textContent).toBe('63.6%');
    const first = turnAt(100);
    const second = turnAt(200);
    expect(field(first, 'cacheHitRate')?.querySelector('dd')?.textContent).toBe('70.0%');
    // 第二輪記了、一次都沒命中：0.0%，不是沒記。
    expect(field(second, 'cacheHitRate')?.querySelector('dd')?.textContent).toBe('0.0%');
  });

  it('span 的 inputTokens 從完整 prompt 改成只算未快取：整個分頁的字一個都不變', async () => {
    const full = bucketed((turn) => (turn === 'a' ? 1_000 : 100));
    mount(withMeter(base(full.script), full.script, full.view));
    await act(async () => {});
    const before = text('right-sidebar-panel-cost');
    cleanup();
    const uncachedOnly = bucketed((turn) => (turn === 'a' ? 200 : 100), {});
    // session 也是只算未快取的版本：夾具照 sumSpans 把 inputTokens 加起來。
    mount(withMeter(base(uncachedOnly.script), uncachedOnly.script, uncachedOnly.view));
    await act(async () => {});
    expect(text('right-sidebar-panel-cost')).toBe(before);
  });

  it('快取桶缺席的那一輪：寫沒記，不畫 0%；別輪照常；合計那一輪標下限', async () => {
    const { script, view } = bucketed((turn) => (turn === 'a' ? 1_000 : 100), {
      cacheWriteTokens: undefined,
    });
    mount(withMeter(base(script), script, view));
    await act(async () => {});
    const first = turnAt(100);
    expect(field(first, 'cacheWriteTokens')?.querySelector('dd')?.textContent).toBe('沒記');
    expect(field(first, 'cacheHitRate')?.querySelector('dd')?.textContent).toBe('沒記');
    expect(field(first, 'tokensTotalBuckets')?.querySelector('dd')?.textContent).toContain(
      '（下限）',
    );
    // 會話總計：有一輪缺，整段缺席（夾具照投影的規則），也是沒記。
    const totals = screen.getByTestId('cost-totals');
    expect(field(totals, 'cacheHitRate')?.querySelector('dd')?.textContent).toBe('沒記');
  });

  it('舊 server 的投影（沒有三格）：照舊畫輸入含快取，沒有命中率', async () => {
    const { script, view } = sample();
    mount(withMeter(base(script), script, view));
    await act(async () => {});
    expect(document.querySelector('[data-field="cacheHitRate"]')).toBeNull();
    expect(document.querySelector('[data-field="cacheReadTokens"]')).toBeNull();
  });

  it('含子代理的 token：各自四桶相加', async () => {
    const { script, view } = bucketed((turn) => (turn === 'a' ? 1_000 : 100));
    const root = { ...view, links: [meterLink('a')] };
    const subView = meterView({
      outside: span({
        steps: 1,
        inputTokens: 500,
        uncachedInputTokens: 50,
        cacheReadTokens: 400,
        cacheWriteTokens: 50,
        outputTokens: 5,
      }),
    });
    let state = withMeter(base(script), script, root);
    state = withSubagentMeter(state, script, 'a', subView);
    mount(state);
    await act(async () => {});
    // 主對話 1,160 ＋ 子代理 505。
    expect(
      numberIn(screen.getByTestId('cost-totals').querySelector('[data-field="subagentTokens"]')),
    ).toBe(1_665);
  });
});

describe('成本分頁：有用量投影', () => {
  it('標語與口徑換成第 1 版；累計逐格等於 view.session；不再讀 sessionStats、不呼叫子代理 loader', async () => {
    const { script, view } = sample();
    const load = vi.fn<SubagentUsageLoader>(async () => {
      throw new Error('不該被呼叫');
    });
    mount(withMeter(base(script), script, view), load);
    await act(async () => {});
    expect(text('cost-headline')).toBe(COST_STRUCTURED_HEADLINE);
    expect(text('cost-headline')).not.toBe(COST_HEADLINE);
    const totals = screen.getByTestId('cost-totals');
    const field = (name: string) => totals.querySelector(`[data-field="${name}"]`);
    expect(numberIn(field('inputTokens'))).toBe(view.session.inputTokens);
    expect(numberIn(field('outputTokens'))).toBe(view.session.outputTokens);
    expect(numberIn(field('tokensTotal'))).toBe(
      view.session.inputTokens + view.session.outputTokens,
    );
    expect(numberIn(field('steps'))).toBe(view.session.steps);
    const limits = within(screen.getByTestId('cost-limits')).getAllByRole('listitem');
    expect(limits.map((item) => item.textContent)).toEqual(Object.values(COST_STRUCTURED_LIMITS));
    expect(limits.map((item) => item.textContent)).not.toEqual(Object.values(COST_LIMITS));
    expect(screen.queryByTestId('cost-subagent-reload')).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('更早合併的、逐輪的、不在任何輪裡的三段，加起來就是累計（沒有哪一段被丟掉）', async () => {
    const { script, view } = sample();
    mount(withMeter(base(script), script, view));
    await act(async () => {});
    for (const [name, key] of [
      ['inputTokens', 'inputTokens'],
      ['outputTokens', 'outputTokens'],
      ['steps', 'steps'],
    ] as const) {
      const parts = [
        screen.getByTestId('cost-earlier'),
        ...screen.getAllByTestId('cost-turn'),
        screen.getByTestId('cost-outside'),
      ].map((part) => numberIn(part.querySelector(`[data-field="${name}"]`)));
      expect(
        parts.reduce((sum, value) => sum + value, 0),
        name,
      ).toBe(view.session[key]);
    }
  });

  it('逐輪的列：編號、起因、收尾方式、時刻；負的殘差照實寫並標記；沒報用量的呼叫讓 token 標下限', async () => {
    const script = new Script();
    const view = meterView({
      turns: [
        meterTurn(0, { seq: 10, unaccountedMs: -1500, unknownSteps: 1 }),
        meterTurn(1, { seq: 110, end: 'paused', kind: 'resume' }),
        { ...meterTurn(2, { seq: 210, kind: 'x-new' }), end: undefined, wallMs: undefined },
      ],
    });
    mount(withMeter(base(script), script, view));
    await act(async () => {});
    const [first, second, third] = screen.getAllByTestId('cost-turn');
    expect(first!.textContent).toContain('第 1 輪');
    expect(first!.textContent).toContain('−1.5 秒');
    expect(first!.textContent).toContain('前提被破壞');
    expect(first!.querySelector('[data-field="inputTokens"]')!.textContent).toContain('（下限）');
    expect(second!.textContent).toContain('第 2 輪');
    expect(second!.textContent).toContain('核准後續接');
    expect(second!.textContent).toContain('停在核准點');
    expect(third!.textContent).toContain('x-new');
    expect(third!.textContent).toContain('進行中');
  });

  it('每個畫在畫面上的數字都有口徑：data-field 都在口徑表裡，展開後每一項都有一句話', async () => {
    const script = new Script();
    const view = meterView({
      turns: [
        meterTurn(0, {
          failedSteps: 1,
          failedInputTokens: 5,
          failedOutputTokens: 1,
          retries: 1,
          retryWaitMs: 500,
          waitMs: 900,
          summaries: 1,
          summaryInputTokens: 10,
          summaryOutputTokens: 2,
          toolErrors: 1,
        }),
      ],
      links: [meterLink('bg-1')],
    });
    let state = withMeter(base(script), script, view);
    state = withSubagentMeter(state, script, 'bg-1', meterView({ turns: [meterTurn(0)] }));
    mount(state);
    await act(async () => {});
    const fields = new Set(
      [...document.querySelectorAll('[data-field]')].map((node) =>
        node.getAttribute('data-field')!,
      ),
    );
    expect(fields.size).toBeGreaterThan(10);
    for (const field of fields) expect(caliberOf(field), field).toBeTypeOf('string');
    fireEvent.click(within(screen.getByTestId('cost-calibers')).getByRole('button'));
    const shown = new Set(
      [...document.querySelectorAll('[data-caliber]')].map((node) =>
        node.getAttribute('data-caliber')!,
      ),
    );
    for (const field of fields) expect(shown.has(field), field).toBe(true);
    for (const item of document.querySelectorAll('[data-caliber]')) {
      expect(item.textContent!.length).toBeGreaterThan(8);
    }
  });

  it('一次用量都沒有：講「還沒有用量」，不畫 0', async () => {
    const script = new Script();
    mount(withMeter(base(script), script, meterView()));
    await act(async () => {});
    expect(text('cost-totals')).toContain(COST_NO_USAGE);
    expect(screen.getByTestId('cost-turns').textContent).toContain('還沒有開過輪');
  });

  it.each([
    ['版本不認得', TOKEN_METER_VERSION + 1],
    ['拋過', -1],
  ])('%s：整個退回第 0 版，照舊讀子代理總帳', async (_label, version) => {
    const { script, view } = sample();
    const load = vi.fn<SubagentUsageLoader>(async () => ({
      ok: true,
      usage: {
        tokenUsage: { inputTokens: 1, outputTokens: 1 },
        sessionStats: { turns: 1, steps: 1, llmMs: 1, toolMs: 1 },
      },
    }));
    const state =
      version === -1
        ? reduceAll(base(script), [
            projectionFrame(script, TOKEN_METER_PROJECTION, TOKEN_METER_VERSION, null, {
              failed: true,
            }),
          ])
        : withMeter(base(script), script, view, version);
    const withBackground = reduceAll(state, [
      script.started('d1', 'subagent', { description: '查 A' }),
      script.finishedWith('d1', '已派出', {
        kind: 'background-subagent',
        runId: 'bg-1',
        subagentType: 'researcher',
      }),
    ]);
    mount(withBackground, load);
    await act(async () => {});
    expect(text('cost-headline')).toBe(COST_HEADLINE);
    expect(screen.queryByTestId('cost-turns')).toBeNull();
    expect(load).toHaveBeenCalled();
  });
});

describe('成本分頁：子代理（來自投影，含前景）', () => {
  it('每個 link 一列：前景標前景並提醒時間不能相加、背景標背景；投影還沒到寫「還沒有資料」；含子代理的 token 只加 token', async () => {
    const script = new Script();
    const root = meterView({
      outside: span({ steps: 1, inputTokens: 100, outputTokens: 10 }),
      links: [
        meterLink('bg-1', { turn: 0 }),
        meterLink('fg-1', { mode: 'one-shot', turn: 1 }),
        meterLink('late'),
      ],
      linksOmitted: 3,
    });
    let state = withMeter(base(script), script, root);
    state = withSubagentMeter(state, script, 'bg-1', meterView({ turns: [meterTurn(0)] }));
    state = withSubagentMeter(
      state,
      script,
      'fg-1',
      meterView({ outside: span({ steps: 2, inputTokens: 40, outputTokens: 4, modelMs: 3_000 }) }),
    );
    mount(state);
    await act(async () => {});
    const rows = screen.getAllByTestId('cost-subagent');
    expect(rows.map((row) => row.getAttribute('data-run-id'))).toEqual(['bg-1', 'fg-1', 'late']);
    expect(rows[0]!.textContent).toContain('背景');
    expect(rows[0]!.textContent).toContain('第 1 輪派出');
    expect(rows[1]!.textContent).toContain('前景');
    expect(rows[1]!.textContent).toContain('不要和主對話的時間相加');
    expect(numberIn(rows[1]!.querySelector('[data-field="inputTokens"]'))).toBe(40);
    // 前景的對不到名字就寫「子代理」（不是「背景子代理」）；背景對不到名字才寫「背景子代理」。
    expect(rows[1]!.querySelector('p')!.textContent).toMatch(/^子代理前景/u);
    expect(rows[2]!.querySelector('p')!.textContent).toMatch(/^背景子代理背景/u);
    expect(rows[2]!.textContent).toContain(COST_SUBAGENT_PENDING);
    expect(rows[2]!.querySelector('[data-field]')).toBeNull();
    // 110（root）＋120（bg-1 那一輪的輸入 100／輸出 20）＋44（fg-1），而且是下限（有一個沒資料、有更早的沒列出）。
    const total = screen
      .getByTestId('cost-totals')
      .querySelector('[data-field="subagentTokens"]')!.textContent!;
    expect(total).toContain('含子代理的 token');
    expect(total).toContain('274 token');
    expect(total).toContain('（下限）');
    expect(text('cost-links-omitted')).toContain('3 個子代理');
    // 時間沒有跨會話加總：累計那一段的模型耗時還是 root 自己的。
    expect(
      screen.getByTestId('cost-totals').querySelector('[data-field="modelMs"] dd')!.textContent,
    ).toBe('0 秒');
  });

  it('沒有 link：講還沒有派出子代理，也沒有含子代理那一格', async () => {
    const script = new Script();
    mount(withMeter(base(script), script, meterView({ turns: [meterTurn(0)] })));
    await act(async () => {});
    expect(text('cost-subagents')).toContain('還沒有派出子代理');
    expect(document.querySelector('[data-field="subagentTokens"]')).toBeNull();
  });

  it('每個子代理自己的值整份換成全新物件（同內容）也不會讓畫面變：投影來回重送是常態', async () => {
    const script = new Script();
    const root = meterView({ links: [meterLink('bg-1')] });
    const child = meterView({ turns: [meterTurn(0)] });
    const state = withSubagentMeter(withMeter(base(script), script, root), script, 'bg-1', child);
    const { store } = mount(state);
    await act(async () => {});
    const before = screen.getByTestId('cost-subagent').innerHTML;
    act(() => {
      store.set(
        withSubagentMeter(
          withMeter(base(script), script, structuredClone(root)),
          script,
          'bg-1',
          structuredClone(child),
        ),
      );
    });
    expect(screen.getByTestId('cost-subagent').innerHTML).toBe(before);
  });
});

describe('成本分頁：可及性', () => {
  it('axe：有逐輪、子代理與口徑展開（亮與暗）', async () => {
    const script = new Script();
    let state = withMeter(
      base(script),
      script,
      meterView({ turns: [meterTurn(0), meterTurn(1, { kind: 'goal' })], links: [meterLink('a')] }),
    );
    state = withSubagentMeter(state, script, 'a', meterView({ turns: [meterTurn(0)] }));
    mount(state);
    await act(async () => {});
    fireEvent.click(within(screen.getByTestId('cost-calibers')).getByRole('button'));
    expect(await axeViolations(document.body)).toEqual([]);
    document.documentElement.classList.add('dark');
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
