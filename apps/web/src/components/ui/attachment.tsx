/**
 * nexus 層（#1638 PR C）：轉出 vendor 的 solid-glass 版（`vendor/solid-glass/components/ui/attachment.tsx`），外觀照 SG（#1468 Q8）。
 * 本地修改登記在 `vendor/solid-glass/README.md` 的「本地修改」；這個檔沒有本地修改，覆寫檔那一層有兩條：一排附件在不支援
 * scroll-driven 動畫時不淡出（第 47 條）、亮色時上傳中標題的 shimmer 亮面換成次要字色（第 48 條）。
 *
 * 跟 shadcn registry 版的差異（#1468 Q19 拿掉 #733、#1281 的改動）：字級回到 SG 的 `text-sm`／`text-xs`（`sm`／`xs` 的檔名 12px），
 * 上傳中的標題用 SG 的 `shimmer`（`tw-shimmer`，reduced-motion 停止寫在 utility 裡），一排附件用 SG 的 `scroll-fade-x`、`scrollbar-none`。
 * 外殼的 `focus-within:ring-1` 畫不出來：SG 的玻璃規則（`solid-glass.css:727-735`）在 layer 外寫了外殼的 `box-shadow`，按鈕聚焦時外殼
 * 不出 ring（#1638 Q7 要的結果，PM 同意不加覆寫）；`guard/` 量鍵盤與滑鼠聚焦後外殼的 `box-shadow` 不變。
 */
export {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from '@/vendor/solid-glass/components/ui/attachment';
