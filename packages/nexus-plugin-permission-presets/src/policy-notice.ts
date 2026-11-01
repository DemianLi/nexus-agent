/**
 * 切換核准政策時對模型講一聲（[#2057](https://github.com/DemianLi/nexus-agent/issues/2057)）。
 *
 * 要發的通知由日誌推出來：`/permission` 那一對 `command/run`／`command/done` 之間值真的變了的 `approval/policy`，
 * 扣掉已經記成 `user/message` 的通知。起始值與續接收回不在命令裡，不發。
 *
 * `PolicyNoticeLedger` 經 `observe` 逐顆吃（接上時它先重播已有的事件），listener 不碰 `log.events`（那是整份副本）。
 *
 * @module
 */

import type { PreStepInjection, PreStepInvocation, PreStepListener } from '@nexus/agent-loop';
import type {} from '@nexus/plugin-commands';
import { PERMISSION_COMMAND_NAME } from '@nexus/permission-presets';
import type { SessionEvent, SessionLookup } from '@nexus/session';

/** 登記 `preStep` 的名字，也是通知那則 `user/message` 的 `source.plugin`。 */
export const POLICY_NOTICE_LISTENER_NAME = 'nexusApprovalPolicyNotice';

type ApprovalPolicy = 'ask' | 'never';

/** 通知裡的政策名稱：只寫 `never` 會被讀成「永遠不核准」。 */
const POLICY_NOTICE_NAMES: Readonly<Record<ApprovalPolicy, string>> = {
  ask: '詢問使用者核准',
  never: '不詢問使用者核准',
};

/**
 * 通知文字。
 *
 * @param from - 切換前的政策。
 * @param to - 切換後的政策。
 * @returns 給模型看的一句話。
 */
export function policyNoticeText(from: ApprovalPolicy, to: ApprovalPolicy): string {
  return `使用者把核准政策從「${POLICY_NOTICE_NAMES[from]}」改成「${POLICY_NOTICE_NAMES[to]}」。`;
}

/** 一份日誌上還沒發出去的通知。 */
export class PolicyNoticeLedger {
  #previous: ApprovalPolicy = 'ask';
  #inCommand = false;
  readonly #pending: string[] = [];

  /** @param event - 下一顆事件，照日誌順序。 */
  advance(event: SessionEvent): void {
    if (event.type === 'command/run') {
      this.#inCommand = event.data.name === PERMISSION_COMMAND_NAME;
    } else if (event.type === 'command/done') {
      this.#inCommand = false;
    } else if (event.type === 'approval/policy' && event.data.source === undefined) {
      const next = event.data.policy;
      if (this.#inCommand) {
        this.#pending.push(policyNoticeText(this.#previous, next));
      }
      this.#previous = next;
    } else if (
      event.type === 'user/message' &&
      event.data.source.kind === 'plugin' &&
      event.data.source.plugin === POLICY_NOTICE_LISTENER_NAME
    ) {
      this.#pending.shift();
    }
  }

  /** @returns 還沒發出去的通知，照切換的先後。記成 `user/message` 之後才消掉。 */
  pending(): readonly string[] {
    return this.#pending;
  }
}

/**
 * 建 listener。
 *
 * @param ledgerOf - 這份日誌的帳；子代理的日誌沒有帳。
 * @param lookup - 這次呼叫屬於哪份日誌。
 * @returns 登記給 `agentLoop.preStep` 的 listener。
 */
export function createPolicyNoticeListener(
  ledgerOf: (found: Extract<SessionLookup, { kind: 'ok' }>) => PolicyNoticeLedger | undefined,
  lookup: (invocation: PreStepInvocation) => SessionLookup,
): PreStepListener {
  return (_visible, invocation): readonly PreStepInjection[] | undefined => {
    const found = lookup(invocation);
    if (found.kind !== 'ok') return undefined;
    return ledgerOf(found)
      ?.pending()
      .map((content) => ({ content }));
  };
}
