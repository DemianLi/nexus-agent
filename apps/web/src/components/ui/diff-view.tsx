/**
 * nexus 層（#1682、#1685）：轉出 vendor 的 solid-glass 版（`vendor/solid-glass/components/ui/diff-view.tsx`），外觀照 SG（#1468 Q8）。
 * 它是 `tool-steps.tsx` 的依賴（vendor 那份 import `@/components/ui/diff-view`，解析到這一層），所以工具段的 `StepRow`／`StepGroup`
 * 畫的計數與 diff 都經過這裡。本地修改登記在 `vendor/solid-glass/README.md` 的「本地修改」：
 *
 * - **`DiffStats` 包一層**（第 76 條，#1685 PR A）：vendor 只畫「+12 −3」，報讀器唸符號。這一層把 vendor 那顆包進 `aria-hidden`，
 *   旁邊一段 sr-only「新增 12 行，刪除 3 行」（同這張卡以前 `changes/counts.tsx` 的唸法，§8）。vendor 的 `DiffStats` 只收 `added`／`removed`／`className`，
 *   掛不上 `aria-hidden`，所以外面再包一層；外層帶 `shrink-0`，在 flex 列裡不被擠（vendor 的 `shrink-0` 在裡面那層，管不到外層）。
 *   只加外層、不複製上游標記，走包裝層（#1583 判準）。
 * - **兩色換成 `--success`／`--destructive`**（第 75 條，覆寫檔 `styles/solid-glass.overrides.css`）：SG 的 emerald-600／rose-600 亮色過不了 4.5。
 * - **數字不分位**（#1685 PM 定題 6）：照 SG 畫 `+1234`。分位要改 vendor 標記，為了外觀寫 patch 違反分層規則。
 * - **`DiffView` 畫之前先截**（第 77 條，#1685 PR B 的 X4）：寫檔的 diff 沒有大小上限（`lib/card-limit.ts`），沿用以前 `ToolDiff` 的三道上限，
 *   見 {@link capPatch}。截在這一層、不在轉接層：vendor 用 `patchStats(step.patch)` 算列與群組的 +N −M，截過的 patch 會少報。
 *   截好的字串以 `useMemo` 記住，vendor 那顆包 `memo`，工具段跟著串流重畫時不重切。
 * - **`patchStats` 有界快取**（第 78 條）：vendor 的 `StepRow`／`StepGroup` 每次畫都對每一顆 `step.patch` 整份 split 一次，見 {@link patchStats}。
 *
 * @module
 */
import { memo, useMemo } from 'react';

import {
  DiffStats as VendorDiffStats,
  DiffView as VendorDiffView,
  patchStats as vendorPatchStats,
} from '@/vendor/solid-glass/components/ui/diff-view';
import { CARD_LINE_MAX_CHARS, fitRowCount } from '@/lib/card-limit';
import { MAX_RENDERED_LINES } from '@/lib/diff-rows';
import { clipMiddle } from '@/lib/tool-output';
import { cn } from '@/lib/utils';

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

/** 快取幾份：一段工具 12 顆、加上幾張撞到上限的大卡，同時在畫面上的 patch 不超過這個數。 */
export const PATCH_STATS_CACHE_SIZE = 32;

const statsCache = new Map<string, { added: number; removed: number }>();

/**
 * vendor 的 `patchStats` 加一層以字串為鍵、最近最少用先丟的快取，結果照全量算。
 *
 * 同一則工具呼叫的 patch 由 `lib/tool-diff.ts` 的 `toolDiffView` 記住，卡與段拿到同一個字串實例，查快取時 V8 用字串上記著的雜湊，
 * 不必重掃內容。記憶體：快取最多多留住 {@link PATCH_STATS_CACHE_SIZE} 份 patch 字串（那則呼叫已經不在畫面上之後），每份的大小同那張卡的 diff。
 */
export function patchStats(patch: string): { added: number; removed: number } {
  const hit = statsCache.get(patch);
  if (hit !== undefined) {
    statsCache.delete(patch);
    statsCache.set(patch, hit);
    return hit;
  }
  const stats = vendorPatchStats(patch);
  statsCache.set(patch, stats);
  if (statsCache.size > PATCH_STATS_CACHE_SIZE) {
    const oldest = statsCache.keys().next();
    if (oldest.done !== true) statsCache.delete(oldest.value);
  }
  return stats;
}

/**
 * 交給 vendor 畫之前的三道上限（同以前的 `ToolDiff`，#961）。「行」指 patch 字串的行，`diff --git` 與 `@@` 也算，
 * 結尾那一個換行不算一行（同 vendor 的切法）：
 *
 * - 最多 {@link MAX_RENDERED_LINES} 行；
 * - 從頭累計，每行最多算 {@link CARD_LINE_MAX_CHARS} 字元，總共不超過 `CARD_MAX_CHARS`（`fitRowCount`）；
 * - 單行超過 {@link CARD_LINE_MAX_CHARS} 時取頭尾、中間換成一句講沒畫多少字（`clipMiddle`）。頭那段保留 `+`／`-` 前綴，上色照舊。
 *
 * 截過時尾端加一行 `... 還有 N 行沒畫`（vendor 把 `...` 開頭的行畫成灰色斜體）。沒有截到時回傳原字串。
 */
export function capPatch(patch: string): string {
  const lines = patch.replace(/\n$/, '').split('\n');
  const limit = Math.min(MAX_RENDERED_LINES, fitRowCount(lines, (line) => line.length));
  let clipped = false;
  const kept = lines.slice(0, limit).map((line) => {
    const { head, tail, dropped } = clipMiddle(line, CARD_LINE_MAX_CHARS);
    if (dropped === 0) return line;
    clipped = true;
    return `${head}⋯ 中間 ${dropped} 字沒畫 ⋯${tail}`;
  });
  if (limit === lines.length && !clipped) return patch;
  if (lines.length > limit) kept.push(`... 還有 ${lines.length - limit} 行沒畫`);
  return kept.join('\n');
}

const MemoVendorDiffView = memo(VendorDiffView);

function DiffView({
  patch,
  className,
  label = '改動內容',
}: {
  patch: string;
  className?: string;
  label?: string;
}) {
  const capped = useMemo(() => capPatch(patch), [patch]);
  return <MemoVendorDiffView patch={capped} className={className} label={label} />;
}

export { DiffStats, DiffView };
