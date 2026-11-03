/**
 * 嵌入的對話框打開一條從獨立頁面開的 thread（`thread_not_embedded`，[#2367](https://github.com/DemianLi/nexus-agent/issues/2367)）時，
 * 給使用者看的那一句（#2382）。
 *
 * **不顯示 server 的 message**：那句寫了 thread id。**是永久的**：嵌入版設定檔綁在 thread 上，重試幾次都一樣，下行不排重試
 * （`hooks/use-conversation.ts`）。要的是開一條新的，所以指向「新對話」那顆鈕。
 *
 * @module
 */

import { THREAD_NOT_EMBEDDED } from '@nexus/wire';

/** 這條對話不是在這個對話框開的。說對話沒有壞、這裡接不了，叫人開新的；不提 thread、嵌入或設定檔這些詞。 */
export const THREAD_NOT_EMBEDDED_TEXT =
  '這條對話是在完整的對話頁開的，這裡接不了。對話沒有壞，請按「新對話」開一條新的。';

/** 錯誤碼是「不是嵌入版開的」就回 {@link THREAD_NOT_EMBEDDED_TEXT}，其他碼回 `undefined`。 */
export function threadNotEmbeddedText(code: string | undefined): string | undefined {
  return code === THREAD_NOT_EMBEDDED ? THREAD_NOT_EMBEDDED_TEXT : undefined;
}
