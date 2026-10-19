import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { MarkdownText } from '@/components/markdown-text';
import { Reasoning } from '@/components/ui/reasoning';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * SG 的 Reasoning（#1683）。vendor 檔套了兩個 patch（README「本地修改」第 67、68 條），包裝層補中文預設字（第 69 條）。
 * 這裡只驗元件本身；接到推理列之後的行為在 `components/reasoning-row.test.tsx`，畫出來的樣子（箭頭、44px、減少動態、
 * shimmer、`white-space`）在 `guard/` 量。
 */

const MARKDOWN = '**粗**的字\n\n- 一\n- 二\n\n```\nconst a = 1\n```\n';

describe('包裝層：預設字是中文（第 69 條）', () => {
  test('講完是「思考過程」、還在想是「思考中」，DOM 裡沒有 vendor 的英文', () => {
    const { container } = render(
      <>
        <Reasoning>想好了</Reasoning>
        <Reasoning thinking>還在想</Reasoning>
      </>,
    );
    const titles = [...container.querySelectorAll('summary > span')].map((s) => s.textContent);
    expect(titles).toEqual(['思考過程', '思考中']);
    expect(container.textContent).not.toMatch(/Thought process|Thinking/);
  });

  test('呼叫端給了就照用', () => {
    const { container } = render(<Reasoning label="推理">想好了</Reasoning>);
    expect(container.querySelector('summary > span')?.textContent).toBe('推理');
  });
});

describe('0020：內文收節點、外層是 div', () => {
  test('交 markdown 節點進去：DOM 裡有 strong、ul、pre，沒有字面的 **；沒有巢狀不合法的警告', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(
      <Reasoning defaultOpen>
        <MarkdownText text={MARKDOWN} />
      </Reasoning>,
    );
    const body = container.querySelector('details > div')!;
    expect(body.querySelector('strong')?.textContent).toBe('粗');
    expect(body.querySelectorAll('ul > li')).toHaveLength(2);
    expect(body.querySelector('pre')?.textContent).toContain('const a = 1');
    expect(body.textContent).not.toContain('**');
    // vendor 原本是 `<p>`：段落、清單、程式碼區塊放進去，React 會報 validateDOMNesting。
    expect(error.mock.calls.flat().join('\n')).not.toMatch(
      /cannot be a descendant|cannot contain a nested/,
    );
  });
});

describe('0021：summary 裡的 trailing', () => {
  test('trailing 在 summary 裡、標題後面、箭頭前面', () => {
    const { container } = render(
      <Reasoning trailing={<span data-testid="tail">· 摘要</span>}>想好了</Reasoning>,
    );
    const summary = container.querySelector('summary')!;
    const children = [...summary.children];
    const tail = summary.querySelector('[data-testid="tail"]');
    expect(tail).not.toBeNull();
    expect(children.indexOf(tail!)).toBe(1);
    expect(children[2]?.tagName.toLowerCase()).toBe('svg');
  });
});
