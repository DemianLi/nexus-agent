import type { Event, WireClient } from '@nexus/wire';
import {
  THREAD_NOT_EMBEDDED,
  THREAD_NOT_OWNED,
  WireRejectedError,
  WORKSPACE_CHANGES,
} from '@nexus/wire';
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

import { THREAD_NOT_EMBEDDED_TEXT } from '@/lib/thread-not-embedded';
import { THREAD_NOT_OWNED_TEXT } from '@/lib/thread-not-owned';
import { fakeClient } from '@/test/app-harness.fixture';
import { Script } from '@/test/conversation-frames';

import { EMBED_THREAD_KEY } from './embedded-chat';
import { HOST_TOOL_EVENT, HOST_TOOL_MISSING_ERROR } from './host-tools';
import type { NexusHostToolDetail } from './host-tools';
import { defineNexusChat, DOCUMENT_STYLE_ID, ELEMENT_NAME } from './nexus-chat-element';
import { NexusSignInError } from './sign-in';
import { TICKET_NEEDED_EVENT } from './ticket-needed';
import type { NexusTicketNeededDetail } from './ticket-needed';

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

/** 最近一個元素交給注入的 client 的回呼：呼叫 `onUnauthorized` 就是假裝它的請求被 401 擋下。 */
let hooks: { readonly onUnauthorized: () => void } | undefined;

