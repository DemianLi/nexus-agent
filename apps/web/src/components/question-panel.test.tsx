import type { PendingApproval, PendingInput, PendingQuestion, QuestionItem } from '@nexus/wire';
import { APPROVAL_PENDING_KIND, QUESTION_PENDING_KIND } from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApprovalCard } from '@/components/approval-card';
import { PendingSwap } from '@/components/pending-swap';
import { QuestionPanel } from '@/components/question-panel';
import type { QuestionAnswer } from '@/components/question-panel';
import { axeViolations } from '@/test/axe';

/** 提問面板（#409）：questionnaire 的補件與換手層上的收起、Esc、焦點。 */

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
});

function question(questions: readonly QuestionItem[], interruptId = 'q-1'): PendingQuestion {
  return { kind: QUESTION_PENDING_KIND, interruptId, namespace: [], questions };
}

const approval: PendingApproval = {
  kind: APPROVAL_PENDING_KIND,
  interruptId: 'int-1',
  namespace: [],
  actions: [{ name: 'edit_file', args: { path: 'a.ts' } }],
  allowedDecisions: ['approve', 'reject'],
};

const DAY: QuestionItem = {
  id: 'day',
  question: '哪一天？',
  options: [{ label: '週一' }, { label: '週二', description: '下午' }],
};
const NAME: QuestionItem = { id: 'name', question: '訪客姓名？', header: '姓名' };
const FOOD: QuestionItem = {
  id: 'food',
  question: '要準備什麼？',
  options: [{ label: '茶' }, { label: '咖啡' }],
  multiSelect: true,
};

function renderPanel(pending: PendingQuestion) {
  const answers: QuestionAnswer[][] = [];
  render(<QuestionPanel pending={pending} busy={false} onAnswer={(a) => answers.push(a)} />);
  return answers;
}

/** 目前這一題（其他題的 fieldset 是 `hidden`，`getByRole` 不會抓到）。 */
const currentTitle = () => document.querySelector('fieldset:not([hidden]) legend')?.textContent;
// 帶描述的選項名稱是「標籤＋描述」（週二下午），所以比開頭。
const radio = (label: string) =>
  screen.getByRole<HTMLInputElement>('radio', { name: new RegExp(`^${label}`) });
const free = () => screen.getByRole<HTMLInputElement>('textbox', { name: '輸入你的答案' });

