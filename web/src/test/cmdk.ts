import { vi } from 'vitest';

/**
 * cmdk 的清單用到 jsdom 沒有的兩個 API：`ResizeObserver`（量清單高度）與 `scrollIntoView`（把選中的項目捲進來）。
 * 會打開 `/` 選單的測試先叫這個。
 */
export function stubCmdkLayout(): void {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
  }
  Element.prototype.scrollIntoView ??= () => {};
}
