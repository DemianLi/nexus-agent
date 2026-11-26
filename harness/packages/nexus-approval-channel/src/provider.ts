/**
 * 答題管道的**提供者**（三角色紀律的提供者那一角，決議 §3-4 第 16 條；#1458）。
 *
 * 跟定義（`./index.ts`）分在兩個入口：消費者只 import `@nexus/approval-channel`，永遠不 import 這裡。理由同
 * `@nexus/tools/provider`：它的測試要被每一顆消費者的一致性套件重用（`checkConformance` 的 `providers`）。
 *
 * ## 行程級、一列、值由宿主交進來
 *
 * 管道不是設定，是**入口的事實**：serve 有人在、CLI 沒有（`HEADLESS_APPROVALS`）、沒有樹的組裝則看那一次組裝自己提供的
 * `channel`。所以提供者**不推導**，只收宿主交進來的值（{@link createApprovalChannelProvider} 的參數）：推導的那一支
 * （`@nexus/core` 的 `deriveApprovalChannel`）只有一個，宿主在組裝點與建樹的地方都呼叫它。
 *
 * 服務的方法是**自己的屬性、閉包住那個值**，不是原型方法：消費者在 `apply` 當下抓住這個服務（traceable proxy），
 * 提供者那一列卸載之後開著的 thread 仍要能問它（#1456 驗收 D 的同一個形狀），方法不碰 `this.ctx`。
 *
 * @module
 */

import type { Context } from '@nexus/cordis';
import { ContractService } from '@nexus/sdk';

import { approvalChannelToken } from './index.js';
import type { ApprovalChannel, ApprovalChannelService } from './index.js';

/** {@link createApprovalChannelProvider} 的回傳：交給 Loader 當內建插件的類別。 */
export interface ApprovalChannelProviderHandle {
  /** 掛進 Loader 的 `builtins` 的那個服務類別。 */
  readonly Provider: new (ctx: Context) => ApprovalChannelService;
  /** 這個提供者交出去的管道（宿主的測試與稽核讀它）；`undefined` 是宿主沒有指定答題者。 */
  readonly channel: ApprovalChannel | undefined;
}

/**
 * 造一個提供者。
 *
 * @param channel - 這個行程的預設管道，由宿主推導後交進來；`undefined` 是宿主沒有指定答題者（消費者在呼叫當下拒絕）。
 *   **複製一份凍結的**：之後呼叫端改它不影響已經交出去的值。
 */
export function createApprovalChannelProvider(
  channel: ApprovalChannel | undefined,
): ApprovalChannelProviderHandle {
  const frozen: ApprovalChannel | undefined =
    channel === undefined ? undefined : Object.freeze({ ...channel });

  class ApprovalChannelServiceImpl
    extends ContractService<ApprovalChannelService>
    implements ApprovalChannelService
  {
    readonly current: () => ApprovalChannel | undefined;

    constructor(ctx: Context) {
      super(ctx, approvalChannelToken);
      this.current = () => frozen;
    }
  }

  return { Provider: ApprovalChannelServiceImpl, channel: frozen };
}
