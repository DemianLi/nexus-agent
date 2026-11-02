/**
 * `@nexus/fs`：**工具在呼叫當下拿到「這條 thread 的 fs」** 這個接縫的定義套件（決議 §3-4 第 16 條，dsh 的三角色紀律；
 * [#1466](https://github.com/DemianLi/nexus-agent/issues/1466) Q2 (a)、Q2-1 (a)，Part of #1385；逐條 thread 接縫的第四段，
 * #1418 → #1458 → #1463 → 這張）。
 *
 * 要讀寫工作區檔案的工具（`submit_record`；之後是 `present`）要拿的是**工具實際讀寫的那一個 backend**。但那個 backend 是
 * **逐條 thread 的物件**：會話歷史與工具結果暫存的路由帶 thread 的鑰匙，`--workspace` 下的 fence
 * （`SandboxModeController`，`/permission` 切的就是它）綁在每條 thread 各一顆的 controller 上。所以行程級的單例做不到，
 * 工具要在**呼叫當下**依這次呼叫屬於哪一條 thread，找回那條 thread 自己的把手。
 *
 * | 角色 | 是誰 | 依賴什麼 |
 * | --- | --- | --- |
 * | 定義 | 這個套件主入口：`fsToken`、{@link FsLookupService}、{@link FsLookup}，與 `FsService`、`virtualPathOf` 的單向轉出 | `@nexus/sdk`，與 `@nexus/core`（只轉出，不寫實作） |
 * | 提供者 | 樹上一列內建列，行程級（`@nexus/fs/provider`），**由宿主把「這次呼叫找哪一條 thread 的把手」的挑法交給它** | 這個套件、`@nexus/sdk` |
 * | 消費者 | 要讀寫工作區的模型工具，今天是 `submit-record` | **只有這個套件**與 `@nexus/sdk`，永不 import 提供者 |
 *
 * ## 偏離 dsh（AGENTS.md 的偏離規則）
 *
 * **哪一條**：dsh 的 `fs` 是行程全域一份的 Cordis 服務（`packages/fs/fs/src/index.ts:45-48`、`:87-90`；提供者是
 * `fs-local` 與 `fs-sandbox` 兩種），工具 `inject: ['fs', …]`（`packages/fs/tool-fs/src/index.ts:23`）後從閉包取用；**每個 agent 不同的東西在呼叫當下以參數傳入**：
 * cwd 來自 `ctx.workingDirectory.ensure(exec.agent, …)`（`session-cwd.ts:23`），沙箱政策是 `sandbox.resolvePolicy(…)` 的結果、當成 `writeText` 的參數
 * （`write.ts:117-124`）。對讀版本 86a40220。dsh 沒有路由、沒有 mount，也沒有每個 agent 一份的 fs。
 *
 * **為什麼表達不出來**：我們每條 thread 的 backend 是 deepagents 的 `CompositeBackend`，路由（會話歷史、工具結果暫存、附件、
 * plugin 的 `backend.mount()`）與 fence 都**綁在每次組裝新建的物件上**，沒有「同一個 fs、換參數」的介面；拆成「全域 fs＋每次
 * 呼叫的政策參數」等於重寫整層 backend，遷移卡做不到（#1466 Q2 (c)）。
 *
 * **退到什麼**：退到「**呼叫當下依 thread 找回那條 thread 自己的把手**」，與 {@link https://github.com/DemianLi/nexus-agent/issues/1463 | 會話查找}
 * 同一個形狀——同一張登記表（一次 `attachSession` 登記一筆，這一筆同時帶這條 thread 的會話註冊表與 fs 把手）、同一支挑法
 * （`@nexus/core` 的 `pickBoundForCall`）。**不另建 backend**：把手就是這次組裝 host-services 裡那一格 `fs` 服務。
 *
 * ## 偏離登記：型別只做單向轉出，實作留在 `@nexus/core`（同 `@nexus/session`）
 *
 * `FsService` 與它的 `createFsService`／`settleFsService`（fold 填值）住在 core 的 `fs-service.ts`；抽出實作是橫跨核心的一刀
 * （#1421 Q2 (b)），這張不做。所以這裡**只轉出型別**，`@nexus/core` 放 `peerDependencies`（不能讓安裝結果出現第二份 core）。
 * **撤除條件**：與 `@nexus/session`、`@nexus/projections` 同（Q2 (b)）。
 *
 * ## 只剩一筆登記時也核對 `thread_id`（#1482）
 *
 * 行程級的查找在**只剩一筆**登記時，呼叫帶了 `thread_id` 而那一筆不擁有它，回 `ambiguous`，不把唯一剩下的另一條 thread 當成它的主人
 * ——**對 fs 這是安全邊界**：fence 是每條 thread 各一顆，一條 thread 收尾途中還在飛的工具若被挑到別人身上，會寫進別人的 backend、
 * 套用別人的 fence。沒帶 `thread_id` 的呼叫與相容層的 `registry.sessions.forCall` 維持「只有一筆就是它」。挑法仍只寫在 core 的
 * `pickBoundForCall`；細節與收尾順序見 `docs/plugin-contract.md`。
 *
 * @module
 */