function createClient(given: { readonly onUnauthorized: () => void }): WireClient {
  hooks = given;
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

/** 第一個元素開過下行的那幾條 thread，照第一次開的順序、不重複（StrictMode 會把同一條開兩次）。 */
function threads(): string[] {
  return [...new Set(clients[0]?.opened)];
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
  hooks = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
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

  test('別人的對話（#2370）：講專用的那一句、不重試，「新對話」按得動也接得上新的一條', async () => {
    failOpen = new WireRejectedError(THREAD_NOT_OWNED, 'thread "t" 不是這位使用者開的', '下行被拒');
    const element = mount();
    const view = shadow(element);
    await waitFor(() => expect(view.getByRole('status').textContent).toBe(THREAD_NOT_OWNED_TEXT));
    expect(view.queryByText(/thread "t"/u)).toBeNull();
    const first = clients[0]?.opened[0];
    const before = clients[0]?.opened.length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    });
    expect(clients[0]?.opened).toHaveLength(before ?? 0);
    const fresh = view.getByRole('button', { name: '新對話' });
    expect(fresh.hasAttribute('disabled')).toBe(false);
    fireEvent.click(fresh);
    await waitFor(() => expect(threads()).toHaveLength(2));
    expect(clients[0]?.opened.at(-1)).not.toBe(first);
  });

  test('沒換票：接著 localStorage 記的上一條', async () => {
    localStorage.setItem(EMBED_THREAD_KEY, JSON.stringify({ threadId: '上一條' }));
    mount();
    await waitFor(() => expect(threads()).toEqual(['上一條']));
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

describe('<nexus-chat> 的宿主頁工具（#2374）', () => {
  const FOCUS = {
    name: 'focus_device',
    description: '把鏡頭轉到指定的設備。',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  } as const;
  const HIGHLIGHT = {
    name: 'highlight_device',
    description: '高亮指定的設備。',
    parameters: { type: 'object', properties: { id: { type: 'string' } } },
  } as const;

  /** 掛一個宣告了 {@link FOCUS}、{@link HIGHLIGHT} 的元素，收它發的每一顆 `nexus-host-tool`。 */
  function mountWithTools() {
    const element = mount();
    element.hostTools = [FOCUS, HIGHLIGHT];
    const handed: NexusHostToolDetail[] = [];
    element.addEventListener(HOST_TOOL_EVENT, (event) => {
      handed.push((event as CustomEvent<NexusHostToolDetail>).detail);
    });
    return { element, handed };
  }

  test('送出時附上當下的宣告；沒宣告就不附 hostTools 這一格', async () => {
    const element = mount();
    await say(element, '第一句');
    expect(clients[0]?.startOptions[0]).not.toHaveProperty('hostTools');
    document.body.replaceChildren();
    const { element: declared } = mountWithTools();
    await say(declared, '把鏡頭轉到 P-101');
    expect(clients[1]?.startOptions[0]?.hostTools).toEqual([FOCUS, HIGHLIGHT]);
  });

  test('超過上限或形狀不對的宣告不收：講一聲、原本的不動；null 清掉', () => {
    const element = mount();
    element.hostTools = [FOCUS];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const nine = Array.from({ length: 9 }, (_, i) => ({ ...FOCUS, name: `tool_${i}` }));
    element.hostTools = nine;
    element.hostTools = [{ ...FOCUS, name: 'Focus' }];
    expect(warn).toHaveBeenCalledTimes(2);
    expect(element.hostTools).toEqual([FOCUS]);
    element.hostTools = null;
    expect(element.hostTools).toBeNull();
    warn.mockRestore();
  });

  test('模型叫了宣告過的一支：發事件帶 id、名字與參數，respond 交回結果、第二次不送', async () => {
    const script = new Script();
    events = [script.running(), script.hostTool('h1', 'focus_device', { id: 'P-101' })];
    const { handed } = mountWithTools();
    await waitFor(() => expect(handed).toHaveLength(1));
    expect(handed[0]).toMatchObject({ id: 'h1', name: 'focus_device', args: { id: 'P-101' } });
    await act(async () => {
      handed[0]?.respond({ focused: 'P-101' });
      handed[0]?.respond({ focused: 'again' });
      handed[0]?.fail('too late');
    });
    expect(clients[0]?.responded).toEqual([
      {
        namespace: ['tools:a'],
        interrupt_id: 'h1',
        response: { ok: true, result: { focused: 'P-101' } },
      },
    ]);
  });

  test('fail 交回錯誤', async () => {
    const script = new Script();
    events = [script.running(), script.hostTool('h1', 'highlight_device', { id: 'X-9' })];
    const { handed } = mountWithTools();
    await waitFor(() => expect(handed).toHaveLength(1));
    await act(async () => handed[0]?.fail('找不到 X-9'));
    expect(clients[0]?.responded).toEqual([
      { namespace: ['tools:a'], interrupt_id: 'h1', response: { ok: false, error: '找不到 X-9' } },
    ]);
  });

  test('結果不是 JSON 值：改成錯誤交回，不讓那顆中斷掛到逾時', async () => {
    const script = new Script();
    events = [script.running(), script.hostTool('h1', 'focus_device', { id: 'P-101' })];
    const { handed } = mountWithTools();
    await waitFor(() => expect(handed).toHaveLength(1));
    await act(async () => handed[0]?.respond(undefined));
    expect(clients[0]?.responded).toEqual([
      {
        namespace: ['tools:a'],
        interrupt_id: 'h1',
        response: { ok: false, error: '宿主頁的結果要是 JSON 值' },
      },
    ]);
  });

  test('名字不在目前的宣告裡：不發事件，當場交回「這個頁面沒有這支工具」', async () => {
    const script = new Script();
    events = [script.running(), script.hostTool('h1', 'rotate_camera', {})];
    const { handed } = mountWithTools();
    await waitFor(() => expect(clients[0]?.responded).toHaveLength(1));
    expect(clients[0]?.responded[0]).toEqual({
      namespace: ['tools:a'],
      interrupt_id: 'h1',
      response: { ok: false, error: HOST_TOOL_MISSING_ERROR },
    });
    expect(handed).toEqual([]);
  });

  test('同一顆中斷再出現（重連補送、再度中斷）不再轉交', async () => {
    const script = new Script();
    events = [script.running(), script.hostTool('h1', 'focus_device', { id: 'P-101' })];
    const { handed } = mountWithTools();
    await waitFor(() => expect(handed).toHaveLength(1));
    const threadId = clients[0]?.opened[0] ?? '';
    await act(async () => {
      clients[0]?.downlink.push(threadId, [
        script.running(),
        script.hostTool('h1', 'focus_device', { id: 'P-101' }),
        script.hostTool('h2', 'highlight_device', { id: 'P-102' }),
      ]);
    });
    await waitFor(() => expect(handed).toHaveLength(2));
    expect(handed.map((detail) => detail.name)).toEqual(['focus_device', 'highlight_device']);
  });

  test('重新整理（整個重掛）之後補送的待決照常轉交，id 跟上一次相同', async () => {
    const script = new Script();
    events = [script.running(), script.hostTool('h1', 'focus_device', { id: 'P-101' })];
    const first = mountWithTools();
    await waitFor(() => expect(first.handed).toHaveLength(1));
    document.body.replaceChildren();
    await act(async () => {});
    const second = mountWithTools();
    await waitFor(() => expect(second.handed).toHaveLength(1));
    expect(second.handed[0]?.args).toEqual({ id: 'P-101' });
    expect(second.handed[0]?.id).toBe(first.handed[0]?.id);
    expect(second.handed[0]?.id).toBe('h1');
  });

  test('server 不收（例如停止之後才回）：不寫狀態列', async () => {
    const script = new Script();
    events = [script.running(), script.hostTool('h1', 'focus_device', { id: 'P-101' })];
    const { element, handed } = mountWithTools();
    await waitFor(() => expect(handed).toHaveLength(1));
    const fake = clients[0];
    if (fake === undefined) throw new Error('沒有 client');
    fake.client.inputRespond = async (_threadId, params) => {
      fake.responded.push(params);
      return { type: 'error', id: 2, error: 'no_such_interrupt', message: '那顆中斷已經不在了' };
    };
    await act(async () => handed[0]?.respond({ focused: 'P-101' }));
    expect(fake.responded).toHaveLength(1);
    expect(shadow(element).queryByText(/那顆中斷已經不在了/u)).toBeNull();
  });
});

describe('<nexus-chat> 的換票登入（#2370）', () => {
  // 單獨跑這一組（`-t`）時前面的 define 沒跑過；已經 define 過就什麼都不做。
  beforeAll(() => {
    defineNexusChat({ styles: STYLES, createClient });
  });

  /** 讓 `POST /embed/session` 回這個；收到的每一個請求記在回傳的陣列裡。 */
  function serveSession(status: number, body: unknown) {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        seen.push({ url: String(url), init });
        return Response.json(body, { status });
      }),
    );
    return seen;
  }

  /**
   * 記下讀寫嵌入版那個鍵的每一下。spy 掛在 `localStorage` 這個實例上：掛在 `Storage.prototype` 的，這份環境裡錄不到。
   * 先自己讀寫一次確認錄得到，再清掉，免得斷言「沒讀沒寫」其實什麼都沒在看。
   */
  function watchStorage() {
    const getItem = vi.spyOn(localStorage, 'getItem');
    const setItem = vi.spyOn(localStorage, 'setItem');
    const saved = localStorage.getItem(EMBED_THREAD_KEY);
    localStorage.setItem(EMBED_THREAD_KEY, saved ?? '{}');
    if (saved === null) localStorage.removeItem(EMBED_THREAD_KEY);
    expect(getItem).toHaveBeenCalledWith(EMBED_THREAD_KEY);
    expect(setItem).toHaveBeenCalledWith(EMBED_THREAD_KEY, saved ?? '{}');
    const reset = () => {
      getItem.mockClear();
      setItem.mockClear();
    };
    reset();
    return {
      reads: () => getItem.mock.calls.filter(([key]) => key === EMBED_THREAD_KEY),
      writes: () => setItem.mock.calls.filter(([key]) => key === EMBED_THREAD_KEY),
      reset,
    };
  }

  test('放進頁面之前換票：接 serve 回的那一條，記著的鍵不讀不寫、被清掉', async () => {
    localStorage.setItem(EMBED_THREAD_KEY, JSON.stringify({ threadId: '上一個人的' }));
    const seen = serveSession(200, { expiresAt: 1_800_000_000_000, threadId: '我的' });
    const storage = watchStorage();
    const element = document.createElement(ELEMENT_NAME);
    await expect(element.signIn('票')).resolves.toEqual({ expiresAt: 1_800_000_000_000 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toMatch(/\/embed\/session$/u);
    expect(seen[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ ticket: '票' });
    expect(localStorage.getItem(EMBED_THREAD_KEY)).toBeNull();
    storage.reset();

    document.body.append(element);
    await waitFor(() => expect(threads()).toEqual(['我的']));
    await say(element, '你好');
    fireEvent.click(shadow(element).getByRole('button', { name: '新對話' }));
    await waitFor(() => expect(threads()).toHaveLength(2));
    expect(storage.reads()).toEqual([]);
    expect(storage.writes()).toEqual([]);
    expect(localStorage.getItem(EMBED_THREAD_KEY)).toBeNull();
  });

  test('回應沒有 threadId：開新的一條，不接記著的那一條', async () => {
    localStorage.setItem(EMBED_THREAD_KEY, JSON.stringify({ threadId: '上一個人的' }));
    serveSession(200, { expiresAt: 1_800_000_000_000 });
    const element = document.createElement(ELEMENT_NAME);
    await element.signIn('票');
    document.body.append(element);
    await waitFor(() => expect(threads()).toHaveLength(1));
    expect(threads()).not.toContain('上一個人的');
    expect(localStorage.getItem(EMBED_THREAD_KEY)).toBeNull();
  });

  test('放進頁面之後才換票：改接 serve 回的那一條，之後不再寫記著的鍵', async () => {
    const element = mount();
    await waitFor(() => expect(threads()).toHaveLength(1));
    serveSession(200, { expiresAt: 1_800_000_000_000, threadId: '我的' });
    const storage = watchStorage();
    await act(async () => {
      await element.signIn('票');
    });
    await waitFor(() => expect(clients[0]?.opened.at(-1)).toBe('我的'));
    expect(localStorage.getItem(EMBED_THREAD_KEY)).toBeNull();
    expect(storage.writes()).toEqual([]);
  });

  test.each([
    [401, 'ticket_invalid'],
    [401, 'ticket_expired'],
    [403, 'identity_rejected'],
  ] as const)('兌換被拒 %i %s：reject 帶這個碼，畫面接的那一條不動', async (status, code) => {
    localStorage.setItem(EMBED_THREAD_KEY, JSON.stringify({ threadId: '上一條' }));
    const element = mount();
    await waitFor(() => expect(threads()).toEqual(['上一條']));
    serveSession(status, { error: code });
    const failure = await element.signIn('票').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NexusSignInError);
    expect(failure).toMatchObject({ name: 'NexusSignInError', code, status });
    await act(async () => {});
    expect(threads()).toEqual(['上一條']);
    expect(JSON.parse(localStorage.getItem(EMBED_THREAD_KEY) ?? '{}')).toEqual({
      threadId: '上一條',
    });
  });

  test('其他失敗是 sign_in_failed；空的票也是，不發請求', async () => {
    const seen = serveSession(404, 'not found');
    const element = document.createElement(ELEMENT_NAME);
    await expect(element.signIn('票')).rejects.toMatchObject({
      code: 'sign_in_failed',
      status: 404,
    });
    await expect(element.signIn('')).rejects.toMatchObject({
      name: 'NexusSignInError',
      code: 'sign_in_failed',
    });
    expect(seen).toHaveLength(1);
  });
});

