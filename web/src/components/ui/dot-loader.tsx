/**
 * nexus 層（#1695）：轉出 vendor 的 solid-glass 版（`vendor/solid-glass/components/ui/dot-loader.tsx`），外觀照 SG（#1468 Q8）。
 * 本地修改登記在 `vendor/solid-glass/README.md` 的「本地修改」；這個檔沒有本地修改。
 *
 * 三個點只是視覺，沒有報讀名稱：呼叫端旁邊要有同義的字，或者放在停用（`aria-disabled`）的鈕裡，由停用狀態表達讀取中（#2009）。reduced-motion 下停在全亮，是 `solid-glass.css` 那條。
 */
export { DotLoader } from '@/vendor/solid-glass/components/ui/dot-loader';
