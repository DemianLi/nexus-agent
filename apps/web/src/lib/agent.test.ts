import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentBaseUrl, agentMuxUrl, createAgentClient, mountedMuxFetch } from './agent.js';

/**
 * 瀏覽器這一端只驗三件事：**解析得到**（`@nexus/wire` 在 Vite／DOM 那份 tsconfig 下
 * 編得過、載得進來），以及**預設同源**（沒設 `VITE_AGENT_BASE_URL` 時走相對路徑，
 * 不會硬編一個 localhost），以及**升級網址**（`ws`／`wss` 跟著 agent 的來源）。協定本身的行為在 `@nexus/wire` 自己的測試裡。
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

  close() {}
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