describe('<nexus-chat> 的續期與 nexus-ticket-needed（#2370）', () => {
  beforeAll(() => {
    defineNexusChat({ styles: STYLES, createClient });
  });

  /** `POST /embed/session` 依序回這幾份 200；用完了回 401 `ticket_invalid`。 */
  function serveSessions(...bodies: unknown[]) {
    const queue = [...bodies];
    vi.stubGlobal('fetch', async () => {
      const body = queue.shift();
      return body === undefined
        ? Response.json({ error: 'ticket_invalid' }, { status: 401 })
        : Response.json(body);
    });
  }

  const LATER = 1_800_000_000_000;

  /** 換票、放進頁面、在 serve 回的那一條講一句，再按「新對話」：回傳那條還沒講話的新對話。 */
  async function signedInWithFreshConversation(element: NexusChatElement): Promise<string> {
    await element.signIn('第一張');
    document.body.append(element);
    await waitFor(() => expect(threads()).toEqual(['我的']));
    await say(element, '你好');
    fireEvent.click(shadow(element).getByRole('button', { name: '新對話' }));
    await waitFor(() => expect(threads()).toHaveLength(2));
    const fresh = clients[0]?.opened.at(-1);
    if (fresh === undefined || fresh === '我的') throw new Error('沒開到新的一條');
    return fresh;
  }

  test('同一個人續期：留在剛開、還沒講話的那一條，不重掛', async () => {
    serveSessions(
      { expiresAt: LATER, identityFingerprint: 'alice', threadId: '我的' },
      { expiresAt: LATER + 1, identityFingerprint: 'alice', threadId: '我的' },
    );
    const element = document.createElement(ELEMENT_NAME);
    const fresh = await signedInWithFreshConversation(element);
    const opened = clients[0]?.opened.length;
    await act(async () => {
      await expect(element.signIn('續期')).resolves.toEqual({ expiresAt: LATER + 1 });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(clients[0]?.opened).toHaveLength(opened ?? 0);
    expect(clients[0]?.opened.at(-1)).toBe(fresh);
  });

  test.each([
    ['換了人', { identityFingerprint: 'bob' }],
    ['分不出是不是同一個人（回應沒有指紋）', {}],
  ])('%s：照第一次換票重掛，接上 serve 回的那一條', async (_name, who) => {
    serveSessions(
      { expiresAt: LATER, identityFingerprint: 'alice', threadId: '我的' },
      { expiresAt: LATER, ...who, threadId: '對方的' },
    );
    const element = document.createElement(ELEMENT_NAME);
    await signedInWithFreshConversation(element);
    await act(async () => {
      await element.signIn('換人');
    });
    await waitFor(() => expect(clients[0]?.opened.at(-1)).toBe('對方的'));
  });

  /** 記下元素發的 `nexus-ticket-needed`，並確認它不往上冒。 */
  function listen(element: NexusChatElement) {
    const seen: NexusTicketNeededDetail[] = [];
    const bubbled = vi.fn();
    document.body.addEventListener(TICKET_NEEDED_EVENT, bubbled);
    element.addEventListener('nexus-ticket-needed', (event) => seen.push(event.detail));
    return { seen, bubbled };
  }

  test('快到期：發 expiring 帶到期時間，不 bubble、只發一次', async () => {
    // 有效期很短：剩一半的時候就發（50 毫秒後）。
    const expiresAt = Date.now() + 100;
    serveSessions({ expiresAt, identityFingerprint: 'alice', threadId: '我的' });
    const element = mount();
    const { seen, bubbled } = listen(element);
    await element.signIn('票');
    await waitFor(() => expect(seen).toEqual([{ reason: 'expiring', expiresAt }]));
    hooks?.onUnauthorized();
    expect(seen).toHaveLength(1);
    expect(bubbled).not.toHaveBeenCalled();
  });

  test('被 401 擋下：發 unauthorized；同一輪只發一次，下一次換票成功才再發', async () => {
    serveSessions({ expiresAt: LATER, identityFingerprint: 'alice', threadId: '我的' });
    const element = mount();
    const { seen } = listen(element);
    hooks?.onUnauthorized();
    hooks?.onUnauthorized();
    expect(seen).toEqual([{ reason: 'unauthorized' }]);
    await element.signIn('票');
    hooks?.onUnauthorized();
    expect(seen).toEqual([{ reason: 'unauthorized' }, { reason: 'unauthorized' }]);
  });

  test('拿掉之後到點不發', async () => {
    // 有效期很短：剩一半的時候就發（50 毫秒後）。
    const expiresAt = Date.now() + 100;
    serveSessions({ expiresAt, identityFingerprint: 'alice' });
    const element = mount();
    const { seen } = listen(element);
    await element.signIn('票');
    element.remove();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(seen).toEqual([]);
  });
});
