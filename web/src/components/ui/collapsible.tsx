/**
 * nexus 層（#1638 PR A）：轉出 vendor 的 solid-glass 版（`vendor/solid-glass/components/ui/collapsible.tsx`，Base UI），外觀照 SG（#1468 Q8）。
 * 本地修改登記在 `vendor/solid-glass/README.md` 的「本地修改」；這個檔沒有本地修改。
 *
 * 跟 Radix 版的用法差異：Root 與 Panel 掛 `data-open`／`data-closed`，**Trigger 只在開著時掛 `data-panel-open`**（關著不帶屬性，
 * 沒有 `data-state`）；`asChild` 改成 `render={<元素 />}`；`forceMount` 改成 `keepMounted`；量好的高度在 `--collapsible-panel-height`。
 * 展開收合照 SG 沒有高度動效（#1687，§7）：Panel 不加動效的 class，開關是立即的。
 */
export {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/vendor/solid-glass/components/ui/collapsible';
