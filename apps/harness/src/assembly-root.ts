/**
 * 兩個入口（CLI 與 serve）共用的**組裝根**（[#697](https://github.com/DemianLi/nexus-agent/issues/697)）。
 *
 * `createCliAgent` 把一份 plugin 清單、模型、圍堵、落盤與標題接成一個可以跑的 agent；`cli.ts` 與 `serve.ts` 各自擁有
 * 輪迴圈與會話接線，但組裝只有這一份。以前它住在 `cli.ts`，serve 為了它反向相依 CLI 入口檔（`cli.ts` 有 `main()`，
 * 只靠檔尾守衛才不會在被 import 時跑起來），而 patch 載進來的 plugin 若靜態 import `cli.js` 會卡在 unsettled top-level
 * await、以 13 退出（見 `cli-invariant-violation.fixture.ts`）。
 *
 * 照 dsh 的顆粒度：入口檔很薄，共用的開機邏輯住在沒有 main 的獨立模組（`apps/cli/src/profile-boot.ts`，自述
 * “Shared profile boot for every `dsh` surface”，`477b4f4`）。**方向只能是入口檔指向這裡**：這個模組不 import
 * `cli.ts` 也不 import `serve.ts`（`import type` 也不行）。
 *
 * 純搬家，不改行為。`SYSTEM_PROMPT` 的措辭是「命令列助手」，組裝點無條件傳它，所以 serve 也用這份——照原字搬，
 * 改措辭是模型看得到的行為變更，不在這一張。
 */

import { basename, dirname, join, resolve } from 'node:path';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { PrunedMemorySaver } from './pruned-memory-saver.js';
import type {
  ApprovalPolicy,
  CommandRegistrationPoint,
  ProjectionRegistrationPoint,
  FeedbackService,
  InvariantError,
  InvariantTap,
  ModelRoute,
  PluginEntry,
  PluginWarning,
  SessionEvent,
  SessionTelemetrySharingStatus,
  SpillStore,
} from '@nexus/core';
import type { ColdChildStore } from './background-cold.js';
import type { BackgroundParentPort, ModelChoice } from './background-subagents.js';
import { composeAttachSessions } from './session-attach.js';
import type { AttachSessions } from './session-attach.js';
import type { SessionLookupRegistrar } from './thread-sessions.js';
import { backgroundSubagentsPlugin } from './settings/background-subagents.js';
import { liveModelPlugin, streamRetryOptionsOf } from './settings/live-model.js';
import type { LiveModelConfig } from './settings/live-model.js';
import { startupEntryMounted, startupSetting } from './settings/startup.js';
import { threadTitlePlugin } from './settings/thread-title.js';
import type { ThreadTitleConfig } from './settings/thread-title.js';
import { declaresOffEffort, findModelEntry, singleDigitModelIds } from './model-catalog.js';
import { resolveDefaultModel } from './model-provider.js';
import type { ModelSelectionPolicy } from './model-selection-policy.js';
import { threadTitleLlmPlugin } from './settings/thread-title-llm.js';
import type { AttachmentStore } from './attachment-store.js';
import type { ToolResultStashOptions } from './tool-result-stash.js';
import type { ThreadTitleLlmConfig } from './settings/thread-title-llm.js';
import { createSessionTitleLlm } from './session-title-llm.js';
import type { AttachSessionTitleLlm } from './session-title-llm.js';
import { MCP_CREDENTIALS_SERVICE, MCP_POOL_SERVICE } from '@nexus/plugin-mcp';
import type { McpConnectionPool, McpCredentials } from '@nexus/plugin-mcp';
import {
  ApprovalPolicyController,
  type ApprovalPolicyValue,
  createHostServicesPlugin,
  SessionRegistry,
  deriveApprovalChannel,
  FS_SERVICE,
  type FsService,
  type SessionLog,
  TokenAnchorBook,
} from '@nexus/core';
import {
  HARNESS_HOME_DIR_NAME,
  HARNESS_HOME_ENV,
  HARNESS_SESSIONS_DIR_NAME,
  harnessInvariantLogPath,
  harnessSessionsDir,
  resolveHarnessHome,
} from './harness-home.js';
import { canonicalize, canonicalizeExisting, isWithin } from './canonical-path.js';
import { LEGACY_ENV_FILE, legacyEnvFileFor } from './launch-env.js';
import { DEFAULT_MAX_GOAL_ROUNDS, GOALS_SERVICE } from '@nexus/goal';
import type { GoalServices } from '@nexus/goal';
import { MCP_SANDBOX_SERVICE } from '@nexus/plugin-mcp';
import { GIT_STARTER_SERVICE, WORKSPACE_CHANGES_SERVICE } from '@nexus/plugin-workspace-changes';
import type { WorkspaceChanges } from '@nexus/plugin-workspace-changes';
import { assemblyDropErrorFor, createNexusAgent } from './agent-factory.js';
import { SHARED_WORKSPACE_PREFIX } from './thread-roots.js';
import type { GoalDriverPort, GoalRoundCap } from './goal-driver.js';
import type { AssemblyDrop, NexusAgentHandle } from './agent-factory.js';
import { isSandboxMode, SANDBOX_MODES, ContainedFilesystemBackend } from './contained-backend.js';
import { CONTAINED_FILESYSTEM, sandboxPolicyPlugin } from '@nexus/plugin-sandbox-policy';
import {
  PERMISSION_PRESETS_PLUGIN_NAME,
  PERMISSION_PRESETS_SERVICE,
} from '@nexus/permission-presets';
import type {
  PermissionCatalog,
  DelegationNarrowing,
  PermissionNarrowing,
  PermissionPresetsService,
} from '@nexus/permission-presets';
import { SandboxModeController } from '@nexus/plugin-sandbox-policy';
import type { SandboxMode } from './contained-backend.js';
import type { CredentialService } from './credentials.js';
import type { RequestGate } from './request-gate.js';
import { createLiveModel } from './live-model.js';
import { subagentDefinitionValidator } from './subagent-definition.js';
import { createModelSelectionHost, createModelSelectionPlugin } from './model-selection-host.js';
import type { ModelSelectionHost } from './model-selection-host.js';
import { createFileReferencePlugin } from './file-references.js';
import { createGitStarter } from './git-sandbox.js';
import { createMcpSandboxWrapper } from './mcp-sandbox.js';
import { sharedReservedWrites } from './shared-reserved-writes.js';

/** 一次呼叫解析出來的東西。`prompt` 缺席即 REPL。 */
export interface CliInvocation {
  /** 一次性模式要問的那句話。省略即進 REPL。 */
  readonly prompt?: string;
  /** 用真實供應商而不是假模型。 */
  readonly live: boolean;
  /**
   * 真實磁碟上的可寫根。給了就換成有路徑圍堵的 Disk backend，省略即跑在 state 裡的
   * 虛擬 FS（`StateBackend`，不碰磁碟）。
   */
  readonly workspace?: string;
  /**
   * 這一次呼叫的圍堵強度。省略即 `workspace-write`——**設防的那一個是預設**。
   *
   * **只有給了 `--workspace` 才有意義**：沒給的時候根本沒有 `ContainedFilesystemBackend`，
   * 檔案落在基座的 `StateBackend` 裡，這一格一個位元組都影響不到。所以兩者不成對是
   * **錯誤**，不是無害的多餘（同 `--max-goal-rounds` 那條規矩）——收下來會變成一個
   * 看起來設過、實際上什麼都沒圍到的模式。
   *
   * 預設值本身是 [#238](https://github.com/DemianLi/nexus-agent/issues/238) 第 0 項的定案：
   * 照 dsh 的出廠 preset（`workspace-write`），而**可寫根之內的寫入在這一格底下是放行的**。
   * 要它不放行就切到 `read-only`。
   */
  readonly sandbox?: SandboxMode;
  /**
   * 核准政策的起始那一格（`ask`／`never`，[#437](https://github.com/DemianLi/nexus-agent/issues/437)）。**只有續接會給，而且續接一定給**：從日誌最後一顆 `approval/policy` 讀回來（`recordedApprovalPolicy`），
   * 日誌沒記就是 `ask`，也就是 #437 以前的行為。所以「給了沒有」同時就是「這是不是續接」，`permission-presets` 據此分辨新會話與續接。
   * **新會話不給**：核准的起始值由 `sandbox` 推（全開＝`never`，其他＝`ask`）。
   * 沒有對應的命令列旗標——切換的入口是 `/permission`。
   */
  readonly approvalPolicy?: ApprovalPolicyValue;
  /**
   * 會話日誌落盤的根目錄，**換位置用**。這一次的每一份日誌寫進它底下的一個 run 目錄；
   * 省略即 harness home 底下的 `sessions`（{@link harnessSessionsDir}）。
   *
   * **預設落盤照 dsh**（[#444](https://github.com/DemianLi/nexus-agent/issues/444)，2026-09-19
   * 拍板）：dsh base 出廠就把會話寫進 `$DSH_HOME/sessions`。這裡以前是「預設不落盤，往家目錄寫
   * 由人決定」（[#172](https://github.com/DemianLi/nexus-agent/issues/172)），那是政策，不是偏離
   * 規則要的「表達不出來」，所以改掉。目錄 `0700`、檔 `0600` 照舊。
   *
   * **關掉落盤不是這個旗標的事**，是清單上 `session-persistence` 那一列的 `disabled: true`
   * （[#612](https://github.com/DemianLi/nexus-agent/issues/612)，同 dsh 拿掉
   * `session-persistence-jsonl` 那一列）。兩者同時給會當場拋，見 {@link assertPersistenceFlags}。
   */
  readonly sessionLog?: string;
  /**
   * 續接一個既有的 run 目錄——上一次 CLI 寫出來的那一個（預設在 harness home 的 `sessions` 底下）
   * （[#251](https://github.com/DemianLi/nexus-agent/issues/251) 的門 A）。
   *
   * **回來的是日誌上推得出來的**：沙箱模式、目標（授權打回 `disarmed`，要人 `/goal resume`）、
   * 計劃模式，以及對話——從日誌推回模型（[#306](https://github.com/DemianLi/nexus-agent/issues/306)，
   * 見 `conversation-restore.ts`），不是把 checkpointer 落盤（門 B 照舊不開）。**todo 沒有自己回來的
   * 狀態**：模型那一側沒有人讀 `todo/write` 重建它，模型是從推回來的對話裡那幾次 `todo_write` 記得它的。
   * （web 的清單面板讀它，#575，但那是畫面，不進模型。）
   * 虛擬檔案系統與摘要器的會話歷史檔（#348）回不來——它們只在 graph state 裡。工具結果暫存回得來
   * （#734）：它存在主機的私有目錄，續接用同一個 run 目錄當鑰匙。
   *
   * **不配 `--sandbox`**：模式從日誌來，兩個來源不管誰贏，另一個都是靜靜被丟掉——一個打了
   * `--sandbox read-only` 的人可能落在 `workspace-write` 裡。要換就接起來之後 `/permission`，
   * 那一次會記進日誌。**不配 `--session-log`**：續接就寫回那個目錄，給兩個等於兩個寫入
   * 目的地。
   */
  readonly resume?: string;
  /**
   * 一個 active 的目標沒達成時自己再開一輪（[#180](https://github.com/DemianLi/nexus-agent/issues/180)）。
   *
   * **CLI 預設關，而且那是一個決定不是保守**（serve 的預設是開，見下面 2026-10-07 那段）。dsh 的續行驅動器是「需要你刻意掛載的可選消費
   * 方」（`packages/goal/README.zh.md`），而我們的入口點擁有輪迴圈——**掛載的等價物就是
   * 這個旗標**。
   *
   * （2026-09-19 註：引文是 dsh 當時 README 的原話，但 dsh 的 base 其實出廠就掛著續行驅動器——
   * 「可選」指套件可以不掛，不是出廠關著。見 `.docs/plugin-architecture-gap-survey.md` §三第 18 列。
   * **2026-10-07（#445）重核的結論：預設只有 CLI 關，serve 預設開。** CLI 用 `HEADLESS_APPROVALS`，
   * 要核准的工具被確定性拒絕，續行只會一再撞同一個拒絕空轉；serve 要核准時停下來等人，沒有
   * 這個問題。所以這個欄位在兩個入口的預設相反，旗標名同一個：CLI `--goal-driver` 開、
   * serve `--no-goal-driver` 關。）
   *
   * 開著的時候有兩條硬上限，先到的那一條管：那個目標自己的 `max_goal_rounds`，與操作者給的那一條（下面的
   * `maxGoalRounds`，或 `goal-round-cap` 那一列，#1623）。「連續 N 輪沒進展就停」那條停損刻意沒做，理由在 `goal-driver.ts` 檔頭。
   */
  readonly goalDriver: boolean;
  /**
   * 命令列的 `--max-goal-rounds`：人每授權一次（建立或恢復目標），續行最多再排幾輪（#1623 起每次授權重新起算，不比累計）。
   * 省略即沒給，這時 `goal-round-cap` 那一列有值就用它，那一列也關掉才只剩目標自己那一條。
   *
   * **它存在的理由是目標自己那條上限不歸操作的人管**：`service.ts:254` 是
   * `request.maxGoalRounds ?? this.#defaultMaxGoalRounds`——`??` 不是 `Math.min`，所以
   * 模型在 `create_goal` 裡填的數字贏過組裝點給的預設。這一格是**模型改不動的那一個**，
   * 完整理由在 `goal-driver.ts` 檔頭。
   *
   * **沒開 `--goal-driver` 就給它是錯誤，不是無害的多餘**：它唯一的消費者是那支迴圈，
   * 收下來會變成一個看起來設過、實際上一輪都限制不到的上限。
   */
  readonly maxGoalRounds?: number;
  /**
   * 這一次呼叫的 agent 迴圈上限，單位是 LangGraph 的 super-step。
   *
   * **省略不等於內建預設**（[#362](https://github.com/DemianLi/nexus-agent/issues/362)／
   * [#529](https://github.com/DemianLi/nexus-agent/issues/529)）：省略之後由組裝點的三態決定
   * ——plugin 清單上 `recursion-limit` 那一列講了就用它的，連那一列都沒有才是
   * `DEFAULT_RECURSION_LIMIT`。**這個旗標在場時永遠贏過那一列**，跟 #456 那三列同一條規則。
   *
   * **產品預設不動，這一格是給呼叫端明著傳的。** 100 是「跑掉了」的界線，對一般任務是對的
   * 校準；需要更長的呼叫端（Proteus 的 adapter）自己傳一個大的，那時那個數字出現在呼叫端
   * 的指令裡而不是沒有人設過。照 dsh 的房規：會隨部署變的選擇要改得動，一個 `DEFAULT_*`
   * 常數不算 configurability（`tool-ralph` 的 `maxRounds` 就是 Config）——**那條房規現在由
   * `recursion-limit` 那一列滿足**，這個旗標是疊在它上面的一層。
   *
   * **它換算成幾個模型輪取決於組裝**：`模型輪數 = floor((recursionLimit − 1) / 每輪格數)`，
   * 每多一個帶 `beforeModel` 的 middleware 每輪就多一格。預設組裝是三格，所以 `500` ≈ 166 輪；
   * 多掛一個就變四格、≈ 124 輪。**一個固定的數字不是一個固定的輪數。**
   *
   * **不必配別的旗標**：它永遠有消費者（每一種組裝都有迴圈），不像 `--max-goal-rounds`。
   *
   * **配 `--resume` 是對的，而且每一次都要重給。** 它跟 `--sandbox` 相反：上限不記進日誌、
   * 也推不回來，只作用在這一次行程——所以續接時沒有「兩個來源誰贏」的問題，不給就是回到
   * 預設。別把它加進 `--resume` 的衝突檢查：Proteus 的 adapter 每個 phase 都是一次
   * `--resume` 呼叫，靠的就是每次重給。
   */
  readonly recursionLimit?: number;
  /**
   * `--patch` 疊在出貨 `cordis.yml` 上的那幾層，照命令列順序（後面的蓋前面的）。
   *
   * **換掉整份清單這件事沒有旗標可以做**（[#455](https://github.com/DemianLi/nexus-agent/issues/455)
   * 拿掉了 `--plugins`）。要一棵完全不一樣的樹是 profile 的工作，dsh 的產品 CLI 也是這樣分的；
   * 低層嵌入方與測試走程式路徑（`createCliAgent`），不走旗標。
   */
  readonly patches?: readonly string[];
  /**
   * 把疊完的設定印出來就退出，一個 plugin 都不載。
   *
   * 照 dsh 的 `--dump-config`：它印的是**啟動真的會掛的那一份**，而印它不需要把每一顆
   * plugin 都載起來（`renderConfigDump` 是純函式那條路）。
   */
  readonly dumpConfig: boolean;
  /**
   * 把疊完的 plugin 設定欄位規格表（JSON Schema）印出來就退出，一個 plugin 都不套用（[#741](https://github.com/DemianLi/nexus-agent/issues/741)）。
   * 照 dsh 的 `--dump-config-schema`：跟 `--dump-config` 用同樣的幾層與 `--patch`，兩者互斥。
   */
  readonly dumpConfigSchema: boolean;
  /**
   * 只印出貨那一層的設定就退出，**不讀** home 覆寫檔與 `--patch`（[#740](https://github.com/DemianLi/nexus-agent/issues/740)）。
   * 照 dsh 的 `--dump-default-config`：它是設計來救「覆寫檔壞掉」的，壞掉的檔根本不會被解析。
   */
  readonly dumpDefaultConfig: boolean;
  /** 只印用法就退出。 */
  readonly help: boolean;
  /** 只印版本就退出（#1502）。 */
  readonly version: boolean;
}

