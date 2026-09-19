/**
 * 來源：shadcn registry `message-scroller`（style new-york，https://ui.shadcn.com/r/styles/new-york-v4/message-scroller.json），
 * shadcn CLI 4.21.0 `shadcn add message-scroller message bubble dialog sonner --overwrite`。裝進來就是我們的原始碼，
 * 不靠重跑 `shadcn add` 更新。
 * 改過的地方（前兩項照原型 tag `proto-375-design-language`）：
 * - 中文報讀字串（§8）；捲到底的按鈕只淡入＋縮放 .97，時長走 `--duration-*` token（§7）。
 * - 拿掉 `scroll-fade-b`：建置出的 CSS 裡沒有這個 utility（§9），寫著也沒作用。
 * - item 拿掉 `[content-visibility:auto]` 與 `contain-intrinsic-size`：paint containment 會把卡片陰影與光暈切成直角（§9）；
 *   500 則的捲動量測寫在 #404 的 PR。
 * 依賴 `@shadcn/react` 的 primitive：viewport 預設 `role="region"`、content 預設 `role="log"`。
 */
import * as React from 'react';
import {
  MessageScroller as MessageScrollerPrimitive,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from '@shadcn/react/message-scroller';
import { cn } from 'cn';
import { ArrowDownIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';

function MessageScrollerProvider(
  props: React.ComponentProps<typeof MessageScrollerPrimitive.Provider>,
) {
  return <MessageScrollerPrimitive.Provider {...props} />;
}

function MessageScroller({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Root>) {
  return (
    <MessageScrollerPrimitive.Root
      data-slot="message-scroller"
      className={cn(
        'group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden',
        className,
      )}
      {...props}
    />
  );
}

function MessageScrollerViewport({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Viewport>) {
  return (
    <MessageScrollerPrimitive.Viewport
      data-slot="message-scroller-viewport"
      className={cn(
        'size-full min-h-0 min-w-0 scrollbar-thin scrollbar-gutter-stable overflow-y-auto overscroll-contain contain-content data-autoscrolling:scrollbar-none data-pending-scroll:invisible',
        className,
      )}
      {...props}
    />
  );
}

function MessageScrollerContent({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Content>) {
  return (
    <MessageScrollerPrimitive.Content
      data-slot="message-scroller-content"
      className={cn('flex h-max min-h-full flex-col gap-8', className)}
      {...props}
    />
  );
}

function MessageScrollerItem({
  className,
  scrollAnchor = false,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Item>) {
  return (
    <MessageScrollerPrimitive.Item
      data-slot="message-scroller-item"
      scrollAnchor={scrollAnchor}
      className={cn('min-w-0 shrink-0', className)}
      {...props}
    />
  );
}

function MessageScrollerButton({
  direction = 'end',
  className,
  children,
  render,
  variant = 'secondary',
  size = 'icon-sm',
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Button> &
  Pick<React.ComponentProps<typeof Button>, 'variant' | 'size'>) {
  return (
    <MessageScrollerPrimitive.Button
      data-slot="message-scroller-button"
      data-direction={direction}
      data-variant={variant}
      data-size={size}
      direction={direction}
      className={cn(
        'absolute inset-s-1/2 -translate-x-1/2 border-border bg-background text-foreground transition-[scale,opacity] duration-(--duration-fast) ease-(--ease-smooth-out) hover:bg-muted hover:text-foreground data-[active=false]:pointer-events-none data-[active=false]:scale-97 data-[active=false]:opacity-0 data-[active=false]:duration-(--duration-quick) data-[active=true]:scale-100 data-[active=true]:opacity-100 data-[direction=end]:bottom-4 data-[direction=start]:top-4 rtl:translate-x-1/2 data-[direction=start]:[&_svg]:rotate-180',
        className,
      )}
      render={render ?? <Button variant={variant} size={size} />}
      {...props}
    >
      {children ?? (
        <>
          <ArrowDownIcon />
          <span className="sr-only">
            {direction === 'end' ? '捲到最新的訊息' : '捲到最早的訊息'}
          </span>
        </>
      )}
    </MessageScrollerPrimitive.Button>
  );
}

export {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
};
