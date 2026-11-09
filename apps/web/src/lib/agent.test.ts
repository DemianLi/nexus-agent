import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentBaseUrl,
  agentMuxUrl,
  createAgentClient,
  createAgentConnection,
  mountedMuxFetch,
} from './agent.js';
import { StreamUnauthorizedError } from './embed-unauthorized.js';

/**
 * 瀏覽器這一端驗的是：**解析得到**（`@nexus/wire` 在 Vite／DOM 那份 tsconfig 下
 * 編得過、載得進來）、**預設同源**（沒設 `VITE_AGENT_BASE_URL` 時走相對路徑，
 * 不會硬編一個 localhost）、**升級網址**（`ws`／`wss` 跟著 agent 的來源），以及**掛在子路徑底下**（`agentBaseUrl` 算前綴、
 * `mountedMuxFetch` 剝接前綴，#2426）。協定本身的行為在 `@nexus/wire` 自己的測試裡。
 */
describe('agent client', () => {
  it('預設走相對路徑，路徑就是協定規定的那條', async () => {
    const seen: string[] = [];
    const client = createAgentClient({
      fetch: async (input) => {
        seen.push(String(input));
        return Response.json({ type: 'success', id: 1, result: {} });
      },
    });
    await client.runStart('t1', '哈囉');
    expect(seen).toEqual(['/threads/t1/commands/run.start']);
  });

  it('指定來源時接在前面', async () => {
    const seen: string[] = [];
    const client = createAgentClient({
      baseUrl: 'http://localhost:8787/',
      fetch: async (input) => {
        seen.push(String(input));
        return Response.json({ type: 'success', id: 1, result: {} });
      },
    });
    await client.runStart('t1', '哈囉');
    expect(seen).toEqual(['http://localhost:8787/threads/t1/commands/run.start']);
  });
});

describe('agentMuxUrl', () => {
  it.each([
    ['', 'http://127.0.0.1:8787/?x=1', 'ws://127.0.0.1:8787/threads/mux'],
    ['', 'https://nexus.example/', 'wss://nexus.example/threads/mux'],
    ['http://harness:8787/', 'http://page/', 'ws://harness:8787/threads/mux'],
    ['https://harness', 'http://page/', 'wss://harness/threads/mux'],
  ])('base %j、頁面 %s', (base, page, expected) => {
    expect(agentMuxUrl(base, page)).toBe(expected);
  });
});

describe('agentBaseUrl', () => {
  it.each([
    ['http://h/', ''],
    ['http://h/index.html', ''],
    ['http://h/?token=x#y', ''],
    ['http://h/nexus/', '/nexus'],
    ['http://h/nexus/index.html?x=1#y', '/nexus'],
    ['http://h/nexus/embed.js', '/nexus'],
    ['http://h/a/b/', '/a/b'],
  ])('%s → %j', (from, expected) => {
    expect(agentBaseUrl(from)).toBe(expected);
  });

  it('預設從 document.baseURI 算：根路徑是空字串', () => {
    expect(agentBaseUrl()).toBe('');
  });
});

describe('掛在子路徑底下的獨立頁面（#2426）', () => {
  afterEach(() => {
    document.head.querySelector('base')?.remove();
  });

  it('請求帶著頁面所在的目錄', async () => {
    const base = document.createElement('base');
    base.href = 'http://localhost:3000/nexus/';
    document.head.append(base);
    const seen: string[] = [];
    const client = createAgentClient({
      fetch: async (input) => {
        seen.push(String(input));
        return Response.json({ type: 'success', id: 1, result: {} });
      },
    });
    await client.runStart('t1', '哈囉');
    expect(seen).toEqual(['/nexus/threads/t1/commands/run.start']);
  });
});

class FakeSocket {
  static made: FakeSocket[] = [];
  static refuse = false;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  readonly sent: { readonly t: string; readonly path?: string }[] = [];

  constructor(readonly url: string) {
    FakeSocket.made.push(this);
    queueMicrotask(() => (FakeSocket.refuse ? this.onerror?.({}) : this.onopen?.({})));
  }

  send(text: string) {
    this.sent.push(JSON.parse(text) as { t: string; path?: string });
  }

  closed = false;
  readonly #closeListeners: (() => void)[] = [];

