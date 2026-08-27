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
}: {
  state: ConversationState;
  connected: boolean;
  connectionError?: string;
  commandError?: string;
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
