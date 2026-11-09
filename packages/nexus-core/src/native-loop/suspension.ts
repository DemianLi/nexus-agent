/**
 * native loop 一次 run 的等人狀態（[#2358](https://github.com/DemianLi/nexus-agent/issues/2358)）：發給每顆工具呼叫的
 * {@link HumanInput}，以及「什麼時候算停在等待點」。
 *
 * **停在等待點**的定義：同一批起跑了的呼叫裡，沒有一顆在自己往前跑（都在 `ask`，或在 `idle` 等），而且至少一顆在 `ask`。
 * 對外的樣子同 LangGraph 的一步：一顆中斷了，要等同一批其餘的都收完或也停下才交出中斷；差在這裡停下的不從頭重跑。判定排在 `setImmediate` 之後再看一次：一顆呼叫收完
 * 到下一顆起跑（或 `idle` 等的那件事兌現）之間隔著幾個 microtask，那一拍數到的 0 不算。
 *
 * **都在 `idle`、沒有一顆在 `ask`** 照理不會發生：`idle` 等的是要人答了才會動的事，沒人在問就永遠不會動。它判成錯誤（建構時給的
 * `onStuck`），不靜靜掛著；當下在 `idle` 等的每一顆以同一個錯拒絕，之後的 `ask`、`idle` 當場以 {@link HumanInputWithdrawn} 拒絕。
 *
 * **收回**（{@link RunSuspension.withdraw}）拒絕每一顆 `ask`。在 `idle` 等的多半跟著前一顆的拒絕落定（例：屏障上等它的那顆一起退出）；
 * 一個 `setImmediate` 之後還在等的，以 {@link HumanInputWithdrawn} 拒絕，收回的 run 不留下等不到的 promise。收回之後的 `ask`、`idle`
 * 當場拒絕。
 *
 * @module
 */

import { randomUUID } from 'node:crypto';

import {
  HumanInputWithdrawn,
  WAIT_CLOCK,
  type HumanInput,
  type WaitClock,
} from '../human-input.js';

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

/** 一顆呼叫手上的併發名額（`agent.ts` 的 `runBounded`）。 */
export interface CallPermit {
  /** 還名額；手上沒有就不做事。 */
  release(): void;
  /** 取回名額，照呼叫的先後排。回 `false` 是這一批不再發名額（有一顆失敗了），照樣往下走。 */
  acquire(): Promise<boolean>;
}

/** 一顆呼叫在 {@link RunSuspension} 裡的位子。 */
export interface CallSlot {
  /** 發給這顆呼叫的服務。 */
  readonly service: HumanInput;
  /** 起跑。 */
  enter(): void;
  /** 收完（不論成敗）。還沒落定的 `ask`、`idle` 以 {@link HumanInputWithdrawn} 拒絕，不再算在掛著的提問裡，之後的也當場拒絕。 */
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
   * @param onStuck - 都在 `idle`、沒有一顆在 `ask` 的那一刻，帶著判成的錯；當下在 `idle` 等的每一顆以它拒絕，之後的 `ask`、`idle`
   *   以 {@link HumanInputWithdrawn} 當場拒絕。
   */
  constructor(
    private readonly onPark: (asks: readonly PendingAsk[]) => void,
    private readonly onStuck: (error: Error) => void,
  ) {}

