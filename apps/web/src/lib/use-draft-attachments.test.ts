import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDraftAttachments } from '@/lib/use-draft-attachments';

const png = (name = 'a.png') => new File(['x'], name, { type: 'image/png' });
const pdf = (name = 'a.pdf') => new File(['x'], name, { type: 'application/pdf' });

let created = 0;
const revoke = vi.fn();

beforeEach(() => {
  created = 0;
  revoke.mockReset();
  URL.createObjectURL = vi.fn(() => `blob:preview-${(created += 1)}`);
  URL.revokeObjectURL = revoke;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('草稿附件的狀態', () => {
  it('照選取的順序排；圖有預覽網址、檔案沒有', () => {
    const { result } = renderHook(() => useDraftAttachments());
    act(() => result.current.add([png('1.png'), pdf('2.pdf'), png('3.png')]));
    expect(result.current.items.map((item) => [item.file.name, item.kind])).toEqual([
      ['1.png', 'image'],
      ['2.pdf', 'file'],
      ['3.png', 'image'],
    ]);
    expect(result.current.items.map((item) => item.previewUrl)).toEqual([
      'blob:preview-1',
      undefined,
      'blob:preview-2',
    ]);
    expect(new Set(result.current.items.map((item) => item.id)).size).toBe(3);
  });

  it('再加一批接在後面，不蓋掉原本的；空陣列不動', () => {
    const { result } = renderHook(() => useDraftAttachments());
    act(() => result.current.add([pdf('1.pdf')]));
    const before = result.current.items;
    act(() => result.current.add([]));
    expect(result.current.items).toBe(before);
    act(() => result.current.add([pdf('2.pdf')]));
    expect(result.current.items.map((item) => item.file.name)).toEqual(['1.pdf', '2.pdf']);
  });

  it('移除一個：只 revoke 它的預覽網址，其他留著', () => {
    const { result } = renderHook(() => useDraftAttachments());
    act(() => result.current.add([png('1.png'), png('2.png')]));
    const [first, second] = result.current.items;
    act(() => result.current.remove(first!.id));
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith('blob:preview-1');
    expect(result.current.items.map((item) => item.id)).toEqual([second!.id]);
  });

  it('移除沒有預覽的檔案不 revoke；移除不存在的 id 什麼都不做', () => {
    const { result } = renderHook(() => useDraftAttachments());
    act(() => result.current.add([pdf()]));
    act(() => result.current.remove(result.current.items[0]!.id));
    act(() => result.current.remove('attachment-999'));
    expect(revoke).not.toHaveBeenCalled();
    expect(result.current.items).toEqual([]);
  });

  it('清空：全部 revoke', () => {
    const { result } = renderHook(() => useDraftAttachments());
    act(() => result.current.add([png('1.png'), pdf(), png('2.png')]));
    act(() => result.current.clear());
    expect(revoke.mock.calls.map(([url]) => url).sort()).toEqual([
      'blob:preview-1',
      'blob:preview-2',
    ]);
    expect(result.current.items).toEqual([]);
  });

  it('卸載時 revoke 當下還在的（不是第一次渲染時的）', () => {
    const { result, unmount } = renderHook(() => useDraftAttachments());
    act(() => result.current.add([png('1.png'), png('2.png')]));
    act(() => result.current.remove(result.current.items[0]!.id));
    revoke.mockClear();
    unmount();
    expect(revoke.mock.calls).toEqual([['blob:preview-2']]);
  });
});
