import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeliverablesCard } from '@/components/deliverable/deliverables-card';
import { createDeliverableDownloader } from '@/lib/deliverable-download';
import { MISSING_REASON, createDeliverableFileStore } from '@/lib/deliverable-file';
import type { LocatedFile } from '@/lib/deliverables-view';
import { axeViolations } from '@/test/axe';
import type { DeliverableCall, Reply } from '@/test/deliverable-commands';
import {
  badRequestReply,
  bytesReply,
  deliverableFetch,
  refuseReply,
  tooLargeReply,
} from '@/test/deliverable-commands';
import { memoryStorage, WithRightSidebar } from '@/test/right-sidebar';

const toastSpy = vi.hoisted(() => {
  const spy = vi.fn() as ReturnType<typeof vi.fn> & { error: ReturnType<typeof vi.fn> };
  spy.error = vi.fn();
  return spy;
});
vi.mock('sonner', () => ({ toast: toastSpy }));

/**
 * 下載鈕（#452 web 第三刀）：卡片那一列一顆，預覽面裡讀不到的那幾格一顆。
 *
 * **哪幾格有鈕是承重的**：`'not-text'` 與 `'too-large'` 有，`'missing'` 與 `'invalid'` 沒有——那兩種
 * 下載也救不了，給一顆按了一定失敗的鈕比不給更糟。位元組本身的驗收在 `lib/deliverable-download.test.ts`。
 */

const FILE: LocatedFile = { path: 'out/report.pdf', seq: 11, index: 0 };

let serial = 0;

beforeEach(() => {
  // 右側欄的版面記在 localStorage，每個測試換一份新的（見 changes-review.test.tsx）。
  vi.stubGlobal('localStorage', memoryStorage());
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
  vi.unstubAllGlobals();
  toastSpy.mockReset();
  toastSpy.error.mockReset();
});

/** 下載成功的回覆：兩個位元組。 */
const octets = () =>
  bytesReply({
    path: FILE.path,
    version: 'v1',
    bytes: 2,
    offset: 0,
    data: new Uint8Array([0x00, 0xff]),
    eof: true,
  });

/** 整檔下載：`readBytes` 不帶 `offset` 與 `length`。預覽讀的窗口一定帶 `offset`。 */
const isDownload = (call: DeliverableCall) =>
  call.method === 'deliverable.readBytes' &&
  call.params.offset === undefined &&
  call.params.length === undefined;

/**
 * 掛一張卡。`respond` 同時服務預覽（`deliverable.read`、窗口）與下載（整檔 `deliverable.readBytes`）兩種呼叫，
 * 用呼叫的內容分辨——真實情況也是同一條命令通道上的兩支方法。
 */
function mount(
  respond: (call: DeliverableCall) => Reply | Promise<Reply>,
  { withDownload = true }: { withDownload?: boolean } = {},
) {
  const { fetch: doFetch, calls } = deliverableFetch(respond);
  const wiring = { threadId: 't1', baseUrl: '', fetch: doFetch };
  const download = withDownload ? createDeliverableDownloader(wiring) : undefined;
  render(
    <WithRightSidebar
      sources={{
        deliverableFiles: createDeliverableFileStore(wiring),
        deliverableDownload: download,
      }}
    >
      <DeliverablesCard files={[FILE]} download={download} />
    </WithRightSidebar>,
  );
  return { calls };
}

const downloadCalls = (calls: readonly DeliverableCall[]) => calls.filter(isDownload);