  addEventListener(type: string, listener: () => void) {
    if (type === 'close') this.#closeListeners.push(listener);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({});
    for (const listener of this.#closeListeners) listener();
  }
}

describe('mountedMuxFetch', () => {
  afterEach(() => {
    FakeSocket.made = [];
    FakeSocket.refuse = false;
    vi.unstubAllGlobals();
  });

  const unused: typeof globalThis.fetch = () => Promise.reject(new Error('不該退回 SSE'));

  it.each([
    ['', '/threads/t1/stream', 'ws://h/threads/mux', '/threads/t1/stream'],
    ['/nexus', '/nexus/threads/t1/stream', 'ws://h/nexus/threads/mux', '/threads/t1/stream'],
    [
      '/nexus',
      '/nexus/embed/threads/t1/stream',
      'ws://h/nexus/embed/threads/mux',
      '/embed/threads/t1/stream',
    ],
  ])('mount %j：socket 帶前綴，socket 裡的 path 不帶', async (mount, input, socketUrl, path) => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const baseUrl = input.slice(0, input.indexOf('/threads/'));
    const fetch = mountedMuxFetch(mount, baseUrl, 'http://h/page', unused);
    void fetch(input, { method: 'POST', body: '{}' }).catch(() => undefined);
    await vi.waitFor(() => expect(FakeSocket.made[0]?.sent.length).toBe(1));
    expect(FakeSocket.made[0]!.url).toBe(socketUrl);
    expect(FakeSocket.made[0]!.sent[0]?.path).toBe(path);
  });

  it('握手失敗退回 SSE 時前綴接回去', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    FakeSocket.refuse = true;
    const seen: string[] = [];
    const fetch = mountedMuxFetch('/nexus', '/nexus', 'http://h/nexus/', async (input) => {
      seen.push(String(input));
      return new Response('');
    });
    await fetch('/nexus/threads/t1/stream?x=1', { method: 'POST', body: '{}' });
    expect(seen).toEqual(['http://h/nexus/threads/t1/stream?x=1']);
  });
});

describe('createAgentConnection 換 socket（#2370）', () => {
  afterEach(() => {
    FakeSocket.made = [];
    vi.unstubAllGlobals();
  });

  /** 假 serve 從這條 socket 送一則下行訊息。 */
  function serverSays(socket: FakeSocket | undefined, message: Record<string, unknown>) {
    socket?.onmessage?.({ data: JSON.stringify(message) });
  }

  const sse = (seq: number) =>
    `data: ${JSON.stringify({ type: 'event', seq, event_id: `t1:${String(seq)}`, method: 'custom', params: { namespace: [], timestamp: 0, data: {} } })}\n\n`;

  it('換了人（closeOpen: true）：舊的 socket 當場關掉，下一條下行開新的一條', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const { client, renewStreams } = createAgentConnection({ baseUrl: '', routePrefix: '/embed' });
    const first = client.openEvents('t1');
    first.catch(() => undefined);
    await vi.waitFor(() => expect(FakeSocket.made[0]?.sent.length).toBe(1));
    renewStreams({ closeOpen: true });
    expect(FakeSocket.made[0]?.closed).toBe(true);
    await expect(first).rejects.toThrow();
    void client.openEvents('t1').catch(() => undefined);
    await vi.waitFor(() => expect(FakeSocket.made[1]?.sent.length).toBe(1));
    expect(FakeSocket.made).toHaveLength(2);
    expect(FakeSocket.made[1]?.closed).toBe(false);
  });

  it('同一個人續期（closeOpen: false）：已開的下行照常收，新的開在新 socket；舊的收掉之後才關舊 socket（#2484）', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const { client, renewStreams } = createAgentConnection({ baseUrl: '', routePrefix: '/embed' });
    const controller = new AbortController();
    const opening = client.openEvents('t1', { signal: controller.signal });
    await vi.waitFor(() => expect(FakeSocket.made[0]?.sent.length).toBe(1));
    serverSays(FakeSocket.made[0], {
      t: 'head',
      id: '1',
      status: 200,
      contentType: 'text/event-stream',
    });
    const events = await opening;

    renewStreams({ closeOpen: false });
    expect(FakeSocket.made[0]?.closed).toBe(false);
    const next = events.next();
    serverSays(FakeSocket.made[0], { t: 'data', id: '1', text: sse(7) });
    expect((await next).value).toMatchObject({ seq: 7 });

    void client.openEvents('t2').catch(() => undefined);
    await vi.waitFor(() => expect(FakeSocket.made[1]?.sent.length).toBe(1));
    expect(FakeSocket.made[0]?.sent.filter(({ t }) => t === 'open')).toHaveLength(1);
    expect(FakeSocket.made[0]?.closed).toBe(false);

    controller.abort();
    await vi.waitFor(() => expect(FakeSocket.made[0]?.closed).toBe(true));
    expect(FakeSocket.made[1]?.closed).toBe(false);
  });

  it('續期時舊 socket 上沒有開著的下行：當場關掉', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const { client, renewStreams } = createAgentConnection({ baseUrl: '', routePrefix: '/embed' });
    const opening = client.openEvents('t1');
    await vi.waitFor(() => expect(FakeSocket.made[0]?.sent.length).toBe(1));
    serverSays(FakeSocket.made[0], { t: 'end', id: '1' });
    await expect(opening).rejects.toThrow();
    renewStreams({ closeOpen: false });
    expect(FakeSocket.made[0]?.closed).toBe(true);
  });

  it('注入 fetch 時沒有 socket，renewStreams 什麼都不做', () => {
    const { renewStreams } = createAgentConnection({ fetch: async () => new Response('') });
    expect(() => renewStreams({ closeOpen: true })).not.toThrow();
  });
});

