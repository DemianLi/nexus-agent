/**
 * `@nexus/subprocess`：插件自己起子行程時要用的兩支宿主函式（[#2544](https://github.com/DemianLi/nexus-agent/issues/2544)）。
 *
 * 遷出的插件不能 import `@nexus/core`（外部插件只相依 SDK 與服務定義套件，#1420 的 lint 擋它），但起子行程時要跟宿主
 * 用同一套規則：
 *
 * - `scrubbedParentEnv`：子行程的基底環境。不分大小寫地拿掉名字像憑證的與 `NEXUS_*` 變數；省略參數、讀 `process.env` 時，
 *   行程裝了代理就再疊上代理那一層。
 * - `trackHostExitChild`：登記子行程，宿主行程結束時同步強殺。
 *
 * ## 只做單向轉出，實作留在 `@nexus/core`
 *
 * 兩支都用 core 模組層的行程級狀態：前者用代理的安裝狀態（`http-proxy/install.ts` 的 `proxyEnvironmentForChild`），後者用
 * 行程結束時要殺的那一張登記表。複製一份就是兩份狀態：代理沒裝在複製的那份上，子行程只拿到這個行程正規化過的代理值、少了
 * `NODE_USE_ENV_PROXY`，子行程裡的 Node 會直連。所以（同 `@nexus/tool-result`）：
 *
 * - 實作**留在 `@nexus/core`，由這個套件單向轉出**。這個套件相依 core，core 不 import 它。
 * - **`@nexus/core` 放 `peerDependencies`，`devDependencies` 留 `workspace:*`**：不能讓安裝結果出現第二份 core。
 * - **撤除條件**：SDK 與定義套件要發布到私有 registry 之前，改成宿主經服務把這兩支交給插件，插件不再於執行期載入 core。
 *
 * 只放今天有消費者的東西：`@nexus/plugin-mcp`（起 stdio server）與 `@nexus/plugin-workspace-changes`（git 的環境與找執行檔用
 * `scrubbedParentEnv`，只給測試的 `directGitStarter` 用 `trackHostExitChild`）。後者還沒套 SDK 的 lint，其他檔仍從 core 取東西。
 *
 * @module
 */

export { scrubbedParentEnv, trackHostExitChild } from '@nexus/core';
