/**
 * 落盤確認（[#1606](https://github.com/DemianLi/nexus-agent/issues/1606)）：一份日誌此刻的最後一顆**真的到了磁碟**才放行。
 *
 * 照 dsh `packages/feedback/message-feedback/src/index.ts:238-258`（`687f282e`）的三步：
 *
 * 1. **同步**記下最後一顆（`:239`）。之後才 await，所以一輪串流當中模型接著寫進來的，不算進這一次。
 * 2. 排空（{@link SessionRegistry.flush}）；沒有任何排空者參與就拒（`:240-244`）。
 * 3. 從存檔讀回，比 header 與那一顆（`:245-258`）。理由照 dsh `:245`：「有排空者參與」證明不了這一份有落盤的寫者——
 *    排空者對不歸它寫的日誌照樣算參與（`session-persistence.ts` 的 `onFlush` 那一支）。
 *
 * ## 偏離
 *
 * - **header 只比 `id`**（理由 1，基座表達不出來）：dsh 比 `[id, createdAt, cwd]` 三格，兩邊都有 header
 *   （`live.header`）。我們的 `SessionLog` 身上沒有 header，header 只活在存檔那一側（`attachSessionPersistence` 建、或續接
 *   時讀回來的那份），沒有活的那一份可以比。**退到**：比 `id`，加上按 `seq` 取的那一顆逐欄相等。
 * - **讀回整份**（卡上 #1606 定的）：dsh 用範圍讀（`handle.read(last.seq, 1)`）；我們的 `ReadonlyStoredSession.read()` 只能讀整份
 *   （`session-store.ts`）。評分是低頻操作，不為它另加範圍讀。
 *
 * @module
 */

import { isDeepStrictEqual } from 'node:util';

import type { SessionLog } from './session-log.js';
import type { SessionRegistry } from './session-registry.js';
import type { SessionStore } from './session-store.js';

/**
 * 排空這一份、從存檔讀回、比對。
 *
 * @param sessions - 這一份日誌所屬的註冊表。
 * @param store - 落盤的那一個 store；只用它的唯讀打開。
 * @param log - 要確認的那一份。
 * @throws 沒有排空者參與、存檔裡沒有這一份、讀回的 header 或那一顆對不上，或排空本身失敗（原樣往外拋）。
 */
export async function checkpointSession(
  sessions: SessionRegistry,
  store: Pick<SessionStore, 'open'>,
  log: SessionLog,
): Promise<void> {
  // 先記、後 await（dsh `:239`）。
  const last = log.events.at(-1);
  const id = log.sessionId;
  if (!(await sessions.flush(log))) {
    throw new Error(`會話 "${id}" 沒有任何落盤的排空者參與，不是耐久的`);
  }
  let stored: Awaited<ReturnType<SessionStore['open']>>;
  try {
    stored = await store.open(id, 'read');
  } catch (error) {
    throw new Error(`會話 "${id}" 在存檔裡打不開，不是耐久的`, { cause: error });
  }
  const events = await stored.read();
  if (stored.header.id !== id) {
    throw new Error(`會話 "${id}" 讀回的存檔是 "${stored.header.id}"，不是耐久的`);
  }
  if (last !== undefined && !isDeepStrictEqual(events[last.seq], last)) {
    throw new Error(`會話 "${id}" 讀回的第 ${String(last.seq)} 顆對不上，不是耐久的`);
  }
}
