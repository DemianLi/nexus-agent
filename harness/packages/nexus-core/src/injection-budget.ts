/**
 * **注入源的分項預算表**（[#2777](https://github.com/DemianLi/nexus-agent/issues/2777)）。
 *
 * 對話與工具結果以外、需要上限的注入源各有一列：它屬於哪一類、最多能放幾個位元組。表上沒有的源（系統提示其餘的中段）
 * 照樣量位元組，只是沒有上限。靠摘要壓不住這些來源的大小：系統提示上的摘要碰不到，訊息串裡的工作區指示被切掉之後會再放一則。
 * 所以它們各自有上限，彼此不共用。
 *
 * 這裡只有表與算法，是純函式，窗口由呼叫端給。量在 `injection-sources.ts`。執行在各源自己那裡：
 * 可延後的源放不下時整項不放、留一行指標（`base-prompt-text.ts` 的兩個 `…Within`，與 agent-instructions、skill-invocation 兩個插件）；
 * 必要的源超過時組裝或載入失敗（`harness/apps/harness` 的 `system-prompt-middleware.ts`、plan-mode 的設定）。插件不 import core，
 * 預設值與算法各抄一份，`harness/apps/harness/src/injection-budget-pins.test.ts` 把兩邊釘成相等。
 *
 * @module
 */

/** 估算一個 token 約幾個 UTF-8 位元組，同 `@` 會話引用的預算（`harness/apps/harness/src/session-reference-budget.ts`）。 */
export const INJECTION_BYTES_PER_TOKEN = 4;

/**
 * 源的類別：決定上限怎麼算、`context/measure` 的 `sources` 附不附 `limit`。
 *
 * - `required`：沒有它請求不成立，模型也沒有別的路讀到。上限不看窗口。
 * - `deferrable`：模型有別的路讀全（讀檔工具）。上限隨窗口縮小。
 * - `per-server`：每台 MCP server 各一個上限，由 MCP 插件用它自己的設定值執行；`sources` 不附 `limit`。
 */
export type InjectionSourceKind = 'required' | 'deferrable' | 'per-server';

/** 表上的一列。 */
export interface InjectionSourceBudget {
  readonly kind: InjectionSourceKind;
  /** 絕對上限，UTF-8 位元組。 */
  readonly maxBytes: number;
  /** 佔模型窗口的比例；只有 `deferrable` 有。 */
  readonly contextFraction?: number;
}

/** 預算表。鍵是源的識別，也是 `context/measure` 的 `sources[].id`；中段的源用段名（`plan:policy`、`mcp:servers`）。 */
export const INJECTION_SOURCE_BUDGETS = {
  'agent-instructions': { kind: 'deferrable', maxBytes: 65_536, contextFraction: 0.1 },
  'skill-catalog': { kind: 'deferrable', maxBytes: 32_768, contextFraction: 0.05 },
  'skill-invocation': { kind: 'deferrable', maxBytes: 65_536, contextFraction: 0.1 },
  memory: { kind: 'deferrable', maxBytes: 32_768, contextFraction: 0.05 },
  'system-prompt-prefix': { kind: 'required', maxBytes: 16_384 },
  'system-prompt-suffix': { kind: 'required', maxBytes: 16_384 },
  'plan:policy': { kind: 'required', maxBytes: 16_384 },
  'mcp:servers': { kind: 'per-server', maxBytes: 32_768 },
} as const satisfies Record<string, InjectionSourceBudget>;

/** 表上有的源。 */
export type InjectionSourceId = keyof typeof INJECTION_SOURCE_BUDGETS;

/**
 * 一個源在某個窗口下的上限。
 *
 * @param source - 表上的源。
 * @param contextWindow - 這次請求要走的模型的窗口（token）；取不到就不給；不是正的有限數也一樣，用絕對上限。
 * @returns UTF-8 位元組數。`deferrable` 是 `min(絕對上限, floor(窗口 × 4 × 比例))`，其餘是絕對上限。
 */
export function injectionLimitFor(source: InjectionSourceId, contextWindow?: number): number {
  const budget: InjectionSourceBudget = INJECTION_SOURCE_BUDGETS[source];
  if (budget.contextFraction === undefined || contextWindow === undefined) return budget.maxBytes;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return budget.maxBytes;
  return Math.min(
    budget.maxBytes,
    Math.floor(contextWindow * INJECTION_BYTES_PER_TOKEN * budget.contextFraction),
  );
}
