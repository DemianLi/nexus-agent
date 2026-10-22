/**
 * 這一輪跑到哪了。
 *
 * `awaiting-input` **不是結束**：基座在中斷時照樣發 `lifecycle completed / root`，
 * 折疊器因此不讓那顆把狀態翻回 idle。按鈕在換手層的面板上，這一行只說它在等人。
 *
 * **代理的現況只由它唸**（§8）：待決、串流、失敗都是這一格 `role="status"`。別處的 `role="status"` 只有 §8 例外清單上那兩格
 * （`styles/live-region.test.ts` 守著）。
 *
 * **執行中那一列是 SG 的 `TurnStatus`**（[#1684](https://github.com/DemianLi/nexus-agent/issues/1684)，地圖 #1497 第 ④ 步）：glyph 加
 * `.status-shimmer` 的字，外觀照 SG（#1468 Q8）。live region 是包在外面的這一格 `<div role="status">`（vendor 的兩處
 * `role="status"` 由 patch `0023` 拿掉）。字固定「執行中…」，glyph 的樣子跟著這一刻在做什麼換（`lib/turn-activity.ts`）：
 * 字在 live region 裡，跟著換就每換一次唸一次。glyph 是 `aria-hidden` 的裝飾；reduced-motion 下 glyph 停在起始姿勢、shimmer 停住，
 * 字照樣在。SG 的經過時間、token 數、可展開的 children 都不接（包裝層 `components/ui/turn-status.tsx` 型別上擋掉）。
 * 只換這一支：其他支的字級跟它不一樣（14px 對 12.5px），記在 #1688；高度由外層的 `min-h-lh` 對齊。
 *
 * **連線也由這一行講**（[#593](https://github.com/DemianLi/nexus-agent/issues/593)）：下行斷了寫在這裡，旁邊一顆
 * 「立刻重連」；接回來短暫寫「已重新連線」。dsh 另有一顆 `ConnectionIndicator`，掛在設定列，我們沒有設定列，
 * 所以放進既有的狀態列（UI 形狀，不是執行語意）。按鈕放在 live region 外面，免得每次重唸都唸到它。
 *
 * **執行中帶經過時間**（[#1308](https://github.com/DemianLi/nexus-agent/issues/1308)）：從 server 記下的這一輪開始時刻起算
 * （`lib/running-turn.ts`），用回應的 `Date` 標頭換算兩邊的時鐘差（`lib/server-clock.ts`），所以重新整理不歸零。每秒跳，
 * **放在 live region 外面、而且 `aria-hidden`**：放裡面的話報讀器每秒重唸一次（所以不放進 TurnStatus 的 `trailing`：它也在
 * live region 裡）。只跟著「執行中」出現——停在核准點時這一格唸的是面板名稱；核准後續接，時間從第一段接著算，含等人的那段
 * （同觀測分頁的牆鐘）。滿 1 秒才畫（照 SG）。
 */

import type { ConversationState } from '@nexus/wire';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { TurnStatus } from '@/components/ui/turn-status';
import { pendingAsker } from '@/lib/approval-asker';
import { pendingLabel } from '@/lib/pending-label';
import { elapsedText, runningTurnStart } from '@/lib/running-turn';
import { serverClock } from '@/lib/server-clock';
import { STOPPED_STATUS_TEXT, TIMED_OUT_STATUS_TEXT, stoppedByTurnClock } from '@/lib/stop-cause';
import { turnActivity } from '@/lib/turn-activity';

/** 經過時間每隔多久重算一次。 */
export const ELAPSED_TICK_MS = 1000;

