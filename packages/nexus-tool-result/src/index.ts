/**
 * `@nexus/tool-result`：工具結果的**寫法**這個定義套件（決議 §3-4 第 16 條，dsh 的三角色紀律；
 * [#1458](https://github.com/DemianLi/nexus-agent/issues/1458) Q4 (a)，Part of #1385）。
 *
 * 遷出的插件要回「這次呼叫沒有生效」的工具結果、認出這次呼叫的 `tool_call_id`、替結果標上日誌讀的錯誤碼，但**不能 import
 * `@nexus/core`**（決議 §3-4 第 17 條：外部插件只相依 SDK 與服務定義套件；#1420 的 lint 擋它）。dsh 的對應是工具作者從
 * `tools` 套件拿 `toolErrorResult` 與 `ToolErrorInfo`；這個套件就是那個位置。
 *
 * ## 為什麼不放 `@nexus/tools`、`@nexus/sdk`、`@nexus/session`
 *
 * - `@nexus/tools` 是**登記處接縫**的定義（token、`register`），它的測試釘死相依只有 `@langchain/core`；放進來會讓
 *   「只想註冊工具的消費者」連帶背上 core 的 peer。
 * - `@nexus/sdk` 是插件規範本身（manifest、token、一致性套件），決議第 17 條要它不相依 core。
 * - `@nexus/session` 是會話日誌的**讀法**（投影單元讀日誌）；這三個值是工具結果的**寫法**，兩邊的消費者不同，放一起名實不符。
 *
 * ## 偏離登記：只做單向轉出，實作留在 `@nexus/core`（同 `@nexus/session`，#1435 Q1 (c)）
 *
 * `markToolError` 與 `toolErrorOf` 共用 core 模組層的同一張 `WeakMap`（日誌讀的就是它），實作搬出來會出現兩張表、
 * 兩份「工具錯誤」的判準（#1458 Q4 (b) 不選的理由）。所以（抽出實作是橫跨核心的一刀，表達不出來，退到最接近的實作，同 `@nexus/session`、`@nexus/projections`）：
 *
 * - 三個值**留在 `@nexus/core`，由這個套件單向轉出**。相依是單向的：這個套件相依 `@nexus/core`，core 不 import 它。
 * - **`@nexus/core` 放 `peerDependencies`，`devDependencies` 留 `workspace:*`**（#1421 PM 決策 3）：不能讓安裝結果出現第二份
 *   core——兩份 core 就是兩張 `WeakMap`，標上去的碼日誌讀不到。
 * - **撤除條件**：SDK 與定義套件要發布到私有 registry 之前，把這三個值的實作連同 `toolErrorOf` 一起搬進這個套件
 *   （屆時 core 改從這裡 import）。
 *
 * 只放今天有消費者的東西（`packages/AGENTS.md`「Require a current owner and need」）：三個值與一個型別今天的消費者只有
 * `@nexus/plugin-ask-user`。`callThreadId` 不在這裡——`ask-user` 在 #1458 Q1 (c) 之後不再依 thread 查答題管道，
 * 它沒有消費者；等逐條 thread 的提供者出現時隨查詢一起加回來（見 `docs/plugin-contract.md`）。
 *
 * @module
 */

export { markToolError, toolCallIdOf, toolRefusal } from '@nexus/core';

// 錯誤碼的型別：`markToolError` 的第二個參數、`rootOnly` 拒絕樁的 `error`。
export type { ToolErrorInfo } from '@nexus/core';
