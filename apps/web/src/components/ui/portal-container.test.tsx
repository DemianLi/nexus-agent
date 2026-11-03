import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test } from 'vitest';

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { PortalContainerContext } from '@/lib/portal-container';

/**
 * 浮層掛在 `PortalContainerContext` 給的節點上（README 本地修改第 82 條，patch `0025-dialog-portal-container`、
 * `0026-popover-portal-container`、`0027-tooltip-portal-container`）：嵌入版的 `<nexus-chat>` 在 Shadow DOM 裡，掛到 body 就吃不到樣式。
 * 沒給就是 Base UI 的預設 body，獨立頁面不變。
 */

afterEach(cleanup);

const OVERLAYS: readonly (readonly [string, string, () => ReactNode])[] = [
  [
    'dialog',
    'dialog-content',
    () => (
      <Dialog defaultOpen>
        <DialogContent>
          <DialogTitle>標題</DialogTitle>
        </DialogContent>
      </Dialog>
    ),
  ],
  [
    'popover',
    'popover-content',
    () => (
      <Popover defaultOpen>
        <PopoverTrigger render={<button type="button">開</button>} />
        <PopoverContent>內容</PopoverContent>
      </Popover>
    ),
  ],
  [
    'tooltip',
    'tooltip-content',
    () => (
      <TooltipProvider>
        <Tooltip defaultOpen>
          <TooltipTrigger render={<button type="button" aria-label="設定" />} />
          <TooltipContent>設定</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    ),
  ],
];

describe.each(OVERLAYS)('%s 的掛載點', (_name, slot, overlay) => {
  test('有給節點就掛在那裡', () => {
    const container = document.createElement('div');
    document.body.append(container);
    render(
      <PortalContainerContext.Provider value={container}>
        {overlay()}
      </PortalContainerContext.Provider>,
    );
    const popup = document.querySelector(`[data-slot="${slot}"]`);
    expect(popup).not.toBeNull();
    expect(container.contains(popup)).toBe(true);
    container.remove();
  });

  test('沒給就掛在 body，不在渲染的那棵樹裡', () => {
    const { container } = render(overlay());
    const popup = document.querySelector(`[data-slot="${slot}"]`);
    expect(popup).not.toBeNull();
    expect(container.contains(popup)).toBe(false);
  });
});