/** 這一輪跑了多久：起點與 server 現在的時刻都在 server 時鐘上；任一個答不出就不畫。 */
function RunningElapsed({ since }: { since: number | undefined }) {
  const [now, setNow] = useState(() => serverClock.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(serverClock.now()), ELAPSED_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  // 滿 1 秒才畫（照 SG `turn-status.tsx` 的 `elapsed >= 1`）：「0 秒」講的是一件還沒發生的事。
  if (since === undefined || now === undefined || now - since < 1000) return null;
  return (
    <span
      aria-hidden
      data-testid="running-elapsed"
      className="text-tip text-muted-foreground tabular-nums"
    >
      {elapsedText(now - since)}
    </span>
  );
}

/**
 * 斷線那一行怎麼講。`refusal` 是伺服器明說不收這條下行時給人看的話（thread 數滿了，[#1478](https://github.com/DemianLi/nexus-agent/issues/1478)）：
 * 不管之前連上過沒有都換成它，**不接 server 的原文**。背景的重試照舊，所以「立刻重連」還在。
 */
function lostText(
  reconnecting: { readonly wasConnected: boolean; readonly offline: boolean },
  connectionError: string | undefined,
  refusal: string | undefined,
): string {
  if (reconnecting.offline) return '網路離線：恢復之後會自動重新連線';
  if (refusal !== undefined) return refusal;
  if (reconnecting.wasConnected) return '連線中斷，正在重新連線…';
  return `連不上 agent${connectionError === undefined ? '' : `：${connectionError}`}。正在重試…`;
}

export function StatusLine({
  state,
  connected,
  connectionError,
  refusal,
  commandError,
  slashError,
  slashNotice,
  reconnecting,
  recovered = false,
  onReconnect,
}: {
  state: ConversationState;
  connected: boolean;
  connectionError?: string;
  /**
   * 下行被伺服器明說不收時給人看的話。還在重試（thread 數滿了）就取代斷線那一行（見 `lostText`）；
   * 不重試（子代理的會話，[#1708](https://github.com/DemianLi/nexus-agent/issues/1708)）就單獨一行，沒有「立刻重連」。
   */
  refusal?: string;
  /** 下行斷了、正在自動重接（見 `useConversation` 的 `reconnecting`）。 */
  reconnecting?: { readonly wasConnected: boolean; readonly offline: boolean };
  /** 剛重新接上。 */
  recovered?: boolean;
  /** 「立刻重連」。 */
  onReconnect?: () => void;
  commandError?: string;
  slashError?: string;
  slashNotice?: string;
}) {
  if (reconnecting !== undefined) {
    return (
      <div className="flex items-center gap-2">
        <p className="text-warning text-body" role="status">
          {lostText(reconnecting, connectionError, refusal)}
        </p>
        {onReconnect !== undefined && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 shrink-0 rounded-full lg:h-8"
            onClick={onReconnect}
          >
            立刻重連
          </Button>
        )}
      </div>
    );
  }
  if (refusal !== undefined) {
    return (
      <p className="text-warning text-body" role="status">
        {refusal}
      </p>
    );
  }
  if (connectionError !== undefined) {
    return (
      <p className="text-destructive text-body" role="status">
        連不上 agent：{connectionError}
      </p>
    );
  }
  if (!connected) {
    return (
      <p className="text-muted-foreground text-body" role="status">
        連線中…
      </p>
    );
  }
  if (state.status === 'failed') {
    return (
      <p className="text-destructive text-body" role="status">
        這一輪失敗了：{state.error ?? '未指名的錯誤'}
      </p>
    );
  }
  if (commandError !== undefined) {
    // 上行拒絕是 200 ＋ error 封包。不說出來就等於把 server 端那幾道圍欄的理由吞掉。
    return (
      <p className="text-destructive text-body" role="status">
        這個動作沒送出去：{commandError}
      </p>
    );
  }
  if (slashError !== undefined) {
    // 命令自己失敗，或那一行不是認得的命令。**跟上面那條是兩件事**：那個是這條線
    // 拒絕發派，這個是發派成功之後命令講的話。
    return (
      <p className="text-destructive text-body" role="status">
        {slashError}
      </p>
    );
  }
  if (slashNotice !== undefined && state.status !== 'running') {
    // 命令的結果**由發派它的這一側直接呈現**，不進 transcript（命令不進模型）。
    // 下一輪一開跑就讓位——那時人要看的是那一輪。
    return (
      <p className="text-body" role="status">
        {slashNotice}
      </p>
    );
  }
  const pending = state.pendings[0];
  if (state.status === 'awaiting-input' && pending !== undefined) {
    // **唸的是換手層上那一個面板的名稱**（§8）：面板出現不另開 live region，名稱與面板的 `aria-label` 同一句，
    // 帶跨面板進度「（1／2）」——兩種中斷混著掛時，進度讓人知道後面還有幾個。
    return (
      <p className="text-body" role="status">
        {pendingLabel(
          pending,
          { index: 0, total: state.pendings.length },
          pendingAsker(state, pending)?.label,
        )}
      </p>
    );
  }
  if (state.status === 'running') {
    return (
      // `min-h-lh` 跟 `text-body` 放在同一層：1lh 就是 text-body 的行高（23px），跟其他支一樣高；不然 SG 那一列是 `h-5`（20px），
      // 就緒 → 執行中 → 等你回答時整條狀態列跳 3px（#1684 驗收 D5，PM 預先核准）。
      <div className="flex min-h-lh items-center gap-2 text-body">
        <div role="status">
          <TurnStatus activity={turnActivity(state)} label="執行中…" />
        </div>
        <RunningElapsed since={runningTurnStart(state)} />
      </div>
    );
  }
  if (recovered) {
    // 只蓋掉最後這一格（就緒／已停止）：接回來時要是正在跑、停在核准點或失敗了，人要看的是那個。
    return (
      <p className="text-muted-foreground text-body" role="status">
        已重新連線
      </p>
    );
  }
  return (
    <p className="text-muted-foreground text-body" role="status">
      {/* 已停止不是失敗（#276）：人按的、時間到停下的都不用紅字；兩種分開講（#1631）。 */}
      {state.status === 'stopped'
        ? stoppedByTurnClock(state.stopCause)
          ? TIMED_OUT_STATUS_TEXT
          : STOPPED_STATUS_TEXT
        : '就緒'}
    </p>
  );
}
