/**
 * 清單上每一列「改了之後什麼時候生效」的分類（[#1406](https://github.com/DemianLi/nexus-agent/issues/1406)）。
 *
 * 依據 `.docs/plugin-reload-classification-2026-10-08.md`，**以 develop 今天的程式碼為準**：那份文件寫在 #669 把幾顆
 * 組裝點自己建的插件搬進清單之前，A 表的「出貨」欄與 R2／R3 那一段已經過期，已在同一張 PR 更正。
 *
 * ## 三個類別
 *
 * | 類別 | 改了之後 | 判定 |
 * |---|---|---|
 * | `startup-read` | 重啟才生效；新對話照舊用啟動時的值 | 值或掛沒掛變了（{@link snapshotsDiffer}，同 `reportStartupDrift`） |
 * | `mount-restart` | 掛不掛改了，要重啟才生效；設定改了仍是新對話生效 | 掛沒掛變了 |
 * | `next-thread` | 新對話生效 | 宣告變了（{@link rowKey}） |
 *
 * **只講設定與掛不掛，不講程式碼版本。** 重讀換不到程式碼（`import()` 有 ESM 快取，見 `thread-plugin-list.ts` 檔頭），換版本
 * 是版本路由的事（決議 §3-2 第 6 條）。所以「宿主 import 了這顆的值」不能讓它歸 `mount-restart`：宿主 import 的是純函式與
 * 常數（`renderGoalRoundPrompt`、`applyGoalEvent`、`recordedSandboxMode`、`*_SERVICE` 名字），那是程式碼版本的耦合，
 * 不是掛不掛的耦合。**判準是：home 層把那一列翻成 `disabled: true` 之後，下一條 thread 實際有沒有變。**
 *
 * ## `mount-restart` 目前是空的（PM 2026-10-12 拍板）
 *
 * 分類文件曾把 goal、sandbox-policy、workspace-changes 歸這一類（R2／R3）。逐顆對宿主核過，今天都不成立：
 *
 * - **goal**：`assembly-root.ts:1000` 每次組裝各從 services 拿一份 `goals`；`:1083-1095` 沒掛就是 `undefined`，排程器
 *   全用 `goals?.` 接；`serve.ts:938-941` 的 `goalDriver` 是那一條 thread 自己那次組裝的。
 * - **workspace-changes**：`assembly-root.ts:997` 每次組裝各取一份；`serve.ts:883`、`:905` 在 thread 組裝區塊裡，沒掛就
 *   缺席；`wire-handler.ts:1139`、`:2563`、`:2582` 讀的是 `ready.get(threadId)?.workspaceChanges`，一條 thread 一份。它是
 *   `cordis.serve.yml:17` 的一列，不是組裝點自己建的。
 * - **sandbox-policy**：控制器每條 thread 組裝時各建一個（`assembly-root.ts:820`）。**關掉它的後果不是「照舊」而是
 *   「建不起來」**：有 `--workspace` 又沒掛這一列，那條 thread 的組裝直接拋（`:803-809`），重讀之後每條新 thread 都是。
 *   這跟 #1405 Q1「必掛的列掉了，只讓這一條 thread 建不起來，大聲報出來」同一路，不另做處理。
 * - **permission-presets**（不在 PM 的 R2／R3 名單上，順手補記）：同一種後果，有 `--workspace` 又沒掛這一列，組裝一樣拋
 *   （`assembly-root.ts:811-818`）；它是 `/permission` 的唯一入口。
 *
 * `commands` 不是清單上的一列（`cordis.yml`／`cordis.serve.yml` 只有 `commands-invariant`），執行器是宿主自己建的
 * （`cli.ts:29`、`wire-handler.ts:126`），沒有可以切的列。
 *
 * 類別、判定與守衛測試照樣在：之後有哪一列真的是「掛不掛要重啟」，改一格就行。
 *
 * @module
 */

import { sessionPersistencePlugin } from '@nexus/core';
import type { NexusPlugin } from '@nexus/core';

import { browserSessionPlugin } from './settings/browser-session.js';
import { backgroundSubagentsPlugin } from './settings/background-subagents.js';
import { deliverableFilesPlugin } from './settings/deliverable-files.js';
import { downlinkPlugin } from './settings/downlink.js';
import { liveModelPlugin } from './settings/live-model.js';
import { memoryGaugePlugin } from './settings/memory-gauge.js';
import { projectionFlushPlugin } from './settings/projection-flush.js';
import { spillPolicyPlugin } from './settings/spill-policy.js';
import { subagentModelSelectionPlugin } from './settings/subagent-model-selection.js';
import { threadCapacityPlugin } from './settings/thread-capacity.js';
import { threadSearchPlugin } from './settings/thread-search.js';
import { threadTitleLlmPlugin } from './settings/thread-title-llm.js';
import { threadTitlePlugin } from './settings/thread-title.js';
import { toolResultStashPlugin } from './settings/tool-result-stash.js';
import { toolTextPlugin } from './settings/tool-text.js';

/** 一列改了之後什麼時候生效。 */
export type RowClass = 'startup-read' | 'mount-restart' | 'next-thread';

