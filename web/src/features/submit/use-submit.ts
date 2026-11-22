import { useRef, useState, useSyncExternalStore } from 'react';

import type { SubmitGesture, MentionAgent } from '@/features/composer';

import { createSubmitMachine } from './machine';
import type { SubmitOptions } from './machine';

export interface Submit {
  readonly draft: string;
  readonly setDraft: (draft: string) => void;
  /** 輸入框的 `@子代理` 標記與它的選取。 */
  readonly mentionedAgent: MentionAgent | undefined;
  readonly selectAgent: (agent: MentionAgent | undefined) => void;
  readonly submit: (gesture: SubmitGesture) => void;
  readonly runCommand: (line: string) => boolean;
  /** 認命令或命令在途：輸入框整個鎖住，也不收 `canSteerQueue`。 */
  readonly locked: boolean;
  /** 附件送出中：附件列上的移除不收。 */
  readonly removalLocked: boolean;
  /** 現在的草稿送不送得出去：{@link SubmitOptions.allowed} 與 {@link SubmitOptions.enabled} 再加上兩道鎖。 */
  readonly canSend: boolean;
}

/**
 * 送出的狀態機（`machine.ts`）接上 React。狀態機一個畫面一個，選項隨畫面換、動作時才讀。
 */
export function useSubmit<A extends { readonly id: string }>(options: SubmitOptions<A>): Submit {
  const latest = useRef(options);
  latest.current = options;
  const [machine] = useState(() => createSubmitMachine(() => latest.current));
  const snapshot = useSyncExternalStore(machine.subscribe, machine.getSnapshot);
  return {
    draft: snapshot.draft,
    setDraft: machine.setDraft,
    mentionedAgent: snapshot.mentionedAgent,
    selectAgent: machine.selectAgent,
    submit: machine.submit,
    runCommand: machine.runCommand,
    locked: snapshot.locked,
    removalLocked: snapshot.removalLocked,
    canSend:
      options.allowed(snapshot.draft) &&
      options.enabled &&
      !snapshot.removalLocked &&
      !snapshot.locked,
  };
}
