/**
 * 註冊表原語：具名表與能力集合。
 *
 * 形狀照 DeepSeek Harness 的 `packages/core/scope/src/store.ts`（`NamedEntries`）：
 * 插入順序、同表同名報錯、每次插入回一個「只撤銷這一筆」的冪等 undo。與 dsh 的
 * 差別在所有權——dsh 靠 Cordis 的 `ctx.effect` 綁定 undo 的生命週期，我們沒有
 * Cordis，undo 由 {@link ./load.ts} 的 per-plugin 堆疊持有，射程限定載入期。
 */

import type { PluginOrigin } from './plugin.js';

/** 表裡的一筆：值本身，加上是誰放進來的。 */
export interface NamedEntry<V> {
  readonly value: V;
  readonly origin: PluginOrigin;
}

/** 重名時由呼叫端決定訊息——它才知道撞的是 tool 還是 subagent。 */
export type DuplicateErrorFactory = (
  name: string,
  existing: PluginOrigin,
  incoming: PluginOrigin,
) => Error;

/**
 * 插入順序的具名表，重名診斷由呼叫端擁有。
 *
 * 值是借用的，不複製。每次成功插入回傳一個冪等的 undo，只移除那一筆——撤銷之後
 * 那個名字是真的空出來，不留墓碑佔名。
 */
export class NamedEntries<V> {
  private readonly data = new Map<string, NamedEntry<V>>();

  constructor(private readonly duplicateError: DuplicateErrorFactory) {}

  /**
   * 插入一個在本表內唯一的名字。
   * @param name - 表內唯一的名字。
   * @param value - 借用的值。
   * @param origin - 註冊者。
   * @returns 只撤銷這一筆的冪等 undo。
   */
  insert(name: string, value: V, origin: PluginOrigin): () => void {
    const existing = this.data.get(name);
    if (existing !== undefined) throw this.duplicateError(name, existing.origin, origin);
    const entry: NamedEntry<V> = { value, origin };
    this.data.set(name, entry);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      // 比對身分而非名字：撤銷只能移除自己那一筆，不能誤刪後來占用同名的別人。
      if (this.data.get(name) === entry) this.data.delete(name);
    };
  }

  /**
   * 讀一個名字。
   * @param name - 要解析的名字。
   * @returns 該筆，或名字不存在時的 `undefined`。
   */
  get(name: string): NamedEntry<V> | undefined {
    return this.data.get(name);
  }

  /**
   * 依插入順序走訪。
   * @returns 名字與該筆的原生迭代器。
   */
  entries(): IterableIterator<[string, NamedEntry<V>]> {
    return this.data.entries();
  }

  /** 表是否為空。 */
  get size(): number {
    return this.data.size;
  }
}

/**
 * 能力集合。刻意不是註冊表：`provide` 冪等、重複提供不報錯，獨佔性由各擴充點
 * 自己的規則守。同時是 [#28] 決議 10 要的「能力 → 提供者」對照表。
 *
 * 用提供者清單而不是 `Set`：兩個 plugin 都 `provide('fs')`、其中一個載入失敗被
 * 回滾時，`fs` 必須還在——`Set` 加 `delete` 會把另一個的宣告一起抹掉。
 */
export class CapabilitySet {
  private readonly data = new Map<string, PluginOrigin[]>();

  /**
   * 宣告一個能力。重複宣告（含同一個 plugin 重複宣告）不報錯。
   * @param name - 能力名。
   * @param origin - 宣告者。
   * @returns 只撤銷這一次宣告的冪等 undo。
   */
  provide(name: string, origin: PluginOrigin): () => void {
    const providers = this.data.get(name) ?? [];
    if (providers.length === 0) this.data.set(name, providers);
    providers.push(origin);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const index = providers.indexOf(origin);
      if (index !== -1) providers.splice(index, 1);
      if (providers.length === 0 && this.data.get(name) === providers) this.data.delete(name);
    };
  }

  /**
   * 這個能力有沒有人提供。
   * @param name - 能力名。
   * @returns 是否至少有一個提供者。
   */
  has(name: string): boolean {
    return this.data.has(name);
  }

  /**
   * 查一個能力的提供者。
   * @param name - 能力名。
   * @returns 依宣告順序的提供者，沒人提供時為空陣列。
   */
  providers(name: string): readonly PluginOrigin[] {
    return this.data.get(name) ?? [];
  }

  /**
   * 目前被提供的所有能力。
   * @returns 依首次宣告順序的能力名。
   */
  names(): string[] {
    return [...this.data.keys()];
  }
}

/**
 * 插入順序的匿名表，每次追加都是獨立的一筆。
 *
 * 形狀照 dsh 的 `AnonymousEntries`：symbol 作 key，所以值相等的兩次追加仍是兩筆
 * 註冊，撤銷靠的是那把 key 而不是值的相等性。給的是沒有名字可撞的擴充點——
 * middleware、deny 規則、interrupt 標記、memory 來源。
 */
export class AnonymousEntries<V> {
  private readonly data = new Map<symbol, NamedEntry<V>>();

  /**
   * 追加一筆。不比對、不去重——匿名表沒有「同名」這回事。
   * @param value - 借用的值。
   * @param origin - 註冊者。
   * @returns 只撤銷這一次追加的冪等 undo。
   */
  append(value: V, origin: PluginOrigin): () => void {
    const key = Symbol();
    this.data.set(key, { value, origin });
    // 冪等不必額外的旗標：key 是這次追加獨有的 symbol，沒有第二個人能佔用它，
    // 所以重複 delete 一定是 no-op。（dsh 的版本有旗標，是因為它的 undo 還會在表
    // 清空時換掉整個 Map；我們沒有那一步。）
    return () => {
      this.data.delete(key);
    };
  }

  /**
   * 依追加順序走訪。
   * @returns 每一筆的值與註冊者。
   */
  entries(): IterableIterator<NamedEntry<V>> {
    return this.data.values();
  }

  /**
   * 取走全部：回傳目前的每一筆，並把表清空。
   *
   * 先複製再清空，所以取走之後這些筆再也不會被第二個呼叫端看到——這是關機清理
   * 「跑一次就好」的來源。已經發出去的 undo 仍然是安全的 no-op（`delete` 一把不存在的
   * key）。
   *
   * @returns 依追加順序的每一筆。
   */
  drain(): NamedEntry<V>[] {
    const taken = [...this.data.values()];
    this.data.clear();
    return taken;
  }

  /** 表裡有幾筆。 */
  get size(): number {
    return this.data.size;
  }
}
