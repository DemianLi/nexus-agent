/**
 * 跨會話引用（`@` 別的會話）的**設定條目**（[#1573](https://github.com/DemianLi/nexus-agent/issues/1573) N0862）。
 * 行為見 `../session-reference.ts`（準備那一半）、`../session-reference-budget.ts`（預算）與
 * `../session-reference-candidates.ts`（候選）。
 *
 * 照 dsh 的 `session-reference` 那一列（`packages/context/session-reference/src/index.ts:90-95`，`1517a4db`、`687f282e`、`22ddee37`
 * 三版這一段逐字相同）：四個值、同名、同範圍。
 *
 * **這一顆不裝功能，只講設定**，`apply` 是空的，同 `thread-search` 那一列：值由 `startupSetting` 在起動期讀出來，交給
 * `serve.ts`（候選上限）與 `createWireHandler`（引用上限與預算）。理由與偏離見 `thread-title.ts` 的檔頭。
 *
 * ## 四個值，同 dsh
 *
 * - `maxReferences`：一則訊息最多引用幾條不同的會話，整數 1 到 {@link MAX_SESSION_REFERENCES}（3），預設 3。
 *   上限不能調高：dsh 一樣以 `MAX_REFERENCES` 為頂，web 端的提示與重編輯也只認三條。
 * - `candidateLimit`：`@` 後面候選最多回幾筆，正整數，預設 50。
 * - `maxReferenceBytes`：每條來源序列化後的位元組上限，正整數，**省略即照模型窗口算**；給了就**原樣蓋過**自動預算。
 * - `referenceContextFraction`：自動預算占模型窗口的幾成，0 到 1，預設 0.2。算法見 `session-reference-budget.ts`。
 *
 * ## 偏離 dsh（登記）
 *
 * 1. **起動期寫壞就整個起不來**（理由 2，產品需求超出 dsh 的射程）：dsh 的 `SessionReferenceResolver` 在建構子裡越界就拋
 *    `SESSION_REFERENCE_INVALID_CONFIG`（`index.ts:100-128`）。我們的載入器把一列的設定驗不過變成「那一列掉了、其餘照樣起來」，
 *    掉了之後 `startupSetting` 回 schema 的預設：`referenceContextFraction` 寫壞就靜靜變成 0.2。0.2 是 dsh 的英文換算，
 *    對中文是 547 KiB × 3 條逼近摘要門檻（見偏離 2），打錯一個字就換來這個，是 fail-open。所以這一列在 `startup-audit.ts` 的
 *    `REQUIRED_ENTRY_IDS` 上（沿用 #707 那筆登記，同 `goal-round-cap`、`turn-timeout`）：寫壞整個起不來，訊息指名這一列與欄位。
 *    **這一列也關不掉**（在 `PROTECTED_ENTRY_NAMES` 上，同 `thread-capacity`）：`disabled: true` 只會讓值回到 schema 的 0.2，
 *    讀起來像關掉引用，其實是把出廠調低的比例拿掉。
 * 2. **出廠的 `referenceContextFraction` 比 dsh 低**（理由 2，產品需求超出 dsh 的射程；demian 2026-10-17 拍板 Q4 (b)，
 *    [#1573 留言](https://github.com/DemianLi/nexus-agent/issues/1573#issuecomment-6235540587)）：dsh 的 web-app 出貨這一列不給 config，吃 0.2。
 *    dsh 的「每 token 4 位元組」是照英文調的；本產品以中文為主，nexus 自己的估算器（o200k）量中文是約 0.31 token／位元組，
 *    三條各 560,036 位元組的中文來源約占摘要門檻的 94%，乘上實測的真實÷o200k 1.10 就超過。出廠比例與量法見 `cordis.yml` 那一列。
 *    schema 的預設仍是 dsh 的 0.2：預設值的家是 schema（同其他列），出廠那一列明寫另一個數字。
 *
 * @module
 */

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';
import { DEFAULT_SESSION_REFERENCE_CANDIDATE_LIMIT, MAX_SESSION_REFERENCES } from '@nexus/wire';

/** 這一列在訊息裡叫什麼。 */
export const SESSION_REFERENCE_PLUGIN_NAME = 'session-reference';

/** 自動預算占窗口的幾成，schema 的預設，同 dsh 的 `DEFAULT_REFERENCE_CONTEXT_FRACTION`（`index.ts:55`）。 */
export const DEFAULT_REFERENCE_CONTEXT_FRACTION = 0.2;

/** `strictObject`：多寫一個欄位是打錯字，同其他幾列。 */
export const sessionReferenceConfigSchema = z.strictObject({
  /** 見檔頭。 */
  maxReferences: z
    .number()
    .int()
    .min(1)
    .max(MAX_SESSION_REFERENCES, `maxReferences 不能超過 ${String(MAX_SESSION_REFERENCES)}`)
    .default(MAX_SESSION_REFERENCES),
  /** 見檔頭。 */
  candidateLimit: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .default(DEFAULT_SESSION_REFERENCE_CANDIDATE_LIMIT),
  /** 見檔頭；省略即照模型窗口算。 */
  maxReferenceBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  /** 見檔頭。 */
  referenceContextFraction: z.number().min(0).max(1).default(DEFAULT_REFERENCE_CONTEXT_FRACTION),
});

/** 驗過的設定。 */
export type SessionReferenceConfig = z.infer<typeof sessionReferenceConfigSchema>;

/** 只講設定的那一顆，見檔頭。 */
export const sessionReferencePlugin: NexusPlugin<SessionReferenceConfig> = {
  name: SESSION_REFERENCE_PLUGIN_NAME,
  Config: sessionReferenceConfigSchema,
  apply: (_registry: PluginRegistry, _config: SessionReferenceConfig): void => {
    // 空的：組裝期沒有消費者。
  },
};

export default sessionReferencePlugin;
