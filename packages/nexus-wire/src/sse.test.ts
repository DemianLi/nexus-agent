import { describe, expect, it } from 'vitest';
import type { Event } from './protocol.js';
import { decodeSseStream, encodeSseFrame } from './sse.js';

/**
 * SSE 編解碼——線的兩端共用的那一份。
 *
 * 這裡驗的是位元流層面的事：一顆 frame 的樣子、以及**切在任意位置的位元組**都能拼回來。
 * 後者不是理論問題：真實的 `Response.body` 想在哪裡切就在哪裡切，而我們的解碼器是
 * 自己拿 `getReader()` 手動拼的。
 */

function event(seq: number, method: string, text: string): Event {
  return {
    type: 'event',
    seq,
    event_id: `t:${seq}`,
    method,
    params: { namespace: [], timestamp: 0, data: { text } },
  } as Event;
}

/** 把一段字串按指定大小切塊餵進去，模擬任意的網路切割。 */
function streamOf(payload: string, chunkSize: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(payload);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Event[]> {
  const events: Event[] = [];
  for await (const decoded of decodeSseStream(stream)) {
    events.push(decoded);
  }
  return events;
}

describe('SSE codec', () => {
  it('一顆 frame 帶 id、event 與整顆封包', () => {
    const frame = encodeSseFrame(event(3, 'messages', '哈囉'));
    expect(frame).toBe(
      'id: t:3\nevent: messages\ndata: {"type":"event","seq":3,"event_id":"t:3","method":"messages","params":{"namespace":[],"timestamp":0,"data":{"text":"哈囉"}}}\n\n',
    );
  });

  it('切在任何位置都拼得回來', async () => {
    const events = [
      event(0, 'lifecycle', '一'),
      event(1, 'messages', '二'),
      event(2, 'tools', '三'),
    ];
    const payload = events.map(encodeSseFrame).join('');
    // 1 個位元組一塊是最壞情況：多位元組的中文字會被切開，frame 分隔線也會被切開。
    for (const chunkSize of [1, 3, 17, payload.length]) {
      expect(await drain(streamOf(payload, chunkSize))).toEqual(events);
    }
  });

  it('註解行（心跳）不會變成封包', async () => {
    const payload = `: keep-alive\n\n${encodeSseFrame(event(0, 'lifecycle', '一'))}`;
    expect(await drain(streamOf(payload, 5))).toEqual([event(0, 'lifecycle', '一')]);
  });

  it('沒收完的最後一段不會吐出半顆', async () => {
    const complete = encodeSseFrame(event(0, 'lifecycle', '一'));
    const payload = `${complete}event: messages\ndata: {"type":"eve`;
    expect(await drain(streamOf(payload, 4))).toEqual([event(0, 'lifecycle', '一')]);
  });
});
