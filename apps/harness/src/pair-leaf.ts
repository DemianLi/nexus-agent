/**
 * 一對裡的葉子這一側（[#2769](https://github.com/DemianLi/nexus-agent/issues/2769)，一對的設計見 #2583）：`--pair-socket` 給了，
 * 對話行程就連組合行程的橋、登記，並替它做 `attach`；組合行程轉來的 `bind` 到這裡變成 {@link ConversationControl.bind}，
 * 與監督行程在 stdio 上送的 `bind` 是同一條路。沒給 `--pair-socket` 就不呼叫這裡的任何東西。
 *
 * - **登記是空的**：`tools`、`hooks` 都沒有。橋這一側還不替這個行程做事，只負責讓組合行程知道葉子在、並把 `bind` 轉過來。
 * - **`attach` 的 result 在綁完才回**：`handler.open` 結束（成功或失敗都算，同 stdio 的 `bind`）。組合行程收到才送 `bound`。
 *   拒絕（已綁別條 thread、payload 不對）回錯，組合行程不送 `bound`、不重試。
 * - **前台的連線不走橋**：組合行程 listen 前台的 `--socket`、原樣轉到這個行程自己 listen 的 `--socket`；橋斷了前台流量照通。
 *
 * ## 橋斷了
 *
 * 組合行程在葉子斷線時只清登記與綁定、照活，同一個葉子重連不會被收（pid 作廢，要等下一則 `leaf{pid}`，只在起葉子時送）。
 * 留著沒有路能恢復，所以葉子自己結束，結束碼 {@link BRIDGE_LOST_EXIT_CODE}，stderr 一行原因：
 *
 * - 還沒 `attach` 成功（沒綁、或 `handler.open` 還在跑）：**立刻結束**。留著會讓那條 thread 等不到 `up` 也等不到 `down`。
 * - 已綁：先停收會開新一輪的命令（`stopAdmission`，已在跑的一輪與串流照舊），**閒了就結束**；{@link BRIDGE_LOST_GRACE_MS}
 *   到了還不閒就強制結束。這個上限是暫定值，沒量過一輪的長度分布。
 *
 * **已知限制：**橋斷到結束之間，這個葉子在監督行程眼中仍是活的、仍佔名額；`stopAdmission` 之後進來的新一輪被拒，前台回
 * `server_closing`（web 顯示「伺服器正在收尾」），使用者的那個請求失敗，不會被分到別的葉子。分流在監督行程與組合行程那一側（#2858）。
 * 死因在監督行程那邊記成 `crash`，只能靠結束碼與 stderr 跟真的壞掉分開。
 *
 * 連不上橋（{@link PAIR_STARTUP_DEADLINE_MS} 內沒進去）也結束，結束碼 {@link BRIDGE_UNREACHABLE_EXIT_CODE}：沒有橋就沒有 `attach`，
 * 這一對廢了。
 *
 * @module
 */

import {
  PAIR_ATTACH_METHOD,
  PairClient,
  PairConnectError,
  type Json,
  type PairConnectOptions,
  type PairDisconnect,
} from '@nexus/host-bridge';

import type { BindOutcome } from './conversation-control.js';

/** 橋斷了、葉子自己結束的結束碼。 */
export const BRIDGE_LOST_EXIT_CODE = 70;
/** 一開始就連不上橋的結束碼。 */
export const BRIDGE_UNREACHABLE_EXIT_CODE = 71;
/** 橋斷了、已綁的葉子最多等一輪收完多久。暫定值，沒有量測支撐。 */
export const BRIDGE_LOST_GRACE_MS = 120_000;
/** 橋斷後多久看一次閒不閒。 */
export const BRIDGE_LOST_POLL_MS = 500;
/** 從開始連起算，最晚到這時還沒連上橋就放棄。暫定值。 */
export const PAIR_STARTUP_DEADLINE_MS = 20_000;

/** 葉子這一側要控制面提供的幾樣，見 {@link ConversationControl}。 */
export interface PairLeafControl {
  bind(threadId: string): Promise<BindOutcome>;
  /** 綁定走完了（`handler.open` 也結束）。 */
  readonly attached: boolean;
  isIdle(): boolean;
  stopAdmission(): void;
}

