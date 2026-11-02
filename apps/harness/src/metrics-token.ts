/**
 * 指標端點的 bearer token 檔（[#1535](https://github.com/DemianLi/nexus-agent/issues/1535)，Q1 (a)）：打開 `/metrics` 時 serve 讀這個檔，
 * 沒有就建一個。
 *
 * 規矩照 `browser-session-secret.ts`，**只有格式不同**：
 *
 * - 目錄 `0700`、檔 `0600`；已存在的檔 group 或 other 有任何權限位元就拒絕啟動（`owner-only.ts` 的 `assertOwnerOnlyMode`）；
 * - 先寫暫存檔再 `link` 到正式路徑（`atomic-file.ts` 的 `publishNewFile`），兩個行程同時第一次建立時先寫的贏、後到的讀它；
 * - 內容認不得就明確失敗，**不覆寫**。
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

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { publishNewFile } from './atomic-file.js';
import { assertOwnerOnlyMode, PRIVATE_DIR_MODE } from './owner-only.js';

/** token 檔在 harness home 底下的預設名字。 */
export const METRICS_TOKEN_FILE = 'metrics-token';

const TOKEN_BYTES = 32;
const LABEL = '指標 token 檔';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** 讀已存在的檔；不存在回 `undefined`。權限過寬或內容認不得都拋，不覆寫。 */
async function readTokenFile(file: string): Promise<string | undefined> {
  let mode: number;
  try {
    mode = (await stat(file)).mode;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  assertOwnerOnlyMode(LABEL, file, mode);
  const token = (await readFile(file, 'utf8')).trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error(
      `${LABEL} ${file} 的內容不合格（要 32 位元組的 base64url，43 個字元，後面可有換行）；` +
        '確認它不是別的東西寫的。要重設就刪掉它再重啟 serve——監控那一側要換新的 token。',
    );
  }
  return token;
}

/**
 * 讀指標 token 檔，沒有就建一個。
 *
 * @param file - token 檔的絕對路徑。上層目錄不存在就以 `0700` 建。
 * @returns token（43 字元，不含換行）。兩個呼叫同時第一次建立時，拿到的是同一個。
 * @throws 權限過寬、內容認不得、或建立失敗。
 */
export async function loadOrCreateMetricsToken(file: string): Promise<string> {
  const existing = await readTokenFile(file);
  if (existing !== undefined) return existing;

  await mkdir(dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    await publishNewFile(file, `${randomBytes(TOKEN_BYTES).toString('base64url')}\n`);
  } catch (error) {
    // 別的行程先建好了：讀它那一個。其他失敗照拋。
    if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw error;
  }
  const created = await readTokenFile(file);
  if (created === undefined) throw new Error(`${LABEL} ${file} 建立之後讀不到。`);
  return created;
}
