import type { ConversationStatus, PlanModePayload } from '@nexus/wire';
import { ClipboardList } from 'lucide-react';
import { useId, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  PLAN_CHIP_EXIT_TEXT,
  PLAN_CHIP_LABEL,
  PLAN_CHIP_TEXT,
  planChipView,
} from '@/lib/plan-chip';

/**
 * 輸入框上方的計劃模式標籤（[#900](https://github.com/DemianLi/nexus-agent/issues/900)）。算法在 `lib/plan-chip.ts`。
 *
 * - **只在開著時才畫，只負責退出**：進入走 `/plan`，標籤本身不能開啟。
 * - **狀態與動作分開**：SG `Badge` 只說「計劃模式」、不能按也不在 Tab 順序裡；退出是旁邊那顆「退出」。
 * - **不是樂觀更新**：按下去送 `/plan off`，成功了也不自己拿掉，等線上的值翻回關著，標籤才消失。送出期間停用、防連按。
 * - **失敗時標籤留著**，旁邊一句帶原因的字（斜線命令被拒、不認得、回錯誤）。下一次按再試時先收掉上一句。
 * - **跑著、停在核准點、斷線時停用**，原因放在 `title`，不讓人按下去才收到一句拒絕。
 * - **報讀**：「退出」鈕的名稱是「退出計劃模式」（看得到的字在名稱開頭）；失敗那句掛在 `aria-describedby`。不掛 `role="status"`：代理的現況
 *   只由狀態列唸（§8）。
 */
export function PlanChip({
  planMode,
  status,
  connected,
  onExit,
}: {
  readonly planMode: PlanModePayload | null;
  readonly status: ConversationStatus;
  readonly connected: boolean;
  /** 送 `/plan off`；回 `undefined` 是命令成功，回字串是失敗的原因。 */
  readonly onExit: () => Promise<string | undefined>;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const failureId = useId();
  const view = planChipView(planMode, status, connected);
  if (!view.visible) return null;

  const exit = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      setFailure(await onExit());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-2 flex min-w-0 flex-wrap items-center gap-2" data-testid="plan-chip">
      <Badge variant="secondary" className="gap-1.5">
        <ClipboardList aria-hidden />
        {PLAN_CHIP_TEXT}
      </Badge>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="max-lg:h-11"
        aria-label={PLAN_CHIP_LABEL}
        aria-describedby={failure === undefined ? undefined : failureId}
        title={view.hint}
        disabled={view.disabled || busy}
        onClick={() => void exit()}
      >
        {PLAN_CHIP_EXIT_TEXT}
      </Button>
      {failure !== undefined && (
        <p id={failureId} className="text-destructive min-w-0 text-tip">
          {failure}
        </p>
      )}
    </div>
  );
}
