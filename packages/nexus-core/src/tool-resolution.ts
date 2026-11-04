/**
 * 這一步模型看得到哪些工具、看到的定義長什麼樣（[#2415](https://github.com/DemianLi/nexus-agent/issues/2415)）。
 *
 * 兩種決定，都不帶 LangChain 型別（agent loop 脫離 LangChain，[#2336](https://github.com/DemianLi/nexus-agent/issues/2336)）：
 *
 * - {@link ToolAdmission}：放不放行某個名字。模型那一側的清單拿掉不放行的；呼叫那一側要不要拒絕，由套用的那一格決定
 *   （`subagent-tool-filter.ts` 拒絕；`@nexus/plugin-mcp` 放棄重連後只藏不拒）。
 * - {@link ToolOverride}：換掉某個工具在模型那一側的定義（參數說明、預設值），執行時找的仍是原本那個工具。
 *
 * `subagent-tool-filter.ts`、`read-continuation.ts`、`search-descriptions.ts`、`@nexus/plugin-mcp` 的 `mcp-tools-guard:<server>` 在自己的 `wrapModelCall`（`subagent-tool-filter.ts` 另在 `wrapToolCall` 拒絕）裡用這兩個
 * 函式套自己那一份決定；套的先後就是洋蔥的先後。
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
    changed = true;
    return replaced;
  });
  return changed ? next : tools;
}
