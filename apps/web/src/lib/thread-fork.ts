/**
 * 從一輪收尾的那則回覆分出一條新對話（[#1581](https://github.com/DemianLi/nexus-agent/issues/1581) 刀 2，wire 是 #1580 的 `thread.fork`）。
 *
 * 照 dsh 的入口 1：每一輪收尾那則回覆下面的分支鈕（`ui-chat/src/client/chat/MessageIconActions.tsx:91-109`，接線在
 * `ui-chat/src/client/apply.ts:285-295`，`687f282e`）。按下去：server 分出子 thread → 清單上先放一列佔位 → 來源有標題就把子 thread
 * 改成遞增的名字 → 切過去（dsh `client/sessions/service.ts:459-483` 的 `fork({ increaseTitle: true })`）。流程在 `App.tsx`。
 *
 * **能不能按照 server 的判法**（卡面刀 2 第 1 點）：那則是收尾那一則、有 `messageId`、那一輪收了而且不是失敗收尾（`@nexus/core` 的
 * `forkBoundaryOf`）。dsh 另外在「收尾的字之後同一輪還有工具卡」時不給（`turn-tail.ts:76-98` 的 `branchUnavailable`、
 * `TurnTailNodeView.tsx` 的 `hasLaterChatNode`），我們的 server 收這種，卡面照 server，所以不另擋。串流中、送出之後回應之前也不給。
 *
 * @module
 */

import type { AiEntry } from '@nexus/wire';

/** 按鈕的名字與 tooltip，照 dsh `message.branch`（「在新对话中分支」）。 */
export const FORK_LABEL = '在新對話中分支';

/** 為什麼現在按不了。 */
export type ForkUnavailable = 'running' | 'forking' | 'failed' | 'no-message';

/** 按不了時 tooltip 與報讀器唸的那一句（dsh 只有一句 `message.branchUnavailable`，我們按原因分）。 */
export const FORK_UNAVAILABLE_TEXT: Readonly<Record<ForkUnavailable, string>> = {
  running: '回答還在進行，這一輪跑完才能分支。',
  forking: '正在分出新對話…',
  failed: '這一輪是失敗收尾的，不能從這裡分支。',
  'no-message': '這則回覆沒有留下訊息編號，不能從這裡分支。',
};

/** 分不出去時 toast 的標題；原因放描述（`fork_unavailable`、名額滿了、其他錯誤各一句）。 */
export const FORK_FAILED_TEXT = '沒有分出新對話';

/** 改名失敗時的 toast：子 thread 已經在了，照樣切過去（卡面驗收 5）。 */
export const FORK_RENAME_FAILED_TEXT = '已分出新對話，但改名失敗';

/** 切到分出來的那條時，畫面上方那一句（`ThreadChoice` 的 `forked`）。 */
export const FORKED_THREAD_NOTICE =
  '這是分出來的新對話：到分叉那一輪為止的內容都帶過來了，模型也記得。原本那條對話不變。';

/** 這一則下面要不要畫分支鈕：只有收尾的那一則（評分鈕的位置，`AiEntry.turnTail`）。 */
export function hasForkButton(entry: AiEntry): boolean {
  return entry.turnTail === true;
}

/**
 * 分支鈕現在按得了嗎；按不了回原因。
 *
 * @param entry - 收尾的那則回覆（{@link hasForkButton} 為真）。
 * @param state.running - 這條 thread 有一輪在跑或停著等人回答。
 * @param state.forking - 分叉送出去了、回應還沒到。
 * @param state.failed - 這則所在的那一輪是失敗收尾的。
 */
export function forkUnavailable(
  entry: AiEntry,
  state: { readonly running: boolean; readonly forking: boolean; readonly failed: boolean },
): ForkUnavailable | undefined {
  if (state.forking) return 'forking';
  if (state.running || entry.streaming) return 'running';
  if (state.failed) return 'failed';
  if (entry.messageId === undefined) return 'no-message';
  return undefined;
}

/**
 * 子 thread 的標題：結尾是半形 `(n)` 或全形 `（n）` 就把 n 加 1（括號照原樣），都不是就接 ` (1)`。
 * 數字用 BigInt 算，多長都不失準。照 dsh `client/sessions/service.ts:134-144` 的 `increasedForkTitle`，regex 原樣搬。
 */
export function increasedForkTitle(title: string): string {
  const ascii = /^(.*?)\((\d+)\)$/u.exec(title);
  if (ascii?.[1] !== undefined && ascii[2] !== undefined) {
    return `${ascii[1]}(${BigInt(ascii[2]) + 1n})`;
  }
  const fullWidth = /^(.*?)（(\d+)）$/u.exec(title);
  if (fullWidth?.[1] !== undefined && fullWidth[2] !== undefined) {
    return `${fullWidth[1]}（${BigInt(fullWidth[2]) + 1n}）`;
  }
  return `${title} (1)`;
}
