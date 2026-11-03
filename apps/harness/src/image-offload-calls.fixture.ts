/**
 * 每次 root 模型呼叫的圖片省略狀態（[#2354](https://github.com/DemianLi/nexus-agent/issues/2354)），夾具產生器與 `session-format-fixtures.test.ts` 共用。
 *
 * `image/offload` 記在 `model/start` 之前（上層先量）或之後（adapter 擋下、上層接住才記：舊寫入器，以及今天上層量不到的情形）。兩種位置下，那次呼叫**送出去的**
 * 請求都已經套了決定；從日誌推那次呼叫的歷史時，推得到的只有 `model/start` 之前的。所以逐次各推兩份：
 *
 * - `derived`：那次 `model/start` 之前的前綴，套 `image/offload`（呼叫端從日誌推歷史的時機）；
 * - `sent`：到那次 `model/end` 為止的前綴，套 `image/offload`（呼叫中途記下的決定也算進去，就是送出去的那一份）。
 *
 * 兩份都只列人話裡由前往後每張圖有沒有被省略。
 */

import { HumanMessage } from '@langchain/core/messages';
import { replayConversation } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';

/** 一次模型呼叫：推導那一份與送出那一份的省略旗標。 */
export interface ImageOffloadCall {
  readonly derived: readonly boolean[];
  readonly sent: readonly boolean[];
}

function offloadFlags(prefix: readonly SessionEvent[]): boolean[] {
  const replay = replayConversation(prefix, { applyImageOffloads: true });
  if (replay.kind !== 'replayed')
    throw new Error(`推不回來：${replay.reason}@${String(replay.seq)}`);
  return replay.messages.flatMap((message) =>
    HumanMessage.isInstance(message) && Array.isArray(message.content)
      ? (message.content as { type?: unknown; offloaded?: unknown }[])
          .filter((block) => block.type === 'nexus-image')
          .map((block) => block.offloaded === true)
      : [],
  );
}

/** 照 `model/start` 的順序，每次呼叫一筆。沒有配到 `model/end` 的那次，`sent` 推到日誌結尾。 */
export function imageOffloadCalls(events: readonly SessionEvent[]): ImageOffloadCall[] {
  return events.flatMap((event, index) => {
    if (event.type !== 'model/start') return [];
    const end = events.findIndex((later, at) => at > index && later.type === 'model/end');
    return [
      {
        derived: offloadFlags(events.slice(0, index)),
        sent: offloadFlags(events.slice(0, end === -1 ? events.length : end + 1)),
      },
    ];
  });
}
