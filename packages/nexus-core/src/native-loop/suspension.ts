/**
 * native loop 一次 run 的等人狀態（[#2358](https://github.com/DemianLi/nexus-agent/issues/2358)）：發給每顆工具呼叫的
 * {@link HumanInput}，以及「什麼時候算停在等待點」。
 *
 * **停在等待點**照 LangGraph 的 superstep：同一批起跑了的呼叫裡沒有一顆還在自己往前跑（都在 `ask`，或在 `idle` 等），而且至少一顆
 * 在 `ask`。判定排在 `setImmediate` 之後再看一次：一顆呼叫收完到上限放下一顆起跑之間隔著幾個 microtask，那一拍數到的 0 不算。
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
  /** 拿到答覆、交回之前叫：那顆呼叫的 {@link HumanInput.onAnswered}。 */
  readonly answered: () => void;
  readonly reject: (reason: unknown) => void;
}

export class RunSuspension {
  #active = 0;
  readonly #asks = new Map<string, PendingAsk>();
  #scheduled = false;
  #parked = false;
  #withdrawn = false;

  /**
   * @param onPark - 停在等待點的那一刻，帶著所有還沒答的提問（照問的先後）。
   */
  constructor(private readonly onPark: (asks: readonly PendingAsk[]) => void) {}

  /** 收回過了：之後拋出的錯都是收回造成的，寫入一律丟掉。 */
  get withdrawn(): boolean {
    return this.#withdrawn;
  }

  /** 還沒答的提問，照問的先後。 */
  get pending(): readonly PendingAsk[] {
    return [...this.#asks.values()];
  }

  /** 一顆呼叫起跑。 */
  enter(): void {
    this.#active += 1;
  }

  /** 一顆呼叫收完（不論成敗）。 */
  exit(): void {
    this.#active -= 1;
    this.#maybePark();
  }

  /**
   * 發給一顆呼叫的服務。
   * @param callId - 那顆呼叫的 id。
   * @param namespace - 那顆呼叫的命名空間。
   */
  serviceFor(callId: string, namespace: readonly string[]): HumanInput {
    const listeners = new Set<() => void>();
    const answered = (): void => {
      for (const listener of [...listeners]) listener();
    };
    return {
      ask: (value) => {
        if (this.#withdrawn) return Promise.reject(new HumanInputWithdrawn());
        const id = randomUUID().replaceAll('-', '');
        return new Promise((resolve, reject) => {
          this.#asks.set(id, { id, value, callId, namespace, resolve, reject, answered });
          this.#active -= 1;
          this.#maybePark();
        });
      },
      idle: <T>(waiting: Promise<T>): Promise<T> => {
        this.#active -= 1;
        this.#maybePark();
        return waiting.finally(() => {
          this.#active += 1;
        });
      },
      onAnswered: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
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
    for (const [id, answer] of Object.entries(answers)) {
      const ask = this.#asks.get(id)!;
      this.#asks.delete(id);
      this.#active += 1;
      ask.answered();
      ask.resolve(answer);
    }
  }

  /** 收回所有還沒答的提問：每一顆以 {@link HumanInputWithdrawn} 拒絕，之後的提問當場拒絕。 */
  withdraw(): void {
    this.#withdrawn = true;
    const asks = [...this.#asks.values()];
    this.#asks.clear();
    for (const ask of asks) ask.reject(new HumanInputWithdrawn());
  }

  #maybePark(): void {
    if (this.#scheduled || !this.#ready()) return;
    this.#scheduled = true;
    setImmediate(() => {
      this.#scheduled = false;
      if (!this.#ready()) return;
      this.#parked = true;
      this.onPark(this.pending);
    });
  }

  #ready(): boolean {
    return !this.#parked && !this.#withdrawn && this.#active === 0 && this.#asks.size > 0;
  }
}
