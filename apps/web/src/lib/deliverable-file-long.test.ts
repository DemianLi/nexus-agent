import type { DeliverableFileBytes, DeliverableFilePage } from '@nexus/wire';
import { describe, expect, it, vi } from 'vitest';

import type { DeliverableFileEntry, DeliverableFileStore } from '@/lib/deliverable-file';
import { createDeliverableFileStore, isLongLine, isPage } from '@/lib/deliverable-file';

/**
 * 超過頁上限的行、中長的行太多（#555）。
 *
 * 假 server 照兩條路由的規則回應（`apps/harness/src/deliverable-files.ts`、`deliverable-window.ts`）：
 * 文字頁一頁超過 `maxBytes` 是 413（**拒絕不是截斷**）、`limit` 超過 `maxLines` 是 400、當頁含 NUL 或不是 UTF-8
 * 是 422、只有檔頭的 BOM 被吃掉；位元組窗口不解碼，`length` 預設且最多 `maxBytes`。**判準是把整個檔讀完、
 * 接回來的文字跟原檔逐字相同**——位置算歪一個位元組，接出來的就不是原檔。
 */

const encoder = new TextEncoder();

interface Fake {
  bytes: Uint8Array;
  version: string;
  readonly maxLines: number;
  readonly maxBytes: number;
}

/** 按 `\n` 切成每一行的位元組；結尾的換行不算多一行，同 `cutPage`。 */
function rawLines(bytes: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) {
      lines.push(bytes.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < bytes.length) lines.push(bytes.subarray(start));
  return lines;
}

const hasBom = (bytes: Uint8Array) => bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;

function respond(fake: Fake, url: string): Response {
  const { pathname, searchParams } = new URL(url, 'http://x');
  const num = (name: string) =>
    searchParams.has(name) ? Number(searchParams.get(name)) : undefined;
  const stat = { path: 'out/long.txt', version: fake.version, bytes: fake.bytes.length };
  if (pathname.endsWith('/deliverables/bytes')) {
    const offset = num('offset') ?? 0;
    const length = num('length') ?? fake.maxBytes;
    if (length === 0) return new Response('', { status: 400 });
    if (length > fake.maxBytes) return new Response('', { status: 413 });
    const slice = fake.bytes.subarray(offset, offset + length);
    const body: DeliverableFileBytes = {
      ...stat,
      offset,
      data: btoa(String.fromCharCode(...slice)),
      eof: offset + length >= fake.bytes.length,
    };
    return Response.json(body);
  }
  const offset = num('offset') ?? 0;
  const limit = num('limit');
  if (limit !== undefined && limit > fake.maxLines) return new Response('', { status: 400 });
  const lines = rawLines(fake.bytes);
  const take = lines.slice(offset, offset + (limit ?? fake.maxLines));
  const size = take.reduce((sum, line) => sum + line.length, 0) + Math.max(0, take.length - 1);
  const bom = offset === 0 && hasBom(fake.bytes) ? 3 : 0;
  if (size - bom > fake.maxBytes) return new Response('', { status: 413 });
  const decoded: string[] = [];
  for (const [i, line] of take.entries()) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: !(offset + i === 0) }).decode(
        line,
      );
      if (text.includes('\0')) return new Response('', { status: 422 });
      decoded.push(text);
    } catch {
      return new Response('', { status: 422 });
    }
  }
  const page: DeliverableFilePage = {
    ...stat,
    offset,
    text: decoded.join('\n'),
    lines: take.length,
    eof: offset + take.length >= lines.length,
  };
  return Response.json(page);
}

function storeOn(fake: Fake) {
  const urls: string[] = [];
  const doFetch = vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return respond(fake, String(input));
  }) as unknown as typeof globalThis.fetch;
  return {
    store: createDeliverableFileStore({ threadId: 't', baseUrl: '', fetch: doFetch }),
    urls,
  };
}

