/**
 * nexus 層（#1682）：轉出 vendor 的 solid-glass 版（`vendor/solid-glass/components/ui/diff-view.tsx`），外觀照 SG（#1468 Q8）。
 * 這個檔沒有本地修改。它是 `tool-steps.tsx` 的依賴（vendor 那份 import `@/components/ui/diff-view`），所以一起 vendor 進來；
 * 工具卡**還沒有**給 `step.patch`，寫檔／改檔的 diff 仍由 `components/tool/result.tsx` 的 `ToolDiff` 畫，改成給 patch 的那一步
 * 記在 #1685（#1682 PM 定）。
 */
export { DiffStats, DiffView, patchStats } from '@/vendor/solid-glass/components/ui/diff-view';
