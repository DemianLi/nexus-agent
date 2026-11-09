/**
 * 這一步模型看得到哪些工具、看到的定義長什麼樣（[#2415](https://github.com/DemianLi/nexus-agent/issues/2415)）。
 *
 * 三種決定，都不帶 LangChain 型別（agent loop 脫離 LangChain，[#2336](https://github.com/DemianLi/nexus-agent/issues/2336)）：
 *
 * - {@link ToolAdmission}：放不放行某個名字。模型那一側的清單拿掉不放行的；呼叫那一側要不要拒絕，由套用的那一格決定
 *   （`subagent-tool-filter.ts` 拒絕；`@nexus/plugin-mcp` 放棄重連後只藏不拒）。
 * - {@link ToolOverride}：換掉某個工具在模型那一側的定義（參數說明、預設值），執行時找的仍是原本那個工具；要拿到那顆實例用 {@link originalToolOf}。
 * - {@link ToolAddition}：在清單尾端接上這一步才有的工具（harness 的 `host-tools.ts`、`background-delegation.ts`）。
 *
 * 各顆在自己的 `wrapModelCall` 裡用 {@link admittedTools}、{@link overriddenTools}、{@link addedTools} 套自己那一份決定
 * （`subagent-tool-filter.ts` 另在 `wrapToolCall` 拒絕）；套的先後就是洋蔥的先後。
 *
 * @module
 */

/** 放不放行某個工具名。 */
export interface ToolAdmission {
  /**
   * @param name - 工具名。
   * @returns 放行是 `true`。
   */
  admits(name: string): boolean;
}

/** 換掉某個工具在模型那一側的定義。 */
export interface ToolOverride {
  /**
   * @param tool - 清單上的那一筆：工具實例，或前一層換過的定義。
   * @param name - 它的名字。
   * @returns 換上的定義；不換是 `undefined`。
   */
  override(tool: object, name: string): object | undefined;
}

/** 接在清單尾端的工具。 */
export interface ToolAddition {
  /** @returns 這一步要接在尾端的那幾筆；沒有就是空陣列。 */
  additions(): readonly unknown[];
}

/** 經 {@link overriddenTools} 換上的定義 → 最初那顆工具（換過幾層都指到最初那顆）。 */
const origins = new WeakMap<object, object>();

/** 清單上一筆的名字；不是物件或沒有字串名字是 `undefined`。 */
export function toolNameOf(tool: unknown): string | undefined {
  if (typeof tool !== 'object' || tool === null) return undefined;
  const name = (tool as { readonly name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

/**
 * 拿掉不放行的。認不出名字的那一筆留著。
 *
 * @param tools - 這一格收到的清單。
 * @param admission - 這一格的決定。
 * @returns 新的清單。
 */
export function admittedTools(
  tools: readonly unknown[],
  admission: ToolAdmission,
): readonly unknown[] {
  return tools.filter((tool) => {
    const name = toolNameOf(tool);
    return name === undefined || admission.admits(name);
  });
}

/**
 * 換上覆寫的定義。一筆都不換時回原本那份清單。
 *
 * @param tools - 這一格收到的清單。
 * @param override - 這一格的覆寫。
 * @returns 換過的清單，或原本那份。
 */
export function overriddenTools(
  tools: readonly unknown[],
  override: ToolOverride,
): readonly unknown[] {
  let changed = false;
  const next = tools.map((tool) => {
    const name = toolNameOf(tool);
    if (name === undefined) return tool;
    const replaced = override.override(tool as object, name);
    if (replaced === undefined) return tool;
    if (replaced !== tool) origins.set(replaced, origins.get(tool as object) ?? (tool as object));
    changed = true;
    return replaced;
  });
  return changed ? next : tools;
}

/**
 * 在尾端接上要加的。一筆都不加時回原本那份清單。
 *
 * @param tools - 這一格收到的清單。
 * @param addition - 這一格要加的。
 * @returns 接過的清單，或原本那份。
 */
export function addedTools(tools: readonly unknown[], addition: ToolAddition): readonly unknown[] {
  const extra = addition.additions();
  return extra.length === 0 ? tools : [...tools, ...extra];
}

/**
 * 清單上那一筆頂替的工具：{@link overriddenTools} 換上的定義回它換掉的那顆（換過幾層都回最初那顆），其餘原樣。
 *
 * @param tool - 清單上的那一筆。
 * @returns 執行要找的那顆。
 */
export function originalToolOf(tool: unknown): unknown {
  return typeof tool === 'object' && tool !== null ? (origins.get(tool) ?? tool) : tool;
}

/**
 * 清單上那一筆給模型看的描述：工具的 `description`，或 OpenAI 形狀定義的 `function.description`。
 *
 * @param tool - 清單上的那一筆。
 * @returns 描述；兩處都不是字串是 `undefined`。
 */
export function toolDescriptionOf(tool: unknown): string | undefined {
  if (typeof tool !== 'object' || tool === null) return undefined;
  const own = (tool as { readonly description?: unknown }).description;
  if (typeof own === 'string') return own;
  const nested = (tool as { readonly function?: { readonly description?: unknown } }).function
    ?.description;
  return typeof nested === 'string' ? nested : undefined;
}
