/**
 * `@nexus/approval-channel`：答題管道這個接縫的**定義套件**（決議 §3-4 第 16 條，dsh 的三角色紀律；
 * [#1458](https://github.com/DemianLi/nexus-agent/issues/1458) Q2 (a)，Part of #1385）。形狀照 `@nexus/tools`、
 * `@nexus/feedback`。
 *
 * 「這個 session 有沒有人可以回答」是**宿主的事實**（入口有沒有人在、有沒有 checkpointer），不是設定檔上的一個值：
 * `ask-user`、`plan-mode`、`submit-record` 的升級、MCP 的 elicitation 都要讀它。這個套件放它的 token、值的型別，與
 * 提問中斷的判別式。
 *
 * | 角色 | 是誰 | 依賴什麼 |
 * | --- | --- | --- |
 * | 定義 | 這個套件主入口：token、`ApprovalChannelService`、契約版本，與下面那幾個從 core 轉出的名字 | `@nexus/sdk`，與 `@nexus/core`（單向轉出，見下） |
 * | 提供者 | 樹上一列內建列，行程級（`@nexus/approval-channel/provider`），**由宿主（入口）把推導好的管道交給它** | 這個套件、`@nexus/sdk` |
 * | 消費者 | 要問人或判斷有沒有人在的插件，今天是 `ask-user` | **只有這個套件**與 `@nexus/sdk`，永不 import 提供者 |
 *
 * ## 接縫的形狀：行程級的預設管道（#1458 Q1 (c)）
 *
 * 服務只有一個方法 `current()`，回宿主給這個行程的 {@link ApprovalChannel}。今天管道在一個行程裡是常數：只看入口有沒有人在
 * （serve 有、CLI 沒有）與有沒有 checkpointer（一律有），所以不需要逐條 thread 的路由。這就是 dsh 的形狀：行程級的答題者
 * 沒有標籤，每個 agent 都拿到（`packages/core/scope/src/index.ts:170-185`）。
 *
 * **`ChannelForThread`（逐條 thread 的管道，#1418）今天沒有提供者，也沒有查詢它的消費者。** 型別與服務名（
 * {@link CHANNEL_FOR_THREAD_SERVICE}）留在這裡，是因為 #1418 的接縫（`@nexus/core` 的 `NexusServices.channelForThread`、`createHostServicesPlugin` 的選項）
 * 已經存在；但**全樹今天沒有任何地方提供它**，只有測試夾具（`apps/harness/src/ask-user.fixture.ts`，舊外殼）還在查。樹上的
 * `ask-user` 不查它。等出現真的會逐條不同的答題者時，再加提供者與查詢，一起加回來。
 * 這不是 AGENTS.md 那條「基礎建設表達不出來」的偏離：dsh 的答題者也不是逐條 thread 提供（見上）。
 *
 * ## 偏離登記
 *
 * - **相依 `@nexus/core`，只做單向轉出**（#1421 Q2 (a)、#1435 Q1 (c) 的同一條）：下面的值與型別留在 core——兩邊都要讀（核准閘門
 *   的 `deriveApprovalChannel`、web 的 wire 折疊器讀 `QUESTION_INTERRUPT_KIND`），搬走就要動核准閘門與 wire，是跟每一張碰
 *   核准的卡相撞的一刀。相依是單向的：這個套件相依 core，core 不 import 它。**`@nexus/core` 放 `peerDependencies`，
 *   `devDependencies` 留 `workspace:*`**（不能讓安裝結果出現第二份 core）。撤除條件併入 #1421 Q2 (b)：發布到私有 registry 之前，
 *   把實作搬進來。
 * - **一條通道加一個判別式**（#231 登記過，不在這張新增）：dsh 用兩條獨立的事件通道（`approval/request` 與
 *   `user-questions/request`），LangGraph 只給一顆 `interrupt()`，所以提問的中斷酬載明著帶 `kind`，判別式是
 *   {@link QUESTION_INTERRUPT_KIND}。
 *
 * 介面只放今天有消費者的東西（`packages/AGENTS.md`「Require a current owner and need」）。
 *
 * @module
 */

import type { ApprovalChannel } from '@nexus/core';
import { defineToken } from '@nexus/sdk';

export { CHANNEL_FOR_THREAD_SERVICE, CHANNEL_SERVICE, QUESTION_INTERRUPT_KIND } from '@nexus/core';
export type {
  ApprovalChannel,
  ChannelForThread,
  QuestionAnswerItem,
  QuestionInterruptPayload,
  QuestionReply,
} from '@nexus/core';

/** 契約版本（semver）。介面破壞性改動跳 major，消費者的範圍擋下不相容的提供者。 */
export const APPROVAL_CHANNEL_CONTRACT_VERSION = '1.0.0';

/** 答題管道。 */
export interface ApprovalChannelService {
  /**
   * 這個行程的預設答題管道：有人在（`human`）、政策上沒有人在（`policy-never`）、沒有 checkpointer（`no-channel`）。
   *
   * **`undefined` 是「宿主沒有指定答題者」**（沒掛 host-services 的組裝，#669）：消費者要在呼叫當下拒絕，**不是**退成
   * 「有人在」。服務本身永遠在（所以消費者的 `inject` 是必要依賴、契約範圍由 Cordis 檢查），有沒有答題者是它回的值。
   *
   * **每次呼叫回同一個值**（行程級、不隨 thread 變）；消費者在 `apply` 當下抓住這個服務，在呼叫當下問它。
   */
  current(): ApprovalChannel | undefined;
}

/** `approvalChannel` 服務的 token。 */
export const approvalChannelToken = defineToken<ApprovalChannelService>(
  'approvalChannel',
  APPROVAL_CHANNEL_CONTRACT_VERSION,
);
