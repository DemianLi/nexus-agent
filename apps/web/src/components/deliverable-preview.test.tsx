import type { DeliverableFilePage } from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BLOCK_LINES, linesOf, loadedChain } from '@/components/deliverable-preview';
import { DeliverablesCard } from '@/components/deliverables-card';
import { createDeliverableFileStore } from '@/lib/deliverable-file';
import type { LocatedFile } from '@/lib/deliverables-view';
import { axeViolations } from '@/test/axe';

/**
 * 交付檔的預覽（#452 web 第二刀；#543 改成接續瀏覽）：從卡片上的座標開 `Sheet`，一段一段往下接。
 *
 * **五個狀態碼各釘自己那句話**。只斷言「有顯示東西」的話，413 與 422 互換之後它照樣綠——而那
 * 兩個講的不是同一件事：422 是「這個檔不是文字」，413 是「這一份太大」，成因與下一步都不同。
 * 第三刀之後兩格都有下載鈕（那幾條在 `deliverable-download-button.test.tsx`），這裡只管話術。
 *
 * **接續那幾條用一個手動的 IntersectionObserver 替身**：jsdom 沒有它，而元件在沒有它的環境會直接讀
 * （同 `use-viewport-highlighting.ts`），那樣「沒捲到底就不讀」這件事就驗不到了。
 */

