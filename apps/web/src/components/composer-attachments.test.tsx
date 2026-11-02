import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Composer } from '@/components/composer';
import type { ComposerAttachments, DraftAttachment } from '@/lib/attachments';
import { useDraftAttachments } from '@/lib/use-draft-attachments';
import { axeViolations } from '@/test/axe';
import { stubCmdkLayout } from '@/test/cmdk';

/** 輸入框的草稿附件（#733）：四個入口（加入鈕、貼上、整頁拖放、附件列）都只在給了 `attachments` 時才有。 */

beforeEach(() => {
  stubCmdkLayout();
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

const png = (name = 'shot.png') => new File(['x'.repeat(2048)], name, { type: 'image/png' });
const pdf = (name = 'plan.pdf') =>
  new File(['x'.repeat(12_595)], name, { type: 'application/pdf' });

function Host({
  supported = true,
  spy,
}: {
  supported?: boolean;
  spy?: { onAdd?: (files: File[]) => void };
}) {
  const [draft, setDraft] = useState('');
  const store = useDraftAttachments();
  const attachments: ComposerAttachments = {
    items: store.items,
    onAdd: (files) => {
      spy?.onAdd?.(files);
      store.add(files);
    },
    onRemove: store.remove,
  };
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
        {...(supported ? { attachments } : {})}
      />
    </main>
  );
}

const textarea = () => screen.getByLabelText<HTMLTextAreaElement>('要說的話');
const chips = () => screen.queryAllByTestId('draft-attachment');

/** `dragenter`／`drop` 的 `dataTransfer`：jsdom 沒有 DataTransfer，只給 Composer 讀的那兩格。 */
const dragData = (types: string[], files: File[] = []) => ({ dataTransfer: { types, files } });

describe('伺服器不收附件（沒給 attachments）：四個入口都不存在', () => {
  it('沒有加入鈕、沒有檔案輸入', () => {
    render(<Host supported={false} />);
    expect(screen.queryByRole('button', { name: '加入附件' })).toBeNull();
    expect(screen.queryByTestId('attachment-input')).toBeNull();
  });

  it('貼上檔案：照瀏覽器本來的行為（不攔、不產生附件）', () => {
    const spy = { onAdd: vi.fn() };
    render(<Host supported={false} spy={spy} />);
    const proceeded = fireEvent.paste(textarea(), {
      clipboardData: { files: [png()], types: ['Files'], getData: () => '' },
    });
    expect(proceeded).toBe(true);
    expect(spy.onAdd).not.toHaveBeenCalled();
    expect(chips()).toHaveLength(0);
  });

  it('把檔案拖進視窗：不出提示、不吞 drop、不產生附件', () => {
    const spy = { onAdd: vi.fn() };
    render(<Host supported={false} spy={spy} />);
    fireEvent.dragEnter(window, dragData(['Files']));
    expect(screen.queryByTestId('drop-overlay')).toBeNull();
    const proceeded = fireEvent.drop(window, dragData(['Files'], [pdf()]));
    expect(proceeded).toBe(true);
    expect(spy.onAdd).not.toHaveBeenCalled();
    expect(chips()).toHaveLength(0);
  });
});

describe('伺服器收附件', () => {
  it('加入鈕開檔案選擇；選了檔案就排進附件列，同一個檔案能再選一次', () => {
    render(<Host />);
    const clicked = vi.fn();
    const picker = screen.getByTestId<HTMLInputElement>('attachment-input');
    picker.addEventListener('click', clicked);
    fireEvent.click(screen.getByRole('button', { name: '加入附件' }));
    expect(clicked).toHaveBeenCalledTimes(1);
    // 選完要把 input 清空，不然同一個檔案選第二次不會觸發 change（jsdom 看不到清空的結果，只能盯住寫入）。
    const written: string[] = [];
    Object.defineProperty(picker, 'value', {
      configurable: true,
      set: (v: string) => written.push(v),
      get: () => '',
    });
    fireEvent.change(picker, { target: { files: [pdf()] } });
    expect(chips()).toHaveLength(1);
    expect(written).toEqual(['']);
  });

  it('貼上檔案：收成附件、不貼文字；貼純文字不攔', () => {
    render(<Host />);
    const pasted = fireEvent.paste(textarea(), {
      clipboardData: { files: [png()], types: ['Files'], getData: () => '' },
    });
    expect(pasted).toBe(false);
    expect(chips()).toHaveLength(1);
    const textOnly = fireEvent.paste(textarea(), {
      clipboardData: { files: [], types: ['text/plain'], getData: () => 'hi' },
    });
    expect(textOnly).toBe(true);
    expect(chips()).toHaveLength(1);
  });

  it('整頁拖放：拖檔案進來出提示，放開收成附件並收掉提示；拖文字不出提示也不吞', () => {
    render(<Host />);
    fireEvent.dragEnter(window, dragData(['text/plain']));
    expect(screen.queryByTestId('drop-overlay')).toBeNull();
    expect(fireEvent.drop(window, dragData(['text/plain']))).toBe(true);

    fireEvent.dragEnter(window, dragData(['Files']));
    expect(screen.getByTestId('drop-overlay')).toBeTruthy();
    expect(fireEvent.dragOver(window, dragData(['Files']))).toBe(false);
    act(() => {
      fireEvent.drop(window, dragData(['Files'], [pdf(), png()]));
    });
    expect(screen.queryByTestId('drop-overlay')).toBeNull();
    expect(chips()).toHaveLength(2);
  });

  it('拖進子元素再離開不算離開視窗（進出各算一次，歸零才收提示）', () => {
    render(<Host />);
    fireEvent.dragEnter(window, dragData(['Files']));
    fireEvent.dragEnter(window, dragData(['Files']));
    fireEvent.dragLeave(window, dragData(['Files']));
    expect(screen.getByTestId('drop-overlay')).toBeTruthy();
    fireEvent.dragLeave(window, dragData(['Files']));
    expect(screen.queryByTestId('drop-overlay')).toBeNull();
  });

  it('提示層不收指標事件（放開檔案的是 window 上的 drop）', () => {
    render(<Host />);
    fireEvent.dragEnter(window, dragData(['Files']));
    expect(screen.getByTestId('drop-overlay').className).toContain('pointer-events-none');
  });
});

describe('附件列', () => {
  it('圖畫縮圖、檔案畫檔名與「副檔名 · 大小」；照加入的順序', () => {
    render(<Host />);
    fireEvent.paste(textarea(), {
      clipboardData: {
        files: [pdf('plan.pdf'), png('shot.png')],
        types: ['Files'],
        getData: () => '',
      },
    });
    const [first, second] = chips();
    expect(first?.getAttribute('data-kind')).toBe('file');
    expect(within(first!).getByText('plan.pdf')).toBeTruthy();
    expect(within(first!).getByText('PDF · 12.3 KB')).toBeTruthy();
    expect(second?.getAttribute('data-kind')).toBe('image');
    expect(within(second!).getByText('PNG · 2.0 KB')).toBeTruthy();
    expect(second?.querySelector('img')?.getAttribute('src')).toBe('blob:preview');
  });

  it('移除鈕：該張消失並 revoke 預覽網址，其他留著；沒有附件時整列不畫', () => {
    render(<Host />);
    expect(screen.queryByTestId('attachment-rail')).toBeNull();
    fireEvent.paste(textarea(), {
      clipboardData: { files: [png('a.png'), pdf('b.pdf')], types: ['Files'], getData: () => '' },
    });
    fireEvent.click(screen.getByRole('button', { name: '移除 a.png' }));
    expect(chips()).toHaveLength(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
    fireEvent.click(screen.getByRole('button', { name: '移除 b.pdf' }));
    expect(screen.queryByTestId('attachment-rail')).toBeNull();
  });

  it('移除鈕手機上（沒有 hover 的裝置）一直看得到，滑鼠才在移上去時才顯示', () => {
    render(<Host />);
    fireEvent.paste(textarea(), {
      clipboardData: { files: [pdf()], types: ['Files'], getData: () => '' },
    });
    const className = screen.getByRole('button', { name: '移除 plan.pdf' }).className;
    expect(className).toContain('[@media(hover:none)]:opacity-100');
    expect(className).toContain('group-hover/attachment:opacity-100');
    expect(className).toContain('focus-visible:opacity-100');
  });

  it('點圖的縮圖開原圖，關掉後回到輸入框', () => {
    render(<Host />);
    fireEvent.paste(textarea(), {
      clipboardData: { files: [png('shot.png')], types: ['Files'], getData: () => '' },
    });
    fireEvent.click(screen.getByRole('button', { name: '看原圖：shot.png' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('img', { name: 'shot.png' })).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('過 axe（有一張圖、一個檔案）', async () => {
    const { container } = render(<Host />);
    fireEvent.paste(textarea(), {
      clipboardData: { files: [png(), pdf()], types: ['Files'], getData: () => '' },
    });
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe('Composer 本身不碰附件的內容', () => {
  it('草稿附件由呼叫端持有：給什麼畫什麼', () => {
    const items: DraftAttachment[] = [{ id: 'x', file: pdf('given.pdf'), kind: 'file' }];
    render(
      <Composer
        draft=""
        onDraftChange={() => {}}
        placeholder=""
        canSend={false}
        onSubmit={() => {}}
        commands={[]}
        onRunCommand={() => true}
        stoppable={false}
        stopDisabled={false}
        onStop={() => {}}
        attachments={{ items, onAdd: () => {}, onRemove: () => {} }}
      />,
    );
    expect(screen.getByText('given.pdf')).toBeTruthy();
  });
});
