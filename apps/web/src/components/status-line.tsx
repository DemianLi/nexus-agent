/**
 * 這一輪跑到哪了。
 *
 * `awaiting-input` **不是結束**：基座在中斷時照樣發 `lifecycle completed / root`，
 * 折疊器因此不讓那顆把狀態翻回 idle。按鈕在 `ApprovalCard`，這一行只說它在等人。
 */

import type { ConversationState } from '@nexus/wire';

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
    const names = state.pending?.actions.map((action) => action.name).join('、') ?? '';
    return (
      <p className="text-sm" role="status">
        等待核准：{names}
      </p>
    );
  }
  return (
    <p className="text-muted-foreground text-sm" role="status">
      {state.status === 'running' ? '執行中…' : '就緒'}
    </p>
  );
}
