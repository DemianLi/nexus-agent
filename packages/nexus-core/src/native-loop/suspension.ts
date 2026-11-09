/**
 * native loop 一次 run 的等人狀態（[#2358](https://github.com/DemianLi/nexus-agent/issues/2358)）：發給每顆工具呼叫的
 * {@link HumanInput}，以及「什麼時候算停在等待點」。
 *
 * **停在等待點**的定義：同一批起跑了的呼叫裡，沒有一顆在自己往前跑（都在 `ask`，或在 `idle` 等），而且至少一顆在 `ask`。
 * 對外的樣子同 LangGraph 的一步：一顆中斷了，要等同一批其餘的都收完或也停下才交出中斷；差在這裡停下的不從頭重跑。判定排在 `setImmediate` 之後再看一次：一顆呼叫收完
 * 到下一顆起跑（或 `idle` 等的那件事兌現）之間隔著幾個 microtask，那一拍數到的 0 不算。
 *
 * **都在 `idle`、沒有一顆在 `ask`** 照理不會發生：`idle` 等的是要人答了才會動的事，沒人在問就永遠不會動。它判成錯誤（建構時給的
 * `onStuck`），不靜靜掛著：跟收回一樣先套已收完的寫入（{@link RunSuspension.onWithdraw}），再交出錯誤，當下在 `idle` 等的每一顆以
 * {@link HumanInputWithdrawn} 拒絕，之後的 `ask`、`idle` 也當場以它拒絕。用它拒絕，是因為屏障與圍堵把它當控制流往外拋：這一批跟著拒絕、
 * run 照控制流退出，不會把它當成一顆呼叫的錯誤結果收下、接著往下跑。
 *
 * **收回**（{@link RunSuspension.withdraw}）先套已收完的寫入，再拒絕每一顆 `ask`。在 `idle` 等的多半跟著前一顆的拒絕落定（例：屏障上等它的那顆一起退出）；
 * 一個 `setImmediate` 之後還在等的，以 {@link HumanInputWithdrawn} 拒絕，收回的 run 不留下等不到的 promise。收回之後的 `ask`、`idle`
 * 當場拒絕。
 *
 * **委派**（{@link delegationOf}）：工具裡跑的前景子代理在 root 那顆 `task` 呼叫底下開自己的呼叫，提問進同一份掛著的提問。
 * 子代理那一層自己數在跑的：它在叫模型、跑 hook，或它的呼叫有一顆在跑，那顆 `task` 就算在跑；那一層都停下了，`task` 才算停下。
 * 收回或判成卡死時，子代理那一層已收完的寫入不套：那顆 `task` 沒有收完，子代理的 state 不會交回 root，套了也沒有地方看得到。
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
  /** 那顆呼叫的位子是第幾個發的；同一批照呼叫的先後發，接回時照它交答覆。 */
  readonly order: number;
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

/** 一個服務上的委派入口：只有 {@link RunSuspension} 發的服務帶它。 */
const DELEGATE = Symbol('nexus.native-loop.delegate');

/** 一顆 `task` 呼叫底下，前景子代理那一層。沒有 {@link RunSuspension.onWithdraw}：理由見模組 doc 的「委派」。 */
export interface Delegation {
  /** root 那次 run 收回過了，同 {@link RunSuspension.withdrawn}。 */
  readonly withdrawn: boolean;
  /** 子代理的一顆呼叫的位子，參數同 {@link RunSuspension.slot}；命名空間是巢狀的那一份。 */
  slot(
    callId: string,
    namespace: readonly string[],
    halt?: AbortSignal,
    permit?: CallPermit,
  ): CallSlot;
  /** 子代理本身在等 `waiting`（它那一批工具）：等的期間不算它自己在跑，跑不跑看那一批的呼叫。 */
  away<T>(waiting: Promise<T>): Promise<T>;
}