/** 照預覽的用法把鏈一格一格讀到底（長行一個窗口一個窗口讀），回傳每一格與最後停在哪。 */
async function readAll(store: DeliverableFileStore) {
  const entries: DeliverableFileEntry[] = [];
  let offset = 0;
  for (let guard = 0; guard < 10_000; guard++) {
    store.load(1, 0, offset);
    await vi.waitFor(() => {
      const state = store.read(1, 0, offset);
      expect(state === 'loading' || (isLongLine(state) && state.next === 'loading')).toBe(false);
    });
    const state = store.read(1, 0, offset);
    if (state === undefined) continue; // 換版本被丟掉了，從同一格重讀
    if (typeof state !== 'object') return { entries, stop: state };
    if (isLongLine(state)) {
      if (state.next !== undefined) return { entries, stop: state.next };
      if (!state.done) continue;
      entries.push(state);
      if (state.eof) return { entries, stop: 'end' as const };
      offset += 1;
      continue;
    }
    entries.push(state);
    if (state.eof || state.lines === 0) return { entries, stop: 'end' as const };
    offset += state.lines;
  }
  throw new Error('讀不完');
}

/** 接回來的全文：每一格的文字用換行接起來。 */
const joined = (entries: readonly DeliverableFileEntry[]) =>
  entries
    .filter((entry) => isLongLine(entry) || entry.lines > 0)
    .map((entry) => entry.text)
    .join('\n');

/** 原檔照路由的解碼：吃掉檔頭的 BOM、去掉結尾那一個換行。 */
const expected = (text: string) => text.replace(/^\uFEFF/, '').replace(/\n$/, '');

const fake = (text: string | Uint8Array, maxBytes = 64, maxLines = 5): Fake => ({
  bytes: typeof text === 'string' ? encoder.encode(text) : text,
  version: 'v1',
  maxBytes,
  maxLines,
});

