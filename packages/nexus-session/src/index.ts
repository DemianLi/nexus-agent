/**
 * `@nexus/session`：會話日誌的**讀法**與**查找**這個定義套件（決議 §3-4 第 16 條，dsh 的三角色紀律；
 * [#1435](https://github.com/DemianLi/nexus-agent/issues/1435)、[#1463](https://github.com/DemianLi/nexus-agent/issues/1463)，
 * Part of #1385）。
 *
 * 投影單元（`trajectory`、`token-meter`……）要讀會話日誌裡的訊息、模型呼叫與 repeat-reminder 標記，**模型工具要找「這次呼叫
 * 該寫進哪一份日誌」**（`todo`），但都**不能 import `@nexus/core`**（決議 §3-4 第 17 條：外部插件只相依 SDK 與服務定義套件；
 * #1420 的 lint 擋它）。dsh 的對應是投影從 `dsh-session` 拿日誌的讀法、工具從 `exec.agent.session` 拿自己的會話；這個套件就是
 * 那個位置。
 *
 * | 角色 | 是誰 | 依賴什麼 |
 * | --- | --- | --- |
 * | 定義 | 這個套件主入口：讀法、型別、`sessionLookupToken` 與 {@link SessionLookupService} | `@nexus/sdk`，與 `@nexus/core`（單向轉出，見下） |
 * | 提供者 | 樹上一列內建列，行程級（`@nexus/session/provider`），**由宿主把「這次呼叫找哪一張註冊表」的挑法交給它** | 這個套件、`@nexus/sdk` |
 * | 消費者 | 要往「呼叫它的那一份日誌」寫的模型工具，今天是 `todo` | **只有這個套件**與 `@nexus/sdk`，永不 import 提供者 |
 *
 * ## 會話查找這個接縫（#1463 Q1 (a)、Q2 (a)）：宿主提供、呼叫當下依 thread 路由
 *
 * 服務只有一個方法 `forCall(invocation)`，回 {@link SessionLookup}。它找的是**行程裡每一條活著的 thread** 綁上的會話註冊表；
 * 挑法是 `@nexus/core` 的 `pickSessionForCall`（相容層一張就不看 `thread_id`、行程級查找一張也核對（#1482）；多張依 `thread_id` 挑恰好一張，否則 `ambiguous`），
 * 相容層的 `registry.sessions.forCall` 與樹上這個服務是**同一支實作**。
 *
 * **偏離 dsh**（AGENTS.md 的偏離規則）：dsh 的形狀是 `exec.agent`，由 agent loop 派發工具時帶進來
 * （`packages/core/tools/src/index.ts:339-340`、`packages/core/agent-loop/src/tool-calls.ts:68,78`），工具直接讀
 * `exec.agent.session`（`packages/todo/tool-todo/src/index.ts:192-199`），沒有任何服務；它也沒有「多個候選」這種情況，因為
 * 以物件身分路由。**表達不出來的原因**：我們的派發點是 LangGraph 的 ToolNode，在 deepagents 底下插不進逐次呼叫的欄位
 * （已登記在 `@nexus/core` 的 `registry.ts` 的 `SessionRegistrationPoint.forCall`）。**退到最接近的**：呼叫當下從 config 推出
 * 身分（`thread_id`＋`checkpoint_ns`），也就是相容層今天的做法，只是提供者從每條 thread 的註冊表換成樹上的內建列。
 *
 * ## 偏離登記：讀法只做單向轉出，實作留在 `@nexus/core`（#1435 Q1 (c)）
 *
 * dsh 的 `dsh-session` 持有日誌的型別與讀法的**實作**；抽出實作是橫跨整個核心的一刀（`session-log.ts`、`logged-message.ts`
 * 都要動，會跟每一張碰會話日誌的卡相撞，#1421 Q2 (b)），這一張不做。所以：
 *
 * - 下面的值與型別**留在 `@nexus/core`，由這個套件單向轉出**。相依是單向的：這個套件相依 `@nexus/core`，core 不 import 它。
 *   插件只 import 這個套件，所以 lint 與決議第 17 條在插件這一側都成立；日後把實作搬進來時，插件一行不改。
 * - **`@nexus/core` 放 `peerDependencies`，`devDependencies` 留 `workspace:*`**（#1421 PM 決策 3）：不能讓安裝結果出現第二份
 *   core，理由同 `@nexus/sdk` 放 peer。
 * - **撤除條件**：SDK 與定義套件要發布到私有 registry 之前，把這些值的實作搬進這個套件（#1421 Q2 (b)）；屆時
 *   `SessionEvent`、`isLogicalTurnStart` 也從 `@nexus/projections` 移來這裡，`@nexus/projections` 改成從這裡轉出。
 * - **`TodoItem`、`TodoStatus`、`TODO_STATUSES`**（#1463 Q2 (a)）：本來就住在 core 的 `todo.ts`，這裡只是轉出，用不著另開一個
 *   `@nexus/todo`。`todo/write` 的事件擴充搬進 core 的 `session-log.ts`（同 `feedback/*`），遷出的插件因此不必對 core 寫
 *   `declare module`。
 * - **`PresentedFile`**（#1469 Q4 (a)）：本來就住在 core 的 `deliverables.ts`（`@nexus/wire` 與 web 都讀它），這裡只是轉出。
 *   `deliverables/presented` 的事件擴充搬進 core 的 `session-log.ts`（前例 `todo/write`），遷出的 `present` 因此不必對 core 寫
 *   `declare module`。
 *
 * 只放今天有消費者的東西（`packages/AGENTS.md`「Require a current owner and need」）：四個讀法只有 `trajectory` 在用；
 * 兩個日誌型別（`SessionLog`、`SessionEvent`）是 `feedback` 的（#1456）；查找與 todo 的名字是 `todo` 的（#1463）；
 * `currentTurnStart`、`sourceKwargs` 與 `SessionEventMap`（`turn/start` 酬載的型別）是 `goal` 的（#1486）。
 *
 * @module
 */

