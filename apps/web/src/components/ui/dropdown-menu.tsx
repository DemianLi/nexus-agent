/**
 * 來源：shadcn registry `dropdown-menu`（style new-york，https://ui.shadcn.com/r/styles/new-york-v4/dropdown-menu.json）。
 * 裝進來就是我們的原始碼，不靠重跑 `shadcn add` 更新；只留側欄列選單用得到的那幾件（Root、Trigger、Content、Item、
 * Separator），checkbox／radio／sub／shortcut 沒用到就沒帶。
 * 改過的地方：同 popover——border＋`shadow-md` 換成 `shadow-menu`、容器圓角 `rounded-2xl`（§5）；字級走階梯
 * （`text-body`，不用 `text-sm`）；動效照 §7 的浮層彈出：開 250 縮放 .97、關 150 縮放 .99，拿掉 slide。
 */
import * as React from 'react';
import { cn } from '@/lib/utils';
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';

function DropdownMenu({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuTrigger({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-40 origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-2xl bg-popover p-1 text-popover-foreground shadow-menu data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-99 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-97',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuItem({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  variant?: 'default' | 'destructive';
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      className={cn(
        "relative flex min-h-11 cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-body outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-60 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 lg:min-h-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn('-mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
};
