/**
 * harness home：這台機器上屬於這個使用者的 nexus-agent 資料根目錄
 * （[#424](https://github.com/DemianLi/nexus-agent/issues/424)）。
 *
 * **解析規則逐條照 dsh** `packages/util/home-paths/src/index.ts` 的 `resolveDshHome`（`ddefc45`）：
 * 環境變數有值就用它，空字串或只有空白算沒設（不然空的覆寫會把 home 解到目前目錄）；沒設就是
 * `~/.nexus-agent`；`~`、`~/` 開頭展開成作業系統的家目錄；最後正規化成絕對路徑。dsh 的變數叫
 * `DSH_HOME`、預設 `~/.dsh`，這裡只換名字。
 *
 * 住在這裡的：瀏覽器會話的簽章密鑰（`browser-session-secret.ts`）、使用者那一層 patch
 * （`cordis.patch.yml`，`plugin-config.ts`），以及會話日誌的預設根（{@link harnessSessionsDir}）。
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

/** 會話日誌的預設根在 home 底下的名字。 */
export const HARNESS_SESSIONS_DIR_NAME = 'sessions';

/**
 * 會話日誌的預設根（[#444](https://github.com/DemianLi/nexus-agent/issues/444)）。
 *
 * **照 dsh**：base 與 sdk-minimal 出廠就掛 `session-persistence-jsonl`，根是
 * `dshHomePath('sessions')`（`packages/bundle/base/cordis.patch.yml:130-133`、`477b4f4`）。
 * 這裡只換 home 的名字。`--session-log` 給了就換成那個位置；清單上 `session-persistence` 那一列
 * 關掉（#612，同 dsh 不掛那一列）就一個字都不寫，這個路徑也不解析。
 *
 * @param env - 同 {@link resolveHarnessHome}。
 * @returns `<harness home>/sessions` 的絕對路徑。只解析，不建目錄——建目錄的是第一次寫入
 *   （`jsonl-session-store.ts`，`0700`）。
 */
export function harnessSessionsDir(env: Readonly<Record<string, string | undefined>>): string {
  return join(resolveHarnessHome(env), HARNESS_SESSIONS_DIR_NAME);
}
