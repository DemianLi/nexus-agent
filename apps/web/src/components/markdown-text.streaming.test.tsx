import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { MarkdownText } from '@/components/markdown-text';

/** 元件那一層真的走增量：串流中每個 delta 解析的是尾段，不是全文（#405）。 */

const parsed = vi.hoisted(() => ({ chars: 0 }));

vi.mock('@/lib/markdown/parse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/markdown/parse')>();
  return {
    parseGfm: (text: string) => {
      parsed.chars += text.length;
      return actual.parseGfm(text);
    },
  };
});

afterEach(cleanup);

it('串流中的 MarkdownText 每個 delta 只解析尾段', () => {
  const doc = Array.from({ length: 60 }, (_, i) => `第 ${i} 段，講一點東西。`).join('\n\n');
  const live = render(<MarkdownText text="" streaming />);
  let everyDeltaReparses = 0;
  for (let end = 5; end < doc.length + 5; end += 5) {
    const prefix = doc.slice(0, Math.min(end, doc.length));
    live.rerender(<MarkdownText text={prefix} streaming />);
    everyDeltaReparses += prefix.length;
  }
  expect(parsed.chars * 10).toBeLessThan(everyDeltaReparses);
});
