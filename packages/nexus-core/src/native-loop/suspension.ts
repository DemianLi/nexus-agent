/**
 * native loop 一次 run 的等人狀態（[#2358](https://github.com/DemianLi/nexus-agent/issues/2358)）：發給每顆工具呼叫的
 * {@link HumanInput}，以及「什麼時候算停在等待點」。
 *
 * **停在等待點**的定義：同一批起跑了的呼叫裡，沒有一顆在自己往前跑（都在 `ask`，或在 `idle` 等），而且至少一顆在 `ask`。
 * 對外的樣子同 LangGraph 的一步：一顆中斷了，要等同一批其餘的都收完或也停下才交出中斷；差在這裡停下的不從頭重跑。判定排在 `setImmediate` 之後再看一次：一顆呼叫收完
 * 到下一顆起跑（或 `idle` 等的那件事兌現）之間隔著幾個 microtask，那一拍數到的 0 不算。
 *
 * **都在 `idle`、沒有一顆在 `ask`** 照理不會發生：`idle` 等的是要人答了才會動的事，沒人在問就永遠不會動。它判成錯誤（建構時給的
 * `onStuck`），不靜靜掛著；在 `idle` 等的每一顆以同一個錯拒絕。
 *
 * **收回**（{@link RunSuspension.withdraw}）拒絕每一顆 `ask`。在 `idle` 等的多半跟著前一顆的拒絕落定（例：屏障上等它的那顆一起退出）；
 * 一個 `setImmediate` 之後還在等的，以 {@link HumanInputWithdrawn} 拒絕，收回的 run 不留下等不到的 promise。
 *
 * @module
 */

import { randomUUID } from 'node:crypto';

import { HumanInputWithdrawn, type HumanInput } from '../human-input.js';

/** 一顆還沒答的提問。 */
export interface PendingAsk {
  /** 中斷 id：32 位十六進位，同 LangGraph 產的形狀。 */
  readonly id: string;
  readonly value: unknown;
  readonly callId: string;
  /** 那顆呼叫的 `tools:<id>` 命名空間。 */
  readonly namespace: readonly string[];
  readonly resolve: (answer: unknown) => void;
  /** 接回時叫：那顆呼叫的 {@link HumanInput.onResumed}。 */
  readonly resumed: () => void;
  readonly reject: (reason: unknown) => void;
}

/** 一顆呼叫在 {@link RunSuspension} 裡的位子。 */
export interface CallSlot {
  /** 發給這顆呼叫的服務。 */
  readonly service: HumanInput;
  /** 起跑。 */
  enter(): void;
  /** 收完（不論成敗）。還沒落定的 `ask`、`idle` 以 {@link HumanInputWithdrawn} 拒絕，不再算在掛著的提問裡。 */
  exit(): void;
}

/**
 * 一次 run 的等人狀態：發服務給每顆呼叫，數有幾顆在自己往前跑，判定停在等待點或卡死。只數已經起跑的呼叫；排在併發上限後面的，
 * 要等接回之後才起跑。
 */
export class RunSuspension {
  #active = 0;
  readonly #asks = new Map<string, PendingAsk>();
  #scheduled = false;
  #parked = false;
  #withdrawn = false;
  readonly #idlers = new Set<(reason: unknown) => void>();

  /**
   * @param onPark - 停在等待點的那一刻，帶著所有還沒答的提問（照問的先後）。
   * @param onStuck - 都在 `idle`、沒有一顆在 `ask` 的那一刻，帶著判成的錯；之後在 `idle` 等的每一顆以它拒絕。
   */
  constructor(
    private readonly onPark: (asks: readonly PendingAsk[]) => void,
    private readonly onStuck: (error: Error) => void,
  ) {}

  /** 收回過了。`#toolStep` 看到它就不套這一步的寫入。 */
  get withdrawn(): boolean {
    return this.#withdrawn;
  }

