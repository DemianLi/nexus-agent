/**
 * `@nexus/agent-loop`：**一次 agent 呼叫開頭注入訊息**這個接縫的定義套件（決議 §3-4 第 16 條，dsh 的三角色紀律；
 * [#1474](https://github.com/DemianLi/nexus-agent/issues/1474) Q1 (a)、Q1-1 (a)，Part of #1385）。
 *
 * 對應 dsh 的 `agent/pre-step`：插件在模型看到這一步之前，往這一步的訊息批次加一則持久的使用者訊息
 * （`agent-instructions` 的 `AGENTS.md` 基線是第一個消費者）。名字叫 `agent-loop`，是因為 dsh 的這條事件就是 agent loop 的
 * 時機，以後 `agent/turn-stopping` 這類也住這裡（本套件今天只放有消費者的 `preStep`，見檔尾）。
 *
 * | 角色 | 是誰 | 依賴什麼 |
 * | --- | --- | --- |
 * | 定義 | 這個套件主入口：token、介面、契約版本 | 只有 `@nexus/sdk`（與訊息的型別，取自 `@langchain/core`），**不 import `@nexus/core`** |
 * | 提供者 | 樹上一列內建列 `pre-step`，行程級的登記處：同一個套件的另一個入口 `@nexus/agent-loop/provider`，由宿主（`apps/harness`）掛一列 | 這個套件、`@nexus/sdk` |
 * | 消費者 | 想在一次呼叫開頭注入訊息的插件，今天是 `agent-instructions` | **只有這個套件**與 `@nexus/sdk`，永不 import 提供者 |
 *
 * ## 誰建 middleware、誰建訊息、誰記日誌（Q2 (a)）
 *
 * **都是宿主**。listener 只回「要追加什麼」（`{ content, additionalKwargs }`）；宿主為每個 listener 建**一顆** middleware、掛在
 * `beforeAgent`（名字就是登記時給的名字），在那裡：
 *
 * 1. 用 core 的 `effectiveMessages` 算出「模型看得到的那一串」交給 listener——摘要器的私有鍵 `_summarizationEvent` 留在宿主，
 *    插件不碰；
 * 2. 把 listener 回的內容建成 `HumanMessage`（`additional_kwargs` 先放 listener 給的、再蓋 `source`）；
 * 3. 經**這條 thread 自己的**會話註冊表記一筆 `user/message`，來源是 `{ kind: 'plugin', plugin: <名字> }`；記不進去訊息照送；
 * 4. 回 `{ messages }`，由基座**追加**。
 *
 * 這跟 dsh 一致：dsh 的插件只把基線放進這一步的批次，由 agent loop 記成 `user/message`，插件不寫日誌
 * （`packages/core/agent-loop/src/agent.ts:426-436`）。「進了模型的訊息一定有記錄」因此是接縫的保證，不靠每顆插件記得做。
 *
 * ## 偏離登記（AGENTS.md 的偏離規則；dsh 以 `86a40220` 為準）
 *
 * | # | dsh 怎麼做 | 我們怎麼做 | 為什麼表達不出來 |
 * | --- | --- | --- | --- |
 * | 1 | waterfall：listener 收 `next()`、拿到這一步的決定（`enter`／`reject`）後可以 splice 進批次的任何位置、可以 `reject` 整步（`agent.ts:267-288`、`runtime-types.ts:322`）。`agent-instructions` 遇到 `reject`、或第 1 步批次是空的就不 splice，把基線留在收件匣等下一步（`agent-instructions/src/index.ts:345`） | **只能追加**，位置由基座決定（今天落在使用者那一句之後，與 dsh 同位）；沒有 `reject`，也沒有「留到下一步」 | 載體是 middleware 的 `beforeAgent`，只能回要追加的訊息（`interception-index.test.ts` 第 2 列 `permissionDelta`）；拿不到整個批次 |
 * | 2 | **每一步**都跑（waterfall 在 `preStep()`，迴圈裡每個 step 一次：`agent.ts:318` 呼叫、`:267-288` 實作） | **每次 invoke 一次**（`beforeAgent`） | 每一步要 `beforeModel`，它是圖裡的節點，預設上限 100 下每輪多一格＝33 輪變 24 輪（#389 triage 實測）；#389 拍板每一步的那一半先不做，這裡也就沒有另外為它付那一格。名字叫 `preStep` 而不叫 `beforeInvoke`：#389 重開時名字不必改 |
 * | 3 | listener 收 `{ agent, messages, step, signal }`，`messages` 是**這一步從收件匣領出來的批次**（`runtime-types.ts:313`） | listener 收「**模型看得到的那一串**」（`effectiveMessages`）與呼叫設定 `{ configurable }`；沒有 `agent` 物件，這次呼叫屬於哪條 thread 由 `configurable` 認 | 我們沒有收件匣：訊息批次在圖的 state 裡。沒有 `agent` 物件，身分由呼叫設定認（同 `@nexus/session` 的會話查找） |
 * | 4 | 在請求被接受的**第一次嘗試**才記 `user/message`（`agent.ts:426-436`，`if (firstAttempt)` 底下） | 在注入當下記（`beforeAgent` 回傳之前） | `beforeAgent` 在請求之前就跑，看不到「這一步是不是第一次嘗試」。重試是模型呼叫那一層的事（`retryModelCall`），不會重跑 `beforeAgent`，所以同一次 invoke 不會因重試記兩筆 |
 *
 * **撤除條件**：#389 重開（每一步注入），或 core 開了讓多個貢獻者共用一格的 pre-step 節點時，第 1、2、4 列一起重評。
 *
 * 介面只放今天有消費者的東西（`packages/AGENTS.md`「Require a current owner and need」）：`agent/turn-stopping` 等其餘 agent loop
 * 事件今天沒有遷出的消費者，不加。
 *
 * @module
 */

