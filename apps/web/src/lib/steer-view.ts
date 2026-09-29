import type { ConversationState, ConversationStatus } from '@nexus/wire';

/**
 * 還沒被領走的插話在畫面上怎麼畫（[#710](https://github.com/DemianLi/nexus-agent/issues/710)）。資料是 harness 的投影
 * `ConversationState.inboxNextStep`：跑著的這一輪下一步就要送進模型的那幾句。
 *
 * 照 dsh 畫在對話尾端（`packages/client/ui-chat/src/client/chat/ChatView.tsx:172`，`477b4f4`），不進送出佇列：它不等
 * 這一輪收掉，而被領走時人的泡泡也接在尾端（`reduceInbox` 的 `claimedNextStep`）。所以**鍵跟領走後那則人的話同一個**
 * （`inbox:<項目 id>`，同 `@nexus/wire` 的 `reduceInbox`）：換成正式的那一刻是同一格換內容，不跳位、不重播進場。
 *
 * @module
 */

/** 插話泡泡底下那一句：這一輪還在（跑著、停在核准點，答完接著跑）。 */
export const PENDING_STEER_TEXT = '插話・下一步送進模型';

/**
 * 插話泡泡底下那一句：這一輪已經停了（按了停止、重啟接回來）。harness 把它留在 `next-step`，**下一輪的第一次模型呼叫**
 * 才領走，排在開那一輪的那句後面（`thread-pump.ts` 的 `#runOnce`，同 dsh 按停止帶 `keepInbox`）。
 */
export const PARKED_STEER_TEXT = '插話・下一輪送進模型';

/** 泡泡底下那一句看這一輪還在不在。 */
export function pendingSteerText(status: ConversationStatus): string {
  return status === 'running' || status === 'awaiting-input'
    ? PENDING_STEER_TEXT
    : PARKED_STEER_TEXT;
}

export interface PendingSteer {
  /** 同領走後那則人的話的 id。 */
  readonly key: string;
  readonly text: string;
}

/** 排著的插話，照送出的先後。已經折成人的話的不算（同一顆 frame 裡清單與領走一起換，這裡只是保險）。 */
export function pendingSteers(state: ConversationState): readonly PendingSteer[] {
  const claimed = new Set(
    state.entries.flatMap((entry) =>
      entry.kind === 'human' && entry.inboxId !== undefined ? [entry.inboxId] : [],
    ),
  );
  return state.inboxNextStep
    .filter((item) => !claimed.has(item.id))
    .map((item) => ({ key: `inbox:${item.id}`, text: item.text }));
}