/** 一個手動觸發的 IntersectionObserver：`nearBottom()` 假裝最後掛上的那一顆看到了。 */
class ManualObserver {
  static live: ManualObserver[] = [];
  readonly root: Element | null;
  constructor(
    private readonly callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    this.root = (options?.root as Element | null | undefined) ?? null;
    ManualObserver.live.push(this);
  }
  observe() {}
  unobserve() {}
  takeRecords() {
    return [];
  }
  disconnect() {
    ManualObserver.live = ManualObserver.live.filter((one) => one !== this);
  }
  fire() {
    this.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

/** 假裝捲到接近底。沒有掛著的觀察器時什麼都不做 —— 那正是「不該再讀」的長相。 */
function nearBottom() {
  act(() => {
    for (const one of [...ManualObserver.live]) one.fire();
  });
}

beforeEach(() => {
  ManualObserver.live = [];
  vi.stubGlobal('IntersectionObserver', ManualObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const FILE: LocatedFile = { path: 'out/report.md', seq: 11, index: 0 };

/** 路由真的形狀：`text` 是 `join('\n')`，結尾沒有換行。 */
const PAGE: DeliverableFilePage = {
  path: 'out/report.md',
  version: 'v1',
  bytes: 15,
  offset: 0,
  text: '第一段內容',
  lines: 1,
  eof: true,
};

/** 從 `offset` 開始的 `n` 行，每行寫著自己的行號（1 起算），好對照畫面上的行號。 */
function numbered(offset: number, n: number, eof: boolean): DeliverableFilePage {
  const lines = Array.from({ length: n }, (_, i) => `line-${offset + i + 1}`);
  return { ...PAGE, offset, text: lines.join('\n'), lines: n, eof };
}

function mount(respond: (url: string) => Response, files: readonly LocatedFile[] = [FILE]) {
  const doFetch = vi.fn(async (input: RequestInfo | URL) =>
    respond(String(input)),
  ) as unknown as typeof globalThis.fetch;
  const store = createDeliverableFileStore({ threadId: 't1', baseUrl: '', fetch: doFetch });
  render(<DeliverablesCard files={files} preview={store} />);
  return { doFetch, store };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

/** 回應裡的 `offset=` 是多少。 */
const offsetOf = (url: string) => Number(new URL(url, 'http://x').searchParams.get('offset'));

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

/** 畫面上每一行的行號，依序。 */
function shownLineNumbers(): number[] {
  return [...document.querySelectorAll('[data-line]')].map((line) =>
    Number(line.getAttribute('data-line')),
  );
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

  it('空檔講「這個檔是空的」，不是畫一片空白', async () => {
    mount(() => json({ ...PAGE, text: '', lines: 0, eof: true }));
    open();
    expect(await screen.findByText('這個檔是空的')).toBeTruthy();
  });

  it('axe：開著的預覽沒有違規', async () => {
    mount(() => json(PAGE));
    open();
    await screen.findByText('第一段內容');
    expect(await axeViolations(document.body)).toEqual([]);
  });
});

describe('接續瀏覽（#543）', () => {
  it('第一段不等捲動就讀；沒捲到接近底之前不讀下一段', async () => {
    const { doFetch } = mount((url) =>
      json(offsetOf(url) === 0 ? numbered(0, 3, false) : numbered(3, 2, true)),
    );
    open();
    expect(await screen.findByText('line-1')).toBeTruthy();
    // **第一段不能靠 IntersectionObserver**：看不見的頁面不會觸發它（#543 量具那一段）。
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it('捲到接近底就接下一段，**前一段還在**，下一段的 offset 是 offset + lines', async () => {
    const { doFetch } = mount((url) =>
      json(offsetOf(url) === 0 ? numbered(0, 3, false) : numbered(3, 2, true)),
    );
    open();
    await screen.findByText('line-1');
    nearBottom();
    expect(await screen.findByText('line-5')).toBeTruthy();
    // 接續，不是換頁：舊的做法按下去 line-1 就不見了。
    expect(screen.getByText('line-1')).toBeTruthy();
    // **是 offset + lines，不是 offset + 我們記著的每頁行數**：每頁幾行由路由決定。
    expect(offsetOf(requestedUrl(doFetch, 1))).toBe(3);
    expect(shownLineNumbers()).toEqual([1, 2, 3, 4, 5]);
  });

  it('到檔尾就不再掛觀察器，捲到底也不再讀', async () => {
    const { doFetch } = mount(() => json(numbered(0, 3, true)));
    open();
    await screen.findByText('line-3');
    nearBottom();
    nearBottom();
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(ManualObserver.live).toHaveLength(0);
  });

  it('後面那段讀壞了：前面的照畫、失敗接在最後、給重試，**而且捲到底不會自動重打**', async () => {
    let broken = true;
    const { doFetch } = mount((url) =>
      offsetOf(url) === 0
        ? json(numbered(0, 3, false))
        : broken
          ? new Response('', { status: 500 })
          : json(numbered(3, 1, true)),
    );
    open();
    await screen.findByText('line-3');
    nearBottom();
    expect(await screen.findByText('沒辦法讀取下一段')).toBeTruthy();
    expect(screen.getByText('line-1')).toBeTruthy();
    // 讀壞了之後不掛觀察器：再怎麼捲都不打。
    nearBottom();
    nearBottom();
    expect(doFetch).toHaveBeenCalledTimes(2);
    // 人按了才打。
    broken = false;
    fireEvent.click(screen.getByRole('button', { name: '重試' }));
    expect(await screen.findByText('line-4')).toBeTruthy();
    expect(offsetOf(requestedUrl(doFetch, 2))).toBe(3);
  });

  it('後面那段太大：話講成「接下來這一段」，不是整個檔', async () => {
    mount((url) =>
      offsetOf(url) === 0 ? json(numbered(0, 3, false)) : new Response('', { status: 413 }),
    );
    open();
    await screen.findByText('line-3');
    nearBottom();
    expect(await screen.findByText('接下來這一段太大，沒辦法在這裡預覽')).toBeTruthy();
    expect(screen.queryByText('檔案太大，沒辦法在這裡預覽')).toBeNull();
  });

  it(`每 ${BLOCK_LINES} 行一塊 content-visibility 邊界，**不是一段一塊**`, async () => {
    // 一段一塊的話，「打開預覽」那一段正好在畫面裡，照付全額 —— 量到 1634ms，等於沒加。
    const n = BLOCK_LINES * 2 + 5;
    mount(() => json(numbered(0, n, true)));
    open();
    await screen.findByText(`line-${n}`);
    const blocks = [...document.querySelectorAll('[data-preview-block]')];
    expect(blocks.map((block) => block.querySelectorAll('[data-line]').length)).toEqual([
      BLOCK_LINES,
      BLOCK_LINES,
      5,
    ]);
    for (const block of blocks) expect(block.className).toContain('[content-visibility:auto]');
  });

  it('行號不在文字裡（畫在 ::before），複製出來的是原文', async () => {
    mount(() => json(numbered(0, 2, true)));
    open();
    await screen.findByText('line-2');
    expect(screen.getByTestId('preview-text').textContent).toBe('line-1\nline-2\n');
  });

  it('預設自動換行，按一下切成橫向捲動', async () => {
    mount(() => json(PAGE));
    open();
    await screen.findByText('第一段內容');
    const toggle = screen.getByRole('button', { name: '自動換行' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('preview-text').hasAttribute('data-preview-wrap')).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('preview-text').hasAttribute('data-preview-wrap')).toBe(false);
  });
});

describe('linesOf', () => {
  it('路由的 text 結尾沒有換行，切出來剛好 lines 行', () => {
    expect(linesOf({ ...PAGE, text: 'a\nb', lines: 2 })).toEqual(['a', 'b']);
    // 空行是一行，不是沒有。
    expect(linesOf({ ...PAGE, text: '', lines: 1 })).toEqual(['']);
  });

  it('lines 是 0 就是空陣列，不是一個空行', () => {
    expect(linesOf({ ...PAGE, text: '', lines: 0 })).toEqual([]);
  });
});

describe('loadedChain', () => {
  function storeOf(pages: Record<number, DeliverableFilePage | 'loading'>) {
    return {
      read: (_seq: number, _index: number, offset: number) => pages[offset],
      load: () => {},
      subscribe: () => () => {},
      revision: () => 0,
    };
  }

  it('走出連續前綴，停在第一個還沒讀的地方', () => {
    const chain = loadedChain(
      storeOf({ 0: numbered(0, 3, false), 3: numbered(3, 2, false) }),
      1,
      0,
    );
    expect(chain.pages.map((page) => page.offset)).toEqual([0, 3]);
    expect(chain.tail).toEqual({ kind: 'next', offset: 5 });
  });

  it('正在讀的那一格停住', () => {
    const chain = loadedChain(storeOf({ 0: numbered(0, 3, false), 3: 'loading' }), 1, 0);
    expect(chain.tail).toEqual({ kind: 'loading', offset: 3 });
  });

  it('lines 是 0 卻沒到檔尾：當成檔尾，不會原地打轉', () => {
    // offset 不前進的話這個迴圈永遠不結束 —— 測試會直接卡死，而不是紅。
    const chain = loadedChain(storeOf({ 0: { ...PAGE, text: '', lines: 0, eof: false } }), 1, 0);
    expect(chain.tail).toEqual({ kind: 'end' });
  });
});
