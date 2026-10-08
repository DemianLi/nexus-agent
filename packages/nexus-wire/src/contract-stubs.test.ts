/**
 * 契約先合、實作還沒做的三塊（#723 模型選擇、#732 上傳與收據、#437 權限組合）的 client 那一半：method 名字、路徑、封包形狀、
 * `not_supported` 怎麼到呼叫端。server 那一半在 `apps/harness` 的 `wire-contract-stubs.test.ts`。
 */

import { describe, expect, it } from 'vitest';

import type { UploadProgress, UploadXhr } from './client.js';

import { createWireClient } from './client.js';
import { isRpcMethod, commandPath } from './protocol.js';
import { uploadPath } from './attachments.js';

interface Seen {
  readonly url: string;
  readonly method: string | undefined;
  readonly contentType: string | null;
  readonly body: unknown;
}

function recording(respond: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  const client = createWireClient({
    baseUrl: 'http://agent.test/',
    fetch: async (input, init) => {
      const body = init?.body;
      const entry: Seen = {
        url: String(input),
        method: init?.method,
        contentType: new Headers(init?.headers).get('content-type'),
        body: typeof body === 'string' ? (JSON.parse(body) as unknown) : body,
      };
      seen.push(entry);
      return respond(entry);
    },
  });
  return { client, seen };
}

const notSupported = () =>
  Response.json({ type: 'error', id: 1, error: 'not_supported', message: '還沒做' });

describe('三塊新 method 都在 RPC 白名單裡', () => {
  it('model.catalog／model.select／permission.catalog', () => {
    for (const method of ['model.catalog', 'model.select', 'permission.catalog']) {
      expect(isRpcMethod(method), method).toBe(true);
    }
    expect(isRpcMethod('model.other')).toBe(false);
  });
});

describe('modelCatalog／selectModel／permissionCatalog', () => {
  it('送到 /commands/:method，封包的 method 與路徑一致，params 照契約', async () => {
    const { client, seen } = recording(() =>
      Response.json({ type: 'success', id: 1, result: { ok: true, value: {} } }),
    );
    await client.modelCatalog('t');
    await client.selectModel('t', { modelId: 'm', reasoningEffort: 'high' });
    await client.permissionCatalog('t');
    expect(seen.map((s) => [s.url, s.contentType, s.body])).toEqual([
      [
        `http://agent.test${commandPath('t', 'model.catalog')}`,
        'application/json',
        { id: 1, method: 'model.catalog', params: {} },
      ],
      [
        `http://agent.test${commandPath('t', 'model.select')}`,
        'application/json',
        { id: 2, method: 'model.select', params: { modelId: 'm', reasoningEffort: 'high' } },
      ],
      [
        `http://agent.test${commandPath('t', 'permission.catalog')}`,
        'application/json',
        { id: 3, method: 'permission.catalog', params: {} },
      ],
    ]);
  });

  it('業務結果照原樣交出；model_unavailable 在 result 裡，不是 rejected', async () => {
    const { client } = recording(() =>
      Response.json({
        type: 'success',
        id: 1,
        result: { ok: false, error: { code: 'model_unavailable', modelId: 'x' } },
      }),
    );
    expect(await client.selectModel('t', { modelId: 'x' })).toEqual({
      kind: 'ok',
      result: { ok: false, error: { code: 'model_unavailable', modelId: 'x' } },
    });
  });

  it('not_supported 是 rejected 帶碼，web 據此藏功能', async () => {
    const { client } = recording(notSupported);
    const expected = { kind: 'rejected', code: 'not_supported', message: '還沒做' };
    expect(await client.modelCatalog('t')).toEqual(expected);
    expect(await client.selectModel('t', { modelId: 'm' })).toEqual(expected);
    expect(await client.permissionCatalog('t')).toEqual(expected);
  });
});

