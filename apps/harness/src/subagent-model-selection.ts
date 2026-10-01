/**
 * 模型逐次替子代理挑模型的**解析與探索**（[#877](https://github.com/DemianLi/nexus-agent/issues/877)，卡
 * [#709](https://github.com/DemianLi/nexus-agent/issues/709)）：純函式，不碰工具、不碰 host。
 *
 * 照 dsh `tool-subagent/src/model-selection.ts` 與 `list-models.ts`（`477b4f4`）：
 *
 * - **都沒給＝繼承**，不查政策（dsh 的 `hasDelegationModelRequest` 先擋掉）。
 * - **只要給了任何一格，有效路由就必須在授權清單裡**——包括只給 `reasoning_effort` 的時候（有效路由是 root 那顆）：dsh 的
 *   `assertAllowedModelSelection` 用的是「有效路由」，不是「有沒有給 model」。
 * - **換了路由卻沒給推理等級＝用新模型的預設**；給了就必須是那顆型錄條目宣告過的名字。
 *
 * ## 與 dsh 的偏離（照 AGENTS.md 登記）
 *
 * - **沒有 `provider`**：我們只有一個端點，路由就是型錄 id。
 * - **推理等級只實作 `off` 與 `default`**：dsh 的等級由 adapter 驗證、請求怎麼帶也是 adapter 的事；我們的 adapter 只有型錄宣告，
 *   而且只有 `off` 有量過的線上寫法（`thinkingOffBody`）。型錄就算宣告了別的名字，也先拒絕，不猜。`default` 不加任何東西，
 *   所以等於沒給（解析時就丟掉，讓圖快取鍵不因為「寫了 default」多出一張一樣的圖）。
 * - **`list_subagent_models` 兩層**：無參數列授權清單；帶 `model` 看那顆的推理等級（dsh 是 provider／model 三層）。
 *
 * @module
 */

import type { ModelChoice } from './background-subagents.js';
import { findModelEntry } from './model-catalog.js';
import type { ModelEntry } from './model-catalog.js';

/** 這個會話的選模型設定：授權清單、root 的模型、型錄。 */
export interface ModelSelectionConfig {
  /** 授權清單（型錄 id），來自日誌上記著的政策（#875）。 */
  readonly allowedModels: readonly string[];
  /** root 用的那顆（型錄 id）：只給 `reasoning_effort` 時就是它。 */
  readonly rootModelId: string;
  /** 型錄（`live-model` 的 `models`）。 */
  readonly catalog: readonly ModelEntry[];
}

/** 模型在 `subagent` 工具上填的兩格。 */
export interface ModelSelectionRequest {
  readonly model?: string;
  readonly reasoning_effort?: string;
}

/** 今天實作的推理等級，見檔頭。 */
export const SUPPORTED_EFFORTS: readonly string[] = ['off', 'default'];

export type ModelSelectionOutcome =
  | { readonly ok: true; readonly choice: ModelChoice | undefined }
  | { readonly ok: false; readonly error: string };

/** 一顆條目宣告過的推理等級名（沒宣告或這顆不推理是空的）。 */
function declaredEfforts(entry: ModelEntry): string[] {
  const efforts = entry.reasoningEfforts;
  return efforts === undefined || efforts === false ? [] : Object.keys(efforts);
}

/** 授權清單講給模型聽。 */
function allowedList(config: ModelSelectionConfig): string {
  return config.allowedModels.map((id) => `"${id}"`).join('、');
}

/**
 * 把模型填的兩格解成要交給 host 的選擇。
 *
 * @returns `choice` 是 `undefined`＝沿用 root 的（都沒給、或解出來等於 root 的預設）；失敗的 `error` 是講給模型聽的，
 *   讓它能自己改正（含授權清單）。
 */
export function resolveModelSelection(
  config: ModelSelectionConfig,
  request: ModelSelectionRequest,
): ModelSelectionOutcome {
  const { model, reasoning_effort: effort } = request;
  if (model === undefined && effort === undefined) return { ok: true, choice: undefined };
  if (model === '') return { ok: false, error: '`model` 不能是空字串' };
  if (effort === '') return { ok: false, error: '`reasoning_effort` 不能是空字串' };

  const effective = model ?? config.rootModelId;
  if (!config.allowedModels.includes(effective)) {
    return {
      ok: false,
      error:
        `模型 "${effective}" 不在這個會話授權的清單裡（可選：${allowedList(config)}）；` +
        '用 list_subagent_models 看有哪些',
    };
  }
  const entry = findModelEntry(config.catalog, effective);
  if (entry === undefined) {
    return { ok: false, error: `型錄裡沒有模型 "${effective}"，不能指定給子代理` };
  }

  let resolvedEffort: string | undefined;
  if (effort !== undefined) {
    const declared = declaredEfforts(entry);
    if (declared.length === 0) {
      return {
        ok: false,
        error: `模型 "${effective}" 沒有宣告可選的推理等級，不能指定 reasoning_effort`,
      };
    }
    if (!declared.includes(effort)) {
      return {
        ok: false,
        error: `模型 "${effective}" 沒有推理等級 "${effort}"（宣告過的：${declared.join('、')}）`,
      };
    }
    if (!SUPPORTED_EFFORTS.includes(effort)) {
      return {
        ok: false,
        error: `推理等級 "${effort}" 還不支援（目前只支援：${SUPPORTED_EFFORTS.join('、')}）`,
      };
    }
    // `default` 不加任何東西，等於沒給。
    if (effort !== 'default') resolvedEffort = effort;
  }

  // 解出來就是 root 的那顆、沒有額外推理設定：等於繼承，不為它另建一個實例。
  if (effective === config.rootModelId && resolvedEffort === undefined) {
    return { ok: true, choice: undefined };
  }
  return {
    ok: true,
    choice: { model: effective, ...(resolvedEffort !== undefined && { effort: resolvedEffort }) },
  };
}

/**
 * `list_subagent_models` 的輸出：無參數列授權清單；帶 `model` 看那顆的推理等級（只列今天支援的）。
 * 授權在前：不在清單裡的 id 一律拒絕，不透露型錄裡有沒有它（dsh 的 “authorizes the exact route before resolving”）。
 *
 * @throws 帶的 `model` 不在授權清單裡（訊息講給模型聽）。
 */
export function describeSubagentModels(
  config: ModelSelectionConfig,
  request: { readonly model?: string },
): string {
  if (request.model === undefined) {
    return config.allowedModels
      .map((id) => (id === config.rootModelId ? `${id}（主對話目前用的）` : id))
      .join('\n');
  }
  if (request.model === '') throw new Error('`model` 不能是空字串');
  if (!config.allowedModels.includes(request.model)) {
    throw new Error(
      `模型 "${request.model}" 不在這個會話授權的清單裡（可選：${allowedList(config)}）`,
    );
  }
  const entry = findModelEntry(config.catalog, request.model);
  const efforts = (entry === undefined ? [] : declaredEfforts(entry)).filter((name) =>
    SUPPORTED_EFFORTS.includes(name),
  );
  return (
    `${request.model}\nReasoning efforts:\n` +
    (efforts.length === 0 ? '(no advertised reasoning efforts)' : efforts.join('\n'))
  );
}
