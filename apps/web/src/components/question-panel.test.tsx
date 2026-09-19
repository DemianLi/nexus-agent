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
