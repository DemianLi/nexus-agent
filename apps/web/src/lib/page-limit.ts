/**
 * 預覽的文字頁回 413 之後，下一次要送多少 `limit`（[#555](https://github.com/DemianLi/nexus-agent/issues/555)）。
 *
 * ## 413 分不出成因
 *
 * 路由一頁最多 `maxLines` 行、`maxBytes` 位元組（預設 5000 行、2 MiB），超過就是 413，**拒絕不是截斷**。
 * 每行平均超過約 420 位元組，一頁就會超過 2 MiB——不需要任何一行超長。所以 413 可能是「這一行本身太長」，
 * 也可能是「這一段中長的行太多」。先縮 `limit` 才分得出來：縮到 1 還是 413，就是這一行本身超過上限，
 * 改走位元組窗口（見 `deliverable-file.ts`）。
 *
 * ## 不知道 `maxLines` 的時候，送什麼都可能 400
 *
 * `maxLines` 是設定條目，web 看不到；送的 `limit` 比它大，路由回 400，畫面就變成「座標不對」
 * （[#543](https://github.com/DemianLi/nexus-agent/issues/543) 就是因為這樣才不送 `limit`）。安全的只有兩個事實：
 *
 * - **不送 `limit` 永遠不會 400**；讀到一頁沒到檔尾的，那一頁的 `lines` 就是 `maxLines`（{@link PageLimit.cap}）。
 * - **送 L 拿到 200，就證明 L ≤ `maxLines`**（{@link PageLimit.good}）。
 *
 * 所以：
 *
 * 1. 縮：從 `cap` 的一半往下對半縮；不知道 `cap` 時從 1 開始（1 在任何設定下都合法）。
 * 2. `cap` 還不知道時，第一次縮到讀得到之後，**下一頁先試一次不送 `limit`**——成功一次就知道 `cap`。
 * 3. 之後每讀到一頁就把 `limit` 加倍，碰到 `cap` 就恢復不送。**不在「不送」與 L 之間每頁來回切**：路由每一頁
 *    都從檔頭開始數行，多一次請求就多一次整段前綴的掃描。
 * 4. 加倍時回 400，只在「`cap` 還不知道、而這個 L 比證明過的大」時歸因成 L 超過 `maxLines`：同一個座標剛剛才用
 *    較小的 `limit` 讀到過，變的只有 `limit`。這一格在這裡消化掉，**不會變成畫面上的「座標不對」**。其他情況的
 *    400 照舊是 bug。
 *
 * 規則是在 #555 的 grilling 定的，其中第 2、4 條是實作前發現原規則會送出超過 `maxLines` 的 `limit` 後補的。
 * dsh 的文字預覽沒有這一段：它遇到 413 就停在「单页内容超过上限」。
 *
 * @module
 */

/** 一個檔的翻頁狀態。 */
export interface PageLimit {
  /** 下一個文字頁請求要送的 `limit`；`undefined` ＝不送。 */
  readonly limit: number | undefined;
  /** 已知的 `maxLines`，或一個已知不超過它的數；`undefined` ＝還不知道。 */
  readonly cap: number | undefined;
  /** 最後一次送 `limit` 並讀到的那個數。 */
  readonly good: number | undefined;
  /** `cap` 還不知道時，已經在縮過之後試過一次不送 `limit`。 */
  readonly probed: boolean;
}

export const INITIAL_PAGE_LIMIT: PageLimit = {
  limit: undefined,
  cap: undefined,
  good: undefined,
  probed: false,
};

/** 一次文字頁請求的結局，只挑這裡要分的幾種。 */
export type PageOutcome =
  | { readonly kind: 'page'; readonly lines: number; readonly eof: boolean }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'invalid' };

/**
 * 下一步：
 *
 * - `'retry'`：同一個 offset 用新的 `limit` 再讀一次。
 * - `'done'`：結果可以發布；新的狀態給後面的頁用。
 * - `'long-line'`：`limit=1` 還是 413，這一行本身超過上限，改走位元組窗口。
 * - `'invalid'`：真的 400，照舊是 bug。
 */
export type PageStep = {
  readonly next: 'retry' | 'done' | 'long-line' | 'invalid';
  readonly state: PageLimit;
};

/** 加倍，碰到 `cap` 就恢復不送。 */
function grow(state: PageLimit, from: number): number | undefined {
  const doubled = from * 2;
  return state.cap !== undefined && doubled >= state.cap ? undefined : doubled;
}

/**
 * 一次請求之後的下一步。
 *
 * @param state - 送出請求時的狀態；請求送的 `limit` 就是 `state.limit`。
 * @param outcome - 那次請求的結局。
 * @returns 下一步與新的狀態。
 */
export function stepPageLimit(state: PageLimit, outcome: PageOutcome): PageStep {
  const sent = state.limit;
  switch (outcome.kind) {
    case 'page': {
      if (sent === undefined) {
        // 不送 `limit`、又沒到檔尾：這一頁就是 `maxLines` 行。
        const cap = outcome.eof ? state.cap : outcome.lines;
        return { next: 'done', state: { ...state, cap } };
      }
      const good = sent;
      if (state.cap === undefined && !state.probed) {
        return { next: 'done', state: { ...state, good, limit: undefined, probed: true } };
      }
      return { next: 'done', state: { ...state, good, limit: grow(state, sent) } };
    }
    case 'too-large': {
      if (sent === 1) return { next: 'long-line', state: { ...state, limit: undefined } };
      const limit =
        sent !== undefined
          ? Math.floor(sent / 2)
          : state.cap !== undefined
            ? Math.max(1, Math.floor(state.cap / 2))
            : (state.good ?? 1);
      return { next: 'retry', state: { ...state, limit } };
    }
    case 'invalid': {
      const probing =
        sent !== undefined &&
        state.cap === undefined &&
        state.good !== undefined &&
        sent > state.good;
      if (!probing) return { next: 'invalid', state };
      return { next: 'retry', state: { ...state, cap: state.good, limit: state.good } };
    }
  }
}
