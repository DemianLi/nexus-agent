import { describe, expect, it } from 'vitest';

import {
  PLAN_CHIP_AWAITING_HINT,
  PLAN_CHIP_LABEL,
  PLAN_CHIP_OFFLINE_HINT,
  PLAN_CHIP_RUNNING_HINT,
  planChipView,
} from '@/lib/plan-chip';

describe('planChipView（#900）', () => {
  it('`null` 與 `active: false` 不畫：`null` 是日誌上還沒有過 plan/mode，等同關著', () => {
    expect(planChipView(null, 'idle', true).visible).toBe(false);
    expect(planChipView({ active: false }, 'idle', true).visible).toBe(false);
    // 跑著也一樣：沒開就是沒開。
    expect(planChipView(null, 'running', true).visible).toBe(false);
  });

  it('開著且閒著：畫、能按，提示是退出的說明', () => {
    expect(planChipView({ active: true }, 'idle', true)).toEqual({
      visible: true,
      disabled: false,
      hint: PLAN_CHIP_LABEL,
    });
    // 失敗與已停止的那一輪都收尾了，伺服器收斜線命令。
    expect(planChipView({ active: true }, 'failed', true).disabled).toBe(false);
    expect(planChipView({ active: true }, 'stopped', true).disabled).toBe(false);
  });

  it('跑著、停在核准點、斷線時停用，各講各的原因', () => {
    expect(planChipView({ active: true }, 'running', true)).toEqual({
      visible: true,
      disabled: true,
      hint: PLAN_CHIP_RUNNING_HINT,
    });
    expect(planChipView({ active: true }, 'awaiting-input', true)).toEqual({
      visible: true,
      disabled: true,
      hint: PLAN_CHIP_AWAITING_HINT,
    });
    expect(planChipView({ active: true }, 'idle', false)).toEqual({
      visible: true,
      disabled: true,
      hint: PLAN_CHIP_OFFLINE_HINT,
    });
  });
});
