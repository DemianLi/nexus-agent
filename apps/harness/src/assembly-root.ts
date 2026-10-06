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

import { resolve, sep } from 'node:path';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { MemorySaver } from '@langchain/langgraph';
import type {
  ApprovalPolicy,
  CommandRegistrationPoint,
  ProjectionRegistrationPoint,
  FeedbackService,
  InvariantError,
  InvariantTap,
  PluginEntry,
  PluginWarning,
  SessionEvent,
  SessionTelemetrySharingStatus,
} from '@nexus/core';
import { ECHO_TOOL_NAME } from '@nexus/plugin-echo';
import type { BackgroundParentPort, ModelChoice } from './background-subagents.js';
import { composeAttachSessions } from './session-attach.js';
import type { AttachSessions } from './session-attach.js';
import { backgroundSubagentsPlugin } from './settings/background-subagents.js';
import { liveModelPlugin } from './settings/live-model.js';
import type { LiveModelConfig } from './settings/live-model.js';
import { startupEntryMounted, startupSetting } from './settings/startup.js';
import { threadTitlePlugin } from './settings/thread-title.js';
import type { ThreadTitleConfig } from './settings/thread-title.js';
import { findModelEntry, singleDigitModelIds } from './model-catalog.js';
import { resolveDefaultModel } from './model-provider.js';
import type { ModelSelectionPolicy } from './model-selection-policy.js';
import { threadTitleLlmPlugin } from './settings/thread-title-llm.js';
import type { ToolResultStashOptions } from './tool-result-stash.js';
import type { ThreadTitleLlmConfig } from './settings/thread-title-llm.js';
import { createSessionTitleLlm } from './session-title-llm.js';
import type { AttachSessionTitleLlm } from './session-title-llm.js';
import {
  createHostServicesPlugin,
  SessionRegistry,
  deriveApprovalChannel,
  type SessionLog,
  TokenAnchorBook,
} from '@nexus/core';
import {
  HARNESS_HOME_DIR_NAME,
  HARNESS_HOME_ENV,
  HARNESS_SESSIONS_DIR_NAME,
  harnessInvariantLogPath,
  harnessSessionsDir,
} from './harness-home.js';
import { DEFAULT_MAX_GOAL_ROUNDS, GOALS_SERVICE } from '@nexus/plugin-goal';
import type { GoalServices } from '@nexus/plugin-goal';
import { createWorkspaceChanges, WORKSPACE_CHANGES_SERVICE } from '@nexus/plugin-workspace-changes';
import type { WorkspaceChanges } from '@nexus/plugin-workspace-changes';
import { createNexusAgent } from './agent-factory.js';
import type { GoalDriverPort } from './goal-driver.js';
import type { AssemblyDrop, NexusAgentHandle } from './agent-factory.js';
import { isSandboxMode, SANDBOX_MODES, ContainedFilesystemBackend } from './contained-backend.js';
import { createSandboxPolicyPlugin } from '@nexus/plugin-sandbox-policy';
import { SandboxModeController } from '@nexus/plugin-sandbox-policy';
import type { SandboxMode } from './contained-backend.js';
import type { CredentialService } from './credentials.js';
import { createLiveModel } from './live-model.js';
import { createFileReferencePlugin } from './file-references.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';

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
   * `--sandbox read-only` 的人可能落在 `workspace-write` 裡。要換就接起來之後 `/sandbox`，
   * 那一次會記進日誌。**不配 `--session-log`**：續接就寫回那個目錄，給兩個等於兩個寫入
   * 目的地。
   */
  readonly resume?: string;
  /**
   * 一個 active 的目標沒達成時自己再開一輪（[#180](https://github.com/DemianLi/nexus-agent/issues/180)）。
   *
   * **預設關，而且那是一個決定不是保守。** dsh 的續行驅動器是「需要你刻意掛載的可選消費
   * 方」（`packages/goal/README.zh.md`），而我們的入口點擁有輪迴圈——**掛載的等價物就是
   * 這個旗標**。
   *
   * （2026-09-19 註：引文是 dsh 當時 README 的原話，但 dsh 的 base 其實出廠就掛著續行驅動器——
   * 「可選」指套件可以不掛，不是出廠關著。這個決定不動，前提待重核，見
   * `.docs/plugin-architecture-gap-survey.md` §三第 18 列。）
   *
   * 開著的時候，唯一的硬上限是那個目標自己的 `max_goal_rounds`；額外那條停損刻意沒做，
   * 理由在 `goal-driver.ts` 檔頭。
   */
  readonly goalDriver: boolean;
  /**
   * 這一次呼叫最多讓續行排幾輪。省略即不設，只剩目標自己那一條。
   *
   * **它存在的理由是目標自己那條上限不歸操作的人管**：`service.ts:269` 是
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
 * **純字串前綴比對，不 canonicalize**——同 `ContainedFilesystemBackend` 的取捨與同一個
 * 已知缺口（symlink 繞得過）。這裡擋的是順手指到工作區裡，不是惡意。
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
 * 不變量量測記錄（[#976](https://github.com/DemianLi/nexus-agent/issues/976)）要寫到哪裡；
 * **不該寫的時候回 `undefined`**，呼叫端就不建 tap。它跟著會話日誌的兩條既有承諾走，不另立規矩：
 *
 * - **落盤關掉就一個位元組都不寫**（#612）：清單上 `session-persistence` 那一列沒掛，home 連目錄都不建。
 * - **預設位置不能落在 `--workspace` 底下**（#424）：寫在可寫根裡，模型讀得到也改得動。會話日誌那一格
 *   遇到這種情況是當場拋（`resolveSessionLogDir`）；這裡**只是不寫**，因為量測記錄不是使用者要的東西，
 *   不值得替它擋掉一次啟動。唯一到得了這個分支的組合是 `--session-log` 明指到工作區外、home 卻在工作區裡。
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

/** 兩個日誌目錄旗標共用的那道檢查。**一份**，理由同 {@link resolveSessionLogDir} 的呼叫端。 */
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
  if (directory === workspace || directory.startsWith(`${workspace}${sep}`)) {
    throw new Error(
      `${subject} 不能在 --workspace 底下（${directory} 在 ${workspace} 之內）。` +
        `會話日誌是基礎建設，不是 agent 的工作區——寫在可寫根裡，模型讀得到也改得動整份對話史。` +
        remedy,
    );
  }
  return directory;
}

