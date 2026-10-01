/**
 * agent 工廠——**plugin 清單組出來的 agent 只有這一個組裝點**。
 *
 * 整個 repo 只有一處例外：[`baseline.test.ts`](./baseline.test.ts) 直接呼叫
 * `createDeepAgent`，而那是刻意的——它斷言的是「基座還是不是我們以為的那個形狀」，
 * 中間隔著我們自己的 fold 就驗不到那件事了。
 *
 * 三步：`loadPlugins()` 把清單跑進 registry、`foldRegistry()` 折成參數、
 * `createDeepAgent()` 收下。前兩步住在 `@nexus/core`（純轉換層，不碰基座的建構），
 * 第三步只有這裡有。換模型、換儲存、換工具組合＝換 plugin 清單，core 不動。
 *
 * 「組裝點自有、plugin 不得提供」的那些（default backend、工具呈現順序、model、
 * checkpointer / store、核准政策的 session 開關、摘要的門檻與去向、重複呼叫提醒的門檻與
 * 射程，加一份基座工具名單）
 * 從 {@link CreateNexusAgentOptions} 進來，原樣交給 fold：**所有權在這裡，檢查跑在 core**。
 *
 * 這也是 fold 的產物第一次真的碰到基座。基座在建構時還有三道自己的檢查是 fold 看不到的，
 * 外加**一件不是檢查而是改寫**的事（第 4 條）：
 *
 * 1. **工具名撞到內建**——`createDeepAgent()` 開頭丟 `ConfigurationError('TOOL_NAME_COLLISION')`。
 *    我們在 fold 之前先擋一次，理由見 {@link assertNoBaseToolNameCollision}。
 * 2. **`permissions` 的路徑格式**——只要規則非空，`createFilesystemMiddleware()` 就跑
 *    `validatePermissionPaths()`：非絕對路徑、含 `..`、含 `~` 一律拋錯。`registry.permissions.deny()`
 *    明文不驗第二次，所以這條的失敗只會在這裡出現。
 * 3. **`permissions` 配上支援命令執行的 backend**——同一個地方拋，因為 shell 指令碰得到任何路徑，
 *    路徑規則會失效。**它丟的是普通的 `Error`，不是 `ConfigurationError`**（PR #53 的內文寫成
 *    後者，是錯的；1.13.1 的 `ConfigurationError` 只有 `TOOL_NAME_COLLISION` 一個 code）。
 *    現在觸發不到——`StateBackend` 的 `isSandboxBackend` 是 false——所以這裡不寫測試，
 *    留給 Phase 2 的 `feat/sandbox-plugin` 當場驗。
 * 4. **按模型改寫組裝**——`createDeepAgent()` 從 `model` 解出一份 harness profile，然後才
 *    開始組 middleware。它拿得掉工具、改得動我們自己註冊的工具的 description、加得了
 *    middleware（連同它帶的工具）、換得掉系統提示詞。**前三條是檢查，這一條是改寫**：
 *    它不會拒絕任何東西，只會安靜地讓組出來的 agent 不是我們宣告的那個。所以這裡在
 *    fold 之前先要求宣告，見 {@link CreateNexusAgentOptions.expectedHarnessProfile} 與
 *    [`harness-profile.ts`](./harness-profile.ts)。
 *
 * 組裝點還負責一件基座**設了但等於沒設**的事：agent 迴圈的上限。值由
 * {@link recursionLimitFor} 的三態決定（明著傳的 > `#settings/recursion-limit` 那一列提供的
 * 服務 > {@link DEFAULT_RECURSION_LIMIT}），常數與它的校準住在
 * [`settings/recursion-limit.ts`](./settings/recursion-limit.ts)。
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  assertInvariantSelection,
  createHostServicesPlugin,
  createInvariantRunner,
  createSessionRunner,
  compileSubagentGraph,
  foldRegistry,
  formatOrigin,
  isFeedbackEvent,
  loadPlugins,
  MESSAGE_FEEDBACK_SERVICE,
  resolveEntriesPerEntry,
  SESSION_TELEMETRY_SERVICE,
  SessionTelemetryCoordinator,
  type AgentCheckpointer,
  type AgentModel,
  type AgentStore,
  type ApprovalPolicy,
  type InvariantError,
  type InvariantSelection,
  type DroppedEntry,
  type PluginEntry,
  type PluginOrigin,
  type PluginRegistry,
  type SessionLog,
  type SessionRegistry,
  type SessionTelemetrySharingStatus,
  type RepeatReminderSettings,
  type SummarizationSettings,
  type ToolResultPruneConfig,
} from '@nexus/core';
import type { SystemPromptVariables } from '@nexus/plugin-system-prompt';
import { CompositeBackend, createDeepAgent } from 'deepagents';
import type { AnyBackendProtocol } from 'deepagents';
import { BackgroundDelegation } from './background-delegation.js';
import type { BackgroundSubagentsOptions } from './background-delegation.js';
import type {
  BackgroundAgent,
  BackgroundParentPort,
  SessionDetach,
} from './background-subagents.js';
import { BASE_TOOL_NAMES, RESERVED_BASE_TOOL_NAMES } from './base-tools.js';
import { TextOnlyStateBackend } from './binary-read.js';
import { createToolResultStash } from './tool-result-stash.js';
import type { StashRoute } from './tool-result-stash.js';
import type { ToolResultStashOptions } from './tool-result-stash.js';
import { assertHarnessProfileDeclared, describeHarnessProfileEffects } from './harness-profile.js';
import type { HarnessProfileEffects } from './harness-profile.js';
import { DEFAULT_RECURSION_LIMIT, RECURSION_LIMIT_SERVICE } from './settings/recursion-limit.js';

/** 組裝時掉了的一列（#751）：載入器交出來的原因，加上它是清單上哪一個條目。 */
export interface AssemblyDrop {
  /** 放進 {@link CreateNexusAgentOptions.plugins} 的那一顆條目物件。 */
  readonly entry: PluginEntry;
  readonly drop: DroppedEntry;
}

/**
 * 組裝時有不能少掛的條目掉了：整個組裝失敗（#751）。**拋出之前已經收掉**這次組裝開的資源。
 *
 * 帶著這一次掉了的全部（可少掛的也在），呼叫端要跟讀清單那一次的一起列時從這裡讀。
 */
export class AssemblyDropError extends Error {
  readonly dropped: readonly AssemblyDrop[];
  /** 不能少掛、卻掉了的那幾個條目。 */
  readonly fatal: ReadonlySet<PluginEntry>;

  constructor(dropped: readonly AssemblyDrop[], fatal: ReadonlySet<PluginEntry>) {
    const lines = dropped.map(
      ({ entry, drop }) => `  ${drop.message}${fatal.has(entry) ? '〔不能少掛〕' : ''}`,
    );
    super(
      `組裝失敗：${String(fatal.size)} 個不能少掛的條目沒有掛上。這一次掉了的全部：\n${lines.join('\n')}`,
    );
    this.name = 'AssemblyDropError';
    this.dropped = dropped;
    this.fatal = fatal;
  }
}

