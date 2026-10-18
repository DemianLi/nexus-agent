/**
 * nexus 層（#1638 PR A）：轉出 vendor 的 solid-glass 版（`vendor/solid-glass/components/ui/collapsible.tsx`，Base UI），外觀照 SG（#1468 Q8）。
 * 本地修改登記在 `vendor/solid-glass/README.md` 的「本地修改」；這個檔沒有本地修改。
 *
 * 跟 Radix 版的用法差異：Root 與 Panel 掛 `data-open`／`data-closed`，**Trigger 只在開著時掛 `data-panel-open`**（關著不帶屬性，
 * 沒有 `data-state`）；`asChild` 改成 `render={<元素 />}`；`forceMount` 改成 `keepMounted`；量好的高度在 `--collapsible-panel-height`
 * （展開收合的 keyframes 與時長都在 `index.css` 的 `@theme`：keyframes 讀它，開 250／關 150，§7；reduced-motion 的替換在 `styles/motion.css`）。
 */
export {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/vendor/solid-glass/components/ui/collapsible';
