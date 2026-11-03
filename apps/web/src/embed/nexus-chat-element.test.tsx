import type { Event, WireClient } from '@nexus/wire';
import { THREAD_NOT_EMBEDDED, WireRejectedError, WORKSPACE_CHANGES } from '@nexus/wire';
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { THREAD_NOT_EMBEDDED_TEXT } from '@/lib/thread-not-embedded';
import { fakeClient } from '@/test/app-harness.fixture';
import { Script } from '@/test/conversation-frames';

import { EMBED_THREAD_KEY } from './embedded-chat';
import { defineNexusChat, DOCUMENT_STYLE_ID, ELEMENT_NAME } from './nexus-chat-element';

/**
 * `<nexus-chat>`（#2366）：元素的生命週期與屬性。整份檔共用一次 `customElements.define`（jsdom 的登記表是全域的），
 * 第一條測試刻意在 define 之前建元素，驗升級前就設好的 property。真瀏覽器裡的樣式、字型與焦點在 `e2e/embed.e2e.ts`。
 */

const STYLES = { shadow: '.nexus-root{--shadow:1}', document: '@font-face{font-family:X}' };
let clients: ReturnType<typeof fakeClient>[] = [];
/** 設了就讓下一個元素的下行被拒。 */
let failOpen: Error | undefined;
/** 下一個元素的下行一打開就推的 frame。 */
let events: Event[] = [];

function createClient(): WireClient {
  const fake = fakeClient(events);
  clients.push(fake);
  const refusal = failOpen;
  if (refusal === undefined) return fake.client;
  return {
    ...fake.client,
    openEvents: async (threadId) => {
      fake.opened.push(threadId);
      throw refusal;
    },
  };
}

async function say(element: NexusChatElement, text: string) {
  const view = shadow(element);
  const box = await view.findByRole('textbox', { name: '要說的話' });
  await waitFor(() => expect(clients.at(-1)?.opened.length).toBeGreaterThan(0));
  fireEvent.change(box, { target: { value: text } });
  await waitFor(() =>
    expect(view.getByRole('button', { name: '送出' }).hasAttribute('disabled')).toBe(false),
  );
  fireEvent.click(view.getByRole('button', { name: '送出' }));
  await waitFor(() => expect(clients.at(-1)?.sent).toEqual([text]));
}

function mount(): NexusChatElement {
  const element = document.createElement(ELEMENT_NAME);
  document.body.append(element);
  return element;
}

function shadow(element: HTMLElement) {
  const root = element.shadowRoot;
  if (root === null) throw new Error('沒有 shadow root');
  return within(root as unknown as HTMLElement);
}

afterEach(() => {
  document.body.replaceChildren();
  clients = [];
  failOpen = undefined;
  events = [];
  vi.unstubAllGlobals();
});

