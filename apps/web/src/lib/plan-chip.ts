import type { ConversationStatus, PlanModePayload } from '@nexus/wire';

/**
 * 輸入框上方的計劃模式標籤在畫面上的判斷（[#900](https://github.com/DemianLi/nexus-agent/issues/900)）。資料是
 * harness 的投影 `ConversationState.planMode`（#895）。
 *
 * 照 dsh 的 `PlanChip`：**只在開著時才畫，只負責退出**——進入走 `/plan` 斜線命令。`null` 是「日誌上還沒有過
 * `plan/mode`」，等同關著，不是「還沒收到」，所以不畫。
 *
 * @module
 */

/** 退出就是打 `/plan off`，走跟打字送出同一條 `slash.run`。 */
export const PLAN_EXIT_LINE = '/plan off';

/** 標籤上的字。 */
export const PLAN_CHIP_TEXT = '計劃模式';

/** 按鈕的無障礙名稱：名字講的是按下去會發生的事，不是現況。 */
export const PLAN_CHIP_LABEL = '退出計劃模式';

/** 跑著時停用的提示（照卡上的建議）：伺服器一輪還在跑時會拒絕斜線命令，不讓人按下去才收到一句拒絕。 */
export const PLAN_CHIP_RUNNING_HINT = '這一輪跑完才能關';

/** 停在核准點或提問時停用的提示：伺服器同樣拒絕斜線命令，要先回答。 */
export const PLAN_CHIP_AWAITING_HINT = '先回答上面的問題，才能關';

/** 沒連上線時停用的提示。 */
export const PLAN_CHIP_OFFLINE_HINT = '連線恢復後才能關';

export interface PlanChipView {
  /** 要不要畫。 */
  readonly visible: boolean;
  /** 能不能按。 */
  readonly disabled: boolean;
  /** 停用時為什麼停用；能按時是退出的說明。 */
  readonly hint: string;
}

/** 這一刻標籤畫不畫、能不能按。 */
export function planChipView(
  planMode: PlanModePayload | null,
  status: ConversationStatus,
  connected: boolean,
): PlanChipView {
  const visible = planMode?.active === true;
  if (!connected) return { visible, disabled: true, hint: PLAN_CHIP_OFFLINE_HINT };
  if (status === 'running') return { visible, disabled: true, hint: PLAN_CHIP_RUNNING_HINT };
  if (status === 'awaiting-input') {
    return { visible, disabled: true, hint: PLAN_CHIP_AWAITING_HINT };
  }
  return { visible, disabled: false, hint: PLAN_CHIP_LABEL };
}