/**
 * `--sandbox` 那一格。
 *
 * **沒給 `--workspace` 就拋。** 那個組合底下沒有 `ContainedFilesystemBackend`——檔案落在
 * 基座的 `StateBackend` 裡，這道 fence 整個不在路徑上。靜靜收下的話，畫面上是「我設了
 * read-only」，實際上模型照樣想寫什麼寫什麼，而**一條測試都不會紅**（同 `--max-goal-rounds`
 * 那條規矩）。
 *
 * **認不得的模式名也拋。** 型別擋不住命令列上來的字串，落到 backend 那邊會變成「不是
 * `danger-full-access` 也不是 `read-only`」——於是靜靜地當成 `workspace-write`，那是誤放行。
 *
 * **兩個入口共用這一份**（`cli` 與 `serve`），所以用法那段話是傳進來的——同
 * `--session-log 不能在 --workspace 底下」那條檢查。兩份各寫一次的下場是有一天只有一邊擋。
 *
 * @param raw - 命令列上那串字，沒給就是 `undefined`。
 * @param workspace - `--workspace` 那一格，用來檢查兩者成對。
 * @param usage - 接在錯誤訊息後面的用法那段話（呼叫的入口各有一份）。
 * @returns 那個模式，或沒給時的 `undefined`（＝由 backend 用它的預設）。
 * @throws 沒配 `--workspace`，或模式名認不得——訊息接上用法。
 */
export function parseSandboxMode(
  raw: string | undefined,
  workspace: string | undefined,
  usage: string,
): SandboxMode | undefined {
  if (raw === undefined) return undefined;
  if (workspace === undefined) {
    throw new Error(
      `--sandbox 要配 --workspace：沒有 --workspace 的時候檔案跑在虛擬檔案系統裡，` +
        `圍堵那道 fence 根本不在路徑上，這個模式一個位元組都影響不到。\n\n${usage}`,
    );
  }
  const mode = raw.trim();
  if (!isSandboxMode(mode)) {
    throw new Error(
      `--sandbox 認不得 "${raw}"。認得的是 ${SANDBOX_MODES.join('、')}。\n\n${usage}`,
    );
  }
  return mode;
}

/**
 * 解析會話日誌的根：`--session-log` 給了就是它，沒給就是 harness home 底下的 `sessions`
 * （{@link harnessSessionsDir}，[#444](https://github.com/DemianLi/nexus-agent/issues/444)）。
 * 兩種都擋掉落在 `--workspace` 底下的情形。
 *
 * **這道檢查就是 [#170](https://github.com/DemianLi/nexus-agent/issues/170) 那條線的第二次應用**：
 * `fold.ts:252` 寫著「歷史是基礎建設，不是 agent 的工作區」。日誌寫進可寫根底下的話，
 * 模型自己一個 `read_file` 就讀得到整份對話史，而且會把自己的日誌當成工作檔改掉。
 *
 * **預設值也要過這道檢查**：`--workspace ~`，或把 `NEXUS_AGENT_HOME` 指進工作區，預設的根就
 * 落在可寫根裡——跟指錯 `--session-log` 是同一個下場，只是使用者一個旗標都沒給。所以錯誤訊息
 * 點名的是路徑從哪來，並講出兩條出路。
 *
 * **只比字面，不 canonicalize**——同 `ContainedFilesystemBackend` 的取捨與同一個
 * 已知缺口（symlink 繞得過）。這裡擋的是順手指到工作區裡，不是惡意。serve 在這之前還有一道會解 symlink 與大小寫的
 * {@link assertLaunchPathsOutsideWorkspace}（#1620），預設的根落在工作區裡時先被那一道擋下；CLI 只有這一道。
 *
 * @param invocation - 解析出來的呼叫。
 * @param cwd - 相對路徑的解析基準。
 * @param env - 決定 harness home 落在哪（同 {@link resolveHarnessHome}）。
 * @returns 絕對路徑。
 * @throws 它落在 `--workspace` 底下。
 */
export function resolveSessionLogDir(
  invocation: Pick<CliInvocation, 'sessionLog' | 'workspace'>,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (invocation.sessionLog !== undefined) {
    return outsideWorkspace(invocation.sessionLog, invocation.workspace, cwd, '--session-log');
  }
  return outsideWorkspace(
    harnessSessionsDir(env),
    invocation.workspace,
    cwd,
    `預設的會話日誌目錄（${HARNESS_HOME_ENV} 或 ~/${HARNESS_HOME_DIR_NAME} 底下的 ${HARNESS_SESSIONS_DIR_NAME}）`,
    `用 --session-log 指到工作區外面，或把 ${HARNESS_HOME_ENV} 設到工作區外面。`,
  );
}

/**
 * 落盤關掉時兩個入口啟動印的那一行（[#612](https://github.com/DemianLi/nexus-agent/issues/612)）。
 * 一份，兩個入口共用：講的是同一列設定。
 */
export const SESSION_LOG_OFF_DISCLOSURE =
  '會話日誌：只在記憶體裡（行程結束就沒了；清單上 session-persistence 那一列沒掛上）';

/**
 * 落盤沒掛的時候（清單上 `session-persistence` 那一列 `disabled: true`，
 * [#612](https://github.com/DemianLi/nexus-agent/issues/612)；或設定驗不過而掉了，#751），擋掉跟它矛盾的旗標。
 * 兩個入口共用。**訊息照成因分開講**：掉了的那一種把原因帶在訊息裡（啟動時那段警告要到組裝完才印，拋的這一刻
 * 還看不到），要改的是設定，不是 `disabled`。
 *
 * - **`--resume`**：續接答應呼叫端「這一次也接得回來」，而沒有落盤的話這一次一個位元組都不寫回去。
 *   照 dsh：headless 的 `--session-id` 沒有持久化服務就當場拋，理由正是「跑完會印出 id，卻在
 *   行程結束時丟掉整段歷史」（`packages/bundle/headless/src/index.ts:253-258`，`477b4f4`）。
 * - **`--session-log`**：一個明說的旗標跟一份明說的設定互相矛盾。安靜地讓哪一邊贏都是 #612 要擋
 *   的那種誤讀——使用者以為日誌在寫（或以為沒寫），實際上是另一回事。
 *
 * **排在解析任何日誌路徑之前**：關掉的時候日誌根根本不用，拿「不能落在工作區底下」擋人是誤擋。
 *
 * @param invocation - 解析出來的呼叫（serve 沒有 `resume`）。
 * @param mounted - 這一次清單上落盤那一列有沒有掛。
 * @param dropped - 那一列讀清單時掉了的原因（`startup-audit.ts` 的 `dropReasonsOf`）。**錯誤自己帶上**：這裡在組裝
 *   之前拋，啟動時那段警告要等組裝完才印，拋的這一刻還沒印出來（#751）。
 * @throws 關掉了卻給了其中一個旗標。
 */
export function assertPersistenceFlags(
  invocation: { readonly sessionLog?: string | undefined; readonly resume?: string | undefined },
  mounted: boolean,
  dropped: readonly string[] = [],
): void {
  if (mounted) return;
  const off =
    dropped.length === 0
      ? '清單上 `session-persistence` 那一列關掉了（`disabled: true`），這一次會話日誌只在記憶體裡'
      : `清單上 \`session-persistence\` 那一列掉了（${dropped.join('；')}），這一次會話日誌只在記憶體裡`;
  const fix =
    dropped.length === 0
      ? '把那一列的 `disabled` 拿掉（或寫成 `false`）'
      : '照上面的原因把設定改好';
  if (invocation.resume !== undefined) {
    throw new Error(
      `--resume 接不起來：${off}——接回來之後一個位元組都不會寫回去，下一次也接不到這一段。` +
        `要續接就讓那一列掛上：${fix}。`,
    );
  }
  if (invocation.sessionLog !== undefined) {
    throw new Error(
      `--session-log 跟設定矛盾：${off}，給了目錄也不會寫。` +
        `要落盤就讓那一列掛上：${fix}；要只在記憶體裡就別給 --session-log。`,
    );
  }
}

/**
 * `--workspace` 那一格解析出來的絕對根，沒給就是 `undefined`。
 *
 * **一份**：這棵樹上曾經有兩處各寫一次 `resolve(cwd, workspace)`（這裡與
 * {@link createCliAgent}），而 {@link outsideWorkspace} 的檔頭對同型情況已經寫過下場
 * ——「有一天只有一邊擋」。[#504](https://github.com/DemianLi/nexus-agent/issues/504)
 * 要把這個值寫進會話 header，那是第三個消費者，所以這裡先抽出來。
 *
 * @param workspace - `--workspace` 命令列上那串字，沒給就是 `undefined`。
 * @param cwd - 解析的起點。
 * @returns 絕對根，或沒給時的 `undefined`。
 */
export function resolveWorkspaceRoot(
  workspace: string | undefined,
  cwd: string,
): string | undefined {
  return workspace === undefined ? undefined : resolve(cwd, workspace);
}