export interface CreateNexusAgentOptions {
  /** plugin 清單。順序有意義：middleware 的順序、以及 `except` 的射程都跟著它。 */
  readonly plugins: readonly PluginEntry[];
  /**
   * 過大的工具結果暫存到主機上的哪個私有目錄（[#734](https://github.com/DemianLi/nexus-agent/issues/734)）。
   * 給了，基座的 `/large_tool_results/` 前綴就路由到那個根底下按會話分的目錄，續接之後讀得回；寫不進去退回記憶體。
   * **省略就是今天的記憶體暫存**：eval、spike 與沒有會話日誌的組裝沒有「續接時回到同一個會話」的身分，落盤只會留下
   * 沒人清的檔。細節與偏離見 `tool-result-stash.ts` 的檔頭。
   */
  readonly toolResultStash?: ToolResultStashOptions;
  /**
   * 工具結果外溢層（[#719](https://github.com/DemianLi/nexus-agent/issues/719)）：一則結果超過 `maxInlineTokens`，
   * 全文存進 {@link toolResultStash} 的主機目錄，模型只收到頭尾預覽加路徑。**省略就不掛**；**沒有
   * {@link toolResultStash}（沒有會話鑰匙、沒有存處）也不掛**，那時超過 80,000 字元的結果仍由基座換成預覽——
   * dsh 的規則是找不到可還原的存處就保留原結果。細節與偏離見 `@nexus/core` 的 `spill-policy.ts`。
   */
  readonly spillPolicy?: { readonly maxInlineTokens: number };
  /**
   * **哪幾個條目可以少掛**（[#751](https://github.com/DemianLi/nexus-agent/issues/751)），以條目物件比對
   * （放進 {@link plugins} 的那一顆）。
   *
   * 給了就用載入器的逐列掉模式，照 dsh：這幾個條目自己的失敗——`apply` 拋錯、`requires` 缺件、撞到基座保留的
   * 工具名——只讓它掉，組出來的 agent 照樣有其餘的，掉了哪幾個從回傳的 `dropped` 讀。**不在這份裡的條目掉了，
   * 整個組裝失敗**（{@link AssemblyDropError}）：產品路徑上那是組裝點自己加的外掛與必掛的列。組裝點的外掛不能
   * 少掛，因為有些使用方查不到它們給的服務就自己退回預設值照樣跑（例如 `ask-user` 查不到對話管道）。
   *
   * 省略即全有全無，手搭清單的呼叫端照舊。
   */
  readonly optionalEntries?: ReadonlySet<PluginEntry>;
  /**
   * 模型。**刻意是必填**——基座省略時會退到它自己的預設（`anthropic:claude-sonnet-4-6`），
   * 那會讓「忘了指定」與「就是要 Anthropic」看起來一模一樣，而前者的代價是打一支
   * 沒人預期的付費 API。預設供應商的決策（Anthropic）不受影響：那是清單怎麼寫的事，
   * 不是這裡該替人填的預設值。
   */
  readonly model: AgentModel;
  /**
   * 系統提示詞前後綴的 `{{model}}` 與 `{{cwd}}`（[#720](https://github.com/DemianLi/nexus-agent/issues/720)）。
   *
   * 出貨清單的 `system-prompt` 那一列硬要這個服務，而**這裡是唯一的提供者**：手搭的呼叫端不必為了一個它們不關心的
   * 服務各交一份，也就不會有兩個提供者撞在一起。省略時 `model` 取模型物件自己報的型號（`model`／`modelName`，
   * 都沒有就用 `_llmType()`——每個 `BaseChatModel` 都有），`cwd` 是 `/`：檔案工具的位址空間裡的根，不是主機路徑
   * （偏離登記見 `@nexus/plugin-system-prompt` 的檔頭）。`--live` 的兩個入口明著傳 `live-model` 那一列的 `modelId`，
   * 跟建模型讀的是同一份。
   */
  readonly systemPromptVariables?: Partial<SystemPromptVariables>;
  /**
   * 宣告「這個模型會讓基座對組裝做哪些事」。**省略即宣告「什麼都不做」**——那是今天所有
   * 呼叫端的實情，也是唯一一種不必寫的宣告。
   *
   * 基座解出來的 profile 與這份宣告不一致，組裝當場失敗（兩個方向都擋：沒宣告卻有東西、
   * 宣告了卻沒有那些東西）。**這不是把某些模型封死**——確認過改動可以接受，就照錯誤訊息
   * 把實際那份貼進來。理由、形狀與 dsh 那側的對照見
   * [`harness-profile.ts`](./harness-profile.ts) 的檔頭。
   */
  readonly expectedHarnessProfile?: HarnessProfileEffects;
  /**
   * default backend。plugin 掛的是路由分支（`backend.mount()`），兜底的這個是組裝點的事。
   * 省略即 `StateBackend`（跑在 state 裡的虛擬 FS，不碰真實磁碟）。**含路徑圍堵的
   * default backend 是 Phase 2 `feat/fs-backends` 的事**，現在這個不設防。
   */
  readonly backend?: AnyBackendProtocol;
  /** 工具呈現順序。省略即字典序（省略不代表隨便排，代表另一種確定的排法）。 */
  readonly toolOrder?: readonly string[];
  /**
   * 基座工具的名字宇宙。省略即 {@link BASE_TOOL_NAMES}。
   * 會想覆寫它的只有測試，以及哪天真的開了 async subagent 的組裝。
   */
  readonly baseToolNames?: readonly string[];
  /**
   * 「先讀後改」策略的開關。省略即開著（照 dsh，那邊是預設載入的插件）——**除非**清單上
   * `@nexus/core/observation-policy` 那一列標了 `disabled: true`，三態見 `@nexus/core` 的
   * `FoldOptions.observationPolicy`（[#456](https://github.com/DemianLi/nexus-agent/issues/456)）。
   *
   * `false` 是明著接受盲改——一個只寫新檔、從不編輯既有檔的批次流程用得到它。
   * 形狀與理由見 `@nexus/core` 的 `observation.ts`。
   */
  readonly observationPolicy?: boolean;
  /**
   * 每一次模型呼叫的 token 帳目要不要記進會話日誌。省略即開著——**除非**清單上
   * `@nexus/core/model-usage` 那一列標了 `disabled: true`，三態見 `@nexus/core` 的
   * `FoldOptions.modelUsage`（#456）。
   *
   * `false` 之後落盤日誌裡不會有 `model/usage`。**評估那條路的數字不受影響**——
   * `eval/runner.ts` 是自己從 `usage_metadata` 加的，而且它不接 `attachSession`。
   * 形狀與理由見 `@nexus/core` 的 `model-usage.ts`。
   */
  readonly modelUsage?: boolean;
  /**
   * 掛不掛插話的載體（[#710](https://github.com/DemianLi/nexus-agent/issues/710)）。省略即不掛。**只有 serve 開**：
   * 插話由 web 的 pump 經 `configurable` 送進圖裡，CLI 一行一輪沒有插話。開了之後每一步多一個 super-step，
   * 換算見 `settings/recursion-limit.ts`。形狀見 `@nexus/core` 的 `step-inbox.ts`。
   *
   * 開沒開從回傳的 `stepInbox` 讀：pump 據它決定插話放 `next-step` 還是退成排隊——沒掛的組裝放進 `next-step`
   * 的話，永遠沒有人領。
   */
  readonly stepInbox?: boolean;
  /**
   * 背景派出的委派工具 `subagent`（[#831](https://github.com/DemianLi/nexus-agent/issues/831)，地圖
   * [#737](https://github.com/DemianLi/nexus-agent/issues/737)）。**省略就完全不變**：沒有這顆 middleware，
   * 模型看到的還是基座的 `task`。給了：`task` 從模型視野拿掉、換成 `subagent`（`run_in_background` 預設 true），
   * 背景那一輪由 `attachSession` 建的 host 拉起。**需要 {@link checkpointer}**（沒有存檔點就沒有第二輪）。
   * 偏離登記與細節見 `background-delegation.ts`。
   */
  readonly backgroundSubagents?: BackgroundSubagentsOptions;
  /** checkpointer。有 plugin 宣告要核准的工具卻沒給，fold 會報錯。 */
  readonly checkpointer?: AgentCheckpointer;
  /** 長期記憶用的 store。 */
  readonly store?: AgentStore;
  /** 核准政策的 session 開關。省略即「這個 session 有人在」。 */
  readonly approvals?: ApprovalPolicy;
  /**
   * 摘要的門檻與去向。給物件就逐格淺合併到 `DEFAULT_SUMMARIZATION` 上，`false` 是真的
   * 關掉：沒有摘要、沒有歷史 offload，也沒有工具結果剪刀（#446）。**省略時由清單上
   * `@nexus/core/summarization` 那一列決定**，手搭清單（沒有那一列）才是內建預設；四態見
   * `@nexus/core` 的 `FoldOptions.summarization`（#456）。
   *
   * **這一格存在是因為基座沒有這個參數。** `createSummarizationMiddleware({ backend })`
   * 被無條件寫死進 root 與每個 subagent 的 stack，`CreateDeepAgentParams` 上一個
   * summarization 欄位都沒有；門檻由基座在執行期從模型 profile 二選一挑，而我們的模型
   * 解不出 profile，於是拿到一組與模型無關的常數，**沒有任何一側在檢查它跟真實窗口的
   * 關係**。唯一的縫是同名取代，fold 走的就是那條。
   *
   * `fraction` 型別的門檻在型別層與執行期都被擋掉——它需要 `profile.maxInputTokens`，
   * 缺值時 `trigger` 一輩子不觸發、`keep` 一則逐字訊息都不留，兩個方向都不警告。
   * 實測與決議見 [#142](https://github.com/DemianLi/nexus-agent/issues/142)，形狀與
   * 數值的理由見 [`summarization.ts`](../../../packages/nexus-core/src/summarization.ts)。
   */
  readonly summarization?: Partial<SummarizationSettings> | false;
  /**
   * 摘要器外面那把工具結果剪刀的預算。給物件就逐格淺合併到 `DEFAULT_TOOL_RESULT_PRUNE`
   * （dsh 的 8192／4096／1024）上，`false` 是摘要照跑、只是不先剪。**省略時由清單上
   * `@nexus/core/tool-result-pruner` 那一列決定**，手搭清單（沒有那一列）才是內建預設；
   * 四態見 `@nexus/core` 的 `FoldOptions.toolResultPruning`（#456）。CLI 與 serve 走的就是
   * 那一列——部署在 patch 裡改它。
   *
   * 照 dsh 只在摘要開著時有作用；給了物件照樣在組裝時驗。形狀見 `@nexus/core` 的
   * `tool-result-pruner.ts`。
   */
  readonly toolResultPruning?: Partial<ToolResultPruneConfig> | false;
  /**
   * 重複工具呼叫的提醒門檻與射程。給物件就逐格淺合併到 `DEFAULT_REPEAT_REMINDER`
   * （門檻 3／5／8）上，`false` 是明著不要。**省略時由清單上 `@nexus/core/repeat-reminder`
   * 那一列決定**，手搭清單（沒有那一列）才是內建預設；四態見 `@nexus/core` 的
   * `FoldOptions.repeatReminder`（#456）。
   *
   * **這一格存在是因為基座沒有這種 middleware。** 模型以同參數重複呼叫同一個工具時，
   * 今天唯一會讓它停下來的是 {@link DEFAULT_RECURSION_LIMIT}，而那個上限不分辨「在
   * 進展」與「在打轉」——它只會在跑了夠久之後把整輪掐掉。提醒器是**建議不是阻止**：
   * 合理的重複一秒都不會被延遲。形狀與門檻照 dsh 的 `repeat-tool-reminder`，
   * 偏離登記見 [`repeat-reminder.ts`](../../../packages/nexus-core/src/repeat-reminder.ts)。
   *
   * **開著會吃掉迴圈預算**：它掛在 `beforeModel` 上，那在圖裡是一個節點，每一輪多一個
   * super-step，於是 `recursionLimit` 的換算從 `2 × 輪數 + 2` 變成 `3 × 輪數 + 2`（{@link stepInbox}
   * 再多一格）。見 {@link DEFAULT_RECURSION_LIMIT}。
   */
  readonly repeatReminder?: Partial<RepeatReminderSettings> | false;
  /** 附加在基座 base prompt 前面的 system prompt。 */
  readonly systemPrompt?: string;
  /**
   * agent 迴圈的上限，單位是 LangGraph 的 super-step。
   *
   * **省略不等於內建預設**（[#529](https://github.com/DemianLi/nexus-agent/issues/529)）：省略之後
   * 由 {@link recursionLimitFor} 的三態決定——{@link plugins} 裡有 `#settings/recursion-limit`
   * 那一列就用它提供的值，連那一列都沒有才是 {@link DEFAULT_RECURSION_LIMIT}。**這一格在場時
   * 永遠贏**。
   *
   * **一定要設，因為基座的預設等於沒有上限**——見 {@link DEFAULT_RECURSION_LIMIT}。
   * 換算是 `recursionLimit = 2 × 模型輪數 + 2`（模型一輪、工具一輪各算一個 super-step）。
   */
  readonly recursionLimit?: number;
  /**
   * 哪些 package 的不變量檢查要真的裝上去。省略即全裝。
   *
   * **這是次要的那個開關。** 條目層的 {@link PluginEntry.disabled} 才是主要答案：一個配套
   * 入口 plugin 對一個 package 名，關掉那個條目就等於關掉那個 package 的檢查，而且
   * 錯誤訊息裡指得出是誰。這裡收的 selection 補的是條目層表達不了的兩件事——`enabled:
   * false` 這個總開關，以及跨多個 package 的 regex 樣式。
   *
   * **原樣轉給 `createInvariantRunner`，這裡不加任何語意**：驗證與過濾規則只有
   * {@link InvariantSelection} 那一份。
   */
  readonly invariants?: InvariantSelection;
  /**
   * 違規往哪裡講。省略即 `createInvariantRunner` 的預設，也就是 `console.error`。
   *
   * **這道縫存在的理由不是「換一個 fd」**——預設的 `console.error` 本來就是 stderr。它買到
   * 的是三件事，缺一件違規就會變成一個沒有人管得到的輸出：呼叫端**指得出格式**（CLI 有
   * 自己的 `Printer`，違規不繞過它）、**測得到**（在這道縫之前，唯一驗違規的辦法是去攔
   * `console.error`），以及**歸得了因**（違規跟 agent 的輸出落在同一個終端機上，沒有前綴
   * 就分不出誰是誰）。
   *
   * 定案見 [#107](https://github.com/DemianLi/nexus-agent/issues/107)。**`serve.ts` 那條
   * 路徑刻意不傳**，維持預設：那裡的 `console.error` 進的是伺服器日誌，撞不到任何人的
   * 終端機。兩條進入點答案不同是選的，不是漏的。
   */
  readonly onInvariantViolation?: (error: InvariantError) => void;
}

