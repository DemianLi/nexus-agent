/**
 * 來源：shadcn registry `popover`（style new-york，https://ui.shadcn.com/r/styles/new-york-v4/popover.json），
 * shadcn CLI 4.21.0 `shadcn add input-group textarea command popover --overwrite`。裝進來就是我們的原始碼，
 * 不靠重跑 `shadcn add` 更新。
 * 改過的地方：border＋`shadow-md` 換成 `shadow-menu`、圓角 `rounded-2xl`（§5，同 dialog）；動效照 §7 的浮層彈出：
 * 開 250 縮放 .97、關 150 縮放 .99（時長來自 `index.css` 的 `--animate-in`／`--animate-out`），拿掉 slide。
 */
import * as React from 'react';
import { cn } from 'cn';
import { Popover as PopoverPrimitive } from 'radix-ui';

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className,
  align = 'center',
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-2xl bg-popover p-4 text-popover-foreground shadow-menu outline-hidden data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-99 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-97',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

function PopoverHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="popover-header"
      className={cn('flex flex-col gap-1 text-sm', className)}
      {...props}
    />
  );
}

function PopoverTitle({ className, ...props }: React.ComponentProps<'h2'>) {
  return <div data-slot="popover-title" className={cn('font-medium', className)} {...props} />;
}

function PopoverDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="popover-description"
      className={cn('text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverAnchor,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
};