describe('questionnaire 的補件', () => {
  it('絆索 8：進度條的 aria-live 關掉，進度寫中文（primitive 寫死英文、預設 polite）', () => {
    renderPanel(question([DAY, NAME]));
    const progress = screen.getByRole('progressbar');
    expect(progress.getAttribute('aria-live')).toBe('off');
    expect(progress.textContent).toBe('第 1 題，共 2 題');
    expect(progress.getAttribute('aria-valuetext')).toBe('第 1 題，共 2 題');
    expect(progress.getAttribute('aria-label')).toBe('問題進度');
  });

  it('legend 前有 sr-only 的題號：焦點落到 fieldset 時一次唸「第 n 題，共 m 題：題目」', () => {
    renderPanel(question([DAY, NAME]));
    const legend = screen.getByRole('group', { name: /哪一天？/ }).querySelector('legend')!;
    expect(legend.querySelector('.sr-only')?.textContent).toBe('第 1 題，共 2 題：');
    expect(legend.textContent).toBe('第 1 題，共 2 題：哪一天？');
  });

  it('單選有選項時事先告知會自動跳（WCAG 3.2.2）；多選不講', () => {
    renderPanel(question([DAY, FOOD]));
    expect(screen.getByRole('group', { name: /哪一天？/ }).textContent).toContain(
      '點選項會跳到下一題',
    );
    fireEvent.click(radio('週一'));
    fireEvent.click(screen.getByRole('button', { name: '下一題' }));
    expect(screen.getByRole('group', { name: /要準備什麼？/ }).textContent).not.toContain(
      '跳到下一題',
    );
  });

  it('**指標選的才自動跳**，先停 200 讓勾選看得到', async () => {
    vi.useFakeTimers();
    try {
      renderPanel(question([DAY, NAME]));
      fireEvent.pointerDown(radio('週一'));
      fireEvent.click(radio('週一'));
      act(() => vi.advanceTimersByTime(199));
      expect(currentTitle()).toContain('哪一天？');
      act(() => vi.advanceTimersByTime(1));
      expect(currentTitle()).toContain('訪客姓名？');
    } finally {
      vi.useRealTimers();
    }
  });

  it('**鍵盤改選取不跳**（方向鍵、數字鍵），要按 Enter', async () => {
    vi.useFakeTimers();
    try {
      renderPanel(question([DAY, NAME]));
      // 先用指標點過一次再改用鍵盤：指標的旗標不能留到鍵盤那一次。
      fireEvent.pointerDown(radio('週一'));
      fireEvent.keyDown(radio('週一'), { key: '2' });
      expect(radio('週二').checked).toBe(true);
      act(() => vi.advanceTimersByTime(1000));
      expect(currentTitle()).toContain('哪一天？');

      fireEvent.keyDown(radio('週二'), { key: 'Enter' });
      act(() => vi.advanceTimersByTime(0));
      expect(currentTitle()).toContain('訪客姓名？');
    } finally {
      vi.useRealTimers();
    }
  });

  it('單選時填字就取代選項，點選項就取代填的字（#376 第 2 條）', () => {
    const answers = renderPanel(question([DAY]));
    fireEvent.click(radio('週一'));
    fireEvent.change(free(), { target: { value: '週五' } });
    expect(radio('週一').checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '送出答案' }));
    expect(answers).toEqual([[{ id: 'day', selected: [], custom: '週五' }]]);
  });

  it('點回選項時填的字不送出——字還在框裡，但不是答案', () => {
    const answers = renderPanel(question([DAY]));
    fireEvent.change(free(), { target: { value: '週五' } });
    fireEvent.click(radio('週二'));
    fireEvent.click(screen.getByRole('button', { name: '送出答案' }));
    expect(answers).toEqual([[{ id: 'day', selected: ['週二'] }]]);
  });

  it('多選時選項與自己寫的並存', () => {
    const answers = renderPanel(question([FOOD]));
    fireEvent.click(screen.getByRole('checkbox', { name: '茶' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '咖啡' }));
    fireEvent.change(free(), { target: { value: '氣泡水' } });
    fireEvent.click(screen.getByRole('button', { name: '送出答案' }));
    expect(answers).toEqual([[{ id: 'food', selected: ['茶', '咖啡'], custom: '氣泡水' }]]);
  });

  it('沒有選項的題目只有自由作答列；沒填就送出時秀中文原因，不送', async () => {
    const answers = renderPanel(question([NAME]));
    expect(screen.queryByRole('radio')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '送出答案' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      '還沒回答這一題：寫下答案，或按跳過。',
    );
    expect(answers).toHaveLength(0);
  });

  it('上下題有方向：往後 next、往前 prev；第一次畫出來不動', () => {
    renderPanel(question([DAY, NAME]));
    const form = screen.getByRole('progressbar').closest('form')!;
    expect(form.getAttribute('data-page-dir')).toBeNull();
    fireEvent.click(radio('週一'));
    fireEvent.click(screen.getByRole('button', { name: '下一題' }));
    expect(form.getAttribute('data-page-dir')).toBe('next');
    fireEvent.click(screen.getByRole('button', { name: '上一題' }));
    expect(form.getAttribute('data-page-dir')).toBe('prev');
    // 回頭改：第一題的選取還在。
    expect(radio('週一').checked).toBe(true);
  });
});

/** 草稿住在呼叫端（跟 App 一樣），輸入框是一顆真的 textarea。 */
function Harness({ pendings }: { pendings: readonly PendingInput[] }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <main>
      <PendingSwap
        pendings={pendings}
        composerRef={ref}
        composer={<textarea ref={ref} aria-label="要說的話" />}
        renderPanel={(pending) =>
          pending.kind === 'question' ? (
            <QuestionPanel pending={pending} busy={false} onAnswer={() => {}} />
          ) : (
            <ApprovalCard pending={pending} busy={false} onDecide={() => {}} onStop={() => {}} />
          )
        }
        renderActions={(pending) =>
          pending.kind === 'question' && (
            <button type="button" aria-label="停止這一輪，不回答這些問題">
              ×
            </button>
          )
        }
      />
    </main>
  );
}

const QUESTIONS = question([DAY, NAME]);
const panel = () => screen.getByRole('region', { name: '有 2 個問題要你回答' });

