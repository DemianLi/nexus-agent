/**
 * nexus 層（#1583）：轉出 vendor 的 solid-glass 版（`vendor/solid-glass/components/ui/sheet.tsx`，Base UI 的 dialog），外觀照 SG（#1468 Q8）。
 * 本地修改登記在 `vendor/solid-glass/README.md` 的「本地修改」；這個檔沒有本地修改。關閉鈕的中文報讀名稱「關閉」是改 vendor 檔
 * （第 20 條，`patches/0003-sheet-close-label.patch`）；reduced-motion 與放在 sheet 裡的側欄底在覆寫檔（`styles/solid-glass.overrides.css`）。
 */
export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/vendor/solid-glass/components/ui/sheet';
