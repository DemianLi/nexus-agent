import type { PendingInput } from '@nexus/wire';

import { isPlanReview } from '@/lib/plan-review';
import { ESCALATION_TITLE, SANDBOX_ESCALATION_TOOL } from '@/lib/sandbox-escalation';

/** 這一個面板排在第幾、總共幾個待決（跨面板，核准與提問一起數）。 */
export interface PendingPosition {
  readonly index: number;
  readonly total: number;
}

/**
 * 待決面板的名稱（規格 §8）：**面板的 `aria-label` 與狀態列唸的是同一句**，所以只寫在這裡。
 * 只有一個待決時不帶進度；兩個以上帶「（1／2）」。計劃審核（#654）叫「計劃待審」，同側欄那顆狀態點的字。
 * 沙箱升級（#1292）不露工具名，叫「{@link ESCALATION_TITLE}」；其他工具照舊是工具名。
 */
export function pendingLabel(
  pending: PendingInput,
  position: PendingPosition,
  /** 前景子代理在問時的稱呼（`lib/approval-asker.ts`）；root 自己問的不給。 */
  asker?: string,
): string {
  const base =
    pending.kind === 'approval'
      ? `等待核准：${pending.actions
          .map((action) =>
            action.name === SANDBOX_ESCALATION_TOOL ? ESCALATION_TITLE : action.name,
          )
          .join('、')}${asker === undefined ? '' : `（${asker}要的）`}`
      : isPlanReview(pending.questions)
        ? '計劃待審'
        : `有 ${pending.questions.length} 個問題要你回答`;
  return position.total > 1 ? `${base}（${position.index + 1}／${position.total}）` : base;
}
