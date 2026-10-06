import type { PendingQuestion, ToolEntry } from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PlanReviewPanel, PlanToolCard } from '@/components/plan/plan-review';
import { PLAN_TAB_MISSING_TEXT, RightSidebarToggle } from '@/components/sidebar/right-sidebar';
import { AUTO_OPENED_KEY, planDocument, planReviewOf } from '@/lib/plan-review';
import type { PlanDocument } from '@/lib/plan-review';
import { axeViolations } from '@/test/axe';
import { WithRightSidebar, memoryStorage } from '@/test/right-sidebar';

/**
 * 計劃審核的畫面（#654）：面板、計劃卡、右側欄的「計劃」分頁。送出去的形狀與「要求修改」不停這一輪驗在
 * `App.test.tsx`；規則驗在 `lib/plan-review.test.ts`。
 */

const PLAN = '# 改登入頁\n\n先把**文案**改成中文。\n\n## 步驟\n\n- 改文案\n- 補測試';

const PENDING: PendingQuestion = {
  kind: 'question',
  interruptId: 'int-1',
  namespace: ['tools:a'],
  questions: [
    {
      id: 'plan-review',
      question: '同意這份計劃並離開計劃模式？',
      detail: PLAN,
      options: [{ label: '同意' }, { label: '繼續規劃' }],
      intent: { kind: 'plan-review', approve: '同意', callId: 'call_1' },
    },
  ],
} as unknown as PendingQuestion;
const REVIEW = planReviewOf(PENDING.questions)!;

function toolEntry(patch: Partial<ToolEntry> = {}): ToolEntry {
  return {
    kind: 'tool',
    id: 'tool-call_1',
    callId: 'call_1',
    name: 'exit_plan_mode',
    input: JSON.stringify({ plan: PLAN }),
    status: 'suspended',
    attribution: { kind: 'root' },
    ...patch,
  };
}

const PLANS: ReadonlyMap<string, PlanDocument> = new Map([['call_1', planDocument(PLAN)]]);

function Screen({ panel = true, card }: { panel?: boolean; card?: ToolEntry }) {
  return (
    <WithRightSidebar sources={{ plans: PLANS }}>
      <main>
        <RightSidebarToggle />
        {card !== undefined && <PlanToolCard entry={card} beam={false} />}
        {panel && (
          <section aria-label="計劃待審">
            <PlanReviewPanel
              pending={PENDING}
              review={REVIEW}
              busy={false}
              onApprove={() => undefined}
              onRevise={() => undefined}
            />
          </section>
        )}
      </main>
    </WithRightSidebar>
  );
}

async function mount(props: { panel?: boolean; card?: ToolEntry } = {}) {
  const view = render(<Screen {...props} />);
  await act(async () => {});
  return view;
}