/**
 * 假模型的腳本：呼叫一次 echo 再回一句話。
 *
 * **它是對著出貨清單（`apps/harness/cordis.yml`）寫的。** 拿 patch 把 `echo` 那一列關掉或換掉
 * 就該一起換 `--live`——腳本裡的工具名那時多半不存在，假模型只會製造一個看不懂的失敗。
 * 腳本三輪，而第一句話就用掉兩輪（呼叫工具、拿到結果再回覆），所以假模型下的 REPL
 * 問到第三句就會用完（`ScriptedChatModel` 選擇當場失敗而不是靜默重播）；REPL 的正經
 * 用法是 `--live`。
 */
/** 假模型腳本寫出去的那個檔。測試靠它確認檔案真的落在 `--workspace` 指的目錄底下。 */
export const CLI_PROBE_FILE = '/cli.md';

const CLI_SCRIPT: readonly ScriptedTurn[] = [
  {
    content: '先回聲一次，確認工具接得上。',
    toolCalls: [{ name: ECHO_TOOL_NAME, args: { message: 'CLI 接線測試' } }],
  },
  {
    // 再寫一個檔。**這一輪是給 `--workspace` 用的**：預設的虛擬 FS 底下它只是讓
    // 「虛擬檔案系統：…」那行有東西可印，換成真實磁碟時它就是「檔案真的落在那個
    // 目錄底下」的證據。少了它，`--workspace` 給了跟沒給在畫面上分不出來。
    content: '再寫一個檔，確認檔案系統接得上。',
    toolCalls: [{ name: 'write_file', args: { file_path: CLI_PROBE_FILE, content: 'CLI 寫的' } }],
  },
  { content: '工具回來了，這條線是通的。' },
  { content: '假模型只會照腳本說話——要真的對話請用 --live。' },
];

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
 * （`service.ts:269` 的 `??`），`--max-goal-rounds` 才是操作的人設得動的那一條。只印其中
 * 一條的話，這一行就會變成上面那句自己警告過的謊話——只印目標那條會讓人以為有一個他控制
 * 得了的數字，只印命令列那條會讓人看不見模型可以在它底下自己挑一個更小的。沒給命令列那
 * 條時要**明著說沒給**，理由同上。
 *
 * @param on - 旗標開著沒有。
 * @param roundCap - `--max-goal-rounds` 那個數字；省略即這一次呼叫沒給。
 * @returns 那一行。
 */
export function formatGoalDriverDisclosure(on: boolean, roundCap?: number): string {
  if (!on) return '續行：關閉（一輪結束就結束，要人再推；--goal-driver 可以打開）';
  const own = `目標自己的 max_goal_rounds（模型在 create_goal 填的，沒填就是 ${DEFAULT_MAX_GOAL_ROUNDS}）`;
  return roundCap === undefined
    ? `續行：開啟（目標沒達成時自己再開一輪；上限只有一條——${own}；這一次呼叫沒有給 --max-goal-rounds）`
    : `續行：開啟（目標沒達成時自己再開一輪；上限兩條，先到的那一條管——--max-goal-rounds ${roundCap}，與${own}）`;
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
): BaseChatModel {
  // **`--live` 是進 live 的唯一閘門**，不看選擇列（理由見 `model-provider.ts`）；沒帶它才由清單上的
  // `agent-default-model` 在內建腳本與 patch 插進來的提供者之間選（#670）。
  if (!live)
    return resolveDefaultModel(plugins, () => new ScriptedChatModel({ turns: CLI_SCRIPT }));
  return createLiveModel(liveModel, undefined, credentials);
}

