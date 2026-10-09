import type {
  ConversationState,
  ConversationStatus,
  SubagentMention,
  WireAttachmentRef,
} from '@nexus/wire';

import { queuedAgentText } from '@/lib/queue-view';

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

/**
 * 排著的背景子代理結算通知與來信那一句（#851、#861）：不是人的泡泡，只說「有這件事、什麼時候送進模型」。跑著的時候
 * 這一輪下一步就會領走，停了就等下一輪，跟 {@link pendingSteerText} 同一條線。
 */
export function pendingAgentText(agentText: string, status: ConversationStatus): string {
  return status === 'running' || status === 'awaiting-input'
    ? `${agentText}・下一步送進模型`
    : `${agentText}・下一輪送進模型`;
}

export interface PendingSteer {
  /** 同領走後那則人的話的 id。通知被領走時不長人的話，這一格就直接消失。 */
  readonly key: string;
  readonly text: string;
  /** 這一句帶的附件參照（人排的才有）：領走前就畫標籤，不要等模型領走才冒出來。 */
  readonly attachments?: readonly WireAttachmentRef[];
  /** 這一句點名派的子代理（#328 第 2 項）：人排的才有；排著時就畫 chip。 */
  readonly mention?: SubagentMention;
  /**
   * 不是人排的（背景子代理的結算通知、來信，#851、#861）時是那一句（`queuedAgentText`）：不畫成人的泡泡，`text` 是給
   * 模型的英文，不給人看。人排的沒有。
   */
  readonly agentText?: string;
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
    .map((item) => {
      const agentText = queuedAgentText(item);
      return {
        key: `inbox:${item.id}`,
        text: item.text,
        ...(item.attachments === undefined ? {} : { attachments: item.attachments }),
        ...(item.mention === undefined ? {} : { mention: item.mention }),
        ...(agentText === undefined ? {} : { agentText }),
      };
    });
}
