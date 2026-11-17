/**
 * 伺服器拒絕時的 wire 錯誤碼 → 給使用者看的那一句。加新碼只改 {@link REFUSALS} 的一列。
 *
 * **不顯示 server 的 message**：那些句子寫了上限、日誌、id、行程與重啟這類給管理者或接 wire 的人看的用語，使用者看不懂也動不了；
 * 原文只留在 serve 的日誌。每一句只寫一份，各處共用。認的是型別錯誤上的碼，不解析訊息（#1481）。
 *
 * 每列的 `permanent`：下行接上被拒時，是不是永久的（同一份資料重試幾次都一樣）。永久的下行不排重試、打開時讀的那幾樣也不重讀
 * （`shared/connection/use-conversation.ts`、`shared/connection/use-open-read.ts`）；暫時的照重試走。
 *
 * 每列的 `during`：那一句在哪些時刻講得通，不在其中的時刻不認，回 `undefined`，由呼叫端照自己原本的講法。
 *
 * @module
 */

import {
  SERVER_CLOSING,
  THREAD_AT_CAPACITY,
  THREAD_DELETED,
  THREAD_HISTORY_TOO_DEEP,
  THREAD_IS_SUBAGENT,
  THREAD_LOG_BUSY,
  THREAD_LOG_TOO_LARGE,
  THREAD_NOT_EMBEDDED,
  THREAD_NOT_OWNED,
  THREAD_ROOT_MISMATCH,
  THREAD_WRITER_HELD,
} from '@nexus/wire';

/** 被拒的那一刻在做什麼：打開會話（下行接上）、送東西上去（送出、斜線命令、叫醒子代理）、讀或管理（讀歷史、改名這類）。 */
export type RefusalMoment = 'opening' | 'sending' | 'reading';

export interface Refusal {
  readonly text: string;
  /** 下行接上被拒時，是不是永久的：永久的不排重試。 */
  readonly permanent: boolean;
}

interface Row {
  readonly text: string;
  readonly permanent: boolean;
  readonly during: readonly RefusalMoment[];
}

const ANYTIME: readonly RefusalMoment[] = ['opening', 'sending', 'reading'];

/** 這條會話因為 serve 的 thread 數滿了而打不開（#1476、#1478）。提管理者，不提上限數字，也不提重啟。 */
export const THREAD_AT_CAPACITY_TEXT = '目前開著的會話太多，這條會話暫時打不開。請聯絡管理者。';

/** 歷史太深、灌不回狀態（#1668、#1753）。講是歷史的形狀，指向使用者做得到的下一步；不提層數、上限、thread 或日誌。 */
export const THREAD_HISTORY_TOO_DEEP_TEXT =
  '這條對話的歷史裡有內容巢狀太深，打不開。請開新的對話。';

/** 紀錄太大、這台伺服器讀不進來（#2115、#2203）。說對話沒有壞，指向管理者；不提數字、額度或日誌。 */
export const THREAD_LOG_TOO_LARGE_TEXT =
  '這條對話的紀錄太大，這台伺服器現在讀不進來。對話沒有壞，請聯絡管理者。';

/** 額度被別的會話佔滿（#2203）。說對話沒有壞、可以再試；不提數字、額度或日誌。 */
export const THREAD_LOG_BUSY_TEXT =
  '伺服器現在開著的對話佔滿了記憶體，這條暫時打不開。對話沒有壞，稍後再試；一直打不開請聯絡管理者。';

/** 寫租約被別的寫入者握著（#2031、#2214）。說對話沒有壞、下一步是什麼；不提 id、行程或寫入者。 */
export const THREAD_WRITER_HELD_TEXT =
  '這條對話正在別的地方開著，這裡暫時打不開。對話沒有壞，那邊關掉之後再試；一直打不開請聯絡管理者。';

/**
 * 可寫根這台 serve 接不上：會話開在另一個 home，或跑在另一個 `--workspace`（#2222）。一句涵蓋兩種，web 分不出也不必分。
 * 說對話沒有壞、要回原本那邊，指向管理者；用的人不知道 home 與工作區這些詞，一律說「環境」，也不提路徑或 id。
 */
export const THREAD_ROOT_MISMATCH_TEXT =
  '這條對話是在別的環境開的，這裡打不開。對話沒有壞，要回原本的環境才打得開，請聯絡管理者。';

/** 這條會話被刪掉了（#2957、#2958），多半是在別的頁籤刪的。指向側欄的「最近刪除」；不提寬限天數，天數在那一區顯示。 */
export const THREAD_DELETED_TEXT =
  '這條對話已經刪除了，打不開。寬限期內可以從側欄的「最近刪除」復原，或按「新對話」開一條新的。';

