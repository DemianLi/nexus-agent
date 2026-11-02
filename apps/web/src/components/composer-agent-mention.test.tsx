import type { FileReferenceListOutcome } from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Composer } from '@/components/composer';
import type { MentionAgent } from '@/lib/agent-mention';
import { axeViolations } from '@/test/axe';
import { stubCmdkLayout } from '@/test/cmdk';

/** `@子代理` 提及（#328 第 2 項）：打 `@` 列出、篩選、鍵盤選、插入成標記、一個取代一個、整顆刪掉。 */

beforeEach(stubCmdkLayout);
afterEach(cleanup);

const AGENTS: readonly MentionAgent[] = [
  { id: 'explorer', name: 'explorer', description: '探索程式碼' },
  { id: 'reviewer', name: 'reviewer', description: '審查變更' },
  { id: 'planner', name: 'planner', description: '拆計劃' },
];

function Harness({
  initial = '',
  agents = AGENTS,
  withMention = true,
  onSelect = () => {},
  fileReferences,
}: {
  initial?: string;
  agents?: readonly MentionAgent[];
  withMention?: boolean;
  onSelect?: (agent: MentionAgent | undefined) => void;
  fileReferences?: (query: string, signal: AbortSignal) => Promise<FileReferenceListOutcome>;
}) {
  const [draft, setDraft] = useState(initial);
  const [selected, setSelected] = useState<MentionAgent | undefined>(undefined);
  return (
    <main>
      <Composer
        draft={draft}
        onDraftChange={setDraft}
        placeholder="說點什麼…"
        canSend={draft.trim() !== ''}
        onSubmit={() => {}}
        commands={[]}
        onRunCommand={() => true}
        stoppable={false}
        stopDisabled={false}
        onStop={() => {}}
        {...(fileReferences === undefined ? {} : { fileReferences })}
        {...(withMention
          ? {
              agentMention: {
                agents,
                selected,
                onSelect: (agent: MentionAgent | undefined) => {
                  setSelected(agent);
                  onSelect(agent);
                },
              },
            }
          : {})}
      />
    </main>
  );
}

const input = () => screen.getByLabelText<HTMLTextAreaElement>('要說的話');
const type = (value: string) => fireEvent.change(input(), { target: { value } });
const key = (key: string, init: Record<string, unknown> = {}) =>
  fireEvent.keyDown(input(), { key, ...init });
const menu = () => screen.queryByRole('dialog', { name: '@ 選單' });
const options = () =>
  within(screen.getByRole('listbox'))
    .getAllByRole('option')
    .map((option) => option.textContent);
const selectedOption = () =>
  within(screen.getByRole('listbox'))
    .getAllByRole('option')
    .find((option) => option.getAttribute('aria-selected') === 'true');
const chip = () => screen.queryByTestId('agent-mention-chip');
const openMenu = async (draft = '@') => {
  type(draft);
  await waitFor(() => expect(menu()).not.toBeNull());
};

describe('清單', () => {
  it('打 @ 就列出全部，不需要檔案或會話來源；段標題是「委派給」', async () => {
    render(<Harness />);
    await openMenu();
    expect(
      [...document.querySelectorAll('[cmdk-group-heading]')].map((heading) => heading.textContent),
    ).toEqual(['委派給']);
    expect(options()).toEqual(['explorer探索程式碼', 'reviewer審查變更', 'planner拆計劃']);
  });

  it('接著打的字篩選：名字或說明含有就留，不分大小寫；篩到沒有就收起來', async () => {
    render(<Harness />);
    await openMenu('@REV');
    expect(options()).toEqual(['reviewer審查變更']);
    type('@計劃');
    await waitFor(() => expect(options()).toEqual(['planner拆計劃']));
    type('@沒有這個');
    await waitFor(() => expect(menu()).toBeNull());
  });

  it('沒給 agentMention：@ 就是普通字元，不開選單', () => {
    render(<Harness withMention={false} />);
    type('@');
    expect(menu()).toBeNull();
  });

  it('@/ 與 @" 開頭是路徑，不列子代理；字中間的 @ 不算', async () => {
    render(<Harness />);
    type('@/');
    expect(menu()).toBeNull();
    // 引號形式的查詢（`rev`）本來對得上 reviewer：選單不開才說明是引號把它擋下來的。
    type('@"rev');
    await act(async () => {});
    expect(menu()).toBeNull();
    type('a@b');
    expect(menu()).toBeNull();
  });

  it('跟檔案一起列時，委派給排在最上面', async () => {
    const fileReferences = () =>
      Promise.resolve<FileReferenceListOutcome>({
        kind: 'ok',
        result: { available: true, candidates: [{ path: '/README.md', kind: 'file' }] },
      });
    render(<Harness fileReferences={fileReferences} />);
    type('@');
    await waitFor(() => expect(options()).toHaveLength(4));
    expect(options()).toEqual([
      'explorer探索程式碼',
      'reviewer審查變更',
      'planner拆計劃',
      'README.md',
    ]);
  });

  it('選單開著時過 axe', async () => {
    render(<Harness />);
    await openMenu();
    expect(await axeViolations(document.body)).toEqual([]);
  });
});