describe('thread 釘選／封存／改名', () => {
  it('五支都在 RPC 白名單裡，送到 /commands/:method，params 照契約', async () => {
    for (const method of [
      'thread.pin',
      'thread.unpin',
      'thread.archive',
      'thread.unarchive',
      'thread.rename',
    ]) {
      expect(isRpcMethod(method), method).toBe(true);
    }
    expect(isRpcMethod('thread.delete')).toBe(false);
    const { client, seen } = recording(() =>
      Response.json({ type: 'success', id: 1, result: { ok: true, value: {} } }),
    );
    await client.threadPin('t');
    await client.threadUnpin('t');
    await client.threadArchive('t');
    await client.threadArchive('t', { stopActivity: true });
    await client.threadUnarchive('t');
    await client.threadRename('t', '新標題');
    expect(seen.map((s) => [s.url, s.body])).toEqual([
      [
        `http://agent.test${commandPath('t', 'thread.pin')}`,
        { id: 1, method: 'thread.pin', params: {} },
      ],
      [
        `http://agent.test${commandPath('t', 'thread.unpin')}`,
        { id: 2, method: 'thread.unpin', params: {} },
      ],
      // 省略 stopActivity 就不放這個 key：舊 server 與預設（不停活動）一致。
      [
        `http://agent.test${commandPath('t', 'thread.archive')}`,
        { id: 3, method: 'thread.archive', params: {} },
      ],
      [
        `http://agent.test${commandPath('t', 'thread.archive')}`,
        { id: 4, method: 'thread.archive', params: { stopActivity: true } },
      ],
      [
        `http://agent.test${commandPath('t', 'thread.unarchive')}`,
        { id: 5, method: 'thread.unarchive', params: {} },
      ],
      [
        `http://agent.test${commandPath('t', 'thread.rename')}`,
        { id: 6, method: 'thread.rename', params: { title: '新標題' } },
      ],
    ]);
  });

  it('業務失敗在 result 裡（thread_archived、thread_active、title_invalid），不是 rejected', async () => {
    const respondWith = (error: unknown) =>
      recording(() => Response.json({ type: 'success', id: 1, result: { ok: false, error } }))
        .client;
    expect(await respondWith({ code: 'thread_archived' }).threadPin('t')).toEqual({
      kind: 'ok',
      result: { ok: false, error: { code: 'thread_archived' } },
    });
    expect(await respondWith({ code: 'thread_active' }).threadArchive('t')).toEqual({
      kind: 'ok',
      result: { ok: false, error: { code: 'thread_active' } },
    });
    expect(await respondWith({ code: 'title_invalid' }).threadRename('t', '')).toEqual({
      kind: 'ok',
      result: { ok: false, error: { code: 'title_invalid' } },
    });
  });

  it('not_supported 是 rejected 帶碼', async () => {
    const { client } = recording(notSupported);
    const expected = { kind: 'rejected', code: 'not_supported', message: '還沒做' };
    expect(await client.threadPin('t')).toEqual(expected);
    expect(await client.threadRename('t', 'x')).toEqual(expected);
  });
});

describe('uploadFile', () => {
  it('POST 原始位元組，content-type 是 octet-stream，檔名走 name 查詢參數', async () => {
    const { client, seen } = recording(() =>
      Response.json({ type: 'success', result: { receiptId: 'r1', name: 'a.txt', bytes: 3 } }),
    );
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await client.uploadFile('t', bytes, '報告 a.txt')).toEqual({
      kind: 'ok',
      receipt: { receiptId: 'r1', name: 'a.txt', bytes: 3 },
    });
    const only = seen[0];
    expect(only?.url).toBe(
      `http://agent.test${uploadPath('t')}?${new URLSearchParams({ name: '報告 a.txt' })}`,
    );
    expect(only?.method).toBe('POST');
    expect(only?.contentType).toBe('application/octet-stream');
    expect(only?.body).toBe(bytes);
  });

  it('省略檔名就不帶查詢參數', async () => {
    const { client, seen } = recording(() =>
      Response.json({ type: 'success', result: { receiptId: 'r', name: 'n', bytes: 0 } }),
    );
    await client.uploadFile('t', new Uint8Array());
    expect(seen[0]?.url).toBe(`http://agent.test${uploadPath('t')}`);
  });

  it('not_supported 是 rejected；載體層的失敗拋；看不懂的收據拋', async () => {
    expect(await recording(notSupported).client.uploadFile('t', new Uint8Array())).toEqual({
      kind: 'rejected',
      code: 'not_supported',
      message: '還沒做',
    });
    const blocked = recording(() => new Response('unauthorized', { status: 401 })).client;
    await expect(blocked.uploadFile('t', new Uint8Array())).rejects.toThrow(
      '上傳被載體層擋下：401 unauthorized',
    );
    const odd = recording(() =>
      Response.json({ type: 'success', result: { receiptId: 1 } }),
    ).client;
    await expect(odd.uploadFile('t', new Uint8Array())).rejects.toThrow('不認得的收據');
  });
});

