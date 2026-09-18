import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { MarkdownText } from '@/components/markdown-text';
import { mathCompatibility } from '@/lib/markdown/math-compatibility';

/**
 * TeX（#406）。案例照 dsh `ui-primitives/tests/markdown.client.spec.tsx` 與 `markdown-incremental.client.spec.tsx`
 * （本機 clone `ddefc45`）。
 */

afterEach(cleanup);

function count(root: HTMLElement) {
  return {
    math: root.querySelectorAll('.katex').length,
    display: root.querySelectorAll('.katex-display').length,
    error: root.querySelector('.katex-error') !== null,
  };
}

describe('講完的回覆畫 TeX', () => {
  it('行內與區塊都經過 KaTeX，不開 trust：\\href 不變成連結', () => {
    const { container } = render(
      <MarkdownText
        text={[
          'Einstein wrote $E = mc^2$.',
          '',
          '$$',
          '\\frac{\\partial \\mathbf{u}}{\\partial t} + (\\mathbf{u} \\cdot \\nabla)\\mathbf{u} = -\\frac{1}{\\rho}\\nabla p',
          '$$',
          '',
          '$\\href{javascript:alert(1)}{unsafe}$',
        ].join('\n')}
      />,
    );
    expect(count(container)).toEqual({ math: 3, display: 1, error: false });
    // 區塊公式包在可 focus 的捲動層裡（太寬時鍵盤也捲得到）；行內的不包。
    expect(
      [...container.querySelectorAll('.md-math')].map((node) => [
        node.getAttribute('tabindex'),
        node.querySelectorAll('.katex-display').length,
      ]),
    ).toEqual([['0', 1]]);
    expect(container.querySelector('.katex-display annotation')?.textContent).toContain(
      '\\frac{\\partial \\mathbf{u}}',
    );
    expect(container.querySelector('a')).toBeNull();
  });

  it('常見的分隔符：\\( \\)、\\[ \\]、同一行的 $$ 帶 \\tag，表格裡也畫', () => {
    const { container } = render(
      <MarkdownText
        text={[
          'Inline dollar $\\theta$ and backslash \\(\\frac{1}{5}\\).',
          '',
          '\\[\\frac{\\pi}{4} < \\theta < \\frac{\\pi}{2}\\]',
          '',
          '$$\\theta \\in \\left(\\frac{\\pi}{4}, \\frac{\\pi}{2}\\right). \\tag{1}$$',
          '',
          '| Symbol | Value |',
          '| --- | --- |',
          '| $\\theta$ | \\(\\frac{1}{5}\\) |',
        ].join('\n')}
      />,
    );
    expect(count(container)).toEqual({ math: 6, display: 2, error: false });
    expect(container.querySelector('.katex-display annotation')?.textContent).toContain(
      '\\frac{\\pi}{4}',
    );
    expect(
      [...container.querySelectorAll('.katex-display')].at(-1)?.querySelector('annotation')
        ?.textContent,
    ).toContain('\\tag{1}');
    expect(container.querySelector('table .katex')).not.toBeNull();
  });

  it('反斜線分隔符跨過 markdown 邊界、遇到不成形的候選都對', () => {
    const cases: { source: string; math: number; display: number; value?: string }[] = [
      { source: '\\(\\alpha \\, \\beta\\)', math: 1, display: 0 },
      { source: String.raw`\\\(x\)`, math: 1, display: 0, value: 'x' },
      {
        source: '\\(\\frac{1}{5}\n+\\frac{1}{7}\\)',
        math: 1,
        display: 0,
        value: '\\frac{1}{5}\n+\\frac{1}{7}',
      },
      { source: '\\[a\\\\\nb\\]', math: 1, display: 1, value: 'a\\\\\nb' },
      { source: '> \\[\n> \\frac{1}{5}\n> \\]', math: 1, display: 1 },
      { source: '- \\[\n  \\frac{1}{5}\n  \\]', math: 1, display: 1 },
    ];
    for (const item of cases) {
      const rendered = render(<MarkdownText text={item.source} />);
      expect(count(rendered.container), item.source).toEqual({
        math: item.math,
        display: item.display,
        error: false,
      });
      if (item.value !== undefined) {
        expect(rendered.container.querySelector('annotation')?.textContent).toBe(item.value);
      }
      rendered.unmount();
    }

    const literal = render(<MarkdownText text={'\\\\(x\\)\n\n\\[x'} />);
    expect(count(literal.container)).toEqual({ math: 0, display: 0, error: false });
    expect(literal.container.textContent).toContain('[x');
  });

  it('一般的 $$ 區塊照舊，沒寫完的分隔符照原文', () => {
    const cases = [
      { source: '$$\n\\theta\n$$', math: 1, display: 1 },
      { source: '$$$\\theta$$$', math: 1, display: 0 },
      { source: '$$a$b\nc', math: 0, display: 0 },
      { source: '  \\[\n  \\theta\n  \\]', math: 1, display: 1 },
      { source: '\\(\\theta', math: 0, display: 0 },
      { source: String.raw`\(a\\)`, math: 0, display: 0 },
      { source: '\\[\n\\[', math: 0, display: 0 },
      { source: '> \\[\nnot a quoted continuation\n\\]', math: 0, display: 0 },
    ];
    for (const item of cases) {
      const rendered = render(<MarkdownText text={item.source} />);
      expect(count(rendered.container), item.source).toEqual({
        math: item.math,
        display: item.display,
        error: false,
      });
      rendered.unmount();
    }
  });

  it('區塊公式可以打斷還開著的段落', () => {
    for (const source of ['Prose line\n\\[x\\]', 'Prose line\n$$x$$']) {
      const rendered = render(<MarkdownText text={source} />);
      expect(rendered.container.querySelectorAll('p')).toHaveLength(1);
      expect(rendered.container.querySelectorAll('.katex-display')).toHaveLength(1);
      rendered.unmount();
    }
  });

  it('$$ 後面還有字：交給上游當行內公式', () => {
    const { container } = render(<MarkdownText text="$$x$$ trailing" />);
    expect(count(container)).toEqual({ math: 1, display: 0, error: false });
    expect(container.querySelector('annotation')?.textContent).toBe('x');
    expect(container.textContent).toContain('trailing');
  });

  it('跳脫的 $ 與成對的反斜線落在結尾分隔符前', () => {
    const { container } = render(
      <MarkdownText
        text={[String.raw`$$100\$$$`, '', String.raw`\(a\\\)`, '', String.raw`\[b\\\]`].join('\n')}
      />,
    );
    expect([...container.querySelectorAll('annotation')].map((node) => node.textContent)).toEqual([
      String.raw`100\$`,
      String.raw`a\\`,
      String.raw`b\\`,
    ]);
    expect(container.querySelector('.katex-error')).toBeNull();
  });

  it('一長串沒關的 \\( 不會讓回退的工作量爆掉', () => {
    const startedAt = performance.now();
    const { container } = render(<MarkdownText text={'\\(x '.repeat(6_400)} />);
    expect(performance.now() - startedAt).toBeLessThan(3_000);
    expect(container.querySelector('.katex')).toBeNull();
  });

  it('看起來像 TeX 的程式碼區塊照原文', () => {
    const { container } = render(
      <MarkdownText text={'```tex\n\\[\\frac{1}{5}\\]\n$$x \\tag{1}$$\n```'} />,
    );
    expect(container.querySelector('.katex')).toBeNull();
    expect(container.querySelector('.md-code pre')?.textContent).toContain('\\[\\frac{1}{5}\\]');
    expect(container.querySelector('.md-code pre')?.textContent).toContain('$$x \\tag{1}$$');
  });

  it('```math fence 講完時畫成區塊公式', () => {
    const { container } = render(<MarkdownText text={'```math\n\\sqrt{2}\n```'} />);
    expect(count(container)).toEqual({ math: 1, display: 1, error: false });
    expect(container.querySelector('.md-code')).toBeNull();
    expect(container.querySelector('.md-math .katex-display')).not.toBeNull();
  });

  it('寫錯的 TeX：畫 KaTeX 的錯誤，不拋出', () => {
    const { container } = render(<MarkdownText text={'$\\frac{1}{$'} />);
    const error = container.querySelector<HTMLElement>('.katex-error');
    expect(error).not.toBeNull();
    expect(error?.style.color).toBe('var(--destructive)');
  });

  it('數學的延伸語法是一個 micromark extension', () => {
    const extension = mathCompatibility();
    expect(Object.keys(extension)).toEqual(['flow', 'text']);
    expect(mathCompatibility()).toBe(extension);
  });

  it('TeX 裡的中文夾標點粗體不被當成粗體', () => {
    const { container } = render(<MarkdownText text={'$**注意：**內容$'} />);
    expect(container.querySelector('strong')).toBeNull();
    expect(container.querySelector('.katex annotation')?.textContent).toBe('**注意：**內容');
  });
});

