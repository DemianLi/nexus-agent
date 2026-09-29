/**
 * 交給子行程的環境：**每個自己起子行程的地方共用這一份清洗**（[#726](https://github.com/DemianLi/nexus-agent/issues/726)）。
 * 照 dsh 的 `scrubbedParentEnv()`（`packages/subprocess/subprocess/src/index.ts:47-80`，`477b4f4`）。
 *
 * 今天的使用者是兩個：git 快照（`@nexus/plugin-workspace-changes`）與 MCP 的 stdio server（`@nexus/plugin-mcp`）。
 * 後者的子行程是 SDK 起的，所以跟 dsh 一樣共用的是清洗的定義，不是起子行程的那條路。
 *
 * ## 與 dsh 的偏離：沒有 subprocess 服務，只有一個函式
 *
 * dsh 把它放在 `subprocess` 能力那一層，所有 spawner 經那個服務起子行程；我們沒有這個服務，兩個使用者各自 spawn
 * （git 那側的登記見 `packages/nexus-plugin-workspace-changes/src/git.ts` 檔頭）。**退掉的是載體，規則照抄**：
 * dsh 自己也把它匯出成一般函式，給不經那個服務的 spawner（SDK 管的 transport 之類）用
 * （`packages/subprocess/subprocess/src/index.ts:58-60`）；我們沒有那個服務，兩個使用者都只能走這條。放在 core，
 * 是因為兩個 plugin 都已相依它，而 plugin 之間今天沒有互相相依。
 *
 * ## 代理那一層（[#746](https://github.com/DemianLi/nexus-agent/issues/746)）
 *
 * 照 dsh 疊在 `scrubbedParentEnv()` 後面的那段（`packages/subprocess/subprocess/src/index.ts:75-78`）：行程裝了代理時，
 * 結果多帶 `NODE_USE_ENV_PROXY=1`，並把代理變數還原成使用者匯出的值（沒設的名字移除），細節與判準在
 * {@link proxyEnvironmentForChild}。子行程裡的 Node 不看這個旗標就不理代理變數，MCP 的 stdio server 與 git 底下的
 * 任何 Node 工具會在父行程走代理時自己直連。沒裝代理時這一層是空的，結果跟只清洗一模一樣。
 *
 * **與 dsh 的差異**：dsh 的函式沒有參數，永遠讀 `process.env`；我們的可以餵一份合成的環境（測試用），而代理狀態是
 * 行程層的、不屬於那份合成環境，所以**只有讀 `process.env` 時才疊這一層**，餵別份環境的呼叫端拿到純清洗。
 *
 * @module
 */

import { proxyEnvironmentForChild } from './http-proxy/install.js';

/**
 * 名字像憑證的環境變數不交給子行程，照抄 dsh 的 `SENSITIVE_ENV_PATTERN`（`packages/subprocess/subprocess/src/index.ts:47`）。
 * git 自己的 `GIT_CONFIG_KEY_<n>` 也中這一條，所以 git 快照另外設 `GIT_CONFIG_COUNT=0`，同 dsh。
 */
export const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i;

/** harness 自己的變數前綴；dsh 拿掉的是 `DSH_*`。 */
const HARNESS_ENV_PREFIX = 'NEXUS_';

/**
 * 父行程的環境，拿掉名字像憑證的與 harness 自己的變數，照 dsh 的 `scrubbedParentEnv()`。兩條都不分大小寫。
 * `PATH`、`HOME`、語系、代理變數照留，子行程才跑得起來；行程裝了代理時另外疊上代理那一層（見檔頭）。**要刻意交出去的憑證**（例如 MCP 設定裡的
 * `GITHUB_TOKEN`）由呼叫端疊在結果後面，不在這裡放行。
 *
 * @param source - 父行程的環境，省略是 `process.env`（呼叫當下才讀）。
 * @returns 一份新的環境物件。
 */
export function scrubbedParentEnv(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || SENSITIVE_ENV_PATTERN.test(key)) continue;
    if (key.toUpperCase().startsWith(HARNESS_ENV_PREFIX)) continue;
    env[key] = value;
  }
  if (source !== process.env) return env;
  // `undefined` 是「使用者沒設這個名字」，要把這個行程自己寫進去的移掉。
  for (const [name, value] of Object.entries(proxyEnvironmentForChild())) {
    if (value === undefined) Reflect.deleteProperty(env, name);
    else env[name] = value;
  }
  return env;
}
