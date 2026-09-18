import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { MarkdownText } from '@/components/markdown-text';
import { IncrementalMarkdownParser } from '@/lib/markdown/incremental';
import { parseGfm } from '@/lib/markdown/parse';

/**
 * 自建 markdown（#405）。增量的那幾條照 dsh `ui-primitives/tests/markdown-incremental.client.spec.tsx` 的形狀
 * （本機 clone `ddefc45`）；中文粗體的案例照 dsh `markdown.client.spec.tsx`（它用簡體，這裡換成繁體）。
 */

afterEach(cleanup);

/** 畫面上看得到的：程式碼區塊以外逐字元比；程式碼區塊逐行、逐段比字與顏色。 */
function looks(root: HTMLElement) {
  const clone = root.cloneNode(true) as HTMLElement;
  const blocks = [...clone.querySelectorAll('.md-code')].map((block) => {
    const pre = block.querySelector('pre');
    const lines = pre?.classList.contains('shiki')
      ? [...pre.querySelectorAll('.line')].map((line) =>
          [...line.querySelectorAll<HTMLElement>('span[style]')].map(
            (span) => `${span.textContent ?? ''}|${span.style.color}`,
          ),
        )
      : undefined;
    const summary = {
      lang: block.querySelector('.md-code-lang')?.textContent,
      text: pre?.textContent,
      lines,
    };
    block.replaceChildren();
    return summary;
  });
  return { html: clone.innerHTML, blocks };
}

describe('GFM', () => {
  it('表格、清單、task list、行內 code、刪除線', () => {
    const { container } = render(
      <MarkdownText
        text={[
          '| 名稱 | 大小 |',
          '| :--- | ---: |',
          '| app | 263 kB |',
          '',
          '- 第一項',
          '- 第二項有 `pnpm build`',
          '',
          '1. 先',
          '2. 後',
          '',
          '- [x] 做完了',
          '- [ ] 還沒',
          '',
          '這句~~刪掉~~了。',
        ].join('\n')}
      />,
    );
    const cells = [...container.querySelectorAll('th, td')].map((cell) => cell.textContent);
    expect(cells).toEqual(['名稱', '大小', 'app', '263 kB']);
    expect((container.querySelectorAll('td')[1] as HTMLElement).style.textAlign).toBe('right');
    expect(
      [...container.querySelectorAll('ul:not(.contains-task-list) > li')].map(
        (li) => li.textContent,
      ),
    ).toEqual(['第一項', '第二項有 pnpm build']);
    expect(container.querySelector('li code')?.textContent).toBe('pnpm build');
    expect(container.querySelectorAll('ol > li')).toHaveLength(2);
    const boxes = [...container.querySelectorAll<HTMLInputElement>('.task-list-item input')];
    expect(boxes.map((box) => box.checked)).toEqual([true, false]);
    expect(container.querySelector('del')?.textContent).toBe('刪掉');
  });

  it('程式碼區塊帶語言標籤，內容原字不動', () => {
    const { container } = render(<MarkdownText text={'```ts {1}\nconst a = 1;\n```'} />);
    expect(container.querySelector('.md-code pre')?.textContent).toBe('const a = 1;');
    expect(container.querySelector('.md-code-lang')?.textContent).toBe('ts');
  });
});