/**
 * 從服務開一層委派：不是 {@link RunSuspension} 發的服務（例如 `NO_HUMAN_INPUT`）回 `undefined`。
 * 每叫一次開新的一層，開的時候算子代理本身在跑；那一層只在歸零與離開零時告訴叫起它的那顆呼叫。同一顆呼叫底下不能有兩層同時在
 * {@link Delegation.away} 裡：兩層都歸零會把那顆呼叫多扣一次。
 * @param service - 工具呼叫拿到的等人服務。
 * @returns 新開的一層；沒有就是 `undefined`。
 */
export function delegationOf(service: unknown): Delegation | undefined {
  if (typeof service !== 'object' || service === null) return undefined;
  const open = (service as { readonly [DELEGATE]?: () => Delegation })[DELEGATE];
  return open?.();
}

/** 一層在跑的有幾顆。歸零與離開零時告訴上一層，上一層只把這一層算成一顆。 */
class Tally {
  #count: number;

  constructor(
    initial: number,
    private readonly onCross?: (delta: 1 | -1) => void,
  ) {
    this.#count = initial;
  }

  get count(): number {
    return this.#count;
  }

  add(delta: number): void {
    const before = this.#count;
    this.#count += delta;
    if (before > 0 && this.#count === 0) this.onCross?.(-1);
    else if (before === 0 && this.#count > 0) this.onCross?.(1);
  }
}

/**
 * 一次 run 的等人狀態：發服務給每顆呼叫，數有幾顆在自己往前跑，判定停在等待點或卡死。只數已經起跑的呼叫；排在併發上限後面的，
 * 要等接回之後才起跑。
 */
export class RunSuspension {
  readonly #root = new Tally(0);
  readonly #asks = new Map<string, PendingAsk>();
  /** 每顆提問算在哪一層。 */
  readonly #tallies = new Map<string, Tally>();
  #slots = 0;
  #scheduled = false;
  #parked = false;
  #withdrawn = false;
  readonly #idlers = new Set<(reason: unknown) => void>();
  readonly #withdrawListeners = new Set<() => void>();

  /**
   * @param onPark - 停在等待點的那一刻，帶著所有還沒答的提問（照問的先後）。
   * @param onStuck - 都在 `idle`、沒有一顆在 `ask` 的那一刻，帶著判成的錯；在 {@link RunSuspension.onWithdraw} 登記的都叫過之後、
   *   拒絕當下在 `idle` 等的之前叫。登記的有拋錯時改帶 `AggregateError`：第一個是判成的錯，後面是拋出的。之後的 `ask`、`idle`
   *   以 {@link HumanInputWithdrawn} 當場拒絕。
   */
  constructor(
    private readonly onPark: (asks: readonly PendingAsk[]) => void,
    private readonly onStuck: (error: Error) => void,
  ) {}

  /** 收回過了（卡死判成錯誤時也算）。 */
  get withdrawn(): boolean {
    return this.#withdrawn;
  }

  /**
   * 收回或判成卡死的那一刻同步叫 `listener`，在拒絕任何一個等待之前：工具步在這裡套已經收完的呼叫寫入。叫過一次就退掉。
   * @param listener - 收回或判成卡死時叫。
   * @returns 取消登記；那一步結束時叫。
   */
  onWithdraw(listener: () => void): () => void {
    this.#withdrawListeners.add(listener);
    return () => this.#withdrawListeners.delete(listener);
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
    return this.#slot(this.#root, callId, namespace, halt, permit);
  }

  #slot(
    tally: Tally,
    callId: string,
    namespace: readonly string[],
    halt?: AbortSignal,
    permit?: CallPermit,
  ): CallSlot {
    const order = this.#slots++;
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
      for (const id of [...asks]) this.#take(id)?.reject(reason());
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
    const service: HumanInput & {
      readonly [WAIT_CLOCK]: WaitClock;
      readonly [DELEGATE]: () => Delegation;
    } = {
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
            order,
            namespace,
            resolve: settle(resolve),
            reject: settle(reject),
            resumed,
          });
          this.#tallies.set(id, tally);
          asks.add(id);
          tally.add(-1);
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
            tally.add(1);
            return true;
          };
          const release = (reason: unknown): void => {
            if (drop()) reject(reason);
          };
          this.#idlers.add(release);
          idlers.add(release);
          tally.add(-1);
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
      [DELEGATE]: () => this.#delegation(tally),
    };
    return {
      service,
      enter: () => {
        tally.add(1);
      },
      exit: () => {
        exited = true;
        halt?.removeEventListener('abort', onHalt);
        cancel(() => new HumanInputWithdrawn());
        tally.add(-1);
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
    for (const [id, error] of failed) this.#take(id)!.reject(error);
    // 照呼叫的先後交，不照 `answers` 的鍵序：交回之後各自取回名額，名額空著時先叫 `acquire` 的當場拿到、排隊的才照索引
    // （`agent.ts` 的 `Permits`），所以交的順序決定誰先接著跑。
    const answered = [...this.#asks.values()]
      .filter((ask) => Object.hasOwn(answers, ask.id))
      .sort((a, b) => a.order - b.order);
    for (const ask of answered) this.#take(ask.id)!.resolve(answers[ask.id]);
  }

  /**
   * 收回：先叫 {@link RunSuspension.onWithdraw} 登記的每一個，再以 {@link HumanInputWithdrawn} 拒絕每一顆還沒答的提問；一個
   * `setImmediate` 之後還在 `idle` 等的也以它拒絕；之後的 `ask`、`idle` 當場拒絕。
   * @throws 登記的拋出的第一個錯，同步拋給呼叫端，這時還沒拒絕任何提問。
   */
  withdraw(): void {
    this.#withdrawn = true;
    const failures = this.#settleWithdrawn();
    if (failures.length > 0) throw failures[0];
    for (const id of [...this.#asks.keys()]) this.#take(id)!.reject(new HumanInputWithdrawn());
    setImmediate(() => this.#releaseIdlers(new HumanInputWithdrawn()));
  }

  /** 拿掉一顆還沒答的提問，它那一層多一顆在跑：拿到答覆或拒絕之後，那顆呼叫是在自己往前跑。 */
  #take(id: string): PendingAsk | undefined {
    const ask = this.#asks.get(id);
    if (ask === undefined) return undefined;
    this.#asks.delete(id);
    this.#tallies.get(id)?.add(1);
    this.#tallies.delete(id);
    return ask;
  }

  /** `parent` 那一層的一顆呼叫底下開一層：開的時候算子代理本身在跑。 */
  #delegation(parent: Tally): Delegation {
    const tally = new Tally(1, (delta) => parent.add(delta));
    const withdrawn = (): boolean => this.#withdrawn;
    return {
      get withdrawn() {
        return withdrawn();
      },
      slot: (callId, namespace, halt, permit) => this.#slot(tally, callId, namespace, halt, permit),
      away: (waiting) => {
        tally.add(-1);
        this.#maybePark();
        return waiting.finally(() => tally.add(1));
      },
    };
  }

  /** 叫每一個登記的，一個拋錯不擋後面的；拋出的照順序回傳。 */
  #settleWithdrawn(): unknown[] {
    const listeners = [...this.#withdrawListeners];
    this.#withdrawListeners.clear();
    const failures: unknown[] = [];
    for (const listener of listeners) {
      try {
        listener();
      } catch (failure) {
        failures.push(failure);
      }
    }
    return failures;
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
        const failures = this.#settleWithdrawn();
        this.onStuck(
          failures.length === 0 ? error : new AggregateError([error, ...failures], error.message),
        );
        this.#releaseIdlers(new HumanInputWithdrawn());
        return;
      }
      if (!this.#ready()) return;
      this.#parked = true;
      this.onPark(this.pending);
    });
  }

  #ready(): boolean {
    return !this.#parked && !this.#withdrawn && this.#root.count === 0 && this.#asks.size > 0;
  }

  #stuck(): boolean {
    return (
      !this.#withdrawn && this.#root.count === 0 && this.#asks.size === 0 && this.#idlers.size > 0
    );
  }
}
