/**
 * 指標端點的 bearer token 檔（[#1535](https://github.com/DemianLi/nexus-agent/issues/1535)，Q1 (a)）：打開 `/metrics` 時 serve 讀這個檔，
 * 沒有就建一個。
 *
 * 規矩照 `browser-session-secret.ts`，**只有格式不同**；讀寫在 `bearer-token-file.ts`，嵌入方的服務憑證共用。
 *
 * **內容是裸的 token 加一個換行，不是 JSON。** 檔案要原樣交給監控那一側：Prometheus 的 `authorization.credentials_file` 讀整個檔案（去掉前後空白）
 * 當 bearer，包一層 `{ "version": 1, … }` 它就沒法用了。token 是 32 位元組亂數的 base64url（43 字元）。
 *
 * ## 偏離 dsh：產品需求超出 dsh
 *
 * dsh 沒有指標出口，也就沒有這個檔（背景見 #1535「dsh 的做法」）；落盤與權限的規矩借 dsh `credentials-local` 的 `assertOwnerOnly`（已抽成 `owner-only.ts`）。
 *
 * @module
 */

import { loadOrCreateBearerTokenFile } from './bearer-token-file.js';

/** token 檔在 harness home 底下的預設名字。 */
export const METRICS_TOKEN_FILE = 'metrics-token';

/**
 * 讀指標 token 檔，沒有就建一個。
 *
 * @param file - token 檔的絕對路徑。上層目錄不存在就以 `0700` 建。
 * @returns token（43 字元，不含換行）。兩個呼叫同時第一次建立時，拿到的是同一個。
 * @throws 權限過寬、內容認不得、或建立失敗。
 */
export function loadOrCreateMetricsToken(file: string): Promise<string> {
  return loadOrCreateBearerTokenFile(file, {
    label: '指標 token 檔',
    resetHint: '監控那一側要換新的 token',
  });
}