/**
 * **「thread → 可寫根」**（[#1774](https://github.com/DemianLi/nexus-agent/issues/1774)，#1675 Q7 (a)）：只收 thread，回這條 thread 的可寫根（主機上的絕對路徑）；
 * `undefined` 是這條 thread 沒有圍堵。
 *
 * 可寫根從行程級的一格改成逐條 thread 的一格：serve 的 `createAgent` 與 CLI 每條 thread 組裝時問它一次，得到的值**同時**交給續接守衛
 * （`assertSameWorkspaceRoot`）與組裝點，兩邊才不會分岔。dsh 的對應物是 `resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot)`
 * （`packages/sandbox/sandbox-policy/src/index.ts:164-171`）：根是會話自己的一格，行程級那一格只是備援。
 */
export type WorkspaceRootOf = (threadId: string) => string | undefined;

/**
 * **CLI 的實作**：每條 thread 一律是 `--workspace` 解析出來的那一個根。serve 不用這一支——serve 的可寫根由 `thread-roots.ts` 的
 * `createThreadPlacer` 逐條 thread 配（[#1775](https://github.com/DemianLi/nexus-agent/issues/1775)，新 thread 配私有根）；
 * 測試接縫 `RunServeOptions.workspaceRootOf` 才會走到這一支的形狀。
 *
 * @param workspace - `--workspace` 命令列上那串字。
 * @param cwd - 解析的起點。
 */
export function launchWorkspaceRootOf(workspace: string | undefined, cwd: string): WorkspaceRootOf {
  return () => resolveWorkspaceRoot(workspace, cwd);
}

/**
 * 不變量量測記錄（[#976](https://github.com/DemianLi/nexus-agent/issues/976)）要寫到哪裡；
 * **不該寫的時候回 `undefined`**，呼叫端就不建 tap。它跟著會話日誌的兩條既有承諾走，不另立規矩：
 *
 * - **落盤關掉就一個位元組都不寫**（#612）：清單上 `session-persistence` 那一列沒掛，home 連目錄都不建。
 * - **預設位置不能落在 `--workspace` 底下**（#424）：寫在可寫根裡，模型讀得到也改得動。會話日誌那一格
 *   遇到這種情況是當場拋（`resolveSessionLogDir`）；這裡**只是不寫**，因為量測記錄不是使用者要的東西，
 *   不值得替它擋掉一次啟動。唯一到得了這個分支的組合是 `--session-log` 明指到工作區外、home 卻在工作區裡，
 *   而且只有 CLI 到得了：serve 啟動時 home 落在工作區裡就起不來（{@link assertLaunchPathsOutsideWorkspace}，#1620）。
 *
 * @param workspace - `--workspace`，沒給就沒有圍堵、也就沒有這一條。
 * @param persistenceMounted - 清單上落盤那一列這次有沒有掛。
 * @param cwd - 解析相對路徑的基準。
 * @param env - 同 {@link resolveHarnessHome}。
 * @returns 記錄檔的絕對路徑，或 `undefined`（不寫）。
 */
export function resolveInvariantLogPath(
  workspace: string | undefined,
  persistenceMounted: boolean,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (!persistenceMounted) return undefined;
  try {
    return outsideWorkspace(harnessInvariantLogPath(env), workspace, cwd, '量測記錄');
  } catch {
    return undefined;
  }
}

/**
 * 兩個日誌目錄旗標共用的那道檢查。**一份**，理由同 {@link resolveSessionLogDir} 的呼叫端。
 *
 * ## 「啟動路徑的安全檢查都拿 `--workspace` 來比」在 #1775 之後仍然對（逐條重判）
 *
 * #1775 之前 `--workspace` 是每條 thread 的可寫根；之後新 thread 的可寫根是 home 底下的私有目錄，`--workspace` 退成**所有 thread 都讀得到的唯讀共用區**。
 * 這些檢查擋的是「基礎建設的檔落進模型讀得到的地方」，判準本來就是讀得到（#1620 檔頭：「讀取不受圍堵」），不是寫得到，所以**比 `--workspace` 仍然是對的、不必改**：
 * 共用區裡的檔每條新 thread 的模型都經 `/shared` 讀得到，舊 thread 還寫得動。私有根在 home 底下、是基底的子目錄，home 的狀態檔在每條私有根**外面**，
 * 反方向（home 落進私有根）不可能；基底本身與其他路徑的重疊另由 `thread-roots.ts` 的 `assertThreadRootsBaseSeparate` 擋。
 *
 * 呼叫點全表（行號以 `e643d137` 為準）：
 *
 * | 檢查 | 呼叫點 | 比什麼 | 判斷 |
 * | --- | --- | --- | --- |
 * | `assertLaunchPathsOutsideWorkspace` | `serve.ts:486` | 目前資料夾的 `.env`、home、home 的 `.env`、舊 `.env` ⇄ `--workspace` | 不改。讀得到就洩漏 key 與金鑰；檔頭補了私有根的 Q3 例外 |
 * | `resolveSessionLogDir`（本體 `:316`，走本函式） | `serve.ts:688`、`cli.ts:1016` | `--session-log`／預設日誌根 ⇄ `--workspace` | 不改。日誌在共用區 ＝ 所有人讀得到整份對話史 |
 * | `resolveInvariantLogPath`（`:443`，走本函式） | `serve.ts:757`、`cli.ts:1004` | 量測記錄 ⇄ `--workspace` | 不改，且仍是「只不寫」不拋 |
 * | `loadConfigHashKey`（`session-header-metadata.ts:142`，走本函式） | `serve.ts:814`、`:947`（經 `createSessionHeaderMetadataResolver`）、`cli.ts:1183`（經 `resolveSessionHeaderMetadata`） | 設定雜湊鍵檔 ⇄ `--workspace` | 不改。**這三處是安全檢查，不是顯示用的**（#1783 內文把它們標成 header metadata／顯示用，那一格分類是錯的） |
 * | `--resume` 的日誌路徑 | `cli.ts:354` | 續接的日誌 ⇄ `--workspace` | 不改，CLI 的可寫根仍是 `--workspace` |
 * | `assertPatchesOutsideWorkspace` | `runServe`、`runCli`、`plugin` | 每份 `--patch` ⇄ `--workspace` | 例外：判準是寫得到，不是讀得到；覆寫檔能換 MCP 的 `command`。不比新 thread 的私有根 |
 */
export function outsideWorkspace(
  path: string,
  workspacePath: string | undefined,
  cwd: string,
  subject: string,
  remedy = '',
): string {
  const directory = resolve(cwd, path);
  const workspace = resolveWorkspaceRoot(workspacePath, cwd);
  if (workspace === undefined) return directory;
  // 感知分隔符的那一支（#1620）：`${workspace}${sep}` 在 `--workspace /` 時是 `//`，什麼都比不中。
  if (isWithin(workspace, directory)) {
    throw new Error(
      `${subject} 不能在 --workspace 底下（${directory} 在 ${workspace} 之內）。` +
        `會話日誌是基礎建設，不是 agent 的工作區——寫在可寫根裡，模型讀得到也改得動整份對話史。` +
        remedy,
    );
  }
  return directory;
}

/** {@link assertLaunchPathsOutsideWorkspace} 的參數。 */
export interface LaunchPathsCheck {
  /** `--workspace` 命令列上那串字，沒給就是 `undefined`（沒給就不檢查）。 */
  readonly workspace: string | undefined;
  /** 目前資料夾：相對路徑的基準，它的 `.env` 是真模型路徑讀的「專案」那一層。 */
  readonly cwd: string;
  /** 決定 harness home 落在哪（同 {@link resolveHarnessHome}）。 */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 程式碼資料夾根目錄的舊 `.env`。省略即 `launch-env.ts` 的那一份（安裝樹沒有）；測試才傳。 */
  readonly legacyEnvFile?: string;
  /** 本模組所在的目錄，決定舊位置在哪、有沒有（`legacyEnvFileFor`）；測試才傳。 */
  readonly moduleDir?: string;
}

/**
 * **serve 認得的 key 來源與 home 不能跟 `--workspace` 重疊**（[#1620](https://github.com/DemianLi/nexus-agent/issues/1620)）。
 * 有 `--workspace` 才檢查；重疊就拋，沒有逃生旗標。
 *
 * 檢的是這四個路徑，各自解到實際位置（symlink 與大小寫都解，見 `canonical-path.ts`）：
 *
 * - 目前資料夾的 `.env`，**存在才算**，不看 `--live`（Q2 (b)）：同一個目錄下次帶 `--live` 重啟，就是這一份被讀。
 * - harness home 本身，**不論存不存在**：受管憑證檔、瀏覽器會話密鑰、所有人的附件、會話日誌的預設根都在裡面。
 * - home 的 `.env`，存在才算：home 不在工作區裡、它卻經 symlink 指進工作區的那一種。
 * - 程式碼資料夾根目錄的舊 `.env`，存在才算（Q5）：不會被讀，但檔案還在的話裡面多半就是 key。
 *
 * **兩個方向都算重疊**（Q3）：路徑在工作區之內、就是工作區、或包含工作區。工作區落在 home 裡，模型讀得到也改得動
 * home 的狀態檔——「歷史是基礎建設，不是 agent 的工作區」（{@link resolveSessionLogDir}）講的是同一件事。
 *
 * **只做 `realpath`，不開檔、不讀內容**：訊息裡只有路徑，不會出現任何值。`ELOOP`、`EACCES` 這類解不開的錯原樣往外拋，
 * 啟動失敗，訊息帶著錯誤碼。
 *
 * ## 與 dsh 的偏離（理由 2：產品需求超出 dsh 的射程）
 *
 * dsh 沒有這道檢查：`loadLayeredEnv` 讀 `$cwd/.env` 與 `$DSH_HOME/.env`，不看工作區在哪
 * （`packages/boot/app-boot/src/index.ts:238-259`，`687f282e`），而它的工作區預設就是 `process.cwd()`
 * （`packages/sandbox/sandbox-policy/src/index.ts:131`），所以專案那份 `.env` 本來就在工作區根，讀取也照本機檔案系統走
 * （`packages/fs/fs-sandbox/README.zh.md:12`）。dsh 是單人的寫程式代理，跟模型對話的人就是 key 的主人。我們的 serve 是
 * 多人共用一台主機的內網機器人：任何一位使用者叫模型讀 `.env`，就拿到管理者的 key。**補的是**啟動時這一道路徑重疊檢查；
 * **不改的是** `launch-env.ts` 的分層與載入規則（照 dsh）。讀取面經連結出根的由 backend 擋（#1982）。只做 serve（Q4）：CLI 是一個人在自己的
 * 終端機跑，跟 dsh 同一個形狀；放在這裡，CLI 之後要用可以直接叫。
 *
 * ## #1775 的例外（#1620 Q3，demian 接受）：私有可寫根落在 home 底下
 *
 * 這道檢查本身**不改**，仍然只比 `--workspace`。serve 的新 thread 另有一個可寫根（`<home>/thread-roots/thread-<雜湊>`，`thread-roots.ts`），
 * 它落在 home 底下——Q3 的理由「工作區落在 home 裡，模型就能改 home 的狀態檔」對它**不成立**：那條 thread 的 backend 根是它自己這個子目錄，
 * home 的狀態檔（`.credentials.yaml`、`sessions/`、`attachments/`、`serve.lock`、設定雜湊鍵檔、瀏覽器會話密鑰、metrics-token、plugin-journal）都在根**外面**；
 * `..` 被 backend 擋下，絕對路徑會被當成根底下的子路徑。基底寫死在 home 底下的 `thread-roots`（不開成設定列），所以 home 本身、home 的上層與
 * home 根目錄那一層的狀態檔不可能落進任何一條 thread 的根。
 *
 * **這道檢查不掃連結**：工作區或私有根裡指向 home 或 `.env` 的連結，要擋得掃整棵樹，而且連結可以在啟動之後才建。
 * 那一格歸 backend：`danger-full-access` 以外，讀寫都在 canonicalize 之後判落不落在根內，經連結落到根外的拒（`contained-backend.ts`，#1982）。
 *
 * @param check - 見 {@link LaunchPathsCheck}。
 * @throws 有任何一個路徑跟工作區重疊；或解路徑時遇到 ENOENT／ENOTDIR 以外的錯。
 */
