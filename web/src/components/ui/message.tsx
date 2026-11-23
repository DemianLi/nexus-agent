/**
 * nexus 層（#1638 PR B）：轉出 vendor 的 solid-glass 版（`vendor/solid-glass/components/ui/message.tsx`），外觀照 SG（#1468 Q8）。
 * 本地修改登記在 `vendor/solid-glass/README.md` 的「本地修改」；這個檔沒有本地修改。
 *
 * 跟 shadcn registry 版的差異只在字級：外殼 `text-sm`（14/20，原本 `text-body` 14/23），表頭與表尾 `text-xs`（跟原本的 `text-tip` 同為 12/16）。
 * 泡泡由呼叫端給 `text-body`，不受外殼影響。
 */
export {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageGroup,
  MessageHeader,
} from '@/vendor/solid-glass/components/ui/message';
