import type { PendingInput } from '@nexus/wire';

import { isPlanReview } from '@/features/plan';
import { ESCALATION_TITLE, SANDBOX_ESCALATION_TOOL } from '@/features/tool';

/** 這一個面板排在第幾、總共幾個待決（跨面板，核准與提問一起數）。 */
export interface PendingPosition {
  readonly index: number;
  readonly total: number;
}

/**
 * 待決的那一句（規格 §8）：**狀態列唸的與面板的 `aria-label` 是同一句**，所以只寫在這裡；面板看得到的名稱列是它的縮寫
 * （{@link pendingHead}）。只有一個待決時不帶進度；兩個以上帶「（1／2）」。計劃審核（#654）叫「計劃待審」，同側欄那一列的狀態字。
 * 沙箱升級（#1292）不露工具名，叫「{@link ESCALATION_TITLE}」；其他工具是工具名。
 */
export function pendingLabel(
  pending: PendingInput,
  position: PendingPosition,
  /** 前景子代理在問時的稱呼（`features/approval/asker.ts`）；root 自己問的不給。 */
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
  return base + positionText(position);
}

/** 面板名稱列看得到的那幾段（#3035 結論 D）：種類、核准的工具、哪個子代理要的、跨面板進度，畫法歸 `pending-swap.tsx`。 */
export interface PendingHead {
  /** 「等待核准」「N 個問題」「計劃待審」。 */
  readonly kind: string;
  /** 要核准的工具；`code` 是工具名，沙箱升級是 {@link ESCALATION_TITLE} 這句話，不是工具名。 */
  readonly tools: readonly { readonly text: string; readonly code: boolean }[];
  /** 哪個前景子代理要的（畫成「・…」）；只有核准有。 */
  readonly asker?: string;
  /** 「（1／2）」；只有一個待決時是空字串。 */
  readonly position: string;
}

/** 面板名稱列看得到的那幾段，是 {@link pendingLabel} 那一句的縮寫。`asker` 只有核准會帶，提問與計劃審核不帶。 */
export function pendingHead(
  pending: PendingInput,
  position: PendingPosition,
  asker?: string,
): PendingHead {
  const head = {
    kind:
      pending.kind === 'approval'
        ? '等待核准'
        : isPlanReview(pending.questions)
          ? '計劃待審'
          : `${pending.questions.length} 個問題`,
    tools:
      pending.kind === 'approval'
        ? pending.actions.map((action) =>
            action.name === SANDBOX_ESCALATION_TOOL
              ? { text: ESCALATION_TITLE, code: false }
              : { text: action.name, code: true },
          )
        : [],
    position: positionText(position),
  };
  return asker === undefined || pending.kind !== 'approval' ? head : { ...head, asker };
}

function positionText(position: PendingPosition): string {
  return position.total > 1 ? `（${position.index + 1}／${position.total}）` : '';
}