export async function assertLaunchPathsOutsideWorkspace(check: LaunchPathsCheck): Promise<void> {
  const root = resolveWorkspaceRoot(check.workspace, check.cwd);
  if (root === undefined) return;
  const workspace = await canonicalize(root);
  const home = resolveHarnessHome(check.env);
  const configured = check.env[HARNESS_HOME_ENV];
  const homeSource =
    configured !== undefined && configured.trim().length > 0
      ? `${HARNESS_HOME_ENV}`
      : `預設的 ~/${HARNESS_HOME_DIR_NAME}`;
  const legacyEnvFile =
    check.legacyEnvFile ??
    (check.moduleDir === undefined ? LEGACY_ENV_FILE : legacyEnvFileFor(check.moduleDir));
  const candidates: readonly {
    readonly label: string;
    readonly path: string;
    readonly mustExist: boolean;
  }[] = [
    { label: '目前資料夾的 .env', path: resolve(check.cwd, '.env'), mustExist: true },
    { label: `harness home（${homeSource}）`, path: home, mustExist: false },
    {
      label: `harness home 的 .env（${homeSource}）`,
      path: resolve(home, '.env'),
      mustExist: true,
    },
    // 安裝樹沒有「程式碼資料夾根目錄」，這一格不列（#1671）：否則 `/opt/.env` 這種不相干的檔會被當成舊檔去比對工作區。
    ...(legacyEnvFile === undefined
      ? []
      : [{ label: '程式碼資料夾根目錄的舊 .env', path: legacyEnvFile, mustExist: true }]),
  ];
  const seen = new Set<string>();
  const overlaps: string[] = [];
  for (const candidate of candidates) {
    const real = candidate.mustExist
      ? await canonicalizeExisting(candidate.path)
      : await canonicalize(candidate.path);
    // 同一個檔只點名一次：cwd 是程式碼根目錄時，目前資料夾的 `.env` 就是舊位置那一份。
    if (real === undefined || seen.has(real)) continue;
    seen.add(real);
    const relation =
      real === workspace
        ? '就是工作區'
        : isWithin(workspace, real)
          ? '在工作區之內'
          : isWithin(real, workspace)
            ? '包含工作區'
            : undefined;
    if (relation === undefined) continue;
    const where = real === candidate.path ? '' : `（實際位置 ${real}）`;
    overlaps.push(`- ${candidate.label}：${candidate.path}${where}，${relation}`);
  }
  if (overlaps.length === 0) return;
  const shown = workspace === root ? root : `${root}（實際位置 ${workspace}）`;
  throw new Error(
    `serve 起不來：下面這些跟 --workspace ${shown} 重疊。\n${overlaps.join('\n')}\n` +
      '工作區裡的檔模型都讀得到（讀取不受圍堵），而共用這台 serve 的每個人都能叫它讀：' +
      '落在裡面的 key、瀏覽器會話密鑰、所有人的附件與會話日誌，誰都拿得到。\n' +
      `出路（擇一）：把 .env 搬到工作區外面，或改在啟動環境 export 那些變數；把 ${HARNESS_HOME_ENV} 設到工作區外面；` +
      '或換一個不跟這些路徑重疊的 --workspace。',
  );
}

/**
 * **`--patch` 的檔不能落在工作區裡**（[#2162](https://github.com/DemianLi/nexus-agent/issues/2162)）：
 * CLI 與 serve 的舊 thread 改得到工作區，而覆寫檔能換掉 MCP 的 `command`，下次起動就以起它的帳號跑。
 *
 * 排在印設定之前：`--dump-config-schema` 會載入覆寫檔 `insert` 的模組。字面路徑、解開父目錄、解開到底三種位置都比，
 * 工作區裡的連結不論指到哪都算在裡面，工作區外的連結指進來也算；檔案不存在也照比。有 `--workspace` 才檢查。
 * 判準是寫得到，而且只比 `--workspace`，不看 serve 新 thread 的私有根。
 *
 * @param check - `--workspace` 那串字、相對路徑的基準、`--patch` 的路徑。
 * @throws 有任何一份落在工作區裡；或解路徑時遇到 ENOENT／ENOTDIR 以外的錯。
 */
export async function assertPatchesOutsideWorkspace(check: {
  readonly workspace: string | undefined;
  readonly cwd: string;
  readonly patches: readonly string[] | undefined;
}): Promise<void> {
  const root = resolveWorkspaceRoot(check.workspace, check.cwd);
  if (root === undefined || check.patches === undefined) return;
  const workspace = await canonicalize(root);
  for (const patch of check.patches) {
    const literal = resolve(check.cwd, patch);
    const real = await canonicalize(literal);
    const placed = join(await canonicalize(dirname(literal)), basename(literal));
    if (isWithin(root, literal) || isWithin(workspace, placed) || isWithin(workspace, real)) {
      throw new Error(
        `--patch ${patch} 不能在 --workspace 底下（實際位置 ${real}，工作區 ${workspace}）。` +
          '工作區可能被模型改動，覆寫檔能換掉 MCP 的 command，下次起動就以這個帳號跑。' +
          '把它搬到工作區外面，或換一個不包含它的 --workspace。',
      );
    }
  }
}

/** 假模型腳本寫出去的那個檔。測試靠它確認檔案真的落在 `--workspace` 指的目錄底下。 */
export const CLI_PROBE_FILE = '/cli.md';

/**
 * 組裝點傳給基座的那一句指引。**身分、persona 與工作目錄不在這裡**（[#720](https://github.com/DemianLi/nexus-agent/issues/720)）：
 * 那些是部署方的設定，住在出貨清單的 `system-prompt` 那一列，由 `@nexus/plugin-system-prompt` 排在它前後。
 * 這一句是指引，不是 persona，所以留在組裝點。
 */
const SYSTEM_PROMPT = '需要動用工具時就真的呼叫，不要只在文字裡描述你打算做什麼。';

/**
 * 假模型在系統提示詞裡叫什麼（`{{model}}` 的值）。`ScriptedChatModel` 沒有型號，而嚴格插值不允許沒有值，
 * 所以替它定一個名字：夠明白地告訴讀日誌的人這一輪沒有真的模型。
 */
export const SCRIPTED_MODEL_NAME = 'scripted';

/**
 * 系統提示詞前後綴的 `{{cwd}}`：檔案工具的位址空間裡的根，**不是主機上的工作目錄**。
 * 理由與偏離登記見 `@nexus/plugin-system-prompt` 的檔頭；沒有 `--workspace` 時是基座的虛擬檔案系統，`/` 一樣是它的根。
 */
export const PROMPT_WORKING_DIRECTORY = '/';

/**
 * 續接時被收回預設組的那一行話（serve 的伺服器日誌與 CLI 的標準錯誤各留一行，[#1621](https://github.com/DemianLi/nexus-agent/issues/1621) Q2 (b)）。
 * 帶原本的兩個值與收成哪一組，部署方看得出為什麼這條對話的權限變了。
 *
 * @param narrowing - `start` 回報的收回。
 * @returns 一行給人看的話（不帶 thread id，呼叫端自己加前綴）。
 */
export function describePermissionNarrowing(narrowing: PermissionNarrowing): string {
  return (
    `日誌記的檔案政策 ${narrowing.fromSandbox}（核准 ${narrowing.fromApproval}）比權限表裡每一組都寬，續接時收回預設組 ` +
    `${narrowing.preset}（檔案政策 ${narrowing.toSandbox}、核准 ${narrowing.toApproval}）`
  );
}

/** 冷復活的背景子代理被收回沙箱的那一次（{@link CreateCliAgentSession.onDelegationNarrowed} 交給 serve／CLI 的事件）。 */
export interface DelegationNarrowedEvent extends DelegationNarrowing {
  /** 被收回的子代理的會話 id（它自己那份日誌的）。 */
  readonly sessionId: string;
}

/**
 * 冷復活的背景子代理被收回沙箱的那一行話（[#1739](https://github.com/DemianLi/nexus-agent/issues/1739)，措辭比照 {@link describePermissionNarrowing}）。
 * **只講沙箱**：子代理的核准照舊釘在 `never`，沒有動；**日誌也沒改**：它記的仍是委派當時那一格，實際跑的是收窄後的。
 *
 * @param event - 被收回的那一次。
 * @returns 一行給人看的話（不帶 thread id，呼叫端自己加前綴）。
 */
export function describeDelegationNarrowing(event: DelegationNarrowedEvent): string {
  return (
    `背景子代理 ${event.sessionId} 的委派快照記的檔案政策 ${event.fromSandbox} 比權限表裡每一組都寬，叫醒時收回預設組 ${event.preset}` +
    `（檔案政策 ${event.toSandbox}；核准不動，子代理的日誌也沒有改）`
  );
}

/**
 * 每個子代理、每個行程只留一次話（卡上定題）：鍵是子代理日誌的會話 id（跨 thread 不重複）。閒置逐出之後重組不再重複。
 */
const warnedDelegationNarrowing = new Set<string>();

/** REPL 與一次性模式共用同一條對話——checkpointer 認的是這個 id。 */
export const THREAD_ID = 'cli';

/**
 * 續行那一行披露。**它是算出來的，不是常數**——因為它背後真的有一個旗標。
 *
 * {@link APPROVAL_DISCLOSURE} 的檔頭寫著「哪天這裡真的多了一個旗標，這個常數要跟著變成
 * 一個函式——不然畫面會開始說謊」。`--goal-driver` 就是那樣的旗標，只是它**不動核准政策**
 * （`runCli` 照樣只傳 {@link HEADLESS_APPROVALS}），所以那一行沒有變成謊話；這一行是同一
 * 條規矩底下的第二行，而它從第一天就是函式。
 *
 * **開著的時候要把上限講出來**，因為那是唯一擋得住這支迴圈的東西。不講的話，「模型自己
 * 又跑了三十輪」與「人問了三十次」在帳單上一模一樣而在畫面上沒有差別。
 *
 * **而上限有兩條，所以兩條都要講。** 目標自己那個 `max_goal_rounds` 是**模型填的**
 * （`service.ts:254` 的 `??`，還能用 `update_goal` 調高），操作的人設得動的是另一條（[#1623](https://github.com/DemianLi/nexus-agent/issues/1623)：
 * `goal-round-cap` 那一列，CLI 的 `--max-goal-rounds` 贏過它）。只印其中一條的話，這一行就會變成上面那句自己警告過的謊話——
 * 只印目標那條會讓人以為有一個他控制得了的數字，只印操作者那條會讓人看不見模型可以在它底下自己挑一個更小的。操作者那條
 * 沒有時要**明著說沒有**，理由同上。操作者那條**每次建立或恢復目標重新起算**，也要講，不然人會以為那是一個目標一輩子的總數。
 *
 * **兩個入口的預設相反**（#445）：CLI 預設關、要 `--goal-driver` 才開；serve 預設開、要
 * `--no-goal-driver` 才關。所以「怎麼改成另一邊」那半句要看入口講，不然 serve 關著的時候這一行
 * 會叫人去加一個本來就是預設的旗標。
 *
 * @param on - 續行開著沒有。
 * @param roundCap - 操作者那條上限與它的來源；省略即沒有（那一列關掉、CLI 也沒給旗標）。
 * @param entry - 哪個入口；預設 CLI。
 * @returns 那一行。
 */
export function formatGoalDriverDisclosure(
  on: boolean,
  roundCap?: GoalRoundCap,
  entry: 'cli' | 'serve' = 'cli',
): string {
  const own = `目標自己的 max_goal_rounds（模型在 create_goal 填的，沒填就是 ${DEFAULT_MAX_GOAL_ROUNDS}）`;
  const limits =
    roundCap === undefined
      ? `上限只有一條——${own}；沒有操作者給的上限（goal-round-cap 那一列關著${entry === 'cli' ? '，也沒有給 --max-goal-rounds' : ''}）`
      : `上限兩條，先到的那一條管——${roundCap.source}給的 ${String(roundCap.limit)} 輪（每次建立或恢復目標重新起算），與${own}`;
  if (entry === 'serve') {
    if (!on) return '續行：關閉（--no-goal-driver；一輪結束就結束，要人再推）';
    return `續行：開啟（預設；目標沒達成時自己再開一輪；${limits}；--no-goal-driver 可以關掉）`;
  }
  if (!on) return '續行：關閉（一輪結束就結束，要人再推；--goal-driver 可以打開）';
  return `續行：開啟（目標沒達成時自己再開一輪；${limits}）`;
}

/**
 * 依這次呼叫建 model。
 *
 * @param live - 是否用真實供應商。
 * @param liveModel - 真實供應商的連線值，清單上 `live-model` 那一列（#545）。
 * @returns 可以交給組裝點的 model。
 * @throws `--live` 但環境變數裡沒有 key——訊息指名缺哪一個，不 fallback（兩層 `.env` 在入口載入，見 `runCli`）。
 */
function createCliModel(
  live: boolean,
  liveModel: LiveModelConfig,
  credentials: CredentialService | undefined,
  plugins: readonly PluginEntry[],
  attachments: AttachmentStore | undefined,
  requestGate: RequestGate | undefined,
): BaseChatModel {
  // **`--live` 是進 live 的唯一閘門**，不看選擇列（理由見 `model-provider.ts`）；沒帶它才由清單上的
  // `agent-default-model` 在清單上的提供者之間選（#670）：出貨值指的是清單上那一列腳本提供者 `cli-script`。
  if (!live) return resolveDefaultModel(plugins);
  return createLiveModel(liveModel, undefined, credentials, {
    ...(attachments !== undefined && { attachments }),
    ...(requestGate !== undefined && { requestGate }),
  });
}

export type NexusAgent = NexusAgentHandle['agent'];

