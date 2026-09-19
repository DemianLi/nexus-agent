import type { PendingApproval, PendingInput, PendingQuestion } from '@nexus/wire';
import { APPROVAL_PENDING_KIND, QUESTION_PENDING_KIND } from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { ApprovalCard } from '@/components/approval-card';
import { PendingSwap } from '@/components/pending-swap';
import { axeViolations } from '@/test/axe';

/** 換手層（#408）：面板換掉輸入框、一次一個、焦點只在會丟掉時才搬。 */

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
});

function approval(name: string, interruptId: string): PendingApproval {
  return {
    kind: APPROVAL_PENDING_KIND,
    interruptId,
    actions: [{ name, args: { path: 'src/a.ts' } }],
    allowedDecisions: ['approve', 'reject'],
  } as unknown as PendingApproval;
}

function question(interruptId: string): PendingQuestion {
  return {
    kind: QUESTION_PENDING_KIND,
    interruptId,
    questions: [{ id: 'a', question: '哪一天？' }],
  } as unknown as PendingQuestion;
}

/** 草稿住在呼叫端（跟 App 一樣），輸入框是一顆真的 textarea。 */
function Harness({ pendings }: { pendings: readonly PendingInput[] }) {
  const [draft, setDraft] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <main>
      <button type="button">別處</button>
      <PendingSwap
        pendings={pendings}
        composerRef={ref}
        composer={
          <textarea
            ref={ref}
            aria-label="要說的話"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        }
        renderPanel={(pending) =>
          pending.kind === 'approval' ? (
            <ApprovalCard pending={pending} busy={false} onDecide={() => {}} onStop={() => {}} />
          ) : (
            <p>提問</p>
          )
        }
      />
    </main>
  );
}

const panel = () => document.querySelector<HTMLElement>('[data-slot="pending-panel"]');

describe('換手層', () => {
  it('面板出現時輸入框藏起來不卸載，草稿留著；面板收掉草稿還在', async () => {
    const view = render(<Harness pendings={[]} />);
    const input = screen.getByLabelText<HTMLTextAreaElement>('要說的話');
    fireEvent.change(input, { target: { value: '打到一半' } });

    view.rerender(<Harness pendings={[approval('edit_file', 'int-1')]} />);
    await screen.findByRole('region', { name: '等待核准：edit_file' });
    // 同一顆 textarea：沒被卸載，藏起來、退出 Tab 順序。
    expect(screen.getByLabelText('要說的話')).toBe(input);
    expect(input.closest('[hidden]')).not.toBeNull();
    expect(input.closest('[inert]')).not.toBeNull();
    expect(input.value).toBe('打到一半');

    view.rerender(<Harness pendings={[]} />);
    await waitFor(() => expect(panel()).toBeNull());
    expect(input.closest('[hidden]')).toBeNull();
    expect(input.value).toBe('打到一半');
  });

  it('兩個待決時先來先處理，進度跨面板數（核准與提問一起）', async () => {
    const view = render(<Harness pendings={[]} />);
    view.rerender(<Harness pendings={[approval('edit_file', 'int-1'), question('q-1')]} />);
    await screen.findByRole('region', { name: '等待核准：edit_file（1／2）' });
    expect(screen.queryByText('提問')).toBeNull();

    view.rerender(<Harness pendings={[question('q-1')]} />);
    await screen.findByRole('region', { name: '有 1 個問題要你回答' });
  });

  it('焦點在輸入框時搬到面板本身（不是按鈕）；面板收掉回輸入框', async () => {
    const view = render(<Harness pendings={[]} />);
    const input = screen.getByLabelText('要說的話');
    input.focus();

    view.rerender(<Harness pendings={[approval('edit_file', 'int-1')]} />);
    await waitFor(() => expect(document.activeElement).toBe(panel()));
    expect(panel()?.getAttribute('tabindex')).toBe('-1');

    view.rerender(<Harness pendings={[]} />);
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it('面板收掉時有下一個待決就到下一張', async () => {
    const view = render(<Harness pendings={[]} />);
    screen.getByLabelText('要說的話').focus();
    const both = [approval('edit_file', 'int-1'), approval('bash', 'int-2')];
    view.rerender(<Harness pendings={both} />);
    await waitFor(() => expect(document.activeElement).toBe(panel()));

    view.rerender(<Harness pendings={[approval('bash', 'int-2')]} />);
    await screen.findByRole('region', { name: '等待核准：bash' });
    await waitFor(() => expect(document.activeElement).toBe(panel()));
  });

  it('焦點在別處時不搶：人在看別的東西，由狀態列唸', async () => {
    const view = render(<Harness pendings={[]} />);
    const elsewhere = screen.getByRole('button', { name: '別處' });
    elsewhere.focus();

    view.rerender(<Harness pendings={[approval('edit_file', 'int-1')]} />);
    await screen.findByRole('region', { name: '等待核准：edit_file' });
    // 換手的 effect 已經跑過了（面板畫出來了），再讓一輪 microtask 過去。
    await act(async () => {});
    expect(document.activeElement).toBe(elsewhere);
  });

  it('axe：核准面板（暗色；jsdom 沒有版面，寬度與對比度另驗）', async () => {
    document.documentElement.classList.add('dark');
    const view = render(<Harness pendings={[]} />);
    view.rerender(<Harness pendings={[approval('edit_file', 'int-1')]} />);
    await screen.findByRole('region', { name: '等待核准：edit_file' });
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
