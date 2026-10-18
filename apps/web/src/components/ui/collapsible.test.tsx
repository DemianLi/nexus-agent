import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { Surface } from '@/components/surface';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

/**
 * collapsible 換成 SG 的 Base UI 版（#1638 PR A）之後，nexus 依賴的屬性契約。樣式靠這幾個屬性命中：`Chevron` 與思考過程的摘要
 * 跟著 Trigger 的 `data-panel-open`，展開收合的動效跟著 Panel 的 `data-open`／`data-closed`。CSS 有沒有真的命中，jsdom 量不到，
 * 由 `guard/` 量（`?overlay=collapsibles`）。
 */

afterEach(cleanup);

describe('collapsible（Base UI）', () => {
  it('Trigger 只在開著時掛 data-panel-open 與 aria-controls；Root 與 Panel 掛 data-open／data-closed；關著不掛 Panel', () => {
    render(
      <Collapsible data-testid="root">
        <CollapsibleTrigger>展開</CollapsibleTrigger>
        <CollapsibleContent>內容</CollapsibleContent>
      </Collapsible>,
    );
    const trigger = screen.getByRole('button', { name: '展開' });
    const root = screen.getByTestId('root');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.hasAttribute('data-panel-open')).toBe(false);
    expect(trigger.hasAttribute('aria-controls')).toBe(false);
    expect(root.hasAttribute('data-closed')).toBe(true);
    expect(screen.queryByText('內容')).toBeNull();

    fireEvent.click(trigger);
    const panel = screen.getByText('內容');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.hasAttribute('data-panel-open')).toBe(true);
    expect(trigger.getAttribute('aria-controls')).toBe(panel.id);
    expect(root.hasAttribute('data-open')).toBe(true);
    expect(panel.hasAttribute('data-open')).toBe(true);
    expect(panel.getAttribute('data-slot')).toBe('collapsible-content');
  });

  it('Root 用 render 接 Surface：ref 拿到 Surface 那個元素，Surface 的 class 與 Root 的屬性疊在同一個元素上', () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <Collapsible ref={ref} render={<Surface tone="raised" data-testid="card" />}>
        <CollapsibleTrigger>展開</CollapsibleTrigger>
      </Collapsible>,
    );
    const card = screen.getByTestId('card');
    expect(ref.current).toBe(card);
    expect(card.getAttribute('data-slot')).toBe('collapsible');
    expect(card.hasAttribute('data-closed')).toBe(true);
    expect(card.className).toContain('rounded-3xl');
    expect(card.contains(screen.getByRole('button', { name: '展開' }))).toBe(true);
  });
});