/** {@link createCliAgent} 的入口身分選項。**省略都是有意義的**：兩個入口各自只傳自己的那幾格。 */
export interface CreateCliAgentSession {
  /**
   * 不變量違規往哪裡講。[`serve.ts`](./serve.ts) 傳伺服器日誌的 `invariant` logger（error 等級，
   * [#1534](https://github.com/DemianLi/nexus-agent/issues/1534)；原先維持 runner 預設，[#107](https://github.com/DemianLi/nexus-agent/issues/107)）。
   */
  readonly onInvariantViolation?: (error: InvariantError) => void;
  /**
   * 不變量的只記錄旁路（[#976](https://github.com/DemianLi/nexus-agent/issues/976)），原樣轉給
   * `createNexusAgent`：每一份日誌裝上了哪幾個 package 的檢查、報了哪一條違規。**CLI 與 serve 都傳**
   * （各自建一份寫到 `$NEXUS_AGENT_HOME/invariant-log.jsonl`），所以兩條路徑答案相同；其餘呼叫端
   * 省略就是不記，測試與 eval 不會寫到任何人的家目錄。
   */
  readonly invariantTap?: InvariantTap;
  /**
   * 核准政策的 session 開關。[`serve.ts`](./serve.ts) 刻意不傳，維持預設的「有人在」——瀏覽器那端真的按得下去。
   * CLI 這條傳 {@link HEADLESS_APPROVALS}，因為它收不了核准決定（[#113](https://github.com/DemianLi/nexus-agent/issues/113)）。
   */
  readonly approvals?: ApprovalPolicy;
  /**
   * root 日誌的 seed：續接時上一個行程留下的事件（`--resume`，[#251](https://github.com/DemianLi/nexus-agent/issues/251)
   * 的門 A）。省略即一份新日誌。serve 不傳：它的註冊表不是這裡建的（一條 thread 一份，在 `ThreadPump`），seed 經
   * `ThreadAgent.rootSeed` 交給 pump。
   */
  readonly rootSeed?: readonly SessionEvent[];
  /**
   * 錨定估算的帳（[#702](https://github.com/DemianLi/nexus-agent/issues/702)），原樣轉給 `createNexusAgent`。
   * **要跨 thread 借錨的入口傳**：serve 在起動期建一本、每條 thread 傳同一本，所以第二條 thread 的第一次借得到第一條的。
   * CLI 一個行程一個組裝，省略即這個組裝自己一本，行為相同。
   */
  readonly tokenAnchorBook?: TokenAnchorBook;
  /**
   * 樹上會話查找的登記面（[#1463](https://github.com/DemianLi/nexus-agent/issues/1463)），原樣轉給 `createNexusAgent`：
   * 兩個產品入口經 `compatLayer` 從 `PluginTree.threadSessions` 帶進來；**省略就是沒有樹的組裝**，只有這一次組裝自己的
   * `registry.sessions`。
   */
  readonly sessionLookup?: SessionLookupRegistrar;
  /**
   * 行程級的 MCP 連線池（[#1677](https://github.com/DemianLi/nexus-agent/issues/1677)），當宿主服務交給 MCP 那幾列：一份設定整台
   * 一份連線。**serve 傳**（起動期建一份、試組與每條 thread 傳同一份）；CLI 一個行程一個組裝，省略就是每列自己連，行為不變。
   */
  readonly mcpPool?: McpConnectionPool;
}

/**
 * 組出這次呼叫要用的 agent。
 *
 * **checkpointer 是 REPL 有沒有記性的全部**：一條 REPL 是一條連續對話，而對話狀態
 * 存在 checkpointer 裡、用 {@link THREAD_ID} 認領。自己在外面累積一個 messages 陣列
 * 也能讓 demo 跑起來，但那是把基座已經有的東西再實作一次，而且下一個 phase 要換成
 * 真的持久化時整段都得丟掉。
 *
 * 回傳 model 是為了讓測試看得到送進去的 prompt——照 `spike/spike-agent.ts` 的先例。
 *
 * `dispose` 一路傳到 {@link runCli}——清單裡的 plugin 可能開了活資源（MCP 的 stdio 子行程是
 * 第一個），沒人收的話這支程式印完答案不會退出。
 *
 * **default backend 是組裝點的事，不是 plugin 的事**（[#28](https://github.com/DemianLi/nexus-agent/issues/28)
 * 決議 3）。`--workspace` 換掉的就是它：給了就跑在真實磁碟上、變更被圍堵在那個目錄之下；
 * 省略即 `StateBackend`——虛擬 FS 跑在 state 裡，完全不碰磁碟。**預設不碰磁碟是刻意的**：
 * 一個手動驗證工具不該因為忘了加旗標就動到誰的檔案。
 *
 * @param invocation - 這次呼叫解析出來的東西。
 * @param plugins - 已經載好的 plugin 清單。
 * @param cwd - `--workspace` 的解析基準，省略即行程的工作目錄。
 * @param session - 入口身分的三個選項，**具名傳**（[#697](https://github.com/DemianLi/nexus-agent/issues/697)）：
 *   以前是三個位置參數，呼叫端為了只傳第三個得寫 `undefined, undefined, HEADLESS_APPROVALS`，而省略有意義。見
 *   {@link CreateCliAgentSession}。
 * @returns 組好的 agent、收掉它的方法，與它用的 model。
 * @throws 清單載入失敗、fold 前置條件不成立，或基座擋下這份組裝。
 */
