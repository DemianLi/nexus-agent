/**
 * 串流的逐字片段按動畫幀合併發布（[#527](https://github.com/DemianLi/nexus-agent/issues/527) Q8）。
 *
 * 推理是串流的大半（#527 量過一輪 86% 的 chunk），每一顆都 `setState` 的話，每一顆都重畫整份 transcript。
 * 照 dsh 的 `BoundConversation.publish`（`packages/client/ui-conversation/src/client/conversation/assembly.ts`，
 * `a60af51`）：
 *
 * - **每一顆事件照樣當場折進最新的狀態**，只有「交給 React」這一步延後。折疊不抽樣、不丟。
 * - **串流的逐字片段**（`content-block-*`）等跨過三次 paint 才發布一次；同一段時間裡再來的片段不另排。
 * - **其餘事件當場發布**，並取消還在排的那一幀：結構變化（新的一則、工具、收尾、待決）不能晚到。
 * - 折完狀態沒變的（例如工具參數的 `block-delta`，折疊器不收）不發布，同 dsh 的 `none`。
 * - 沒有 `requestAnimationFrame` 的環境當場發布，同 dsh。
 *
 * @module
 */

import type { Event } from '@nexus/wire';

/** 這顆事件的變化什麼時候交給 React。 */
export type Publication = 'animation-frame' | 'immediate';

/** 串流的逐字片段走動畫幀，其餘當場。 */
export function publicationOf(event: Event): Publication {
  if (event.method !== 'messages') return 'immediate';
  const data = event.params.data as { readonly event?: unknown };
  return typeof data.event === 'string' && data.event.startsWith('content-block-')
    ? 'animation-frame'
    : 'immediate';
}

/** 跨幾次 paint 才發布一次串流片段，同 dsh（「Cross three paint opportunities」）。 */
export const FRAMES_PER_PUBLICATION = 3;

interface FrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

function browserFrames(): FrameScheduler | null {
  if (typeof requestAnimationFrame !== 'function') return null;
  return {
    request: (callback) => requestAnimationFrame(callback),
    cancel: (handle) => cancelAnimationFrame(handle),
  };
}

/**
 * 持有最新折好的狀態，決定什麼時候交給 React。**所有改狀態的地方都要經過它**：它手上的那份永遠是最新的，
 * React 的那份可能落後一到三幀。要讀「當下」的狀態（例如送出時找 pending）讀 {@link current}。
 */
export class FramePublisher<S> {
  #current: S;
  #frame: number | undefined;
  readonly #publish: (state: S) => void;
  readonly #frames: FrameScheduler | null;

  /** @param frames - 沒有幀可排時給 `null`（當場發布）。預設用瀏覽器的 `requestAnimationFrame`。 */
  constructor(
    initial: S,
    publish: (state: S) => void,
    frames: FrameScheduler | null = browserFrames(),
  ) {
    this.#current = initial;
    this.#publish = publish;
    this.#frames = frames;
  }

  /** 最新折好的狀態，可能還沒交給 React。 */
  get current(): S {
    return this.#current;
  }

  apply(step: (previous: S) => S, publication: Publication = 'immediate'): void {
    const next = step(this.#current);
    if (next === this.#current) return;
    this.#current = next;
    if (publication === 'animation-frame' && this.#frames !== null) {
      if (this.#frame === undefined) this.#schedule(FRAMES_PER_PUBLICATION);
      return;
    }
    this.cancel();
    this.#publish(this.#current);
  }

  /**
   * 取消還在排的那一幀。**不停用它**：StrictMode 會先卸載再掛回來，同一個實例接著用。還沒交出去的變化
   * 留在 {@link current}，下一次發布一起交。
   */
  cancel(): void {
    if (this.#frame !== undefined) this.#frames?.cancel(this.#frame);
    this.#frame = undefined;
  }

  #schedule(remaining: number): void {
    this.#frame = this.#frames!.request(() => {
      if (remaining > 1) {
        this.#schedule(remaining - 1);
        return;
      }
      this.#frame = undefined;
      this.#publish(this.#current);
    });
  }
}