export type NexusAgent = NexusAgentHandle['agent'];

/** {@link createCliAgent} 的入口身分選項。**省略都是有意義的**：兩個入口各自只傳自己的那幾格。 */
export interface CreateCliAgentSession {
  /**
   * 不變量違規往哪裡講。[`serve.ts`](./serve.ts) 刻意不傳——伺服器那條路徑的違規進的是伺服器日誌，
   * 維持 runner 的預設（[#107](https://github.com/DemianLi/nexus-agent/issues/107)）。
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
  invocation: Pick<CliInvocation, 'live' | 'workspace' | 'sandbox' | 'recursionLimit'> & {
    /**
     * 記每一輪改了哪些檔（[#443](https://github.com/DemianLi/nexus-agent/issues/443)）。**只有 serve 開**：dsh 由
     * web-app bundle 掛，CLI 沒有人讀摘要。沒給 `--workspace` 時開了也不掛——那正是 dsh 的「不合格」。
     */
    readonly workspaceChanges?: boolean;
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
    readonly backgroundSubagents?: { readonly maxActive: number };
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
  /** 每一輪的改動摘要，serve 交給 wire-handler 的兩條路由。沒開或沒有工作區時是 `undefined`。 */
  workspaceChanges: WorkspaceChanges | undefined;
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
  /** 這一次組裝收不收插話（#710），見 `stepInbox` 那一格。 */
  stepInbox: boolean;
}> {
  const liveModel = invocation.liveModel ?? startupSetting(plugins, liveModelPlugin);
  const subagentToolFilter = startupSetting(plugins, backgroundSubagentsPlugin).toolFilter;
  const model = createCliModel(invocation.live, liveModel, invocation.credentials, plugins);
  // **標題模型是另一顆實例**：輸出上限換成標題那一列的，並表明用途，由 `createLiveModel` 決定要不要關推理
  // （`live-model.ts` 的 `LiveModelPurpose`）。`.env` 已經在入口（`runCli`／`runServe`）載入過了。
  const attachTitle =
    invocation.live && startupEntryMounted(plugins, threadTitleLlmPlugin)
      ? titleLlmFor(
          liveModel,
          invocation.threadTitleLlm ?? startupSetting(plugins, threadTitleLlmPlugin),
          invocation.threadTitle ?? startupSetting(plugins, threadTitlePlugin),
          invocation.credentials,
        )
      : undefined;
  // **channel 在這裡算一次，消費者共用。** 核准閘門由 `foldRegistry` 自己算
  // （同一個 `deriveApprovalChannel`），`ask_user_question` 與 `exit_plan_mode`（#652）拿的是這一份
  // ——分岔的樣子是「核准擋得下來、問答還掛在那裡」，而那不會有任何測試紅。
  //
  // **它掛在這裡而不是出貨清單裡**：那份清單是一個設定檔，看不到這一次
  // 呼叫的 checkpointer 與 `approvals`。
  // **綁在真的那個值上，不是寫死 `true`。** 今天這條路一律給 `MemorySaver`，但把它寫成
  // 字面量的那一刻，這個推導就不再跟著組裝走了——有人讓 checkpointer 變成有條件的那天，
  // 核准閘門會正確地回報 `no-channel`，而 `ask_user_question` 還宣稱有人在，然後撞上
  // `interrupt()` 的 `No checkpointer set`。那正是抽出這個推導要防的分岔。
  const checkpointer = new MemorySaver();
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
  // **模式是傳一個來源進去，不是一個字面值**：fence 逐次呼叫問一次，所以 `/sandbox` 換掉
  // 控制器那一格之後，下一次檔案變更就照新那格判（理由見 `SandboxModeSource`）。
  //
  // **控制器建在這裡而不是模組層**，這決定了它的壽命：`serve.ts` 一條 thread 呼叫一次
  // `createCliAgent`，所以一條 thread 一格。建在模組層或工廠閉包裡的話兩條 thread 會共用
  // 同一格——一條 thread 的 `/sandbox read-only` 收緊到另一條 thread 的檔案工具上，
  // 而那是靜默的（見 `sandbox-mode.ts` 的模組註解）。
  const workspaceRoot = resolveWorkspaceRoot(invocation.workspace, cwd);
  const sandboxMode = new SandboxModeController(invocation.sandbox ?? 'workspace-write');
  const backend =
    workspaceRoot === undefined
      ? undefined
      : // **grant 也從同一顆控制器認領**：升級工具把 grant 發在它身上（`sandbox-escalation.ts`），
        // fence 在被擋下時來這裡認領。給 fence 另一個 ledger 的話，核准了也認領不到。
        new ContainedFilesystemBackend({
          rootDir: workspaceRoot,
          mode: sandboxMode.source,
          grants: sandboxMode,
        });
  // **一條 thread 一份**：服務答的是這一次組裝的 root，所以條目建在這裡，同上面的控制器。
  const workspaceChanges =
    invocation.workspaceChanges === true && workspaceRoot !== undefined
      ? createWorkspaceChanges({ root: workspaceRoot })
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
    stepInbox,
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
        ...(workspaceRoot === undefined
          ? {}
          : { sandboxPolicy: { controller: sandboxMode, rootDir: workspaceRoot } }),
      }),
      ...plugins,
      // **有圍堵才講**。沒有 `--workspace` 的組裝一格圍堵都沒有，那時候講「目前的檔案
      // 政策是 workspace-write」是對模型說謊——它會以為根外被擋著，而整道 fence 不在
      // 路徑上。理由與 dsh 的 `ctx.fs.sandboxMode === undefined` 就不貢獻同一條。
      ...(workspaceRoot === undefined ? [] : [createSandboxPolicyPlugin()]),
      // **`@` 引用那一句跟圍堵同一個條件**（#651）：沒有工作區時不提供列檔，使用者插不出 `@` 路徑，檔案工具讀的也不是磁碟。
      ...(workspaceRoot === undefined ? [] : [createFileReferencePlugin()]),
      ...(workspaceChanges === undefined ? [] : [workspaceChanges]),
    ],
    ...(backend !== undefined && { backend }),
    ...(invocation.recursionLimit !== undefined && { recursionLimit: invocation.recursionLimit }),
    systemPrompt: SYSTEM_PROMPT,
    // **`--live` 時是 `live-model` 那一列的型號**，跟上面 `createCliModel` 讀的是同一份，兩邊不會漂移；
    // 假模型沒有型號，用 {@link SCRIPTED_MODEL_NAME}。
    systemPromptVariables: {
      model: invocation.live ? liveModel.modelId : SCRIPTED_MODEL_NAME,
      cwd: PROMPT_WORKING_DIRECTORY,
    },
    checkpointer,
    ...(onInvariantViolation !== undefined && { onInvariantViolation }),
    ...(invariantTap !== undefined && { invariantTap }),
    ...(approvals !== undefined && { approvals }),
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
          modelFor: (choice: ModelChoice) =>
            createLiveModel(
              { ...liveModel, modelId: choice.model },
              undefined,
              invocation.credentials,
              {
                ...(choice.effort === 'off' && { thinkingOff: true }),
              },
            ),
        }),
        ...(workspaceRoot !== undefined && { sandbox: sandboxMode }),
      },
    }),
    ...(invocation.toolResultStash !== undefined && {
      toolResultStash: invocation.toolResultStash,
    }),
    ...(invocation.spillPolicy !== undefined && { spillPolicy: invocation.spillPolicy }),
  });
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
    goals: services.get(GOALS_SERVICE),
    workspaceRoot,
    attachTitle,
    dropped,
    warnings,
    stepInbox,
  };
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
): AttachSessionTitleLlm {
  const modelId = config.modelId ?? liveModel.modelId;
  if (findModelEntry(liveModel.models, modelId) === undefined) {
    const known = liveModel.models.map((entry) => entry.id).join('、');
    throw new Error(
      `thread-title-llm（#settings/thread-title-llm）的 modelId "${modelId}" 不在 live-model 的 models 型錄裡（型錄有：${known}）`,
    );
  }
  return createSessionTitleLlm({
    model: createLiveModel({ ...liveModel, modelId }, 'session-title', credentials, {
      maxOutputTokens: config.maxOutputTokens,
    }),
    route: { provider: liveModel.baseUrl, model: modelId },
    config,
    limits,
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
 * @returns 排程器要問域的四件事。
 */
export function goalDriverPort(
  goals: GoalServices | undefined,
  log: () => SessionLog,
  flush: () => Promise<void>,
  warn: (message: string) => void,
): GoalDriverPort {
  return {
    // **查不到就是 `undefined`**：patch 把 goal 那一列關掉時這條路就沒有 goal 域，
    // 那時排程器安靜地什麼都不做。
    goal: () => goals?.serviceFor(log())?.get(),
    block: (ref, reason) => void goals?.serviceFor(log())?.block(ref, reason),
    disarm: () => void goals?.serviceFor(log())?.disarm(),
    flush,
    warn: (message) => warn(`[續行] ${message}`),
  };
}
