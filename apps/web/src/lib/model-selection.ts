import type {
  ModelCatalog,
  ModelCatalogModel,
  ModelSelection,
  ModelSelectionState,
  WireProjection,
} from '@nexus/wire';

/**
 * 模型座背後的純邏輯（[#723](https://github.com/DemianLi/nexus-agent/issues/723)）：現在選的是哪一顆、`/model`
 * 那一行怎麼解、座位上寫什麼字。契約見 `packages/nexus-wire/src/model-selection.ts`。
 *
 * @module
 */

/** 客戶端自己攔的命令名；伺服器沒有 `/model`，這個名字只在模型座存在時才出現在 `/` 選單。 */
export const MODEL_COMMAND = 'model';

/** 推理強度的選擇列：沒宣告強度的模型沒有這一列。 */
export function reasoningOf(model: ModelCatalogModel) {
  const reasoning = model.reasoning;
  return reasoning !== undefined && reasoning.efforts.length > 0 ? reasoning : undefined;
}

/** 投影（key `model-selection`）的那份值，形狀不對就當沒收到。 */
export function parseSelectionProjection(
  projection: WireProjection | undefined,
): ModelSelectionState | undefined {
  const view: unknown = projection?.view;
  if (typeof view !== 'object' || view === null) return undefined;
  const record = view as Record<string, unknown>;
  const lastUsed = parseSelection(record.lastUsed);
  const next = parseSelection(record.next);
  if (lastUsed === undefined || next === undefined) return undefined;
  return { lastUsed, next };
}

function parseSelection(value: unknown): ModelSelection | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'object' || value === undefined) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.modelId !== 'string' || record.modelId === '') return undefined;
  return typeof record.reasoningEffort === 'string'
    ? { modelId: record.modelId, reasoningEffort: record.reasoningEffort }
    : { modelId: record.modelId };
}

/**
 * 現在生效的選擇：伺服器推來的（投影，多分頁同步）＞ 這個分頁剛選的（還沒等到推送）＞ 讀型錄時回的 `next` ＞ `lastUsed`
 * ＞ 部署預設。**型錄上沒有的模型 id 一律跳過**（型錄換了、選擇還指著舊的），退到下一個。
 */
export function effectiveSelection(
  catalog: ModelCatalog,
  candidates: readonly (ModelSelection | null | undefined)[],
): ModelSelection {
  const known = new Set(catalog.models.map((model) => model.id));
  for (const candidate of [...candidates, catalog.default]) {
    if (candidate !== null && candidate !== undefined && known.has(candidate.modelId)) {
      return candidate;
    }
  }
  return catalog.default;
}

export function findModel(catalog: ModelCatalog, id: string): ModelCatalogModel | undefined {
  return catalog.models.find((model) => model.id === id);
}

/** 該模型這次實際用的強度 id：選擇帶的（要是它宣告的）＞ 模型的預設等級；沒有強度資訊就是 `undefined`。 */
export function effortOf(model: ModelCatalogModel, selection: ModelSelection): string | undefined {
  const reasoning = reasoningOf(model);
  if (reasoning === undefined) return undefined;
  const wanted = selection.reasoningEffort;
  if (wanted !== undefined && reasoning.efforts.some((effort) => effort.id === wanted)) {
    return wanted;
  }
  return reasoning.defaultEffort;
}

/** 座位上寫的字：模型名，加上強度名（有的話）。 */
export function seatText(catalog: ModelCatalog, selection: ModelSelection): string {
  const model = findModel(catalog, selection.modelId);
  if (model === undefined) return selection.modelId;
  const effort = effortOf(model, selection);
  const effortName = reasoningOf(model)?.efforts.find((item) => item.id === effort)?.name;
  return effortName === undefined ? model.name : `${model.name} · ${effortName}`;
}

/** 選一顆新模型時帶的強度：沿用目前的強度（新模型也宣告了它才算），否則不帶，讓伺服器套預設。 */
export function selectionForModel(
  model: ModelCatalogModel,
  current: ModelSelection,
): ModelSelection {
  const kept = current.reasoningEffort;
  const reasoning = reasoningOf(model);
  if (kept !== undefined && reasoning?.efforts.some((effort) => effort.id === kept) === true) {
    return { modelId: model.id, reasoningEffort: kept };
  }
  return { modelId: model.id };
}

export type ModelLine =
  | { readonly kind: 'open' }
  | { readonly kind: 'pick'; readonly selection: ModelSelection }
  | { readonly kind: 'unknown'; readonly query: string };

/**
 * 解 `/model` 那一行。不是 `/model` 開頭回 `undefined`（交給一般的斜線流程）。
 *
 * - 光打 `/model`：打開模型座。
 * - `/model <模型> [強度]`：模型先比 id（不分大小寫）、再比名字、最後比唯一的前綴；強度比 id 或名字。找不到模型或強度
 *   就是 `unknown`，呼叫端說出來，不送出。
 */
export function parseModelLine(
  line: string,
  catalog: ModelCatalog,
  current: ModelSelection,
): ModelLine | undefined {
  const match = /^\s*\/model(?:\s+(.*))?$/s.exec(line);
  if (match === null) return undefined;
  const rest = (match[1] ?? '').trim();
  if (rest === '') return { kind: 'open' };
  const [query = '', effortQuery] = rest.split(/\s+/, 2);
  const model = matchModel(catalog.models, query);
  if (model === undefined) return { kind: 'unknown', query };
  const base = selectionForModel(model, current);
  if (effortQuery === undefined) return { kind: 'pick', selection: base };
  const wanted = effortQuery.toLowerCase();
  const effort = reasoningOf(model)?.efforts.find(
    (item) => item.id.toLowerCase() === wanted || item.name.toLowerCase() === wanted,
  );
  if (effort === undefined) return { kind: 'unknown', query: effortQuery };
  return { kind: 'pick', selection: { modelId: model.id, reasoningEffort: effort.id } };
}

function matchModel(
  models: readonly ModelCatalogModel[],
  query: string,
): ModelCatalogModel | undefined {
  const wanted = query.toLowerCase();
  const exact =
    models.find((model) => model.id.toLowerCase() === wanted) ??
    models.find((model) => model.name.toLowerCase() === wanted);
  if (exact !== undefined) return exact;
  const prefixed = models.filter(
    (model) =>
      model.id.toLowerCase().startsWith(wanted) || model.name.toLowerCase().startsWith(wanted),
  );
  return prefixed.length === 1 ? prefixed[0] : undefined;
}
