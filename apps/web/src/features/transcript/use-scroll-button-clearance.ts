import { useEffect } from 'react';
import type { RefObject } from 'react';

/**
 * 「跳到最新」浮鈕讓開對話裡的輸入區（[#1295](https://github.com/DemianLi/nexus-agent/issues/1295)）。
 *
 * **為什麼會蓋住**：浮鈕在 `MessageScroller` 根元素（`relative overflow-hidden`）裡 `absolute bottom-4` 置中，疊在捲動區上；
 * 子代理面板的輸入框與送出鈕在捲動**內容**裡，人往回捲時剛好經過那一帶就被壓住。z 軸怎麼排都一樣：浮鈕本來就要在內容之上。
 * 核准、反問、計劃審核在換手層（`pending-swap`），是根元素外面的兄弟，浮鈕畫不到那裡。
 *
 * **怎麼讓**：捲動、內容或視窗尺寸一變（rAF 合併），拿浮鈕的框跟內容裡標了 {@link SCROLL_BUTTON_AVOID} 的元素比，壓到就在浮鈕上
 * 設 `data-obscuring`（樣式 `data-[obscuring]:invisible`：visibility 不跟淡入淡出那幾條打架，藏起來也不在 Tab 順序裡）。
 * 浮鈕自己有焦點時不藏，焦點不能憑空消失。只看標了的元素，不抓全部的 `form`：新元件要讓就自己標。
 *
 * 不改 vendor 的 `message-scroller.tsx`（#1638 PR B 起是 SG 版），只靠浮鈕的 `data-slot`：合併 `render` 的 Button 之後仍是
 * `message-scroller-button`（`components/ui/message-scroller.test.tsx` 釘）。
 *
 * **浮鈕會位移**（#1687 撤掉 README 本地修改第 41 條、改回 vendor 原樣）：藏著時 `translate-y-full scale-95`，出現與藏起來各有
 * 200／400ms 的過渡。`getBoundingClientRect` 量到的是過渡途中的框，所以除了捲動與尺寸，再聽浮鈕自己的 `transitionend`：
 * 過渡跑完再量一次，量到終點的框。
 *
 * **不另外看 `data-active`**（PM 2026-10-21 判，#1687）：primitive 的 `data-active` 只在捲動、尺寸、內容變動這三種事件的處理裡
 * 同步翻轉，而且比這裡排的 rAF 重量先提交（翻轉在 scroll 事件之前，同一幀），所以 reduced-motion 下沒有過渡、位置直接跳，
 * 捲動那次重量量到的就是終點。這是在 `@shadcn/react` 0.3.1 上實測的；**升 primitive 的版本時要重核**，翻轉若改成在別的時機發生，
 * 這裡就要補一個看 `data-active` 的重量時機（`guard/` 的避讓格 reduced-motion 那一格量得到）。
 * 過渡那一小段裡量到的還是途中的框，可能閃一下；不改用 `offsetTop`：水平置中也是靠 transform，改了等於綁死 vendor 的 class。
 */

/** 浮鈕要讓開的元素：標在對話裡的輸入區上。 */
export const SCROLL_BUTTON_AVOID = 'data-scroll-button-avoid';

/** 浮鈕被壓住時設的屬性。 */
export const SCROLL_BUTTON_OBSCURING = 'data-obscuring';

/** 兩個框之間至少留這麼多才算沒壓到：剛好貼邊的也讓，手指點不準。 */
const CLEARANCE_PX = 4;

interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** 浮鈕的框有沒有壓到任何一個目標（含 {@link CLEARANCE_PX} 的餘裕）。 */
export function obscures(button: Box, targets: readonly Box[]): boolean {
  return targets.some(
    (target) =>
      button.left < target.right + CLEARANCE_PX &&
      target.left < button.right + CLEARANCE_PX &&
      button.top < target.bottom + CLEARANCE_PX &&
      target.top < button.bottom + CLEARANCE_PX,
  );
}

/**
 * 掛在對話區：`viewport` 是 `MessageScrollerViewport`。浮鈕是它在根元素裡的兄弟。
 *
 * ref 掛在 viewport 不掛在根：primitive 的 Root 是 `jsx('div', { ref: 內部的, ...props })`，傳進去的 `ref` 會蓋掉它自己登記根元素
 * 那一個；Viewport 會把外面給的 ref 跟自己的合起來。
 */
export function useScrollButtonClearance(viewportRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const viewport = viewportRef.current;
    const button = viewport?.parentElement?.querySelector<HTMLElement>(
      '[data-slot="message-scroller-button"]',
    );
    if (!viewport || !button) return;
    const content = viewport.querySelector<HTMLElement>('[data-slot="message-scroller-content"]');

    let frame = 0;
    const check = () => {
      frame = 0;
      const targets = [...viewport.querySelectorAll<HTMLElement>(`[${SCROLL_BUTTON_AVOID}]`)].map(
        (target) => target.getBoundingClientRect(),
      );
      const hidden =
        obscures(button.getBoundingClientRect(), targets) && document.activeElement !== button;
      button.toggleAttribute(SCROLL_BUTTON_OBSCURING, hidden);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(check);
    };

    const settled = (event: TransitionEvent) => {
      if (event.target === button) schedule();
    };

    viewport.addEventListener('scroll', schedule, { passive: true });
    button.addEventListener('transitionend', settled);
    // 面板展開、視窗變寬窄時不會捲動，要靠尺寸變化再量一次。jsdom 沒有 ResizeObserver（也沒有版面），那裡只聽捲動。
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
    resize?.observe(viewport);
    if (content) resize?.observe(content);
    schedule();
    return () => {
      viewport.removeEventListener('scroll', schedule);
      button.removeEventListener('transitionend', settled);
      resize?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [viewportRef]);
}