describe('createAgentConnection 的 onUnauthorized（#2370）', () => {
  afterEach(() => {
    FakeSocket.made = [];
    FakeSocket.refuse = false;
    vi.unstubAllGlobals();
  });

  it('上行回 401 叫一次，其他狀態不叫', async () => {
    const onUnauthorized = vi.fn();
    let status = 401;
    const { client } = createAgentConnection({
      fetch: async () => Response.json({ error: 'unauthorized' }, { status }),
      onUnauthorized,
    });
    await expect(client.runStart('t1', '哈囉')).rejects.toThrow();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    status = 500;
    await expect(client.runStart('t1', '哈囉')).rejects.toThrow();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('WebSocket 下行退回 SSE 被 401 擋下：叫一次', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    FakeSocket.refuse = true;
    vi.stubGlobal('fetch', async () => new Response('', { status: 401 }));
    const onUnauthorized = vi.fn();
    const { client } = createAgentConnection({
      baseUrl: '',
      routePrefix: '/embed',
      onUnauthorized,
    });
    await expect(client.openEvents('t1')).rejects.toThrow(StreamUnauthorizedError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('注入 fetch 的下行回 401：叫一次，拋 StreamUnauthorizedError（#2490）', async () => {
    const onUnauthorized = vi.fn();
    const { client } = createAgentConnection({
      fetch: async () => Response.json({ error: 'unauthorized' }, { status: 401 }),
      onUnauthorized,
    });
    await expect(client.openEvents('t1')).rejects.toThrow(StreamUnauthorizedError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('沒給 onUnauthorized（獨立頁面）：下行的 401 照舊是一般的錯誤，不是 StreamUnauthorizedError（#2490）', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    FakeSocket.refuse = true;
    vi.stubGlobal('fetch', async () => new Response('', { status: 401 }));
    const { client } = createAgentConnection({ baseUrl: '', routePrefix: '/embed' });
    const error: unknown = await client.openEvents('t1').then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(StreamUnauthorizedError);
    const injected = createAgentClient({
      fetch: async () => new Response('', { status: 401 }),
    });
    const fromInjected: unknown = await injected.openEvents('t1').then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(fromInjected).toBeInstanceOf(Error);
    expect(fromInjected).not.toBeInstanceOf(StreamUnauthorizedError);
  });

  it('下行回 403（來源不受信任）：不叫，也不是 StreamUnauthorizedError，呼叫端照舊重試（#2490）', async () => {
    const onUnauthorized = vi.fn();
    const { client } = createAgentConnection({
      fetch: async () => new Response('', { status: 403 }),
      onUnauthorized,
    });
    const error: unknown = await client.openEvents('t1').then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(StreamUnauthorizedError);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('續期之前開的下行，回來時才是 401：不叫；續期之後開的 401 照叫（#2484）', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const onUnauthorized = vi.fn();
    const { client, renewStreams } = createAgentConnection({
      baseUrl: '',
      routePrefix: '/embed',
      onUnauthorized,
    });
    const unauthorized = (socket: FakeSocket | undefined) => {
      for (const message of [
        { t: 'head', id: '1', status: 401, contentType: 'application/json' },
        { t: 'end', id: '1' },
      ]) {
        socket?.onmessage?.({ data: JSON.stringify(message) });
      }
    };
    const old = client.openEvents('t1');
    old.catch(() => undefined);
    await vi.waitFor(() => expect(FakeSocket.made[0]?.sent.length).toBe(1));
    renewStreams({ closeOpen: false });
    // mux 收到 401 會換一條 socket 再開一次，兩次都 401 才交回來。
    unauthorized(FakeSocket.made[0]);
    await vi.waitFor(() => expect(FakeSocket.made[1]?.sent.length).toBe(1));
    unauthorized(FakeSocket.made[1]);
    const oldError: unknown = await old.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(oldError).toBeInstanceOf(Error);
    expect(oldError).not.toBeInstanceOf(StreamUnauthorizedError);
    expect(onUnauthorized).not.toHaveBeenCalled();

    const fresh = client.openEvents('t1');
    fresh.catch(() => undefined);
    await vi.waitFor(() => expect(FakeSocket.made[2]?.sent.length).toBe(1));
    unauthorized(FakeSocket.made[2]);
    await vi.waitFor(() => expect(FakeSocket.made[3]?.sent.length).toBe(1));
    unauthorized(FakeSocket.made[3]);
    await expect(fresh).rejects.toThrow(StreamUnauthorizedError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
