/**
 * nexus 層（#1583）：轉出 vendor 的 solid-glass 版（`vendor/solid-glass/components/ui/dialog.tsx`，Base UI），外觀照 SG（#1468 Q8）。
 * 本地修改登記在 `vendor/solid-glass/README.md` 的「本地修改」；這個檔沒有本地修改。關閉鈕的中文報讀名稱「關閉」是改 vendor 檔
 * （第 20 條，`patches/0002-dialog-close-label.patch`）。
 */
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from '@/vendor/solid-glass/components/ui/dialog';
