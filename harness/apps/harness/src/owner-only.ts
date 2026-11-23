/**
 * 秘密檔的權限檢查：**讀之前先確認只有擁有者讀得到**，group 或 other 有任何一個權限位元就拒絕。
 *
 * 逐條照 dsh `credentials-local` 的 `assertOwnerOnly`（`477b4f4`）：檔案是我們自己以 `0600` 建的，但手寫或別的工具產生的
 * 檔案帶著當時的 umask，默默從一份人人可讀的檔案讀秘密，會讓我們承諾的權限變成空話。Windows 沒有 POSIX mode 可看，
 * 跳過而不假裝。
 *
 * 瀏覽器會話密鑰（`browser-session-secret.ts`，#424）與受管憑證檔（`credentials.ts`，#730）共用這一份。
 */

/** group 或 other 的任何權限位元。 */
export const GROUP_OTHER_BITS = 0o077;

/** 目錄與檔案建立時的權限。 */
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/**
 * @param label - 這是什麼檔，寫進訊息開頭。
 * @param file - 絕對路徑。
 * @param mode - `stat` 給的 mode。
 * @throws 其他使用者讀得到；訊息帶 `chmod 600` 那一行。
 */
export function assertOwnerOnlyMode(label: string, file: string, mode: number): void {
  if (process.platform === 'win32' || (mode & GROUP_OTHER_BITS) === 0) return;
  throw new Error(
    `${label} ${file} 其他使用者讀得到（mode ${(mode & 0o777).toString(8)}）；` +
      `先跑 chmod 600 ${file} 再啟動。`,
  );
}