/**
 * 沒有人在的那些入口用的核准政策。
 *
 * **這是入口層的一個事實，不是一個偏好。** 一個收不了核准決定的入口把 `enabled` 留在
 * 預設的 `true`，等於保證每次碰到核准點都停在那裡等一個不會來的答案 —— CLI 是整輪
 * 作廢，eval 是一條基準任務作廢。關掉之後 agent 照樣跑得完：不需要核准的照跑，需要
 * 核准的回一則說明是「沒有人被問到」的拒絕（[#113](https://github.com/DemianLi/nexus-agent/issues/113)
 * 拍板 (a)：不加旗標，因為旗標是為了讓人選，而這裡沒有第二個值得選的行為）。
 *
 * 對到 dsh 的 `ApprovalPolicy: 'never'`，它的文件寫的正是這個用途 ——
 * "The strict headless stance (CI, unattended runs)"（`docs/subsystems/approval.md:43`）。
 *
 * **與 dsh 的偏離，只有這一句**：dsh 還分得出第三種 —— policy 留在 `'ask'` 但一個
 * answerer 都沒 compose，結果是 `'unavailable'` 而不是 `'rejected'`。我們的
 * `ApprovalChannel` 是從 checkpointer 在不在推出 `no-channel` 的，不是從一份 answerer
 * 名冊，所以「有 resume 管道但沒有介面」在我們這裡沒有表示法，退到 `never`。
 *
 * **不是每個入口都該用它。** `serve.ts` 那條刻意維持預設的 `true`：瀏覽器那端真的按得
 * 下去，關掉它會把一個做得出來的功能關掉。三個入口三個答案，這是選的不是漏的。
 */
export const HEADLESS_APPROVALS: ApprovalPolicy = { enabled: false };

/**
 * 組裝好的 agent，加上收掉它的方法。
 *
 * **刻意是推導出來的別名，不是自己打一份 interface**：`createDeepAgent` 的回傳型別帶著
 * 一整串由參數推導的型別參數，寫成 `ReturnType<typeof createDeepAgent>` 會退回預設值，
 * 呼叫端的 `result.messages` 當場變成 `any`。
 *
 * `dispose` 收的是清單裡的 plugin 經 `registry.lifecycle.onDispose()` 登記的活資源
 * （MCP 的 stdio 子行程是第一個），逆序、冪等，**外加還接著的遙測協調器**。
 * **不收 agent 本身**——deepagents 建構後不可變，也沒有東西要關。不呼叫的下場是行程
 * 不退出：子行程的 stdio pipe 是活的 handle。
 *
 * `attachTelemetry` 是遙測的接線口。它在這裡而不在 `@nexus/core`，因為接線需要同時
 * 拿到 registry（誰掛了後端、誰掛了脫敏規則）與一份 {@link SessionLog}，而**只有組裝點
 * 同時看得到這兩個**——core 那側不知道日誌是誰建的，兩條進入點那側不知道 registry。
 *
 * `attachInvariants` 同一個理由，接的是不變量配套入口。兩者**不合併**：遙測是把事件
 * 送出去，不變量是檢查事件之間的關係，一個有出境資料一個沒有，開關與失敗語意都不一樣。
 *
 * `attachSession` 是第三個，接的是 `sessions` 通道的參與者。它與另外兩個的差別是**方向**：
 * 那兩個只讀，這一個交出去的日誌**寫得動**——`goal/change` 這種權威 domain 事件就是從
 * 這裡進日誌的。理由與否掉沿用 `invariants` 的兩條見
 * {@link @nexus/core!SessionSubject}。
 */