export async function createCliAgent(
  invocation: Pick<
    CliInvocation,
    'live' | 'workspace' | 'sandbox' | 'approvalPolicy' | 'recursionLimit'
  > & {
    /**
     * 真實供應商的五個連線值（[#545](https://github.com/DemianLi/nexus-agent/issues/545)）。
     * 兩條產品路徑都傳：CLI 與 serve 在起動期從同一份清單解一次（serve 的這個函式一條 thread
     * 跑一次，只解在這裡的話設定寫壞要等到第一條 thread 才炸；起動期那一次也是啟動時印模型名
     * 的來源）。省略時從 `plugins` 解，給手上只有清單的呼叫端（測試、嵌入方）。
     *
     * **傳與不傳拿到的值一樣**——同一份清單、同一支 `startupSetting`。所以這一格的作用是
     * **不解第二次**，不是改變值；突變量過（2026-09-23）：拿掉 serve 傳下來的那一格，全樹照樣綠。
     * 「寫壞的設定在起動期就炸」由 serve 起動期那一次解析負責，那一條有測試
     * （`settings/live-model.test.ts`）。
     */
    readonly liveModel?: LiveModelConfig;
    /**
     * **這條 thread 的可寫根**（[#1774](https://github.com/DemianLi/nexus-agent/issues/1774)）：入口依「thread → 根」（{@link WorkspaceRootOf}）取得後明著交進來，
     * 組裝點用它建 backend、host 服務 `workspaceRoot`、`sandboxPolicy.rootDir`，並原樣從回傳值交回去（交付錨、檔案搜尋、header）。
     *
     * **選填，而且「鍵不在」時退回 `--workspace` 解析出來的根**（`resolveWorkspaceRoot(workspace, cwd)`）：手上只有 `--workspace` 的呼叫端
     * （大量既有測試、嵌入方、CLI）行為不變。**鍵在、值是 `undefined` 就是「這條 thread 沒有圍堵」，不退回**（#1775，PM 補充第 1 件）：
     * 「回 `undefined` 就是沒有圍堵」的語意在入口與組裝點之間不再分岔——serve 一律明著傳這一格（連 `undefined` 也傳），
     * 所以續接守衛與組裝點拿到的永遠是同一個值。「這一格是逐條 thread 取得的」靠入口的接線測試守
     * （`workspace-root-per-thread.test.ts` 從 `runServe` 起量），不靠這裡的退回。
     */
    readonly workspaceRoot?: string | undefined;
    /**
     * **唯讀共用參考區的根**（[#1775](https://github.com/DemianLi/nexus-agent/issues/1775)）：只有這條 thread 有私有可寫根時才給，值是 `--workspace` 解析出來的根。
     * 組裝點把它以固定 `read-only` 掛在 `SHARED_WORKSPACE_PREFIX` 底下（`agent-factory.ts` 的 `sharedWorkspace`），並提供 host 服務
     * `sharedWorkspace`（前綴）給 `agent-instructions`、`sandbox-policy` 與 `fs` 把手。舊 thread、CLI 不給。
     * 落盤關掉的新 thread（可寫根是記憶體，`workspaceRoot` 明著是 `undefined`）照樣給（PM 裁決 (f)）。
     */
    readonly sharedWorkspaceRoot?: string;
    /**
     * **可寫根就是新 thread 讀的共用區**（舊 thread，[#1960](https://github.com/DemianLi/nexus-agent/issues/1960)）：給了，圍堵 backend 對根目錄的指示檔與
     * 技能來源目錄一律拒絕變更（`shared-reserved-writes.ts`）。只有 serve 依 placer 給；CLI 沒有新 thread 讀共用區，不給。
     */
    readonly rootIsShared?: boolean;
    /**
     * 全機的模型請求並行閘（[#1505](https://github.com/DemianLi/nexus-agent/issues/1505)）：**只有 serve 給**，起動期建一份、每條 thread 的組裝
     * 共用同一份（名額是整台 serve 的，不是這條 thread 的）。對話、換模型別顆、背景子代理指定的模型、標題（含跟隨主路由的那顆）都從
     * 這一份取名額。省略＝不建閘（CLI、REPL、嵌入方與沒設 `maxConcurrentRequests` 的 serve）。
     */
    readonly requestGate?: RequestGate;
    /**
     * 真實供應商的憑證服務（[#730](https://github.com/DemianLi/nexus-agent/issues/730)）：`runCli`／`runServe` 在起動期建一次
     * （載入兩層 `.env`、完整檢查受管檔），對話那顆與標題那顆都從它取 key，每次請求前解析。省略時退回啟動環境
     * （`process.env`），給手上沒有入口的呼叫端（測試、嵌入方）。
     */
    readonly credentials?: CredentialService;
    /**
     * LLM 標題那一列與標題上限（[#650](https://github.com/DemianLi/nexus-agent/issues/650)），理由同 {@link liveModel}：
     * 兩條產品路徑在起動期解一次往下傳，serve 上那一列寫壞了就在 server 起來之前失敗，而不是等到第一條 thread。
     * 省略時從 `plugins` 解。**掛不掛不在這兩格**：那一列關掉時照樣由 `startupEntryMounted` 判。
     */
    readonly threadTitleLlm?: ThreadTitleLlmConfig;
    readonly threadTitle?: ThreadTitleConfig;
    /**
     * `plugins` 裡**哪幾個條目可以少掛**（[#751](https://github.com/DemianLi/nexus-agent/issues/751)），原樣交給
     * `createNexusAgent`：這幾個條目組裝時自己的失敗只讓它掉，掉了哪幾個從回傳的 `dropped` 讀。兩條產品路徑拿
     * 必掛名單算（`startup-audit.ts` 的 `optionalEntriesOf`）。
     *
     * 組裝點在下面自己加的外掛**永遠不在這份裡**，理由見 `CreateNexusAgentOptions.optionalEntries`。省略即全有全無，
     * 手搭清單的呼叫端照舊。
     */
    readonly optionalEntries?: ReadonlySet<PluginEntry>;
    /**
     * 收不收插話（[#710](https://github.com/DemianLi/nexus-agent/issues/710)），原樣交給 `createNexusAgent`。**只有 serve 開**：
     * CLI 一行一輪，沒有插話。
     */
    readonly stepInbox?: boolean;
    /**
     * 過大的工具結果暫存到主機的哪裡（[#734](https://github.com/DemianLi/nexus-agent/issues/734)），原樣交給
     * `createNexusAgent`。兩條產品路徑在有會話日誌時傳：根從 `tool-result-stash` 那一列解、會話鑰匙是「續接時會回到
     * 同一個會話」的既有身分。省略就是記憶體暫存（沒有會話日誌的組裝、手搭的呼叫端）。
     */
    readonly toolResultStash?: ToolResultStashOptions;
    /** 附件儲存（#732），原樣交給 `createNexusAgent`。只有 serve 傳；省略就不掛附件那條唯讀路由。 */
    readonly attachments?: AttachmentStore;
    /**
     * 工具結果外溢層的預算（[#719](https://github.com/DemianLi/nexus-agent/issues/719)），原樣交給 `createNexusAgent`。
     * 從 `spill-policy` 那一列解；省略就是不掛。存處是上面的 `toolResultStash`，沒給它就不會外溢。
     */
    readonly spillPolicy?: { readonly maxInlineTokens: number };
    /**
     * 背景續行子代理的上限（[#841](https://github.com/DemianLi/nexus-agent/issues/841)）：**給了就是背景續行，省略就是一次性**。
     * 從 `background-subagents` 那一列解。**只有 serve 傳**：REPL 一行一輪、一次性模式答完就退出，背景子代理做完沒有
     * 可以叫醒的一輪，結果就送不回來。
     */
    readonly backgroundSubagents?: {
      readonly maxActive: number;
      /** 重啟之前派出的背景子代理怎麼冷復活（#1271）；省略＝這台沒落盤，不認得重啟之前的。只有 serve 傳。 */
      readonly cold?: ColdChildStore;
    };
    /**
     * 這個會話允許子代理挑哪些模型（[#875](https://github.com/DemianLi/nexus-agent/issues/875)），原樣交給 `createNexusAgent`：
     * 組裝點在 root 日誌還沒有政策事件時把它寫進去。**只有 serve 傳**（新會話從設定取樣、續接讀日誌那一顆）。
     */
    readonly modelSelectionPolicy?: ModelSelectionPolicy;
  },
  plugins: readonly PluginEntry[],
  cwd: string = process.cwd(),
  {
    onInvariantViolation,
    invariantTap,
    approvals,
    rootSeed,
    tokenAnchorBook,
    sessionLookup,
    mcpPool,
  }: CreateCliAgentSession = {},
): Promise<{
  agent: NexusAgent;
  dispose: () => Promise<void>;
  model: BaseChatModel;
  /** 這條 REPL 的會話註冊表。root 那一份就是 {@link sessionLog}。 */
  sessions: SessionRegistry;
  sessionLog: SessionLog;
  commands: CommandRegistrationPoint;
  projections: ProjectionRegistrationPoint;
  /**
   * 把這條 thread 的**每一份**會話日誌接上遙測、不變量配套入口與 `sessions` 通道的參與者，一個口三件事
   * （[#668](https://github.com/DemianLi/nexus-agent/issues/668)）。見 {@link SessionsAttachment}。
   */
  attachSessions: AttachSessions;
  /**
   * 三個口各自的原件，**只給要量單一消費者的測試**（例如「沒有配套入口時不接線」「出貨清單接得上」）。
   * 兩個入口與手搭 `ThreadAgent` 一律走 {@link attachSessions}：`ThreadAgent` 上沒有這三個，
   * 所以 serve 不可能再少轉交其中一個。
   */
  attachTelemetry: (sessions: SessionRegistry) => (() => Promise<void>) | undefined;
  attachInvariants: (sessions: SessionRegistry) => (() => void) | undefined;
  attachSession: (sessions: SessionRegistry, backgroundPort?: BackgroundParentPort) => () => void;
  telemetrySharing: SessionTelemetrySharingStatus | undefined;
  /** 評分與評語的規則。serve 那條交給 wire-handler；CLI 那條只用得到 `/feedback`（走命令面）。 */
  feedback: FeedbackService | undefined;
  /**
   * 每一輪的改動摘要，serve 交給 wire-handler 的兩條路由。**沒有 `workspace-changes` 那一列（CLI 不載 serve 專屬層、或被停用）
   * 或沒有工作區時是 `undefined`**——兩條路由對這三種成因的反應相同。
   */
  workspaceChanges: WorkspaceChanges | undefined;
  /**
   * 權限組合的目錄（#437）。有圍堵且 `permission-presets` 那一列掛上了才有；沒有時 wire 的 `permission.catalog` 回 `not_supported`、
   * `permissions` 投影缺席，web 藏起選單。
   */
  permissionPresets: { catalog(): PermissionCatalog } | undefined;
  /**
   * 續接時日誌記的沙箱模式比權限表裡每一組都寬，會話接上時會被收回預設組（[#1621](https://github.com/DemianLi/nexus-agent/issues/1621) Q2 (b)）。
   * 沒有這件事是 `undefined`。**只是通知**：收回由權限組合的會話參與者在 `attachSessions` 時往 root 日誌寫，這裡的值讓 serve／CLI 留一行 warn。
   */
  permissionNarrowed: PermissionNarrowing | undefined;
  /**
   * 訂閱「冷復活的背景子代理在讀回委派快照時被收回沙箱」（[#1739](https://github.com/DemianLi/nexus-agent/issues/1739)）。發生在組裝**之後**
   * （子代理被叫醒的那一輪），所以是訂閱而不是一格值；serve／CLI 各留一行 warn。同一個子代理在同一個行程裡只通知一次。沒有權限組合
   * （沒有圍堵）的組裝永遠不會觸發。回傳取消訂閱。
   */
  onDelegationNarrowed: (listener: (event: DelegationNarrowedEvent) => void) => () => void;
  /** 使用者可以點名派的子代理（`subagent.list`，#328 第 2 項）：`task` 實際收的那份。serve 交給 wire-handler。 */
  subagentKinds: readonly { readonly name: string; readonly description: string }[];
  /**
   * 這一次組裝的 goal 域，**沒掛時是 `undefined`**——出貨清單上有 goal，但一份 patch
   * 可以把那一列 `disabled: true` 關掉（[#455](https://github.com/DemianLi/nexus-agent/issues/455)
   * 拿掉 `--plugins` 之後，這是剩下的那條路）。兩條進入點都拿它去組 {@link goalDriverPort}。
   */
  goals: GoalServices | undefined;
  /**
   * `--workspace` 解析出來的絕對根，**沒給就是 `undefined`**
   * （[#452](https://github.com/DemianLi/nexus-agent/issues/452)）。
   *
   * 回傳它是因為算它的地方（這個函式裡）與要用它的地方是兩個 scope：serve 把它交給
   * wire-handler 的讀檔路由當錨。**呼叫端不要再寫一次 `resolve(cwd, ...)`**，見
   * {@link resolveWorkspaceRoot}。
   */
  workspaceRoot: string | undefined;
  /**
   * 把 LLM 標題接到一份 root 日誌上（[#650](https://github.com/DemianLi/nexus-agent/issues/650)），**沒有時是
   * `undefined`**：沒帶 `--live`，或清單上 `thread-title-llm` 那一列關掉了。
   *
   * 沒帶 `--live` 不掛是承重的：假模型的腳本是一格一格吃的，多出來的標題呼叫會吃掉主回覆的那一格。它也不另給
   * 一顆假模型——沒有人要讀一個假的標題。
   *
   * 接線同 {@link attachSessions}，交給呼叫端：CLI 接它那一份，serve 在 wire-handler 建 pump 的那一刻接。
   */
  attachTitle: AttachSessionTitleLlm | undefined;
  /** 這一次組裝掉了的可少掛條目（#751）；沒給 `optionalEntries` 時一律是空的。 */
  dropped: readonly AssemblyDrop[];
  /** 外掛在 `apply` 裡交出的警告（#751），例如 MCP 連不上而照樣掛上。 */
  warnings: readonly PluginWarning[];
  /** 組裝之後外掛執行期交出的警告（#1099），例如 MCP 掉線重連的進度；回傳取消訂閱。印在哪由呼叫端決定。 */
  onWarning: (listener: (warning: PluginWarning) => void) => () => void;
  /** 這一次組裝收不收插話（#710），見 `stepInbox` 那一格。 */
  stepInbox: boolean;
  /** 這一次組裝的外溢存檔服務（#1553 N0948）；**沒給工具結果暫存是 `undefined`**。見 `createNexusAgent` 回的那一格。 */
  spillStore: SpillStore | undefined;
  /** 每會話模型選擇的組裝端（#723）；**沒帶 `--live` 是 `undefined`**（假模型沒有型錄）。 */
  modelSelection: ModelSelectionHost | undefined;
}> {
  const liveModel = invocation.liveModel ?? startupSetting(plugins, liveModelPlugin);
  const subagentToolFilter = startupSetting(plugins, backgroundSubagentsPlugin).toolFilter;
  const model = createCliModel(
    invocation.live,
    liveModel,
    invocation.credentials,
    plugins,
    invocation.attachments,
    invocation.requestGate,
  );
  // **標題模型是另一顆實例**：輸出上限換成標題那一列的，並表明用途，由 `createLiveModel` 決定要不要關推理
  // （`live-model.ts` 的 `LiveModelPurpose`）。`.env` 已經在入口（`runCli`／`runServe`）載入過了。
  const attachTitle =
    invocation.live && startupEntryMounted(plugins, threadTitleLlmPlugin)
      ? titleLlmFor(
          liveModel,
          invocation.threadTitleLlm ?? startupSetting(plugins, threadTitleLlmPlugin),
          invocation.threadTitle ?? startupSetting(plugins, threadTitlePlugin),
          invocation.credentials,
          // 標題沒有自己的 modelId 時沿用主請求走的模型（#723）。
          { followMainRoute: true, requestGate: invocation.requestGate },
        )
      : undefined;
  // **channel 在這裡算一次，消費者共用。** 核准閘門由 `foldRegistry` 自己算
  // （同一個 `deriveApprovalChannel`），`ask_user_question` 與 `exit_plan_mode`（#652）拿的是這一份
  // ——分岔的樣子是「核准擋得下來、問答還掛在那裡」，而那不會有任何測試紅。
  //
  // **它掛在這裡而不是出貨清單裡**：那份清單是一個設定檔，看不到這一次
  // 呼叫的 checkpointer 與 `approvals`。
  // **綁在真的那個值上，不是寫死 `true`。** 今天這條路一律給 `PrunedMemorySaver`（只留最新存檔點的 `MemorySaver`，#1106），但把它寫成
  // 字面量的那一刻，這個推導就不再跟著組裝走了——有人讓 checkpointer 變成有條件的那天，
  // 核准閘門會正確地回報 `no-channel`，而 `ask_user_question` 還宣稱有人在，然後撞上
  // `interrupt()` 的 `No checkpointer set`。那正是抽出這個推導要防的分岔。
  const checkpointer = new PrunedMemorySaver();
  const channel = deriveApprovalChannel({
    ...(approvals?.enabled !== undefined && { approvalsEnabled: approvals.enabled }),
    hasCheckpointer: checkpointer !== undefined,
  });
  // **backend 只交給 `createNexusAgent`**：`submit_record` 與 `present` 從 `fs` 服務拿 `foldRegistry`
  // 折出來的那一個，就是 `write_file` 實際讀寫的那個（#694）。不要再另外交一份給 plugin——
  // 這一份是折前的，被路由的前綴上兩個工具會寫到兩個地方，**而且兩邊都會寫成功**。
  //
  // `undefined` 是「沒給 `--workspace`」，`createNexusAgent` 墊一顆 `TextOnlyStateBackend`。
  //
  // **模式是傳一個來源進去，不是一個字面值**：fence 逐次呼叫問一次，所以 `/permission` 換掉
  // 控制器那一格之後，下一次檔案變更就照新那格判（理由見 `SandboxModeSource`）。
  //
  // **控制器建在這裡而不是模組層**，這決定了它的壽命：`serve.ts` 一條 thread 呼叫一次
  // `createCliAgent`，所以一條 thread 一格。建在模組層或工廠閉包裡的話兩條 thread 會共用
  // 同一格——一條 thread 的 `/permission read-only` 收緊到另一條 thread 的檔案工具上，
  // 而那是靜默的（見 `sandbox-mode.ts` 的模組註解）。
  // 鍵在就用它的值（`undefined` 也算：沒有圍堵）；鍵不在才退回 `--workspace`（#1775，見 `workspaceRoot` 選項）。
  const workspaceRoot = Object.hasOwn(invocation, 'workspaceRoot')
    ? invocation.workspaceRoot
    : resolveWorkspaceRoot(invocation.workspace, cwd);
  // 唯讀共用區：入口給了就掛。有私有可寫根時共用區是 `--workspace`；落盤關掉的新 thread 可寫根是記憶體（`workspaceRoot` 是 `undefined`），
  // 共用區照樣掛（#1775，(f)）。舊 thread 與 CLI 不給。
  const sharedWorkspaceRoot = invocation.sharedWorkspaceRoot;
  // **有圍堵而 `sandbox-policy` 那一列沒掛：起不來**（#669，dsh 的方向）。fence 還在擋，模型卻不知道、也請不到升級，
  // 看起來像關掉了護欄其實護欄還在。不加進 `PROTECTED_ENTRY_NAMES`：沒有圍堵時關掉它是合法的（只剩那一句政策）。
  if (workspaceRoot !== undefined && !startupEntryMounted(plugins, sandboxPolicyPlugin)) {
    throw new Error(
      '有 --workspace（檔案系統有圍堵），但清單上的 sandbox-policy 那一列沒有掛（不存在或被停用）。' +
        '它負責把檔案政策講給模型、記進日誌與提供升級；關掉它而 fence 照舊在擋，模型不知道自己被擋、也請不到升級。' +
        '要嘛把那一列留著，要嘛不要給 --workspace。',
    );
  }
  // **有圍堵而 `permission-presets` 那一列沒掛：同樣起不來。** `/sandbox` 已經拿掉（#437），`/permission` 是切沙箱與核准的唯一入口；
  // 那一列不在，使用者就沒有任何辦法在會話中收緊或放寬。掛了但 `apply` 拋（組合表壞了）則由 `startup-audit.ts` 的必掛名單接住——那一列的 id 在 `REQUIRED_ENTRY_IDS` 上；
  // `defaultPreset` 與 `--sandbox` 矛盾、起始值對不上任何一組這兩種逐條 thread 的錯在 `start` 拋（下面「權限組合的起始值」那一段），包成 `AssemblyDropError`。
  if (
    workspaceRoot !== undefined &&
    !startupEntryMounted(plugins, { name: PERMISSION_PRESETS_PLUGIN_NAME })
  ) {
    throw new Error(
      '有 --workspace（檔案系統有圍堵），但清單上的 permission-presets 那一列沒有掛（不存在或被停用）。' +
        '它提供 /permission——切換檔案政策與核准政策的唯一入口；關掉它，會話中就沒有任何辦法改這兩顆旋鈕。' +
        '要嘛把那一列留著，要嘛不要給 --workspace。',
    );
  }
  const sandboxMode = new SandboxModeController(invocation.sandbox ?? 'workspace-write');
  // **核准政策的控制器也建在這裡**，理由同上（一條 thread 一格）。`approvals.policy` 把它的來源交給閘門與升級工具，
  // `approvalPolicy` 服務把控制器本身交給 `approval-gate` 那一列去接日誌；**與 `approvals.enabled`（入口有沒有人在）是兩件事**。
  //
  // **起始值：續接用日誌記的，新會話由 `--sandbox` 推**（偏離，登記在 `packages/nexus-plugin-permission-presets/src/index.ts` 檔頭第 1 條）：
  // 全開就是 `never`、其他是 `ask`，同 dsh 的 `DSH_PERMISSION_MODE`。**續接的呼叫端一定會把 `approvalPolicy` 給滿**
  // （`cli.ts`、`serve.ts` 的合併：記著的，沒記就 `ask`）——否則一份只記了全開沙箱、沒記核准的舊日誌會在這裡被推成 `never`。
  const approvalPolicy = new ApprovalPolicyController(
    invocation.approvalPolicy ?? (invocation.sandbox === 'danger-full-access' ? 'never' : 'ask'),
  );
  /** 這次組裝 fold 完的 fs 把手，`createNexusAgent` 回來之後才填；保留清單讀它。 */
  const settled: { fs?: FsService } = {};
  const backend =
    workspaceRoot === undefined
      ? undefined
      : // **grant 也從同一顆控制器認領**：升級工具把 grant 發在它身上（`sandbox-escalation.ts`），
        // fence 在被擋下時來這裡認領。給 fence 另一個 ledger 的話，核准了也認領不到。
        new ContainedFilesystemBackend({
          rootDir: workspaceRoot,
          mode: sandboxMode.source,
          grants: sandboxMode,
          // 多人共用主機上的使用者工作區：別人的 0600 檔、0700 目錄讀不到不讓整次搜尋失敗（偏離 dsh，#1704）。
          tolerateUnreadable: true,
          // 技能來源要 fold 完才知道，所以逐次讀下面填的 fs 把手。
          ...(invocation.rootIsShared === true && {
            reservedWrites: () => sharedReservedWrites(settled.fs),
          }),
        });
  // **每會話模型選擇只在 `--live` 時有**（#723）：假模型沒有型錄可選。控制器由組裝點建、經 `createNexusAgent` 折進 root，
  // 同一個 host 回傳給呼叫端（serve 的 `model.catalog`／`model.select` 用它驗型錄）。
  const modelSelection = invocation.live
    ? createModelSelectionHost({
        liveModel,
        credentials: invocation.credentials,
        ...(invocation.attachments !== undefined && { attachments: invocation.attachments }),
        ...(invocation.requestGate !== undefined && { requestGate: invocation.requestGate }),
      })
    : undefined;
  const {
    agent,
    commands,
    projections,
    dispose,
    attachTelemetry,
    attachInvariants,
    attachSession,
    telemetrySharing,
    feedback,
    services,
    dropped,
    warnings,
    onWarning,
    stepInbox,
    spillStore,
    subagentKinds,
  } = await createNexusAgent({
    model,
    // 沒傳就在這裡按型錄建一本（#1102）：fold 自己 new 的那本不認得哪些模型逐位切詞。
    tokenAnchorBook:
      tokenAnchorBook ??
      new TokenAnchorBook({ singleDigitModels: singleDigitModelIds(liveModel.models) }),
    plugins: [
      // **組裝點的協作者排最前面**（#459）：ask-user、plan-mode、sandbox-policy 在自己的
      // `apply` 當下就讀，排後面它們會拿不到。載入是一趟到底的，不會回頭等。
      createHostServicesPlugin({
        channel,
        approvalPolicy,
        // MCP 連線池（#1677）：缺席＝每列自己連（CLI）。
        [MCP_POOL_SERVICE]: mcpPool,
        // MCP 設定裡的憑證引用（#1989）：跟模型 key 同一份憑證服務、同一條規則；缺席＝寫了引用的列連不上。
        ...(invocation.credentials !== undefined && {
          [MCP_CREDENTIALS_SERVICE]: mcpCredentialsOf(invocation.credentials),
        }),
        // 唯讀共用區的前綴（#1775）：缺席＝這條 thread 沒有共用區（舊 thread、CLI）。**與有沒有圍堵無關**：落盤關掉的新 thread 沒有圍堵、共用區照樣在。
        ...(sharedWorkspaceRoot !== undefined && { sharedWorkspace: SHARED_WORKSPACE_PREFIX }),
        // MCP 的沙箱包裝（#1946）：缺席＝宣告了 sandbox 的列不連線。
        [MCP_SANDBOX_SERVICE]: createMcpSandboxWrapper(),
        // **有沒有圍堵是一格獨立的事實，不是控制器在不在**（#669）：對應 dsh 的 `ctx.fs.sandboxMode`。`sandbox-policy` 那一列據它
        // 分岔——有圍堵就掛控制器、升級；沒有就只貢獻那一句不宣稱圍堵的政策。兩個服務一起交，缺一個
        // 那一列載入當場拋（有圍堵卻缺控制器）。
        ...(workspaceRoot === undefined
          ? {}
          : {
              // **工作區根也是一格 host 服務**（#669 第 4 步）：`workspace-changes` 等要根的列在 `apply` 當下讀它，沒有就不合格
              // （照 dsh 的 `eligible`）；以前是組裝點把根塞進那一列的 Config，那一列就進不了出貨清單。
              workspaceRoot,
              [GIT_STARTER_SERVICE]: createGitStarter(sandboxMode.source, workspaceRoot),
              fsContainment: CONTAINED_FILESYSTEM,
              sandboxPolicy: {
                controller: sandboxMode,
                rootDir: workspaceRoot,
                // 舊 thread 的保留清單（#1960）：升級工具據它不對寫不進去的目標掛卡（#2078）。
                ...(backend !== undefined && {
                  reservedReason: (target: string) => backend.reservedReason(target),
                }),
              },
            }),
      }),
      ...plugins,
      // **`@` 引用那一句跟圍堵同一個條件**（#651）：沒有工作區時不提供列檔，使用者插不出 `@` 路徑，檔案工具讀的也不是磁碟。
      ...(workspaceRoot === undefined ? [] : [createFileReferencePlugin()]),
      ...(modelSelection === undefined ? [] : [createModelSelectionPlugin(modelSelection)]),
    ],
    ...(modelSelection !== undefined && {
      modelSelection: modelSelection.controller,
      modelLimits: modelSelection.limitsOf,
      // 子代理定義的 `model`／`reasoningEffort` 在註冊那一刻對型錄驗（#328 第 3 項）；沒有每會話選擇（假模型）就沒有型錄，驗證函式走預設的全拒。
      validateSubagent: subagentDefinitionValidator(liveModel.models),
    }),
    // 模型呼叫失敗的整次重打（#520、#1427）：首事件之前與之後共用 `retryPolicy` 這一份。只有真模型的 fetch 層與
    // `onFailedAttempt` 會回報失敗，腳本模型照給也無事發生。
    streamRetry: streamRetryOptionsOf(liveModel.retryPolicy),
    ...(backend !== undefined && { backend }),
    ...(sharedWorkspaceRoot !== undefined && { sharedWorkspace: { rootDir: sharedWorkspaceRoot } }),
    ...(invocation.recursionLimit !== undefined && { recursionLimit: invocation.recursionLimit }),
    systemPrompt: SYSTEM_PROMPT,
    // **`--live` 時是 `live-model` 那一列的型號**，跟上面 `createCliModel` 讀的是同一份，兩邊不會漂移；
    // 假模型沒有型號，用 {@link SCRIPTED_MODEL_NAME}。
    systemPromptVariables: {
      model: invocation.live ? liveModel.modelId : SCRIPTED_MODEL_NAME,
      cwd: PROMPT_WORKING_DIRECTORY,
    },
    checkpointer,
    ...(sessionLookup !== undefined && { sessionLookup }),
    ...(onInvariantViolation !== undefined && { onInvariantViolation }),
    ...(invariantTap !== undefined && { invariantTap }),
    approvals: { ...approvals, policy: approvalPolicy.source },
    ...(invocation.optionalEntries !== undefined && {
      optionalEntries: invocation.optionalEntries,
    }),
    ...(invocation.stepInbox === true && { stepInbox: true }),
    // 子代理的工具過濾（#707）：兩條產品路徑都讀，與背景續行無關，見 `settings/background-subagents.ts` 檔頭。
    ...(subagentToolFilter !== undefined && { subagentToolFilter }),
    ...(invocation.modelSelectionPolicy !== undefined && {
      modelSelectionPolicy: invocation.modelSelectionPolicy,
    }),
    // 沙箱控制器只在有圍堵時給：沒有 `--workspace` 就沒有沙箱參與者，快照與讀回無從做起（同上面的 sandbox-policy 條件）。
    ...(invocation.backgroundSubagents !== undefined && {
      backgroundSubagents: {
        maxActive: invocation.backgroundSubagents.maxActive,
        ...(invocation.backgroundSubagents.cold !== undefined && {
          cold: invocation.backgroundSubagents.cold,
        }),
        // 這個會話的授權清單（#877）：有政策才給，`subagent` 才多選模型的兩格與 `list_subagent_models`。
        ...(invocation.modelSelectionPolicy !== undefined && {
          modelSelection: {
            allowedModels: invocation.modelSelectionPolicy.allowedModels,
            rootModelId: liveModel.modelId,
            catalog: liveModel.models,
          },
        }),
        // 背景子代理被指定模型時才用到（#876）：同一個端點、另一個型錄 id。沒連真實供應商就沒有別的模型可建。
        ...(invocation.live && {
          modelFor: liveSubagentModelFor(liveModel, invocation.credentials, invocation.requestGate),
        }),
        ...(workspaceRoot !== undefined && { sandbox: sandboxMode }),
      },
    }),
    toolMode: sandboxMode.source,
    ...(invocation.toolResultStash !== undefined && {
      toolResultStash: invocation.toolResultStash,
    }),
    ...(invocation.attachments !== undefined && { attachments: invocation.attachments }),
    ...(invocation.spillPolicy !== undefined && { spillPolicy: invocation.spillPolicy }),
  });
  settled.fs = services.get(FS_SERVICE);
  // **權限組合的起始值**（#1491 Q3 (a)）：向 `permission-presets` 那一列要（它提供、折進這條 thread 的 `permissionPresets` 服務），再對兩顆控制器
  // **靜默** `switchTo` 回來的值。呼叫點在 `createNexusAgent` 回來之後、回傳之前——控制器與 fence 早在 `createNexusAgent` 之前就建好了，
  // 折進來的服務要等它回來才拿得到。**這時還沒有日誌接著**（`attachSessions` 在呼叫端），所以不寫事件，新會話日誌上 `sandbox/mode` 仍只有一顆；
  // 之後各參與者接日誌時才把起始值釘進去。跟以前一樣：以前也是在還沒接日誌時由那一列的 `apply` 靜默切。
  //
  // 這一步的兩種錯（跟 `--sandbox` 矛盾、起始值對不上任何一組）是逐條 thread 的，包成以 `permission-presets` 為不能少掛條目的
  // `AssemblyDropError`：serve 試組、逐條 thread 與 CLI 三條路都照以前「那一列掉了 → 必掛」的方式記錄與轉換。內層訊息逐字不變。
  let permissionCatalog: PermissionCatalog | undefined;
  let permissionNarrowed: PermissionNarrowing | undefined;
  const delegationNarrowedListeners = new Set<(event: DelegationNarrowedEvent) => void>();
  if (workspaceRoot !== undefined) {
    const presets = services.get<PermissionPresetsService>(PERMISSION_PRESETS_SERVICE);
    if (presets === undefined) {
      await dispose().catch(() => {});
      throw new Error(
        `有 --workspace（檔案系統有圍堵），但 ${PERMISSION_PRESETS_SERVICE} 服務沒有折進這條 thread——` +
          'permission-presets 那一列沒有提供它（這條 thread 的圍堵事實沒有交到樹上，或那一列沒有起來）。',
      );
    }
    try {
      const started = presets.start({
        // 這一次是怎麼開始的：沒有續接的日誌就是新會話；`--sandbox` 有給才算明確。
        //
        // **「新會話」看 `approvalPolicy` 有沒有給，不看 `rootSeed`**：`serve` 的註冊表是 pump 建的、不經這個工廠，
        // 它不傳 `rootSeed`；而兩條產品路徑的續接一律把 `approvalPolicy` 給滿（記著的，沒記就 `ask`），新會話一律不給。
        seed: {
          fresh: invocation.approvalPolicy === undefined,
          sandboxExplicit:
            invocation.approvalPolicy === undefined && invocation.sandbox !== undefined,
        },
        sandbox: sandboxMode.current,
        approval: approvalPolicy.current,
      });
      sandboxMode.switchTo(started.sandbox);
      approvalPolicy.switchTo(started.approval);
      permissionCatalog = started.catalog;
      permissionNarrowed = started.narrowed;
      // **冷復活的背景子代理讀回委派快照時過的上限**（#1739）：背景子代理每一輪由 host 的 `enter` 走 `delegateFromLog`，快照是委派當下寫進它自己日誌的；
      // 部署方事後把全開從組合表拿掉，root 在續接時收回了，冷復活的子代理讀回的仍是全開。只看「表＋快照」，不讀 root 當下的狀態（照 dsh，快照在
      // 委派時拍、冷復活只重播）；讀回時收、**不寫子代理日誌**（多寫就多一個能移動 fence 的寫入處）。偏離登記在 `@nexus/plugin-permission-presets` 檔頭第 10 條。
      sandboxMode.setDelegationCeiling((recorded, log) => {
        const narrowing = presets.narrowDelegated(recorded);
        if (narrowing === undefined) return recorded;
        if (!warnedDelegationNarrowing.has(log.sessionId)) {
          warnedDelegationNarrowing.add(log.sessionId);
          for (const listener of delegationNarrowedListeners) {
            listener({ sessionId: log.sessionId, ...narrowing });
          }
        }
        return narrowing.toSandbox;
      });
    } catch (error) {
      await dispose().catch(() => {});
      throw assemblyDropErrorFor(plugins, PERMISSION_PRESETS_PLUGIN_NAME, error, dropped) ?? error;
    }
  }
  // 註冊表跟 agent 同壽命：REPL 是一條連續對話，`seq` 要跨輪連續才有意義。**subagent 的
  // 那些日誌也掛在它上面**，第一次有人要寫的時候才出生（見 `SessionRegistry` 的偏離）。
  const sessions = new SessionRegistry(THREAD_ID, rootSeed === undefined ? {} : { rootSeed });
  const sessionLog = sessions.root;
  // **這裡不替呼叫端接。** 這個工廠兩條路都在用，而 serve 那條不用這份 `sessionLog`——它一個
  // thread 一份，註冊表是 pump 建的。在這裡接等於幫 serve 接上一份永遠不會有事件的日誌，只送得出一筆
  // `shutdown`。但**接什麼、接的順序、怎麼收**定成 {@link AttachSessions} 一個口，呼叫端只剩「對哪一份
  // 註冊表接」這一個決定，不再各寫一份三行接線。
  const attachSessions = composeAttachSessions({
    attachTelemetry,
    attachInvariants,
    attachSession,
  });
  return {
    agent,
    dispose,
    model,
    sessions,
    sessionLog,
    commands,
    projections,
    attachSessions,
    attachTelemetry,
    attachInvariants,
    attachSession,
    telemetrySharing,
    feedback,
    workspaceChanges: services.get(WORKSPACE_CHANGES_SERVICE),
    // wire 的 `permission.catalog` 讀它：逐條 thread 的目錄（含這條 thread 的預設組，偏離登記在 `@nexus/permission-presets`）。
    permissionPresets:
      permissionCatalog === undefined ? undefined : { catalog: () => permissionCatalog },
    permissionNarrowed,
    onDelegationNarrowed: (listener) => {
      delegationNarrowedListeners.add(listener);
      return () => void delegationNarrowedListeners.delete(listener);
    },
    subagentKinds,
    goals: services.get<GoalServices>(GOALS_SERVICE),
    workspaceRoot,
    attachTitle,
    dropped,
    warnings,
    onWarning,
    stepInbox,
    spillStore,
    modelSelection,
  };
}