describe('換手層上的提問面板', () => {
  it('焦點從輸入框搬到當前那一題的 fieldset（§8），不是面板本身', async () => {
    const view = render(<Harness pendings={[]} />);
    screen.getByLabelText('要說的話').focus();
    view.rerender(<Harness pendings={[QUESTIONS]} />);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('group', { name: /哪一天？/ })),
    );
  });

  it('名稱列上有呼叫端給的 ❌；核准面板沒有', async () => {
    const view = render(<Harness pendings={[QUESTIONS]} />);
    expect(
      within(panel()).getByRole('button', { name: '停止這一輪，不回答這些問題' }),
    ).toBeTruthy();
    view.rerender(<Harness pendings={[approval]} />);
    const approvalPanel = await screen.findByRole('region', { name: '等待核准：edit_file' });
    expect(within(approvalPanel).queryByRole('button', { name: /停止/ })).toBeNull();
    expect(within(approvalPanel).queryByRole('button', { name: /收起/ })).toBeNull();
  });

  it('收起再展開，答到一半的還在（內容保持掛載）；關完才 hidden', async () => {
    render(<Harness pendings={[QUESTIONS]} />);
    fireEvent.click(radio('週二'));
    fireEvent.click(within(panel()).getByRole('button', { name: '收起這些問題' }));
    const content = panel().querySelector('[data-slot="collapsible-content"]')!;
    // 關的動效那 150ms 裡還看得到、但已經進不去。
    expect(content.hasAttribute('hidden')).toBe(false);
    expect(content.hasAttribute('inert')).toBe(true);
    await waitFor(() => expect(content.hasAttribute('hidden')).toBe(true));

    fireEvent.click(within(panel()).getByRole('button', { name: '展開這些問題' }));
    expect(content.hasAttribute('hidden')).toBe(false);
    expect(radio('週二').checked).toBe(true);
  });

  it('Esc＝收起（不是停止），焦點落到展開鈕上；核准面板 Esc 不做事', async () => {
    const view = render(<Harness pendings={[QUESTIONS]} />);
    fireEvent.keyDown(radio('週一'), { key: 'Escape' });
    const trigger = within(panel()).getByRole('button', { name: '展開這些問題' });
    expect(document.activeElement).toBe(trigger);

    view.rerender(<Harness pendings={[approval]} />);
    const approvalPanel = await screen.findByRole('region', { name: '等待核准：edit_file' });
    fireEvent.keyDown(approvalPanel, { key: 'Escape' });
    expect(within(approvalPanel).getByRole('button', { name: '全部核准' })).toBeTruthy();
  });

  it('axe：提問面板（暗色；§11 絆索 6 的「375 暗」，jsdom 沒有版面，寬度另驗）', async () => {
    document.documentElement.classList.add('dark');
    render(<Harness pendings={[QUESTIONS]} />);
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('axe：提問面板（亮色；§11 絆索 6 的「1280 亮」）', async () => {
    render(<Harness pendings={[question([FOOD, NAME])]} />);
    expect(await axeViolations(document.body)).toEqual([]);
  });
});

/** 照 #652 的生產者（`exit_plan_mode`）問的那一題。 */
const PLAN_REVIEW: QuestionItem = {
  id: 'plan-review',
  header: '計劃審核',
  question: '同意這份計劃並離開計劃模式？',
  detail: '# 改登入頁\n\n先做**錯誤訊息**：\n\n- 改成中文\n- 補測試',
  options: [{ label: '同意' }, { label: '繼續規劃' }],
  intent: { kind: 'plan-review', approve: '同意', callId: 'call-1' },
};

const detailOf = () => document.querySelector('[data-slot="question-detail"]');

