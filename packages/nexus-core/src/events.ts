/**
 * 事件匯流排本體（[#1217](https://github.com/DemianLi/nexus-agent/issues/1217)，事件契約草稿的 S0）。
 *
 * 照 dsh 的 `vendor/cordis/src/events.ts`（`5badb15009a`）：同一個匯流排、三種派發。這個檔案是**純 TypeScript**，
 * 不 import LangChain 家族任何東西——它存在的理由就是讓攔截點不再長在 LangChain 的 middleware 鉤子上
 * （`kernel-boundary.test.ts` 守著這個檔案的相依）。
 *
 * ## 三種派發，照 dsh 逐條
 *
 * - **`emit`**：同步呼叫每位監聽者，不等它們回傳的 promise；回傳值丟掉。同步拋錯會中斷後面的監聽者並往外拋。
 * - **`serial`**：依序 `await`，遇到「bail 值」（不是 `null`、`false`、`undefined`）就停並回傳它。
 * - **`waterfall`**：派發的**最後一個參數是最內層的 `next`**（內建行為）；監聽者由外而內執行，每位拿到的 `next()`
 *   會呼叫下一位，最後才是最內層。**沒呼叫 `next()` 就是否決**——連內建行為一起略過。這個語意與 `approvals`
 *   註冊點（`approval.ts` 的 pre-execute 鏈）同形。
 *
 * 其餘兩種（`bail`、`parallel`）與 `internal/*` 框架事件**不做**：dsh 的 81 個宣告事件裡 `bail` 只有框架內部用，
 * `parallel` 只有三個事件用而我們沒有對應的消費者（草稿 §4-1）。有需求再加。
 *
 * **派發當下取監聽者的快照**：派發途中新掛上的監聽者不參與這一次；途中撤銷的仍在這一次的名單上（同 dsh，
 * `dispatch` 先 `.map` 出一份陣列）。
 *
 * ## 撤銷只撤自己那一筆（同 dsh，不是偏離）
 *
 * dsh 的 `unregister` 是依 callback 找第一筆拿掉，乍看會在「同一個函式被兩位註冊者各掛一次」時誤傷別人。但 dsh 的 `on()` 在登記
 * 之前先做 `listener = this.ctx.reflect.bind(listener)`（`vendor/cordis/src/reflect.ts` 的 `bind` 每次都回一個新的 `Proxy`），所以
 * 每一次註冊存進表裡的 callback 本來就各不相同，「依 callback 撤」實際上就是「依身分撤」。我們的註冊表也有同一條約定：
 * **撤銷只撤自己那一次註冊，冪等**（`entries.ts`，載入器的回滾靠它，#677）。這裡每一筆註冊是一個獨立的紀錄，以身分撤銷，結果相同。
 *
 * ## 不做的事
 *
 * - **沒有 `Scoped<Agent>` 過濾**。dsh 靠它讓註冊在某個 agent 底下的監聽者只收到那個 agent 的事件；我們是一個 thread 一個
 *   registry、一個 agent，thread 之間天然隔離。子代理的事件怎麼帶身分（草稿 D4）留給有生產者的 S1。
 * - **`waterfall` 的 `next()` 只能呼叫一次**，同 dsh：`next` 是共用的一支，呼叫兩次會再往下推進一位。這是 dsh 的行為，
 *   S0 照抄；需要「重試」語意的事件（草稿的 `agent/request-error`）在宣告時回 `{ kind: 'retry' }` 而不是重呼叫 `next()`。
 *
 * ## 事件表
 *
 * 事件表是下面的 {@link Events} interface，**S0 是空的**：沒有生產者的事件宣告出來就是沒人送的死事件，所以 S1 以後每個
 * 事件跟它的第一個生產者同一張 PR 落地。插件靠 TypeScript 的 declaration merging 擴充它——`declare module '@nexus/core'
 * { interface Events { 'my/event'(…): void } }`。**每個成員必須有 JSDoc，並標 `@mode emit | serial | waterfall`**，
 * 由 `event-table.test.ts` 掃整棵樹檢查（照 dsh 的規矩）。
 *
 * @module
 */