/**
 * 交給 MCP 那幾列的憑證服務（[#1989](https://github.com/DemianLi/nexus-agent/issues/1989)）：只要值，來源層不往外交。
 *
 * @param credentials - 這次啟動的憑證服務。
 */
export function mcpCredentialsOf(credentials: CredentialService): McpCredentials {
  return { resolve: (name) => credentials.resolve(name)?.value };
}

/**
 * 背景子代理被指定模型時建的那一顆（#876）：同一個端點、另一個型錄 id，推理強度 `off` 時關推理。
 *
 * **要接全機的並行閘**（#1505）：子代理的請求是並行請求的大宗（每個主對話最多 8 個背景子代理），漏接這一處，閘就管不到最會
 * 衝量的那一類。抽成具名函式，是為了它測得到（`request-gate-wiring.test.ts`）；`requestGate` 是**必傳的位置參數**，
 * 少寫在型別上就編不過（不給閘要明著傳 `undefined`）。
 *
 * @param liveModel - `live-model` 那一列（連線值與型錄）。
 * @param credentials - 憑證服務。
 * @param requestGate - 全機的模型請求並行閘；`undefined`＝不限。
 */
export function liveSubagentModelFor(
  liveModel: LiveModelConfig,
  credentials: CredentialService | undefined,
  requestGate: RequestGate | undefined,
): (choice: ModelChoice) => BaseChatModel {
  return (choice) =>
    createLiveModel({ ...liveModel, modelId: choice.model }, undefined, credentials, {
      ...(choice.effort === 'off' && { thinkingOff: true }),
      ...(requestGate !== undefined && { requestGate }),
    });
}

