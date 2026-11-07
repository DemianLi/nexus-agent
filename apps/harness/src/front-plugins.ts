/**
 * per-thread 前台的 plugin 對照快照（[#2341](https://github.com/DemianLi/nexus-agent/issues/2341)，設計 `.docs/supervisor-1947-design-2026-11-03.md` §4-3）：
 * thread 在對話行程裡組裝、綁上它掛上的列，`plugin-snapshot.json` 由前台寫，所以前台去問那幾列（`internalThreadPath(id, 'plugins')`）、綁進自己那張表。
 *
 * - **什麼時候問**：監督行程送 `up` 時，與之後每一次轉送拿到回應時，直到問到一份不是空的。組裝在對話行程收到第一個指名這條
 *   thread 的請求時發生（開下行、讀歷史、送指令），所以只看過歷史的 thread 也列得出來，同 `single`。
 * - **綁一次**：同一個行程裡一條 thread 只組裝一次，問到之後不再問；行程換了（`up` 換 socket）重問。
 * - `down`：放掉，快照不再列它。
 *
 * @module
 */

import type { FrontForwarder } from './front-forward.js';
import type { LiveRowBinding } from './plugin-live-versions.js';
import { internalThreadPath } from './wire-handler.js';

/** 綁進前台那張表；回放掉。見 `ThreadPluginReader.bindElsewhere`。 */
export type BindElsewhere = (
  threadId: string,
  bindings: readonly LiveRowBinding[],
) => Promise<() => Promise<void>>;

export interface FrontPluginBindingsOptions {
  readonly forwarder: FrontForwarder;
  readonly warn?: (message: string) => void;
}

interface Tracked {
  readonly socket: string;
  /** 正在問；問完清掉。 */
  asking?: Promise<void>;
  release?: () => Promise<void>;
  gone: boolean;
}

function isBinding(value: unknown): value is LiveRowBinding {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { signature?: unknown }).signature === 'string'
  );
}

export class FrontPluginBindings {
  readonly #forwarder: FrontForwarder;
  readonly #warn: (message: string) => void;
  readonly #threads = new Map<string, Tracked>();
  #bind: BindElsewhere | undefined;
  #closed = false;

  constructor(options: FrontPluginBindingsOptions) {
    this.#forwarder = options.forwarder;
    this.#warn = options.warn ?? (() => {});
  }

  /** 接上綁定的那一支（serve 建好表之後）；沒接之前的 `up` 等接上再問。 */
  bindWith(bind: BindElsewhere): void {
    this.#bind = bind;
    for (const threadId of this.#threads.keys()) this.touched(threadId);
  }

  /** 監督行程說這條 thread 在 `socket` 上。同一個 socket 不重來；換了就放掉舊的再問。 */
  up(threadId: string, socket: string): void {
    if (this.#closed) return;
    const current = this.#threads.get(threadId);
    if (current?.socket === socket) return;
    if (current !== undefined) this.down(threadId);
    this.#threads.set(threadId, { socket, gone: false });
    this.touched(threadId);
  }

  /** 轉送給這條 thread 的請求拿到回應了：還沒綁就問一次。 */
  touched(threadId: string): void {
    const tracked = this.#threads.get(threadId);
    if (
      tracked === undefined ||
      this.#bind === undefined ||
      tracked.release !== undefined ||
      tracked.asking !== undefined
    ) {
      return;
    }
    tracked.asking = this.#ask(threadId, tracked, this.#bind).finally(() => {
      tracked.asking = undefined;
    });
  }

  /** 這條的行程走了。 */
  down(threadId: string): void {
    const tracked = this.#threads.get(threadId);
    if (tracked === undefined) return;
    this.#threads.delete(threadId);
    tracked.gone = true;
    void tracked.release?.();
  }

  close(): void {
    this.#closed = true;
    for (const tracked of this.#threads.values()) tracked.gone = true;
    this.#threads.clear();
  }

  async #ask(threadId: string, tracked: Tracked, bind: BindElsewhere): Promise<void> {
    let bindings: readonly LiveRowBinding[];
    try {
      const response = await this.#forwarder.forward(
        new Request(`http://localhost${internalThreadPath(threadId, 'plugins')}`),
        tracked.socket,
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`對話行程回 ${String(response.status)}`);
      }
      const body = (await response.json()) as { bindings?: unknown };
      bindings = Array.isArray(body.bindings) ? body.bindings.filter(isBinding) : [];
    } catch (error) {
      if (!tracked.gone) {
        this.#warn(
          `[對照快照] 問 thread "${threadId}" 綁著哪幾列失敗，下一次轉送再問：${String(error)}`,
        );
      }
      return;
    }
    // 還沒組裝（這次轉送的路由不建 thread）：下一次轉送再問。
    if (bindings.length === 0 || tracked.gone) return;
    const release = await bind(threadId, bindings);
    if (tracked.gone) await release();
    else tracked.release = release;
  }
}
