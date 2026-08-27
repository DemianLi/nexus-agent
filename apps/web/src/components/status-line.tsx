/**
 * 這一輪跑到哪了。
 *
 * `awaiting-input` **不是結束**：基座在中斷時照樣發 `lifecycle completed / root`，
 * 折疊器因此不讓那顆把狀態翻回 idle。核准的按鈕是下一張 PR（`feat/web-hitl`）的事，
 * 這裡只負責讓「它在等人」看得出來，而不是看起來當掉了。
 */

import type { ConversationState } from '@nexus/wire';

export function StatusLine({
  state,
  connected,
  connectionError,
}: {
  state: ConversationState;
  connected: boolean;
  connectionError?: string;
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
  if (state.status === 'awaiting-input') {
    const names = state.pending?.actions.map((action) => action.name).join('、') ?? '';
    return (
      <p className="text-sm" role="status">
        等待核准：{names}（核准介面還沒做，見 feat/web-hitl）
      </p>
    );
  }
  return (
    <p className="text-muted-foreground text-sm" role="status">
      {state.status === 'running' ? '執行中…' : '就緒'}
    </p>
  );
}