describe('中文夾標點的粗體（cjkFriendlyStrong）', () => {
  const cases = [
    ['**注意：**內容', '注意：'],
    ['**Notice:**內容', 'Notice:'],
    ['**事件中介層（waterfall）**實作', '事件中介層（waterfall）'],
    ['**事件中介層(waterfall)**實作', '事件中介層(waterfall)'],
    ['**句號。**後續', '句號。'],
    ['**Period.**後續', 'Period.'],
    ['**提醒！**繼續', '提醒！'],
    ['**Warning!**繼續', 'Warning!'],
  ] as const;

  it.each([false, true])('標點收尾的粗體後面直接接中文也收得起來（串流 %s）', (streaming) => {
    const source = cases.map(([markdown]) => markdown).join('\n\n');
    const { container } = render(<MarkdownText text={source} streaming={streaming} />);
    expect([...container.querySelectorAll('strong')].map((node) => node.textContent)).toEqual(
      cases.map(([, strong]) => strong),
    );
  });

  it('跳脫、code、英文接英文、單星號都不受影響', () => {
    const source = [
      String.raw`\**注意：**內容`,
      '`**注意：**內容`',
      '**Notice:**text',
      '*提醒！*繼續',
      '```md',
      '**注意：**內容',
      '```',
      '**普通**內容',
    ].join('\n\n');
    const { container } = render(<MarkdownText text={source} />);
    expect([...container.querySelectorAll('strong')].map((node) => node.textContent)).toEqual([
      '普通',
    ]);
    expect(container.querySelector('p code')?.textContent).toBe('**注意：**內容');
    expect(container.textContent).toContain('**Notice:**text');
  });
});

