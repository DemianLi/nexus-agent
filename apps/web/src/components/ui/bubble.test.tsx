import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Bubble, BubbleContent } from '@/components/ui/bubble';

/** bubble 換成 SG 版（#1638 PR B，Base UI 的 `useRender`）之後，呼叫端依賴的兩件事。 */

afterEach(cleanup);

describe('bubble（SG 版）', () => {
  it('呼叫端給的 text-body 蓋掉 vendor 的 text-sm（transcript、chat-bubble 都靠這個維持 14/23）', () => {
    render(
      <Bubble variant="ghost">
        <BubbleContent className="text-body">回覆</BubbleContent>
      </Bubble>,
    );
    const content = screen.getByText('回覆');
    expect(content.getAttribute('data-slot')).toBe('bubble-content');
    const classes = content.className.split(/\s+/);
    expect(classes).toContain('text-body');
    expect(classes).not.toContain('text-sm');
  });

  it('asChild 改成 render：換成別的元素時 data-slot 與 class 照樣合進去', () => {
    render(
      <Bubble>
        <BubbleContent render={<button type="button" />}>可以點</BubbleContent>
      </Bubble>,
    );
    const button = screen.getByRole('button', { name: '可以點' });
    expect(button.getAttribute('data-slot')).toBe('bubble-content');
    expect(button.className).toMatch(/\brounded-xl\b/);
  });
});