export type NexusAgentHandle = Awaited<ReturnType<typeof createNexusAgent>>;

/**
 * 依一份 plugin 清單建一個 agent。
 *
 * **組裝失敗時這裡自己收拾**：`loadPlugins` 過了才發現 fold 的前置條件不成立、或基座
 * 擋下這份組裝時，已經開好的資源沒有第二個人知道——呼叫端拿到的是一個 exception，
 * 不是 handle。所以先 `dispose()` 再把原本的錯誤往外拋。
 *
 * @param options - 清單，加上組裝點自有的那些。
 * @returns 建好的 agent 與收掉它的方法。
 * @throws 模型解出來的 harness profile 與宣告不符、清單載入失敗（重名、`requires` 缺件、
 *   `apply` 拋錯）、`invariants` 的 pattern 不合法、fold 的前置條件不成立，或基座自己在
 *   建構時擋下這份組裝——五種都在載入期發生，不會拖到跑起來才炸。
 */
/**
 * 基座把過大的工具結果搬去的那個路徑前綴。**抄自基座，不是我們選的。**
 *
 * `createFilesystemMiddleware` 的 `wrapToolCall` 在文字超過
 * `4 * toolTokenLimitBeforeEvict`（預設 `2e4` → 80,000 字元）時寫
 * `/large_tool_results/<sanitized tool_call_id>.txt`，然後把訊息換成頭尾預覽加一句
 * 「用 `read_file` 自己去讀」（`deepagents@1.13.1`，`dist/langsmith-zm0ILQsV.js:2416`
 * 的 `processToolMessage`）。那個路徑是**寫死在基座裡的**，這裡只是把同一個字串說出來。
 *
 * **匯出是刻意的**：`tool-result-stash.test.ts` 那條絆索拿它跟基座實際指路的路徑對，
 * 基座改了字串就當場紅。把它藏起來、測試裡再抄一次字面值，那條絆索就會兩邊一起錯。
 */
export const TOOL_RESULT_STASH_PREFIX = '/large_tool_results';

/**
 * 把工具結果暫存那一格路由到獨立的去處，不讓它落在 agent 的工作區上。
 *
 * ## 它修的是一個會丟資料的缺陷（[#170](https://github.com/DemianLi/nexus-agent/issues/170)）
 *
 * 基座那次 `backend.write()` **失敗時不會保留原文**——它把訊息換成
 * `Tool result too large, but the result could not be saved to the filesystem: <error>`
 * （`:2437`），於是模型剛要到手的東西整個沒了，只剩一句「存不進去」。
 *
 * **而那不是稀有路徑。** `ContainedFilesystemBackend` 的 `read-only` mode 對**每一次**
 * write 回 `{ error }`，所以那個組裝底下**每一則**超過 80,000 字元的工具結果都會這樣：
 * 實測 80,014 個字元換成 166 個，模型接著 `read_file` 拿到 `ENOENT`。
 *
 * dsh 明文保證相反：`dsh-spill-policy` 的三個不變式之一是「spill 失敗保留原始內聯結果，
 * 絕不把成功的呼叫變成錯誤」（`packages/spill/spill-policy/README.zh.md`，SHA `4e84901`）。
 *
 * ## 為什麼修在 backend 這一層，而不是包一層 middleware
 *
 * **因為原文在基座那一層裡面。** 我們自己的 `wrapToolCall` 包在外面時，拿到的已經是
 * 基座換過的訊息；要握住原文得再有一層跑在裡面，兩層之間對 `tool_call_id`，而且
 * 「認出基座失敗了」只能去比對那句英文——基座沒有給碼。路由讓那次 write **不會失敗**，
 * 於是這些都不必發生。
 *
 * ## 為什麼是無條件的，不是「唯讀時才路由」
 *
 * `fold.ts` 已經畫過這條線：**歷史是基礎建設，不是 agent 的工作區**（摘要器因此拿的是
 * default backend，不是折出來的那個）。工具結果暫存落在同一側 —— 它是 harness 的暫存，
 * 不是模型在做的事。所以它不該取決於工作區的寫入政策：
 *
 * - **`read-only`**：那次 write 不再被 fence 擋掉，缺陷消失。
 * - **`workspace-write`**：暫存不再落在使用者的專案目錄裡。今天它會留下永遠沒人清的
 *   `<root>/large_tool_results/*.txt`；dsh 的 spill 同樣**不寫工作區**，它有自己的私有根。
 * - 而且它不必知道那次 write **為什麼**會失敗——`ENOSPC`、`EACCES`、掛載唯讀，一起蓋掉。
 *
 * ## 去向：主機上的私有目錄（[#734](https://github.com/DemianLi/nexus-agent/issues/734)），退路是記憶體
 *
 * 給了 `stash`（產品路徑上兩個入口都給）：路由到主機上按會話分的私有目錄，目錄 0700、檔案 0600，所以 CLI
 * `--resume` 或 serve 重開之後，預覽指著的路徑還讀得到同一個檔（`conversation-restore.ts` 照同一條規則重算路徑）。
 * 這一改**推翻了原本「放記憶體」的理由**——「唯讀模式不該碰磁碟、state 不需要清理政策」是偏好，不是基座做不到：
 * 唯讀指的是使用者的**工作區**，這個私有目錄不在工作區裡（dsh 的 spill 同樣如此）；清理政策改由啟動時的保留期
 * 清理承擔（`tool-result-stash.ts` 的 `cleanupToolResultStash`）。
 * **寫不進主機目錄就退回記憶體**（今天的 {@link TextOnlyStateBackend}），所以 #170 的「存不下就丟原文」不會復發。
 *
 * 沒給 `stash`（eval、spike、沒有會話日誌的組裝）維持記憶體：它是 graph state 的一部分，會進 checkpoint，
 * 跑完也不留在磁碟上供事後翻查。偏離 dsh 的三點（固定根、檔名由工具呼叫編號推出、會話鑰匙由呼叫端給）
 * 登記在 `tool-result-stash.ts` 的檔頭。
 *
 * @param backend - 組裝點的 default backend。
 * @param stash - 主機暫存的根與會話鑰匙；省略就是記憶體。
 * @returns 同一個 backend，外面包一層只有這一條路由的 `CompositeBackend`。
 */
function withToolResultStash(backend: AnyBackendProtocol, stash?: StashRoute): AnyBackendProtocol {
  // **路由鍵要有結尾斜線**（[#354](https://github.com/DemianLi/nexus-agent/issues/354)），理由同
  // {@link withConversationHistory}。少了它，照確切路徑 `read_file` 仍讀得到，但在這個目錄底下
  // `ls` 列出 `/large_tool_result// (directory)`、`grep` 回 No matches（實測）。代價同歷史那一格：
  // 預設組裝裡 state 的 `files` 是共用的，模型在根目錄看得到 `/call_<id>.txt`——斜線之前也看得到，
  // 只是形狀是 `//call_<id>.txt`（`tool-result-stash.test.ts` 的 state 那條記著）。
  // 給了 `stash` 之後，暫存不再放在對話狀態裡，那一格只剩退回記憶體時才會出現。
  return new CompositeBackend(backend, {
    [`${TOOL_RESULT_STASH_PREFIX}/`]: stash === undefined ? new TextOnlyStateBackend() : stash,
  });
}

