/**
 * 呼叫宿主服務失敗時丟的錯。
 *
 * @module
 */

import type { HostErrorCode } from './protocol.js';

/**
 * 「宿主不在」那一族，客戶端自己判，不上線：
 *
 * - `host_absent`：這個行程沒有宿主（單行程模式、監督行程沒起宿主），或連線已經關了。不會好轉，不要重試。
 * - `host_unavailable`：有宿主，但等到時限還沒連上。呼叫沒有送出去，可以重試。
 * - `host_lost`：送出去之後連線斷了，宿主那邊做了沒做不知道。不自動重送，要不要重送由呼叫端照方法的語意決定。
 */
export const HOST_ABSENCE_CODES = ['host_absent', 'host_unavailable', 'host_lost'] as const;

export type HostAbsenceCode = (typeof HOST_ABSENCE_CODES)[number];

export type HostCallErrorCode = HostErrorCode | HostAbsenceCode;

export class HostCallError extends Error {
  override readonly name = 'HostCallError';

  constructor(
    readonly code: HostCallErrorCode,
    message: string,
  ) {
    super(message);
  }
}
