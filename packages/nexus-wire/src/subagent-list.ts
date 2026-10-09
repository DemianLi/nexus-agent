/**
 * 「使用者可以點名派哪一種子代理」上線的形狀（[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 2 項）。
 *
 * **這一份只是契約**：型別、method 名字、client 方法。server 端還沒實作，`subagent.list` 一律回 `not_supported`，
 * `run.start` 帶非空的 `mention` 也一樣；web 據那個碼把 `@` 子代理的入口藏起來。實作落地時這裡的形狀盡量不動。
 *
 * **（2026-10-09 起 server 端已實作）**：`subagent.list` 回這個組裝的 `task` 實際收的子代理（`general-purpose` 在前，其餘依註冊順序），
 * `run.start` 的 `mention` 驗形狀與名字（不在清單上回 `invalid_argument`，那句話不進佇列）。點名之後在線上長在三個地方：
 * 排著的那一件（`WireQueuedInput.mention`）、領走時畫人話泡泡的 `claimed`、歷史重播的人話（`HumanEntry.mention`）。
 *
 * ## 與 dsh 的關係：dsh 沒有，為什麼做
 *
 * dsh 只有**已經生出來的子會話**的目錄投影（`subagentCatalog`，列 id、createdAt、mode、label；
 * `packages/subagent/subagent/src/projection-types.ts:10-19`，`5badb150`），沒有「有哪幾種子代理可以派」的清單，也沒有使用者
 * 直接派工的入口——派子代理的只有模型（委派工具），使用者只能點進已存在的子會話。所以這裡**沒有可照抄的形狀**，
 * 也不該照抄成投影：可派的種類是這個組裝的靜態事實（`registry.subagents.register` 註冊的那幾份），用一支讀取的 RPC 就夠。
 *
 * 做它的理由是 demian 2026-10-08 的指示（#328 第 2 項）：Claude Code 允許使用者在對話裡 `@` 某個子代理，這是它比 dsh 靈活的地方。
 *
 * ## 形狀
 *
 * - `subagent.list`：掛在 thread 底下（`/threads/:id/commands/:method`，同 `model.catalog`），回 {@link SubagentKind} 的清單，
 *   依註冊順序。
 * - `run.start` 的 `params.mention`：**選填**，{@link SubagentMention}。省略＝照舊，由模型自己決定派不派。帶了就是「這一句
 *   話請派那一種子代理」；名字不在 `subagent.list` 的清單上，server 回 `invalid_argument`（那句話不進佇列）。
 *   這一版**只有 `kind: 'subagent'`**；判別式留著，將來別種點名（例如技能）是向後相容的。
 *
 * 回應是 `{ ok: true, value }`，同模型選擇那兩支。
 *
 * @module
 */

/** 這個檔定義的 method。 */
export const SUBAGENT_LIST_METHOD = 'subagent.list';

export function isSubagentListMethod(value: unknown): value is typeof SUBAGENT_LIST_METHOD {
  return value === SUBAGENT_LIST_METHOD;
}

/** 一種可以派的子代理。 */
export interface SubagentKind {
  /** 註冊的名字，就是 {@link SubagentMention.name}。 */
  readonly name: string;
  /** 它做什麼；給人在選單裡看，也是模型選它的依據。 */
  readonly description: string;
}

export interface SubagentListCommand {
  readonly id: number;
  readonly method: typeof SUBAGENT_LIST_METHOD;
  readonly params: Record<string, never>;
}

export type SubagentListResult = {
  readonly ok: true;
  readonly value: { readonly subagents: readonly SubagentKind[] };
};

/** 使用者在這句話裡點名的對象。 */
export interface SubagentMention {
  readonly kind: 'subagent';
  /** {@link SubagentKind.name}。 */
  readonly name: string;
}

/**
 * 線上送來的值是不是一個合格的點名：`kind` 是 `'subagent'`、`name` 是非空字串。多出來的欄位不擋（前向相容），但 {@link mentionField} 不轉手。
 */
export function isSubagentMention(value: unknown): value is SubagentMention {
  if (typeof value !== 'object' || value === null) return false;
  const { kind, name } = value as { kind?: unknown; name?: unknown };
  return kind === 'subagent' && typeof name === 'string' && name !== '';
}

/**
 * 有合格的點名才帶 `mention` 這一格，只留認得的欄位。**不合格就當沒有**：點名只用來畫泡泡上的標記，壞掉的不該害整件話被丟掉
 * （附件不同，附件是話的內容）。
 */
export function mentionField(
  value: unknown,
): { readonly mention: SubagentMention } | Record<string, never> {
  return isSubagentMention(value) ? { mention: { kind: 'subagent', name: value.name } } : {};
}
