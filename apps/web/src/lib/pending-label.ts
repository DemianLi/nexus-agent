import type { PendingInput } from '@nexus/wire';

/** 這一個面板排在第幾、總共幾個待決（跨面板，核准與提問一起數）。 */
export interface PendingPosition {
  readonly index: number;
  readonly total: number;
}

/**
 * 待決面板的名稱（規格 §8）：**面板的 `aria-label` 與狀態列唸的是同一句**，所以只寫在這裡。
 * 只有一個待決時不帶進度；兩個以上帶「（1／2）」。
 */
export function pendingLabel(pending: PendingInput, position: PendingPosition): string {
  const base =
    pending.kind === 'approval'
      ? `等待核准：${pending.actions.map((action) => action.name).join('、')}`
      : `有 ${pending.questions.length} 個問題要你回答`;
  return position.total > 1 ? `${base}（${position.index + 1}／${position.total}）` : base;
}
