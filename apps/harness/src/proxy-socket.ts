/**
 * serve 改聽 Unix socket、只讓反向代理連進來（[#2369](https://github.com/DemianLi/nexus-agent/issues/2369)，`--unix-socket`／`--socket-group`）。
 *
 * 主機多人共用，綁 loopback 的 port 誰都連得到；改聽 socket 之後，**誰連得進來由 socket 所在目錄的權限決定**：
 * 目錄是 serve 的使用者自己的、群組是代理那個群組、權限恰好 0750 或 0710（other 一律 0），所以只有 serve 自己與代理群組的成員走得到 socket。
 * 建目錄、設群組是管理者的事（`docs/operations.md`〈放在反向代理後面〉），serve 只在起動時驗，不合就起不來，不自己改權限。
 *
 * socket 檔本身在 listen 之後改成 0666：它的群組是 serve 行程的群組、不是代理的，留 umask 給的權限代理會 connect 不進來。
 * 閘門是目錄，不是這個檔——各平台對 socket 檔權限的執行不一致，目錄的 other 位元是 0 則到處都擋得住。
 *
 * @module
 */

import { chmod, lstat, unlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname } from 'node:path';

/** 目錄可以是這兩種權限：群組要能進目錄（x），列不列得出內容（r）都行；寫與 other 一律沒有。 */
const ALLOWED_DIRECTORY_MODES: ReadonlySet<number> = new Set([0o750, 0o710]);

/** listen 之後 socket 檔的權限：誰走得到它由目錄決定，見檔頭。 */
const SOCKET_FILE_MODE = 0o666;

/**
 * `--socket-group` 的值：代理所在群組的數字 gid。
 *
 * 只收數字：Node 沒有查群組名的介面，只讀 `/etc/group` 又查不到 LDAP、SSSD 這類目錄服務的群組。
 *
 * @throws 不是非負整數。
 */
export function parseSocketGroup(raw: string): number {
  const gid = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(gid)) {
    throw new Error(
      `--socket-group 要給代理所在群組的數字 gid（例如 getent group nginx 的第三欄），收到 "${raw}"`,
    );
  }
  return gid;
}

/**
 * 驗 `socketPath` 所在的目錄：是真的目錄（符號連結不算）、擁有者是這個行程的使用者、群組是 `gid`、權限恰好 0750 或 0710。
 *
 * @throws 任何一條不成立；訊息說要怎麼改。
 */
export async function assertProxySocketDirectory(socketPath: string, gid: number): Promise<void> {
  const directory = dirname(socketPath);
  // 只驗這一層、不跟它的符號連結，理由同 `peer-socket-auth.ts`：驗完之後連結還換得掉。
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    throw new Error(
      `socket 目錄 ${directory} 讀不到：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!info.isDirectory()) {
    throw new Error(`socket 目錄 ${directory} 不是目錄（符號連結也不算）`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw new Error(
      `socket 目錄 ${directory} 的擁有者是 uid ${String(info.uid)}，要是 serve 自己的 ${String(uid)}`,
    );
  }
  if (info.gid !== gid) {
    throw new Error(
      `socket 目錄 ${directory} 的群組是 gid ${String(info.gid)}，跟 --socket-group ${String(gid)} 不一樣`,
    );
  }
  const mode = info.mode & 0o777;
  if (!ALLOWED_DIRECTORY_MODES.has(mode)) {
    throw new Error(
      `socket 目錄 ${directory} 權限是 ${mode.toString(8).padStart(3, '0')}，要恰好 750 或 710：other 走得到目錄，同主機的任何使用者就連得進 serve`,
    );
  }
}

/** 路徑上的 socket 有沒有行程在聽。 */
function isListening(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(socketPath);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => {
      resolve(false);
    });
  });
}

/**
 * listen 之前清掉上一次留下的 socket 檔：serve 被 `kill -9` 之類沒走收尾時，檔還在，listen 會撞 `EADDRINUSE`。
 *
 * 只刪「是 socket、而且沒有行程在聽」的那一種；不是 socket 的檔、或還有行程在聽，一律拒絕起動，不碰它。
 *
 * @throws 路徑上是別種檔，或另一個行程正在聽。
 */
export async function clearStaleSocket(socketPath: string): Promise<void> {
  let info;
  try {
    info = await lstat(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!info.isSocket()) {
    throw new Error(`${socketPath} 已經有一個不是 socket 的檔，serve 不覆蓋它`);
  }
  if (await isListening(socketPath)) {
    throw new Error(`${socketPath} 上已經有行程在聽，可能是另一個 serve`);
  }
  await unlink(socketPath);
}

/** listen 之後把 socket 檔改成代理 connect 得進來的權限，見檔頭。 */
export async function openSocketToProxy(socketPath: string): Promise<void> {
  await chmod(socketPath, SOCKET_FILE_MODE);
}
