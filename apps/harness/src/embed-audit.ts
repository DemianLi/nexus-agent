/**
 * 嵌入換票的稽核紀錄（[#2370](https://github.com/DemianLi/nexus-agent/issues/2370)）：`<home>/embed-audit.jsonl`，一行一筆，只增不改。
 *
 * - **寫法**：整行 append、`datasync` 之後才算寫好；一次只寫一行（排隊）。只有前台行程寫，同一個 home 只有一台 serve（home 鎖；拿不到 flock 的平台例外，
 *   見 `home-lock.ts`），所以不另拿跨行程鎖。檔 `0600`；已存在的檔權限過寬就拒絕啟動。
 * - **寫不進去**：換票或兌換失敗（呼叫端照 500 回），不發一張沒有紀錄的票、不設一顆沒有紀錄的 cookie。
 * - **不記秘密**：服務憑證、登入票、cookie 都不記；對方的登入 session id 只記 sha256。
 * - **認不出是誰的請求合併**：換票時沒過服務憑證（`event: 'exchange'`），與兌換時票不存在、用過或本文不對（`event: 'redeem'`），都不知道是誰打的，
 *   又最容易被人大量打。每一類各自的時間窗（{@link UNAUTHENTICATED_WINDOW_MS}）裡第一次照記一行（`count: 1`），之後只計數；
 *   時間窗過了之後同一類再有一次、或 serve 收尾時，把計到的寫成一行（`count`、`from`、`to`）。所以每一類每個時間窗最多兩行。
 *   合併中的計數只在這兩個時機落盤：行程被強制結束（沒走收尾）時這段計數遺失。
 * - **一筆一行的**：過了服務憑證的換票（發票、身分被拒、本文不對、票滿了）與票查得到的兌換（兌換成功、票過期、身分被拒）：
 *   打的人是設定裡指名的嵌入方，或拿著它發的票。
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

import { assertOwnerOnlyMode, PRIVATE_FILE_MODE } from './owner-only.js';

/** 檔名，放在 harness home 底下。 */
// session-file-exempt: 換票稽核紀錄，不是會話日誌
export const EMBED_AUDIT_FILE = 'embed-audit.jsonl';

/** 憑證錯的請求合併成一行的時間窗。 */
export const UNAUTHENTICATED_WINDOW_MS = 60_000;

const LABEL = '嵌入換票稽核紀錄';

/** 過了服務憑證之後的結果。 */
export type ExchangeOutcome = 'issued' | 'identity_rejected' | 'bad_request' | 'capacity';

/** 一筆過了服務憑證的換票。 */
export interface ExchangeRecord {
  readonly outcome: ExchangeOutcome;
  readonly embedder: string;
  /** 對方帳號；本文不對時可能沒有。 */
  readonly subject?: string;
  /** 對應到的 nexus 身分；`issued` 與 `capacity` 有。 */
  readonly userId?: string;
  /** 對方登入 session id 的 sha256（hex）；本文不對時沒有。 */
  readonly sessionIdSha256?: string;
  /** 被拒的原因（`identity_rejected`、`bad_request`）。 */
  readonly reason?: string;
}

/** 對方登入 session id 的 sha256（hex），記進稽核與登入票（`EmbedGrant.sessionIdSha256`）。 */
export function sessionIdDigest(sessionId: string): string {
  return createHash('sha256').update(sessionId, 'utf8').digest('hex');
}

/** 兌換的結果（`embed-session.ts`）。 */
export type RedeemOutcome = 'redeemed' | 'ticket_expired' | 'identity_rejected';

/** 一筆票查得到的兌換。 */
export interface RedeemRecord {
  readonly outcome: RedeemOutcome;
  readonly embedder: string;
  readonly subject: string;
  /** 票上的 nexus 身分。 */
  readonly userId: string;
  readonly sessionIdSha256: string;
  /** 被拒的原因（`identity_rejected`）。 */
  readonly reason?: string;
  /** 換到的 cookie 到期時間（ISO）；只有 `redeemed` 有。 */
  readonly cookieExpiresAt?: string;
}

/** 合併記的那一類屬於哪一步：換票時沒過服務憑證，或兌換時票不存在、用過、本文不對。 */
export type UnattributedEvent = 'exchange' | 'redeem';

