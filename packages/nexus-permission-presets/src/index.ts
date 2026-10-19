/**
 * `@nexus/permission-presets`：權限組合這個**服務**的定義套件（決議 §3-4 第 16 條；
 * [#1491](https://github.com/DemianLi/nexus-agent/issues/1491)，Part of #1385）。形狀照 `@nexus/feedback`、`@nexus/goal`。
 *
 * ## 插件提供、宿主消費
 *
 * | 角色 | 是誰 | 依賴什麼 |
 * | --- | --- | --- |
 * | 定義 | 這個套件：token、{@link PermissionPresetsService}、起始請求與結果的型別、契約版本 | `@nexus/sdk`，與 `@nexus/core`、`@nexus/wire` 的詞彙（見下） |
 * | 提供者 | `@nexus/plugin-permission-presets`，樹上一列函式插件 | 這個套件、`@nexus/sdk`、`@nexus/session`、`@nexus/commands`、`@nexus/projections` |
 * | 消費者 | 宿主（`apps/harness`）：組一條 thread 時從折進來的 `registry.services` 取它，叫 {@link PermissionPresetsService.start} | 這個套件；**不 import 提供者套件**（決議 §3-4 第 16 條） |
 *
 * ## 偏離登記
 *
 * 1. **目錄是逐條 thread 的，dsh 整台共用**（Q3 (a)；類別：遷移卡不改行為（暫時））。dsh 的 `catalog()` 預設組只從設定或行程預設推
 *    （`packages/interaction/permission-presets/src/index.ts:293-299`，`86a40220`）；我們今天的預設組是**這條 thread 的起始值推出來的**
 *    （續接的 thread 沒設 `defaultPreset` 時，是日誌記著的那一組），wire 的 `permission.catalog` 逐條 thread 回。照 dsh 做會讓新會話的日誌多一顆
 *    `sandbox/mode`、續接的目錄預設組變動，都是行為改變，遷移卡不做。**撤除條件**：之後的權限卡定。
 * 2. **子代理的組名由會話參與者寫，dsh 由委派那一側（`subagent/subagent/src/child-agent.ts:248-279`）寫**（Q2-1；類別：基座表達不出來）。
 *    委派那一刻拍下沙箱那一格靠包住 `task` 的 `wrapToolCall` 與 ALS（`sandbox-policy`），樹上沒有包工具呼叫的接縫。**撤除條件**：
 *    `sandbox-policy` 遷上樹時一起做。
 * 3. **參與者安裝失敗只記 warn、已寫的收不回**（R3；類別：基座表達不出來）。dsh 的 `session/created` listener 同步拋錯會否決並回滾這次接上
 *    （`core/session/src/index.ts:1258-1286`）；相容層的七位會話參與者本來就是記 warn 的語意，`@nexus/session` 的 `join` 沿用。
 *    **撤除條件**：會話註冊表能在參與者拋錯時回滾這次接上（`registry.sessions` 與 `join` 一起改，連同相容層其餘的參與者同一天換）；在那之前單獨改這一位沒有意義。
 * 4. **起始值在宿主的組 thread 那一步算，不在參與者裡套**（Q3 (a)；類別：遷移卡不改行為（暫時））。dsh 在 `session/created` 上整組套預設；我們把「算出預設組」放進
 *    {@link PermissionPresetsService.start}（純函式，不碰日誌也不碰控制器），宿主據回傳值靜默切兩顆控制器，之後參與者才釘組名。
 *    好處是新會話的日誌只有一顆 `sandbox/mode`、順序逐字不變。
 *    **撤除條件**：兩顆控制器整個拿掉、fence 與閘門改讀日誌投影（#1491 Q1 (c)）時，宿主不再靜默切控制器，起始值就能直接由參與者往日誌套。
 * 5. **`/permission` 切換核准政策時不對模型注入一則使用者訊息**（類別：遷移卡不改行為（暫時））。dsh 的 `user-approval` 在政策變動時用
 *    `agent.inject` 排一則「The approval policy changed from … to … (changed by the user).」給下一步模型
 *    （`packages/interaction/user-approval/src/index.ts:184-187`，`687f282e`）；我們的 `/permission` 從相容層起就沒有這一步，遷移不改行為。
 *    這一條住在提供者（`@nexus/plugin-permission-presets` 檔頭第 8 條），登記在這裡是因為定義套件是偏離登記的總表（`docs/plugin-contract.md` 登記第 5 列）。
 *    **撤除條件**：之後的權限卡決定要不要補這則訊息（補了就是行為改變，要自己一張卡）。
 *
 * ## 相依
 *
 * 型別與常數（`SandboxMode`、`SANDBOX_MODES`、`ApprovalPolicyValue`、`APPROVAL_POLICIES`）留在 `@nexus/core`，由這個套件**單向轉出**
 * （照 `@nexus/projections` 的 #1421 Q2 (a)）；`PermissionCatalog` 取自 `@nexus/wire`（web 的協定也讀它）。**`@nexus/core`、`@nexus/wire`
 * 放 `peerDependencies`，`devDependencies` 留 `workspace:*`**。撤除條件併入 #1421 Q2 (b)。
 *
 * `permission/preset` 的事件宣告（`SessionEventMap`）住在 `@nexus/core` 的 `session-log.ts`（前例 `feedback/*`、`todo/write`），遷出的插件因此
 * 不必對 core 寫 `declare module`。
 *
 * 介面只放今天有消費者的東西（`packages/AGENTS.md`「Require a current owner and need」）。
 *
 * @module
 */

