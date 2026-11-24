/**
 * 插件投影 frame 的合併（[#1071](https://github.com/DemianLi/nexus-agent/issues/1071)）。
 *
 * #1026 的通道是整份取代：每顆讓某個單元的 view 改變的事件，pump 就送一顆含整份值的 `projection` frame。輪中事件一顆接一顆
 * 到（一次模型呼叫帶十個工具，就是二十幾顆挨在一起的事件），下行量 ≈ 事件數 × view 大小，而 view 大的時候（軌跡滿載單顆
 * 377 KB）這個乘積是 GB 級。
 *
 * ## 照 dsh 的作法：整份值、一陣一顆
 *
 * dsh 的 job-controller 觀察串流也是整份取代（`streamJobRows`：「一顆開啟時、之後每陣合併過的生命週期提交一顆」），
 * 作法是等一次 `wake` 之後睡一個合併視窗（`observeFlushMs`，預設 100 毫秒），**醒來才讀現況**再送一顆
 * （`packages/api/job-controller/src/rows.ts`、`wake.ts`，`5badb15`）。這裡同形：一個單元的值變了，若這個單元沒有排著的
 * 視窗，就開一個；視窗到了送**那一刻最新的**值；視窗內再變的只換掉待送的那份，不另開。
 *
 * ## 最後一顆一定是最終值
 *
 * 歷史＝即時的承諾靠這一條：待送的值永遠是該單元最新的一份（整份取代，中間值丟掉沒有損失），而**輪結束（root 的
 * `turn/end`）與收線一定先送掉所有待送的**（{@link ProjectionCoalescer.flush}）。視窗只存在於輪中（root 輪外的變更當場送，見
 * {@link ProjectionCoalescer.offer}）；一輪收尾之後下行看到的就是最終值，同沒有合併時一樣。
 *
 * ## 不在這裡
 *
 * - 視窗是固定毫秒數，不看 view 大小：dsh 同（`observeFlushMs` 是部署政策，不隨幀大小變）。view 本身太大是另一條路
 *   （降低軌跡的完整輪數，見 #1069 備註），與這裡正交。
 * - 不合併「別種」frame：訊息、工具、`custom` 的其他名字都不經過這裡。
 *
 * @module
 */

import type { CustomFrameData } from '@nexus/wire';

/** 合併視窗的預設，毫秒。同 dsh `observeFlushMs` 的預設；部署時用 `projection-flush` 那一列（`settings/projection-flush.ts`）改。 */
export const PROJECTION_FLUSH_MS = 100;

/** 計時器的縫，測試換成假的。 */
export interface CoalescerTimers {
  readonly set: (callback: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

const REAL_TIMERS: CoalescerTimers = {
  set: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    // 視窗不該撐住行程：收線時沒送的，是下行已經沒人在聽的那些。
    handle.unref();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class ProjectionCoalescer {
  readonly #send: (data: CustomFrameData) => void;
  readonly #flushMs: number;
  readonly #timers: CoalescerTimers;
  /** 待送的最新值，按單元（含子代理）一格；插入序就是送出序。 */
  readonly #pending = new Map<string, CustomFrameData>();
  /** 排著視窗的單元 → 計時器。沒排著視窗的單元不會有待送的值。 */
  readonly #windows = new Map<string, unknown>();

  /**
   * @param send - 真的送出一顆 `custom` frame。
   * @param flushMs - 合併視窗；`0` ＝ 不合併，每次 {@link ProjectionCoalescer.offer} 當場送。
   * @param timers - 計時器，省略即真的。
   */
  constructor(
    send: (data: CustomFrameData) => void,
    flushMs = PROJECTION_FLUSH_MS,
    timers: CoalescerTimers = REAL_TIMERS,
  ) {
    this.#send = send;
    this.#flushMs = flushMs;
    this.#timers = timers;
  }

  /**
   * 這個單元有新值了。
   *
   * @param slot - 單元的身分：同一個單元的值互相取代，不同單元（含不同子代理的同一個單元）互不相干。
   * @param data - 整份值的 frame 內容。
   * @param coalesce - 這一次要不要合併。`false` ＝ 當場送，並作廢這個單元排著的視窗與待送的舊值（先後不能倒）。輪外的變更
   *   （命令、接上時的 baseline）不是一陣事件裡的一顆，等一個視窗只多一段沒有人要的延遲。
   */
  offer(slot: string, data: CustomFrameData, coalesce = true): void {
    if (this.#flushMs <= 0 || !coalesce) {
      const window = this.#windows.get(slot);
      if (window !== undefined) this.#timers.clear(window);
      this.#windows.delete(slot);
      this.#pending.delete(slot);
      this.#send(data);
      return;
    }
    this.#pending.set(slot, data);
    if (this.#windows.has(slot)) return;
    this.#windows.set(
      slot,
      this.#timers.set(() => {
        this.#windows.delete(slot);
        const latest = this.#pending.get(slot);
        this.#pending.delete(slot);
        if (latest !== undefined) this.#send(latest);
      }, this.#flushMs),
    );
  }

  /** 把所有待送的當場送掉，視窗作廢。輪結束時呼叫：之後下行看到的就是最終值。 */
  flush(): void {
    for (const handle of this.#windows.values()) this.#timers.clear(handle);
    this.#windows.clear();
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const data of pending) this.#send(data);
  }

  /** 收線：作廢視窗、丟掉待送的（這時下行已經沒人在聽）。 */
  dispose(): void {
    for (const handle of this.#windows.values()) this.#timers.clear(handle);
    this.#windows.clear();
    this.#pending.clear();
  }
}