import type { PluginOrigin } from './plugin.js';

/**
 * 事件表。成員的形狀是監聽者的簽名：`'name'(arg: A, next: () => R): R`。
 *
 * 空的，由各 plugin 與核心用 declaration merging 擴充；見檔頭。**每個成員要有 JSDoc 與 `@mode`**。
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 空表是設計：靠 declaration merging 長出來。
export interface Events {}

/** 事件名。 */
export type EventName = keyof Events & string;

/** 派發方式。 */
export type DispatchMode = 'emit' | 'serial' | 'waterfall';

/** 掛監聽者的選項。 */
export interface EventOptions {
  /** 排在同一個事件現有監聽者的**前面**（預設接在後面）。 */
  readonly prepend?: boolean;
}

/** 一位掛著的監聽者，給診斷看。 */
export interface EventListenerInfo {
  /** 事件名。 */
  readonly name: string;
  /** 誰掛的。 */
  readonly origin: PluginOrigin | undefined;
  /** 掛的時候有沒有 `prepend`。 */
  readonly prepend: boolean;
}

/**
 * 監聽者的回傳值是不是 bail 值：不是 `null`、`false`、`undefined`。照 dsh 的 `isBailed`。
 *
 * @param value - 監聽者的回傳值。
 * @returns `true` 表示 `serial` 要在這裡停。
 */
export function isBailed(value: unknown): boolean {
  return value !== null && value !== false && value !== undefined;
}

type Args<K extends EventName> = Events[K] extends (...args: infer P) => unknown ? P : never;
type Result<K extends EventName> = Events[K] extends (...args: never[]) => infer R ? R : never;

/** `serial` 的回傳：監聽者可以是同步或非同步，結果一律包成 promise。 */
type Awaitable<R> = Promise<Awaited<R> | undefined>;

interface Hook {
  readonly callback: (...args: never[]) => unknown;
  readonly origin: PluginOrigin | undefined;
  readonly prepend: boolean;
}

/**
 * 宿主持有的派發面。**插件拿不到它**——插件只拿得到 {@link EventBus.on} 那一側（`registry.events`）。
 */
export interface EventDispatcher {
  /**
   * 同步派發，不等監聽者回傳的 promise。
   * @param name - 事件名。
   * @param args - 給每位監聽者的參數。
   */
  emit<K extends EventName>(name: K, ...args: Args<K>): void;
  /**
   * 依序派發，遇到 bail 值就停。
   * @param name - 事件名。
   * @param args - 給每位監聽者的參數。
   * @returns 第一個 bail 值，沒有就是 `undefined`。
   */
  serial<K extends EventName>(name: K, ...args: Args<K>): Awaitable<Result<K>>;
  /**
   * waterfall 派發：**最後一個參數是最內層的 `next`**。
   * @param name - 事件名。
   * @param args - 給每位監聽者的參數，最後一個是最內層的 `next`。
   * @returns 最外層監聽者的回傳值。
   */
  waterfall<K extends EventName>(name: K, ...args: Args<K>): Result<K>;
  /**
   * 某個事件現在掛著幾位監聽者。
   * @param name - 事件名。
   * @returns 數量。
   */
  count(name: string): number;
  /**
   * 掛著的每一位監聽者，依派發順序（先 `name` 的字典序，同事件內依執行順序）。
   * @returns 給診斷看的清單。
   */
  listeners(): readonly EventListenerInfo[];
  /**
   * 撤掉所有監聽者。關機用——撤銷歸各註冊者的堆疊，這一下只是把表清空，之後的撤銷都是 no-op。
   */
  clear(): void;
}