describe('題目帶 detail（認不出來的計劃審核也走這裡，#652；認得的換成 #654 的面板）', () => {
  it('計劃全文畫成 markdown，放在題目那一組裡、選項前面', () => {
    renderPanel(question([PLAN_REVIEW]));
    const group = screen.getByRole('group', { name: /同意這份計劃並離開計劃模式？/ });
    const detail = detailOf();
    expect(detail).not.toBeNull();
    expect(group.contains(detail)).toBe(true);
    expect(within(group).getByRole('heading', { name: '改登入頁' })).toBeTruthy();
    expect(
      within(group)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['改成中文', '補測試']);
    expect(detail!.querySelector('strong')?.textContent).toBe('錯誤訊息');
    expect(detail!.textContent).not.toContain('**');
    // 在選項前面：先讀計劃，再選。
    const firstChoice = radio('同意');
    expect(detail!.compareDocumentPosition(firstChoice) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('答法跟一般提問一樣：送回選項標籤，不看 intent', () => {
    const answers = renderPanel(question([PLAN_REVIEW]));
    fireEvent.click(radio('同意'));
    fireEvent.click(screen.getByRole('button', { name: '送出答案' }));
    expect(answers).toEqual([[{ id: 'plan-review', selected: ['同意'] }]]);
  });

  it('沒有 detail、或只有空白的，不畫那一塊', () => {
    renderPanel(question([DAY, { ...NAME, detail: '  \n ' }]));
    expect(detailOf()).toBeNull();
    fireEvent.click(radio('週一'));
    fireEvent.click(screen.getByRole('button', { name: '下一題' }));
    expect(currentTitle()).toContain('訪客姓名？');
    expect(detailOf()).toBeNull();
  });

  it('axe：帶計劃全文的提問面板（亮、暗）', async () => {
    const view = render(<Harness pendings={[question([PLAN_REVIEW])]} />);
    expect(await axeViolations(document.body)).toEqual([]);
    view.unmount();
    document.documentElement.classList.add('dark');
    render(<Harness pendings={[question([PLAN_REVIEW])]} />);
    expect(await axeViolations(document.body)).toEqual([]);
  });
});

/** MCP server 反問（#1098）：來源、拒絕、取消。 */
describe('MCP 反問（#1098）', () => {
  const ORIGIN = {
    kind: 'mcp-elicitation' as const,
    server: 'files',
    tool: 'delete_dir',
    arguments: { path: '/tmp/x', recursive: true },
  };
  const asked = (): PendingQuestion => ({ ...question([DAY]), origin: ORIGIN });

  function renderAsked(
    props: {
      onDecline?: () => void;
      onDismiss?: () => void;
      busy?: boolean;
      pending?: PendingQuestion;
    } = {},
  ) {
    // `main` 是地標：axe 的 region 規則要求內容在地標裡（真的畫面裡由換手層的 region 擔任）。
    render(
      <main>
        <QuestionPanel
          pending={props.pending ?? asked()}
          busy={props.busy ?? false}
          onAnswer={() => {}}
          {...(props.onDecline === undefined ? {} : { onDecline: props.onDecline })}
          {...(props.onDismiss === undefined ? {} : { onDismiss: props.onDismiss })}
        />
      </main>,
    );
  }

  it('最上面講是哪台 server 的哪支工具在問，參數原文照畫（排版過的 JSON）', () => {
    renderAsked();
    const block = screen.getByTestId('question-origin');
    expect(block.textContent).toContain('MCP 伺服器「files」的工具「delete_dir」在問你');
    expect(screen.getByTestId('question-origin-arguments').textContent).toBe(
      JSON.stringify(ORIGIN.arguments, null, 2),
    );
    // 在題目之前。
    expect(
      block.compareDocumentPosition(document.querySelector('fieldset')!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('拒絕與取消各叫各的，都不是作答；答案那條路照舊', () => {
    const onDecline = vi.fn();
    const onDismiss = vi.fn();
    const answers: QuestionAnswer[][] = [];
    render(
      <QuestionPanel
        pending={asked()}
        busy={false}
        onAnswer={(a) => answers.push(a)}
        onDecline={onDecline}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '拒絕' }));
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(answers).toEqual([]);
    fireEvent.click(radio('週一'));
    fireEvent.click(screen.getByRole('button', { name: '送出答案' }));
    expect(answers).toEqual([[{ id: 'day', selected: ['週一'] }]]);
  });

  it('連線斷了（busy）：拒絕與取消都停用', () => {
    renderAsked({ onDecline: () => {}, onDismiss: () => {}, busy: true });
    expect(screen.getByRole('button', { name: '拒絕' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '取消' }).hasAttribute('disabled')).toBe(true);
  });

  it('模型自己問的（沒有 origin）：沒有來源區塊，就算給了處理函式也沒有拒絕與取消；操作列照舊釘在底部', () => {
    renderAsked({ pending: question([DAY]), onDecline: () => {}, onDismiss: () => {} });
    expect(screen.queryByTestId('question-origin')).toBeNull();
    expect(screen.queryByRole('button', { name: '拒絕' })).toBeNull();
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull();
    expect(document.querySelector('[data-slot="questionnaire-actions"]')?.className).toContain(
      'sticky',
    );
  });

  it('有 origin 但沒給處理函式：只有來源區塊，沒有那兩顆（舊接法不會多出按不動的鈕）', () => {
    renderAsked();
    expect(screen.getByTestId('question-origin')).toBeTruthy();
    expect(screen.queryByTestId('origin-actions')).toBeNull();
  });

  it('參數轉不成 JSON（循環）也不炸，退回字串', () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    renderAsked({ pending: { ...asked(), origin: { ...ORIGIN, arguments: loop } } });
    expect(screen.getByTestId('question-origin-arguments').textContent).toBe('[object Object]');
  });

  it('axe：有來源與拒絕、取消的面板（亮、暗）', async () => {
    renderAsked({ onDecline: () => {}, onDismiss: () => {} });
    expect(await axeViolations(document.body)).toEqual([]);
    cleanup();
    document.documentElement.classList.add('dark');
    renderAsked({ onDecline: () => {}, onDismiss: () => {} });
    expect(await axeViolations(document.body)).toEqual([]);
  });
});

describe('「（推薦）」小標與換題高度（#1306）', () => {
  const PICK: QuestionItem = {
    id: 'pick',
    question: '用哪個方案？',
    options: [
      { label: '方案甲（推薦）', description: '最快' },
      { label: '方案乙(推薦)' },
      { label: '方案丙' },
    ],
  };

  it('字尾畫成小標，畫面上的標籤不再帶字尾；沒有字尾的不畫', () => {
    renderPanel(question([PICK]));
    const badges = screen.getAllByTestId('recommended-badge');
    expect(badges.map((badge) => badge.textContent)).toEqual(['推薦', '推薦']);
    const [first] = document.querySelectorAll('[data-slot="questionnaire-choice-label"]');
    expect(first?.firstElementChild?.firstElementChild?.textContent).toBe('方案甲');
    expect(
      radio('方案丙')
        .closest('[data-slot="questionnaire-choice"]')
        ?.querySelector('[data-testid="recommended-badge"]'),
    ).toBeNull();
  });

  it('輔助技術仍唸原字尾：選項名稱跟以前一樣', () => {
    renderPanel(question([PICK]));
    expect(screen.getByRole('radio', { name: /^方案甲（推薦）/ })).not.toBeNull();
    expect(screen.getByRole('radio', { name: '方案乙（推薦）' })).not.toBeNull();
  });

  it('送出的答案仍是整個標籤，一字不差（全形、半形都是）', () => {
    const answers = renderPanel(question([PICK, { ...PICK, id: 'again' }]));
    fireEvent.click(screen.getByRole('radio', { name: /^方案甲/ }));
    fireEvent.click(screen.getByRole('button', { name: '下一題' }));
    // 其他題的 fieldset 是 `hidden`，`getAllByRole` 只抓得到當前這一題的。
    fireEvent.click(screen.getByRole('radio', { name: /^方案乙/ }));
    fireEvent.submit(screen.getByRole('progressbar').closest('form')!);
    expect(answers).toEqual([
      [
        { id: 'pick', selected: ['方案甲（推薦）'] },
        { id: 'again', selected: ['方案乙(推薦)'] },
      ],
    ]);
  });

  it('外框掛 motion-resize；換題時高度不同就過渡（jsdom 沒有版面：舊高量 100、新高量 240）', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      height: 240,
    } as DOMRect);
    try {
      renderPanel(question([DAY, NAME]));
      const surface = screen.getByRole('progressbar').closest('.motion-resize') as HTMLElement;
      expect(surface).not.toBeNull();
      expect(surface.hasAttribute('data-resizing')).toBe(false);
      fireEvent.click(radio('週一'));
      fireEvent.click(screen.getByRole('button', { name: '下一題' }));
      expect(surface.hasAttribute('data-resizing')).toBe(true);
      expect(surface.style.height).toBe('240px');
    } finally {
      vi.restoreAllMocks();
    }
  });
});
