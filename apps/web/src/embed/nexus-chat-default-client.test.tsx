import { afterEach, describe, expect, test, vi } from 'vitest';

import { defineNexusChat, ELEMENT_NAME } from './nexus-chat-element';

/**
 * `<nexus-chat>` 不注入 client 時打的路徑（#2382）：thread 那一族與 mux 都在 `/embed` 底下，server 照這個前綴套嵌入版的設定檔。
 * `embed.js` 掛在子路徑底下（#2426）：WebSocket 網址帶著 `embed.js` 所在的目錄（代理只剝升級網址的前綴）；socket 訊息裡的 path 由
 * client 先剝掉，所以不帶前綴。
 * 獨立一份檔：`customElements.define` 一份檔只能一次，`nexus-chat-element.test.tsx` 那份注入了假 client。
 */

class FakeSocket {
  static readonly made: FakeSocket[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  readonly sent: { readonly t: string; readonly path?: string }[] = [];

  constructor(readonly url: string) {
    FakeSocket.made.push(this);
    queueMicrotask(() => this.onopen?.({}));
  }

  send(text: string) {
    this.sent.push(JSON.parse(text) as { t: string; path?: string });
  }

  addEventListener() {}

  close() {}
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('<nexus-chat> 預設的 client', () => {
  test('embed.js 在 /nexus/ 底下：WebSocket 是 /nexus/embed/threads/mux，開的串流在 /embed/threads/:id 底下', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    );
    defineNexusChat({
      styles: { shadow: '', document: '' },
      scriptUrl: 'http://localhost:3000/nexus/embed.js',
    });
    document.body.append(document.createElement(ELEMENT_NAME));
    await vi.waitFor(() => expect(FakeSocket.made[0]?.sent.length).toBeGreaterThan(0));
    const socket = FakeSocket.made[0]!;
    expect(new URL(socket.url).pathname).toBe('/nexus/embed/threads/mux');
    expect(socket.sent[0]?.t).toBe('open');
    expect(socket.sent[0]?.path).toMatch(/^\/embed\/threads\/[^/]+\/stream$/u);
  });
});