import type { ApprovalPolicyValue, SandboxMode } from '@nexus/core';
import { defineToken } from '@nexus/sdk';
import type { PermissionCatalog } from '@nexus/wire';

export { APPROVAL_POLICIES, SANDBOX_MODES } from '@nexus/core';
export type { ApprovalPolicyValue, SandboxMode } from '@nexus/core';
export type { PermissionCatalog } from '@nexus/wire';

/** 契約版本（semver）。介面破壞性改動跳 major，宿主的範圍檢查擋下不相容的提供者。 */
export const PERMISSION_PRESETS_CONTRACT_VERSION = '1.0.0';

/** 服務名：宿主讀折進 `registry.services` 的這個名字。 */
export const PERMISSION_PRESETS_SERVICE = 'permissionPresets';

/** 提供它的那一列在樹上的名字（`startupEntryMounted` 與必掛名單比的是它）。 */
export const PERMISSION_PRESETS_PLUGIN_NAME = 'permission-presets';

/** `/permission` 的命令名，不帶斜線。 */
export const PERMISSION_COMMAND_NAME = 'permission';

/**
 * 宿主交給插件的「這一次是怎麼開始的」。
 *
 * - `fresh`：這份日誌從零開始，沒有續接任何已記下的旋鈕。**只有 fresh 才套用預設組、才在對不上任何一組時報錯**；續接保留日誌裡的值，
 *   對不上就顯示 `custom`（照 dsh：續接的會話保留日誌裡的值，不套用預設）。
 * - `sandboxExplicit`：這一次的沙箱起始值是 `--sandbox` 明確給的（不是出廠預設）。`defaultPreset` 與它矛盾時啟動報錯。
 */
export interface PermissionSeed {
  readonly fresh: boolean;
  readonly sandboxExplicit: boolean;
}

/** {@link PermissionPresetsService.start} 的請求：這條 thread 組裝當下的起始狀態。 */
export interface PermissionStartRequest {
  readonly seed: PermissionSeed;
  /** 沙箱那顆旋鈕現在的值（宿主的控制器當下的格子）。 */
  readonly sandbox: SandboxMode;
  /** 核准那顆旋鈕現在的值。 */
  readonly approval: ApprovalPolicyValue;
}

/** {@link PermissionPresetsService.start} 的結果。 */
export interface PermissionStarted {
  /** 套完預設組之後沙箱旋鈕該有的值。fresh 且有 `defaultPreset` 時是那一組的值，否則原樣。 */
  readonly sandbox: SandboxMode;
  /** 套完預設組之後核准旋鈕該有的值。 */
  readonly approval: ApprovalPolicyValue;
  /** 這條 thread 的目錄，含預設組（偏離 1）。 */
  readonly catalog: PermissionCatalog;
}

/** 權限組合服務：宿主組一條 thread 時向它要起始值與目錄。 */
export interface PermissionPresetsService {
  /**
   * 決定這條 thread 的預設組，並算出兩顆旋鈕在**接上日誌之前**該有的值。**純函式：不碰日誌，也不碰控制器**——宿主拿回傳的值自己
   * 靜默切控制器（這時還沒有日誌接著，所以不寫事件；之後參與者接日誌時才把起始組合釘進去）。
   *
   * 呼叫時機：`createCliAgent` 裡、`createNexusAgent` 回來之後、回傳之前，每條 thread 一次。
   *
   * @throws 跟 `--sandbox` 矛盾（`defaultPreset` 的檔案政策與明確給的 `--sandbox` 不同）、或 fresh 的起始值對不上組合表裡任何一組又沒有設定
   *   `defaultPreset`。這兩種是逐條 thread 的錯；設定本身的錯（組合表是空的、組名是保留字、`defaultPreset` 不在表裡）在插件的 `apply` 就拋。
   */
  start(request: PermissionStartRequest): PermissionStarted;
}

/** `permissionPresets` 服務的 token。 */
export const permissionPresetsToken = defineToken<PermissionPresetsService>(
  PERMISSION_PRESETS_SERVICE,
  PERMISSION_PRESETS_CONTRACT_VERSION,
);
