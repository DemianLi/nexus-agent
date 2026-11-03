import { afterEach, describe, expect, test, vi } from 'vitest';

import { defineNexusChat, ELEMENT_NAME } from './nexus-chat-element';

/**
 * `<nexus-chat>` 不注入 client 時打的路徑（#2382）：thread 那一族與 mux 都在 `/embed` 底下，server 照這個前綴套嵌入版的設定檔。
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

  close() {}
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('<nexus-chat> 預設的 client', () => {
  test('下行的 WebSocket 是 /embed/threads/mux，開的串流在 /embed/threads/:id 底下', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    );
    defineNexusChat({ styles: { shadow: '', document: '' } });
    document.body.append(document.createElement(ELEMENT_NAME));
    await vi.waitFor(() => expect(FakeSocket.made[0]?.sent.length).toBeGreaterThan(0));
    const socket = FakeSocket.made[0]!;
    expect(new URL(socket.url).pathname).toBe('/embed/threads/mux');
    expect(socket.sent[0]?.t).toBe('open');
    expect(socket.sent[0]?.path).toMatch(/^\/embed\/threads\/[^/]+\/stream$/u);
  });
});
