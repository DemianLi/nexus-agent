/**
 * `@nexus/feedback`：評分與評語這個**服務**的定義套件（決議 §3-4 第 16 條；
 * [#1456](https://github.com/DemianLi/nexus-agent/issues/1456)，Part of #1385）。形狀照 `@nexus/tools`、`@nexus/projections`。
 *
 * ## 第一個「插件提供、宿主消費」的服務
 *
 * 前面的接縫（工具、投影、技能來源）都是**宿主提供登記處、插件消費**。這一個反過來：服務的**提供者是插件**（`@nexus/plugin-feedback`
 * 在 `apply` 裡 `new` 一個繼承 `ContractService` 的類別，建構時 `provide`），**消費者是宿主**（`apps/harness` 的組 thread 那一步
 * 從樹上取它）。所以三個角色的位置變了：
 *
 * | 角色 | 是誰 | 依賴什麼 |
 * | --- | --- | --- |
 * | 定義 | 這個套件：token、`FeedbackService` 與請求／結果型別、契約版本 | `@nexus/sdk`，與 `@nexus/core` 的型別與讀日誌的函式（見下） |
 * | 提供者 | `@nexus/plugin-feedback`，樹上一列函式插件 | 這個套件、`@nexus/sdk`、`@nexus/session`、`@nexus/commands` |
 * | 消費者 | 宿主（`apps/harness`）：組 thread 時把服務折進 `registry.services`，wire handler 與 pump 讀它 | 這個套件；**不 import 提供者套件**（決議 §3-4 第 16 條） |
 *
 * ## 偏離登記
 *
 * - **相依 `@nexus/core`**（照 `@nexus/projections` 的 #1421 Q2 (a)）：型別與 `currentMessageFeedback`、`FEEDBACK_CATEGORIES`
 *   的實作留在 `@nexus/core`（兩邊都要讀的詞彙，web 的 wire 協定也讀它），由這個套件單向轉出。**`@nexus/core` 放
 *   `peerDependencies`，`devDependencies` 留 `workspace:*`**。撤除條件併入 #1421 Q2 (b)。
 * - **兩個服務併成一個**（#1456 Q3 (a)；類別：遷移卡不改行為（暫時））：dsh 的評分（`messageFeedback`，管 list／put／delete）與評語
 *   （`sessionFeedback`，管 `record`）是兩個服務（`packages/feedback/message-feedback/src/index.ts:118-140`、
 *   `packages/feedback/command-feedback/src/index.ts:40-41`）。nexus 的 `FeedbackService` 把 `record` 併成第四個方法
 *   （`@nexus/core` 的 `feedback.ts`，#278 起如此）。這張是遷移卡，驗收是行為不變：拆開要改 wire handler 讀兩個服務、
 *   也牽動列 id，是行為變更。**撤除條件**：要拆時另開卡，連同使用者 home 變更紀錄裡 `feedback` 列 id 的遷移一起處理
 *   （紀錄裡找不到 id 的 patch 只警告就跳過，停用過的列會靜靜重新啟用）。
 * - **宿主取的是快照，不是每次呼叫讀 live**：dsh 的 gateway 每次呼叫當下讀全域 store 的 `ctx.get('messageFeedback')`
 *   （`packages/api/gateway/src/index.ts:384-399`、`:874-889`）。這裡在組 thread 時取一次，跟既有的「快照」那一類同一個理由
 *   （決議 §3-2 第 6 條：插件更新只給新對話；開著的對話不變）。
 *
 * 服務的方法**一律不碰 `this.ctx`**：宿主拿到的是快照時取的那個值，列卸載之後開著的 thread 仍要能呼叫它（traceable proxy 讀屬性
 * 不檢查提供的 fiber 還在不在）。需要的設定在建構時進閉包，需要的日誌由呼叫端逐次傳進來。
 *
 * 介面只放今天有消費者的東西（`packages/AGENTS.md`「Require a current owner and need」）。
 *
 * @module
 */

import { MESSAGE_FEEDBACK_SERVICE } from '@nexus/core';
import type { FeedbackService } from '@nexus/core';
import { defineToken } from '@nexus/sdk';

export { currentMessageFeedback, FEEDBACK_CATEGORIES } from '@nexus/core';
export type {
  CurrentMessageFeedback,
  FeedbackCategory,
  FeedbackRecord,
  FeedbackRecordResult,
  FeedbackRejected,
  FeedbackService,
  FeedbackSuccess,
  LegacyTurnFeedbackItem,
  MessageFeedbackDelete,
  MessageFeedbackDeleteRequest,
  MessageFeedbackDeleteResult,
  MessageFeedbackFailure,
  MessageFeedbackItem,
  MessageFeedbackListResult,
  MessageFeedbackNoteBlank,
  MessageFeedbackNoteTooLarge,
  MessageFeedbackPut,
  MessageFeedbackPutRequest,
  MessageFeedbackPutResult,
  MessageFeedbackRating,
  MessageFeedbackTargetNotFound,
  MessageFeedbackVersionConflict,
} from '@nexus/core';

/** 契約版本（semver）。介面破壞性改動跳 major，宿主的範圍檢查擋下不相容的提供者。 */
export const FEEDBACK_CONTRACT_VERSION = '1.0.0';

/**
 * `messageFeedback` 服務的 token。服務名取自 `@nexus/core` 的 `MESSAGE_FEEDBACK_SERVICE`（跨套件的位址，照 dsh 取名），
 * 兩處是同一個字串，不各寫一份。
 */
export const feedbackToken = defineToken<FeedbackService>(
  MESSAGE_FEEDBACK_SERVICE,
  FEEDBACK_CONTRACT_VERSION,
);