describe('卡片上的下載鈕', () => {
  it('沒給 downloader 就不畫它——預覽與複製路徑照舊', () => {
    mount(() => octets(), { withDownload: false });
    expect(screen.queryByRole('button', { name: /^下載：/ })).toBeNull();
    expect(screen.getByRole('button', { name: `預覽：${FILE.path}` })).toBeTruthy();
    expect(screen.getByRole('button', { name: `複製路徑：${FILE.path}` })).toBeTruthy();
  });

  it('按了會用那個檔自己的座標打整檔的 readBytes', async () => {
    const { calls } = mount(() => octets());
    fireEvent.click(screen.getByRole('button', { name: `下載：${FILE.path}` }));
    await waitFor(() => expect(downloadCalls(calls)).toHaveLength(1));
    expect(downloadCalls(calls)[0]).toEqual({
      method: 'deliverable.readBytes',
      params: { seq: 11, index: 0 },
    });
    // 成功就不該有人被打擾。
    expect(toastSpy.error).not.toHaveBeenCalled();
  });

  it('飛行中按第二次不會再發一份——那是兩份整檔', async () => {
    let release = (_: Reply) => {};
    const inFlight = new Promise<Reply>((resolve) => {
      release = resolve;
    });
    const { calls } = mount(() => inFlight);
    const button = screen.getByRole('button', {
      name: `下載：${FILE.path}`,
    }) as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    fireEvent.click(button);
    expect(downloadCalls(calls)).toHaveLength(1);
    release(octets());
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it('同一拍內連點兩次也只發一份——那時 disabled 還沒生效', async () => {
    let release = (_: Reply) => {};
    const inFlight = new Promise<Reply>((resolve) => {
      release = resolve;
    });
    const { calls } = mount(() => inFlight);
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
    await waitFor(() => expect(downloadCalls(calls)).toHaveLength(1));
    expect(downloadCalls(calls)).toHaveLength(1);
    release(octets());
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it.each<[string, Reply, string]>([
    ['參數不合格（協定錯誤）', badRequestReply, '下載不了這個檔'],
    ['deliverable/not-found', refuseReply('deliverable/not-found'), '讀不到這個檔'],
    ['deliverable/too-large', tooLargeReply(), '檔案太大，連下載都超過上限'],
    // 下載不會收到 `not-text`；真收到就落在可重試的 error，見 `deliverable-download.ts` 檔頭。
    ['deliverable/not-text', refuseReply('deliverable/not-text'), '沒辦法下載這個檔'],
  ])('%s 講的是「%3$s」', async (_name, reply, said) => {
    mount(() => reply);
    fireEvent.click(screen.getByRole('button', { name: `下載：${FILE.path}` }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalled());
    expect(toastSpy.error.mock.calls[0]![0]).toBe(said);
  });

  it('讀不到的說明不斷言成因：不說「這一輪之後」，也講到路徑可能本來就不在工作區（#951）', async () => {
    mount(() => refuseReply('deliverable/not-found'));
    fireEvent.click(screen.getByRole('button', { name: `下載：${FILE.path}` }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalled());
    const [, options] = toastSpy.error.mock.calls[0]!;
    const description = (options as { description: string }).description;
    expect(description).toBe(MISSING_REASON);
    expect(description).not.toContain('這一輪之後');
    expect(description).toContain('本來就不在工作區');
  });

  it('axe：一列三顆圖示鈕沒有違規', async () => {
    mount(() => octets());
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('too-large 跟 error 講的不是同一件事——一個是終局，一個叫你再按一次', async () => {
    mount(() => tooLargeReply());
    fireEvent.click(screen.getByRole('button', { name: `下載：${FILE.path}` }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalled());
    const [, options] = toastSpy.error.mock.calls[0]!;
    // 終局不該叫人再試一次。
    expect((options as { description: string }).description).not.toContain('再按一次');
  });
});

describe('預覽面裡的下載鈕', () => {
  /** 開預覽，讓預覽那條回指定的拒絕；整檔下載照常成功。 */
  async function openPreviewWith(reply: Reply, options?: { withDownload?: boolean }) {
    const mounted = mount((call) => (isDownload(call) ? octets() : reply), options);
    fireEvent.click(screen.getByRole('button', { name: `預覽：${FILE.path}` }));
    return mounted;
  }

  it.each<[string, Reply, string]>([
    ['deliverable/not-text', refuseReply('deliverable/not-text'), '不是文字檔，沒辦法預覽'],
    ['deliverable/too-large', tooLargeReply(), '檔案太大，沒辦法在這裡預覽'],
  ])('%s 那一格有下載鈕，按了真的去下載', async (_name, reply, said) => {
    const { calls } = await openPreviewWith(reply);
    const sheet = within(await screen.findByRole('tabpanel'));
    expect(sheet.getByText(said)).toBeTruthy();
    fireEvent.click(sheet.getByRole('button', { name: /下載這個檔/ }));
    await waitFor(() => expect(downloadCalls(calls)).toHaveLength(1));
  });

  it.each<[string, Reply, string]>([
    [
      'deliverable/not-found',
      refuseReply('deliverable/not-found'),
      `讀不到這個檔：${MISSING_REASON}`,
    ],
    ['參數不合格（協定錯誤）', badRequestReply, '讀不到這個檔：座標不對'],
  ])('%s 那一格沒有下載鈕——下載也救不了它', async (_name, reply, said) => {
    await openPreviewWith(reply);
    const sheet = within(await screen.findByRole('tabpanel'));
    expect(sheet.getByText(said)).toBeTruthy();
    expect(sheet.queryByRole('button', { name: /下載這個檔/ })).toBeNull();
  });

  it('沒給 downloader 時那一格只剩一句話，仍然講得出發生什麼事', async () => {
    await openPreviewWith(refuseReply('deliverable/not-text'), { withDownload: false });
    const sheet = within(await screen.findByRole('tabpanel'));
    expect(sheet.getByText('不是文字檔，沒辦法預覽')).toBeTruthy();
    expect(sheet.queryByRole('button', { name: /下載這個檔/ })).toBeNull();
  });

  it('axe：帶下載鈕的那一格沒有違規', async () => {
    await openPreviewWith(refuseReply('deliverable/not-text'));
    await screen.findByRole('tabpanel');
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
