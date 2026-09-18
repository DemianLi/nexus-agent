import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { CodeBlock } from '@/components/markdown/code-block';
import { StreamingHighlightSession, supportsHighlighting } from '@/lib/markdown/highlight';

/**
 * 程式碼高亮（#406）。案例照 dsh `ui-primitives/tests/streaming-code-block.client.spec.tsx` 與
 * `code-block.client.spec.tsx`（本機 clone `ddefc45`）。
 */

afterEach(cleanup);

/** 一臂畫出來的 token 樹：字＋shiki 會給的每一種 style，兩臂相等＝看起來一樣。 */
function readPre(root: HTMLElement) {
  const pre = root.querySelector('pre.shiki');
  expect(pre).not.toBeNull();
  return {
    classes: [...(pre?.classList ?? [])].sort().join(' '),
    tabIndex: pre?.getAttribute('tabindex'),
    text: pre?.textContent,
    lines: [...(pre?.querySelectorAll('.line') ?? [])].map((line) =>
      [...line.querySelectorAll<HTMLElement>('span[style]')].map(
        ({ textContent, style }) =>
          `${textContent ?? ''}|${style.color}|${style.fontStyle}|${style.fontWeight}|${style.textDecoration}`,
      ),
    ),
  };
}

describe('StreamingHighlightSession', () => {
  it('字原樣拼得回來，顏色都走 --shiki-*', () => {
    const code = 'const a = 1\n// note\nconst b = "x"';
    const lines = new StreamingHighlightSession().update(code, 'ts');
    expect(lines?.map((line) => line.map((span) => span.text).join('')).join('\n')).toBe(code);
    expect(lines?.[0]?.[0]).toEqual({
      text: 'const',
      style: { color: 'var(--shiki-token-keyword)' },
    });
    expect(lines?.[1]?.[0]?.style.color).toBe('var(--shiki-token-comment)');
  });

  it('一個字一個字長，每個前綴都跟從頭算一樣（含跨行的 template）', () => {
    const code = 'const s = `template\nline ${x} mid\n` // done\nconst t: number = 42';
    const session = new StreamingHighlightSession();
    for (let end = 1; end <= code.length; end++) {
      const slice = code.slice(0, end);
      expect(session.update(slice, 'ts')).toEqual(
        new StreamingHighlightSession().update(slice, 'ts'),
      );
    }
  });

  it('完成的行留同一個陣列，只重算最後一行', () => {
    const session = new StreamingHighlightSession();
    const first = session.update('const a = 1\nlet', 'ts');
    const second = session.update('const a = 1\nlet b = 2', 'ts');
    expect(second?.[0]).toBe(first?.[0]);
    expect(second?.[1]).not.toBe(first?.[1]);
  });

  it('不是接在後面的字就從頭來', () => {
    const session = new StreamingHighlightSession();
    session.update('const a = 1\nconst b = 2\n', 'ts');
    expect(session.update('let z = 0\n', 'ts')).toEqual(
      new StreamingHighlightSession().update('let z = 0\n', 'ts'),
    );
  });
});

describe('認得哪些語言', () => {
  it('fence 的 info string 是模型寫的：物件原型上的名字查不到，也不會炸', () => {
    for (const lang of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(supportsHighlighting(lang)).toBe(false);
      const { container } = render(<CodeBlock code="x" lang={lang} streaming={false} />);
      expect(container.querySelector('pre.shiki')).toBeNull();
      expect(container.querySelector('pre')?.textContent).toBe('x');
      cleanup();
    }
  });

  it('沒有語言、不認得的語言：純文字', () => {
    for (const lang of [undefined, 'brainfuck']) {
      const { container } = render(<CodeBlock code="a < b" lang={lang} streaming={false} />);
      expect(container.querySelector('pre.shiki')).toBeNull();
      expect(container.querySelector('pre')?.textContent).toBe('a < b');
      cleanup();
    }
  });

  it('js／bash／json 開機就載，大小寫與別名都認', () => {
    for (const lang of ['JS', 'tsx', 'sh', 'zsh', 'jsonc']) {
      const { container } = render(<CodeBlock code="x" lang={lang} streaming={false} />);
      expect(container.querySelector('pre.shiki')).not.toBeNull();
      cleanup();
    }
  });

  it('其他語言用到才載：先純文字，文法到了換成高亮', async () => {
    const { container } = render(
      <CodeBlock code={'def f():\n    return 1'} lang="py" streaming={false} />,
    );
    expect(container.querySelector('pre.shiki')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toBe('def f():\n    return 1');
    await waitFor(() => {
      expect(container.querySelector('pre.shiki')).not.toBeNull();
    });
    expect(container.querySelector('pre')?.textContent).toBe('def f():\n    return 1');
  });
});

describe('CodeBlock 的三臂', () => {
  const code = 'const a = 1\n// note\nfunction f(x: number) {\n  return `v${x}`\n}';

  it('串流那一臂跟講完的 shiki HTML 畫出同一棵 token 樹', () => {
    const streamed = render(<CodeBlock code={code} lang="ts" streaming />);
    const settled = render(<CodeBlock code={code} lang="ts" streaming={false} />);
    expect(readPre(streamed.container)).toEqual(readPre(settled.container));
  });

  it('長大時，完成的行留同一個 DOM 節點', () => {
    const live = render(<CodeBlock code={'const a = 1\nlet'} lang="ts" streaming />);
    const firstLine = live.container.querySelector('.line');
    live.rerender(<CodeBlock code={'const a = 1\nlet b = 2\nlet c = 3'} lang="ts" streaming />);
    expect(live.container.querySelector('.line')).toBe(firstLine);
    expect(live.container.querySelectorAll('.line')).toHaveLength(3);
  });

  it('超過一組（32 行）的長 fence 也一行對一行', () => {
    const lines = Array.from({ length: 70 }, (_, i) => `const v${i} = ${i};`);
    const live = render(<CodeBlock code="" lang="ts" streaming />);
    let source = '';
    for (const line of lines) {
      source += `${line}\n`;
      live.rerender(<CodeBlock code={source} lang="ts" streaming />);
    }
    const fresh = render(<CodeBlock code={source} lang="ts" streaming={false} />);
    expect(readPre(live.container)).toEqual(readPre(fresh.container));
  });

  it('講完時字沒變就留用串流那一棵，不重掛', () => {
    const live = render(<CodeBlock code={code} lang="ts" streaming />);
    const pre = live.container.querySelector('pre');
    live.rerender(<CodeBlock code={code} lang="ts" streaming={false} />);
    expect(live.container.querySelector('pre')).toBe(pre);
  });
});
