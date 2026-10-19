/**
 * nexus 層（#1682、#1685）：轉出 vendor 的 solid-glass 版（`vendor/solid-glass/components/ui/diff-view.tsx`），外觀照 SG（#1468 Q8）。
 * 它是 `tool-steps.tsx` 的依賴（vendor 那份 import `@/components/ui/diff-view`，解析到這一層）。本地修改登記在
 * `vendor/solid-glass/README.md` 的「本地修改」：
 *
 * - **`DiffStats` 包一層**（第 76 條，#1685 PR A）：vendor 只畫「+12 −3」，報讀器唸符號。這一層把 vendor 那顆包進 `aria-hidden`，
 *   旁邊一段 sr-only「新增 12 行，刪除 3 行」（同這張卡以前 `changes/counts.tsx` 的唸法，§8）。vendor 的 `DiffStats` 只收 `added`／`removed`／`className`，
 *   掛不上 `aria-hidden`，所以外面再包一層；外層帶 `shrink-0`，在 flex 列裡不被擠（vendor 的 `shrink-0` 在裡面那層，管不到外層）。
 *   只加外層、不複製上游標記，走包裝層（#1583 判準）。vendor 的 `StepRow`／`StepGroup` import 的也是這一層，一起改到。
 * - **兩色換成 `--success`／`--destructive`**（第 75 條，覆寫檔 `styles/solid-glass.overrides.css`）：SG 的 emerald-600／rose-600 亮色過不了 4.5。
 * - **數字不分位**（#1685 PM 定題 6）：照 SG 畫 `+1234`。分位要改 vendor 標記，為了外觀寫 patch 違反分層規則。
 *
 * 工具卡**還沒有**給 `step.patch`，寫檔／改檔的 diff 仍由 `components/tool/result.tsx` 的 `ToolDiff` 畫，改成給 patch 是 #1685 PR B。
 */
import { DiffStats as VendorDiffStats } from '@/vendor/solid-glass/components/ui/diff-view';
import { cn } from '@/lib/utils';

export { DiffView, patchStats } from '@/vendor/solid-glass/components/ui/diff-view';

function DiffStats({
  added,
  removed,
  className,
}: {
  added: number;
  removed: number;
  className?: string;
}) {
  return (
    <span className={cn('shrink-0', className)}>
      <span aria-hidden="true">
        <VendorDiffStats added={added} removed={removed} />
      </span>
      <span className="sr-only">{`新增 ${added} 行，刪除 ${removed} 行`}</span>
    </span>
  );
}

export { DiffStats };
