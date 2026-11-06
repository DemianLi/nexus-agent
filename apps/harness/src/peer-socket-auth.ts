/**
 * 對話行程 socket 上的驗證（[#2338](https://github.com/DemianLi/nexus-agent/issues/2338)，設計 `.docs/supervisor-1947-design-2026-11-03.md` §4-2）：
 * 登入只在前台，對話行程不帶 `BrowserAuth`、前台也不轉瀏覽器的 cookie。**信任來自 socket 所在的目錄**：監督行程建一個只有擁有者
 * 讀寫得到的目錄（0700），socket 放在裡面，連得進來的就是同一個使用者的行程（前台）。主機多人共用時，邊界就是這個目錄的權限。
 *
 * 所以這一支不看請求，只在建的時候驗目錄：是真的目錄（不是指向目錄的符號連結）、權限恰好 0700、擁有者是這個行程的使用者，任何一條不成立就拋、行程起不來。
 * `createWireHandler` 的 `auth` 仍是必填；只有對話行程的入口（`conversation-process.ts`）建它，`peer-socket-auth.test.ts` 掃原始碼釘住這一點。
 *
 * @module
 */

import { lstat } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { WireAuth } from './wire-handler.js';
import { OWNER_PRINCIPAL } from './wire-principal.js';

/** 對話行程 socket 上的 {@link WireAuth}。用 {@link openPeerSocketAuth} 建。 */
export interface PeerSocketAuth extends WireAuth {
  /** 驗過的目錄。 */
  readonly directory: string;
}

/**
 * 驗 `socketPath` 所在的目錄，過了才回一支把所有請求都當成擁有者的 {@link PeerSocketAuth}。
 *
 * @throws 目錄不存在、不是目錄（含符號連結）、權限不是 0700，或擁有者不是這個行程的使用者。
 */
export async function openPeerSocketAuth(socketPath: string): Promise<PeerSocketAuth> {
  const directory = dirname(socketPath);
  // 只驗 socket 所在的這一層、不跟它的符號連結：連結不在驗證範圍內，能寫它那層目錄的人驗完之後還能換掉它，listen 就落到沒驗過的目錄。上層路徑照常解析。
  const info = await lstat(directory);
  if (!info.isDirectory())
    throw new Error(`對話行程的 socket 目錄 ${directory} 不是目錄（符號連結也不算）`);
  const mode = info.mode & 0o777;
  if (mode !== 0o700) {
    throw new Error(
      `對話行程的 socket 目錄 ${directory} 權限是 ${mode.toString(8).padStart(3, '0')}，要恰好 700：別的使用者連得進來就能以 serve 擁有者的身分操作這條 thread`,
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw new Error(
      `對話行程的 socket 目錄 ${directory} 的擁有者是 uid ${String(info.uid)}，不是這個行程的 ${String(uid)}`,
    );
  }
  return { directory, authenticate: () => OWNER_PRINCIPAL };
}
