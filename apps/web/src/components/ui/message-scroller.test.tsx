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
 * message-scroller 換成 SG 版（#1638 PR B）之後，nexus 這邊的兩條本地修改（README 第 41、44 條）與按鈕的 `data-slot`。
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

  it('第 41 條：按鈕的動效照 §7：只淡入＋縮放 .97、不位移，時長與緩動走 token；呼叫端的 class 照樣接得上', () => {
    render(
      <Scroller>
        <MessageScrollerButton className="rounded-full" />
      </Scroller>,
    );
    const classes = (buttons()[0]?.className ?? '').split(/\s+/);
    for (const kept of [
      'transition-[scale,opacity]',
      'duration-(--duration-fast)',
      'data-[active=false]:scale-97',
      'data-[active=false]:duration-(--duration-quick)',
      'data-[active=false]:ease-(--ease-smooth-out)',
      'data-[active=true]:ease-(--ease-smooth-out)',
      'data-[direction=end]:data-[active=false]:translate-y-0',
      'data-[direction=start]:data-[active=false]:translate-y-0',
      'rounded-full',
    ])
      expect(classes).toContain(kept);
    // vendor 那組被蓋掉的值一條都不剩（cn 沒合掉就會兩條並存，誰贏看 CSS 的順序）。
    for (const gone of [
      'transition-[translate,scale,opacity]',
      'duration-200',
      'data-[active=false]:scale-95',
      'data-[active=false]:duration-400',
      'data-[direction=end]:data-[active=false]:translate-y-full',
      'data-[direction=start]:data-[active=false]:-translate-y-full',
    ])
      expect(classes).not.toContain(gone);
    expect(classes.join(' ')).not.toMatch(/cubic-bezier/);
  });
});
