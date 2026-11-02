import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller';

/**
 * message-scroller 換成 SG 版（#1638 PR B）之後，nexus 這邊的本地修改（README 第 44 條；第 41 條 #1687 撤掉）與按鈕的 `data-slot`。
 * CSS 有沒有真的命中（計算後的 transition、transform、content-visibility）jsdom 量不到，由 `guard/` 量（`?overlay=messages`）。
 */

afterEach(cleanup);

function Scroller({ children }: { children?: ReactNode }) {
  return (
    <MessageScrollerProvider>
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="a">第一則</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        {children}
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

const buttons = () => [...document.querySelectorAll<HTMLElement>('[data-direction]')];

describe('message-scroller（SG 版）', () => {
  it('第 44 條：呼叫端沒給 children 時，兩個方向的報讀名稱都是中文（patch 0009）', () => {
    // 產品的 transcript 自己給了 children，擋不住 patch 被拿掉；這裡刻意不給，吃的是 vendor 的預設內容。
    render(
      <Scroller>
        <MessageScrollerButton />
        <MessageScrollerButton direction="start" />
      </Scroller>,
    );
    const [end, start] = buttons();
    expect(end?.textContent).toBe('捲到最新的訊息');
    expect(start?.textContent).toBe('捲到最早的訊息');
    expect(document.body.textContent).not.toMatch(/Scroll to/);
  });

  it('按鈕合併 render 的 Button 之後，data-slot 仍是 message-scroller-button（reduced-motion 與避讓都靠它）', () => {
    render(
      <Scroller>
        <MessageScrollerButton />
      </Scroller>,
    );
    const [button] = buttons();
    expect(button?.tagName).toBe('BUTTON');
    expect(button?.getAttribute('data-slot')).toBe('message-scroller-button');
  });

  it('第 41 條已撤（#1687）：按鈕的 class 就是 vendor 原樣，呼叫端的 class 照樣接得上', async () => {
    const [vendor, nexus] = await Promise.all([
      import('@/vendor/solid-glass/components/ui/message-scroller'),
      import('@/components/ui/message-scroller'),
    ]);
    // 包裝層拿掉：轉出的就是 vendor 那一顆，`SCROLL_BUTTON_MOTION` 不再存在。
    expect(nexus.MessageScrollerButton).toBe(vendor.MessageScrollerButton);
    expect(Object.keys(nexus)).not.toContain('SCROLL_BUTTON_MOTION');
    render(
      <Scroller>
        <MessageScrollerButton className="rounded-full" />
      </Scroller>,
    );
    const classes = (buttons()[0]?.className ?? '').split(/\s+/);
    for (const kept of [
      'transition-[translate,scale,opacity]',
      'duration-200',
      'data-[active=false]:scale-95',
      'data-[active=false]:duration-400',
      'data-[direction=end]:data-[active=false]:translate-y-full',
      'data-[direction=start]:data-[active=false]:-translate-y-full',
      'rounded-full',
    ])
      expect(classes).toContain(kept);
    for (const gone of ['transition-[scale,opacity]', 'data-[active=false]:scale-97'])
      expect(classes).not.toContain(gone);
    expect(classes.join(' ')).not.toMatch(/--duration-|--ease-/);
  });
});
