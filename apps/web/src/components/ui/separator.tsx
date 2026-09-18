/**
 * 來源：shadcn registry `separator`（style new-york，https://ui.shadcn.com/r/styles/new-york-v4/separator.json），
 * shadcn CLI 4.21.0 `shadcn add sidebar sheet --overwrite`。裝進來就是我們的原始碼，不靠重跑 `shadcn add` 更新。
 * 沒有改動（只拿掉 `'use client'`）。
 */
import * as React from 'react';
import { cn } from 'cn';
import { Separator as SeparatorPrimitive } from 'radix-ui';

function Separator({
  className,
  orientation = 'horizontal',
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        'shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px',
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
