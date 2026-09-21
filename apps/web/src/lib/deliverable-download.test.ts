import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeliverableDownloader } from '@/lib/deliverable-download';
import type { LocatedFile } from '@/lib/deliverables-view';

/**
 * 交付檔的下載（#452 web 第三刀）。
 *
 * **這一組的主角是位元組。** 下載存在的理由就是那些預覽讀不了的檔（二進位、非 UTF-8），而讓它
 * 悄悄壞掉的方法只有一個：中間出現一次文字解碼。基座的 `readRaw` 正是這樣壞的——6 位元組進、
 * 10 位元組出，`error` 仍然是 `undefined`。所以 fixture 刻意選**走不過 UTF-8 來回的位元組**，
 * 而斷言比的是整串，不是長度、也不是「有內容」。
 */

const FILE: LocatedFile = { path: 'out/build/app.bin', seq: 11, index: 2 };

/**
 * 六個位元組，其中三個是**不合法的 UTF-8 起始位元組**。
 *
 * 任何一次 `TextDecoder` 來回都會把 `ff`／`fe`／`80` 各換成 U+FFFD（再編碼回去各佔 3 個位元組），
 * 6 進 12 出。長度斷言抓得到這一種，但抓不到「解碼後長度碰巧相同」的變體，所以下面逐格比。
 * `00` 在最前面還順便釘住：我們不掃 NUL——二進位正是下載存在的理由。
 */
const BYTES = new Uint8Array([0x00, 0xff, 0xfe, 0x41, 0x80, 0x0a]);

let created: Blob[] = [];
let revoked: string[] = [];
let clicked: { href: string; download: string }[] = [];
/** **不隨 `beforeEach` 歸零**：收回延一拍，前一條測試的那一拍會落在這一條裡面，url 重號就分不出是誰的。 */
let serial = 0;

/**
 * 讀出 blob 的位元組。
 *
 * **走 `FileReader`**：這一版 jsdom 的 `Blob` 沒有 `arrayBuffer()`，而 `new Response(blob)` 要把
 * jsdom 的 Blob 交給 undici，那是另一套實作。`FileReader` 是 jsdom 自己的，讀自己的 Blob。
 */
function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('讀不到 blob'));
    reader.readAsArrayBuffer(blob);
  });
}

beforeEach(() => {
  created = [];
  revoked = [];
  clicked = [];
  // jsdom 沒有這兩支。
  URL.createObjectURL = vi.fn((blob: Blob) => {
    created.push(blob);
    serial += 1;
    return `blob:fake/${serial}`;
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
  // jsdom 對 `<a download>` 的 click 會想去導航並印一整段 Not implemented。攔在這裡，順便把
  // 真正承重的兩個欄位（存成什麼名字、指向哪個 blob）記下來。
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push({ href: this.href, download: this.download });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function downloaderWith(respond: (url: string) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const doFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond(String(input));
  }) as unknown as typeof globalThis.fetch;
  return {
    calls,
    doFetch,
    downloader: createDeliverableDownloader({ threadId: 't1', baseUrl: '', fetch: doFetch }),
  };
}

/**
 * 原始位元組的回應，照路由實際送的那組 header。
 *
 * 交的是 `buffer` 而不是那個 view：這一版的型別裡 `Uint8Array` 不算合法的 body，而 fixture 都是
 * 整塊新建的，兩者的位元組相同。
 */
const octets = (bytes: Uint8Array) =>
  new Response(bytes.buffer as ArrayBuffer, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="app.bin"',
    },
  });

describe('交付檔的下載', () => {
  it('存下去的位元組跟路由送來的一字不差', async () => {
    const { downloader } = downloaderWith(() => octets(BYTES));
    expect(await downloader.download(FILE)).toBe('ok');

    expect(created).toHaveLength(1);
    const saved = await bytesOf(created[0]!);
    // **長度先講話**：一次 UTF-8 來回會把這六個位元組變成十二個。
    expect(saved).toHaveLength(BYTES.length);
    // **再逐格比**：長度相同而內容被換掉的變體（例如每個壞位元組換成一個 `?`）長度會騙過上一行。
    expect([...saved]).toEqual([...BYTES]);
  });

  it('打的是下載路由、帶座標、帶那道 header 的閘門', async () => {
    const { downloader, calls } = downloaderWith(() => octets(BYTES));
    await downloader.download(FILE);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/deliverables/download');
    expect(calls[0]!.url).toContain('seq=11');
    expect(calls[0]!.url).toContain('index=2');
    // 拿掉它，這條線上的每一條 GET 都會被 415 擋下來。
    expect(calls[0]!.init?.headers).toMatchObject({ 'content-type': 'application/json' });
  });

  it('不送翻頁參數——下載沒有頁', async () => {
    const { downloader, calls } = downloaderWith(() => octets(BYTES));
    await downloader.download(FILE);
    expect(calls[0]!.url).not.toContain('offset');
    expect(calls[0]!.url).not.toContain('limit');
  });

  it.each([
    [400, 'invalid'],
    [404, 'missing'],
    [413, 'too-large'],
    [500, 'error'],
  ])('%i 對到 %s', async (status, expected) => {
    const { downloader } = downloaderWith(() => new Response('nope', { status }));
    expect(await downloader.download(FILE)).toBe(expected);
    // 失敗就不該有東西被存下來。
    expect(created).toHaveLength(0);
    expect(clicked).toHaveLength(0);
  });

  it('422 是可重試的 error，不是 binary——下載那條不看內容（#452）', async () => {
    // 預覽那條用 422 講「含 NUL，改走下載」。下載這條**不會**回它：二進位正是它存在的理由。
    // 真收到就代表我們對協定的理解錯了，那該當「再試一次」，不是一句斬釘截鐵的終局。
    const { downloader } = downloaderWith(() => new Response('', { status: 422 }));
    expect(await downloader.download(FILE)).toBe('error');
  });

  it('斷線是 error', async () => {
    const downloader = createDeliverableDownloader({
      threadId: 't1',
      baseUrl: '',
      fetch: (() => Promise.reject(new Error('斷了'))) as unknown as typeof globalThis.fetch,
    });
    expect(await downloader.download(FILE)).toBe('error');
  });

  it('存成宣告路徑的最後一段', async () => {
    const { downloader } = downloaderWith(() => octets(BYTES));
    await downloader.download(FILE);
    expect(clicked).toHaveLength(1);
    expect(clicked[0]!.download).toBe('app.bin');
    expect(clicked[0]!.href).toContain('blob:fake');
  });

  it('路徑沒有目錄就用它自己；空的退回一個名字', async () => {
    const { downloader } = downloaderWith(() => octets(BYTES));
    await downloader.download({ path: 'report.pdf', seq: 1, index: 0 });
    expect(clicked[0]!.download).toBe('report.pdf');
    await downloader.download({ path: '', seq: 1, index: 1 });
    expect(clicked[1]!.download).toBe('deliverable');
  });

  it('blob URL 會被收回——不收就是整份檔留在記憶體裡', async () => {
    const { downloader } = downloaderWith(() => octets(BYTES));
    await downloader.download(FILE);
    // 延一拍才收，所以這裡等它。前面幾條測試的那一拍也可能落在這裡，所以比的是「這一個收了沒」。
    await vi.waitFor(() => expect(revoked).toContain(clicked[0]!.href));
  });

  it('下載完之後沒有留下錨點', async () => {
    const { downloader } = downloaderWith(() => octets(BYTES));
    await downloader.download(FILE);
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });
});
