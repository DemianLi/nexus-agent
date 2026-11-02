import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';
import type { Event } from './protocol.js';
import { WireProtocolError } from './protocol-error.js';
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

describe('真的 fetch 的 body', () => {
  it('開線之後、第一次 next() 之前 Response 被回收：下行照樣收得到 frame', async () => {
    // 不必另加執行旗標就拿到 `gc`：開旗標後在新的 context 裡取。
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const frame = encodeSseFrame(event(0, 'messages', '還在'));
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': connected\n\n');
      // 第一顆 frame 晚一點才來，跟真的 server 一樣：要等上行送出去。
      setTimeout(() => response.end(frame), 100);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      // 只留 generator，`Response` 物件在這個函式回來之後就沒人拿著——跟 `openEvents` 一樣。
      const open = async () => decodeSseStream((await fetch(`http://127.0.0.1:${port}/`)).body!);
      const events = await open();
      for (let i = 0; i < 5; i += 1) {
        gc();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const first = await events.next();
      expect(first.done).toBe(false);
      expect(first.value).toEqual(event(0, 'messages', '還在'));
      await events.return(undefined);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

/**
 * 信封驗證（[#1555](https://github.com/DemianLi/nexus-agent/issues/1555) N0758）：每一顆先驗再交出去，壞的拋 `WireProtocolError`。
 * 以前 `as Event` 直接交出去：缺 `params` 的進折疊器炸成 `TypeError`，`"seq": "7"` 則靜靜壞掉去重。
 */
describe('SSE 解碼：信封驗證', () => {
  const good = (): Record<string, unknown> => ({ ...event(1, 'messages', 'x') });

  function frame(value: unknown): string {
    return `data: ${JSON.stringify(value)}\n\n`;
  }

  async function failure(payload: string): Promise<unknown> {
    return drain(streamOf(payload, 64)).then(
      () => undefined,
      (error: unknown) => error,
    );
  }

  it.each([
    ['seq 是字串 "7"', { ...good(), seq: '7' }, 'seq'],
    ['seq 是負數', { ...good(), seq: -1 }, 'seq'],
    ['seq 不是整數', { ...good(), seq: 1.5 }, 'seq'],
    ['seq 超過安全整數', { ...good(), seq: Number.MAX_SAFE_INTEGER + 1 }, 'seq'],
    [
      '缺 params（今天丟的是折疊器裡的 TypeError）',
      { type: 'event', method: 'messages' },
      'params',
    ],
    ['params 是陣列', { ...good(), params: [] }, 'params'],
    ['namespace 不是陣列', { ...good(), params: { namespace: 'a', data: {} } }, 'params.namespace'],
    [
      'namespace 裡有非字串',
      { ...good(), params: { namespace: ['a', 1], data: {} } },
      'params.namespace',
    ],
    ['缺 data（照 dsh：data 要存在）', { ...good(), params: { namespace: [] } }, 'params.data'],
    ['type 不是 event', { ...good(), type: 'success' }, 'type'],
    ['method 不是字串', { ...good(), method: 1 }, 'method'],
    ['event_id 不是字串', { ...good(), event_id: 7 }, 'event_id'],
  ])('%s：拋 WireProtocolError，field 指名欄位', async (_label, value, field) => {
    const error = await failure(frame(value));
    expect(error).toBeInstanceOf(WireProtocolError);
    expect((error as WireProtocolError).field).toBe(field);
  });

  it('seq 是 -0：拋（JSON 的 -0 解出來是 -0，dsh 同樣拒）', async () => {
    const error = await failure(
      `data: ${JSON.stringify(good()).replace('"seq":1', '"seq":-0')}\n\n`,
    );
    expect(error).toBeInstanceOf(WireProtocolError);
    expect((error as WireProtocolError).field).toBe('seq');
  });

  it('不是 JSON：同樣是 WireProtocolError，field 是 data，原始的錯在 cause', async () => {
    const error = await failure('data: {不是 json\n\n');
    expect(error).toBeInstanceOf(WireProtocolError);
    expect((error as WireProtocolError).field).toBe('data');
    expect((error as WireProtocolError).cause).toBeInstanceOf(SyntaxError);
  });

  it('只有 data:null 之類的非物件：拋，field 是 event', async () => {
    const error = await failure(frame(null));
    expect((error as WireProtocolError).field).toBe('event');
  });

  it('合格的照常交出：多出的欄位不拒（協定是 Extensible）；data 是 null 放行；歷史不帶 seq', async () => {
    const extra = { ...good(), futureField: { a: 1 } };
    const nullData = { type: 'event', method: 'custom', params: { namespace: ['n'], data: null } };
    const noSeq = { type: 'event', method: 'lifecycle', params: { namespace: [], data: {} } };
    const payload = [extra, nullData, noSeq].map(frame).join('');
    expect(await drain(streamOf(payload, 7))).toEqual([extra, nullData, noSeq]);
  });

  it('只有註解行（心跳）的 frame 吐出 0 顆，不驗、不拋', async () => {
    expect(await drain(streamOf(': ping\n\n: connected\n\n: ping\n\n', 3))).toEqual([]);
  });

  it('壞的那一顆之前的好的照常交出；之後的不讀', async () => {
    const payload = frame(good()) + frame({ ...good(), seq: 'x' }) + frame(good());
    const got: Event[] = [];
    let thrown: unknown;
    try {
      for await (const decoded of decodeSseStream(streamOf(payload, payload.length)))
        got.push(decoded);
    } catch (error) {
      thrown = error;
    }
    expect(got).toHaveLength(1);
    expect(thrown).toBeInstanceOf(WireProtocolError);
  });

  // 終止類的錯沒有人再來讀 body：不取消的話連線掛著，server 那側也收不到線已經沒人要了。
  it('拋 WireProtocolError 的同時取消底層的串流', async () => {
    let cancelled: unknown;
    const bytes = new TextEncoder().encode(frame({ ...good(), seq: 'x' }));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
      },
      cancel(reason: unknown) {
        cancelled = reason;
      },
    });
    await expect(drain(body)).rejects.toBeInstanceOf(WireProtocolError);
    expect(cancelled).toBeInstanceOf(WireProtocolError);
  });
});