import type { BaseMessage } from '@langchain/core/messages';
import { defineToken } from '@nexus/sdk';

/**
 * 契約版本（semver）。介面破壞性改動跳 major，消費者的 `inject` 範圍擋下不相容的提供者。
 */
export const AGENT_LOOP_CONTRACT_VERSION = '1.0.0';

/**
 * 這一次呼叫的設定，listener 的第二個參數。形狀固定是 `{ configurable }`：**原樣**交給會話查找與 fs 查找
 * （`sessionLookup.forCall(invocation)`、`fs.forCall(invocation)`）就認得出這次呼叫屬於哪一條 thread、是 root 還是某個子代理。
 * 交裸的 `configurable` 那兩個查找會回 `unknown-caller`——**注入會靜靜消失**，所以宿主一律交這個形狀。
 */
export interface PreStepInvocation {
  /** 基座給 `beforeAgent` 的 `runtime.configurable`；取不到時是 `undefined`。 */
  readonly configurable: unknown;
}

/** 一則要追加的訊息：宿主把它建成使用者訊息。 */
export interface PreStepInjection {
  /** 訊息文字。 */
  readonly content: string;
  /**
   * 訊息帶的記號（`additional_kwargs`），**依這裡的順序放在前面**；宿主之後再蓋 `source`。
   * 記號用來讓 listener 下一次認得「這個 agent 已經有了」——判準放在訊息上，不放在閉包裡（一份 listener 服務好幾條 thread）。
   */
  readonly additionalKwargs?: Readonly<Record<string, unknown>>;
}

/**
 * 一位 `agent/pre-step` listener。
 *
 * **一份 listener 服務好幾條 thread、root 與每個子代理**：逐 agent 的狀態不能放在閉包裡，要從 `visible`（看訊息上的記號）與
 * `invocation`（看是哪條 thread）查。
 *
 * @param visible - 模型看得到的那一串訊息（摘要之後是 `[summary, ...切點之後的]`，不是 state 裡的全部）。唯讀。
 * @param invocation - 這一次呼叫的設定，見 {@link PreStepInvocation}。
 * @returns 要追加的訊息（0 則：`undefined` 或空陣列）。
 */
export type PreStepListener = (
  visible: readonly BaseMessage[],
  invocation: PreStepInvocation,
) => readonly PreStepInjection[] | undefined | Promise<readonly PreStepInjection[] | undefined>;

/** agent loop 的登記處。 */
export interface AgentLoop {
  /**
   * 登記一位 `agent/pre-step` listener：每次 agent 呼叫開頭（root 與每個子代理各一次）被叫一次，回要追加的訊息。
   *
   * 登記就是 effect：登記者那一列卸載時登記處自己撤掉。已經折進某條 thread 的那一份不受影響（組 thread 時取快照，決議 §3-2 第 6 條）。
   *
   * - **`name` 是 middleware 的名字**，也是日誌 `user/message` 的 `source.plugin`。同一個登記處內重名拒絕（後登記的那一列掉在
   *   `apply` 階段）；與別的 middleware 撞名由 fold 那側判。
   * - **位置就是那一列在出貨清單上的位置**：宿主為它建的 middleware 不帶 `prepend`／`last`。
   *
   * @param name - listener 的名字，非空。
   * @param listener - 這一位 listener。
   * @returns 只撤銷這一次登記的冪等 disposer。
   * @throws 名字是空的、或同一個登記處內已經有這個名字。
   */
  preStep(name: string, listener: PreStepListener): () => void;
}

/** `agentLoop` 服務的 token。 */
export const agentLoopToken = defineToken<AgentLoop>('agentLoop', AGENT_LOOP_CONTRACT_VERSION);
