/**
 * 對話狀態的可訂閱 store（[#1033](https://github.com/DemianLi/nexus-agent/issues/1033)，#1031 延後的那一項）。
 *
 * 右側欄的面板要讀對話，但**不能靠 props 或 `RightSidebarSources` 帶 `ConversationState`**：`App` 每收一格串流就重畫一次，
 * `sources` 一變身分，`RightSidebarPanel` 的 `memo` 就整個擋不住（#1031 量過）。這裡給面板一條自己的線：`useSyncExternalStore`
 * 同 `changes.summary`，面板只在**看得見**時訂閱（見 `components/trace-panel.tsx`），藏起來時逐字片段不會讓它重算。
 *
 * **快照是「已交給 React 的那一份」**，不是 `FramePublisher.current`：後者在動畫幀排著時已經往前走了，面板讀到它會比對話區
 * 早看到還沒畫出來的字。所以 `set` 跟 `setState` 在同一個發布回呼裡（`use-conversation.ts`），兩邊同一刻換、同一份。
 *
 * 放的是整份狀態而不是挑好的投影：成本分頁（#1032）要讀 `tokenUsage` 與 `sessionStats`，同一條線就夠。
 *
 * @module
 */

import type { ConversationState } from '@nexus/wire';

export interface ConversationStore {
  /** 目前那一份。跟 React 手上的同一個參照，沒變就是同一個。 */
  getSnapshot(): ConversationState;
  subscribe(listener: () => void): () => void;
}

/** 可寫的那一半只給持有者（`useConversation`）：面板拿到的型別是 {@link ConversationStore}。 */
export interface WritableConversationStore extends ConversationStore {
  set(state: ConversationState): void;
}

export function createConversationStore(initial: ConversationState): WritableConversationStore {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(state) {
      if (state === current) return;
      current = state;
      for (const listener of [...listeners]) listener();
    },
  };
}