import type { FsService, SessionAddress } from '@nexus/core';
import { defineToken } from '@nexus/sdk';

// 型別出口（#1466 Q2-1 (a)）：工具要在簽名裡寫 `FsService`，但不能 import `@nexus/core`。單向轉出，實作留在 core。
export type { FsService, SessionAddress } from '@nexus/core';

// 路徑換算（#1469 Q4 (a)）：把模型給的路徑換成 backend 命名空間裡的虛擬路徑（相對路徑以工作區根為起點、`..` 夾回根）。
// 它是 backend 命名空間的規則，跟 fs 走，所以放這裡而不放 `@nexus/tool-result`。單向轉出，實作留在 core（讀檔路由與
// workspace-changes 共用那一份，不在這裡另寫）。
export { virtualPathOf } from '@nexus/core';

// 路由前綴的判斷（#2082）：「在不在 `offWorkspacePrefixes()` 某一個底下」跟上面同一個理由跟 fs 走，實作同樣留在 core。
export { isUnderAnyPrefix } from '@nexus/core';

/**
 * 契約版本（semver）。介面破壞性改動跳 major，消費者的範圍擋下不相容的提供者。
 *
 * `1.1.0`（#1469）：`FsService` 多 `hasWorkspace()`，`offWorkspacePrefixes()` 把 plugin 用 `backend.mount()` 掛的前綴也併進來
 * （兩樣都在 fold 填 backend 的同一處算）；另轉出 `virtualPathOf`。向後相容的新增：只用 `backend()` 的消費者
 * （`submit-record`，宣告 `^1.0.0`）照常。
 *
 * `1.2.0`（[#1491](https://github.com/DemianLi/nexus-agent/issues/1491) Q4 (a)）：`FsLookupService` 多 `workspaceRoot()`——**行程級**的工作區事實
 * （主機上的可寫根；沒給 `--workspace` 是 `undefined`），由入口建樹時交進來，`permission-presets` 在 `apply` 當下據它決定掛不掛 `/permission`、
 * 並在 `/permission` 不帶引數時報可寫根。
 *
 * `2.0.0`（[#1774](https://github.com/DemianLi/nexus-agent/issues/1774)，重開 #1491 Q4 (a) 的「主機上的可寫根」那一半，demian 2026-10-20 拍板）：
 * **可寫根從行程級的一格改成逐條 thread 的一格**。破壞性改動，所以跳 major：
 *
 * - `FsLookupService.workspaceRoot()` **拿掉**，換成 `hasContainment()`——行程級只留「有沒有圍堵」這一格（`apply` 當下就要知道，不依 thread 挑）。
 * - `FsService.workspaceRoot()`（`@nexus/core`）：**這條 thread** 的可寫根，跟 `hasWorkspace()` 並列，fold 當下一起算。
 * - `FsLookupService.forThread(threadId)`：依 root 會話 id（＝thread id）**精確**找回那條 thread 的把手，給手上沒有工具呼叫設定、只有
 *   `sessionLog` 的命令 handler 用（`/permission` 不帶引數時報這條 thread 的根）。**不套「只剩一筆就是它」的退路**：fs 是安全邊界（#1482），
 *   查不到就是 `undefined`，不猜。
 *
 * 這一版不改任何行為：每條 thread 拿到的仍是 `--workspace` 解析出來的那一個根；每條 thread 配自己的根是之後的事。消費者的範圍一起跳到 `^2.0.0`。
 *
 * `2.1.0`（[#1775](https://github.com/DemianLi/nexus-agent/issues/1775)）：`FsService` 多 `sharedWorkspacePrefix()`——新 thread 有私有可寫根、
 * `--workspace` 退成唯讀共用區時，共用區在模型位址空間裡的前綴（沒有共用區是 `undefined`）。向後相容的新增：只用 `backend()`／`workspaceRoot()` 等
 * 既有方法的消費者（`^2.0.0`）照常；要讀共用區的消費者（`agent-instructions`、`skill-invocation`）宣告 `^2.1.0`。
 *
 * `2.2.0`（[#1919](https://github.com/DemianLi/nexus-agent/issues/1919)）：`FsService` 多 `skillSources()`——這條 thread 要掃的技能來源，就是
 * 折進這次組裝、模型清單用的那一份（有共用區的 thread 已換到共用區底下）。向後相容的新增；`skill-invocation` 讀它，宣告 `^2.2.0`。
 */
