/**
 * 瀏覽器與 harness 的時鐘差（#1308）。
 *
 * 投影上的時刻（`turn/start` 的 `time`）是 server 的 `Date.now()`；瀏覽器拿自己的 `Date.now()` 去減，兩邊不是同一個時鐘時
 * （多人共用主機、SSH 轉 port）差幾分鐘就顯示錯幾分鐘。**不動 harness**：每個回應本來就帶 HTTP `Date` 標頭（`node:http`
 * 預設會蓋，秒級），拿它換算偏移。
 *
 * 一筆樣本給的是一個區間，不是一個點：標頭寫 `D`，server 產生回應的那一刻落在 `[D, D + 1000)`；那一刻在瀏覽器的時鐘上落在
 * 「送出」與「拿到標頭」之間。所以 `offset = server − browser` 落在 `(D − 收到, D + 1000 − 送出)`。多筆取交集，越收越準；
 * 交集變空（某一邊的時鐘被調過）就從最新那一筆重來。估計值取區間中點。
 *
 * 跨源時（開發模式用 `VITE_AGENT_BASE_URL` 指到別的 port）`Date` 不在 CORS safelisted 標頭裡，讀到 null，就沒有樣本——
 * 沒有樣本時 {@link ServerClock.offset} 是 `undefined`，用它的人不顯示，不猜 0。
 */

/** 標頭秒級：server 的那一刻落在標頭所寫那一秒的這麼多毫秒之內。 */
const DATE_RESOLUTION_MS = 1000;

export interface ServerClock {
  /** 記一筆：`date` 是回應的 `Date` 標頭，`sentAt`／`receivedAt` 是瀏覽器的 `Date.now()`。讀不懂的標頭不算。 */
  observe(date: string | null | undefined, sentAt: number, receivedAt: number): void;
  /** `server − browser` 的估計（毫秒）；還沒有樣本是 `undefined`。 */
  offset(): number | undefined;
  /** server 現在幾點；還沒有樣本是 `undefined`。 */
  now(): number | undefined;
  /** 清掉樣本（測試用）。 */
  reset(): void;
}

export function createServerClock(): ServerClock {
  let low: number | undefined;
  let high: number | undefined;
  const offset = () => (low === undefined || high === undefined ? undefined : (low + high) / 2);
  return {
    observe(date, sentAt, receivedAt) {
      if (date === null || date === undefined) return;
      const serverAt = Date.parse(date);
      if (Number.isNaN(serverAt) || receivedAt < sentAt) return;
      const sampleLow = serverAt - receivedAt;
      const sampleHigh = serverAt + DATE_RESOLUTION_MS - sentAt;
      if (low === undefined || high === undefined) {
        low = sampleLow;
        high = sampleHigh;
        return;
      }
      const nextLow = Math.max(low, sampleLow);
      const nextHigh = Math.min(high, sampleHigh);
      if (nextLow <= nextHigh) {
        low = nextLow;
        high = nextHigh;
      } else {
        low = sampleLow;
        high = sampleHigh;
      }
    },
    offset,
    now() {
      const current = offset();
      return current === undefined ? undefined : Date.now() + current;
    },
    reset() {
      low = undefined;
      high = undefined;
    },
  };
}

/** 這個分頁連的那一台 harness。{@link clockedFetch} 預設記到這裡。 */
export const serverClock: ServerClock = createServerClock();

/**
 * 包一層 `fetch`：每個回應拿到標頭時記一筆 `Date`。**每次呼叫才讀 `globalThis.fetch`**（測試會在不同時機換掉它），不碰 body，
 * 讀標頭失敗也不影響回應。
 */
export function clockedFetch(clock: ServerClock = serverClock): typeof globalThis.fetch {
  return async (input, init) => {
    const sentAt = Date.now();
    const response = await globalThis.fetch(input, init);
    try {
      clock.observe((response.headers as Headers | undefined)?.get?.('date'), sentAt, Date.now());
    } catch {
      // 假的回應、怪的標頭物件：沒有樣本而已。
    }
    return response;
  };
}
