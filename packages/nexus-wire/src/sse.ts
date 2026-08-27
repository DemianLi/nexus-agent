/**
 * SSE 的編解碼——線的兩端共用同一份。
 *
 * 這個「共用」是照 dsh 的做法：它把 SSE 的 frame 解碼放在**共用**的
 * `AbstractApiClient`，而不是讓每個載體各寫一份；`WebApiClient` 覆寫成 WS 時
 * 換掉的是載體，不是這一層。所以之後補 WebSocket 覆寫的話，動的不是這個檔。
 *
 * 一顆 frame 的形狀：
 *
 * ```
 * id: <thread>:<seq>
 * event: <method>
 * data: <整顆 Event 的 JSON>
 *
 * ```
 *
 * `data` 放整顆 `Event` 而不是只放 `params`，是因為協定的消費者要的是封包本身；
 * `id` 與 `event` 是給 SSE 那一層看的重複資訊，方便瀏覽器端的除錯與代理層的處理。
 */

import type { Event } from './protocol.js';

const FRAME_SEPARATOR = '\n\n';

/** 一顆 `Event` 編成一段 SSE frame。 */
export function encodeSseFrame(event: Event): string {
  const lines: string[] = [];
  if (event.event_id !== undefined) {
    lines.push(`id: ${event.event_id}`);
  }
  lines.push(`event: ${event.method}`);
  // JSON.stringify 不會吐出裸 \n，所以 data 永遠是單行；多行 data 的拼接規則
  // 因此用不到，也就不實作——真的需要時它是這個檔的事。
  lines.push(`data: ${JSON.stringify(event)}`);
  return `${lines.join('\n')}${FRAME_SEPARATOR}`;
}

/** SSE 的註解行（`:` 開頭）。目前只在解碼端認得，我們自己不發心跳。 */
function isComment(line: string): boolean {
  return line.startsWith(':');
}

/**
 * 把一段 SSE 位元流解回 `Event`。
 *
 * 吃的是 `Response.body` 那種 `ReadableStream<Uint8Array>`——**streaming fetch，
 * 不是 `EventSource`**。這一點也照 dsh（`packages/host/apiproxy/src/fetch/client.ts`）：
 * `EventSource` 只能 GET、不能帶 body，而協定規定下行是 `POST … /stream` 帶
 * `EventStreamRequest`，兩者接不上。
 */
export async function* decodeSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Event, void, undefined> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let index = buffer.indexOf(FRAME_SEPARATOR);
      while (index !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + FRAME_SEPARATOR.length);
        const event = parseFrame(frame);
        if (event !== undefined) {
          yield event;
        }
        index = buffer.indexOf(FRAME_SEPARATOR);
      }
    }
  } finally {
    // 消費端提早 break 時要放掉底層的 reader，否則連線會掛著不收。
    reader.releaseLock();
  }
}

function parseFrame(frame: string): Event | undefined {
  const data = frame
    .split('\n')
    .filter((line) => !isComment(line) && line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart())
    .join('');
  if (data === '') {
    return undefined;
  }
  return JSON.parse(data) as Event;
}