import type { SessionInstaller, SessionLookup } from '@nexus/core';
import { defineToken } from '@nexus/sdk';

export {
  loggedContentBlocks,
  loggedMessageId,
  REPEAT_REMINDER_MARKER,
  toolCallIds,
} from '@nexus/core';

// goal 要用的兩個讀寫日誌的小函式（#1486 Q4 (a)）：`currentTurnStart` 讀「這一輪從哪顆 `turn/start` 開始」（權限判準），
// `sourceKwargs` 造一則訊息的來源記號（收尾指示）。本來就住在 core，這裡單向轉出。
export { currentTurnStart, sourceKwargs } from '@nexus/core';

// time-context 要的兩支讀日誌的述詞（#1625）：「這一顆開不開新的邏輯輪」與「這一顆會不會進模型」（含 `compaction/summary`）。
// 本來就住在 core 的 `session-log.ts`，這裡單向轉出，插件不再自己重寫一份。
export { isLogicalTurnStart, isModelVisibleEvent } from '@nexus/core';

// 日誌的**型別**出口（#1456 Q4 (a)）：遷出的插件要在簽名裡寫 `SessionLog`／`SessionEvent`，但不能 import `@nexus/core`。
// 跟上面四個值同一個形狀：單向轉出，實作留在 `@nexus/core`；撤除條件同上（#1421 Q2 (b)）。
export type { SessionEvent, SessionEventMap, SessionLog } from '@nexus/core';

// 會話參與者的型別出口（#1491 Q2）：`join(participant)` 的參數型別與它收到的 subject（address、可寫的 log、唯讀的 rootLog、observe）。
export type { SessionInstaller, SessionSubject } from '@nexus/core';

// 會話查找的型別出口（#1463 Q2 (a)）：工具在簽名裡要寫 `SessionLookup` 與它帶的 `SessionAddress`，但不能 import `@nexus/core`。
export type { SessionAddress, SessionLookup } from '@nexus/core';

// 待辦清單的詞彙（#1463 Q2 (a)）：三個名字本來就住在 core 的 `todo.ts`，單向轉出。
export { TODO_STATUSES } from '@nexus/core';
export type { TodoItem, TodoStatus } from '@nexus/core';
// 交付物的詞彙（#1469）：`present` 的 `deliverables/presented` 酬載。
export type { PresentedFile } from '@nexus/core';

