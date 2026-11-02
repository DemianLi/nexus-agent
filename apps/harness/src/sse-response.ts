/**
 * 下行的 SSE `Response`：把一條事件產生器接成 `text/event-stream`。從 [`wire-handler.ts`](./wire-handler.ts) 原樣搬出來（`pull` 以外的
 * 部分一字未改），為了能直接用一個會拋的 `encode` 測 `pull` 這一層（#1560 N1384）。
 *
 * @module
 */

/** {@link sseResponse} 的選項。 */
export interface SseResponseOptions<T> {
  /** warn 裡指名這條線：`thread <id>` 或 `全域下行`。 */
  readonly where: string;
  /** 拋錯那一顆的標籤（事件的 `method`、frame 的 `type`）。**只寫這個，不寫內容。** */
  readonly describe: (value: T) => string;
  /** 伺服器日誌（warn 級）。 */
  readonly warn?: (message: string) => void;
}

/**
 * 開一條 SSE 回應。
 *
 * **`pull` 裡 `encode` 拋錯**（#1560 N1384）：以前 `pull` reject，ReadableStream 進入 errored，而 `cancel()` 不會被叫（它只在讀者主動取消時跑），
 * 產生器停在 `yield`、`finally` 永遠不跑——那是 `#subscribers.delete` 唯一的地方。現在接住：記一行 warn（路徑、標籤，不寫內容）、
 * `events.return()` 讓產生器的 `finally` 跑、`controller.error(error)` 結束這條線（沒有終止 frame，偏離 C 見 `bounded-event-queue.ts`）。
 *
 * 實務上 `ThreadPump`／`ThreadFeed` 廣播與補送時已經 `JSON.stringify` 過同一顆（`boundFrame`），所以這一層是防禦：`encode` 會拋、
 * 前面卻沒拋的情形（兩次序列化結果不同的值）才走得到。
 */
export function sseResponse<T>(
  events: AsyncGenerator<T, void, undefined>,
  encode: (value: T) => string,
  options: SseResponseOptions<T>,
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // **開線就先吐一行 SSE 註解。** 沒有這一行的話，中間任何一層代理都可能把
      // header 壓著等第一顆 body byte——實測 Vite dev server 的 proxy 正是如此：
      // 直連拿得到 `200 text/event-stream`，經過它就一個位元組都不來，而瀏覽器那端
      // 看起來就是永遠「連線中」。**這一行今天的依據就是那次實測**——dsh 當初的
      // `sseResponse()` 也這樣做（「Send an SSE comment line on open so
      // clients/proxies see a live channel」），但那個套件在 HEAD `0a53fb55` 已經
      // 不在了，見 `wire-handler.ts` 檔頭。註解不是封包，解碼端本來就會跳過它。
      controller.enqueue(encoder.encode(': connected\n\n'));
    },
    async pull(controller) {
      const next = await events.next();
      if (next.done === true) {
        controller.close();
        return;
      }
      let text: string;
      try {
        text = encode(next.value);
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.name : typeof error;
        options.warn?.(
          `[下行] ${options.where} 有一顆 ${labelOf(options, next.value)} 無法編成 SSE，已斷開這一條（${reason}）`,
        );
        void events.return(undefined);
        controller.error(error);
        return;
      }
      controller.enqueue(encoder.encode(text));
    },
    cancel() {
      void events.return(undefined);
    },
  });
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      // 代理層常見的 SSE 緩衝會把「串流」變成「一次吐完」，這一行是關掉它的慣例。
      'x-accel-buffering': 'no',
    },
  });
}

/** 標籤本身也不能把 `pull` 弄壞：`describe` 拋錯就退成固定字串。 */
function labelOf<T>(options: SseResponseOptions<T>, value: T): string {
  try {
    return options.describe(value);
  } catch {
    return '事件';
  }
}
