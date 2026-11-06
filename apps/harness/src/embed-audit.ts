/**
 * 嵌入換票的稽核紀錄（[#2370](https://github.com/DemianLi/nexus-agent/issues/2370)）：`<home>/embed-audit.jsonl`，一行一筆，只增不改。
 *
 * - **寫法**：整行 append、`datasync` 之後才算寫好；一次只寫一行（排隊）。只有前台行程寫，同一個 home 只有一台 serve（home 鎖；拿不到 flock 的平台例外，
 *   見 `home-lock.ts`），所以不另拿跨行程鎖。檔 `0600`；已存在的檔權限過寬就拒絕啟動。
 * - **寫不進去**：換票失敗（呼叫端照 500 回），不發一張沒有紀錄的票。
 * - **不記秘密**：服務憑證、登入票都不記；對方的登入 session id 只記 sha256。
 * - **憑證錯的請求合併**：沒過服務憑證的請求不知道是誰打的，又最容易被人大量打。一個時間窗（{@link UNAUTHENTICATED_WINDOW_MS}）
 *   裡第一次照記一行（`count: 1`），之後只計數；時間窗過了之後再有一次、或 serve 收尾時，把計到的寫成一行（`count`、`from`、`to`）。
 *   所以這一類每個時間窗最多兩行。合併中的計數只在這兩個時機落盤：行程被強制結束（沒走收尾）時這段計數遺失。過了服務憑證的請求（發票、身分被拒、本文不對、票滿了）一筆一行：打的人是設定裡指名的嵌入方。
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

/** 稽核紀錄的寫入端。 */
export interface EmbedAudit {
  /** 記一筆過了服務憑證的換票。寫好（`datasync` 完）才 resolve；寫不進去就 reject。 */
  recordExchange(record: ExchangeRecord): Promise<void>;
  /** 記一次沒過服務憑證的請求（合併，見檔頭）。不 reject：寫失敗交給 `onError`。 */
  recordUnauthenticated(): void;
  /** 把還沒寫的合併計數寫掉、關檔。關了之後 `recordExchange` 一律 reject，`recordUnauthenticated` 不動作。 */
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
  /** 目前時間窗的起點與窗內第一行之後計到的次數。 */
  let window: { readonly start: number; pending: number; last: number } | undefined;

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

  function flushWindow(): Promise<void> | undefined {
    if (window === undefined || window.pending === 0) return undefined;
    const { start, pending, last } = window;
    window.pending = 0;
    return append({
      event: 'exchange',
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
    recordUnauthenticated() {
      if (closed) return;
      const at = now();
      if (window !== undefined && at - window.start < UNAUTHENTICATED_WINDOW_MS) {
        window.pending += 1;
        window.last = at;
        return;
      }
      flushWindow()?.catch(onError);
      window = { start: at, pending: 0, last: at };
      append({ event: 'exchange', outcome: 'unauthenticated', count: 1 }).catch(onError);
    },
    async close() {
      if (closed) return;
      closed = true;
      await flushWindow()?.catch(onError);
      await queue;
      await handle.close();
    },
  };
}
