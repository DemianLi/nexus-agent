/**
 * 程式碼區塊第一次進到可視範圍才高亮。照 dsh `ui-primitives/src/markdown/useViewportHighlighting.ts`
 * （本機 clone `ddefc45`，MIT）：一份全文件共用的 IntersectionObserver，啟動過的元素永久離開它；
 * 沒有 IntersectionObserver 的環境（jsdom）直接啟動。一長串歷史載進來時，畫面外的程式碼不花 tokenize 的時間。
 */

import { useCallback, useEffect, useState } from 'react';
import type { RefObject } from 'react';

import { supportsHighlighting } from '@/lib/markdown/highlight';

const noop = (): void => {};

class HighlightViewport {
  private observer: IntersectionObserver | undefined;
  private readonly activators = new Map<Element, () => void>();

  observe(element: Element, activate: () => void): () => void {
    if (typeof IntersectionObserver === 'undefined') {
      activate();
      return noop;
    }
    this.observer ??= new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const current = this.activators.get(entry.target);
        if (current === undefined) continue;
        this.activators.delete(entry.target);
        this.observer?.unobserve(entry.target);
        current();
      }
      this.releaseEmptyObserver();
    });
    this.activators.set(element, activate);
    this.observer.observe(element);
    return () => {
      this.activators.delete(element);
      this.observer?.unobserve(element);
      this.releaseEmptyObserver();
    };
  }

  private releaseEmptyObserver(): void {
    if (this.activators.size > 0) return;
    this.observer?.disconnect();
    this.observer = undefined;
  }
}

const highlightViewport = new HighlightViewport();

/** 這一塊可不可以開始高亮：語言認得，而且進過可視範圍（之後一直是 true）。 */
export function useViewportHighlighting(
  target: RefObject<Element | null>,
  lang: string | undefined,
): boolean {
  const supported = supportsHighlighting(lang);
  const [activated, setActivated] = useState(false);
  const activate = useCallback(() => {
    setActivated(true);
  }, []);

  useEffect(() => {
    if (activated || !supported) return;
    const element = target.current;
    if (element === null) return;
    return highlightViewport.observe(element, activate);
  }, [activate, activated, supported, target]);

  return activated && supported;
}
