/**
 * nexus 層（#1583）：轉出 vendor 的 solid-glass 版（`vendor/solid-glass/components/ui/tooltip.tsx`，Base UI），外觀照 SG（#1468 Q8）。
 * 本地修改登記在 `vendor/solid-glass/README.md` 的「本地修改」；這個檔沒有本地修改。nexus 要的延遲 0 是 SG 的 `TooltipProvider` 預設值
 * （vendor `:7`）：Trigger 取 `delay ?? Provider 的 delay ?? 600`，產品裡唯一的 tooltip（`App.tsx` 的停止鈕）自己包一層 Provider。
 * `tooltip.test.tsx` 釘 Provider 的預設。Base UI 的 tooltip 只是視覺，
 * 不給 `role="tooltip"`、不掛 `aria-describedby`：提示的字不能帶 Trigger 名稱裡沒有的資訊（#1583 驗收 D）。
 */
export {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/vendor/solid-glass/components/ui/tooltip';
