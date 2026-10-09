import type { ConversationStatus, PlanModePayload } from '@nexus/wire';
import { ClipboardList, X } from 'lucide-react';
import { useId, useState } from 'react';

import { PLAN_CHIP_LABEL, PLAN_CHIP_TEXT, planChipView } from '@/lib/plan-chip';

/**
 * 輸入框上方的計劃模式標籤（[#900](https://github.com/DemianLi/nexus-agent/issues/900)）。算法在 `lib/plan-chip.ts`。
 *
 * - **只在開著時才畫，只負責退出**：進入走 `/plan`，標籤本身不能開啟。
 * - **不是樂觀更新**：按下去送 `/plan off`，成功了也不自己拿掉，等線上的值翻回關著，標籤才消失。送出期間停用、防連按。
 * - **失敗時標籤留著**，旁邊一句帶原因的字（斜線命令被拒、不認得、回錯誤）。下一次按再試時先收掉上一句。
 * - **跑著、停在核准點、斷線時停用**，原因放在 `title`，不讓人按下去才收到一句拒絕。
 * - **報讀**：按鈕名稱是「退出計劃模式」；失敗那句掛在 `aria-describedby`。不掛 `role="status"`：代理的現況
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
      <button
        type="button"
        aria-label={PLAN_CHIP_LABEL}
        aria-describedby={failure === undefined ? undefined : failureId}
        title={view.hint}
        disabled={view.disabled || busy}
        onClick={() => void exit()}
        className="bg-card text-muted-foreground hover:bg-chip-hover active:bg-chip-pressed flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-ui transition-colors duration-(--duration-quick) disabled:cursor-default disabled:opacity-60 disabled:hover:bg-card lg:min-h-8"
      >
        <ClipboardList aria-hidden className="size-4 shrink-0" />
        <span>{PLAN_CHIP_TEXT}</span>
        <X aria-hidden className="size-3.5 shrink-0" />
      </button>
      {failure !== undefined && (
        <p id={failureId} className="text-destructive min-w-0 text-tip">
          {failure}
        </p>
      )}
    </div>
  );
}