/**
 * 契約版本（semver）。介面破壞性改動跳 major，消費者的範圍擋下不相容的提供者。
 *
 * **1.1.0（[#1491](https://github.com/DemianLi/nexus-agent/issues/1491) Q2）**：多一個 `join`（會話參與者接縫），只增不減——`forCall` 的消費者
 * （`todo`、`present`、`goal`、`time-context`，範圍都是 `^1.0.0`）不受影響。
 */
export const SESSION_LOOKUP_CONTRACT_VERSION = '1.1.0';

/** 會話查找：這次工具呼叫該寫進哪一份會話日誌。 */
export interface SessionLookupService {
  /**
   * **模型工具問「我這次呼叫該寫進哪一份日誌」的地方**，dsh `exec.agent.session` 的對應物（偏離見檔頭）。
   *
   * 挑法與四種結果的意思見 {@link SessionLookup}：一張時行程級查找也核對 `thread_id`（#1482），多張依 `thread_id` 挑恰好一張。服務看的是**行程裡
   * 每一條活著的 thread**，所以多條 thread 同時活著時，**每一次呼叫都靠 `thread_id` 認出主人**——工具要把整個呼叫設定
   * （handler 的第二個參數）原樣傳進來，不能只傳它自己覺得有用的欄位。
   *
   * **在呼叫當下才呼叫它**；消費者在 `apply` 當下把這個服務抓進閉包（列卸載之後經 `ctx` 取服務會拋，抓住的那份仍可呼叫）。
   *
   * @param invocation - 工具 handler 的第二個參數（`ToolRunnableConfig`）。
   */
  forCall(invocation: unknown): SessionLookup;

  /**
   * **登記一位會話參與者**（[#1491](https://github.com/DemianLi/nexus-agent/issues/1491) Q2 (a)）：這條 thread 的每一份會話日誌（root 與每次子代理）接上時，
   * 安裝函式被叫一次，拿到 `{ address, log, rootLog, observe }`。dsh `session/created` 的對應物——**接上就寫**：全新的會話把起始狀態
   * 釘進日誌（`@nexus/permission-presets` 釘起始組合）。
   *
   * ## 形狀照 #1469 Q1 (a)：折進 thread，不掛樹上的事件
   *
   * 要對**每條 thread** 生效的 listener 不能掛在樹上的 Cordis 事件上——列卸載會撤掉 listener，開著的 thread 就收不到。所以這裡只**登記**：
   * 宿主在組一條 thread 時，把登記者是某一列的那幾位折進那條 thread 的 `registry.sessions.join`，**位置就是那一列在清單上的位置**
   * （日誌上的事件順序靠它：`approval/policy` → `sandbox/mode` → `permission/preset`）。登記是 effect，列卸載時登記處自己撤；**已經折進去的
   * 不受影響**（只給新對話，決議 §3-2 第 6 條）。
   *
   * ## 安裝失敗的語意（偏離 dsh，R3）
   *
   * dsh 的 `session/created` listener 同步拋錯會**否決並回滾**這次接上；我們的參與者安裝失敗只記一行 warn、已經寫進日誌的收不回
   * （`@nexus/core` 的 `createSessionRunner`，append 是定案的）。**表達不出來的原因**：相容層的七位參與者本來就是這個語意。
   *
   * ## 契約
   *
   * - `subject.log` 是**這一份**日誌（可寫）。**不要自己 `log.subscribe()`**，要看事件走 `subject.observe`。
   * - `subject.rootLog` 是這條 thread 的 root 日誌，**唯讀**。參與者不能經由它寫 root：「誰往 root 日誌寫 `sandbox/mode`／`approval/policy`，
   *   誰就移得動 fence 與閘門」（#1494）靠這一點成立。
   * - 參與者自己決定管不管這一份（`subject.address.kind`）；沒看的下場是每次子代理上多長一份自己。
   *
   * @param participant - 安裝函式；回傳的收尾函式在這份日誌的接線收掉時叫。
   * @returns 撤掉這次登記的函式（列卸載時也會自動撤）。
   */
  join(participant: SessionInstaller): () => void;
}

/** `sessionLookup` 服務的 token。 */
export const sessionLookupToken = defineToken<SessionLookupService>(
  'sessionLookup',
  SESSION_LOOKUP_CONTRACT_VERSION,
);