/**
 * 會話歷史落在 backend 的哪個前綴。**抄自基座，不是我們選的。**
 *
 * 兩個寫入者都用它：摘要器 offload 的預設前綴（`@nexus/core` 的 `DEFAULT_SUMMARIZATION` 的
 * `historyPathPrefix` 同值明寫），與 `createFilesystemMiddleware` 的 `beforeAgent` 把超大 human
 * message 搬走時**寫死**的 `/conversation_history/<uuid>`（`deepagents@1.13.1`，
 * `dist/langsmith-zm0ILQsV.js:2468`，不吃 `historyPathPrefix`）。
 *
 * **匯出是刻意的**，理由同 {@link TOOL_RESULT_STASH_PREFIX}：測試拿它跟摘要器的預設前綴對。
 */
export const CONVERSATION_HISTORY_PREFIX = '/conversation_history';

/**
 * 把會話歷史那一格路由到獨立的 {@link TextOnlyStateBackend}，不讓它落在 agent 的工作區上
 * （[#348](https://github.com/DemianLi/nexus-agent/issues/348)）。
 *
 * ## 缺的是什麼
 *
 * `fold.ts` 畫的線是「歷史是基礎建設，不是 agent 的工作區」，摘要器因此拿 default backend
 * 而不是折出來的那個。**但 default backend 就是工作區**：CLI 給了 `--workspace`，
 * default backend 就是那個 `ContainedFilesystemBackend`，於是
 * `<workspace>/conversation_history/*.md` 一直都在使用者的目錄裡。那條線只擋住了 plugin 的
 * 路由，沒擋住工作區本身。#335 的量測在 8 次呼叫裡量到 6 份；放到 Proteus 底下，快照會把
 * 它們量成「演化」。
 *
 * ## 為什麼路由而不是換 `historyPathPrefix`
 *
 * **第二個寫入者不吃那個前綴。** eviction 的路徑寫死在基座裡，換前綴只搬得走摘要器那一半。
 * 路由按路徑前綴接住兩個。
 *
 * **只路由基座那個常數，不路由呼叫端自訂的前綴。** 明著設了 `historyPathPrefix` 等於明著選了
 * 去向，那一條照舊寫進 default backend（`conversation-history-route.test.ts` 釘著）。
 *
 * ## 去向：graph state，與 {@link withToolResultStash} 同一個理由
 *
 * dsh 不把被壓掉的原文寫進任何檔案系統：原文留在會話日誌，模型只看到一則
 * `<compacted-summary>`（`packages/compaction/compaction-basic/README.zh.md`，SHA `0d1f500`）。
 * 我們的日誌從 [#305](https://github.com/DemianLi/nexus-agent/issues/305) 起也記著對話
 * （`assistant/message`、`tool/result`），所以耐久的那一份已經在日誌裡；backend 上這一份只是
 * **這個行程內**讓模型照摘要那句話去 `read_file` 的便利。放 state 不必碰磁碟（`read-only` 也
 * 留得住，以前那次寫入被 fence 擋掉、歷史直接消失），也不必有清理政策。
 *
 * **偏離登記**：基座把歷史寫成檔、還在摘要裡告訴模型路徑，dsh 沒有這條路；這條路基座無條件
 * 建、關不掉（`contained-backend.ts` 的 `read-only` 那段），所以退到「照舊寫，但寫到工作區外」。
 *
 * **代價講明白**，都跟暫存那一格同形：
 *
 * - 它進 checkpoint，跑完就不在磁碟上，**續接（`--resume`、serve 重開）帶不回來**。灌回去的
 *   摘要仍寫著「完整歷史存在某某路徑」，那時讀不到——跟暫存預覽裡的路徑一樣，另外披露。
 * - `CompositeBackend` 把路由前綴剝掉再交給 `StateBackend`，而 `StateBackend` 讀寫的是 graph
 *   state 的 `files`。沒給 `--workspace` 時 default backend 也是一個 `StateBackend`，所以 agent
 *   在自己的根目錄 `grep` 得到歷史檔（實測）。暫存那一格是同一個機制。
 *
 * @param backend - 組裝點的 default backend（已經包過暫存那一格）。
 * @returns 同一個 backend，外面再包一層只有這一條路由的 `CompositeBackend`。
 */
function withConversationHistory(backend: AnyBackendProtocol): AnyBackendProtocol {
  // **路由鍵要有結尾斜線。** `CompositeBackend.getBackendAndKey` 拿 `prefix.slice(0, -1)` 比對
  // 目錄本身、`key.substring(prefix.length)` 剝前綴，兩個都假設鍵以 `/` 結尾。少了它，寫進去
  // 的鍵變成 `//session_x.md`，照確切路徑 `read_file` 仍讀得到（兩邊同樣錯），但在這個目錄底下
  // `ls`／`grep` 都對不上（實測 `grep` 回 No matches）。
  return new CompositeBackend(backend, {
    [`${CONVERSATION_HISTORY_PREFIX}/`]: new TextOnlyStateBackend(),
  });
}

/**
 * 這一次組裝的迴圈上限，三態：**明著傳的 > 條目提供的服務 > 內建預設**。
 *
 * 形狀照 #456 那三列的 `repeatReminderDisposition`（`@nexus/core` 的 `fold.ts`），但**刻意少一
 * 態**。那邊有第四格（`registry.disabledEntries.has(...)`）是因為「條目被關掉」與「清單上沒有那
 * 一列」在 `services.get()` 眼中一模一樣、而正確答案相反；這裡兩件事都不成立：
 *
 * - **這一列關不掉**（`plugin-config.ts` 的 `PROTECTED_ENTRY_NAMES`）。設定寫壞時它會掉、記成沒掛（#751），但那時
 *   也不需要第四格，理由是下一條。
 * - **就算關得掉，兩種成因的答案相同**——都是 {@link DEFAULT_RECURSION_LIMIT}，因為護欄沒有
 *   「不掛」這個狀態，基座那層 `withConfig({ recursionLimit: 1e4 })` 永遠在下面。
 *
 * 多寫那一格不會改變任何行為，只會讓讀的人以為那裡有一個分岔。
 *
 * **第一態是一條登記過的偏離，不是順手寫的。** 形狀上它跟 #456 那三列的第一態一樣
 * （`options.X !== undefined`），但那三列沒有旗標，所以它們沒回答過「旗標與設定誰贏」。dsh 回答
 * 過，而且答案的**載體**跟這裡不同：它把優先序寫在設定值自己身上（`port: !!js
 * ctx.webStartup.port ?? 3080`），逐字「No row has launcher-level command-line status」。我們沒有
 * `inject`、也沒有延後解析的設定值，所以退到「在讀它的這個函式裡排優先序」。逐條登記見
 * [`settings/recursion-limit.ts`](./settings/recursion-limit.ts) 的偏離 2。
 *
 * @param registry - 已經跑完 `loadPlugins()` 的 registry。
 * @param options - 組裝點自有的那些。
 * @returns super-step 上限，不是模型輪數。換算見 {@link DEFAULT_RECURSION_LIMIT}。
 */
function recursionLimitFor(registry: PluginRegistry, options: CreateNexusAgentOptions): number {
  if (options.recursionLimit !== undefined) return options.recursionLimit;
  return registry.services.get(RECURSION_LIMIT_SERVICE) ?? DEFAULT_RECURSION_LIMIT;
}

/** 模型物件自己報的型號；沒有的話退到它的種類名，每個 `BaseChatModel` 都有。字串形式的模型（基座的 `provider:model`）原樣用。 */
function modelLabelOf(model: AgentModel): string {
  if (typeof model === 'string') return model;
  // 型別上 `AgentModel` 含 `undefined`（基座的參數是選填），但這個選項是必填的；真的漏了，基座退到它自己的預設。
  if (model === undefined) return 'default';
  const named = model as unknown as { model?: unknown; modelName?: unknown };
  for (const candidate of [named.model, named.modelName]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate;
  }
  return model._llmType();
}

