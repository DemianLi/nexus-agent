/**
 * 目標續行的**操作者上限**的設定條目（[#1623](https://github.com/DemianLi/nexus-agent/issues/1623)）：人每授權一次（建立或恢復目標），
 * 續行最多再排幾輪。排程器在 `../goal-driver.ts`，這一列的值是它的 `roundCap`。
 *
 * **這一顆不裝功能，只講設定**，`apply` 是空的，同 `thread-capacity` 那一列：值由 `startupSetting` 在起動期讀出來，serve 交給每條
 * thread 的 pump，CLI 交給它的續行迴圈。**改了要重啟**（分類 `startup-read`，`plugin-row-classes.ts`）。消費者是 harness 的排程器
 * 不是 goal 插件（排程器在 harness，見 `goal-driver.ts` 檔頭的載體偏離），設定跟著消費者放（#1614 Q-A1 (a)）。
 *
 * ## 偏離 dsh：產品需求超出 dsh（理由 2）
 *
 * dsh 的續行只有目標自己那條上限（`packages/goal/goal-round-driver/src/index.ts:182-188`，`687f282e`），而那個數是模型在
 * `create_goal` 填的、還能用 `update_goal` 調高；部署設定 `defaultMaxGoalRounds` 只是預設（`goal/src/index.ts:218`、`:243-245`）。
 * 多人共用一台內網主機時，一個失控的目標會一直花錢、佔 thread 名額，部署的人要能從外面夾住它。補的是一條模型改不動的上限，
 * 載體沿用 CLI 早就有的 `roundCap`；目標域的 `??` 不動，同 dsh。逐點見 `../goal-driver.ts` 檔頭那一筆登記。
 *
 * ## 出廠 20
 *
 * 一輪續行最多約 24 次模型呼叫（`recursion-limit` 那一列的推算），20 輪約 480 次，比目標自己的預設 256 輪（約 6000 次）低一個數量級。
 * **沒有量過健康的目標要跑幾輪**，這是保守的起點（#1614 Q-A3 (a)）。預設寫在 schema，`cordis.yml` 照抄同一個值讓人看得到
 * （`plugin-config.test.ts` 釘兩邊相等），理由同 `thread-capacity`：patch 是整份替換 `config`，把 `config:` 拿掉的 patch 要回到同一個值。
 *
 * ## 關得掉
 *
 * `disabled: true` 就是只剩目標自己那條，跟沒有這一列一樣。**讀的那一方要先問 `startupEntryMounted`**：`startupSetting` 把關掉的列
 * 讀成 schema 預設（20），只用它的話關不掉。
 *
 * ## 續行關著時不起作用、不報錯（#1614 Q-A4 (a)）
 *
 * CLI 的 `--max-goal-rounds` 沒配 `--goal-driver` 是錯誤（`../cli.ts` 的 `parseMaxGoalRounds`）：旗標是這一次呼叫明講的意圖，
 * 收下來卻沒人用，就是一個看起來設過、實際上限制不到任何東西的上限。這一列不一樣：它是出廠的共用預設，serve 與 CLI 共讀一份
 * `cordis.yml`，而 CLI 預設不開續行。照旗標那條規矩，CLI 不帶 `--goal-driver` 每次啟動都會失敗。所以那條規矩只管命令列旗標，
 * 這一列在續行關著時（CLI 沒帶 `--goal-driver`、serve 帶了 `--no-goal-driver`）安靜地不起作用。
 *
 * @module
 */

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';

/** 這一列在訊息裡叫什麼。 */
export const GOAL_ROUND_CAP_PLUGIN_NAME = 'goal-round-cap';

/** 出廠的上限，理由見檔頭。 */
export const DEFAULT_GOAL_ROUND_CAP = 20;

/** `strictObject`：多寫一個欄位是打錯字，同其他幾列。 */
export const goalRoundCapConfigSchema = z.strictObject({
  /** 人每授權一次，續行最多排幾輪。正整數；要放寬就調大，要拿掉這條上限就把整列關掉。 */
  limit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_GOAL_ROUND_CAP),
});

/** 驗過的設定。 */
export type GoalRoundCapConfig = z.infer<typeof goalRoundCapConfigSchema>;

/** 只講設定的那一顆，見檔頭。 */
export const goalRoundCapPlugin: NexusPlugin<GoalRoundCapConfig> = {
  name: GOAL_ROUND_CAP_PLUGIN_NAME,
  Config: goalRoundCapConfigSchema,
  apply: (_registry: PluginRegistry, _config: GoalRoundCapConfig): void => {
    // 空的：組裝期沒有消費者。
  },
};

export default goalRoundCapPlugin;

/** 寫進 blocker 訊息裡的來源，讓人知道去哪裡改。 */
export const GOAL_ROUND_CAP_SOURCE = '部署設定（cordis.yml 的 goal-round-cap 那一列）';