describe('<nexus-chat>', () => {
  test('升級之前就設好的 context 收得到，畫成標籤', async () => {
    const early = document.createElement(ELEMENT_NAME);
    early.context = { label: 'A-12 冷卻泵' };
    document.body.append(early);
    defineNexusChat({ styles: STYLES, createClient });
    expect(await shadow(early).findByText('目前選取：A-12 冷卻泵')).toBeTruthy();
    expect(early.context).toEqual({ label: 'A-12 冷卻泵' });
  });

  test('再 define 一次什麼都不做', () => {
    expect(() => defineNexusChat({ styles: STYLES, createClient })).not.toThrow();
  });

  test('樣式：shadow root 一份、宿主頁 head 只放一份', () => {
    const first = mount();
    mount();
    expect(first.shadowRoot?.querySelector('style')?.textContent).toContain('--shadow:1');
    const documentStyles = document.querySelectorAll(`#${DOCUMENT_STYLE_ID}`);
    expect(documentStyles).toHaveLength(1);
    expect(documentStyles[0]?.textContent).toBe(STYLES.document);
  });

  test('context 的屬性與 property：屬性是標籤的字，寫錯的值不收、標籤不動', async () => {
    const element = mount();
    element.setAttribute('context', 'B-07 壓縮機');
    expect(await shadow(element).findByText('目前選取：B-07 壓縮機')).toBeTruthy();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 宿主頁不一定有型別：故意塞一個不收的值。
    element.context = 42 as unknown as string;
    expect(warn).toHaveBeenCalledTimes(1);
    expect(element.context).toEqual({ label: 'B-07 壓縮機' });
    element.context = null;
    await waitFor(() => expect(shadow(element).queryByText(/目前選取：/u)).toBeNull());
    warn.mockRestore();
  });

  test('theme 掛在 shadow root 裡的 wrapper 上，不改宿主頁的 <html>', () => {
    const element = mount();
    const root = element.shadowRoot?.querySelector('.nexus-root');
    element.setAttribute('theme', 'dark');
    expect(root?.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    element.setAttribute('theme', 'light');
    expect(root?.classList.contains('dark')).toBe(false);
  });

  test('送出走 run.start；開頭是 / 也是一句話，不走 slash.run', async () => {
    const element = mount();
    const view = shadow(element);
    const box = await view.findByRole('textbox', { name: '要說的話' });
    await waitFor(() => expect(clients[0]?.opened.length).toBeGreaterThan(0));
    fireEvent.change(box, { target: { value: '/deploy 今天' } });
    await waitFor(() =>
      expect(view.getByRole('button', { name: '送出' }).hasAttribute('disabled')).toBe(false),
    );
    fireEvent.click(view.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(clients[0]?.sent).toEqual(['/deploy 今天']));
    expect(clients[0]?.slashed).toEqual([]);
  });

  test('送出時附上當下的情境（#2382）', async () => {
    const element = mount();
    element.context = { label: 'A-12 冷卻泵' };
    await say(element, '它現在溫度多少？');
    expect(clients[0]?.startOptions[0]?.context).toEqual({ label: 'A-12 冷卻泵' });
  });

  test('沒有情境就不附 context 這一格', async () => {
    const element = mount();
    await say(element, '今天有哪些告警？');
    expect(clients[0]?.startOptions[0]).not.toHaveProperty('context');
  });

  test('獨立頁面開的 thread：講專用的那一句、不當一般錯誤，「新對話」按得動', async () => {
    failOpen = new WireRejectedError(
      THREAD_NOT_EMBEDDED,
      'thread "t" 不是從嵌入的對話框開的，嵌入的對話框不能接手它；請開一條新對話',
      '下行被拒',
    );
    const element = mount();
    const view = shadow(element);
    await waitFor(() =>
      expect(view.getByRole('status').textContent).toBe(THREAD_NOT_EMBEDDED_TEXT),
    );
    expect(view.queryByText(/thread "t"/u)).toBeNull();
    expect(view.getByRole('button', { name: '新對話' }).hasAttribute('disabled')).toBe(false);
  });

  test('空白畫面不提拖檔：嵌入版沒有附件（#2384）', async () => {
    const view = shadow(mount());
    await view.findByRole('heading', { level: 2, name: '今天要做什麼？' });
    expect(view.getByText('在下面打字。')).toBeTruthy();
    expect(view.queryByText(/拖/u)).toBeNull();
  });

  test('這一輪有改動也不畫改動卡、不讀改動摘要（#2384）', async () => {
    const summary = { files: [{ path: 'a.md', display: 'a.md', added: 3, deleted: 1 }], total: 1, added: 3, deleted: 1 }; // prettier-ignore
    const fetch = vi.fn(async (_url: RequestInfo | URL) => new Response(JSON.stringify(summary)));
    vi.stubGlobal('fetch', fetch);
    const script = new Script();
    events = [
      script.running(),
      ...script.human('inbox:r1', '改一下'),
      script.custom(WORKSPACE_CHANGES, { seq: 42 }),
      ...script.ai('a1', { text: '好了。' }),
      script.completed(),
    ];
    const view = shadow(mount());
    await view.findByText('好了。');
    await act(async () => {});
    expect(view.queryByRole('region', { name: /這一輪改動的檔案/u })).toBeNull();
    const urls = fetch.mock.calls.map(([url]) => String(url));
    expect(urls.filter((url) => url.includes('/changes'))).toEqual([]);
  });

  test('新對話：講過話才按得動，換一條新的並記在嵌入版自己的鍵', async () => {
    const element = mount();
    const view = shadow(element);
    const box = await view.findByRole('textbox', { name: '要說的話' });
    await waitFor(() => expect(clients[0]?.opened.length).toBeGreaterThan(0));
    const fresh = view.getByRole('button', { name: '新對話' });
    expect(fresh.hasAttribute('disabled')).toBe(true);
    fireEvent.change(box, { target: { value: '你好' } });
    fireEvent.click(view.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(fresh.hasAttribute('disabled')).toBe(false));
    const first = clients[0]?.opened[0];
    fireEvent.click(fresh);
    await waitFor(() => expect(clients[0]?.opened.at(-1)).not.toBe(first));
    const remembered = JSON.parse(localStorage.getItem(EMBED_THREAD_KEY) ?? '{}') as {
      threadId?: string;
    };
    expect(remembered.threadId).toBe(clients[0]?.opened.at(-1));
    expect(localStorage.getItem('nexus.threads.current')).toBeNull();
  });

  test('拿掉元素就卸掉畫面；同一個 tick 裡搬到別處不卸', async () => {
    const element = mount();
    await shadow(element).findByRole('textbox', { name: '要說的話' });
    const app = element.shadowRoot?.querySelector('.nexus-app');
    const other = document.createElement('div');
    document.body.append(other);
    await act(async () => {
      other.append(element);
      await Promise.resolve();
    });
    expect(app?.childElementCount).toBeGreaterThan(0);
    await act(async () => {
      element.remove();
      await Promise.resolve();
    });
    expect(app?.childElementCount).toBe(0);
  });
});
