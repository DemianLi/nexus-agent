/**
 * 嵌入的對話框打開一條不是這位使用者開的對話（`thread_not_owned`，[#2370](https://github.com/DemianLi/nexus-agent/issues/2370)）時，
 * 給使用者看的那一句。
 *
 * **不顯示 server 的 message**，同 `thread-not-embedded.ts`。**是永久的**：擁有者寫在對話上，重試幾次都一樣，下行不排重試
 * （`hooks/use-conversation.ts`）。指向「新對話」那顆鈕。
 *
 * @module
 */

import { THREAD_NOT_OWNED } from '@nexus/wire';

/** 這不是你的對話。不說是誰的，叫人開新的；不提 thread、擁有者或登入這些詞。 */
export const THREAD_NOT_OWNED_TEXT = '這不是你的對話，這裡打不開。請按「新對話」開一條新的。';

/** 錯誤碼是「不是你的」就回 {@link THREAD_NOT_OWNED_TEXT}，其他碼回 `undefined`。 */
export function threadNotOwnedText(code: string | undefined): string | undefined {
  return code === THREAD_NOT_OWNED ? THREAD_NOT_OWNED_TEXT : undefined;
}
