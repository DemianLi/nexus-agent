/**
 * 子代理逐次選模型的**政策**（[#875](https://github.com/DemianLi/nexus-agent/issues/875)，卡
 * [#709](https://github.com/DemianLi/nexus-agent/issues/709)）：設定怎麼變成一個會話的政策，以及續接時怎麼讀回來。
 *
 * 照 dsh（`packages/subagent/tool-subagent/src/index.ts:626-640` 與 `model-selection-state.ts:17`，`477b4f4`）：
 *
 * - **沒有歷史的新會話**從設定取樣一次，寫成 `subagent/model-selection-policy` 事件（`agent-factory.ts` 的 `attachSession`）；
 * - **有歷史的會話**（續接）只讀日誌那一份，**不看現在的設定**：設定事後再改只影響新會話。
 *   沒有那顆事件的舊會話就是關著，即使現在設定打開了。
 *
 * @module
 */

import type { SessionEvent } from '@nexus/core';

import type { ModelEntry } from './model-catalog.js';
import type { SubagentModelSelectionConfig } from './settings/subagent-model-selection.js';

/** 一個會話生效的政策：允許子代理挑的型錄 id。 */
export interface ModelSelectionPolicy {
  readonly allowedModels: readonly string[];
}

/**
 * 日誌上記著的政策：最後一顆 `subagent/model-selection-policy`；沒有就是 `undefined`（＝關）。
 * 同 `recordedSandboxMode` 的形狀。
 *
 * @param events - 讀回來的那一份日誌。
 */
export function recordedModelSelectionPolicy(
  events: readonly SessionEvent[],
): ModelSelectionPolicy | undefined {
  for (let at = events.length - 1; at >= 0; at -= 1) {
    const event = events[at];
    if (event?.type === 'subagent/model-selection-policy') {
      return { allowedModels: [...event.data.allowedModels] };
    }
  }
  return undefined;
}

/**
 * 啟動時驗：`allowedModels` 裡每一個 id 都在型錄裡。**關著的設定不驗**（關著的清單不會被用到）。
 * 單列 schema 管不到這一點（兩列是各自的 schema），所以 serve 讀完兩列後在這裡驗，起不來就在 server 起來之前。
 *
 * @throws 有不在型錄裡的 id 時，訊息指名它與型錄有哪些。
 */
export function assertAllowedModelsInCatalog(
  setting: SubagentModelSelectionConfig,
  catalog: readonly ModelEntry[],
): void {
  if (!setting.enabled) return;
  const known = new Set(catalog.map((entry) => entry.id));
  const missing = setting.allowedModels.filter((id) => !known.has(id));
  if (missing.length === 0) return;
  throw new Error(
    `subagent-model-selection 的 allowedModels 有型錄裡沒有的模型：${missing.map((id) => `"${id}"`).join('、')}` +
      `（live-model 的 models 型錄有：${[...known].join('、') || '（空的）'}）`,
  );
}

/**
 * 這個會話的政策。
 *
 * @param input.resumedEvents - 續接回來的日誌；`undefined` 是沒有歷史的新會話。**有歷史就只讀日誌**，不看設定。
 * @param input.setting - 啟動時解好、驗過的設定。
 * @returns 政策，或 `undefined`（關）。
 */
export function modelSelectionPolicyFor(input: {
  readonly resumedEvents: readonly SessionEvent[] | undefined;
  readonly setting: SubagentModelSelectionConfig;
}): ModelSelectionPolicy | undefined {
  if (input.resumedEvents !== undefined) return recordedModelSelectionPolicy(input.resumedEvents);
  if (!input.setting.enabled) return undefined;
  return { allowedModels: [...input.setting.allowedModels] };
}
