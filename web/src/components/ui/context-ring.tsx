/**
 * nexus 層（#1591）：轉出 vendor 的 solid-glass 版（`vendor/solid-glass/components/ui/context-ring.tsx`），外觀照 SG（#1468 Q8）。
 * 本地修改登記在 `vendor/solid-glass/README.md` 的「本地修改」；這個檔沒有本地修改。改 vendor 檔的有一條：
 *
 * - 第 34 條 `patches/0008-context-ring-body.patch`：加 `label`（報讀名稱）與 `children`（明細整段由呼叫端給）。
 *
 * 外觀另有覆寫檔第 36、37、38 條（1024 以下 44px、色階壓回 status token、減少動態時弧長不走 transition）。
 */
export { ContextRing, compactTokens } from '@/vendor/solid-glass/components/ui/context-ring';
