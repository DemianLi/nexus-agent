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
import { assertWireEvent } from './protocol.js';
import { WireProtocolError } from './protocol-error.js';

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

/**
 * 一顆全域下行的 frame 編成一段 SSE frame（#632）。沒有 `id:`：那條線不重播，也沒有號。
 *
 * @param event - `event:` 欄位，給 SSE 那一層與除錯看的重複資訊，同 {@link encodeSseFrame}。
 * @param data - 整顆 frame，JSON 編進 `data:`。
 */
export function encodeSseData(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}${FRAME_SEPARATOR}`;
}

/**
 * SSE 的註解行（`:` 開頭）。解碼端跳過它；伺服器端的心跳（`: ping`，#1504，寫在 `apps/harness/src/wire-server.ts`）
 * 與開線的 `: connected` 都是這種行，所以這個檔不產生心跳，只負責認得它不是封包。
 */
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
 *
 * **body 在呼叫的當下就鎖住，不等第一次 `next()`。** generator 的本體要到第一次 `next()` 才開跑；body 在那之前
 * 沒鎖、也沒讀過的話，Node 內建的 fetch（undici）會在 `Response` 物件被回收時把它 `cancel` 掉
 * （`streamRegistry`：`!stream.locked && !isDisturbed(stream)` 就 `cancel("Response object has been garbage
 * collected")`），之後的 `read()` 只拿到乾淨的 `done`——下行一顆 frame 都沒有就「結束」了，server 那側毫無動靜。
 * 開下行之後先拿歷史、再送上行，正好是那段空檔；負載一大 GC 就落進去（serve-history 的測試在整套跑時穩定紅，
 * 強制 GC 可以每次重現）。瀏覽器沒有這條回收規則，但早鎖對它無害。
 *
 * **每一顆都先驗信封**（{@link assertWireEvent}，[#1555](https://github.com/DemianLi/nexus-agent/issues/1555)）：解不開的 JSON、缺欄位、
 * `seq` 不是安全非負整數，都拋 {@link WireProtocolError}（`field` 指名哪個欄位），而且**這時就把底層的 reader 取消**，連線不掛著。
 * 以前直接 `as Event`，壞的進了折疊器才炸成 `TypeError`，`"seq": "7"` 這種則是靜靜壞掉去重。
 *
 * @param body - 下行回應的 body。
 * @returns 一顆一顆的 `Event`。
 * @throws {WireProtocolError} 某一顆的形狀不對。
 */
export function decodeSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Event, void, undefined> {
  return decodeFrames(body.getReader(), parseEvent) as AsyncGenerator<Event, void, undefined>;
}

/**
 * 同 {@link decodeSseStream}，但 `data` 只解成 JSON、不假設是 `Event`——給全域下行用（#632），那條線的 frame 由
 * 呼叫端驗。**body 一樣在呼叫的當下就鎖住**，理由同上。
 *
 * @param body - 下行回應的 body。
 * @returns 一顆一顆 `data` 解出來的值。
 */
export function decodeSseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown, void, undefined> {
  return decodeFrames(body.getReader(), parseJson);
}

async function* decodeFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  parse: (frame: string) => unknown,
): AsyncGenerator<unknown, void, undefined> {
  const decoder = new TextDecoder();
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
        let event: unknown;
        try {
          event = parse(frame);
        } catch (error) {
          // 協定錯誤是終止類：不會有人再來讀這條 body，取消它，連線才不會掛著。
          if (error instanceof WireProtocolError) await reader.cancel(error).catch(() => undefined);
          throw error;
        }
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

/** 一段 SSE frame 的 `data:` 行接起來；沒有 `data`（心跳、註解）回 `undefined`。 */
function dataOf(frame: string): string | undefined {
  const data = frame
    .split('\n')
    .filter((line) => !isComment(line) && line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart())
    .join('');
  return data === '' ? undefined : data;
}

/** 全域下行：只解 JSON，frame 由呼叫端驗。 */
function parseJson(frame: string): unknown {
  const data = dataOf(frame);
  return data === undefined ? undefined : (JSON.parse(data) as unknown);
}

/** thread 下行：解 JSON 再驗信封，兩種不對都是 {@link WireProtocolError}。 */
function parseEvent(frame: string): unknown {
  const data = dataOf(frame);
  if (data === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch (cause) {
    throw new WireProtocolError('data', '下行事件的 data 不是合法的 JSON', { cause });
  }
  assertWireEvent(value);
  return value;
}
