/**
 * subagent 定義的註冊驗證（[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 3 項）：`NexusSubAgent` 的 `model` 與 `reasoningEffort`
 * 在 `registry.subagents.register()` 的當下對型錄驗證，認不得就拋，而不是等到委派才炸（PM 2026-10-09）。
 *
 * 型錄只有組裝點有（registry 自己沒有），所以這裡造出驗證函式交給 `createNexusAgent({ validateSubagent })`。沒連真實供應商的組裝
 * （腳本模型、評估）沒有型錄：字串 `model` 與 `reasoningEffort` 一律拒絕，因為沒有東西能把它們解成模型實例。
 *
 * 推理等級的界線同 {@link ./subagent-model-selection.ts}：型錄宣告過、而且今天實作的（`SUPPORTED_EFFORTS`）才收；`default` 一律收（不加任何東西）。
 *
 * @module
 */

import type { NexusSubAgent } from '@nexus/core';

import { findModelEntry } from './model-catalog.js';
import type { ModelEntry } from './model-catalog.js';
import { SUPPORTED_EFFORTS } from './subagent-model-selection.js';

/** 一顆條目宣告過的推理等級名。 */
function declaredEfforts(entry: ModelEntry): string[] {
  const efforts = entry.reasoningEfforts;
  return efforts === undefined || efforts === false ? [] : Object.keys(efforts);
}

/**
 * 造註冊時用的驗證函式。
 *
 * @param catalog - 型錄；省略＝這份組裝沒有型錄。
 * @returns 不合就拋，訊息講給寫 plugin 的人聽（註冊點會再補上註冊者）。
 */
export function subagentDefinitionValidator(
  catalog: readonly ModelEntry[] | undefined,
): (subagent: NexusSubAgent) => void {
  return (subagent) => {
    const { model, reasoningEffort } = subagent;
    if (typeof model === 'string') {
      if (catalog === undefined) {
        throw new Error(
          `model "${model}" 要對型錄解析，這份組裝沒有型錄（沒連真實供應商）；給模型實例，或拿掉 model`,
        );
      }
      if (findModelEntry(catalog, model) === undefined) {
        throw new Error(
          `model "${model}" 不在型錄裡（有：${catalog.map((entry) => entry.id).join('、')}）`,
        );
      }
    }
    if (reasoningEffort === undefined) return;
    if (model !== undefined && typeof model !== 'string') {
      throw new Error('reasoningEffort 只能配型錄 id 的 model；給了模型實例時，強度要設在實例上');
    }
    if (catalog === undefined) {
      throw new Error(`reasoningEffort "${reasoningEffort}" 要對型錄解析，這份組裝沒有型錄`);
    }
    if (reasoningEffort === '') throw new Error('reasoningEffort 不能是空字串');
    if (reasoningEffort === 'default') return;
    if (!SUPPORTED_EFFORTS.includes(reasoningEffort)) {
      throw new Error(
        `reasoningEffort "${reasoningEffort}" 還不支援（目前只支援：${SUPPORTED_EFFORTS.join('、')}）`,
      );
    }
    // 配了 model 就查那一顆；沒配（＝父代理當下那顆，註冊時還不知道是哪顆）就要求型錄裡至少有一顆宣告了它。
    if (typeof model === 'string') {
      const entry = findModelEntry(catalog, model)!;
      if (!declaredEfforts(entry).includes(reasoningEffort)) {
        throw new Error(
          `model "${model}" 沒有推理等級 "${reasoningEffort}"（宣告過的：${declaredEfforts(entry).join('、') || '沒有'}）`,
        );
      }
    } else if (!catalog.some((entry) => declaredEfforts(entry).includes(reasoningEffort))) {
      throw new Error(`型錄裡沒有任何一顆模型宣告了推理等級 "${reasoningEffort}"`);
    }
  };
}