  /** 收回過了（卡死判成錯誤時也算）。`#toolStep` 看到它就不套這一步的寫入。 */
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
   * @param halt - 這一批的中止訊號（一顆失敗時舉起，含呼叫端中止讓節點被拒絕）。舉起之後這顆還沒落定的 `ask`、`idle` 以它的 `reason` 拒絕，之後的也當場
   *   拒絕：這一批不會再停在等待點，不論那顆呼叫自己理不理這個訊號。
   * @param permit - 這顆呼叫的併發名額。在 `ask`、`idle` 上等的期間還回去，讓排在上限後面的呼叫起跑，同 LangGraph 那顆中斷了就收掉、
   *   讓出名額；等完先照呼叫的先後取回，拿到才把答覆交回本體。收回、收完或這一批中止了就不取，直接交回。
   */
  slot(
    callId: string,
    namespace: readonly string[],
    halt?: AbortSignal,
    permit?: CallPermit,
  ): CallSlot {
    // 這顆呼叫自己還沒落定的 `ask`／`idle`。收完時還會有：呼叫的外層先落定、本體還在等（例：`tool()` 接的中止讓呼叫先拒絕）。
    const asks = new Set<string>();
    const idlers = new Set<(reason: unknown) => void>();
    let exited = false;
    const listeners = new Set<() => void>();
    const resumed = (): void => {
      for (const listener of [...listeners]) listener();
    };
    // 同一顆呼叫問好幾次（例：MCP 一輪一輪反問），前一次答完才沿用第一次的 id，同 LangGraph 一顆 task 裡的每一個 `interrupt()` 都是同一個 id。
    let askId: string | undefined;
    // 等人的時間（含等完排隊取回名額），給 {@link WaitClock}。
    let waits = 0;
    let waitingSince = 0;
    let waitedMs = 0;
    const clockListeners = new Set<(waiting: boolean) => void>();
    const beginWait = (): void => {
      waits += 1;
      if (waits > 1) return;
      waitingSince = Date.now();
      permit?.release();
      for (const listener of [...clockListeners]) listener(true);
    };
    const endWait = (): void => {
      waits -= 1;
      if (waits > 0) return;
      waitedMs += Date.now() - waitingSince;
      for (const listener of [...clockListeners]) listener(false);
    };
    const clock: WaitClock = {
      get waitedMs() {
        return waitedMs + (waits > 0 ? Date.now() - waitingSince : 0);
      },
      onWaiting: (listener) => {
        clockListeners.add(listener);
        return () => clockListeners.delete(listener);
      },
    };
    // 不再收新的等待時拒絕的原因：收回、收完是 `HumanInputWithdrawn`；這一批中止了是中止的原因，同 `tool()` 替呼叫接的中止。
    const refusal = (): unknown =>
      this.#withdrawn || exited
        ? new HumanInputWithdrawn()
        : halt?.aborted === true
          ? halt.reason
          : undefined;
    // 拒絕這顆呼叫還沒落定的每一個等待，每一個把扣掉的那一顆加回來：呼叫拿到拒絕之後是在自己往前跑。
    const cancel = (reason: () => unknown): void => {
      for (const id of [...asks]) {
        const ask = this.#asks.get(id);
        if (ask === undefined) continue;
        this.#asks.delete(id);
        this.#active += 1;
        ask.reject(reason());
      }
      for (const release of [...idlers]) release(reason());
    };
    const onHalt = (): void => {
      cancel(() => halt?.reason);
      this.#maybePark();
    };
    halt?.addEventListener('abort', onHalt, { once: true });
    // 等完：還能往下跑的先排隊取回名額，再交回本體。同一顆還有別的等待沒完的，名額留到最後一個等完才取。
    const reclaim = async (): Promise<void> => {
      if (waits === 1 && permit !== undefined && refusal() === undefined) await permit.acquire();
      endWait();
    };
    const handBack = <T>(waited: Promise<T>): Promise<T> =>
      waited.then(
        async (value) => {
          await reclaim();
          return value;
        },
        async (error: unknown) => {
          await reclaim();
          throw error;
        },
      );
    const service: HumanInput & { readonly [WAIT_CLOCK]: WaitClock } = {
      [WAIT_CLOCK]: clock,
      ask: (value) => {
        const refused = refusal();
        if (refused !== undefined) return Promise.reject(refused);
        const id =
          askId !== undefined && !this.#asks.has(askId) ? askId : randomUUID().replaceAll('-', '');
        askId ??= id;
        const asked = new Promise((resolve, reject) => {
          const settle =
            <A extends unknown[]>(then: (...args: A) => void) =>
            (...args: A): void => {
              asks.delete(id);
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
          this.#active -= 1;
          beginWait();
          this.#maybePark();
        });
        return handBack(asked);
      },
      idle: <T>(waiting: Promise<T>): Promise<T> => {
        const refused = refusal();
        if (refused !== undefined) {
          waiting.catch(() => undefined);
          return Promise.reject(refused);
        }
        const idled = new Promise<T>((resolve, reject) => {
          const drop = (): boolean => {
            if (!this.#idlers.delete(release)) return false;
            idlers.delete(release);
            this.#active += 1;
            return true;
          };
          const release = (reason: unknown): void => {
            if (drop()) reject(reason);
          };
          this.#idlers.add(release);
          idlers.add(release);
          this.#active -= 1;
          beginWait();
          this.#maybePark();
          waiting.then(
            (value) => {
              if (drop()) resolve(value);
            },
            (error: unknown) => release(error),
          );
        });
        return handBack(idled);
      },
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
        halt?.removeEventListener('abort', onHalt);
        cancel(() => new HumanInputWithdrawn());
        this.#active -= 1;
        this.#maybePark();
      },
    };
  }

  /**
   * 驗答覆收不收得下，不動任何狀態。
   * @param answers - 中斷 id → 答覆。
   * @throws {Error} 一顆都沒答，或有一顆 id 不在還沒答的提問裡。
   */
  check(answers: Readonly<Record<string, unknown>>): void {
    const ids = Object.keys(answers);
    if (ids.length === 0) throw new Error('native agent loop 接回時沒有帶任何一顆答覆');
    const unknown = ids.filter((id) => !this.#asks.has(id));
    if (unknown.length > 0) {
      throw new Error(`native agent loop 沒有這顆掛著的中斷：${unknown.join('、')}`);
    }
  }

  /**
   * 送回答覆：每一顆照 id 解開，這次 run 接著跑。沒答到的照舊掛著，同一批又都停住時帶著原 id 再交一次。
   * @param answers - 中斷 id → 答覆。
   * @throws {Error} 同 {@link RunSuspension.check}；拋的時候什麼都還沒動。
   */
  resume(answers: Readonly<Record<string, unknown>>): void {
    this.check(answers);
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

  /**
   * 收回：每一顆還沒答的提問以 {@link HumanInputWithdrawn} 拒絕；一個 `setImmediate` 之後還在 `idle` 等的也以它拒絕；之後的
   * `ask`、`idle` 當場拒絕。
   */
  withdraw(): void {
    this.#withdrawn = true;
    const asks = [...this.#asks.values()];
    this.#asks.clear();
    for (const ask of asks) {
      this.#active += 1;
      ask.reject(new HumanInputWithdrawn());
    }
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
