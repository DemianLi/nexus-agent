/*
 * 一條 thread 的命令清單（[#1929](https://github.com/DemianLi/nexus-agent/issues/1929)）：送出時認命令用的那一份。照 dsh 的
 * `CommandDirectory`（`packages/client/ui-commands/src/client/directory.ts`，本機 clone `687f282e`，MIT，Copyright (c) DeepSeek），
 * 只留一條 thread 的那一格——web 一個 hook 只管一條 thread，換 thread 整個重掛，不需要 dsh 那層依 session 分的表。
 *
 * - 四種狀態同 dsh：`cold` 沒抓過、`pending` 在抓而且手上沒有能用的、`ready` 有一份、`failed` 最近一次抓失敗、清單丟掉。
 * - **重連就整份丟掉重抓**（`resetConnected`，dsh `:82-88`）：另一條線上的伺服器可能已經換了組裝。
 * - **抓失敗就清空、標失敗**（`refresh`，dsh `:117-121`），原本是 `ready` 也一樣。只有最新那一次能發布結果（epoch）。
 * - **送出時 strong-wait**（`ensureReady`，dsh `:136-146`）：`ready` 直接用；`cold`／`failed` 重抓一次；`pending` 等在途的那一次；
 *   等到的是失敗才拋——不靜默降級成送給模型（dsh `service.ts:304-305`）。
 */

import type { SlashDescriptor } from '@nexus/wire';

export type CommandDirectoryStatus = 'cold' | 'pending' | 'ready' | 'failed';

/** 抓一次清單；伺服器不給（被拒）也要拋，訊息是講給人聽的原因。 */
export type FetchCommands = () => Promise<readonly SlashDescriptor[]>;

/** 這一次抓的結果：成功、失敗（帶原因），或被後來的那一次蓋掉（`superseded`，結果不發布）。 */
export type RefreshOutcome =
  | { readonly kind: 'ready' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'superseded' };

export class CommandDirectory {
  #state: CommandDirectoryStatus = 'cold';
  #commands: readonly SlashDescriptor[] = [];
  /** 每次開抓就加一；只有最新的那一次能發布結果。 */
  #epoch = 0;
  #lastError: unknown;
  #waiters: (() => void)[] = [];

  /**
   * @param fetchCommands - 抓清單。
   * @param onChange - 能用的那份清單換了（到了、清空）就叫，畫選單與送出鈕用。
   */
  constructor(
    private readonly fetchCommands: FetchCommands,
    private readonly onChange: (commands: readonly SlashDescriptor[]) => void,
  ) {}

  get status(): CommandDirectoryStatus {
    return this.#state;
  }

  /** 重連：丟掉手上的清單，馬上重抓（dsh `resetConnected`）。回這一次抓的結果。 */
  resetConnected(): Promise<RefreshOutcome> {
    this.#state = 'cold';
    this.#commands = [];
    this.onChange(this.#commands);
    return this.refresh();
  }

  /** 抓一次。有一份能用的時候不降級，抓的期間照用；失敗一律清空。 */
  async refresh(): Promise<RefreshOutcome> {
    const epoch = ++this.#epoch;
    if (this.#state !== 'ready') this.#state = 'pending';
    try {
      const commands = await this.fetchCommands();
      if (epoch !== this.#epoch) return { kind: 'superseded' };
      this.#commands = commands;
      this.#state = 'ready';
      this.#lastError = undefined;
      this.onChange(commands);
      return { kind: 'ready' };
    } catch (error) {
      if (epoch !== this.#epoch) return { kind: 'superseded' };
      const hadCommands = this.#commands.length > 0;
      this.#commands = [];
      this.#state = 'failed';
      this.#lastError = error;
      if (hadCommands) this.onChange(this.#commands);
      return { kind: 'failed', message: messageOf(error) };
    } finally {
      if (epoch === this.#epoch) this.#notify();
    }
  }

  /**
   * 等到有一份能用的清單（送出時認命令那一道）。`ready` 馬上回；`cold`／`failed` 重抓一次；`pending` 等在途的那一次；
   * 等到的那一次被後來的蓋掉就再等。等到的是失敗就拋，訊息是失敗的原因。
   */
  async ensureReady(): Promise<readonly SlashDescriptor[]> {
    for (;;) {
      if (this.#state === 'ready') return this.#commands;
      if (this.#state !== 'pending') void this.refresh();
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
      if (this.#state === 'failed') throw new Error(messageOf(this.#lastError));
    }
  }

  #notify(): void {
    const woken = this.#waiters;
    this.#waiters = [];
    for (const wake of woken) wake();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