/** 假的 XHR：記下呼叫，測試手動觸發進度、完成、失敗。 */
class FakeXhr implements UploadXhr {
  readonly upload: UploadXhr['upload'] = { onprogress: null };
  status = 0;
  responseText = '';
  onload: UploadXhr['onload'] = null;
  onerror: UploadXhr['onerror'] = null;
  onabort: UploadXhr['onabort'] = null;
  opened: [string, string] | undefined;
  headers: Record<string, string> = {};
  sent: Blob | undefined;
  aborted = false;
  open(method: string, url: string): void {
    this.opened = [method, url];
  }
  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  send(body: Blob): void {
    this.sent = body;
  }
  abort(): void {
    this.aborted = true;
    this.onabort?.({});
  }
  progress(loaded: number, total?: number): void {
    this.upload.onprogress?.({
      loaded,
      total: total ?? 0,
      lengthComputable: total !== undefined,
    });
  }
  finish(status: number, body: string): void {
    this.status = status;
    this.responseText = body;
    this.onload?.({});
  }
}

const RECEIPT = JSON.stringify({
  type: 'success',
  result: { receiptId: 'r1', name: 'a.txt', bytes: 3 },
});

describe('uploadFile 的進度與取消（#732，簽名照 dsh file-upload）', () => {
  it('沒有 XHR（注入了 fetch）：送完報一次，loaded === total', async () => {
    const { client } = recording(() => Response.json(JSON.parse(RECEIPT) as object));
    const seen: UploadProgress[] = [];
    await client.uploadFile('t', new Uint8Array([1, 2, 3]), 'a.txt', undefined, (p) =>
      seen.push(p),
    );
    expect(seen).toEqual([{ loaded: 3, total: 3 }]);
  });

  it('Blob＋XHR：走 XHR（不走 fetch），進度單調不減、total 只在知道長度時才有', async () => {
    const xhr = new FakeXhr();
    let fetched = 0;
    const client = createWireClient({
      baseUrl: 'http://agent.test',
      fetch: async () => {
        fetched += 1;
        return new Response('不該被叫到', { status: 500 });
      },
      createXhr: () => xhr,
    });
    const seen: UploadProgress[] = [];
    const pending = client.uploadFile(
      't',
      new Blob([new Uint8Array(10)]),
      'a.txt',
      undefined,
      (p) => seen.push(p),
    );
    xhr.progress(4, 10);
    xhr.progress(2, 10); // 瀏覽器偶爾回報比上一次小的值：不倒退
    xhr.progress(7); // 不知道長度：沒有 total
    xhr.finish(200, RECEIPT);
    expect(await pending).toEqual({
      kind: 'ok',
      receipt: { receiptId: 'r1', name: 'a.txt', bytes: 3 },
    });
    expect(seen).toEqual([{ loaded: 4, total: 10 }, { loaded: 4, total: 10 }, { loaded: 7 }]);
    expect(fetched).toBe(0);
    expect(xhr.opened).toEqual(['POST', `http://agent.test${uploadPath('t')}?name=a.txt`]);
    expect(xhr.headers['content-type']).toBe('application/octet-stream');
  });

  it('XHR 路上的失敗與非 2xx 跟 fetch 路同一種：載體層的錯拋、協定錯誤是 rejected', async () => {
    const run = async (answer: (xhr: FakeXhr) => void) => {
      const xhr = new FakeXhr();
      const client = createWireClient({
        baseUrl: 'http://agent.test',
        createXhr: () => xhr,
        fetch: globalThis.fetch,
      });
      const pending = client.uploadFile(
        't',
        new Blob([new Uint8Array(1)]),
        undefined,
        undefined,
        () => {},
      );
      answer(xhr);
      return pending;
    };
    await expect(run((xhr) => xhr.finish(401, 'unauthorized'))).rejects.toThrow(
      '上傳被載體層擋下：401 unauthorized',
    );
    await expect(run((xhr) => xhr.onerror?.({}))).rejects.toThrow('上傳的連線失敗');
    expect(
      await run((xhr) =>
        xhr.finish(
          200,
          JSON.stringify({ type: 'error', id: null, error: 'not_supported', message: '不收' }),
        ),
      ),
    ).toEqual({ kind: 'rejected', code: 'not_supported', message: '不收' });
  });

  it('中止：XHR 路 abort() 並以 signal.reason 拒絕；已經中止的 signal 連 XHR 都不開', async () => {
    const xhr = new FakeXhr();
    const client = createWireClient({
      baseUrl: 'http://agent.test',
      createXhr: () => xhr,
      fetch: globalThis.fetch,
    });
    const controller = new AbortController();
    const pending = client.uploadFile(
      't',
      new Blob([new Uint8Array(1)]),
      'a.txt',
      controller.signal,
      () => {},
    );
    const reason = new Error('使用者取消');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(xhr.aborted).toBe(true);

    const second = new FakeXhr();
    const already = new AbortController();
    already.abort(reason);
    await expect(
      createWireClient({
        baseUrl: 'http://agent.test',
        createXhr: () => second,
        fetch: globalThis.fetch,
      }).uploadFile('t', new Blob([]), undefined, already.signal, () => {}),
    ).rejects.toBe(reason);
    expect(second.opened).toBeUndefined();
  });

  it('中止：fetch 路把 signal 交給 fetch', async () => {
    let received: AbortSignal | undefined;
    const client = createWireClient({
      baseUrl: 'http://agent.test',
      fetch: async (_input, init) => {
        received = init?.signal ?? undefined;
        return Response.json(JSON.parse(RECEIPT) as object);
      },
    });
    const controller = new AbortController();
    await client.uploadFile('t', new Uint8Array(1), undefined, controller.signal);
    expect(received).toBe(controller.signal);
  });

  it('沒要進度、或 body 不是 Blob：即使有 XHR 也走 fetch', async () => {
    const xhr = new FakeXhr();
    let fetched = 0;
    const client = createWireClient({
      baseUrl: 'http://agent.test',
      fetch: async () => {
        fetched += 1;
        return Response.json(JSON.parse(RECEIPT) as object);
      },
      createXhr: () => xhr,
    });
    await client.uploadFile('t', new Blob([new Uint8Array(1)]), 'a.txt');
    await client.uploadFile('t', new Uint8Array(1), 'a.txt', undefined, () => {});
    expect(fetched).toBe(2);
    expect(xhr.opened).toBeUndefined();
  });
});