const aside = () => screen.getByTestId('right-sidebar');
const tabNames = () => screen.queryAllByRole('tab').map((tab) => tab.textContent);
const openButton = (root: HTMLElement) =>
  within(root).getByRole('button', { name: '查看全文：改登入頁' });

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('面板', () => {
  it('標題、兩行摘要（去掉 markdown）、只有兩顆鈕：要求修改在左、同意執行在右', async () => {
    await mount();
    const panel = screen.getByTestId('plan-review-panel');
    expect(within(panel).getByTestId('plan-title').textContent).toBe('改登入頁');
    const summary = within(panel).getByTestId('plan-summary');
    expect(summary.textContent).toBe('先把文案改成中文。');
    expect(summary.className).toContain('line-clamp-2');
    expect(
      within(panel)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['查看全文', '要求修改', '同意執行']);
  });

  it('按鈕各自回呼', async () => {
    const approve = vi.fn();
    const revise = vi.fn();
    render(
      <PlanReviewPanel
        pending={PENDING}
        review={REVIEW}
        busy={false}
        onApprove={approve}
        onRevise={revise}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '同意執行' }));
    fireEvent.click(screen.getByRole('button', { name: '要求修改' }));
    expect(approve).toHaveBeenCalledTimes(1);
    expect(revise).toHaveBeenCalledTimes(1);
  });

  it('沒有右側欄：不給「查看全文」', () => {
    render(
      <PlanReviewPanel
        pending={PENDING}
        review={REVIEW}
        busy={false}
        onApprove={() => undefined}
        onRevise={() => undefined}
      />,
    );
    expect(screen.queryByRole('button', { name: /查看全文/ })).toBeNull();
  });

  it('連線斷了：兩顆鈕都按不動', () => {
    render(
      <PlanReviewPanel
        pending={PENDING}
        review={REVIEW}
        busy
        onApprove={() => undefined}
        onRevise={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: '同意執行' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '要求修改' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('全文：寬螢幕', () => {
  it('面板一出現就自動停靠「計劃」分頁；焦點不搬過去', async () => {
    await mount();
    expect(aside().hidden).toBe(false);
    expect(tabNames()).toEqual(['改登入頁']);
    const preview = screen.getByTestId('plan-preview');
    expect(within(preview).getByRole('heading', { name: '改登入頁' })).toBeTruthy();
    expect(within(preview).getByRole('heading', { name: '步驟' })).toBeTruthy();
    expect(aside().contains(document.activeElement)).toBe(false);
    expect(JSON.parse(localStorage.getItem(AUTO_OPENED_KEY) ?? '[]')).toEqual(['call_1']);
  });

  it('關掉之後不再自動彈，重新整理（重新掛上）也一樣；按「查看全文」又打開同一個分頁', async () => {
    const view = await mount();
    fireEvent.click(screen.getByTestId('right-sidebar-tab-close'));
    await act(async () => {});
    expect(tabNames()).toEqual([]);
    view.unmount();

    await mount();
    expect(tabNames()).toEqual([]);

    fireEvent.click(openButton(screen.getByTestId('plan-review-panel')));
    await act(async () => {});
    expect(tabNames()).toEqual(['改登入頁']);
  });

  it('按「查看全文」：焦點進分頁；收起時回到「查看全文」', async () => {
    await mount();
    const button = openButton(screen.getByTestId('plan-review-panel'));
    button.focus();
    fireEvent.click(button);
    await act(async () => {});
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: '改登入頁' }));

    fireEvent.click(within(aside()).getByRole('button', { name: '收起右側欄' }));
    await act(async () => {});
    expect(aside().hidden).toBe(true);
    expect(document.activeElement).toBe(button);
  });

  it('從計劃卡打開的跟從面板打開的是同一個分頁', async () => {
    await mount({ card: toolEntry() });
    fireEvent.click(openButton(screen.getByTestId('plan-card')));
    await act(async () => {});
    fireEvent.click(openButton(screen.getByTestId('plan-review-panel')));
    await act(async () => {});
    expect(tabNames()).toEqual(['改登入頁']);
  });

  it('分頁指到對話裡沒有的那一份：講一聲，不空白', async () => {
    render(
      <WithRightSidebar sources={{ plans: new Map() }}>
        <main>
          <PlanReviewPanel
            pending={PENDING}
            review={REVIEW}
            busy={false}
            onApprove={() => undefined}
            onRevise={() => undefined}
          />
        </main>
      </WithRightSidebar>,
    );
    await act(async () => {});
    expect(tabNames()).toEqual(['計劃']);
    expect(screen.getByText(PLAN_TAB_MISSING_TEXT)).toBeTruthy();
  });
});

describe('全文：窄螢幕', () => {
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

  it('不自動開，也不記成開過；按「查看全文」才全螢幕打開，關掉後面板的鈕照樣按得到', async () => {
    await mount();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(localStorage.getItem(AUTO_OPENED_KEY)).toBeNull();

    fireEvent.click(openButton(screen.getByTestId('plan-review-panel')));
    await act(async () => {});
    const dialog = screen.getByRole('dialog', { name: '右側欄' });
    expect(within(dialog).getByRole('tab').textContent).toBe('改登入頁');
    expect(within(dialog).getByTestId('plan-preview')).toBeTruthy();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull();
    const panel = screen.getByTestId('plan-review-panel');
    expect(panel.closest('[aria-hidden="true"]')).toBeNull();
    expect(panel.closest('[inert]')).toBeNull();
  });
});

describe('計劃卡', () => {
  it.each([
    ['done', undefined, '已同意'],
    [
      'failed',
      '使用者關掉了計劃審核，要自己說話。留在計劃模式，停在這裡，等使用者的訊息。',
      '要求修改',
    ],
    ['failed', 'tool call aborted before dispatch', '停止'],
  ] as const)('結果 %s／%s：chip 寫「%s」', async (status, error, label) => {
    await mount({
      panel: false,
      card: toolEntry({ status, ...(error === undefined ? {} : { error }) }),
    });
    const card = screen.getByTestId('plan-card');
    expect(within(card).getByTestId('plan-outcome').textContent).toBe(label);
    expect(within(card).getByTestId('plan-title').textContent).toBe('改登入頁');
  });

  it('還在等：沒有 chip', async () => {
    await mount({ panel: false, card: toolEntry() });
    expect(screen.queryByTestId('plan-outcome')).toBeNull();
  });

  it('沒有 # 標題、參數解不開：退回通用工具卡', async () => {
    await mount({ panel: false, card: toolEntry({ input: '{"plan":"沒有標題"}' }) });
    expect(screen.queryByTestId('plan-card')).toBeNull();
    expect(screen.getByTestId('tool-entry')).toBeTruthy();
  });
});

it('面板、計劃卡、分頁過 axe', async () => {
  await mount({ card: toolEntry({ status: 'done' }) });
  expect(screen.getByTestId('plan-preview')).toBeTruthy();
  expect(await axeViolations(document.body)).toEqual([]);
});
