/**
 * nexus 層（#1638 PR B）：轉出 vendor 的 solid-glass 版（`vendor/solid-glass/components/ui/bubble.tsx`，Base UI 的 `useRender`），
 * 外觀照 SG（#1468 Q8）。本地修改登記在 `vendor/solid-glass/README.md` 的「本地修改」；這個檔沒有本地修改。
 *
 * 跟 shadcn registry 版的用法差異：`BubbleContent` 的 `asChild` 改成 `render={<元素 />}`（產品碼沒有人用）。字級 `text-sm`（原本 `text-body`），
 * 呼叫端照樣自己給 `text-body`。
 */
export {
  Bubble,
  BubbleContent,
  BubbleGroup,
  BubbleReactions,
} from '@/vendor/solid-glass/components/ui/bubble';
