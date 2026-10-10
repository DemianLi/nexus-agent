/**
 * 換內容時高度用過渡跟上（`.motion-resize`，規格 §7「面板高度差 resize 300」，
 * [#1306](https://github.com/DemianLi/nexus-agent/issues/1306)）。CSS 的 `height: auto` 不能過渡，所以 `key` 一變：
 *
 * 1. 拿換之前量好的高度當起點（正在過渡就拿當下的高度，接著往新目標走，不先跳回去）；
 * 2. 放開高度量出新內容的自然高度當終點；
 * 3. 釘回起點、掛上 `data-resizing`（CSS 這時才裁切、才有 transition），下一格設成終點；
 * 4. `transitionend` 或保險的計時器到了就把高度放開、拿掉 `data-resizing`。
 *
 * 換之前的高度靠 `ResizeObserver` 保持新鮮（沒有就退回每次 render 後量一次）：題目裡的錯誤句、視窗寬度
 * 都會改高度，不一定伴隨這裡的 render。
 *
 * **reduced-motion 整段不做**（§7「尺寸瞬間到位」）：JS 自己讀 media query，不靠 CSS 的 `transition: none`——
 * 那樣 `transitionend` 不會來，高度會被釘到計時器到期。
 */

import { useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';

/** 等 `transitionend` 的上限：`--resize-dur` 300 再寬限一點。 */
export const RESIZE_SETTLE_MS = 400;

function reducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function useResizeTransition(ref: RefObject<HTMLElement | null>, key: unknown): void {
  const last = useRef<number | undefined>(undefined);
  const lastKey = useRef(key);
  const settle = useRef<(() => void) | undefined>(undefined);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || Object.is(lastKey.current, key)) return;
    lastKey.current = key;
    const resizing = element.hasAttribute('data-resizing');
    const from = resizing ? element.getBoundingClientRect().height : last.current;
    settle.current?.();
    if (from === undefined || reducedMotion()) return;
    const to = element.getBoundingClientRect().height;
    if (Math.abs(from - to) < 1) return;

    element.style.height = `${from}px`;
    element.setAttribute('data-resizing', '');
    void element.offsetHeight; // 先讓起點生效，下一句才會過渡
    element.style.height = `${to}px`;

    const done = () => {
      clearTimeout(timer);
      element.removeEventListener('transitionend', onEnd);
      element.style.height = '';
      element.removeAttribute('data-resizing');
      settle.current = undefined;
      last.current = element.offsetHeight;
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.target === element && event.propertyName === 'height') done();
    };
    const timer = setTimeout(done, RESIZE_SETTLE_MS);
    element.addEventListener('transitionend', onEnd);
    settle.current = done;
  }, [ref, key]);

  // 換之前的高度：過渡中不更新（那是動畫中途的值，起點另外量）。**排在上面那段之後**：同一次 commit 裡
  // 先拿舊值當起點，才輪到這裡量。`ResizeObserver` 的回呼在 layout effect 之後才來，所以起點不會先被新內容蓋掉。
  const measure = () => {
    const element = ref.current;
    if (element !== null && !element.hasAttribute('data-resizing')) {
      last.current = element.offsetHeight;
    }
  };
  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') measure();
  });
  // `measure` 每次 render 都是新的，但它只讀 ref，不必跟著重接。
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  useLayoutEffect(() => () => settle.current?.(), []);
}
