import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RESIZE_SETTLE_MS, useResizeTransition } from '@/hooks/use-resize-transition';

/**
 * 換內容時的高度過渡（#1306，§7 resize 300）。jsdom 沒有版面：自然高度由 {@link natural} 決定，釘了 `style.height`
 * 就回釘住的值，跟瀏覽器一樣。jsdom 也沒有 `ResizeObserver`，所以換之前的高度走「每次 render 後量」那條。
 */

let natural = 0;
const heightOf = (element: HTMLElement) =>
  element.style.height === '' ? natural : Number.parseFloat(element.style.height);

/** 每一次寫 `style.height` 的值，照順序。 */
let writes: string[] = [];

beforeEach(() => {
  natural = 100;
  writes = [];
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return heightOf(this);
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return { height: heightOf(this) } as DOMRect;
  });
  const descriptor = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'height')!;
  vi.spyOn(CSSStyleDeclaration.prototype, 'height', 'set').mockImplementation(function (
    this: CSSStyleDeclaration,
    value: string,
  ) {
    writes.push(value);
    descriptor.set!.call(this, value);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function Box({ page }: { page: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useResizeTransition(ref, page);
  return (
    <div ref={ref} className="motion-resize" data-testid="box">
      第 {page} 頁
    </div>
  );
}

function show() {
  const view = render(<Box page={1} />);
  const box = view.getByTestId('box');
  return { box, go: (page: number) => view.rerender(<Box page={page} />) };
}

describe('換內容時高度過渡', () => {
  it('第一次畫出來不動', () => {
    const { box } = show();
    expect(box.hasAttribute('data-resizing')).toBe(false);
    expect(writes).toEqual([]);
  });

  it('換頁：先釘回舊高度、掛上 data-resizing，再設成新高度；transitionend 後放開', () => {
    const { box, go } = show();
    natural = 240;
    go(2);
    expect(writes).toEqual(['100px', '240px']);
    expect(box.hasAttribute('data-resizing')).toBe(true);
    expect(box.style.height).toBe('240px');

    // 子元素自己的過渡不算。
    const child = document.createElement('span');
    box.append(child);
    fireEvent(
      child,
      Object.assign(new Event('transitionend', { bubbles: true }), { propertyName: 'height' }),
    );
    expect(box.hasAttribute('data-resizing')).toBe(true);

    fireEvent(box, Object.assign(new Event('transitionend'), { propertyName: 'height' }));
    expect(box.hasAttribute('data-resizing')).toBe(false);
    expect(box.style.height).toBe('');
  });

  it('transitionend 沒來也會在保險時間到時放開', () => {
    vi.useFakeTimers();
    const { box, go } = show();
    natural = 60;
    go(2);
    expect(box.hasAttribute('data-resizing')).toBe(true);
    act(() => vi.advanceTimersByTime(RESIZE_SETTLE_MS));
    expect(box.hasAttribute('data-resizing')).toBe(false);
    expect(box.style.height).toBe('');
  });

  it('過渡中又換頁：從當下的高度接著走，不先跳回去', () => {
    const { box, go } = show();
    natural = 240;
    go(2);
    natural = 180;
    go(3);
    // 第二次的起點是第一次釘住的 240（jsdom 沒有動畫中途值，釘住的值就是當下），終點是新的 180。
    expect(writes.slice(-2)).toEqual(['240px', '180px']);
    expect(box.hasAttribute('data-resizing')).toBe(true);
  });

  it('高度沒變就不碰', () => {
    const { box, go } = show();
    go(2);
    expect(writes).toEqual([]);
    expect(box.hasAttribute('data-resizing')).toBe(false);
  });

  it('reduced-motion：直接到位，不掛 data-resizing、不釘高度', () => {
    vi.stubGlobal(
      'matchMedia',
      (query: string) =>
        ({ matches: query === '(prefers-reduced-motion: reduce)' }) as MediaQueryList,
    );
    const { box, go } = show();
    natural = 240;
    go(2);
    expect(writes).toEqual([]);
    expect(box.hasAttribute('data-resizing')).toBe(false);
  });
});