/**
 * 起動期讀一次的那幾顆（`startupSetting`／`startupEntryMounted` 的呼叫者在 `serve.ts` 起動那一段）。
 *
 * **`startup-read` 這一類只從這份名單來**，分類表不再抄一次：兩邊各寫一次就是兩份真相。`default-model` 不在這裡：
 * 非 `--live` 時它在每條 thread 組裝時讀（`assembly-root.ts:527`），`--live` 時不經過它（`:750`）。
 */
export const STARTUP_READ_PLUGINS: readonly NexusPlugin<unknown>[] = [
  browserSessionPlugin,
  threadTitlePlugin,
  deliverableFilesPlugin,
  sessionPersistencePlugin,
  toolTextPlugin,
  projectionFlushPlugin,
  toolResultStashPlugin,
  spillPolicyPlugin,
  backgroundSubagentsPlugin,
  liveModelPlugin,
  subagentModelSelectionPlugin,
  threadTitleLlmPlugin,
  threadSearchPlugin,
  threadCapacityPlugin,
  memoryGaugePlugin,
  downlinkPlugin,
] as readonly NexusPlugin<unknown>[];

/** 表上的一格。 */
export interface RowClassEntry {
  /** 只會是 `next-thread` 或 `mount-restart`；`startup-read` 由 {@link STARTUP_READ_PLUGINS} 決定。 */
  readonly class: Exclude<RowClass, 'startup-read'>;
  /** 要讀的人注意的一句；沒有就省略。`mount-restart` 一律要寫理由。 */
  readonly note?: string;
}

const next: RowClassEntry = { class: 'next-thread' };

/**
 * 出貨清單（`cordis.yml`、`cordis.serve.yml`）每一列的分類，以列 id 為鍵。
 *
 * **起動期讀的那幾列不在這張表上**，它們由 {@link STARTUP_READ_PLUGINS} 決定；守衛測試（`plugin-row-classes.test.ts`）
 * 要求出貨的每一列恰好在其中一邊，漏了是紅，兩邊都有也是紅。表上沒有的列（使用者 `insert` 進來的）一律當
 * `next-thread`：重讀會讓它掛上，這是 #1405 的行為。
 */
export const ROW_CLASSES: ReadonlyMap<string, RowClassEntry> = new Map<string, RowClassEntry>([
  // ── 出貨的插件（分類文件 A 表）：程式碼住在套件裡，狀態全在 `apply` 裡，每條 thread 各掛一份。
  ['echo', next],
  ['agent-instructions', next],
  ['skills', next],
  ['plan-mode', next],
  ['goal', next],
  ['todo', next],
  ['feedback', next],
  ['present', next],
  ['ask-user', next],
  ['submit-record', next],
  ['trajectory', next],
  ['token-meter', next],
  ['system-prompt', next],
  ['workspace-changes', next],
  [
    'sandbox-policy',
    {
      class: 'next-thread',
      note:
        '有 --workspace 時關掉它，之後每條新 thread 都建不起來（assembly-root.ts:803-809 拋錯），不是照舊。' +
        '沒有 --workspace 時關掉是合法的，只剩那一句政策。',
    },
  ],
  // ── `@nexus/core/*`（分類文件 B 表）：設定在組裝期從服務讀。
  ['repeat-reminder', next],
  ['tool-result-pruner', next],
  ['summarization', next],
  ['observation-policy', next],
  ['model-usage', next],
  ['session-checkpoint-policy', next],
  ['approval-gate', next],
  // ── `#settings/*` 與模型提供者（分類文件 C 表）：組裝期讀的那幾列。
  ['agent-loop', next],
  ['recursion-limit', next],
  ['tool-fs-search', next],
  [
    'agent-default-model',
    { class: 'next-thread', note: '非 --live 時每條 thread 組裝才讀（assembly-root.ts:527）。' },
  ],
  ['cli-script', next],
  [
    'permission-presets',
    {
      class: 'next-thread',
      note:
        '有 --workspace 時關掉它，之後每條新 thread 都建不起來（assembly-root.ts:811-818 拋錯），不是照舊。' +
        '它是 /permission 的唯一入口。沒有 --workspace 時關掉是合法的。',
    },
  ],
  // ── invariant 配套（分類文件 D 表）：隨所屬套件走，所屬的都是 next-thread。
  ['core-invariant', next],
  ['commands-invariant', next],
  ['goal-invariant', next],
  ['plan-mode-invariant', next],
  ['present-invariant', next],
  ['workspace-changes-invariant', next],
  ['sandbox-policy-invariant', next],
  ['todo-invariant', next],
]);

/**
 * 一列屬於哪一類。
 *
 * @param id - 列 id。
 * @param pluginName - 那一列解析出來的插件名；模組那一步就掉了的列沒有。
 * @returns 類別。
 */
export function classOfRow(id: string, pluginName: string | undefined): RowClass {
  if (
    pluginName !== undefined &&
    STARTUP_READ_PLUGINS.some((plugin) => plugin.name === pluginName)
  ) {
    return 'startup-read';
  }
  return ROW_CLASSES.get(id)?.class ?? 'next-thread';
}