export async function createNexusAgent(options: CreateNexusAgentOptions) {
  // **跑在 `loadPlugins` 之前**：它只看 `options.model`，這時候還沒有任何 plugin 開好資源，
  // 所以失敗了不必先 `dispose()`。其餘四種都在下面那個 try 裡，因為它們要等 registry。
  assertHarnessProfileDeclared(options.model, options.expectedHarnessProfile);
  if (options.backgroundSubagents !== undefined && options.checkpointer == null) {
    throw new Error(
      'backgroundSubagents 需要 checkpointer：沒有存檔點，背景子代理的第二輪就看不到第一輪',
    );
  }
  const delegation =
    options.backgroundSubagents === undefined
      ? undefined
      : new BackgroundDelegation(options.backgroundSubagents);

  // **放在最前面**：出貨清單的 `system-prompt` 在自己的 `apply` 當下就讀變數（#720）。
  const plugins: readonly PluginEntry[] = [
    createHostServicesPlugin(
      {
        systemPromptVariables: {
          model: options.systemPromptVariables?.model ?? modelLabelOf(options.model),
          cwd: options.systemPromptVariables?.cwd ?? '/',
        },
      },
      'system-prompt-variables',
    ),
    ...options.plugins,
    ...(delegation === undefined ? [] : [delegation.entry()]),
  ];
  const optional = options.optionalEntries;
  const { registry, dispose, dropped } = await loadPlugins(
    plugins,
    undefined,
    optional === undefined
      ? {}
      : {
          perEntry: true,
          // **撞名算那一列 `apply` 失敗**（#751）：在它 `apply` 完的當下查整份，前面每一列都已經查過、保留名單又是
          // 固定的，所以查得到的只會是它剛註冊的，掉的就只有它。
          afterApply: (loading) => void assertNoBaseToolNameCollision(loading),
        },
  );
  const assemblyDrops = optional === undefined ? [] : pairWithEntries(plugins, dropped);

  try {
    const fatal = new Set(
      assemblyDrops
        .filter(({ entry }) => !(optional?.has(entry) ?? false))
        .map(({ entry }) => entry),
    );
    if (fatal.size > 0) throw new AssemblyDropError(assemblyDrops, fatal);
    // 逐列掉模式下每一列已經查過自己的了；整份再查一次當安全網，全有全無那條路則靠它。
    assertNoBaseToolNameCollision(registry);
    // 選擇的合法性在**這裡**驗，不是等接線時才驗：runner 是每一份會話日誌各建一個的，
    // 壞掉的 regex 預設會拖到第一輪對話才炸，那不是組裝失敗該出現的地方。
    if (options.invariants !== undefined) assertInvariantSelection(options.invariants);

    // 暫存的路由目標與外溢層的存檔服務是**同一個實例**：同一個會話目錄、同一套權限，外溢的檔與基座 eviction 的檔
    // 都落在模型 `read_file` 讀得到的同一條前綴底下（#719）。
    const stashRoute =
      options.toolResultStash === undefined
        ? undefined
        : createToolResultStash(options.toolResultStash);
    const params = foldRegistry(registry, {
      defaultBackend: withConversationHistory(
        // 墊底的虛擬 FS 讀到二進位檔照 dsh 拒絕（#642），路由那兩格同一種。
        withToolResultStash(options.backend ?? new TextOnlyStateBackend(), stashRoute),
      ),
      ...(options.spillPolicy !== undefined &&
        stashRoute !== undefined && {
          spillPolicy: {
            maxInlineTokens: options.spillPolicy.maxInlineTokens,
            store: stashRoute.spillStore(TOOL_RESULT_STASH_PREFIX),
            ...(options.toolResultStash?.warn !== undefined && {
              warn: options.toolResultStash.warn,
            }),
          },
        }),
      toolOrder: options.toolOrder,
      baseToolNames: options.baseToolNames ?? BASE_TOOL_NAMES,
      model: options.model,
      checkpointer: options.checkpointer,
      store: options.store,
      approvals: options.approvals,
      ...(options.summarization !== undefined && { summarization: options.summarization }),
      ...(options.toolResultPruning !== undefined && {
        toolResultPruning: options.toolResultPruning,
      }),
      ...(options.repeatReminder !== undefined && { repeatReminder: options.repeatReminder }),
      ...(options.observationPolicy !== undefined && {
        observationPolicy: options.observationPolicy,
      }),
      ...(options.modelUsage !== undefined && { modelUsage: options.modelUsage }),
      ...(options.stepInbox === true && { stepInbox: true }),
    });

    // `withConfig` 疊在基座自己那一層 `withConfig` 上面，後者贏（實測 `8` → 模型只被叫
    // 3 輪）。**推導出來的型別沒有塌**：包完之後 `invoke()` 的 `messages` 仍然是
    // `BaseMessage[]` 而不是 `any`，所以 {@link NexusAgentHandle} 那個別名照樣成立
    // ——這件事驗過，因為 `any` 是不會讓 typecheck 紅的那種壞掉。
    const agent = createDeepAgent({
      ...params,
      ...(options.systemPrompt !== undefined && { systemPrompt: options.systemPrompt }),
    }).withConfig({ recursionLimit: recursionLimitFor(registry, options) });

    // 接上去但還沒收掉的協調器。**組裝點自己記著**，因為呼叫端可能只叫 `dispose()`
    // 就走人——那時 `shutdown` 標記與後端的排空都還沒發生，遙測會少掉最後一段。
    const attached = new Set<TelemetryAttachment>();
    /** detach 時還在收的背景 host：`dispose` 要等它們，不然後端先關、進行中的輪寫到一半。 */
    const hostCloses = new Set<Promise<void>>();
    /**
     * 把 fold 過的子代理規格編成一張**帶存檔點的圖**，給背景續行用（[#825](https://github.com/DemianLi/nexus-agent/issues/825)，
     * [#737](https://github.com/DemianLi/nexus-agent/issues/737)）。一次性的委派仍走基座的 `task`；這是另一條路，
     * 細節與為什麼要另編見 {@link @nexus/core!compileSubagentGraph}。
     *
     * **模型的 harness profile 若會動子代理的組成就拋**：拿掉工具、加或拿 middleware 這幾根槓桿基座在 `createSubAgent`
     * 之外套用，自編的圖不套用，靜靜略過的話背景子代理與一次性子代理就是兩個不同的東西。
     *
     * @param name - 子代理名（`general-purpose` 或某個 plugin 註冊的）。
     * @param checkpointer - 這張圖的存檔點；同一個 `thread_id` 的下一輪看得到上一輪。
     * @returns 編好的圖。
     * @throws 沒有這個子代理、規格不合、profile 會動組成。
     */
    const compileSubagent = (
      name: string,
      checkpointer: NonNullable<AgentCheckpointer>,
      model?: BaseChatModel,
    ) => {
      const effects = describeHarnessProfileEffects(options.model);
      const touched = [
        ...effects.excludedTools.map((tool) => `拿掉工具 ${tool}`),
        ...effects.excludedMiddleware.map((each) => `移除 middleware ${each}`),
        ...effects.extraMiddleware.map((each) => `加 middleware ${each}`),
      ];
      if (touched.length > 0) {
        throw new Error(
          `這個模型的 harness profile 會動子代理的組成（${touched.join('、')}），背景子代理的自編圖不套用；` +
            '一次性委派走基座，兩條路會長得不一樣，所以不編。',
        );
      }
      // **背景圖要自己帶上限**（#858 的量測）：它是 `createAgent` 直接編的，沒有 `createDeepAgent` 最後那層
      // `withConfig`，也沒有一次性子代理從 `task` 那次呼叫繼承來的 root 上限，於是落在 LangGraph 的預設 25——
      // 連續 8 次工具呼叫就 `GraphRecursionError`。給它跟 root 同一個值（旗標 > 設定列 > 預設），背景子代理每一輪才跟
      // 一次性的、跟 root 一樣長。
      return compileSubagentGraph(params, name, {
        checkpointer,
        ...(model !== undefined && { model }),
      }).withConfig({
        recursionLimit: recursionLimitFor(registry, options),
      });
    };

    return {
      agent,
      /**
       * 這一次組裝掉了的可少掛條目（#751）。沒給 {@link CreateNexusAgentOptions.optionalEntries} 時一律是空的：
       * 全有全無的組裝一列失敗就整個拋，走不到這裡。
       */
      dropped: assemblyDrops,
      /**
       * 外掛在 `apply` 裡交出的警告（#751，`registry.logger`），例如 MCP 連不上而照樣掛上。呼叫端跟掉了的列印在同一段。
       */
      warnings: registry.logger.warnings(),
      /**
       * 這一次組裝收不收插話（#710），見 {@link CreateNexusAgentOptions.stepInbox}。
       */
      stepInbox: options.stepInbox === true,
      /**
       * plugin 註冊的**人的命令**。進入點靠它把一行 `/name` 發派出去。
       *
       * 交出去的是整個註冊點而不是只有 `find`，理由是 `register()` 自己就擋得住誤用：
       * 它要 `requireOrigin()`，而組裝之後沒有任何 plugin 的 `apply` 在跑，呼叫它會
       * 當場拋。所以這裡沒有「組裝後偷偷加命令」這條路。
       */
      commands: registry.commands,
      /**
       * 評分與評語的規則，**沒掛時是 `undefined`**。讀它的是 web 的 wire-handler：評分沒有模型
       * 那一側，所以它跟 `commands` 一樣從組裝點交出去（[#278](https://github.com/DemianLi/nexus-agent/issues/278)）。
       */
      feedback: registry.services.get(MESSAGE_FEEDBACK_SERVICE),
      /**
       * plugin 提供的**服務**（[#459](https://github.com/DemianLi/nexus-agent/issues/459)）。
       *
       * 交出去的是整個註冊點而不是某幾個名字，理由有兩條。一是**這個檔案一顆 plugin 都不
       * import**：`feedback` 與 `telemetry` 走的是 `@nexus/core` 自己的通道，而服務名住在
       * 各個 plugin 裡，在這裡列名字等於讓通用工廠認得特定 plugin。二是 `provide()` 自己
       * 就擋得住誤用——它要 `requireOrigin()`，而組裝之後沒有任何 `apply` 在跑，呼叫它會
       * 當場拋（同 `commands` 那一格的理由）。
       *
       * 今天的消費者是續行排程器（`cli.ts` 的 `goalDriverPort` 讀 `goals`）。
       */
      services: registry.services,
      /**
       * 掛著的遙測服務說的共享策略，**沒掛任何東西時是 `undefined`**。
       *
       * 披露那一層只有在拿到 `undefined` 的時候才渲染「未配置」——這是 dsh 的規矩，
       * 也是為什麼這裡回的是「有沒有掛」而不是一個保險的預設值。
       */
      telemetrySharing: registry.services.get(SESSION_TELEMETRY_SERVICE)?.sharing,
      /**
       * 把一次組裝的**每一份**會話日誌接上遙測。**沒掛後端時回 `undefined`**——沒有後端
       * 就沒有出口，建一個把記錄丟進虛空的協調器只會讓熱路徑白付投影與脫敏的成本。
       *
       * **一份會話一個協調器，而且新開的那些自動有。** 這是 dsh 的形狀——它的 live
       * capture「subscribes to the session firehose」並且「sweeps already-live sessions」
       * （`packages/session/session-telemetry/src/coordinator.ts` 檔頭），per-session 的
       * 狀態掛在以 session 為鍵的 `WeakMap` 上。subagent 的日誌因此不必有人記得重接。
       *
       * **怎麼捕獲由後端說的共享策略決定**（[#279](https://github.com/DemianLi/nexus-agent/issues/279)）：
       * `feedback-only` 是 on-demand，只在人送出回饋時補送（{@link watchFeedback}）；其餘是 live。
       * dsh 把這一段放在 OTel 後端自己的建構子裡（它的後端自己組協調器）；我們的協調器從
       * [#89](https://github.com/DemianLi/nexus-agent/issues/89) 起就在這裡組，plugin 碰不到日誌，所以
       * 策略跟著協調器住在這裡。協調器本身照舊不讀 `sharing`。
       *
       * @param sessions - 這次組裝的會話註冊表。
       * @returns 收掉這一次接線的函式，或沒掛後端時的 `undefined`。
       */
      attachTelemetry(sessions: SessionRegistry): (() => Promise<void>) | undefined {
        const mounted = registry.services.get(SESSION_TELEMETRY_SERVICE);
        if (mounted === undefined) return undefined;
        const { sharing } = mounted;
        const mine = new Set<TelemetryAttachment>();
        const unobserve = sessions.observe(({ log }) => {
          const coordinator = new SessionTelemetryCoordinator({
            log,
            sink: mounted,
            // 現讀而不是快照：`rules()` 每次捕獲都重新問一遍，補送歷史時套的是**現在**
            // 掛著的策略。這是 dsh waterfall 的語意，折疊要接得住。
            rules: () => registry.telemetry.rules(),
            capture: sharing === 'feedback-only' ? 'on-demand' : 'live',
          });
          const unwatch = watchFeedback(log, sharing, coordinator);
          // 退訂跟協調器綁成一個：組裝整個收掉時（下面的 `dispose`）只知道逐個收，
          // 分開記的話觸發器會留下來，對一個關掉的後端補送。
          const attachment: TelemetryAttachment = {
            dispose: async () => {
              unwatch();
              await coordinator.dispose();
            },
          };
          attached.add(attachment);
          mine.add(attachment);
        });
        return async () => {
          unobserve();
          for (const attachment of [...mine]) {
            mine.delete(attachment);
            attached.delete(attachment);
            await attachment.dispose();
          }
        };
      },
      /**
       * 把一份會話日誌接上註冊著的不變量配套入口。**沒有人註冊時回 `undefined`**——
       * 同 `attachTelemetry` 的理由：沒有檢查就不要在熱路徑上多掛一個訂閱。
       *
       * 過濾器（`enabled` / allowlist / blocklist）從 {@link CreateNexusAgentOptions.invariants}
       * 來，**原樣轉下去**。沒給就是全裝。違規的去處同理，從
       * {@link CreateNexusAgentOptions.onInvariantViolation} 來，沒給就是 runner 的預設。
       *
       * **`companions.length === 0` 這一條擋在過濾之前，不是之後**：這裡問的是「有沒有
       * 人註冊」，而不是「過濾完還剩幾個」。過濾成空集合是一個有效的選擇結果，runner
       * 照樣要接（它擁有訂閱與失敗語意），只是一個檢查都不裝。
       *
       * **每一份會話各一個 runner**，同 dsh 的配套入口（`for (const session of
       * ctx.sessions.list()) seedSession(session)` 加 `ctx.on('session/created', …)`，
       * `packages/core/session/src/invariant.ts:218-220`）。subagent 的日誌因此不會變成
       * 一個沒有檢查的角落。
       *
       * @param sessions - 這次組裝的會話註冊表。
       * @returns 收掉這一次接線的函式，或沒有配套入口時的 `undefined`。
       */
      attachInvariants(sessions: SessionRegistry): (() => void) | undefined {
        const companions = registry.invariants.companions();
        if (companions.length === 0) return undefined;
        const runners: (() => void)[] = [];
        const unobserve = sessions.observe(({ log }) => {
          runners.push(
            createInvariantRunner({
              log,
              companions,
              ...(options.invariants !== undefined && { selection: options.invariants }),
              ...(options.onInvariantViolation !== undefined && {
                onViolation: options.onInvariantViolation,
              }),
            }),
          );
        });
        return () => {
          unobserve();
          // 倒著收，同 `load.ts` 收 lifecycle disposer 的順序。
          for (const stop of [...runners].reverse()) stop();
          runners.length = 0;
        };
      },
      /**
       * 把會話註冊表接上來：**綁給模型工具，並把每一份會話裝上 `sessions` 參與者**。
       *
       * **它做兩件事，而且不再有「沒有人註冊就回 `undefined`」那條短路。** 短路以前成立
       * 是因為這個口只餵參與者；現在它同時是模型工具問「我該寫進哪一份日誌」的那條線
       * （`registry.sessions.forCall`）。一個只註冊工具、沒有 `join` 任何參與者的 plugin
       * 在短路底下會永遠拿到「沒接上」，而那是一個**看起來像設定問題的假象**。
       *
       * **這裡沒有 selection 也沒有 `onViolation`。** 那兩樣是不變量的東西：一個回答
       * 「這個 package 的檢查要不要裝」，一個回答「違規往哪裡印」。參與者不產生違規，
       * 它產生的是事件；要不要裝它由清單那一層答（條目層的 `disabled`），而它自己壞掉
       * 只換來一行 warn。
       *
       * @param sessions - 這次組裝的會話註冊表。
       * @param backgroundPort - 背景子代理往主對話這個方向的出口：結算通知（#840）與寫來的話（#849）。
       *   **省略即沒有人被通知、子代理也寄不出去**（cli 的 REPL 一行一輪）；serve 傳 pump 的 `notifySettled` 與
       *   `receiveAgentMessage`。
       * @returns 收掉這一次接線的函式：退訂、解綁，再倒著收每一份會話的 runner。
       */
      attachSession(
        sessions: SessionRegistry,
        backgroundPort?: BackgroundParentPort,
      ): SessionDetach {
        const installers = registry.sessions.installers();
        const unbind = registry.sessions.bind(sessions);
        // 背景派出的 host：**在這裡建**（任何圖的環境之外），detach 時等進行中的輪收完。
        const closeHost = delegation?.attach(
          sessions,
          (subagent, modelId) => {
            let model: BaseChatModel | undefined;
            if (modelId !== undefined) {
              const modelFor = options.backgroundSubagents?.modelFor;
              if (modelFor === undefined) {
                throw new Error(
                  `這份組裝建不出別的模型，背景子代理 "${subagent}" 不能指定 "${modelId}"`,
                );
              }
              model = modelFor(modelId);
            }
            return compileSubagent(
              subagent,
              options.checkpointer!,
              model,
            ) as unknown as BackgroundAgent;
          },
          backgroundPort,
        );
        const runners: (() => void)[] = [];
        const unobserve = sessions.observe(({ address, log }) => {
          if (installers.length > 0)
            runners.push(createSessionRunner({ address, log, installers }));
        });
        const detach = () => {
          unobserve();
          unbind();
          for (const stop of [...runners].reverse()) stop();
          runners.length = 0;
          if (closeHost !== undefined) {
            const closing = closeHost().finally(() => hostCloses.delete(closing));
            hostCloses.add(closing);
          }
        };
        return closeHost === undefined
          ? detach
          : Object.assign(detach, { background: closeHost.control });
      },
      compileSubagent,
      async dispose() {
        // 遙測先收：後端很可能是某個 plugin 開的，plugin 的 disposer 一跑它就沒了，
        // 那時再送 `shutdown` 標記等於送進一個已經關掉的東西。
        // 背景 host 比它更早：它們還在往日誌寫，遙測要收得到最後那幾顆。
        await Promise.all([...hostCloses]);
        for (const attachment of [...attached]) {
          attached.delete(attachment);
          await attachment.dispose();
        }
        await dispose();
      },
    };
  } catch (error) {
    // 清理自己失敗的話不能蓋掉原本的錯誤——那個才是使用者要修的東西。
    await dispose().catch(() => {});
    throw error;
  }
}