/** 稽核紀錄的寫入端。 */
export interface EmbedAudit {
  /** 記一筆過了服務憑證的換票。寫好（`datasync` 完）才 resolve；寫不進去就 reject。 */
  recordExchange(record: ExchangeRecord): Promise<void>;
  /** 記一筆兌換。寫好（`datasync` 完）才 resolve；寫不進去就 reject。 */
  recordRedeem(record: RedeemRecord): Promise<void>;
  /**
   * 記一次認不出是誰的請求（合併，見檔頭）：`exchange` 是沒過服務憑證，`redeem` 是拿不存在或用過的票、或本文不對來兌換。
   * 兩類各自一個時間窗；`event` 不帶是 `exchange`。不 reject：寫失敗交給 `onError`。
   */
  recordUnauthenticated(event?: UnattributedEvent): void;
  /** 把還沒寫的合併計數寫掉、關檔。關了之後 `recordExchange`、`recordRedeem` 一律 reject，`recordUnauthenticated` 不動作。 */
  close(): Promise<void>;
}

/** {@link openEmbedAudit} 的選項。 */
export interface EmbedAuditOptions {
  /** 現在幾點；測試換掉。 */
  readonly now?: () => number;
  /** 合併那一類寫失敗時的去處（伺服器日誌）。 */
  readonly onError?: (error: unknown) => void;
}

async function assertExistingIsPrivate(file: string): Promise<void> {
  try {
    assertOwnerOnlyMode(LABEL, file, (await stat(file)).mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return;
    throw error;
  }
}

/**
 * 打開稽核紀錄，沒有就建（`0600`）。
 *
 * @param file - 絕對路徑。
 * @throws 已存在的檔權限過寬，或打不開。
 */
export async function openEmbedAudit(
  file: string,
  options: EmbedAuditOptions = {},
): Promise<EmbedAudit> {
  await assertExistingIsPrivate(file);
  const handle: FileHandle = await open(file, 'a', PRIVATE_FILE_MODE);
  const now = options.now ?? Date.now;
  const onError = options.onError ?? (() => undefined);
  let queue: Promise<void> = Promise.resolve();
  let closed = false;
  /** 每一類目前時間窗的起點與窗內第一行之後計到的次數。 */
  const windows = new Map<
    UnattributedEvent,
    { readonly start: number; pending: number; last: number }
  >();

  function append(entry: Record<string, unknown>): Promise<void> {
    const line = `${JSON.stringify({ v: 1, at: new Date(now()).toISOString(), ...entry })}\n`;
    const write = queue.then(async () => {
      await handle.write(line);
      await handle.datasync();
    });
    // 一筆失敗不擋後面的：每一筆各自回報自己的結果。
    queue = write.catch(() => undefined);
    return write;
  }

  function flushWindow(event: UnattributedEvent): Promise<void> | undefined {
    const window = windows.get(event);
    if (window === undefined || window.pending === 0) return undefined;
    const { start, pending, last } = window;
    window.pending = 0;
    return append({
      event,
      outcome: 'unauthenticated',
      count: pending,
      from: new Date(start).toISOString(),
      to: new Date(last).toISOString(),
    });
  }

  return {
    recordExchange(record) {
      if (closed) return Promise.reject(new Error(`${LABEL}已關閉`));
      return append({ event: 'exchange', ...record });
    },
    recordRedeem(record) {
      if (closed) return Promise.reject(new Error(`${LABEL}已關閉`));
      return append({ event: 'redeem', ...record });
    },
    recordUnauthenticated(event = 'exchange') {
      if (closed) return;
      const at = now();
      const window = windows.get(event);
      if (window !== undefined && at - window.start < UNAUTHENTICATED_WINDOW_MS) {
        window.pending += 1;
        window.last = at;
        return;
      }
      flushWindow(event)?.catch(onError);
      windows.set(event, { start: at, pending: 0, last: at });
      append({ event, outcome: 'unauthenticated', count: 1 }).catch(onError);
    },
    async close() {
      if (closed) return;
      closed = true;
      await flushWindow('exchange')?.catch(onError);
      await flushWindow('redeem')?.catch(onError);
      await queue;
      await handle.close();
    },
  };
}
