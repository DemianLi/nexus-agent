import type { DeliverableFilePage } from '@nexus/wire';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeliverablesCard } from '@/components/deliverables-card';
import { createDeliverableFileStore } from '@/lib/deliverable-file';
import type { LocatedFile } from '@/lib/deliverables-view';
import { axeViolations } from '@/test/axe';

/**
 * 交付檔的預覽（#452 web 第二刀）：從卡片上的座標開 `Sheet`，一頁一頁讀。
 *
 * **五個狀態碼各釘自己那句話**。只斷言「有顯示東西」的話，413 與 422 互換之後它照樣綠——而那
 * 兩個講的不是同一件事：422 是「這個檔不是文字」，413 是「這一份太大」，成因與下一步都不同。
 * 第三刀之後兩格都有下載鈕（那幾條在 `deliverable-download-button.test.tsx`），這裡只管話術。
 */

afterEach(cleanup);

const FILE: LocatedFile = { path: 'out/report.md', seq: 11, index: 0 };

const PAGE: DeliverableFilePage = {
  path: 'out/report.md',
  version: 'v1',
  bytes: 9,
  offset: 0,
  text: '第一段內容\n',
  lines: 1,
  eof: true,
};

function mount(respond: (url: string) => Response, files: readonly LocatedFile[] = [FILE]) {
  const doFetch = vi.fn(async (input: RequestInfo | URL) =>
    respond(String(input)),
  ) as unknown as typeof globalThis.fetch;
  const store = createDeliverableFileStore({ threadId: 't1', baseUrl: '', fetch: doFetch });
  render(<DeliverablesCard files={files} preview={store} />);
  return { doFetch };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

/**
 * 第 n 次請求的 URL。
 *
 * `mock.calls` 的每一格在型別上都可能是 `undefined`（`noUncheckedIndexedAccess`），所以這裡**斷言一次**
 * 而不是一路 `?.`——沒發生的那次請求要當場紅，不是靜靜變成字串 "undefined" 然後 `toContain` 失敗。
 */
function requestedUrl(doFetch: typeof globalThis.fetch, nth: number): string {
  const call = (doFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[nth];
  expect(call).toBeDefined();
  return String((call as unknown[])[0]);
}

/** 按下那個檔的預覽鈕。 */
function open(file: LocatedFile = FILE) {
  fireEvent.click(screen.getByRole('button', { name: `預覽：${file.path}` }));
}

describe('交付檔預覽', () => {
  it('沒給 store 就沒有預覽鈕（卡片其餘照畫）', () => {
    render(<DeliverablesCard files={[FILE]} />);
    expect(screen.queryByRole('button', { name: /^預覽：/ })).toBeNull();
    // 複製路徑不需要讀檔，所以它還在。
    expect(screen.getByRole('button', { name: `複製路徑：${FILE.path}` })).toBeTruthy();
  });

  it('按預覽會用那個檔自己的座標去讀，標題是檔名、副標是完整路徑', async () => {
    const { doFetch } = mount(() => json(PAGE));
    open();
    expect(await screen.findByText('第一段內容')).toBeTruthy();
    const url = requestedUrl(doFetch, 0);
    expect(url).toContain('seq=11');
    expect(url).toContain('index=0');
    // **在預覽面裡面找**：卡片那一列也印著同一個路徑，整頁找會撞到兩個。
    expect(within(screen.getByRole('dialog')).getByText('out/report.md')).toBeTruthy();
  });

  it('座標取自那一列，不是列表位置（#452）', async () => {
    // 第二列的座標是 `(22, 0)`——它是第二顆事件宣告的第一個檔。拿 map 的索引頂替就會送 index=1。
    const second: LocatedFile = { path: 'b.md', seq: 22, index: 0 };
    const { doFetch } = mount(() => json(PAGE), [FILE, second]);
    open(second);
    await screen.findByText('第一段內容');
    const url = requestedUrl(doFetch, 0);
    expect(url).toContain('seq=22');
    expect(url).toContain('index=0');
  });

  it.each([
    [400, '讀不到這個檔：座標不對'],
    [404, '這個檔已經讀不到了'],
    [413, '檔案太大，沒辦法在這裡預覽'],
    [422, '二進位檔，沒辦法預覽'],
  ])('%i 畫的是「%s」，而且沒有重試鈕', async (status, said) => {
    mount(() => new Response('', { status }));
    open();
    expect(await screen.findByText(said)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重試' })).toBeNull();
  });

  it('讀壞了才給重試，按了會再打一次', async () => {
    let broken = true;
    const { doFetch } = mount(() => (broken ? new Response('', { status: 500 }) : json(PAGE)));
    open();
    expect(await screen.findByText('沒辦法讀取這個檔')).toBeTruthy();
    broken = false;
    fireEvent.click(screen.getByRole('button', { name: '重試' }));
    expect(await screen.findByText('第一段內容')).toBeTruthy();
    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it('還沒到檔尾才給「讀下一段」，下一頁的 offset 是 offset + lines', async () => {
    const { doFetch } = mount((url) =>
      url.includes('offset=0')
        ? json({ ...PAGE, eof: false, lines: 3, text: '頭\n' })
        : json({ ...PAGE, offset: 3, text: '尾\n', eof: true }),
    );
    open();
    expect(await screen.findByText('頭')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /讀下一段/ }));
    expect(await screen.findByText('尾')).toBeTruthy();
    // **是 offset + lines，不是 offset + 我們記著的每頁行數**：每頁幾行由路由決定。
    expect(requestedUrl(doFetch, 1)).toContain('offset=3');
    // 到檔尾就收起那顆鈕。
    expect(screen.queryByRole('button', { name: /讀下一段/ })).toBeNull();
  });

  it('到檔尾就沒有「讀下一段」', async () => {
    mount(() => json(PAGE));
    open();
    await screen.findByText('第一段內容');
    expect(screen.queryByRole('button', { name: /讀下一段/ })).toBeNull();
  });

  it('axe：開著的預覽沒有違規', async () => {
    mount(() => json(PAGE));
    open();
    await screen.findByText('第一段內容');
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
