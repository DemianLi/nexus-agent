/**
 * harness home：這台機器上屬於這個使用者的 nexus-agent 資料根目錄
 * （[#424](https://github.com/DemianLi/nexus-agent/issues/424)）。
 *
 * **解析規則逐條照 dsh** `packages/util/home-paths/src/index.ts` 的 `resolveDshHome`（`ddefc45`）：
 * 環境變數有值就用它，空字串或只有空白算沒設（不然空的覆寫會把 home 解到目前目錄）；沒設就是
 * `~/.nexus-agent`；`~`、`~/` 開頭展開成作業系統的家目錄；最後正規化成絕對路徑。dsh 的變數叫
 * `DSH_HOME`、預設 `~/.dsh`，這裡只換名字。
 *
 * 今天住在這裡的只有瀏覽器會話的簽章密鑰（`browser-session-secret.ts`）。
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** 覆寫 home 的環境變數。 */
export const HARNESS_HOME_ENV = 'NEXUS_AGENT_HOME';

/** 沒覆寫時，home 在家目錄底下的名字。 */
export const HARNESS_HOME_DIR_NAME = '.nexus-agent';

function expandHomePath(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
  return path;
}

/**
 * 解析 harness home。
 *
 * @param env - 讀 {@link HARNESS_HOME_ENV} 的環境；serve 傳的是 `RunServeOptions.env ?? process.env`。
 * @returns 正規化過的絕對路徑。只解析，不建目錄。
 */
export function resolveHarnessHome(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env[HARNESS_HOME_ENV];
  const selected =
    configured !== undefined && configured.trim().length > 0
      ? configured
      : join(homedir(), HARNESS_HOME_DIR_NAME);
  return resolve(expandHomePath(selected));
}