/**
 * 把載入器交出來的掉了的列對回清單上的條目物件。身分照載入器同一支算（補號、重複 id），所以 `origin.id`
 * 對得上。
 */
function pairWithEntries(
  plugins: readonly PluginEntry[],
  dropped: readonly DroppedEntry[],
): AssemblyDrop[] {
  const byId = new Map(
    resolveEntriesPerEntry(plugins).map(({ origin }, index) => [origin.id, plugins[index]]),
  );
  return dropped.flatMap((drop) => {
    const entry = byId.get(drop.origin.id);
    return entry === undefined ? [] : [{ entry, drop }];
  });
}

/** 一份日誌的遙測接線：協調器，加上 `feedback-only`／`disabled` 那個看回饋的訂閱。 */
interface TelemetryAttachment {
  dispose(): Promise<void>;
}

/** 策略是關閉時收到回饋講的那一句。dsh 的 `DISABLED_FEEDBACK_WARNING` 翻過來。 */
export const DISABLED_FEEDBACK_WARNING = '遙測：策略是關閉，這則回饋不會經遙測送出去。';

/**
 * 共享策略裡跟回饋有關的兩格，照 dsh 的 OTel 後端
 * （`packages/session/session-telemetry-otel/src/index.ts:160-164,236-248`，`c291e79`）：
 *
 * - `feedback-only`：每收到一顆回饋（{@link isFeedbackEvent}），就把日誌從上次交到的地方補送到
 *   現在。第一次是整份——前面的輪、續接帶進來的歷史都在內，照 dsh 的 `includeHistory: true`。
 * - `disabled`：收到回饋時講一聲，這則不會經遙測出去。
 * - `full` 本來就每顆都送，不用看。
 *
 * **用 `log.subscribe`，不用 `SessionSubject.observe`**：後者一接上就把日誌重播一遍，而續接回來的
 * 日誌裡可能本來就有上一個行程的回饋——重播到它，就等於在接上的當下把整份歷史送出去，這一次
 * 沒有人按過送出。
 *
 * **補送沒有上界**，dsh 的 `captureSession` 有（`throughSeq`）。這裡省掉，靠的是 `subscribe`
 * 在 append 之後同步叫：listener 跑的當下日誌剛好到那一顆回饋。除非另一個訂閱者在同一次通知裡
 * 又寫了一顆，今天沒有這種寫者。
 *
 * @param log - 這一份會話日誌。
 * @param sharing - 掛著的後端說的策略。
 * @param coordinator - 這一份日誌的協調器，`feedback-only` 時是 on-demand。
 * @returns 退訂；`full` 沒有訂閱，回 no-op。
 */
