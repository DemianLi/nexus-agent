/**
 * 這條會話的可寫根這台 serve 接不上（`thread_root_mismatch`，[#2222](https://github.com/DemianLi/nexus-agent/issues/2222)）時，
 * 給使用者看的那一句：會話開在另一個 home，或跑在另一個 `--workspace`。
 *
 * **不顯示 server 的 message**：那句寫了會話 id 與 serve 的用語。一句涵蓋兩種情況，web 分不出是哪一種，也不必分。
 * **是永久的**：換這台怎麼試結果都一樣，下行不排重試、打開時讀的那幾樣也不重讀（`hooks/use-conversation.ts`、`hooks/use-open-read.ts`）。
 *
 * @module
 */

import { THREAD_ROOT_MISMATCH } from '@nexus/wire';

/** 這條會話開在別的 home 或工作區。說對話沒有壞、要回原本那邊，指向管理者；用的人不知道 home 與工作區這些詞，一律說「環境」，也不提路徑或 id。 */
export const THREAD_ROOT_MISMATCH_TEXT =
  '這條對話是在別的環境開的，這裡打不開。對話沒有壞，要回原本的環境才打得開，請聯絡管理者。';

/** 錯誤碼是「可寫根接不上」就回 {@link THREAD_ROOT_MISMATCH_TEXT}，其他碼回 `undefined`。 */
export function threadRootMismatchText(code: string | undefined): string | undefined {
  return code === THREAD_ROOT_MISMATCH ? THREAD_ROOT_MISMATCH_TEXT : undefined;
}