/** serve 正在收尾、不收新的一輪（#1787、#1995）。講的是話或命令都適用，所以不說「這句話」。 */
export const SERVER_CLOSING_TEXT = '伺服器正在重新啟動，這次沒有送出。請稍後再送一次。';

/** 這個 id 是子代理的會話，serve 不讓它當一條 thread 開（#1544、#1708）。指回主對話，不提 thread、wire 或命令名。 */
export const THREAD_IS_SUBAGENT_TEXT = '這是子代理的對話，請從主對話查看。';

/**
 * 嵌入的對話框打開一條從獨立頁面開的 thread（#2367、#2382）。嵌入版設定檔綁在 thread 上。
 * 說對話沒有壞、這裡接不了，叫人開新的；不提 thread、嵌入或設定檔這些詞。
 */
export const THREAD_NOT_EMBEDDED_TEXT =
  '這條對話是在完整的對話頁開的，這裡接不了。對話沒有壞，請按「新對話」開一條新的。';

/** 嵌入的對話框打開一條不是這位使用者開的對話（#2370）。不說是誰的，叫人開新的；不提 thread、擁有者或登入這些詞。 */
export const THREAD_NOT_OWNED_TEXT = '這不是你的對話，這裡打不開。請按「新對話」開一條新的。';

const REFUSALS: ReadonlyMap<string, Row> = new Map<string, Row>([
  [THREAD_AT_CAPACITY, { text: THREAD_AT_CAPACITY_TEXT, permanent: false, during: ANYTIME }],
  [
    THREAD_HISTORY_TOO_DEEP,
    // 同一份日誌每次都一樣深。
    { text: THREAD_HISTORY_TOO_DEEP_TEXT, permanent: true, during: ANYTIME },
  ],
  [
    THREAD_LOG_TOO_LARGE,
    // 要管理者調額度或加記憶體後重啟。
    { text: THREAD_LOG_TOO_LARGE_TEXT, permanent: true, during: ANYTIME },
  ],
  [
    THREAD_LOG_BUSY,
    // 別條會話關掉或閒置逐出後就可能放得下。
    { text: THREAD_LOG_BUSY_TEXT, permanent: false, during: ANYTIME },
  ],
  [
    THREAD_WRITER_HELD,
    // 握著的那一方放掉之後再開就開得起來。
    { text: THREAD_WRITER_HELD_TEXT, permanent: false, during: ANYTIME },
  ],
  [
    THREAD_ROOT_MISMATCH,
    // 換這台怎麼試結果都一樣。
    { text: THREAD_ROOT_MISMATCH_TEXT, permanent: true, during: ANYTIME },
  ],
  [
    THREAD_DELETED,
    // 已刪除的，復原之前重試幾次都一樣。刪除進行中也回這個碼（最後沒做成的話其實打得開），少見，一樣當永久。
    { text: THREAD_DELETED_TEXT, permanent: true, during: ANYTIME },
  ],
  [
    SERVER_CLOSING,
    // `run.start`、`slash.run`、`subagent.send` 三條上行共用；下行接上不會碰到它。
    { text: SERVER_CLOSING_TEXT, permanent: false, during: ['sending'] },
  ],
  [
    THREAD_IS_SUBAGENT,
    // 子代理的會話重試幾次都一樣；只有打開會話會碰到。
    { text: THREAD_IS_SUBAGENT_TEXT, permanent: true, during: ['opening'] },
  ],
  [
    THREAD_NOT_EMBEDDED,
    // 嵌入版設定檔綁在 thread 上，重試幾次都一樣。
    { text: THREAD_NOT_EMBEDDED_TEXT, permanent: true, during: ['opening'] },
  ],
  [
    THREAD_NOT_OWNED,
    // 擁有者寫在對話上，重試幾次都一樣。
    { text: THREAD_NOT_OWNED_TEXT, permanent: true, during: ['opening'] },
  ],
]);

/** 這個碼在這一刻有專用文案就回它與永久與否，沒有（不認得、沒有碼、這一刻講不通）回 `undefined`，由呼叫端照自己原本的講法。 */
export function refusal(code: string | undefined, during: RefusalMoment): Refusal | undefined {
  if (code === undefined) return undefined;
  const row = REFUSALS.get(code);
  if (row === undefined || !row.during.includes(during)) return undefined;
  return { text: row.text, permanent: row.permanent };
}

/** 只要那一句的 {@link refusal}，給不分永久或暫時的地方用。 */
export function refusalText(code: string | undefined, during: RefusalMoment): string | undefined {
  return refusal(code, during)?.text;
}
