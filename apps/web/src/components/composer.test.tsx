import type { SlashDescriptor } from '@nexus/wire';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Composer } from '@/components/composer';
import { axeViolations } from '@/test/axe';
import { stubCmdkLayout } from '@/test/cmdk';

/** 輸入框與 `/` 選單（#407）。 */

beforeEach(stubCmdkLayout);
afterEach(cleanup);

const plan: SlashDescriptor = {
  name: 'plan',
  description: '進出計劃模式。',
  input: { hint: '[off]' },
};
// 真的伺服器給的 `/feedback` 帶參數（`<內容>`），光打名字另有動作（開回饋框）：選單要直接執行它。
const feedback: SlashDescriptor = {
  name: 'feedback',
  description: '留一則回饋。',
  input: { hint: '<內容>' },
};
const todo: SlashDescriptor = { name: 'todo', description: '列出待辦。' };
const goal: SlashDescriptor = {
  name: 'goal',
  description: '設定目標。',
  input: { hint: '<目標>' },
};

function Harness({
  initial = '',
  canSend = true,
  run = () => true,
  onSubmit = () => {},
}: {
  initial?: string;
  canSend?: boolean;
  run?: (line: string) => boolean;
  onSubmit?: (draft: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <main>
      <Composer
        draft={draft}
        onDraftChange={setDraft}
        placeholder="說點什麼…"
        canSend={canSend && draft.trim() !== ''}
        onSubmit={() => {
          onSubmit(draft);
          setDraft('');
        }}
        commands={[plan, feedback, goal, todo]}
        decorated={new Set(['feedback'])}
        onRunCommand={run}
        stoppable={false}
        stopDisabled={false}
        onStop={() => {}}
      />
    </main>
  );
}

const input = () => screen.getByLabelText<HTMLTextAreaElement>('要說的話');
const type = (value: string) => fireEvent.change(input(), { target: { value } });
const key = (key: string, init: Record<string, unknown> = {}) =>
  fireEvent.keyDown(input(), { key, ...init });
const options = () =>
  within(screen.getByRole('listbox'))
    .getAllByRole('option')
    .map((option) => option.textContent);
const selected = () =>
  within(screen.getByRole('listbox'))
    .getAllByRole('option')
    .find((option) => option.getAttribute('aria-selected') === 'true');

describe('送出', () => {
  it('Enter 送出，Shift＋Enter 換行，選字中的 Enter 不送', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    type('記一筆');
    key('Enter', { shiftKey: true });
    key('Enter', { isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
    key('Enter');
    expect(onSubmit).toHaveBeenCalledWith('記一筆');
    expect(input().value).toBe('');
  });

  it('送不出去時 Enter 不送、送出鍵按不下去', () => {
    const onSubmit = vi.fn();
    render(<Harness canSend={false} onSubmit={onSubmit} />);
    type('記一筆');
    key('Enter');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '送出' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('`/` 選單', () => {
  it('打 `/` 列出命令，輸入框指著清單與選中的那一項', async () => {
    render(<Harness />);
    expect(screen.queryByRole('listbox')).toBeNull();
    type('/');
    expect(options()).toEqual([
      '/plan [off]進出計劃模式。',
      '/feedback <內容>留一則回饋。',
      '/goal <目標>設定目標。',
      '/todo列出待辦。',
    ]);
    await waitFor(() => {
      expect(input().getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id);
      expect(input().getAttribute('aria-activedescendant')).toBe(selected()?.id);
    });
    expect(selected()?.textContent).toContain('/plan');
  });

  it('打字就篩選排序；方向鍵換選項、繞圈', async () => {
    render(<Harness />);
    type('/g');
    expect(options()).toEqual(['/goal <目標>設定目標。']);
    type('/');
    key('ArrowDown');
    expect(selected()?.textContent).toContain('/feedback');
    key('ArrowUp');
    key('ArrowUp');
    expect(selected()?.textContent).toContain('/todo');
    await waitFor(() => expect(input().getAttribute('aria-activedescendant')).toBe(selected()?.id));
  });

  it('選單開著時 Shift＋Enter 不選（留給換行）', () => {
    const run = vi.fn(() => true);
    render(<Harness run={run} />);
    type('/to');
    key('Enter', { shiftKey: true });
    expect(run).not.toHaveBeenCalled();
    expect(input().value).toBe('/to');
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('Enter 選帶參數的命令：填上 `/名稱 `、不執行、選單收起', () => {
    const run = vi.fn(() => true);
    const onSubmit = vi.fn();
    render(<Harness run={run} onSubmit={onSubmit} />);
    type('/pl');
    key('Enter');
    expect(input().value).toBe('/plan ');
    expect(input().selectionStart).toBe(6);
    expect(run).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Tab 選不帶參數的命令：從草稿拿掉、直接執行', () => {
    const run = vi.fn(() => true);
    render(<Harness run={run} />);
    type('/to');
    key('Tab');
    expect(run).toHaveBeenCalledWith('/todo');
    expect(input().value).toBe('');
  });

  it('有裝飾的 `/feedback` 雖然帶參數，Enter 選到就直接執行（照 dsh：裝飾先判），不是填 `/feedback `', () => {
    const run = vi.fn(() => true);
    render(<Harness run={run} />);
    type('/fe');
    key('Enter');
    expect(run).toHaveBeenCalledWith('/feedback');
    expect(input().value).toBe('');
  });

  it('現在不能執行：那一行留在草稿裡，選單不再跳出來', () => {
    render(<Harness run={() => false} />);
    type('/fe');
    key('Enter');
    expect(input().value).toBe('/feedback');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('點選項也選得到', () => {
    const run = vi.fn(() => true);
    render(<Harness run={run} />);
    type('/');
    fireEvent.click(screen.getByRole('option', { name: /feedback/ }));
    expect(run).toHaveBeenCalledWith('/feedback');
  });

  it('Esc 收起，同一個片段不再自己跳出來；再打一個字才回來。Shift＋Tab 也是收起', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    type('/p');
    key('Escape');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input().value).toBe('/p');
    fireEvent.select(input());
    expect(screen.queryByRole('listbox')).toBeNull();
    type('/pl');
    expect(screen.getByRole('listbox')).toBeTruthy();
    key('Tab', { shiftKey: true });
    expect(screen.queryByRole('listbox')).toBeNull();
    // 刪光重打同一個 `/`：片段中間不見過，收起的記錄作廢，選單回來。
    type('/');
    key('Escape');
    expect(screen.queryByRole('listbox')).toBeNull();
    type('');
    type('/');
    expect(screen.getByRole('listbox')).toBeTruthy();
    type('/pl');
    key('Tab', { shiftKey: true });
    // 收起之後 Enter 就是送出。
    key('Enter');
    expect(onSubmit).toHaveBeenCalledWith('/pl');
  });

  it('句中的 `/` 只列不帶參數的命令；網址不開', () => {
    render(<Harness />);
    type('先記一下 /');
    expect(options()).toEqual(['/todo列出待辦。']);
    type('看 https://example.com/');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('選單開著時過 axe', async () => {
    render(<Harness />);
    type('/');
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
