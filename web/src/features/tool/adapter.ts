/**
 * 「一種畫法」的契約：工具卡的呈現類別（`data-variant` 的值）與每一類各自知道的事。
 * 實作在 `features/tool/adapters.ts`，哪顆工具用哪一類在 `features/tool/tools.ts` 那張表上；
 * 其他檔（`view.ts`、`step.ts`、`card.tsx`）只問 adapter，不按工具名分支。
 *
 * @module
 */

import type { ToolEntry } from '@nexus/wire';

import type { ReadCard, SearchCard } from '@/features/tool/result-card';
import type { ToolDiffView } from '@/shared/lib/tool-diff';

/** 工具卡的呈現類別。 */
export type ToolVariant = 'search' | 'read' | 'bash' | 'write' | 'edit' | 'code' | 'others';

/** 這一類專屬的結果檢視；沒有就走通用的結果文字。`kind` 決定 `card.tsx` 用哪個元件畫（diff 交給 SG 的 `step.patch`）。 */
export type ToolResultView =
  | { readonly kind: 'read'; readonly card: ReadCard }
  | { readonly kind: 'search'; readonly card: SearchCard }
  | { readonly kind: 'diff'; readonly view: ToolDiffView };

/** 結果檢視要看的欄位。 */
export type ToolResultEntry = Pick<ToolEntry, 'name' | 'status' | 'input' | 'meta'>;

export interface ToolAdapter {
  readonly variant: ToolVariant;
  /** 這一類的通用標題；表上有專屬標題的工具以它為準。 */
  readonly title: string;
  /** 摘要從參數挑哪幾個欄位，依序取第一個非空字串。 */
  readonly summaryKeys: readonly string[];
  /** 展開的參數；沒給或回 `undefined` 就是排好的 JSON。 */
  inputBody?(
    args: Readonly<Record<string, unknown>>,
  ): { readonly text: string; readonly lang: string } | undefined;
  /** 這一類專屬的結果檢視；沒有就走通用的結果文字。 */
  result?(entry: ToolResultEntry): ToolResultView | undefined;
}