export interface PairLeafOptions {
  /** `--pair-socket` 給的路徑；沒給就什麼都不做（{@link startPairLeaf} 不呼叫 `connect`、不碰控制面）。 */
  readonly socketPath: string | undefined;
  readonly control: PairLeafControl;
  /** 結束這個行程；呼叫之後不再回來。測試換成記錄。 */
  readonly exit: (code: number) => void | Promise<void>;
  readonly log: (line: string) => void;
  /** 預設 {@link PairClient.connect}；測試換成假的。 */
  readonly connect?: (options: PairConnectOptions) => Promise<PairLeafClient>;
  readonly startupDeadlineMs?: number;
  readonly graceMs?: number;
  readonly pollMs?: number;
  readonly timers?: {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

/** 連上之後這一側用到的：連線什麼時候斷。 */
export interface PairLeafClient {
  readonly closed: Promise<PairDisconnect>;
}

function threadIdOf(payload: Json): string | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  const { threadId } = payload as { readonly [key: string]: Json };
  return typeof threadId === 'string' && threadId !== '' ? threadId : undefined;
}

/**
 * 連橋、登記、等 `attach`。連上了才回；連不上就以 {@link BRIDGE_UNREACHABLE_EXIT_CODE} 結束。
 * 橋之後斷了的處理見檔頭，在背景跑。
 */
export async function startPairLeaf(options: PairLeafOptions): Promise<void> {
  const { socketPath } = options;
  if (socketPath === undefined) return;
  const {
    control,
    exit,
    log,
    connect = (connectOptions) => PairClient.connect(connectOptions),
    startupDeadlineMs = PAIR_STARTUP_DEADLINE_MS,
    graceMs = BRIDGE_LOST_GRACE_MS,
    pollMs = BRIDGE_LOST_POLL_MS,
    timers = {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    },
  } = options;

  let client: PairLeafClient;
  try {
    client = await connect({
      socketPath,
      startupDeadlineMs,
      register: { tools: [], hooks: [] },
      methods: {
        [PAIR_ATTACH_METHOD]: async (payload) => {
          const threadId = threadIdOf(payload);
          if (threadId === undefined) throw new Error('attach 的 payload 要有字串 threadId');
          const outcome = await control.bind(threadId);
          if (!outcome.ok) throw new Error(outcome.reason);
          return { bound: threadId };
        },
      },
    });
  } catch (error: unknown) {
    const detail =
      error instanceof PairConnectError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    log(`[橋] 連不上組合行程的橋（${socketPath}），這個葉子結束：${detail}`);
    await exit(BRIDGE_UNREACHABLE_EXIT_CODE);
    return;
  }

  void client.closed.then(async (disconnect) => {
    // 自己關的（`local`）不是橋斷。
    if (disconnect.kind === 'local') return;
    const why = `${disconnect.kind}：${disconnect.detail}`;
    if (!control.attached) {
      log(`[橋] 橋斷了（${why}），還沒 attach 成功，立刻結束`);
      await exit(BRIDGE_LOST_EXIT_CODE);
      return;
    }
    control.stopAdmission();
    if (control.isIdle()) {
      log(`[橋] 橋斷了（${why}），已綁但閒著，結束`);
      await exit(BRIDGE_LOST_EXIT_CODE);
      return;
    }
    log(`[橋] 橋斷了（${why}），停收新的一輪，等這一輪收完（最多 ${String(graceMs)} 毫秒）再結束`);
    let waited = 0;
    const tick = (): void => {
      if (control.isIdle()) {
        log('[橋] 這一輪收完了，結束');
        void exit(BRIDGE_LOST_EXIT_CODE);
        return;
      }
      waited += pollMs;
      if (waited >= graceMs) {
        log(`[橋] 等了 ${String(graceMs)} 毫秒這一輪還沒收完，強制結束`);
        void exit(BRIDGE_LOST_EXIT_CODE);
        return;
      }
      timers.setTimeout(tick, pollMs);
    };
    timers.setTimeout(tick, pollMs);
  });
}