function watchFeedback(
  log: SessionLog,
  sharing: SessionTelemetrySharingStatus,
  coordinator: SessionTelemetryCoordinator,
): () => void {
  if (sharing === 'full') return () => {};
  return log.subscribe((event) => {
    if (!isFeedbackEvent(event)) return;
    if (sharing === 'feedback-only') coordinator.captureNow();
    else console.warn(DISABLED_FEEDBACK_WARNING);
  });
}

/**
 * plugin 註冊的工具不得佔用基座內建的名字。
 *
 * 基座自己有一道同樣意思的檢查（`createDeepAgent()` 開頭的 `BUILTIN_TOOL_NAMES`
 * → `ConfigurationError('TOOL_NAME_COLLISION')`），這裡先擋是為了兩件事：
 *
 * - **指名是誰。** 基座的訊息只說哪個工具名撞了，不知道是清單裡哪一個 plugin 註冊的——
 *   而 registry 每次註冊都記著 origin，這是我們比基座多知道的東西。
 * - **補上基座沒查的那半。** 它只檢查 root 的 `tools`。註冊到 subagent 層、或 subagent
 *   定義自帶的同名工具**不會**觸發它：那些工具跟該 subagent 那份 middleware stack 帶的
 *   內建檔案工具擠在同一個名字上，誰贏由基座內部的合併順序決定，而且是無聲的。
 *
 * 用的是 {@link RESERVED_BASE_TOOL_NAMES} 而不是 `foldRegistry` 收的 `baseToolNames`：
 * 那是兩個不同的集合，前者多了 async 那五個。理由見
 * [`base-tools.ts`](./base-tools.ts)——基座的保留是無條件的，而名字宇宙是條件式的。
 */
function assertNoBaseToolNameCollision(registry: PluginRegistry): void {
  const collisions: string[] = [];

  const collect = (name: string, where: string, origin: PluginOrigin): void => {
    if (RESERVED_BASE_TOOL_NAMES.has(name)) {
      collisions.push(`${formatOrigin(origin)} 在${where}註冊了 "${name}"`);
    }
  };

  for (const [name, entry] of registry.tools.effective()) {
    collect(name, '全域', entry.origin);
  }
  for (const scope of registry.tools.scopes()) {
    for (const [name, entry] of registry.tools.own(scope)) {
      collect(name, `subagent "${scope}"`, entry.origin);
    }
  }
  for (const [name, entry] of registry.subagents.entries()) {
    for (const tool of entry.value.tools ?? []) {
      collect(tool.name, `subagent "${name}" 自帶的工具裡`, entry.origin);
    }
  }

  if (collisions.length === 0) return;
  throw new Error(
    `工具名撞到基座保留的名字：${collisions.join('；')}。` +
      `這些名字歸基座的 middleware stack 所有（檔案系統工具、task、async 任務那組），` +
      `佔用它們不會取代基座的版本，只會讓兩個同名工具擠在一起。換個名字。` +
      `目前被保留的：${[...RESERVED_BASE_TOOL_NAMES].sort().join('、')}`,
  );
}