export const FS_LOOKUP_CONTRACT_VERSION = '2.2.0';

/**
 * 找這次呼叫那條 thread 的 fs 把手的結果。
 *
 * 形狀對應 {@link https://github.com/DemianLi/nexus-agent/issues/1463 | 會話查找}（`SessionLookup`）的四種：成功帶的是
 * **把手**而不是日誌。工具對三種失敗**一律同一句話**（`submit-record` 的 `SUBMIT_RECORD_NO_BACKEND_MESSAGE`，#1466 Q3）；
 * 分開成不同的 `kind` 是給宿主與測試看的，不是給模型看的。
 */
export type FsLookup =
  /** 找到了：這條 thread 的把手，與這次呼叫在那條 thread 裡的位址。 */
  | { readonly kind: 'ok'; readonly fs: FsService; readonly address: SessionAddress }
  /** 行程裡沒有任何一條 thread 登記過（沒綁、組裝點沒接 `attachSessions`、或已經撤了）。 */
  | { readonly kind: 'not-attached' }
  /** 找到了 thread，但呼叫設定算不出位址（沒有 `configurable`、`checkpoint_ns` 不認得）。 */
  | { readonly kind: 'unknown-caller' }
  /** 不只一條 thread 活著，而呼叫沒帶（或帶了誰都不認得的）`thread_id`。`count` 是活著的 thread 數。 */
  | { readonly kind: 'ambiguous'; readonly count: number };

/** fs 查找：這次工具呼叫該讀寫哪一條 thread 的 backend。 */
export interface FsLookupService {
  /**
   * **模型工具問「我這次呼叫該用哪一個 fs」的地方**，dsh `ctx.fs` 的對應物（偏離見檔頭）。
   *
   * 挑法與四種結果的意思見 {@link FsLookup}。服務看的是**行程裡每一條活著的 thread**，所以多條 thread 同時活著時，
   * **每一次呼叫都靠 `thread_id` 認出主人**——工具要把整個呼叫設定（handler 的第二個參數）原樣傳進來。
   *
   * 回來的把手的 {@link FsService.backend} **也要在呼叫當下才讀**（fold 之前是 `undefined`）。消費者在 `apply` 當下把這個服務
   * 抓進閉包（列卸載之後經 `ctx` 取服務會拋，抓住的那份仍可呼叫）。
   *
   * @param invocation - 工具 handler 的第二個參數（`ToolRunnableConfig`）。
   */
  forCall(invocation: unknown): FsLookup;

  /**
   * **依 thread 精確找回那條 thread 的 fs 把手**（#1774）。給手上沒有工具呼叫設定的呼叫端用——今天是命令 handler，它只有 `sessionLog`
   * （其 `sessionId` 就是 root 會話 id＝thread id）。
   *
   * 跟 {@link forCall} 的差別：**不挑、不退路**。`threadId` 沒有登記（沒綁、已撤、或是別的行程的 id）就是 `undefined`，即使行程裡只剩一條活著的
   * thread 也不把它當成答案——fs 是安全邊界（#1482），猜錯是讀到別條 thread 的根。
   *
   * @param threadId - root 會話 id（＝thread id）。
   * @returns 那條 thread 的把手；沒有登記是 `undefined`。把手的 {@link FsService.workspaceRoot} 與 {@link FsService.backend} 都要在呼叫當下才讀。
   */
  forThread(threadId: string): FsService | undefined;

  /**
   * **這個行程有沒有圍堵**（給了 `--workspace`）。行程級、整台一份，由入口建樹時交進來（前例 #1458 的 `channel`）。
   *
   * 它回答的是 `apply` 當下就要知道的事（「要不要掛 `/permission`」），所以不依 thread 挑、不需要呼叫設定。**不回根**：根是逐條 thread 的，
   * 從 {@link FsService.workspaceRoot} 讀（{@link forCall}、{@link forThread} 取得把手）。要問**這一條 thread** 有沒有工作區用 {@link FsService.hasWorkspace}。
   */
  hasContainment(): boolean;
}

/** `fs` 服務的 token。 */
export const fsToken = defineToken<FsLookupService>('fs', FS_LOOKUP_CONTRACT_VERSION);
