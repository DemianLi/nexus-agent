/**
 * 放一把 bearer token 的秘密檔：沒有就建，有就驗過再讀。指標 token（`metrics-token.ts`，#1535）與嵌入方的服務憑證
 * （`serve-run.ts` 起動時讀，#2370）共用這一份，兩邊只有檔案的稱呼與「要重設時另一側要做什麼」不同。
 *
 * - 目錄 `0700`、檔 `0600`；已存在的檔 group 或 other 有任何權限位元就拋（`owner-only.ts` 的 `assertOwnerOnlyMode`）；
 * - 先寫暫存檔再 `link` 到正式路徑（`atomic-file.ts` 的 `publishNewFile`），兩個行程同時第一次建立時先寫的贏、後到的讀它；
 * - 內容認不得就明確失敗，**不覆寫**。
 *
 * **內容是裸的 token 加一個換行，不是 JSON**：檔案要原樣交給另一側（Prometheus 的 `credentials_file`、嵌入方的後端）。
 * token 是 32 位元組亂數的 base64url（43 字元）。
 *
 * @module
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { publishNewFile } from './atomic-file.js';
import { assertOwnerOnlyMode, PRIVATE_DIR_MODE } from './owner-only.js';

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** 這個檔在訊息裡怎麼稱呼。 */
export interface BearerTokenFileLabels {
  /** 檔案的稱呼，例如「指標 token 檔」。 */
  readonly label: string;
  /** 刪檔重設之後，另一側要做的事，接在「要重設就刪掉它再重啟 serve——」後面。 */
  readonly resetHint: string;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

async function readTokenFile(
  file: string,
  labels: BearerTokenFileLabels,
): Promise<string | undefined> {
  let mode: number;
  try {
    mode = (await stat(file)).mode;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  assertOwnerOnlyMode(labels.label, file, mode);
  const token = (await readFile(file, 'utf8')).trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error(
      `${labels.label} ${file} 的內容不合格（要 32 位元組的 base64url，43 個字元，後面可有換行）；` +
        `確認它不是別的東西寫的。要重設就刪掉它再重啟 serve——${labels.resetHint}。`,
    );
  }
  return token;
}

/**
 * 讀 token 檔，沒有就建一個。
 *
 * @param file - 絕對路徑。上層目錄不存在就以 `0700` 建。
 * @param labels - 訊息裡的稱呼。
 * @returns token（43 字元，不含換行）。兩個呼叫同時第一次建立時，拿到的是同一個。
 * @throws 權限過寬、內容認不得、或建立失敗。
 */
export async function loadOrCreateBearerTokenFile(
  file: string,
  labels: BearerTokenFileLabels,
): Promise<string> {
  const existing = await readTokenFile(file, labels);
  if (existing !== undefined) return existing;

  await mkdir(dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    await publishNewFile(file, `${randomBytes(TOKEN_BYTES).toString('base64url')}\n`);
  } catch (error) {
    // 別的行程先建好了：讀它那一個。其他失敗照拋。
    if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw error;
  }
  const created = await readTokenFile(file, labels);
  if (created === undefined) throw new Error(`${labels.label} ${file} 建立之後讀不到。`);
  return created;
}

/**
 * 每一把 bearer token 要各自一個檔：兩把指到同一個檔，就變成同一把 token，比對時認不出是誰（例如嵌入方的憑證也打得了指標）。
 * 比的是解析成絕對路徑之後的字串；同一個檔經 symlink 或 hard link 換了名字，這裡看不出來。
 *
 * @throws 有兩個檔解析到同一個路徑，訊息指名兩邊。
 */
export function assertDistinctSecretFiles(
  files: readonly { readonly label: string; readonly file: string }[],
): void {
  const seen = new Map<string, string>();
  for (const { label, file } of files) {
    const path = resolve(file);
    const other = seen.get(path);
    if (other !== undefined) {
      throw new Error(`${other}與${label}指到同一個檔 ${path}：每一把 token 要各自一個檔。`);
    }
    seen.set(path, label);
  }
}
