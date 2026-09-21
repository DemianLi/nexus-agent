import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeliverablesCard } from '@/components/deliverables-card';
import { createDeliverableDownloader } from '@/lib/deliverable-download';
import { createDeliverableFileStore } from '@/lib/deliverable-file';
import type { LocatedFile } from '@/lib/deliverables-view';
import { axeViolations } from '@/test/axe';

const toastSpy = vi.hoisted(() => {
  const spy = vi.fn() as ReturnType<typeof vi.fn> & { error: ReturnType<typeof vi.fn> };
  spy.error = vi.fn();
  return spy;
});
vi.mock('sonner', () => ({ toast: toastSpy }));

/**
 * 下載鈕（#452 web 第三刀）：卡片那一列一顆，預覽面裡讀不到的那幾格一顆。
 *
 * **哪幾格有鈕是承重的**：`'binary'` 與 `'too-large'` 有，`'missing'` 與 `'invalid'` 沒有——那兩種
 * 下載也救不了，給一顆按了一定失敗的鈕比不給更糟。位元組本身的驗收在 `lib/deliverable-download.test.ts`。
 */

const FILE: LocatedFile = { path: 'out/report.pdf', seq: 11, index: 0 };

let serial = 0;

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => {
    serial += 1;
    return `blob:fake/${serial}`;
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  toastSpy.mockReset();
  toastSpy.error.mockReset();
});

/** 下載成功的回應。 */
const octets = () =>
  new Response(new Uint8Array([0x00, 0xff]).buffer as ArrayBuffer, {
    headers: { 'content-type': 'application/octet-stream' },
  });

/**
 * 掛一張卡。`respond` 同時服務預覽與下載兩條路由，用 URL 分辨——真實情況也是同一個 origin 上
 * 的兩條路由。
 */
function mount(
  respond: (url: string) => Response | Promise<Response>,
  { withDownload = true }: { withDownload?: boolean } = {},
) {
  const doFetch = vi.fn(async (input: RequestInfo | URL) =>
    respond(String(input)),
  ) as unknown as typeof globalThis.fetch;
  const wiring = { threadId: 't1', baseUrl: '', fetch: doFetch };
  render(
    <DeliverablesCard
      files={[FILE]}
      preview={createDeliverableFileStore(wiring)}
      download={withDownload ? createDeliverableDownloader(wiring) : undefined}
    />,
  );
  return { doFetch };
}

const downloadCalls = (doFetch: unknown) =>
  (doFetch as ReturnType<typeof vi.fn>).mock.calls.filter((call) =>
    String(call[0]).includes('/deliverables/download'),
  );

