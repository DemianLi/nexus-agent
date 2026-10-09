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

/**
 * 一次委派的**基線**（[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 3 項）：沒有模型自己的要求時這個子代理會走哪條路由。
 *
 * 照 dsh `requestedAgentOptions`（`tool-subagent/src/model-selection.ts:99-128`，`5badb15`）的合併，**越後面越近**：
 * 父代理當下的選擇 → 定義釘的（`pin`，dsh 的 `agentOptions`）→ 模型這次要求的（`request`）。
 */
export interface DelegationBaseline {
  /** 父代理**此刻**的路由（#723 的選擇，沒選過是最近一次請求走的，再沒有是部署預設）。 */
  readonly parent: { readonly model: string; readonly effort?: string };
  /** 部署預設的模型 id：解出來就是它、又沒有額外推理設定時，等於沿用預設實例，不另建。 */
  readonly defaultModelId: string;
  /** 定義釘的兩格（`NexusSubAgent.model`／`reasoningEffort`）；沒有定義釘東西就省略。 */
  readonly pin?: { readonly model?: string; readonly reasoningEffort?: string };
}

/**
 * 沒有模型要求時的有效路由；有要求時疊上去。**純函式，合併順序就是 dsh 的**：
 *
 * - 基線模型＝定義釘的 ?? 父代理當下的。
 * - 基線強度＝定義釘的；沒釘強度、而基線模型就是父代理的那顆，沿用父代理的強度（dsh：子代理沿用父代理「相容的」欄位）；其餘用新模型的預設。
 * - 要求給了模型且**換了路由**、又沒給強度：定義釘的強度丟掉（dsh 的 `routeChanged && 沒給強度`），用新模型的預設。
 * - 要求給了強度：蓋過一切。`default` 是明著要預設，不是沒給。
 */
export function effectiveRoute(
  baseline: DelegationBaseline,
  request: ModelSelectionRequest,
): { readonly model: string; readonly effort?: string } {
  const pinModel = baseline.pin?.model;
  const baselineModel = pinModel ?? baseline.parent.model;
  const inheritsParentEffort = pinModel === undefined || pinModel === baseline.parent.model;
  const baselineEffort =
    baseline.pin?.reasoningEffort ?? (inheritsParentEffort ? baseline.parent.effort : undefined);
  const model = request.model ?? baselineModel;
  const routeChanged = request.model !== undefined && request.model !== baselineModel;
  const effort =
    request.reasoning_effort !== undefined
      ? request.reasoning_effort
      : routeChanged
        ? undefined
        : baselineEffort;
  return { model, ...(effort !== undefined && effort !== 'default' && { effort }) };
}

/** 路由是不是部署預設那顆、又沒有額外推理設定（是＝沿用預設實例）。 */
function isDefaultRoute(
  route: { readonly model: string; readonly effort?: string },
  baseline: DelegationBaseline,
): boolean {
  return route.model === baseline.defaultModelId && route.effort === undefined;
}

/**
 * 模型沒有要求（沒開選模型、或這次沒給）時，這個子代理要用的選擇：定義釘的，沒釘就是父代理**此刻**的。
 * 背景子代理在委派那一刻取這一次、之後固定（照 dsh：子代理建立時取父代理當下的選擇）。
 *
 * @returns `undefined`＝沿用預設實例。
 */
export function baselineChoice(baseline: DelegationBaseline): ModelChoice | undefined {
  const route = effectiveRoute(baseline, {});
  return isDefaultRoute(route, baseline)
    ? undefined
    : { model: route.model, ...(route.effort !== undefined && { effort: route.effort }) };
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
  /** 省略＝沒有定義釘的、父代理就是部署預設（#877 當時的形狀）。 */
  baseline: DelegationBaseline = {
    parent: { model: config.rootModelId },
    defaultModelId: config.rootModelId,
  },
): ModelSelectionOutcome {
  const { model, reasoning_effort: effort } = request;
  // 都沒給＝不查政策（dsh `hasDelegationModelRequest` 先擋掉）：走基線，定義釘的與父代理當下的都不受清單管。
  if (model === undefined && effort === undefined) {
    return { ok: true, choice: baselineChoice(baseline) };
  }
  if (model === '') return { ok: false, error: '`model` 不能是空字串' };
  if (effort === '') return { ok: false, error: '`reasoning_effort` 不能是空字串' };

  // 有效路由：定義釘的 ?? 父代理當下的，疊上模型這次要的。**政策查的是它**（dsh `assertAllowedModelSelection`：只給強度時，
  // 有效模型是定義釘的或父代理的那顆，也要在清單裡）。
  const route = effectiveRoute(baseline, request);
  const effective = route.model;
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

  // 模型這次給了強度＝驗過的那個（`default` 解成沒有）；沒給＝有效路由上合併出來的（定義釘的或父代理沿用的）。
  const finalEffort = effort !== undefined ? resolvedEffort : route.effort;
  // 解出來就是部署預設那顆、沒有額外推理設定：等於沿用預設實例，不為它另建一個。
  if (effective === baseline.defaultModelId && finalEffort === undefined) {
    return { ok: true, choice: undefined };
  }
  return {
    ok: true,
    choice: { model: effective, ...(finalEffort !== undefined && { effort: finalEffort }) },
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
