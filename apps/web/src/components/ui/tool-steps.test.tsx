import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { StepGroup, StepList, StepRow, stepGroupSummary } from '@/components/ui/tool-steps';
import type { Step } from '@/components/ui/tool-steps';

afterEach(cleanup);

/**
 * SG 的 tool-steps（#1682 PR A）。vendor 檔套了四個 patch（README「本地修改」第 56–59 條），包裝層補中文預設字（第 60 條）。
 * 這裡只驗元件本身；接到工具卡與工具段之後的行為在 PR B。畫出來的樣子（執行中不閃、焦點外框、44px、減少動態、疊在清單裡的結果框不 blur）
 * 在 `guard/` 量。
 */

const done: Step = {
  id: 's1',
  label: '讀取 src/App.tsx',
  status: 'done',
  detail: '{"file_path":"src/App.tsx"}',
  output: '第一行\n第二行',
};
const failed: Step = { id: 's2', label: '讀取 nope.ts', status: 'error', error: '沒有這個檔' };
const running: Step = { id: 's3', label: '執行指令 pnpm test', status: 'running' };

describe('包裝層：預設字是中文（第 60 條）', () => {
  test('明細框的標題是「參數」「結果」「錯誤」，DOM 裡沒有 vendor 的英文', () => {
    const { container } = render(
      <>
        <StepRow step={done} />
        <StepRow step={failed} />
      </>,
    );
    for (const button of screen.getAllByRole('button')) fireEvent.click(button);
    expect(screen.getAllByLabelText('參數')).toHaveLength(1);
    expect(screen.getByLabelText('結果').textContent).toBe('第一行\n第二行');
    expect(screen.getByLabelText('錯誤').textContent).toBe('沒有這個檔');
    expect(container.textContent).not.toMatch(/Input|Output|Error/);
  });

  test('呼叫端只給一部分時，其餘照包裝層的', () => {
    render(<StepRow step={done} labels={{ output: '回傳' }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByLabelText('參數')).toBeTruthy();
    expect(screen.getByLabelText('回傳')).toBeTruthy();
  });

  test('群組收著那一列：完成是「N 個工具呼叫」，有一顆在跑接「，執行中」；不是 Ran／Running N steps', () => {
    const { container, rerender } = render(<StepGroup steps={[done, failed]} />);
    expect(screen.getByRole('button', { name: '2 個工具呼叫' })).toBeTruthy();
    rerender(<StepGroup steps={[done, running]} />);
    expect(screen.getByRole('button', { name: '2 個工具呼叫，執行中' })).toBeTruthy();
    expect(container.textContent).not.toMatch(/Ran|Running|steps/);
    expect(stepGroupSummary(3, false)).toBe('3 個工具呼叫');
  });

  test('群組展開後裡面每一列也是中文標題', () => {
    render(<StepGroup steps={[done, failed]} defaultOpen />);
    fireEvent.click(screen.getByRole('button', { name: /讀取 src\/App\.tsx/ }));
    expect(screen.getByLabelText('參數')).toBeTruthy();
    expect(screen.getByLabelText('結果')).toBeTruthy();
  });
});

describe('0017：受控的 open', () => {
  test('StepRow：給 open 就照它展開，點了由 onOpenChange 回報、自己不翻', () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(<StepRow step={done} open onOpenChange={onOpenChange} />);
    const button = screen.getByRole('button');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText('結果')).toBeTruthy();

    fireEvent.click(button);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // 受控：父層沒改 open，就還開著。
    expect(button.getAttribute('aria-expanded')).toBe('true');

    rerender(<StepRow step={done} open={false} onOpenChange={onOpenChange} />);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText('結果')).toBeNull();
  });

  test('StepGroup：同上；父層接住 onOpenChange 就翻得動', () => {
    function Controlled() {
      const [open, setOpen] = useState(false);
      return <StepGroup steps={[done, failed]} open={open} onOpenChange={setOpen} />;
    }
    render(<Controlled />);
    const group = screen.getByRole('button', { name: '2 個工具呼叫' });
    expect(group.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(group);
    expect(group.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /讀取 nope\.ts/ })).toBeTruthy();

    cleanup();
    const onOpenChange = vi.fn();
    render(<StepGroup steps={[done, failed]} open onOpenChange={onOpenChange} />);
    const fixed = screen.getByRole('button', { name: '2 個工具呼叫' });
    fireEvent.click(fixed);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(fixed.getAttribute('aria-expanded')).toBe('true');
  });

  test('沒給 open 時照 vendor 原本自己記', () => {
    render(<StepRow step={done} />);
    const button = screen.getByRole('button');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('0018：trailing 與 children 槽', () => {
  test('trailing 在按鈕裡、接在 label 後面，進按鈕的名稱', () => {
    render(<StepRow step={done} trailing={<span>完成</span>} />);
    const button = screen.getByRole('button', { name: /^讀取 src\/App\.tsx\s*完成$/ });
    expect(within(button).getByText('完成')).toBeTruthy();
  });

  test('children 畫在展開的區塊裡、接在 SG 的明細後面；收著不畫', () => {
    render(
      <StepRow step={done}>
        <p>自己的檢視</p>
      </StepRow>,
    );
    expect(screen.queryByText('自己的檢視')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    const own = screen.getByText('自己的檢視');
    const result = screen.getByLabelText('結果').closest('[data-slot="output-block"]')!;
    // 附加，不取代：SG 的結果框還在，children 排在它後面。
    expect(result.compareDocumentPosition(own) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('有 patch 的列：children 接在 SG 的 DiffView 後面（#1685 B 擴充 patch 分支）', () => {
    render(
      <StepRow step={{ id: 'p', label: '編輯 a.ts', status: 'done', patch: '@@\n-a\n+b' }}>
        <p>手機版的歸屬</p>
      </StepRow>,
    );
    fireEvent.click(screen.getByRole('button'));
    const view = document.querySelector('[data-slot="diff-view"]')!;
    const own = screen.getByText('手機版的歸屬');
    expect(view.compareDocumentPosition(own) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(view.parentElement).toBe(own.parentElement);
  });

  test('只有 children、沒有 detail／output／error 的列也打得開', () => {
    render(
      <StepRow step={{ id: 'x', label: '交付 report.pdf', status: 'done' }}>
        <p>檔案清單</p>
      </StepRow>,
    );
    const button = screen.getByRole('button');
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    expect(screen.getByText('檔案清單')).toBeTruthy();
  });

  test('StepList 給 children 時取代逐步那一列，每一個各包一層', () => {
    const { container } = render(
      <StepList steps={[done, failed]}>
        <p>第一</p>
        <p>第二</p>
      </StepList>,
    );
    const list = container.querySelector('[data-slot="step-list"]')!;
    expect(list.children).toHaveLength(2);
    expect([...list.children].map((child) => child.textContent)).toEqual(['第一', '第二']);
    for (const child of list.children) expect(child.className).toBe('px-2.5 py-1.5');
    expect(list.querySelector('[data-slot="step-row"]')).toBeNull();
  });

  test('StepGroup 的 children 交給展開後的 StepList', () => {
    render(
      <StepGroup steps={[done, failed]} defaultOpen>
        <p>自己的列</p>
      </StepGroup>,
    );
    expect(
      screen.getByText('自己的列').parentElement?.parentElement?.getAttribute('data-slot'),
    ).toBe('step-list');
    expect(screen.queryByRole('button', { name: /讀取 src/ })).toBeNull();
  });
});

describe('0019：結果框聚焦得到、有名稱', () => {
  test('pre 的 tabIndex 是 0，名稱是框的標題', () => {
    render(<StepRow step={done} open />);
    for (const name of ['參數', '結果']) {
      const pre = screen.getByLabelText(name);
      expect(pre.tagName).toBe('PRE');
      expect(pre.tabIndex).toBe(0);
    }
  });
});