describe('串流中不畫 TeX', () => {
  it('寫到一半的公式不閃 KaTeX 的錯誤；講完才畫', () => {
    const partial = '$$\n\\frac{\\partial \\mathbf{u}}{\\partial';
    const complete = '$$\n\\frac{\\partial \\mathbf{u}}{\\partial t}\n$$';
    const live = render(<MarkdownText text={partial} streaming />);
    expect(count(live.container)).toEqual({ math: 0, display: 0, error: false });
    expect(live.container.textContent).toContain('\\frac{\\partial \\mathbf{u}}{\\partial');
    live.rerender(<MarkdownText text={complete} />);
    expect(count(live.container)).toEqual({ math: 1, display: 1, error: false });
  });

  it('```math 串流中照原文，是一般的程式碼區塊', () => {
    const live = render(<MarkdownText text={'```math\n\\sqrt{2}\n```'} streaming />);
    expect(live.container.querySelector('.katex')).toBeNull();
    expect(live.container.querySelector('.md-code pre')?.textContent).toContain('\\sqrt{2}');
  });

  it('講完換成有 TeX 的整份解析，跟直接畫講完的一樣', () => {
    const doc = 'Value $E = mc^2$ inline.\n\nSecond.\n\nThird.\n\nFourth.';
    const live = render(<MarkdownText text={doc} streaming />);
    expect(live.container.querySelector('.katex')).toBeNull();
    live.rerender(<MarkdownText text={doc} />);
    const settled = render(<MarkdownText text={doc} />);
    expect(live.container.innerHTML).toBe(settled.container.innerHTML);
    expect(live.container.querySelector('.katex')).not.toBeNull();
  });
});