describe('卡片上的下載鈕', () => {
  it('沒給 downloader 就不畫它——預覽與複製路徑照舊', () => {
    mount(() => octets(), { withDownload: false });
    expect(screen.queryByRole('button', { name: /^下載：/ })).toBeNull();
    expect(screen.getByRole('button', { name: `預覽：${FILE.path}` })).toBeTruthy();
    expect(screen.getByRole('button', { name: `複製路徑：${FILE.path}` })).toBeTruthy();
  });

  it('按了會用那個檔自己的座標打下載路由', async () => {
    const { doFetch } = mount(() => octets());
    fireEvent.click(screen.getByRole('button', { name: `下載：${FILE.path}` }));
    await waitFor(() => expect(downloadCalls(doFetch)).toHaveLength(1));
    const url = String(downloadCalls(doFetch)[0]![0]);
    expect(url).toContain('seq=11');
    expect(url).toContain('index=0');
    // 成功就不該有人被打擾。
    expect(toastSpy.error).not.toHaveBeenCalled();
  });

  it('飛行中按第二次不會再發一份——那是兩份整檔', async () => {
    let release = (_: Response) => {};
    const inFlight = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { doFetch } = mount(() => inFlight);
    const button = screen.getByRole('button', {
      name: `下載：${FILE.path}`,
    }) as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    fireEvent.click(button);
    expect(downloadCalls(doFetch)).toHaveLength(1);
    release(octets());
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it('同一拍內連點兩次也只發一份——那時 disabled 還沒生效', async () => {
    let release = (_: Response) => {};
    const inFlight = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { doFetch } = mount(() => inFlight);
    const button = screen.getByRole('button', {
      name: `下載：${FILE.path}`,
    }) as HTMLButtonElement;
    // **不用 `fireEvent`**：它每次都會 flush，第二次點下去時鈕已經是 `disabled`，那樣擋住的是
    // 屬性、不是 `run` 裡那道守衛——把守衛拿掉這條測試照樣綠（量過）。真實的競態發生在 re-render
    // 之前，所以兩次派發要落在同一個 act 批次裡。
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => expect(downloadCalls(doFetch)).toHaveLength(1));
    expect(downloadCalls(doFetch)).toHaveLength(1);
    release(octets());
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it.each([
    [400, '下載不了這個檔'],
    [404, '這個檔已經讀不到了'],
    [413, '檔案太大，連下載都超過上限'],
    [500, '沒辦法下載這個檔'],
  ])('%i 講的是「%s」', async (status, said) => {
    mount(() => new Response('', { status }));
    fireEvent.click(screen.getByRole('button', { name: `下載：${FILE.path}` }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalled());
    expect(toastSpy.error.mock.calls[0]![0]).toBe(said);
  });

  it('axe：一列三顆圖示鈕沒有違規', async () => {
    mount(() => octets());
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('413 跟 500 講的不是同一件事——一個是終局，一個叫你再按一次', async () => {
    mount(() => new Response('', { status: 413 }));
    fireEvent.click(screen.getByRole('button', { name: `下載：${FILE.path}` }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalled());
    const [, options] = toastSpy.error.mock.calls[0]!;
    // 終局不該叫人再試一次。
    expect((options as { description: string }).description).not.toContain('再按一次');
  });
});

describe('預覽面裡的下載鈕', () => {
  /** 開預覽，讓預覽那條回指定的狀態碼。 */
  async function openPreviewWith(status: number, options?: { withDownload?: boolean }) {
    const mounted = mount(
      (url) => (url.includes('/deliverables/download') ? octets() : new Response('', { status })),
      options,
    );
    fireEvent.click(screen.getByRole('button', { name: `預覽：${FILE.path}` }));
    return mounted;
  }

  it.each([
    [422, '二進位檔，沒辦法預覽'],
    [413, '檔案太大，沒辦法在這裡預覽'],
  ])('%i 那一格有下載鈕，按了真的去下載', async (status, said) => {
    const { doFetch } = await openPreviewWith(status);
    const sheet = within(await screen.findByRole('dialog'));
    expect(sheet.getByText(said)).toBeTruthy();
    fireEvent.click(sheet.getByRole('button', { name: /下載這個檔/ }));
    await waitFor(() => expect(downloadCalls(doFetch)).toHaveLength(1));
  });

  it.each([
    [404, '這個檔已經讀不到了'],
    [400, '讀不到這個檔：座標不對'],
  ])('%i 那一格沒有下載鈕——下載也救不了它', async (status, said) => {
    await openPreviewWith(status);
    const sheet = within(await screen.findByRole('dialog'));
    expect(sheet.getByText(said)).toBeTruthy();
    expect(sheet.queryByRole('button', { name: /下載這個檔/ })).toBeNull();
  });

  it('沒給 downloader 時那一格只剩一句話，仍然講得出發生什麼事', async () => {
    await openPreviewWith(422, { withDownload: false });
    const sheet = within(await screen.findByRole('dialog'));
    expect(sheet.getByText('二進位檔，沒辦法預覽')).toBeTruthy();
    expect(sheet.queryByRole('button', { name: /下載這個檔/ })).toBeNull();
  });

  it('axe：帶下載鈕的那一格沒有違規', async () => {
    await openPreviewWith(422);
    await screen.findByRole('dialog');
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
