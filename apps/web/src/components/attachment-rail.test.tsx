import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AttachmentRail } from '@/components/attachment-rail';
import type { DraftAttachment } from '@/lib/attachments';
import type { UploadStates } from '@/lib/upload-state';
import { axeViolations } from '@/test/axe';

/** 附件卡的上傳進度與取消（#733）。 */

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

const pdf = (name: string, size = 12_595): DraftAttachment => ({
  id: name,
  file: new File(['x'.repeat(size)], name, { type: 'application/pdf' }),
  kind: 'file',
});
const png: DraftAttachment = {
  id: 'shot.png',
  file: new File(['x'.repeat(2048)], 'shot.png', { type: 'image/png' }),
  kind: 'image',
  previewUrl: 'blob:preview',
};

const states = (
  entries: readonly (readonly [
    string,
    UploadStates extends ReadonlyMap<string, infer V> ? V : never,
  ])[],
) => new Map(entries);

const card = (name: string) =>
  screen.getAllByTestId('draft-attachment').find((el) => el.textContent?.includes(name))!;

describe('附件列：上傳狀態（#733）', () => {
  it('沒有紀錄：跟沒有這個功能時一樣——「副檔名 · 大小」、移除鈕、沒有進度條與取消鈕', () => {
    render(<AttachmentRail items={[pdf('plan.pdf')]} onRemove={() => {}} />);
    expect(card('plan.pdf').textContent).toContain('PDF · 12.3 KB');
    expect(card('plan.pdf').getAttribute('data-upload')).toBe('none');
    expect(screen.getByRole('button', { name: '移除 plan.pdf' })).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByTestId('upload-cancel')).toBeNull();
  });

  it('上傳中有總量：進度條帶百分比，名稱說上傳哪一個；移除鈕換成取消鈕', () => {
    const onCancel = vi.fn();
    const onRemove = vi.fn();
    render(
      <AttachmentRail
        items={[pdf('plan.pdf')]}
        onRemove={onRemove}
        uploads={states([['plan.pdf', { kind: 'uploading', loaded: 456, total: 1000 }]])}
        onCancelUpload={onCancel}
      />,
    );
    const bar = screen.getByRole('progressbar', { name: '上傳 plan.pdf' });
    expect(bar.getAttribute('aria-valuenow')).toBe('45');
    expect(bar.getAttribute('aria-valuetext')).toBe('上傳中 45%');
    expect(card('plan.pdf').textContent).toContain('上傳中 45%');
    expect(screen.queryByRole('button', { name: '移除 plan.pdf' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '取消上傳 plan.pdf' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('上傳中不知道總量：進度條不給 aria-valuenow（不猜百分比），字寫已送出的量', () => {
    render(
      <AttachmentRail
        items={[pdf('plan.pdf')]}
        onRemove={() => {}}
        uploads={states([['plan.pdf', { kind: 'uploading', loaded: 2048 }]])}
      />,
    );
    const bar = screen.getByRole('progressbar');
    expect(bar.hasAttribute('aria-valuenow')).toBe(false);
    expect(card('plan.pdf').textContent).toContain('上傳中 2.0 KB');
  });

  it('取消後那張卡回到未上傳：寫「未上傳（已取消）」，沒有進度條，可以移除', () => {
    const onRemove = vi.fn();
    render(
      <AttachmentRail
        items={[pdf('plan.pdf')]}
        onRemove={onRemove}
        uploads={states([['plan.pdf', { kind: 'idle', reason: 'cancelled' }]])}
      />,
    );
    expect(card('plan.pdf').textContent).toContain('未上傳（已取消）');
    expect(card('plan.pdf').getAttribute('data-state')).toBe('idle');
    expect(screen.queryByRole('progressbar')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '移除 plan.pdf' }));
    expect(onRemove).toHaveBeenCalledWith('plan.pdf');
  });

  it('上傳失敗的卡：寫「未上傳（上傳失敗）」，用錯誤樣式，可以移除', () => {
    render(
      <AttachmentRail
        items={[pdf('plan.pdf')]}
        onRemove={() => {}}
        uploads={states([['plan.pdf', { kind: 'idle', reason: 'failed' }]])}
      />,
    );
    expect(card('plan.pdf').textContent).toContain('未上傳（上傳失敗）');
    expect(card('plan.pdf').getAttribute('data-state')).toBe('error');
    expect(screen.getByRole('button', { name: '移除 plan.pdf' })).toBeTruthy();
  });

  it('已上傳、等伺服器收下的那段：寫已上傳，不能移除也沒有取消', () => {
    render(
      <AttachmentRail
        items={[pdf('plan.pdf')]}
        onRemove={() => {}}
        uploads={states([['plan.pdf', { kind: 'done' }]])}
      />,
    );
    expect(card('plan.pdf').textContent).toContain('已上傳');
    expect(screen.queryByRole('button', { name: '移除 plan.pdf' })).toBeNull();
    expect(screen.queryByTestId('upload-cancel')).toBeNull();
  });

  it('各張各畫各的：圖沒有紀錄照常畫，旁邊的檔案在上傳', () => {
    render(
      <AttachmentRail
        items={[png, pdf('plan.pdf')]}
        onRemove={() => {}}
        uploads={states([['plan.pdf', { kind: 'uploading', loaded: 10, total: 100 }]])}
        onCancelUpload={() => {}}
      />,
    );
    expect(card('shot.png').getAttribute('data-upload')).toBe('none');
    expect(screen.getByRole('button', { name: '移除 shot.png' })).toBeTruthy();
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
  });

  it('無障礙：上傳中與取消後都沒有違規', async () => {
    const { container, rerender } = render(
      <AttachmentRail
        items={[pdf('plan.pdf')]}
        onRemove={() => {}}
        uploads={states([['plan.pdf', { kind: 'uploading', loaded: 10, total: 100 }]])}
        onCancelUpload={() => {}}
      />,
    );
    expect(await axeViolations(container)).toEqual([]);
    rerender(
      <AttachmentRail
        items={[pdf('plan.pdf')]}
        onRemove={() => {}}
        uploads={states([['plan.pdf', { kind: 'idle', reason: 'cancelled' }]])}
      />,
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});
