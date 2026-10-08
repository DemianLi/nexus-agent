/**
 * 每會話模型選擇上線的形狀（[#723](https://github.com/DemianLi/nexus-agent/issues/723)）。
 *
 * **這一份只是契約**：型別、method 名字、client 方法。server 端還沒實作，兩支 method 一律回 `not_supported`，
 * web 據那個碼把模型座藏起來；實作落地時這裡的形狀盡量不動（真的要改，改 wire 的 PR 帶著 web 一起改）。
 *
 * 照 dsh 的 `session-controller`（`packages/api/session-controller/src/types.ts` 的 `ModelCatalog`、`ModelSelection`、
 * `ModelSelectionProjection`、`SessionSelectModelRequest`／`Value`，`5badb150`）：
 *
 * - **型錄**（`model.catalog`）：每顆模型帶 `id`、`name`、選填的 `description`，以及選填的推理資訊——可選的等級
 *   （`id`／`name`／`description?`）與預設等級。**沒有推理資訊的模型不顯示強度列**，不能由 client 自己輸入任意強度
 *   （dsh `ui-model-selection` 的已知限制）。
 * - **目前的選擇**（同一支 `model.catalog` 一併回）：dsh 的 `modelSelection` 投影是 `{ lastUsed, next }`——`lastUsed` 是
 *   最近一次請求實際用的，`next` 是下一個請求會用的（沒有待生效的選擇就等於 `lastUsed`）。**選擇從下一步生效，跑著的那步
 *   不換**，所以兩者可以不同。
 * - **選擇**（`model.select`）：收一對完整的選擇，型錄裡沒有那顆、或帶了那顆沒宣告的強度，就拒，選擇不變
 *   （dsh `session/model-unavailable`）。
 *
 * ## 與 dsh 的偏離
 *
 * 1. **沒有 provider**：dsh 的選擇是 `{ provider, model, reasoningEffort? }`、型錄依 provider 分組。我們的型錄是設定裡的一份
 *    清單（#729），整個部署只有一個端點，所以攤平成 `models`、選擇只收 `modelId`。哪天有第二個端點，加一格選填的
 *    `provider` 是向後相容的。
 * 2. **method 掛在 thread 底下**（`/threads/:id/commands/:method`），型錄那一半是整台共用的、與 thread 無關，但跟其他讀取
 *    （`feedback.list` 之類）一樣帶著 thread，web 打開一條 thread 才有模型座。
 * 3. **還沒有推送**：dsh 的投影會在選擇改變時推給所有分頁。這一版只有 RPC 讀與 `model.select` 的回應；要多分頁即時同步時再加
 *    一顆 `custom` frame（向後相容）。
 *
 * 回應都是 `{ ok: true, value }`／`{ ok: false, error: { code } }`，業務失敗走成功回應，`ErrorResponse` 只給「這條線收不了」
 * （含 `not_supported`），同回饋那四支（{@link FEEDBACK_METHODS}）。
 *
 * @module
 */

/** 這個檔定義的兩支 method。 */
export const MODEL_METHODS = ['model.catalog', 'model.select'] as const;

export type ModelMethod = (typeof MODEL_METHODS)[number];

export function isModelMethod(value: unknown): value is ModelMethod {
  return typeof value === 'string' && (MODEL_METHODS as readonly string[]).includes(value);
}

/** 一個完整的選擇：模型 id，加上選填的推理強度（型錄上那顆宣告過的等級 id）。 */
export interface ModelSelection {
  readonly modelId: string;
  readonly reasoningEffort?: string;
}

/** 型錄上一個可選的推理等級。 */
export interface ModelReasoningEffort {
  /** 送回 {@link ModelSelection.reasoningEffort} 的值。 */
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

/** 一顆模型的推理資訊。沒有這一格的模型不顯示強度列。 */
export interface ModelReasoning {
  readonly efforts: readonly ModelReasoningEffort[];
  /** 選了這顆模型但沒挑強度時套用的等級。 */
  readonly defaultEffort?: string;
}

/** 型錄上的一顆模型。 */
export interface ModelCatalogModel {
  readonly id: string;
  /** 畫面上的名字。 */
  readonly name: string;
  readonly description?: string;
  readonly reasoning?: ModelReasoning;
}

/** 這個部署的模型型錄與沒選過的會話用的預設。 */
export interface ModelCatalog {
  /** 沒選過的會話用的選擇（部署預設）。 */
  readonly default: ModelSelection;
  /** 依型錄的宣告順序。 */
  readonly models: readonly ModelCatalogModel[];
}

/** 這條 thread 目前的選擇，同 dsh 的 `ModelSelectionProjection`。 */
export interface ModelSelectionState {
  /** 最近一次請求實際用的；還沒送過請求就是 `null`。 */
  readonly lastUsed: ModelSelection | null;
  /** 下一個請求會用的；沒有待生效的選擇就等於 `lastUsed`，兩者都沒有就是 `null`（用 {@link ModelCatalog.default}）。 */
  readonly next: ModelSelection | null;
}

export interface ModelCatalogCommand {
  readonly id: number;
  readonly method: 'model.catalog';
  readonly params: Record<string, never>;
}

export interface ModelSelectCommand {
  readonly id: number;
  readonly method: 'model.select';
  readonly params: ModelSelection;
}

export type ModelCommand = ModelCatalogCommand | ModelSelectCommand;

export type ModelCatalogResult = {
  readonly ok: true;
  readonly value: { readonly catalog: ModelCatalog; readonly selection: ModelSelectionState };
};

/** 選不上的原因只有一種：型錄沒有那顆，或那顆沒宣告帶來的強度（dsh 也併成一個碼）。 */
export type ModelUnavailable = { readonly code: 'model_unavailable'; readonly modelId: string };

export type ModelSelectResult =
  | { readonly ok: true; readonly value: { readonly selected: ModelSelection } }
  | { readonly ok: false; readonly error: ModelUnavailable };