describe('runStart 的 attachments', () => {
  it('有附件才放進 params，順序照給的；省略或空陣列不放這個 key', async () => {
    const { client, seen } = recording(() =>
      Response.json({ type: 'success', id: 1, result: { run_id: 'r' } }),
    );
    const attachments = [
      { type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'a.png' },
      { type: 'file', receiptId: 'r1' },
    ] as const;
    await client.runStart('t', '看這個', { attachments });
    await client.runStart('t', '沒附件', { attachments: [] });
    await client.runStart('t', '省略');
    const params = seen.map((s) => (s.body as { params: Record<string, unknown> }).params);
    expect(params[0]?.['attachments']).toEqual(attachments);
    expect('attachments' in (params[1] ?? {})).toBe(false);
    expect('attachments' in (params[2] ?? {})).toBe(false);
  });
});

describe('subagent.list 與 run.start 的 mention（#328）', () => {
  it('subagent.list 在 RPC 白名單裡，送到 /commands/:method，params 是空物件，回應原樣交出', async () => {
    expect(isRpcMethod('subagent.list')).toBe(true);
    const value = { subagents: [{ name: 'reviewer', description: '看變更' }] };
    const { client, seen } = recording(() =>
      Response.json({ type: 'success', id: 1, result: { ok: true, value } }),
    );
    const outcome = await client.subagentList('t');
    expect(seen.map((s) => [s.url, s.body])).toEqual([
      [
        `http://agent.test${commandPath('t', 'subagent.list')}`,
        { id: 1, method: 'subagent.list', params: {} },
      ],
    ]);
    expect(outcome).toEqual({ kind: 'ok', result: { ok: true, value } });
  });

  it('server 沒實作：not_supported 以 rejected 交到呼叫端', async () => {
    const outcome = await recording(notSupported).client.subagentList('t');
    expect(outcome).toMatchObject({ kind: 'rejected', code: 'not_supported' });
  });

  it('mention 有值才放進 run.start 的 params；省略不放這個 key', async () => {
    const { client, seen } = recording(() =>
      Response.json({ type: 'success', id: 1, result: { run_id: 'r' } }),
    );
    const mention = { kind: 'subagent', name: 'reviewer' } as const;
    await client.runStart('t', '請 reviewer 看', { mention });
    await client.runStart('t', '沒點名');
    const params = seen.map((s) => (s.body as { params: Record<string, unknown> }).params);
    expect(params[0]?.['mention']).toEqual(mention);
    expect('mention' in (params[1] ?? {})).toBe(false);
  });
});
