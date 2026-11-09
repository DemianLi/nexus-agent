import { createWireClient } from '@nexus/wire';
import { act } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { LIVEZ_PROBE_TIMEOUT_MS } from '@/lib/livez-probe';
import { SLOW_CONNECT_MS } from '@/lib/reconnect';

import { defineNexusChat, ELEMENT_NAME } from './nexus-chat-element';

/**
 * 嵌入版的 `/livez` 探測打 `embed.js` 所在的目錄，不打宿主頁的（#2426）：宿主頁的伺服器回 404 也算「回來了」，探測就失準。
 * 獨立一份檔：`customElements.define` 一份檔只能一次。
 */

afterEach(() => {
  document.body.replaceChildren();
  document.head.querySelector('base')?.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('<nexus-chat> 的 /livez 探測', () => {
  test('宿主頁在 /viz/page/、embed.js 在 /nexus/：探測打 /nexus/livez', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const base = document.createElement('base');
    base.href = 'http://localhost:3000/viz/page/';
    document.head.append(base);
    const probed: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        probed.push(String(input));
        return new Response('ok');
      }),
    );
    defineNexusChat({
      styles: { shadow: '', document: '' },
      scriptUrl: 'http://localhost:3000/nexus/embed.js',
      // 連線一直等不到結果，到點才會探測。
      createClient: () =>
        createWireClient({ baseUrl: '/nexus/embed', fetch: () => new Promise(() => {}) }),
    });
    // 掛上去的那一次 act 結束時 effect 才跑，連線與等待的計時器在那之後才排，所以分兩次。
    await act(async () => {
      document.body.append(document.createElement(ELEMENT_NAME));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLOW_CONNECT_MS + LIVEZ_PROBE_TIMEOUT_MS);
    });
    expect(probed).toEqual(['/nexus/livez']);
  });
});