describe('輸入不可信', () => {
  it('連結只放行 http／https／mailto，外部的另開分頁、不帶 referrer', () => {
    render(
      <MarkdownText
        text={
          '[安全](https://example.com) [信](mailto:a@example.com) [壞的](javascript:alert(1)) [相對](./x)'
        }
      />,
    );
    const safe = screen.getByRole('link', { name: '安全' });
    expect(safe.getAttribute('target')).toBe('_blank');
    expect(safe.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByRole('link', { name: '信' }).getAttribute('target')).toBeNull();
    expect(screen.queryByRole('link', { name: '壞的' })).toBeNull();
    expect(screen.queryByRole('link', { name: '相對' })).toBeNull();
    expect(screen.getByText(/壞的/)).toBeTruthy();
  });

  it('raw HTML 當文字；圖片不自動載入，畫成連結', () => {
    const { container } = render(
      <MarkdownText
        text={'<img src=x onerror=alert(1)>\n\n![架構圖](https://example.com/a.png)'}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(screen.getByRole('link', { name: '圖片：架構圖' }).getAttribute('href')).toBe(
      'https://example.com/a.png',
    );
  });
});

/**
 * 串流中凍結的 block 與尾段拼起來，每一刻都要跟同一段字重新掛一次一模一樣。定義與引用放在一起：
 * 定義落在凍結邊界另一側時先照原文是已知偏差（見 `markdown-text.tsx`）。
 */
const STREAM_DOC = [
  '# 標題',
  '',
  '第一段有 **粗體**、`code` 和 [連結](https://example.com)。',
  '',
  '- 清單第一項',
  '- 清單第二項',
  '',
  '  第二項的延續',
  '',
  'Setext 標題',
  '===',
  '',
  '| a | b |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '```ts',
  'const x = 1',
  '',
  '還在 fence 裡',
  '```',
  '',
  '> 引用的第一行',
  '延續行',
  '',
  '用了腳註[^n]兩次[^n]。',
  '',
  '[^n]: 腳註本文。',
  '',
  '**注意：**中文粗體接標點。',
  '',
  '最後一段。',
].join('\n');

describe('增量解析', () => {
  it.each([1, 3, 7, 16])(
    '每一個前綴都跟重新掛一次一樣（每次 %i 字）',
    (chunk) => {
      const live = render(<MarkdownText text="" streaming />);
      for (let end = chunk; end < STREAM_DOC.length + chunk; end += chunk) {
        const prefix = STREAM_DOC.slice(0, Math.min(end, STREAM_DOC.length));
        live.rerender(<MarkdownText text={prefix} streaming />);
        const fresh = render(<MarkdownText text={prefix} streaming />);
        expect(live.container.innerHTML).toBe(fresh.container.innerHTML);
        fresh.unmount();
      }
      // 講完換成整份解析，跟直接畫講完的一樣。程式碼區塊講完時留用串流那棵 span 樹，直接畫的是 shiki 的 HTML：
      // 字串不同（style 的空白、外面多一層 div），逐 token 比字與顏色（同 dsh `streaming-code-block` 的比法）。
      live.rerender(<MarkdownText text={STREAM_DOC} />);
      const settled = render(<MarkdownText text={STREAM_DOC} />);
      expect(looks(live.container)).toEqual(looks(settled.container));
      // 逐字那一格每個前綴都重畫兩次：本機約 0.5 秒，CI 跟其他檔並行時約 8 倍（#421 3.1 秒、#422 3.9 秒、
      // #425 5.1 秒撞到預設的 5 秒）。量的是結果不是速度，給足上限。
    },
    30_000,
  );

  it('凍結的 block 跨過邊界時沿用同一個 DOM 節點，不重掛', () => {
    const paragraphs = Array.from({ length: 8 }, (_, i) => `第 ${i} 段。`);
    const live = render(<MarkdownText text={`${paragraphs[0]}\n\n`} streaming />);
    const first = live.container.querySelector('p');
    live.rerender(<MarkdownText text={paragraphs.join('\n\n')} streaming />);
    expect(live.container.querySelector('p')).toBe(first);
    expect(live.container.querySelectorAll('p')).toHaveLength(paragraphs.length);
  });

  it('字不是接在後面而是換掉時，重來而不是拼錯', () => {
    const live = render(<MarkdownText text={'甲\n\n乙\n\n丙\n\n丁'} streaming />);
    live.rerender(<MarkdownText text={'完全\n\n不同的\n\n一份'} streaming />);
    const fresh = render(<MarkdownText text={'完全\n\n不同的\n\n一份'} streaming />);
    expect(live.container.innerHTML).toBe(fresh.container.innerHTML);
  });

  it('不是每個 delta 重解全文：解析過的字數跟全文長度同一個量級', () => {
    const doc = Array.from({ length: 60 }, (_, i) => `第 ${i} 段，講一點東西。`).join('\n\n');
    let parsed = 0;
    const parser = new IncrementalMarkdownParser((text) => {
      parsed += text.length;
      return parseGfm(text);
    });
    let everyDeltaReparses = 0;
    for (let end = 5; end < doc.length + 5; end += 5) {
      const prefix = doc.slice(0, Math.min(end, doc.length));
      parser.update(prefix);
      everyDeltaReparses += prefix.length;
    }
    // 每次重解全文是 O(n²)：這份 888 字、178 次更新是 79,653 字次；只重解尾段實測 5,523（約全文 6 倍）。
    expect(parsed).toBeLessThan(doc.length * 10);
    expect(parsed * 10).toBeLessThan(everyDeltaReparses);
  });

  it('未關閉的 fence 一行一行長時，已完成的行不再重解', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `const v${i} = ${i};`);
    let parsed = 0;
    const parser = new IncrementalMarkdownParser((text) => {
      parsed += text.length;
      return parseGfm(text);
    });
    let source = '```ts\n';
    for (const line of lines) {
      source += `${line}\n`;
      parser.update(source);
    }
    expect(parser.update(source).tail.at(-1)?.node.type).toBe('code');
    expect(parsed).toBeLessThan(source.length * 6);
  });
});

describe('游標', () => {
  it('接在最後一段的字尾；最後一塊是清單時另起一行', () => {
    const caret = <span data-testid="caret" />;
    const paragraph = render(<MarkdownText text={'一段\n\n最後一段'} streaming caret={caret} />);
    expect(paragraph.getByTestId('caret').parentElement?.tagName).toBe('P');
    expect(paragraph.getByTestId('caret').parentElement?.textContent).toBe('最後一段');
    paragraph.unmount();

    const list = render(<MarkdownText text={'- 一\n- 二'} streaming caret={caret} />);
    expect(list.getByTestId('caret').parentElement?.className).toBe('markdown');
  });
});
