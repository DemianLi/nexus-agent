/**
 * 瀏覽器會話 cookie 的簽章密鑰：存在 harness home 底下的一個專用檔
 * （[#424](https://github.com/DemianLi/nexus-agent/issues/424)）。
 *
 * **密鑰要落盤，不是每個行程換一把**，照 dsh 的決策筆記
 * `.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.zh.md`（`ddefc45`）：
 * 每次重啟都換密鑰，瀏覽器在普通的重啟之後就連不回來；只讓啟動 token 每個行程換一個，已經把
 * 「印出來的網址」限定在一個行程的壽命裡。
 *
 * ## 偏離（照 AGENTS.md 的偏離規則登記）
 *
 * - **沒有 credentials seam，改成 home 底下一個專用檔。** dsh 把密鑰存成 `ctx.credentials` 裡
 *   `client-connection/browser-session` 的 `grant` 記錄，由 `credentials-local` 寫進
 *   `$DSH_HOME/.credentials.yaml`。我們沒有那個載體（調研筆記 §三第 11 列），**退的是載體，
 *   隨載體一起來的規則照抄**：
 *   - 記錄帶版本（`{ version: 1, secret }`），密鑰是 32 bytes 的 base64url——
 *     `browser-auth.ts` 的 `storedSecret`／`canonicalSecret`；
 *   - 認不得的記錄明確失敗，**不覆寫**——同一個出處；
 *   - 讀之前先確認只有擁有者讀得到，group 或 other 有任何一個權限位元就拒絕啟動——
 *     `credentials-local` 的 `assertOwnerOnly`；Windows 沒有 POSIX mode 可看，跳過而不假裝；
 *   - 目錄 `0700`、檔案 `0600`——`credentials-local` 的 `writeFileAtomic(…, { mode: 0o600, dirMode: 0o700 })`；
 *   - 兩個行程同時第一次啟動不能互相蓋掉：dsh 在跨行程寫入鎖裡跑 `modifyRecord`；這裡只有一筆記錄，
 *     改用「先寫暫存檔、再 `link` 到正式路徑」——`link` 在目標已存在時失敗，所以先寫的贏，後到的讀
 *     先寫的那一把，而且讀的一方永遠讀不到寫一半的檔；
 *   - 每次啟動只讀一次，之後在記憶體裡同步驗證；刪掉這個檔再重啟就撤銷全部既有的會話。
 */

import { randomBytes } from 'node:crypto';
import { link, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 密鑰檔在 harness home 底下的名字。 */
export const BROWSER_SESSION_SECRET_FILE = 'browser-session.json';

const SECRET_BYTES = 32;
const RECORD_VERSION = 1;
const GROUP_OTHER_BITS = 0o077;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

/** 只收 canonical 的 base64url：解回去再編一次要一字不差，擋掉補零、換字元這類變形。 */
function canonicalSecret(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.byteLength !== SECRET_BYTES || encodeBase64Url(decoded) !== value) return undefined;
  return decoded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * 讀一份已存在的密鑰檔；不存在回 `undefined`。
 *
 * @throws 權限過寬、內容認不得、密鑰不合格——三種都不覆寫，由人決定怎麼處理。
 */
async function readSecretFile(file: string): Promise<Buffer | undefined> {
  let mode: number;
  try {
    mode = (await stat(file)).mode;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (process.platform !== 'win32' && (mode & GROUP_OTHER_BITS) !== 0) {
    throw new Error(
      `瀏覽器會話密鑰檔 ${file} 其他使用者讀得到（mode ${(mode & 0o777).toString(8)}）；` +
        `先跑 chmod 600 ${file} 再啟動。`,
    );
  }
  const text = await readFile(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // JSON 解不開：跟版本不對同一種處置——認不得就停下，不覆寫。
    parsed = undefined;
  }
  if (!isRecord(parsed) || parsed.version !== RECORD_VERSION) {
    throw new Error(
      `瀏覽器會話密鑰檔 ${file} 的格式認不得（要 { "version": 1, "secret": … }）；` +
        `確認它不是別的東西寫的。要重設就刪掉它再重啟 serve——所有瀏覽器會話都會失效。`,
    );
  }
  const secret = canonicalSecret(parsed.secret);
  if (secret === undefined) {
    throw new Error(
      `瀏覽器會話密鑰檔 ${file} 的密鑰不合格（要 32 bytes 的 base64url）；` +
        `要重設就刪掉它再重啟 serve——所有瀏覽器會話都會失效。`,
    );
  }
  return secret;
}

/**
 * 讀 home 底下的簽章密鑰，沒有就建一把。
 *
 * @param home - harness home（`harness-home.ts` 解析出來的絕對路徑）。不存在就以 `0700` 建。
 * @returns 32 bytes 的密鑰。兩個呼叫同時第一次建立時，拿到的是同一把。
 * @throws 檔案權限過寬、內容認不得、或建立失敗。
 */
export async function loadOrCreateBrowserSessionSecret(home: string): Promise<Buffer> {
  const file = join(home, BROWSER_SESSION_SECRET_FILE);
  const existing = await readSecretFile(file);
  if (existing !== undefined) return existing;

  await mkdir(home, { recursive: true, mode: DIR_MODE });
  const text = `${JSON.stringify({ version: RECORD_VERSION, secret: encodeBase64Url(randomBytes(SECRET_BYTES)) })}\n`;
  const staging = join(
    home,
    `.${BROWSER_SESSION_SECRET_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  await writeFile(staging, text, { mode: FILE_MODE, flag: 'wx' });
  try {
    await link(staging, file);
  } catch (error) {
    // 別的行程先建好了：讀它那一把。其他失敗照拋。
    if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw error;
  } finally {
    await rm(staging, { force: true });
  }
  const created = await readSecretFile(file);
  if (created === undefined) {
    throw new Error(`瀏覽器會話密鑰檔 ${file} 建立之後讀不到。`);
  }
  return created;
}
