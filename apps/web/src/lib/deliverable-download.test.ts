import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeliverableDownloader } from '@/lib/deliverable-download';
import type { LocatedFile } from '@/lib/deliverables-view';
import type { DeliverableCall, Reply } from '@/test/deliverable-commands';
import {
  badRequestReply,
  bytesReply,
  carrierReply,
  deliverableFetch,
  refuseReply,
  tooLargeReply,
} from '@/test/deliverable-commands';

/**
 * 交付檔的下載（#452 web 第三刀；#747 起走命令通道的 `deliverable.readBytes`）。
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
 * 讀出 blob 的位元組。`Blob` 是 Node 的那一個（`test/deliverable-commands.ts` 換掉了 jsdom 的，理由寫在那裡），
 * 所以用它自己的 `arrayBuffer()`；jsdom 的 `FileReader` 不收 Node 的 Blob。
 */
async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
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

function downloaderWith(respond: (call: DeliverableCall) => Reply | Promise<Reply>) {
  const { fetch: doFetch, calls, urls, inits } = deliverableFetch(respond);
  return {
    calls,
    urls,
    inits,
    downloader: createDeliverableDownloader({ threadId: 't1', baseUrl: '', fetch: doFetch }),
  };
}

/** 整檔的回覆：位元組走多段表單，照命令通道實際送的形狀。 */
const octets = (bytes: Uint8Array) =>
  bytesReply({
    path: 'out/build/app.bin',
    version: 'v1',
    bytes: bytes.length,
    offset: 0,
    data: bytes,
    eof: true,
  });

describe('交付檔的下載', () => {
  it('存下去的位元組跟命令送來的一字不差', async () => {
    const { downloader } = downloaderWith(() => octets(BYTES));
    expect(await downloader.download(FILE)).toBe('ok');

    expect(created).toHaveLength(1);
    const saved = await bytesOf(created[0]!);
    // **長度先講話**：一次 UTF-8 來回會把這六個位元組變成十二個。
    expect(saved).toHaveLength(BYTES.length);
    // **再逐格比**：長度相同而內容被換掉的變體（例如每個壞位元組換成一個 `?`）長度會騙過上一行。
    expect([...saved]).toEqual([...BYTES]);
  });

  it('打的是 readBytes 命令、帶座標、整檔（不帶 offset 與 length）、帶那道 header 的閘門', async () => {
    const { downloader, calls, urls, inits } = downloaderWith(() => octets(BYTES));
    await downloader.download(FILE);
    expect(calls).toEqual([
      // **不帶 `offset`／`length`**：兩個都不給才是整檔，給任何一個就變成窗口。
      { method: 'deliverable.readBytes', params: { seq: 11, index: 2 } },
    ]);
    expect(urls[0]).toBe('/threads/t1/commands/deliverable.readBytes');
    expect(inits[0]?.method).toBe('POST');
    // 拿掉它，這條線上的每一條請求都會被 415 擋下來。
    expect(inits[0]?.headers).toMatchObject({ 'content-type': 'application/json' });
  });

  it.each([
    ['deliverable/no-anchor', 'missing'],
    ['deliverable/not-found', 'missing'],
    ['deliverable/not-regular-file', 'missing'],
  ] as const)('理由碼 %s 對到 %s', async (code, expected) => {
    const { downloader } = downloaderWith(() => refuseReply(code));
    expect(await downloader.download(FILE)).toBe(expected);
    // 失敗就不該有東西被存下來。
    expect(created).toHaveLength(0);
    expect(clicked).toHaveLength(0);
  });

  it('too-large（整檔超過 maxFileBytes）是終局', async () => {
    const { downloader } = downloaderWith(() => tooLargeReply(32 * 1024 * 1024));
    expect(await downloader.download(FILE)).toBe('too-large');
    expect(created).toHaveLength(0);
  });

  it('參數不合格（協定錯誤）是 invalid；載體層擋下暫時也是（#747，wire 補上 code／status 之前分不出成因）', async () => {
    expect(await downloaderWith(() => badRequestReply).downloader.download(FILE)).toBe('invalid');
    expect(await downloaderWith(() => carrierReply(500)).downloader.download(FILE)).toBe('invalid');
    expect(created).toHaveLength(0);
  });

  it('not-text 是可重試的 error，不是 not-text——readBytes 不看內容（#452）', async () => {
    // 預覽那條用 `deliverable/not-text` 講「不是文字，改走下載」。下載這條**不會**回它：二進位正是它存在的理由。
    // 真收到就代表我們對協定的理解錯了，那該當「再試一次」，不是一句斬釘截鐵的終局。
    const { downloader } = downloaderWith(() => refuseReply('deliverable/not-text'));
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
