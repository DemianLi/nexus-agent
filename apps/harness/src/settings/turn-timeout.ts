/**
 * 一輪的**時鐘上限**的設定條目（[#1624](https://github.com/DemianLi/nexus-agent/issues/1624)）：一輪從 `turn/start` 起算，超過這麼多毫秒，
 * serve 就照停止鍵的路把它停下來，日誌以 `aborted`、原因 `{ kind: 'hook', reason: 'turn-timeout' }` 收尾。計時在 `../thread-pump.ts`
 * （root 那一輪）與 `../background-subagents.ts`（背景子代理的每一輪），這一列只講值。
 *
 * **這一顆不裝功能，只講設定**，`apply` 是空的，同 `goal-round-cap` 那一列：值由 `startupSetting` 在起動期讀出來，serve 交給每條
 * thread 的 pump 與背景子代理。**改了要重啟**（分類 `startup-read`，`plugin-row-classes.ts`）。CLI 一次性路徑不套（#1614 Q-B4 (a)：生產走 serve）。
 *
 * ## 偏離 dsh：產品需求超出 dsh（理由 2）
 *
 * - **哪一條**：多一個一輪層級的時鐘，到點中止這一輪。dsh 沒有這個生產者：全樹沒有一輪的時鐘，有的時限都不是一輪層級的
 *   （工具的 `guard/timeout-policy`、程式執行的 `maxWallMs`），見 #1624 正文的查法，`687f282e`。
 * - **理由**：多人共用一台內網主機，一條卡住的 thread 會一直花錢、佔 thread 名額與模型並行額度；dsh 是單人桌面，卡住了使用者自己會按停止。
 * - **補了什麼**：只補一個中止的生產者，**收尾的形狀照 dsh 的詞彙**：`aborted` 帶 `hook` 原因，同 dsh 帳號登出那個先例
 *   （`credentials/deepseek-account/src/account-tasks.ts:30` 的 `agent.cancel({ kind: 'hook', reason: … }, { keepInbox: true })`）。
 *   取消本身走既有的合作式中止（`@nexus/core` 的 `turn-cancel.ts`），不另起一條路：還沒開始的工具不開始、正在跑的等它落定、模型請求
 *   當場切斷、排著的輸入停住、目標收回續行授權。
 *
 * ## 出廠 30 分鐘（暫定）
 *
 * #1614 Q-B5：先量健康長輪的 p99 再定；**沒有量**（手上沒有可用的生產會話日誌），先用 Q-B5 給的暫定值 30 分鐘：比單次請求的最壞重試
 * （首事件 180 秒 × 7 次加退避，約 21 分鐘，#1251）長，正常一輪碰不到；失控的一輪最多燒半小時。排隊等全機模型並行額度的時間
 * （#1505）算在這一輪裡，所以要留餘地。等人核准的時間不算：停在核准點本身就是 `turn/end`，人批准是新的一輪、重新計時。
 * 預設寫在 schema，`cordis.yml` 照抄同一個值讓人看得到（`plugin-config.test.ts` 釘兩邊相等）。
 *
 * ## 上限是計時器上限
 *
 * `setTimeout` 的延遲超過 2³¹−1 毫秒會被 Node 當成 1，所以 schema 擋在 {@link MAX_TURN_TIMEOUT_MS}，同 dsh `packages/util/timeout/src/index.ts:25`
 * 的 `MAX_TIMER_DELAY_MS`。#1569 的 `@nexus/timeout` 還沒合，先用最小的 `setTimeout`，合了再換（同 `live-model.ts`、`memory-gauge.ts`
 * 各自定義同一個數字的做法）。
 *
 * ## 關得掉
 *
 * `disabled: true` 就是不限，跟今天一樣。**讀的那一方要先問 `startupEntryMounted`**：`startupSetting` 把關掉的列讀成 schema 預設，只用它
 * 的話關不掉。**寫壞了整個起不來**（`startup-audit.ts` 的必掛名單，同 `goal-round-cap`）：寫壞就掉，掉了就沒有時鐘，是 fail-open。
 *
 * @module
 */

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';
import { MAX_TIMER_DELAY_MS } from '@nexus/timeout';

/** 這一列在訊息裡叫什麼。 */
export const TURN_TIMEOUT_PLUGIN_NAME = 'turn-timeout';

/** 出廠的時鐘，理由見檔頭。 */
export const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;

/** 計時器能排的最長延遲，見檔頭。 */
export const MAX_TURN_TIMEOUT_MS = MAX_TIMER_DELAY_MS;

/** 中止原因裡的 `reason`：日誌與下行都帶這個字串，讀的人據此分出「時間到」與「人按停止」。 */
export const TURN_TIMEOUT_REASON = 'turn-timeout';

/** `strictObject`：多寫一個欄位是打錯字，同其他幾列。 */
export const turnTimeoutConfigSchema = z.strictObject({
  /** 一輪最多跑幾毫秒。正整數，不超過 {@link MAX_TURN_TIMEOUT_MS}；要拿掉時鐘就把整列關掉。 */
  timeoutMs: z.number().int().min(1).max(MAX_TURN_TIMEOUT_MS).default(DEFAULT_TURN_TIMEOUT_MS),
});

/** 驗過的設定。 */
export type TurnTimeoutConfig = z.infer<typeof turnTimeoutConfigSchema>;

/** 只講設定的那一顆，見檔頭。 */
export const turnTimeoutPlugin: NexusPlugin<TurnTimeoutConfig> = {
  name: TURN_TIMEOUT_PLUGIN_NAME,
  Config: turnTimeoutConfigSchema,
  apply: (_registry: PluginRegistry, _config: TurnTimeoutConfig): void => {
    // 空的：組裝期沒有消費者。
  },
};

export default turnTimeoutPlugin;
