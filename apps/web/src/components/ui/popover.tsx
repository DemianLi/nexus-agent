/**
 * nexus 層（#1583）：轉出 vendor 的 solid-glass 版（`vendor/solid-glass/components/ui/popover.tsx`，Base UI），外觀照 SG（#1468 Q8）。
 * 本地修改登記在 `vendor/solid-glass/README.md` 的「本地修改」；這個檔沒有本地修改。`PopoverContent` 收 `anchor`（錨在 Trigger 以外的
 * 元素上，例如輸入框的命令選單）是改 vendor 檔（第 19 條，`patches/0001-popover-anchor.patch`）。Base UI 沒有 Radix 的 `PopoverAnchor`。
 */
export {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/vendor/solid-glass/components/ui/popover';
