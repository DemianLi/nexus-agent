import type { WireGoal } from '@nexus/wire';
import { Pause, Target } from 'lucide-react';
import { useId, useState } from 'react';

import { Surface } from '@/components/surface';
import { GOAL_PAUSE_LABEL, GOAL_PAUSE_OFFLINE_HINT, goalBarView } from '@/lib/goal-bar';

/**
 * 輸入框上方的目標列（[#945](https://github.com/DemianLi/nexus-agent/issues/945)，對應 dsh 的 `GoalBar`）。判斷在
 * `lib/goal-bar.ts`。
 *
 * - **只做暫停**（[#1517](https://github.com/DemianLi/nexus-agent/issues/1517)，送 #1516 的 `goal.pause`）：恢復、編輯、清除
 *   不在這條上，建立目標在 `/goal` 斜線命令。暫停鈕在相位是 `active` 時才有（PM 定，不看 activation）。
 * - **不是樂觀更新**：按下去送出，成功了也不自己改相位，等下行把目標翻成 `paused`，鈕自己消失；一輪跑著時停下來的樣子
 *   也走下行（跟按停止同一條，#1516）。送出期間停用、防連按；斷線時停用，原因放 `title`。
 * - **失敗時列留著**，列下面一句帶原因的字（目標剛被改過、已經不在進行、伺服器不支援）。下一次按再試時先收掉上一句。
 *   失敗那句掛在鈕的 `aria-describedby`。
 * - **鈕不撐高整列**：看得到的圓 32px、上下各吃掉 8px，跟一行 `text-tip` 一樣高，鈕消失時列不跳；窄螢幕用 `after` 把點擊區
 *   擴到 44px（同側欄的寫法），不畫出來。
 * - **有目標且沒完成才畫**（`complete` 與沒有目標都不畫）。
 * - **目標內容單行截短**，全文在 `title` 與整列的無障礙名稱。`blocked` 的理由直接顯示在列上。
 * - 不掛 `role="status"`：代理的現況只由狀態列唸（§8），目標每變一次就唸一次太吵。
 */
export function GoalBar({
  goal,
  connected,
  onPause,
}: {
  readonly goal: WireGoal | null;
  readonly connected: boolean;
  /** 送 `goal.pause`；回 `undefined` 是收下了，回字串是失敗的原因。 */
  readonly onPause: (goalId: string, revision: number) => Promise<string | undefined>;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const failureId = useId();
  const view = goalBarView(goal);
  if (view === undefined || goal === null) return null;

  // 帶的是按下去那一刻畫面上的那一份：server 拿修訂比對，過期就回錯，不蓋掉別人剛做的改動。
  const pause = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      setFailure(await onPause(goal.id, goal.revision));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Surface
      tone="docked"
      role="group"
      aria-label={view.label}
      data-testid="goal-bar"
      className="text-muted-foreground mb-2 min-w-0 px-3 py-2 text-tip"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Target aria-hidden className="size-4 shrink-0" />
        <span className="shrink-0 font-medium">{view.phase}</span>
        <span className="min-w-0 flex-1 truncate" title={view.objective}>
          {view.objective}
        </span>
        {view.rounds !== undefined && (
          <span className="shrink-0" data-testid="goal-rounds">
            {view.rounds}
          </span>
        )}
        {view.pausable && (
          <button
            type="button"
            aria-label={GOAL_PAUSE_LABEL}
            aria-describedby={failure === undefined ? undefined : failureId}
            title={connected ? GOAL_PAUSE_LABEL : GOAL_PAUSE_OFFLINE_HINT}
            disabled={!connected || busy}
            onClick={() => void pause()}
            data-testid="goal-pause"
            className="hover:bg-chip-hover active:bg-chip-pressed relative -my-2 -mr-1.5 flex size-8 shrink-0 items-center justify-center rounded-full transition-colors duration-(--duration-quick) after:absolute after:-inset-1.5 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent lg:after:hidden"
          >
            <Pause aria-hidden className="size-4" />
          </button>
        )}
      </div>
      {view.blockedReason !== undefined && (
        <p className="mt-1 pl-6" data-testid="goal-blocked-reason">
          {view.blockedReason}
        </p>
      )}
      {failure !== undefined && (
        <p id={failureId} className="text-destructive mt-1 pl-6" data-testid="goal-pause-failure">
          {failure}
        </p>
      )}
    </Surface>
  );
}
