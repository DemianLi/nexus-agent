/**
 * 一次模型呼叫走的**路由**：哪一顆模型、帶什麼推理強度（[#723](https://github.com/DemianLi/nexus-agent/issues/723)）。
 *
 * 照 dsh `ModelSelection`（`packages/core/agent/src/model-selection.ts:21-28`，`5badb15`）的 `{ provider, model, reasoningEffort? }`，
 * **去掉 `provider`**：我們整個部署只有一個端點，路由就是型錄 id（理由同 `apps/harness/src/subagent-model-selection.ts` 的偏離一）。
 * 哪天有第二個端點，加一格選填的 `provider` 是向後相容的。
 *
 * ## 實例上的標記
 *
 * 路由要寫進 `model/start`（dsh 的 `requestHeader().config`：換模型通知與續接都拿「最近一次請求實際走的」來比），而寫的人
 * （`model-calls.ts`）手上只有 `request.model`。所以建模型實例的一端用 {@link tagModelRoute} 在實例上貼一張標籤，
 * 讀的一端用 {@link routeOfModel} 讀：**弱引用表，不改實例本身**，也不要求實例是哪個類別（測試的替身、`withConfig` 之前的本尊都行）。
 * 沒貼標籤的實例退回它自己報的名字（`ChatOpenAI` 的 `model`），再沒有就是沒有路由。
 *
 * @module
 */

/** 一次呼叫的路由。`effort` 沒有就是供應商／型錄的預設，**不寫 `'default'`**（見 {@link normalizeEffort}）。 */
export interface ModelRoute {
  readonly model: string;
  /** 推理強度（型錄宣告過的等級名，今天只有 `off`）。缺席＝預設行為。 */
  readonly effort?: string;
}

const TAGS = new WeakMap<object, ModelRoute>();

/**
 * 在模型實例上貼它的路由標籤。同一個實例貼第二次就覆蓋。
 *
 * @param model - 模型實例。
 * @param route - 這個實例走的路由。
 * @returns 同一個實例，方便串在建構式後面。
 */
export function tagModelRoute<T extends object>(model: T, route: ModelRoute): T {
  TAGS.set(model, normalizeRoute(route));
  return model;
}

/** 只看標籤：實例有沒有被明著貼過路由。沒貼過是 `undefined`（不退回它自己報的名字）。 */
export function taggedRouteOf(model: unknown): ModelRoute | undefined {
  return model !== null && typeof model === 'object' ? TAGS.get(model) : undefined;
}

/** 模型的名字：`ChatOpenAI` 叫 `model`，舊的叫 `modelName`。認不出就是 `undefined`。 */
export function modelNameOf(model: unknown): string | undefined {
  if (model === null || typeof model !== 'object') return undefined;
  const { model: name, modelName } = model as { model?: unknown; modelName?: unknown };
  if (typeof name === 'string') return name;
  return typeof modelName === 'string' ? modelName : undefined;
}

/**
 * 一個模型實例走的路由：先看標籤，沒有就退回它自己報的名字，再沒有是 `undefined`。
 *
 * @param model - `request.model` 之類的東西。
 */
export function routeOfModel(model: unknown): ModelRoute | undefined {
  if (model !== null && typeof model === 'object') {
    const tagged = TAGS.get(model);
    if (tagged !== undefined) return tagged;
  }
  const name = modelNameOf(model);
  return name === undefined ? undefined : { model: name };
}

/**
 * `'default'` 是「沒挑」的另一種寫法：它不加任何線上設定，等於缺席。**正規化掉**，這樣兩個等價的選擇比起來相等，
 * 日誌上也不會同時出現兩種寫法。
 */
export function normalizeEffort(effort: string | undefined): string | undefined {
  return effort === undefined || effort === '' || effort === 'default' ? undefined : effort;
}

/** 正規化一條路由（見 {@link normalizeEffort}）。 */
export function normalizeRoute(route: ModelRoute): ModelRoute {
  const effort = normalizeEffort(route.effort);
  return effort === undefined ? { model: route.model } : { model: route.model, effort };
}

/** 兩條路由是不是同一個模型。**只比模型，不比強度**：換通知只在模型變了才附（dsh `sameRoute`）。 */
export function sameModel(left: ModelRoute, right: ModelRoute): boolean {
  return left.model === right.model;
}

/** 兩條路由完全相同（模型與強度）。 */
export function sameRoute(left: ModelRoute, right: ModelRoute): boolean {
  return (
    left.model === right.model && normalizeEffort(left.effort) === normalizeEffort(right.effort)
  );
}
