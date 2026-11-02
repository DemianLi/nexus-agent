import type { ConversationStatus, QueueSteerAction, WireQueuedInput } from '@nexus/wire';

import type { QueueUpdateRejected } from '@/hooks/use-conversation';

/**
 * 把送出佇列裡排著的話改成插話（[#710](https://github.com/DemianLi/nexus-agent/issues/710) 第二步）。照 dsh
 * （`packages/client/ui-conversation/src/client/queue/QueueDock.tsx:347` 的每列插話鈕、`client/input/hub.ts:223` 的
 * `steerQueue`，`477b4f4`）：
 *
 * - **只有這一輪跑著時能插話**：停了、停在核准點都不行（伺服器也回 `steer_unavailable`，這裡先擋一道）。
 * - **草稿空白時 Cmd/Ctrl+Enter 把排著的全部改成插話**：照排的先後一件一件送，伺服器每一件都要照條件收。
 *
 * @module
 */

/** 每列插話鈕的名稱前綴；後面接預覽，同一個佇列裡的「插話」要分得出是哪一則。 */
export const STEER_ROW_LABEL = '插話';

/** 這一輪不跑了，鈕按不下去時的說明。 */
export const STEER_ROW_UNAVAILABLE_TEXT = '只有這一輪跑著時才能插話';

/** 伺服器說這一輪已經不收插話了（跑完、按了停止、正在收尾），那一則照舊排著。 */
export const STEER_UNAVAILABLE_TEXT = '這一輪已經不收插話了，那一則照舊排著';

/** 改成插話沒送出去（不是「不收」也不是「已經不在隊裡」）。 */
export const STEER_FAILED_TEXT = '插話沒送出去，請再試一次';

/** 草稿空白、有排著的、這一輪跑著時，輸入框的提示字（dsh 的 `placeholder.steerQueue`）。 */
export const STEER_QUEUE_PLACEHOLDER = 'Cmd/Ctrl+Enter 把排著的全部改成插話';

/** 插話的動作。 */
export const STEER_ACTION: QueueSteerAction = { kind: 'steer' };

/** 現在能不能把排著的改成插話：連得上、這一輪跑著。 */
export function canSteerRows(connected: boolean, status: ConversationStatus): boolean {
  return connected && status === 'running';
}

/**
 * 草稿空白時 Cmd/Ctrl+Enter 有沒有東西可插：多了一條「有排著的」（dsh 的 `canSteerQueue`）。
 * 草稿有字時那個手勢是送出，不歸它管。
 */
export function canSteerQueue(
  connected: boolean,
  status: ConversationStatus,
  draft: string,
  count: number,
): boolean {
  return canSteerRows(connected, status) && draft.trim() === '' && count > 0;
}

/** {@link steerAll} 的結局：全送了、送到一半不收了或那一件已經不在隊裡（靜靜停，同 dsh）、或別的原因失敗。 */
export type SteerAllOutcome =
  | { readonly kind: 'done' }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * 照排的先後一件一件改成插話。**碰到「不收了」或「已經不在隊裡」就靜靜停**（同 dsh `steerQueue`：後面的一定也不收，
 * 而那一件多半是剛開跑了）；別的失敗停下來，交給呼叫端說。
 *
 * @param items - 排著的，照先後。
 * @param update - 改一件（`useConversation().updateQueue`）。
 */
export async function steerAll(
  items: readonly WireQueuedInput[],
  update: (itemId: string, action: QueueSteerAction) => Promise<QueueUpdateRejected | undefined>,
): Promise<SteerAllOutcome> {
  for (const item of items) {
    const rejected = await update(item.id, STEER_ACTION);
    if (rejected === undefined) continue;
    if (rejected.gone || rejected.unavailable) return { kind: 'stopped' };
    return { kind: 'failed', message: rejected.message };
  }
  return { kind: 'done' };
}