describe('超過頁上限的一行改走位元組窗口', () => {
  it('中文長行夾在短行之間：接回來跟原檔逐字相同，字元被切在窗口之間也沒有亂碼', async () => {
    const text = `a\nb\n${'中文長行🏳️‍🌈'.repeat(40)}\nc\nd\n`;
    const { store } = storeOn(fake(text));
    const { entries, stop } = await readAll(store);
    expect(stop).toBe('end');
    expect(joined(entries)).toBe(expected(text));
    expect(entries.filter(isLongLine).map((line) => line.offset)).toEqual([2]);
  });

  it.each([
    ['長行在第 0 行', `${'x'.repeat(300)}\nshort\n`],
    ['BOM、長行不在第 0 行', `\uFEFFfirst\n${'y'.repeat(300)}\nlast`],
    ['BOM、長行在第 0 行', `\uFEFF${'z'.repeat(300)}\nlast`],
    ['CRLF', `one\r\ntwo\r\n${'w'.repeat(300)}\r\nthree\r\n`],
    ['兩條長行相鄰', `${'p'.repeat(200)}\n${'q'.repeat(200)}\nend`],
    ['長行是最後一行、沒有結尾換行', `head\n${'t'.repeat(300)}`],
    ['行首是 U+FEFF 的長行（不在檔頭，不能被吃掉）', `head\n\uFEFF${'u'.repeat(300)}\n`],
  ])('%s：接回來跟原檔逐字相同', async (_, text) => {
    const { store } = storeOn(fake(text));
    const { entries, stop } = await readAll(store);
    expect(stop).toBe('end');
    expect(joined(entries)).toBe(expected(text));
  });

  it('長行裡有 NUL：停在「接下來這一段不是文字」，前面讀到的照留', async () => {
    const bytes = encoder.encode(`ok\n${'n'.repeat(100)}\0${'n'.repeat(100)}\nafter`);
    const { store } = storeOn(fake(bytes));
    const { entries, stop } = await readAll(store);
    expect(stop).toBe('not-text');
    expect(entries.map((entry) => entry.text)).toEqual(['ok']);
  });

  it('長行裡不是 UTF-8：同上', async () => {
    const bytes = new Uint8Array([...encoder.encode(`ok\n${'n'.repeat(100)}`), 0xff, 0x0a]);
    const { store } = storeOn(fake(bytes));
    expect((await readAll(store)).stop).toBe('not-text');
  });

  it('位置對不上（例如文字頁少算了位元組）：是 invalid，不會悄悄畫錯一行', async () => {
    const text = `ab\n${'x'.repeat(300)}\n`;
    const drift = fake(text);
    const { store } = storeOn(drift);
    // 讀完第一頁之後把檔頭多塞一個位元組：之後的位置全部往後偏一格。
    store.load(1, 0, 0);
    await vi.waitFor(() => expect(isPage(store.read(1, 0, 0))).toBe(true));
    drift.bytes = encoder.encode(`zab\n${'x'.repeat(300)}\n`);
    const page = store.read(1, 0, 0) as DeliverableFilePage;
    expect(page.lines).toBe(1);
    store.load(1, 0, 1);
    await vi.waitFor(() => expect(store.read(1, 0, 1)).toBe('invalid'));
  });

  it('讀到一半檔被換掉：舊版本的格全部丟掉，不會拼出兩個版本', async () => {
    const changing = fake(`head\n${'x'.repeat(300)}\n`);
    const { store } = storeOn(changing);
    store.load(1, 0, 0);
    await vi.waitFor(() => expect(isPage(store.read(1, 0, 0))).toBe(true));
    store.load(1, 0, 1);
    await vi.waitFor(() => expect(isLongLine(store.read(1, 0, 1))).toBe(true));
    changing.version = 'v2';
    store.load(1, 0, 1);
    await vi.waitFor(() => expect(store.read(1, 0, 0)).toBeUndefined());
    expect(store.read(1, 0, 1)).toBeUndefined();
  });

  it('讀完的長行之後，下一頁換了版本：那條長行也一起丟掉', async () => {
    const changing = fake(`${'x'.repeat(300)}\nnext\n`);
    const { store } = storeOn(changing);
    await vi.waitFor(async () => {
      store.load(1, 0, 0);
      const line = store.read(1, 0, 0);
      if (isLongLine(line) && !line.done) store.load(1, 0, 0);
      expect(isLongLine(line) && line.done).toBe(true);
    });
    changing.version = 'v2';
    store.load(1, 0, 1);
    await vi.waitFor(() => expect(isPage(store.read(1, 0, 1))).toBe(true));
    expect(store.read(1, 0, 0)).toBeUndefined();
  });

  it('BOM 只查一次', async () => {
    const text = `\uFEFFa\n${'x'.repeat(200)}\nb\n${'y'.repeat(200)}\n`;
    const { store, urls } = storeOn(fake(text));
    await readAll(store);
    expect(urls.filter((url) => url.includes('length=3'))).toHaveLength(1);
  });
});

describe('中長的行太多：縮 limit 讀，不會變成「座標不對」', () => {
  it('第一頁就 413、maxLines 只有 3：整個檔讀得完，一次都沒停在 invalid', async () => {
    const line = 'm'.repeat(30);
    const text = `${Array(3).fill(line).join('\n')}\n${Array(40).fill('s').join('\n')}\n`;
    const { store, urls } = storeOn(fake(text, 64, 3));
    const { entries, stop } = await readAll(store);
    expect(stop).toBe('end');
    expect(joined(entries)).toBe(expected(text));
    expect(entries.some(isLongLine)).toBe(false);
    expect(urls.some((url) => url.includes('limit='))).toBe(true);
  });

  it('沒有 413 就一次都不送 limit', async () => {
    const { store, urls } = storeOn(fake('a\nb\nc'));
    expect((await readAll(store)).stop).toBe('end');
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.some((url) => url.includes('limit='))).toBe(false);
  });
});
