/**
 * 核准政策這顆**切得動**的旋鈕（[#437](https://github.com/DemianLi/nexus-agent/issues/437)）：這個會話遇到要人點頭的事，
 * 是去問人（`ask`），還是一律回絕（`never`）。
 *
 * ## 它和 {@link ApprovalChannel} 是兩個問題
 *
 * 照 dsh：`ApprovalPolicy` 是**政策**（`packages/interaction/user-approval/src/index.ts`，`5badb15`），「人在不在」不是它的事。
 * 我們以前只有 `approvals.enabled` 一顆，問的其實是「這個入口有沒有人在」（批次跑的 CLI 與評測是 `false`），政策那一半沒有載體；
 * 它關著時 `ask_user_question` 與 `exit_plan_mode` 也一起拒絕（沒有人，問了也等不到）。**這一顆拆出來的是另一半**：
 *
 * | | 問的是 | 誰決定 | 什麼時候決定 | 影響 |
 * | --- | --- | --- | --- |
 * | {@link ApprovalChannel} | 有沒有人可以回答 | 入口（CLI／評測／serve）與 checkpointer | 組裝時 | 核准、提問、計劃審核 |
 * | 本旋鈕 | 要不要問 | 使用者（經 `/permission`） | 每次呼叫 | **只有核准**；提問與計劃審核照常 |
 *
 * dsh 同款：`never` 只讓核准回 `rejected`（`user-approval/src/index.ts:275`），計劃審核走提問服務、不受它影響
 * （`plan-mode/src/index.ts:303-306`）。
 *
 * ## 照 dsh 的三件事
 *
 * 1. **逐次讀，不是組裝時扣進閉包。** 核准閘門與升級工具每次要問人之前問一次 {@link ApprovalPolicyController.source}。
 *    dsh 是每次從日誌最後一顆 `approval/policy` 讀（`:237-245`）；我們的狀態住在這顆控制器、日誌是審計面與續接的記憶，
 *    同 {@link ../../nexus-plugin-sandbox-policy/src/sandbox-mode.ts | SandboxModeController} 的做法，兩顆旋鈕形狀一致。
 * 2. **淨變化為零不寫事件。**
 * 3. **接上日誌的當下把起始值釘進去**，同沙箱那一顆：不釘的話，一份沒有人切過的日誌答不出政策是哪一格。
 *
 * ## 偏離（登記）
 *
 * - **控制器實體歸組裝點，不歸 plugin。** dsh 的 `user-approval` 服務自己擁有政策與它的 setter；`.docs/development-plan.md` 把
 *   「核准政策的 session 開關」留給組裝點，所以組裝點建控制器、經 {@link APPROVAL_POLICY_SERVICE} 交出去，plugin 只能讀與切。
 * - **子代理不讀這一顆。** 照 dsh 委派時把子代理的核准政策釘成 `never`（`child-agent.ts:254`），我們早已為子代理另建一顆管道固定
 *   `policy-never` 的閘門（`fold.ts`，#324），所以不必另有快照；子代理的日誌補一顆 `approval/policy { never, source: 'delegation' }`
 *   （由 {@link ./approval.ts | approvalGatePlugin} 在子代理日誌開啟時寫），讓日誌答得出子代理的政策。
 *
 * @module
 */

import type { SessionEvent, SessionLog } from './session-log.js';

/** 核准政策的值，照 dsh 的 `APPROVAL_POLICIES`。 */
export const APPROVAL_POLICIES = ['ask', 'never'] as const;

/** 核准政策。`ask`：要人點頭的事去問人；`never`：一律回絕，不問。 */
export type ApprovalPolicyValue = (typeof APPROVAL_POLICIES)[number];

/** 沒有人設定過時的政策：去問。 */
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicyValue = 'ask';

/**
 * 認得的政策值嗎。
 * @param value - 任意值（日誌讀回來的、命令列給的都沒有型別保證）。
 * @returns 是 {@link APPROVAL_POLICIES} 之一。
 */
export function isApprovalPolicy(value: unknown): value is ApprovalPolicyValue {
  return typeof value === 'string' && (APPROVAL_POLICIES as readonly string[]).includes(value);
}

/** 閘門與升級工具每次要問人之前問一次的來源。 */
export type ApprovalPolicySource = () => ApprovalPolicyValue;

/**
 * 這個組裝的核准政策控制器的服務名，型別見 `NexusServices.approvalPolicy`。**組裝點提供**（見檔頭的偏離）；
 * 沒有人提供時（手搭的測試組裝）閘門與升級工具都當作 {@link DEFAULT_APPROVAL_POLICY}。
 */
