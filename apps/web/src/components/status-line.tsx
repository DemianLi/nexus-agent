/**
 * 這一輪跑到哪了。
 *
 * `awaiting-input` **不是結束**：基座在中斷時照樣發 `lifecycle completed / root`，
 * 折疊器因此不讓那顆把狀態翻回 idle。按鈕在 `ApprovalCard`，這一行只說它在等人。
 *
 * **全站唯一的 `role="status"`**（§8）：待決、串流、失敗都由它唸。執行中配 working orb 與 shimmer（§7），
 * orb 旁已有同義文字所以 `aria-hidden`；reduced-motion 下兩者都停在一格，字照樣在。
 */

import type { ConversationState } from '@nexus/wire';
import { isApprovalPending, isQuestionPending } from '@nexus/wire';

import { AgentOrb } from '@/components/agent-orb';

export function StatusLine({
  state,
  connected,
  connectionError,
  commandError,
  slashError,
  slashNotice,
}: {
  state: ConversationState;
  connected: boolean;
  connectionError?: string;
  commandError?: string;
  slashError?: string;
  slashNotice?: string;
}) {
  if (connectionError !== undefined) {
    return (
      <p className="text-destructive text-sm" role="status">
        連不上 agent：{connectionError}
      </p>
    );
  }
  if (!connected) {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        連線中…
      </p>
    );
  }
  if (state.status === 'failed') {
    return (
      <p className="text-destructive text-sm" role="status">
        這一輪失敗了：{state.error ?? '未指名的錯誤'}
      </p>
    );
  }
  if (commandError !== undefined) {
    // 上行拒絕是 200 ＋ error 封包。不說出來就等於把 server 端那幾道圍欄的理由吞掉。
    return (
      <p className="text-destructive text-sm" role="status">
        這個動作沒送出去：{commandError}
      </p>
    );
  }
  if (slashError !== undefined) {
    // 命令自己失敗，或那一行不是認得的命令。**跟上面那條是兩件事**：那個是這條線
    // 拒絕發派，這個是發派成功之後命令講的話。
    return (
      <p className="text-destructive text-sm" role="status">
        {slashError}
      </p>
    );
  }
  if (slashNotice !== undefined && state.status !== 'running') {
    // 命令的結果**由發派它的這一側直接呈現**，不進 transcript（命令不進模型）。
    // 下一輪一開跑就讓位——那時人要看的是那一輪。
    return (
      <p className="text-sm" role="status">
        {slashNotice}
      </p>
    );
  }
  if (state.status === 'awaiting-input') {
    // 兩種中斷可以同時掛著，而它們等的不是同一件事——「核准」與「回答」擠成一句話，
    // 人會以為畫面上那張問答卡是要他核准什麼。
    const names = state.pendings
      .flatMap((pending) => (isApprovalPending(pending) ? pending.actions : []))
      .map((action) => action.name)
      .join('、');
    const questions = state.pendings.filter(isQuestionPending).length;
    return (
      <p className="text-sm" role="status">
        {[
          names === '' ? undefined : `等待核准：${names}`,
          questions === 0 ? undefined : `等你回答 ${questions} 組問題`,
        ]
          .filter((part) => part !== undefined)
          .join('；')}
      </p>
    );
  }
  if (state.status === 'running') {
    return (
      <p className="text-muted-foreground flex items-center gap-1.5 text-sm" role="status">
        <AgentOrb state="working" size={20} decorative />
        <span className="text-shimmer">執行中…</span>
      </p>
    );
  }
  return (
    <p className="text-muted-foreground text-sm" role="status">
      {/* 已停止不是失敗（#276）：人按的，所以不用紅字。 */}
      {state.status === 'stopped' ? '已停止' : '就緒'}
    </p>
  );
}
