/**
 * 啟動時裝一次對外代理（[#746](https://github.com/DemianLi/nexus-agent/issues/746)）。
 *
 * 照 dsh：**啟動流程的第一件事**，排在載完分層環境之後、第一顆外掛載入之前
 * （`apps/cli/src/profile-boot.ts:245-252`，`477b4f4`）。值從啟動環境讀（`LaunchEnvironment`），
 * 所以寫在 harness home 那份 `.env` 裡的代理也生效；目前資料夾那份設代理，`launch-env.ts` 已經在載入時拒絕。
 *
 * **每一條啟動路徑都裝，不只 `--live`**：網路上的 MCP（`transport: 'http'`）在假模型路徑上一樣連外。
 * 沒帶 `--live` 時沒有 `.env` 可讀，改用只有行程環境那一層的快照（{@link processLaunchEnv}）——
 * 那條路徑本來就不讀任何 `.env`，這裡不改變它。
 *
 * @module
 */

import { installProxyFromEnvironment } from '@nexus/core';

import type { LaunchEnvironment } from './launch-env.js';

/**
 * 依啟動環境裝代理。沒有設任何代理時**什麼都不裝、不動環境變數**，回傳的收尾函式是空的。
 *
 * @param launchEnv - 這次啟動的環境快照。
 * @param warn - 每個用不了的代理值收到一則訊息（點名變數、不含值），由呼叫端決定往哪裡講。
 * @returns 收尾函式：還原派送器、政策與環境。**入口要在結束時呼叫**，不然同一個行程裡後面的啟動（測試）會繼承它。
 */
export async function installLaunchProxy(
  launchEnv: LaunchEnvironment,
  warn: (message: string) => void,
): Promise<() => Promise<void>> {
  return await installProxyFromEnvironment(launchEnv, (message) => {
    warn(`代理：${message}`);
  });
}