describe('選了之後', () => {
  it('Enter 選中目前那一列：@ 那一段從草稿拿掉、標記出現、選單收起；沒轉成文字', async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await openMenu('看一下 @rev');
    key('Enter');
    expect(onSelect).toHaveBeenCalledWith(AGENTS[1]);
    expect(input().value).toBe('看一下 ');
    expect(chip()?.textContent).toBe('@reviewer');
    expect(menu()).toBeNull();
    expect(input().value).not.toContain('reviewer');
  });

  it('上下鍵換列（頭尾相接），Tab 也是選定', async () => {
    render(<Harness />);
    await openMenu();
    expect(selectedOption()?.textContent).toContain('explorer');
    key('ArrowUp');
    expect(selectedOption()?.textContent).toContain('planner');
    key('ArrowDown');
    key('ArrowDown');
    expect(selectedOption()?.textContent).toContain('reviewer');
    key('Tab');
    expect(chip()?.textContent).toBe('@reviewer');
    expect(input().value).toBe('');
  });

  it('點一列也選得到', async () => {
    render(<Harness />);
    await openMenu();
    fireEvent.click(within(screen.getByRole('listbox')).getByText('planner'));
    expect(chip()?.textContent).toBe('@planner');
  });

  it('Esc 收起選單，不選、草稿不動；同一個片段不再自己跳出來', async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await openMenu('@ex');
    key('Escape');
    expect(menu()).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
    expect(input().value).toBe('@ex');
    expect(chip()).toBeNull();
  });

  it('選單開著時 Enter 是選，不是送出', async () => {
    render(<Harness />);
    await openMenu();
    key('Enter');
    expect(chip()).not.toBeNull();
  });

  it('再選一個取代前一個：標記永遠只有一顆；選單上目前選的那一列有勾', async () => {
    render(<Harness />);
    await openMenu();
    key('Enter');
    expect(chip()?.textContent).toBe('@explorer');
    await openMenu('@');
    expect(screen.getAllByLabelText('目前選的')).toHaveLength(1);
    const mark = screen.getByLabelText('目前選的');
    expect(mark.closest('[role="option"]')?.textContent).toContain('explorer');
    key('ArrowDown');
    key('Enter');
    expect(screen.getAllByTestId('agent-mention-chip')).toHaveLength(1);
    expect(chip()?.textContent).toBe('@planner'.replace('planner', 'reviewer'));
  });
});

describe('刪掉', () => {
  async function selectFirst() {
    await openMenu();
    key('Enter');
    expect(chip()).not.toBeNull();
  }

  it('點 ×：整顆刪掉，通知取消', async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await selectFirst();
    fireEvent.click(screen.getByRole('button', { name: '取消委派給 explorer' }));
    expect(chip()).toBeNull();
    expect(onSelect).toHaveBeenLastCalledWith(undefined);
  });

  it('游標在最前面按退格：整顆刪掉，草稿不動', async () => {
    render(<Harness initial="" />);
    await selectFirst();
    type('已經打了字');
    act(() => input().setSelectionRange(0, 0));
    key('Backspace');
    expect(chip()).toBeNull();
    expect(input().value).toBe('已經打了字');
  });

  it('游標不在最前面、或選了一段字時退格歸輸入框：標記留著', async () => {
    render(<Harness />);
    await selectFirst();
    type('已經打了字');
    act(() => input().setSelectionRange(2, 2));
    key('Backspace');
    expect(chip()).not.toBeNull();
    act(() => input().setSelectionRange(0, 3));
    key('Backspace');
    expect(chip()).not.toBeNull();
  });

  it('沒有標記時游標在最前面按退格什麼都不發生', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} initial="字" />);
    act(() => input().setSelectionRange(0, 0));
    key('Backspace');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('標記過 axe', async () => {
    render(<Harness />);
    await selectFirst();
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
