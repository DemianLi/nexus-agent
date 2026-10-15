/**
 * `@nexus/session`：會話日誌的**讀法**這個定義套件（決議 §3-4 第 16 條，dsh 的三角色紀律；
 * [#1435](https://github.com/DemianLi/nexus-agent/issues/1435)，Part of #1385）。
 *
 * 投影單元（`trajectory`、`token-meter`……）要讀會話日誌裡的訊息、模型呼叫與 repeat-reminder 標記，但**不能 import
 * `@nexus/core`**（決議 §3-4 第 17 條：外部插件只相依 SDK 與服務定義套件；#1420 的 lint 擋它）。dsh 的對應是投影從
 * `dsh-session` 拿日誌的讀法；這個套件就是那個位置。
 *
 * ## 偏離登記：只做單向轉出，實作留在 `@nexus/core`（#1435 Q1 (c)）
 *
 * dsh 的 `dsh-session` 持有日誌的型別與讀法的**實作**；抽出實作是橫跨整個核心的一刀（`session-log.ts`、`logged-message.ts`
 * 都要動，會跟每一張碰會話日誌的卡相撞，#1421 Q2 (b)），這一張不做。所以：
 *
 * - 下面四個值**留在 `@nexus/core`，由這個套件單向轉出**。相依是單向的：這個套件相依 `@nexus/core`，core 不 import 它。
 *   插件只 import 這個套件，所以 lint 與決議第 17 條在插件這一側都成立；日後把實作搬進來時，插件一行不改。
 * - **`@nexus/core` 放 `peerDependencies`，`devDependencies` 留 `workspace:*`**（#1421 PM 決策 3）：不能讓安裝結果出現第二份
 *   core，理由同 `@nexus/sdk` 放 peer。
 * - **撤除條件**：SDK 與定義套件要發布到私有 registry 之前，把這四個值的實作搬進這個套件（#1421 Q2 (b)）；屆時
 *   `SessionEvent`、`isLogicalTurnStart` 也從 `@nexus/projections` 移來這裡，`@nexus/projections` 改成從這裡轉出。
 *
 * 只放今天有消費者的東西（`packages/AGENTS.md`「Require a current owner and need」）：四個值只有 `trajectory` 在用；兩個型別（`SessionLog`、
 * `SessionEvent`）是 `feedback` 的（#1456，插件的簽名要寫它們）。
 *
 * @module
 */

export {
  loggedContentBlocks,
  loggedMessageId,
  REPEAT_REMINDER_MARKER,
  toolCallIds,
} from '@nexus/core';

// 日誌的**型別**出口（#1456 Q4 (a)）：遷出的插件要在簽名裡寫 `SessionLog`／`SessionEvent`，但不能 import `@nexus/core`。
// 跟上面四個值同一個形狀：單向轉出，實作留在 `@nexus/core`；撤除條件同上（#1421 Q2 (b)）。
export type { SessionEvent, SessionLog } from '@nexus/core';