/** 掛監聽者的那一側。`registry.events` 在這之上加上 origin 與回滾。 */
export interface EventSubscriber {
  /**
   * 掛一位監聽者。
   * @param name - 事件名。
   * @param listener - 監聽者；簽名由事件表決定。
   * @param options - `prepend`。
   * @param origin - 誰掛的（診斷用）。
   * @returns 只撤這一筆的冪等函式，回傳撤到了沒有。
   */
  on<K extends EventName>(
    name: K,
    listener: Events[K],
    options?: EventOptions,
    origin?: PluginOrigin,
  ): () => boolean;
}

/**
 * 事件匯流排：掛監聽者（{@link EventSubscriber}）與派發（{@link EventDispatcher}）兩側的實作。
 */
export class EventBus implements EventSubscriber, EventDispatcher {
  readonly #hooks = new Map<string, Hook[]>();

  on<K extends EventName>(
    name: K,
    listener: Events[K],
    options: EventOptions = {},
    origin?: PluginOrigin,
  ): () => boolean {
    const hook: Hook = {
      callback: listener as unknown as Hook['callback'],
      origin,
      prepend: options.prepend === true,
    };
    const hooks = this.#hooks.get(name) ?? [];
    this.#hooks.set(name, hooks);
    if (hook.prepend) hooks.unshift(hook);
    else hooks.push(hook);
    return () => {
      // 以這一筆紀錄的身分撤，不是以 callback：見檔頭（dsh 靠 reflect.bind 讓每筆各有一支，結果相同）。
      const at = hooks.indexOf(hook);
      if (at < 0) return false;
      hooks.splice(at, 1);
      return true;
    };
  }

  /**
   * 掛一位只響一次的監聽者：第一次被呼叫時先撤掉自己。
   * @param name - 事件名。
   * @param listener - 監聽者。
   * @param options - `prepend`。
   * @param origin - 誰掛的。
   * @returns 只撤這一筆的冪等函式。
   */
  once<K extends EventName>(
    name: K,
    listener: Events[K],
    options?: EventOptions,
    origin?: PluginOrigin,
  ): () => boolean {
    const wrapper = ((...args: never[]) => {
      undo();
      return (listener as unknown as (...rest: never[]) => unknown)(...args);
    }) as unknown as Events[K];
    const undo = this.on(name, wrapper, options, origin);
    return undo;
  }

  #snapshot(name: string): ((...args: never[]) => unknown)[] {
    return (this.#hooks.get(name) ?? []).map((hook) => hook.callback);
  }

  emit<K extends EventName>(name: K, ...args: Args<K>): void {
    for (const callback of this.#snapshot(name)) callback(...(args as unknown as never[]));
  }

  async serial<K extends EventName>(name: K, ...args: Args<K>): Awaitable<Result<K>> {
    for (const callback of this.#snapshot(name)) {
      const result = await callback(...(args as unknown as never[]));
      if (isBailed(result)) return result as Awaited<Result<K>>;
    }
    return undefined;
  }

  waterfall<K extends EventName>(name: K, ...args: Args<K>): Result<K> {
    const callbacks = this.#snapshot(name);
    const rest = [...(args as unknown[])];
    const inner = rest.pop() as (...inner: never[]) => unknown;
    const next = (): unknown => {
      const callback = callbacks.shift() ?? inner;
      return callback(...(rest as never[]));
    };
    rest.push(next);
    return next() as Result<K>;
  }

  count(name: string): number {
    return this.#hooks.get(name)?.length ?? 0;
  }

  listeners(): readonly EventListenerInfo[] {
    return [...this.#hooks.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .flatMap(([name, hooks]) =>
        hooks.map((hook) => ({ name, origin: hook.origin, prepend: hook.prepend })),
      );
  }

  clear(): void {
    // 先把每個陣列清空再丟掉表：已發出去的撤銷函式握著的是那個陣列，只清表的話它們還找得到自己、回傳「撤到了」。
    for (const hooks of this.#hooks.values()) hooks.length = 0;
    this.#hooks.clear();
  }
}