  /** 還沒答的提問，照問的先後。 */
  get pending(): readonly PendingAsk[] {
    return [...this.#asks.values()];
  }

  /**
   * 一顆呼叫的位子：發給它的服務，加上起跑與收完。
   * @param callId - 那顆呼叫的 id。
   * @param namespace - 那顆呼叫的命名空間。
   */
  slot(callId: string, namespace: readonly string[]): CallSlot {
    // 這顆呼叫自己還沒落定的 `ask`／`idle`：收完時還留著的（外層先把它收掉了，例：兄弟失敗舉起 step 的中止），在這裡清掉。
    const asks = new Set<string>();
    const idlers = new Set<(reason: unknown) => void>();
    /** `idlers` 裡每一顆在收完時怎麼拒絕。 */
    const drops = new Map<(reason: unknown) => void, () => void>();
    let waits = 0;
    let exited = false;
    const listeners = new Set<() => void>();
    const resumed = (): void => {
      for (const listener of [...listeners]) listener();
    };
    const service: HumanInput = {
      ask: (value) => {
        if (this.#withdrawn || exited) return Promise.reject(new HumanInputWithdrawn());
        const id = randomUUID().replaceAll('-', '');
        return new Promise((resolve, reject) => {
          const settle =
            <A extends unknown[]>(then: (...args: A) => void) =>
            (...args: A): void => {
              asks.delete(id);
              waits -= 1;
              then(...args);
            };
          this.#asks.set(id, {
            id,
            value,
            callId,
            namespace,
            resolve: settle(resolve),
            reject: settle(reject),
            resumed,
          });
          asks.add(id);
          waits += 1;
          this.#active -= 1;
          this.#maybePark();
        });
      },
      idle: <T>(waiting: Promise<T>): Promise<T> =>
        new Promise<T>((resolve, reject) => {
          const drop = (): boolean => {
            if (!this.#idlers.delete(release)) return false;
            idlers.delete(release);
            drops.delete(release);
            waits -= 1;
            return true;
          };
          const release = (reason: unknown): void => {
            if (!drop()) return;
            this.#active += 1;
            reject(reason);
          };
          this.#idlers.add(release);
          idlers.add(release);
          waits += 1;
          this.#active -= 1;
          this.#maybePark();
          waiting.then(
            (value) => {
              if (!drop()) return;
              this.#active += 1;
              resolve(value);
            },
            (error: unknown) => release(error),
          );
          drops.set(release, () => {
            if (drop()) reject(new HumanInputWithdrawn());
          });
        }),
      onResumed: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    return {
      service,
      enter: () => {
        this.#active += 1;
      },
      exit: () => {
        exited = true;
        // 起跑算一顆，每一個還沒落定的等待已經扣過一顆：這顆收完要拿掉的是它此刻還佔著的那一份。
        this.#active -= 1 - waits;
        for (const id of [...asks]) {
          const ask = this.#asks.get(id);
          this.#asks.delete(id);
          ask?.reject(new HumanInputWithdrawn());
        }
        for (const release of [...idlers]) drops.get(release)?.();
        this.#maybePark();
      },
    };
  }

  /**
   * 送回答覆：每一顆照 id 解開，這次 run 接著跑。沒答到的照舊掛著，同一批又都停住時帶著原 id 再交一次。
   * @param answers - 中斷 id → 答覆。
   * @throws {Error} 有一顆 id 不在還沒答的提問裡。
   */
  resume(answers: Readonly<Record<string, unknown>>): void {
    const unknown = Object.keys(answers).filter((id) => !this.#asks.has(id));
    if (unknown.length > 0) {
      throw new Error(`native agent loop 沒有這顆掛著的中斷：${unknown.join('、')}`);
    }
    this.#parked = false;
    const failed = new Map<string, unknown>();
    for (const ask of this.#asks.values()) {
      try {
        ask.resumed();
      } catch (error) {
        failed.set(ask.id, error);
      }
    }
    // 接回的 listener 拋了（例：日誌拒收補記）：那顆以那個錯拒絕，由它自己的規則收，不讓它懸著。
    for (const [id, error] of failed) {
      const ask = this.#asks.get(id)!;
      this.#asks.delete(id);
      this.#active += 1;
      ask.reject(error);
    }
    for (const [id, answer] of Object.entries(answers)) {
      const ask = this.#asks.get(id);
      if (ask === undefined) continue;
      this.#asks.delete(id);
      this.#active += 1;
      ask.resolve(answer);
    }
  }

  /** 收回所有還沒答的提問：每一顆以 {@link HumanInputWithdrawn} 拒絕，之後的提問當場拒絕。 */
  withdraw(): void {
    this.#withdrawn = true;
    const asks = [...this.#asks.values()];
    this.#asks.clear();
    for (const ask of asks) ask.reject(new HumanInputWithdrawn());
    setImmediate(() => this.#releaseIdlers(new HumanInputWithdrawn()));
  }

  #releaseIdlers(reason: unknown): void {
    for (const release of [...this.#idlers]) release(reason);
  }

  #maybePark(): void {
    if (this.#scheduled || (!this.#ready() && !this.#stuck())) return;
    this.#scheduled = true;
    setImmediate(() => {
      this.#scheduled = false;
      if (this.#stuck()) {
        const error = new Error(
          'native agent loop：同一批起跑了的呼叫都在 idle 等，沒有一顆在問人，也沒有一顆在跑',
        );
        this.#withdrawn = true;
        this.onStuck(error);
        this.#releaseIdlers(error);
        return;
      }
      if (!this.#ready()) return;
      this.#parked = true;
      this.onPark(this.pending);
    });
  }

  #ready(): boolean {
    return !this.#parked && !this.#withdrawn && this.#active === 0 && this.#asks.size > 0;
  }

  #stuck(): boolean {
    return !this.#withdrawn && this.#active === 0 && this.#asks.size === 0 && this.#idlers.size > 0;
  }
}
