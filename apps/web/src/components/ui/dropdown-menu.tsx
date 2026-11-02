/**
 * nexus 層（#1583）：轉出 vendor 的 solid-glass 版（`vendor/solid-glass/components/ui/dropdown-menu.tsx`，Base UI 的 Menu），
 * 外觀照 SG（#1468 Q8）。只轉出用得到的那幾件：側欄列選單的 Root、Trigger、Content、Item、Separator，加上 vendor 的
 * `ComposerPick`（#1591）用的 RadioGroup、RadioItem、Label——vendor 檔 import 的 `@/components/ui/dropdown-menu` 解析到這一層。
 * 本地修改登記在 `vendor/solid-glass/README.md` 的「本地修改」，這個檔有一條（第 25 條）：
 *
 * - `DropdownMenuItem` 與 `DropdownMenuRadioItem` 的觸控高度：vendor 都是 `py-1`（約 28px），規格 §9 要 1024 以下 44px、以上 32px
 *   （`min-h-11 lg:min-h-8`）。兩個是不同的元件，各包一次（RadioItem 在 #1591 加上）。
 *
 * 跟 Radix 版的用法差異：Item 用 `onClick`（不是 `onSelect`）；Trigger 用 `render`（不是 `asChild`）；關掉時焦點還到哪由
 * Content 的 `finalFocus` 決定（不是 `onCloseAutoFocus`）；Trigger 開著時掛 `data-popup-open`（不是 `data-state="open"`）。
 * SG 的選單沒有進出場動畫（vendor 寫 `animate-none!`）。
 */
import type * as React from 'react';

import { cn } from '@/lib/utils';
import {
  DropdownMenuItem as VendorDropdownMenuItem,
  DropdownMenuRadioItem as VendorDropdownMenuRadioItem,
} from '@/vendor/solid-glass/components/ui/dropdown-menu';

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/vendor/solid-glass/components/ui/dropdown-menu';

function DropdownMenuItem({
  className,
  ...props
}: React.ComponentProps<typeof VendorDropdownMenuItem>) {
  return <VendorDropdownMenuItem className={cn('min-h-11 lg:min-h-8', className)} {...props} />;
}

function DropdownMenuRadioItem({
  className,
  ...props
}: React.ComponentProps<typeof VendorDropdownMenuRadioItem>) {
  return (
    <VendorDropdownMenuRadioItem className={cn('min-h-11 lg:min-h-8', className)} {...props} />
  );
}

export { DropdownMenuItem, DropdownMenuRadioItem };