export const APPROVAL_POLICY_SERVICE = 'approvalPolicy';

/**
 * 一份日誌上**最後一顆** `approval/policy` 記的政策，一顆都沒有時是 `undefined`。
 *
 * 續接拿它當起始值（同 `recordedSandboxMode`）。`undefined` 有兩種來源：這是 #437 以前的日誌，或根本沒接過；
 * 兩者都照 {@link DEFAULT_APPROVAL_POLICY} 起算，也就是以前的行為。**子代理日誌上的那一顆（`source: 'delegation'`）不算**：
 * 它記的是子代理自己的，不是 root 該續接的值。
 *
 * @param events - 讀回來的 root 日誌。
 * @returns 最後一顆 root 記的政策，或 `undefined`。
 */
export function recordedApprovalPolicy(
  events: readonly SessionEvent[],
): ApprovalPolicyValue | undefined {
  for (let at = events.length - 1; at >= 0; at -= 1) {
    const event = events[at];
    if (event?.type === 'approval/policy' && event.data.source === undefined) {
      return event.data.policy;
    }
  }
  return undefined;
}

/** 一次切換的結局。 */
export type ApprovalPolicySwitchOutcome =
  /** 真的換了一格，日誌上多了一顆 `approval/policy`。 */
  | {
      readonly kind: 'switched';
      readonly from: ApprovalPolicyValue;
      readonly to: ApprovalPolicyValue;
    }
  /** 目標就是現在這一格。**什麼都沒發生，日誌上一顆都沒加**。 */
  | { readonly kind: 'unchanged'; readonly policy: ApprovalPolicyValue };

/**
 * 這個組裝的核准政策現在是哪一格，以及切它的權威入口。
 *
 * **核准閘門與升級工具都跟這一顆讀**（經 {@link ApprovalPolicyController.source}），各存一份快照的話，切換那天畫面上說的與實際
 * 擋的會是兩格，而沒有任何測試會紅。
 *
 * **壽命是一次組裝＝一條 thread**，理由同 `SandboxModeController`：放進模組層就會串台。
 */
export class ApprovalPolicyController {
  #policy: ApprovalPolicyValue;

  /** 接著的 root 日誌，依接線順序；多於一份時每一份都寫（理由同 `SandboxModeController`）。 */
  readonly #logs: SessionLog[] = [];

  /**
   * @param initial - 起始那一格。省略即 {@link DEFAULT_APPROVAL_POLICY}。
   */
  constructor(initial: ApprovalPolicyValue = DEFAULT_APPROVAL_POLICY) {
    this.#policy = initial;
  }

  /** 這一刻是哪一格。 */
  get current(): ApprovalPolicyValue {
    return this.#policy;
  }

  /** 現在接著幾份日誌。切換時用來把「這次切換沒留痕跡」講出來。 */
  get attachedCount(): number {
    return this.#logs.length;
  }

  /**
   * 交給閘門與升級工具的來源。**是欄位不是方法**，拿去傳給別人時不必 bind（理由同 `SandboxModeController.source`）。
   */
  readonly source: ApprovalPolicySource = () => this.#policy;

  /**
   * 接一份 root 會話日誌，**並且當場把起始值釘進去**。
   *
   * **日誌上最後一顆已經是這一格就不再寫**（dsh 的 `pinInitialPermission` 只補缺的事實）：續接時控制器就是從那一顆起算的，
   * 再寫一顆等於每次空轉的續接都讓日誌長一筆，還會讓 `session/resumed` 的「前一顆是同樣內容就不疊」與 end-seed 的
   * 判斷失準（尾巴不再是它們認得的那一顆）。
   *
   * @param log - 要記帳的日誌。
   * @returns 收掉這次接線的函式。
   */
  attach(log: SessionLog): () => void {
    this.#logs.push(log);
    if (recordedApprovalPolicy(log.events) !== this.#policy) {
      log.append('approval/policy', { policy: this.#policy });
    }
    return () => {
      const at = this.#logs.indexOf(log);
      if (at >= 0) this.#logs.splice(at, 1);
    };
  }

  /**
   * 切到某一格。**淨變化為零時什麼都不做**，照 dsh。
   *
   * @param next - 目標那一格。
   * @returns 這次切換的結局；`unchanged` 代表日誌上一顆都沒加。
   */
  switchTo(next: ApprovalPolicyValue): ApprovalPolicySwitchOutcome {
    const from = this.#policy;
    if (from === next) return { kind: 'unchanged', policy: from };
    this.#policy = next;
    for (const log of this.#logs) log.append('approval/policy', { policy: next });
    return { kind: 'switched', from, to: next };
  }
}