/**
 * 標題請求要記的推理強度（[#1573](https://github.com/DemianLi/nexus-agent/issues/1573)，照 dsh 1517a4db `session-title-first-prompt-llm/src/index.ts:74-76`
 * 取最低一級）。標題那顆以 `purpose: 'session-title'` 建，`live-model` 會依型錄條目關推理（`thinkingOffBody`）；這裡用
 * 同一個判準（{@link declaresOffEffort}）決定記不記 `'off'`，只讓紀錄多一格，不碰送出去的請求。
 *
 * **只有條目宣告了 `off` 時才跟 dsh 一致。** 沒宣告 `off` 的條目，dsh 取 `efforts[0]`（最低一級），紀錄和送出都用它；nexus 兩樣都不做
 * （沒有 `off` 以外的線上寫法），已登記為理由 1，見 `model-catalog.ts` 檔頭「`reasoningEfforts` 的驗證只搬 dsh 的前三條」那一條。
 *
 * @param models - `live-model` 的型錄。
 * @param modelId - 這顆標題模型的 id。
 * @returns 條目宣告了 `off` 就 `{ reasoningEffort: 'off' }`；沒宣告（或不在型錄）就 `{}`，紀錄上沒有這個 key。
 */
function titleReasoningEffort(
  models: LiveModelConfig['models'],
  modelId: string,
): { readonly reasoningEffort?: string } {
  const entry = findModelEntry(models, modelId);
  return entry !== undefined && declaresOffEffort(entry) ? { reasoningEffort: 'off' } : {};
}

/**
 * 這一次組裝的 LLM 標題。路由是 `live-model` 那一列的連線（一個組裝一條連線）加上實際走的那顆模型：
 * `thread-title-llm` 的 `modelId`（#657）挑型錄裡的一筆，沒給就是 `live-model` 的預設模型；記進
 * `session/title-llm-request` 與 provider 標題的 `model`。
 *
 * @throws 標題挑的 `modelId` 不在 `live-model` 的型錄裡：指名 `thread-title-llm` 這一列與那個 id。
 */
function titleLlmFor(
  liveModel: LiveModelConfig,
  config: ThreadTitleLlmConfig,
  limits: ThreadTitleConfig,
  credentials: CredentialService | undefined,
  options: {
    readonly followMainRoute: boolean;
    /** 全機的模型請求並行閘（#1505）：標題的請求也算一個名額，兩顆（預設的與跟隨主路由的）都要掛。 */
    readonly requestGate?: RequestGate | undefined;
  } = { followMainRoute: false },
): AttachSessionTitleLlm {
  const requestGate = options.requestGate;
  const modelId = config.modelId ?? liveModel.modelId;
  const followedTitleModels = new Map<string, BaseChatModel>();
  if (findModelEntry(liveModel.models, modelId) === undefined) {
    const known = liveModel.models.map((entry) => entry.id).join('、');
    throw new Error(
      `thread-title-llm（#settings/thread-title-llm）的 modelId "${modelId}" 不在 live-model 的 models 型錄裡（型錄有：${known}）`,
    );
  }
  return createSessionTitleLlm({
    model: createLiveModel({ ...liveModel, modelId }, 'session-title', credentials, {
      maxOutputTokens: config.maxOutputTokens,
      ...(requestGate !== undefined && { requestGate }),
    }),
    route: { provider: liveModel.baseUrl, model: modelId },
    ...titleReasoningEffort(liveModel.models, modelId),
    config,
    limits,
    // 標題不在模型呼叫圖裡，SDK 層又不重試了（#1427）：自己吃同一份政策，不記日誌。
    retry: streamRetryOptionsOf(liveModel.retryPolicy),
    // **標題自己指定了模型就不跟**（`config.modelId`）；沒指定才沿用觸發它的那次主請求走的（#723，照 dsh）。
    // 主請求走預設、或路由不在型錄裡（續接的會話選過後來被拿掉的模型）時回 `undefined`，用上面預設那顆。
    ...(options.followMainRoute &&
      config.modelId === undefined && {
        follow: (mainRoute: ModelRoute) => {
          if (mainRoute.model === modelId) return undefined;
          if (findModelEntry(liveModel.models, mainRoute.model) === undefined) return undefined;
          let followed = followedTitleModels.get(mainRoute.model);
          if (followed === undefined) {
            followed = createLiveModel(
              { ...liveModel, modelId: mainRoute.model },
              'session-title',
              credentials,
              {
                maxOutputTokens: config.maxOutputTokens,
                ...(requestGate !== undefined && { requestGate }),
              },
            );
            followedTitleModels.set(mainRoute.model, followed);
          }
          return {
            model: followed,
            route: { provider: liveModel.baseUrl, model: mainRoute.model },
            ...titleReasoningEffort(liveModel.models, mainRoute.model),
          };
        },
      }),
  });
}

/**
 * 組出排程器要問域的那四件事。**兩條進入點共用這一個**。
 *
 * `log` 是 getter 不是值，因為 serve 那條路上日誌由 `ThreadPump` 建，而 port 要在 pump
 * 之前組好（pump 的建構參數就是它）。
 *
 * **`goals` 是這一次組裝的那一份**（[#459](https://github.com/DemianLi/nexus-agent/issues/459)）。
 * 以前它是模組層級的一顆 plugin 物件上的查表，所以同一個 process 裡兩次組裝共用一份
 * ——症狀是一條 thread 的目標被另一條 thread 的排程器讀到。現在它由
 * `registry.services` 交出來，一次組裝一份。
 *
 * @param goals - 這一次組裝的 goal 域；**沒掛就是 `undefined`**。
 * @param log - 讀那一份日誌；服務綁在它上面。
 * @param flush - 耐久檢查點。沒落盤時給一個 no-op。
 * @param warn - 排程器出事時說話的去處。
 * @param waitForChildren - 等背景子代理停下來（#1575）。缺席＝不等（CLI、沒有背景 host 的組裝）。
 * @returns 排程器要問域的四件事。
 */
export function goalDriverPort(
  goals: GoalServices | undefined,
  log: () => SessionLog,
  flush: () => Promise<void>,
  warn: (message: string) => void,
  waitForChildren?: (signal?: AbortSignal) => Promise<boolean>,
): GoalDriverPort {
  return {
    // **查不到就是 `undefined`**：patch 把 goal 那一列關掉時這條路就沒有 goal 域，
    // 那時排程器安靜地什麼都不做。
    //
    // **這四格走會建立的 `serviceFor`**（lazy，#1486）：排程器問的時候這條 thread 已經有過一輪，建一次的成本與以前「接上日誌就建」同量級，
    // 而且它們的語意這張卡不改。**逐出判斷的那一讀不在這裡**，見 {@link GoalDriverPort.armed}。
    goal: () => goals?.serviceFor(log()).get(),
    block: (ref, reason) => void goals?.serviceFor(log()).block(ref, reason),
    disarm: () => void goals?.serviceFor(log()).disarm(),
    pause: (ref) => void goals?.serviceFor(log()).pause(ref),
    // **不建立的讀法**（閒置逐出用）：沒被問過的日誌上沒有服務，就沒有人掛過授權，等價於「沒有武裝的目標」。見 `GoalServices.existingFor`。
    armed: () => {
      const goal = goals?.existingFor(log())?.get();
      return goal?.phase === 'active' && goal.activation === 'armed';
    },
    flush,
    warn: (message) => warn(`[續行] ${message}`),
    ...(waitForChildren !== undefined && { waitForChildren }),
    // **不經 `serviceFor`**（N0376）：訂閱與種子都不該為一條沒碰過 goal 的 thread 觸發整份日誌的重播（#1486）。
    onActivationChanged: (listener) => goals?.onActivationChanged(log(), listener) ?? (() => {}),
    currentActivation: () => {
      try {
        const goal = goals?.existingFor(log())?.get();
        return goal === undefined
          ? undefined
          : { goal: { id: goal.id, revision: goal.revision, activation: goal.activation } };
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * serve 每條 thread 交給 wire handler 的 `goalDriver` 工廠（具名抽出來，#1575 W4 的紅燈）。
 *
 * 以前這一段是 `serve.ts` 裡的行內閉包：N0372 在產品路徑上的效果完全靠它把 `waitForChildren` 轉進 {@link goalDriverPort}，
 * 而拿掉那一格所有測試照樣綠（實測）。抽成具名函式之後 `serve.ts` 只剩「用它」，轉呼這一層有單元測試釘住。
 *
 * @param goals - 這一條 thread 自己那一次組裝的 goal 域（#459）。
 * @param warn - 排程器出事時說話的去處。
 * @param roundCap - 續行輪數上限的有效值與來源；沒設就不帶（排程器用預設）。
 * @returns wire handler 要的 `(log, flush, waitForChildren) => GoalDriverPort`。
 */
export function serveGoalDriver(
  goals: GoalServices | undefined,
  warn: (message: string) => void,
  roundCap?: GoalRoundCap,
): (
  log: () => SessionLog,
  flush: () => Promise<void>,
  waitForChildren?: (signal?: AbortSignal) => Promise<boolean>,
) => GoalDriverPort {
  return (log, flush, waitForChildren) => ({
    ...goalDriverPort(goals, log, flush, warn, waitForChildren),
    ...(roundCap !== undefined && { roundCap }),
  });
}
