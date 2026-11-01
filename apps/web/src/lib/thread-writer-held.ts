/**
 * 這條會話的寫租約被別的寫入者握著、續接被拒（`thread_writer_held`，
 * [#2031](https://github.com/DemianLi/nexus-agent/issues/2031)、[#2214](https://github.com/DemianLi/nexus-agent/issues/2214)）時，
 * 給使用者看的那一句。
 *
 * **不顯示 server 的 message**：那句寫了會話 id 與行程、寫入者這些用語，用的人看不懂也用不上。
 * **是暫時的**：握著的那一方放掉之後再開就開得起來，同 `lib/thread-capacity.ts` 走重試（`hooks/use-conversation.ts`、`hooks/use-open-read.ts`）。
 *
 * @module
 */

import { THREAD_WRITER_HELD } from '@nexus/wire';

/** 這條會話被別處開著，這裡暫時打不開。說對話沒有壞、下一步是什麼；不提 id、行程或寫入者。 */
export const THREAD_WRITER_HELD_TEXT =
  '這條對話正在別的地方開著，這裡暫時打不開。對話沒有壞，那邊關掉之後再試；一直打不開請聯絡管理者。';

/** 錯誤碼是「被別的寫入者握著」就回 {@link THREAD_WRITER_HELD_TEXT}，其他碼回 `undefined`。 */
export function threadWriterHeldText(code: string | undefined): string | undefined {
  return code === THREAD_WRITER_HELD ? THREAD_WRITER_HELD_TEXT : undefined;
}
