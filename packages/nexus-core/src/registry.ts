/**
 * `PluginRegistry`——plugin 的 `apply` 拿到的那個東西。
 *
 * 九個註冊點：`tools` / `subagents` / `capabilities` 是具名的，`backend` / `skills`
 * 也靠名字（`routePrefix` 與來源路徑）擋重複，其餘三個（`middleware` /
 * `permissions` / `approvals`）沒有名字可撞，走匿名追加。折疊成
 * `createDeepAgent` 參數的部分在 {@link ./fold.ts}。
 *
 * 外加七條**不折進 `createDeepAgent` 任何參數**的通道，所以它們不算進那九個：
 * {@link LifecycleRegistrationPoint} 回答「這些東西怎麼收掉」，
 * {@link TelemetryRegistrationPoint} 回答「送出去之前怎麼洗」，
 * {@link InvariantRegistrationPoint} 回答「這個會話發生的事有沒有破壞誰的約定」，
 * {@link CommandRegistrationPoint} 回答「人打得出哪些斜線命令」，
 * {@link SessionRegistrationPoint} 回答「誰拿得到這個會話的日誌」，
 * {@link ServiceRegistrationPoint} 回答「這次組裝的協作者從哪裡拿」（[#459](https://github.com/DemianLi/nexus-agent/issues/459)）。
 * 九個註冊點回答的是「這個 agent 由什麼組成」，六者正交。
 *
 * **第七條是唯一一條沒有人往裡面註冊東西的**：{@link DisabledEntryView | disabledEntries}
 * 回答「產生這個 registry 的那份清單說了什麼」，是唯讀視圖而不是註冊點
 * （[#456](https://github.com/DemianLi/nexus-agent/issues/456)）。它進得了這份清單是因為
 * 它確實是 `PluginRegistry` 的一個欄位，而那個數字有絆索在數（`registry-channel-count.test.ts`）。
 *
 * **遙測後端與回饋規則不在這份清單上**，它們是 `services` 上的兩個名字
 * （[#477](https://github.com/DemianLi/nexus-agent/issues/477)）：兩者本來各有一個「一個
 * registry 只收一個」的註冊點，而那正是 `services.provide()` 一次解決的事。
 */

import type { StructuredTool } from '@langchain/core/tools';
import type { AnyBackendProtocol, SubAgent } from 'deepagents';
import type { ZodType } from 'zod';
import type { AgentMiddleware } from './base-types.js';
import type { PreToolListener } from './approval.js';
import { normalizeCommandDefinition } from './commands.js';
import type { CommandDefinition, CommandDescriptor } from './commands.js';
import { AnonymousEntries, CapabilitySet, NamedEntries } from './entries.js';
import type { NamedEntry } from './entries.js';
import { formatOrigin } from './plugin.js';
import type { PluginOrigin } from './plugin.js';
import { duplicateCompanionError } from './invariants.js';
import type { InvariantCompanion, InvariantInstaller } from './invariants.js';
import type { SessionInstaller } from './sessions.js';
import { toolCallSessionAddress } from './session-address.js';
import type { SessionAddress } from './session-address.js';
import type { SessionRegistry } from './session-registry.js';
import type { SessionLog } from './session-log.js';
import type { SessionTelemetryRedactRule, SessionTelemetryService } from './session-telemetry.js';
import type { FeedbackService } from './feedback.js';
import type { RepeatReminderSettings } from './repeat-reminder.js';
import type { SummarizationSettings } from './summarization.js';
import type { ToolResultPruneConfig } from './tool-result-pruner.js';
import type { ToolErrorInfo } from './tool-events.js';

/**
 * 註冊層的定址。`undefined` 是全域（root agent），字串是那個名字的 subagent。
 *
 * 只有兩層，沒有巢狀——層結構由 deepagents 的形狀決定（root 加一排 subagents），
 * 不是 dsh 那種來自 Cordis context 樹的任意深度。
 */
export type ScopeKey = string;

/**
 * root-only 工具在 subagent 裡被叫到時，自己帶的拒絕句與碼。
 *
 * 給了才用；`rootOnly: true` 走 fold 預設那句、不帶碼（`fold.ts` 的 `rootOnlyRefusal`）。
 * 只有 dsh 那側有現成的碼時才該給——例如問答那顆的 `DELEGATED_CALLER`（#324）。
 */
export interface RootOnlyRefusal {
  /** 模型看到的那一句，`Error: ` 之後的部分；**不要自己帶前綴**。 */
  readonly message: string;
  /** 帶進日誌 `tool/result` 的碼。 */
  readonly error?: ToolErrorInfo;
}

export interface RegisterOptions {
  /** 註冊到哪一層。省略即全域。 */
  scope?: ScopeKey;
  /**
   * 這個工具**只在 root agent 上執行**。fold 會把每個 subagent 那一份裡的同名項換成
   * 一顆說得出原因的拒絕樁，見 {@link ./fold.ts}。
   *
   * **只能配全域註冊。** 帶著 `scope` 一起給是矛盾的——那是在往 subagent 身上掛一個
   * 「不給 subagent」的工具——所以當場拋，不靜默忽略。
   *
   * 給一個 {@link RootOnlyRefusal} 等於 `true` 再加上自己的拒絕句與碼。
   */
  rootOnly?: boolean | RootOnlyRefusal;
  /**
   * 這個工具**成功**輸出的形狀。fold 打底的校驗器對它驗每一次成功的結果，不合就換成一則
   * 帶 `INVALID_TOOL_OUTPUT` 的錯誤（見 {@link ./output-schema.ts}）。
   *
   * 對 dsh `defineTool` 的 `output.schema`，但**選帶不強制**：`StructuredTool` 沒有這個欄位，
   * 省略即不驗。只有回 JSON 字串（或夾在 `Command` 裡的 JSON ToolMessage）的工具宣告得了——
   * 驗的是 `JSON.parse(content)`。
   */
  outputSchema?: ZodType;
}

/** 一層的具名表們。 */
interface Layer {
  readonly tools: NamedEntries<StructuredTool>;
}

/** `tools` 註冊點：同層同名報錯、跨層遮蔽。 */
export interface ToolRegistrationPoint {
  /**
   * 註冊一個工具。
   * @param tool - 工具實例，名字取自它的 `name`。
   * @param options - 註冊到哪一層。
   * @returns 只撤銷這一次註冊的冪等 undo。
   */
  register(tool: StructuredTool, options?: RegisterOptions): () => void;
  /**
   * 從某一層看一個工具名解析到誰。就近原則：該層自己註冊的遮蔽掉全域的同名工具。
   * @param name - 工具名。
   * @param scope - 觀看的層，省略即全域視角。
   * @returns 該層解析到的那筆，或都沒有時的 `undefined`。
   */
  resolve(name: string, scope?: ScopeKey): NamedEntry<StructuredTool> | undefined;
  /**
   * 某一層看得到的完整工具集合。
   * @param scope - 觀看的層，省略即全域視角。
   * @returns 全域先、該層的同名項覆蓋其上的插入順序表。
   */
  effective(scope?: ScopeKey): Map<string, NamedEntry<StructuredTool>>;
  /**
   * 某一層**自己**註冊的那些工具，不含全域打底。刻意與 {@link effective} 分開：
   * 問「這一層自己貢獻了什麼」的呼叫端不該默默收到全域的東西（dsh 的
   * `ScopedLayers.peek()` 同樣理由，明文 chain-blind）。
   * @param scope - 那一層。
   * @returns 該層自己的插入順序表，沒有那一層時是空表。
   */
  own(scope: ScopeKey): Map<string, NamedEntry<StructuredTool>>;
  /**
   * 全域那一份裡，這個名字是不是宣告成 root agent 專用的。
   *
   * **比對的是工具實例而不是名字**，同 {@link ./entries.ts | NamedEntries} 的 undo：
   * 撤銷過的註冊不能把旗標留給後來占用同名的別人。
   * @param name - 工具名。
   * @returns 全域解析得到、而且那一筆就是宣告 `rootOnly` 的那一個實例時為真。
   */
  isRootOnly(name: string): boolean;
  /**
   * 全域那一份裡，這個名字的 root-only 註冊自己帶的拒絕句與碼。查法同 {@link isRootOnly}。
   * @param name - 工具名。
   * @returns 註冊時給的那一份；不是 root-only、或只給了 `true` 時是 `undefined`。
   */
  rootOnlyRefusalOf(name: string): RootOnlyRefusal | undefined;
  /**
   * 這一顆工具實例註冊時宣告的輸出 schema。
   *
   * **以實例查而不是名字**，理由同 {@link isRootOnly}；而且校驗器在執行期手上本來就是那顆
   * 實例（`request.tool`），同名的工具在不同層可以是不同的東西。
   * @param tool - 工具實例；不是這裡註冊過的東西一律回 `undefined`。
   * @returns 宣告的 schema，沒宣告或已撤銷時是 `undefined`。
   */
  outputSchemaOf(tool: unknown): ZodType | undefined;
  /**
   * 目前有東西註冊進去的 subagent 層。層是按名字延遲建立的，而且**不驗那個名字
   * 真有對應的 subagent**——`requires` 不排序，清單裡靠前的 plugin 本來就可以往
   * 靠後的 plugin 才註冊的 subagent 上加工具。「有層沒 subagent」是 fold 的後置
   * 檢查（見 {@link ./fold.ts}），不是這裡的即時錯誤。
   * @returns 依首次註冊順序的層名。
   */
  scopes(): string[];
}

/** `subagents` 註冊點：同名報錯。只有全域一層——deepagents 的 subagent 不巢狀。 */
export interface SubAgentRegistrationPoint {
  /**
   * 註冊一個 subagent。
   * @param subagent - subagent 定義，名字取自它的 `name`。
   * @returns 只撤銷這一次註冊的冪等 undo。
   */
  register(subagent: SubAgent): () => void;
  /**
   * 讀一個 subagent。
   * @param name - subagent 名。
   * @returns 該筆，或不存在時的 `undefined`。
   */
  get(name: string): NamedEntry<SubAgent> | undefined;
  /**
   * 依註冊順序走訪。
   * @returns 名字與該筆。
   */
  entries(): IterableIterator<[string, NamedEntry<SubAgent>]>;
}

/** `capabilities` 註冊點：宣告能力。重複提供冪等、不報錯。 */
export interface CapabilityRegistrationPoint {
  /**
   * 宣告本 plugin 提供某個能力。
   * @param name - 能力名。
   * @returns 只撤銷這一次宣告的冪等 undo。
   */
  provide(name: string): () => void;
  /**
   * 這個能力有沒有人提供。
   * @param name - 能力名。
   * @returns 是否至少有一個提供者。
   */
  has(name: string): boolean;
  /**
   * 查提供者，用於 `requires` 缺件時指名，以及「能力 → 提供者」對照表。
   * @param name - 能力名。
   * @returns 依宣告順序的提供者。
   */
  providers(name: string): readonly PluginOrigin[];
  /**
   * 目前被提供的所有能力。
   * @returns 依首次宣告順序的能力名。
   */
  names(): string[];
}

/**
 * 服務名 → 服務型別的對照表。每個服務由**擁有那個型別的套件**用宣告合併補一格，照 dsh 的
 * 做法（`declare module '@deepseek-ai/cordis' { interface Context { goals: GoalService } }`，
 * `references/deepseek-harness/packages/goal/goal/src/index.ts:59-63`，SHA `6b1808f`）。
 *
 * 沒補進來的名字仍然放得進去、取得出來，只是型別退到 `unknown`——`services` 的每個方法
 * 都有寬的那條多載。這與 dsh 一致：它的 `ctx.provide(name: string, value?: any)` 也留著。
 *
 * **下面兩格直接寫在這裡，不走宣告合併**，因為擁有這兩個型別的套件就是 core 自己
 * （[#477](https://github.com/DemianLi/nexus-agent/issues/477)）。規則沒有變——補格子的還是
 * 型別的擁有者，只是這一次擁有者不必從外面 `declare module` 進來。dsh 的位置也在這裡：
 * `sessionTelemetry` 那一格宣告在基底套件 `dsh-session-telemetry`，不在 OTel 後端裡
 * （`references/deepseek-harness/packages/session/session-telemetry/src/index.ts:19-21`）。
 */
export interface NexusServices {
  /**
   * 遙測後端。**沒人提供時 `services.get()` 回 `undefined`，那才是「未配置」**——這是 dsh
   * 的規矩，披露那一層據它渲染。名字見
   * {@link ./session-telemetry.ts | SESSION_TELEMETRY_SERVICE}。
   */
  sessionTelemetry: SessionTelemetryService;
  /**
   * 評分與評語的規則。沒人提供時是 `undefined`，wire 那一側據此回「這個組裝收不了回饋」。
   * 名字見 {@link ./feedback.ts | MESSAGE_FEEDBACK_SERVICE}。
   */
  messageFeedback: FeedbackService;
  /**
   * 重複工具呼叫提醒器的設定，由 `@nexus/core/repeat-reminder` 這個條目提供
   * （[#456](https://github.com/DemianLi/nexus-agent/issues/456)）。名字見
   * {@link ./repeat-reminder.ts | REPEAT_REMINDER_SERVICE}。
   *
   * **沒人提供不等於「關掉」**：那兩種成因的正確答案相反，分野見
   * {@link DisabledEntryView}。
   */
  repeatReminder: RepeatReminderSettings;
  /**
   * 工具結果剪刀的預算，由 `@nexus/core/tool-result-pruner` 這個條目提供
   * （[#456](https://github.com/DemianLi/nexus-agent/issues/456)）。名字見
   * {@link ./tool-result-pruner.ts | TOOL_RESULT_PRUNE_SERVICE}。
   *
   * **沒人提供不等於「不剪」**：那兩種成因的正確答案相反，分野見
   * {@link DisabledEntryView}。
   *
   * 「先讀後改」那一顆**沒有**對應的服務欄位，而那是刻意的：它沒有設定，所以只有三態
   * （見 {@link ./observation.ts | observationPolicyPlugin}）。
   */
  toolResultPruning: ToolResultPruneConfig;
  /**
   * 摘要的門檻與去向，由 `@nexus/core/summarization` 這個條目提供
   * （[#456](https://github.com/DemianLi/nexus-agent/issues/456)）。名字見
   * {@link ./summarization.ts | SUMMARIZATION_SERVICE}。
   *
   * **沒人提供不等於「關掉」**——而且這一顆的「關掉」不是「沒有」，是一顆同名空殼
   * （基座無條件建的那顆要靠同名取代才消得掉）。分野見 {@link DisabledEntryView}。
   */
  summarization: SummarizationSettings;
}

/** 已經宣告過型別的服務名。空表時是 `never`，那時只有寬的多載可用。 */
export type KnownServiceName = keyof NexusServices & string;

/**
 * `services` 註冊點：**依名字提供一個物件，依名字取得它**。
 *
 * 這是 [#459](https://github.com/DemianLi/nexus-agent/issues/459) 要的注入點，照 dsh 的
 * `ctx.provide` / `ctx.get`（`vendor/cordis/src/reflect.ts:277-305`）。它存在的理由是
 * **讓 plugin 的設定回到「只是資料」**：協作者（通道、backend、圍堵控制器）從這裡拿，
 * 不再塞進工廠的閉包裡。
 *
 * **與 `capabilities` 的分野在碰撞政策，不是口味**：`capabilities.provide` 冪等、多提供者
 * （`providers(name)` 回陣列，回滾其中一個不能抹掉另一個）；服務是**單一佔位**，重名
 * 直接拋，照 cordis 的 `service "<name>" has been registered at <fiber>`。兩種語意塞進
 * 同一個點就得犧牲一邊。
 *
 * **`requires` 照樣管得到服務**：`assertRequires` 兩邊都查（見 `load.ts`），所以宣告
 * `requires: ['sandboxPolicy']` 的 plugin 在沒人提供時一樣是載入失敗。服務名**不會**
 * 被寫進 `capabilities`——那會讓一句 `capabilities.provide('sandboxPolicy')` 在沒有
 * 任何服務的情況下滿足那條 `requires`。
 *
 * ## 偏離登記：缺件是失敗，不是等待
 *
 * cordis 的 `inject` 是反應式的——缺件時 fiber 停在 INACTIVE，等到有人提供才啟動
 * （`vendor/cordis/src/fiber.ts:611-622` 的 `_refresh`）。我們的載入是**一趟到底**的
 * 命令式折疊，deepagents / LangGraph 沒有 context 樹與 fiber 狀態機可以表達那件事，
 * 所以退到最接近的實作：**缺件當場失敗**。
 *
 * 直接後果：**清單順序在「誰提供、誰消費」之間是承重的**。今天沒有人踩到——#459 的五個
 * 協作者全是「組裝點提供、plugin 消費」或反過來，一條 plugin → plugin 的服務相依都沒有
 * ——所以組裝點把自己那幾個放在清單最前面就夠了。**plugin → plugin 的服務相依不在
 * #459 的射程內**；真要的那天，順序才會變成承重的，那時再決定是拓撲排序還是照 dsh 做成惰性。
 */
export interface ServiceRegistrationPoint {
  /**
   * 提供一個服務。
   * @param name - 服務名，**全域唯一**。
   * @param value - 服務物件。借用的，不複製。
   * @returns 只撤銷這一次提供的冪等 undo。
   * @throws 這個名字已經有人提供了——訊息指名前一個提供者。
   */
  provide<K extends KnownServiceName>(name: K, value: NexusServices[K]): () => void;
  provide(name: string, value: unknown): () => void;
  /**
   * 取一個**必須在**的服務。硬相依，對應 dsh 的 `inject`。
   * @param name - 服務名。
   * @returns 服務物件。
   * @throws 沒有人提供這個名字——訊息指名缺哪一個，在 `apply` 裡時連帶指名是誰要的。
   */
  use<K extends KnownServiceName>(name: K): NexusServices[K];
  use<T = unknown>(name: string): T;
  /**
   * 取一個**可以不在**的服務。軟相依，對應 dsh 的 `ctx.get('sandboxPolicy')`
   * （`references/deepseek-harness/packages/shell/tool-bash/src/index.ts:193`）。
   * @param name - 服務名。
   * @returns 服務物件，或沒人提供時的 `undefined`。
   */
  get<K extends KnownServiceName>(name: K): NexusServices[K] | undefined;
  get<T = unknown>(name: string): T | undefined;
  /**
   * 誰提供了這個服務。缺件診斷與 `requires` 的存在性檢查靠它。
   * @param name - 服務名。
   * @returns 提供者，或沒人提供時的 `undefined`。
   */
  provider(name: string): PluginOrigin | undefined;
  /**
   * 目前被提供的所有服務。
   * @returns 依提供順序的服務名。
   */
  names(): string[];
}

/** `backend` 註冊點：同 `routePrefix` 報錯。 */
export interface BackendRegistrationPoint {
  /**
   * 把一個 backend 掛到某個路徑前綴上。
   * @param routePrefix - 掛載點，必須以 `/` 開頭**且以 `/` 結尾**——基座的
   *   `CompositeBackend.getBackendAndKey()` 直接對前綴做 `startsWith` 與
   *   `slice(0, -1)`，少了尾斜線它會切錯路徑。同時也讓「同一個掛載點」只有一種
   *   寫法，重複偵測才是可靠的。
   * @param backend - backend 實例。
   * @returns 只撤銷這一次掛載的冪等 undo。
   */
  mount(routePrefix: string, backend: AnyBackendProtocol): () => void;
  /**
   * 目前的掛載點。
   * @returns 依掛載順序的前綴與該筆。
   */
  mounts(): [string, NamedEntry<AnyBackendProtocol>][];
}

/**
 * 一次 middleware 註冊：直接給實例，或給一個要 backend 才建得出來的工廠。
 *
 * 兩種**在同一條清單上**，所以註冊順序就是它們之間的順序——分兩條清單的話，
 * 「工廠的排在實例之後」會變成一條沒有人選過的規則。
 */
export type MiddlewareRegistration =
  | {
      readonly middleware: AgentMiddleware;
      readonly build?: undefined;
      /** 是否插到其他 plugin 的 middleware 之前。 */
      readonly prepend: boolean;
    }
  | {
      readonly middleware?: undefined;
      readonly build: (backend: AnyBackendProtocol) => AgentMiddleware;
      /** 是否插到其他 plugin 的 middleware 之前。 */
      readonly prepend: boolean;
    };

/** `middleware` 註冊點：清單順序，`prepend` 為唯一例外閥。 */
export interface MiddlewareRegistrationPoint {
  /**
   * 追加一個 middleware。
   * @param middleware - middleware 實例。
   * @param options - `prepend: true` 把它排到其他 plugin 的 middleware 之前。
   *   注意射程只到 plugin 之間——基座的標準 middleware stack 永遠在前面，
   *   `createDeepAgent` 的 `middleware` 參數整組接在它後面。
   *
   * **這一份實例會掛在 root 與每個子代理上**（[#327](https://github.com/DemianLi/nexus-agent/issues/327)，照 dsh
   * 子代理併入父代理同一份組合）。所以逐 agent 的狀態不能放在閉包裡：要從這一次呼叫的身分查
   * （`sessions.forCall`；`wrapModelCall` 與 `wrapToolCall` 拿到的是 `request.runtime.configurable`，包回
   * `{ configurable }` 再問）。放在閉包裡的話 root 與子代理會靜靜串台，**沒有絆索擋得住**——這是登記過的偏離，
   * 理由見 `fold.ts` 的 `foldSubAgents`。真的需要逐個建的，開卡加工廠。**唯一的例外**是名字撞上摘要器的那一顆：
   * 它只到 root，子代理照舊用 fold 逐個建的那份（`fold.ts` 的 `subagentPluginMiddleware`）。
   * @returns 只撤銷這一次註冊的冪等 undo。
   */
  use(middleware: AgentMiddleware, options?: { prepend?: boolean }): () => void;
  /**
   * 追加一個**要 backend 才建得出來**的 middleware（[#388](https://github.com/DemianLi/nexus-agent/issues/388)）。
   *
   * plugin 的 `apply` 看不到那個 backend：`backend.mount()` 掛的是路由分支，兜底的那個是組裝點
   * 自己的一格，而且要等 {@link foldRegistry} 把兩者折起來才算得出來（`fold.ts` 的 `foldBackend`）。
   * 所以要讀工作區檔案的 middleware **只能由 fold 建**——摘要器與「先讀後改」策略走的是同一條路，
   * 差別只在它們是組裝點自有的東西，這一條是 plugin 的。
   *
   * **一次組裝只建一次**，建出來的那一份走遍 root 與每個子代理，與 {@link use} 同一條契約
   * ——逐 agent 的狀態不能放在閉包裡。
   *
   * **這次組裝一個 backend 都沒有時，工廠一次都不會被呼叫**，等於沒註冊過。要讀檔的東西沒有檔案
   * 系統可讀，唯一誠實的結果就是什麼都不做（dsh 的 `agent-instructions` 在 `ctx.get('fs')` 拿不到
   * 提供方時同樣直接返回）。
   *
   * @param build - 拿折出來的 backend，回一份 middleware。
   * @param options - 同 {@link use}。
   * @returns 只撤銷這一次註冊的冪等 undo。
   */
  useWithBackend(
    build: (backend: AnyBackendProtocol) => AgentMiddleware,
    options?: { prepend?: boolean },
  ): () => void;
  /**
   * 目前註冊的 middleware。
   * @returns 依註冊順序的每一筆，`prepend` 的分區留給 fold 處理。
   */
  list(): NamedEntry<MiddlewareRegistration>[];
}

/** 一條 deny 規則。 */
export interface DenyRule {
  /** 被擋住的 glob 路徑。 */
  readonly paths: readonly string[];
  /** 這條 deny 自己挖的洞。 */
  readonly except: readonly string[];
}

/** `permissions` 註冊點：deny-only。 */
export interface PermissionRegistrationPoint {
  /**
   * 擋掉一組路徑的讀寫。
   * @param paths - 絕對 glob 路徑。合法性由基座的
   *   `createFilesystemMiddleware()` 驗，這裡不驗第二次。
   * @param options - `except` 是這條 deny 自己挖的洞。
   * @returns 只撤銷這一條規則的冪等 undo。
   */
  deny(paths: readonly string[], options?: { except?: readonly string[] }): () => void;
  /**
   * 目前的 deny 規則。
   * @returns 依註冊順序的每一條。
   */
  rules(): NamedEntry<DenyRule>[];
}

/**
 * `approvals` 註冊點：一條 pre-execute waterfall。
 *
 * **這取代了 `interrupts.require(toolName, ...)`。** 舊的是宣告式的——註冊一份工具名
 * 清單，執行時由基座拿 `toolCall.name` 查表，查不到就 auto-approve，所以一個打錯字的
 * 閘門會靜靜地什麼都不擋。新的是 listener 拿活的那一次呼叫自己判斷，**名字不是宣告
 * 出來的，那個 bug class 不存在**。形狀與決議見 {@link ./approval.ts} 與
 * [#111](https://github.com/DemianLi/nexus-agent/issues/111)。
 *
 * 順帶不見的兩件（都是機制換掉的直接後果，不是這裡另外修的）：
 *
 * - **`context: { interruptOn: {} }` 那條繞道**。基座把 `interruptOn` 放在 HITL
 *   middleware 的 `contextSchema` 裡、執行期取 `{ ...options, ...runtime.context }`
 *   （`hitl.js:421`），呼叫端一句 context 就把所有閘門整組換掉。我們不再用
 *   `interruptOn`，那個蓋法沒有東西可蓋。
 * - **一批裡有人被拒、被核准的那些靜靜消失**（`hitl.js:483-496`）。閘門改成逐次呼叫
 *   各自判斷，沒有「一批」這個單位了。
 */
export interface ApprovalRegistrationPoint {
  /**
   * 掛一位 pre-execute listener。
   *
   * 依註冊順序跑，`next()` 委派給下一位，鏈底是 allow。**不呼叫 `next()` 就是把後面的
   * 人短路掉**，那是 waterfall 刻意提供的能力。
   *
   * @param listener - 拿到活的那一次呼叫，回 allow / deny / ask。
   * @returns 只撤銷這一次掛載的冪等 undo。
   */
  gate(listener: PreToolListener): () => void;
  /**
   * 目前掛著的 listener。
   * @returns 依註冊順序的每一位。
   */
  listeners(): NamedEntry<PreToolListener>[];
}

/** `skills` 註冊點：同一來源路徑重複註冊報錯，路徑格式也這裡驗。 */
export interface SkillSourceRegistrationPoint {
  /**
   * 加一個 skill 來源路徑。
   *
   * **路徑格式當場擋**——理由見 {@link assertLoadableSkillsPath}。與 memory 那條的
   * 差別在結尾斜線：skill 來源**是目錄**，結尾斜線合法。
   * @param path - backend 命名空間下的絕對目錄路徑。
   * @returns 只撤銷這一次註冊的冪等 undo。
   * @throws 路徑以 `~` 開頭、不是絕對路徑、含 `.` / `..` / 空路段、或含 `\`。
   */
  addSource(path: string): () => void;
  /**
   * 目前的來源路徑。
   * @returns 依註冊順序的路徑。
   */
  sources(): string[];
}

/** `memory` 註冊點：純累加，但路徑格式這裡驗。 */
export interface MemorySourceRegistrationPoint {
  /**
   * 加一個 memory 來源路徑（AGENTS.md）。重複路徑不報錯——併入 prompt 的規則是
   * 基座的事，這裡只負責把清單交出去。
   *
   * **路徑格式是例外，這裡當場擋**——理由見 {@link assertLoadableMemoryPath}。
   * @param path - backend 命名空間下的絕對路徑。
   * @returns 只撤銷這一次註冊的冪等 undo。
   * @throws 路徑不是絕對路徑、含 `..`、或以 `~` 開頭。
   */
  addSource(path: string): () => void;
  /**
   * 目前的來源路徑。
   * @returns 依註冊順序的路徑。
   */
  sources(): string[];
}

/** 一次關機清理。回 promise 就會被等到。 */
export type Disposer = () => void | Promise<void>;

/**
 * `lifecycle` 通道：登記關機時要收掉的東西。
 *
 * **它與九個註冊點不同軸。** 九個註冊點的東西會折進 `createDeepAgent` 的參數，這條
 * 不會——它的產物是 `loadPlugins()` 回傳的 `dispose()`，由組裝點在不用這個 agent 之後
 * 呼叫。第一個需要它的是 `@nexus/plugin-mcp`：MCP server 是外部程序，stdio 子行程的
 * pipe 是活的 handle，沒人關的話 CLI 印完答案不會退出。
 *
 * **與 dsh 的偏離**（AGENTS.md 的偏離規則）：dsh 的 `ctx.effect` 一個函式同時是「回滾」
 * 與「卸載」，因為 Cordis 的 context 一收掉兩件事本來就同時發生。我們沒有 context 樹，
 * `apply` 拋錯時的回滾走的是 {@link ./load.ts} 的 undo 堆疊，而堆疊是同步的、
 * 關機清理不是。所以退到最接近的實作：**兩條路分開**——回滾期的資源釋放由 plugin 自己
 * 的 `try` / `catch` 負責（它才知道自己開了什麼、開到哪一步），這條通道只管關機。
 */
export interface LifecycleRegistrationPoint {
  /**
   * 登記一個關機時要跑的清理。
   * @param dispose - 清理函式。async 的會被等到。
   * @returns 只撤銷這一次登記的冪等 undo（撤掉之後關機不會跑它）。
   */
  onDispose(dispose: Disposer): () => void;
  /**
   * 目前登記的清理，不取走。診斷與測試用。
   * @returns 依登記順序的每一筆。
   */
  disposers(): NamedEntry<Disposer>[];
  /**
   * 取走目前登記的清理——回傳它們，並把登記清空。
   *
   * 關機走的是這條而不是 {@link disposers}：取走就是冪等的來源，`dispose()` 呼叫第二次
   * 自然是 no-op，不必另外記一個旗標，也不會有「跑到一半又被人呼叫一次」的重複清理。
   *
   * @returns 依登記順序的每一筆。
   */
  takeDisposers(): NamedEntry<Disposer>[];
}

/**
 * `telemetry` 通道：**送出去之前**的脫敏規則。
 *
 * **後端本身不在這裡**（[#477](https://github.com/DemianLi/nexus-agent/issues/477)）：它走
 * {@link ServiceRegistrationPoint}，名字是 {@link ./session-telemetry.ts | SESSION_TELEMETRY_SERVICE}。
 * 分成兩個通道不是我們的口味，**是 dsh 自己的形狀**——它把後端掛在 `interface Context`
 * （`ctx.sessionTelemetry`），把脫敏掛在 `interface Events` 的 waterfall
 * （`references/deepseek-harness/packages/session/session-telemetry/src/index.ts:19-40`，SHA `6b1808f`）。
 * 兩個不同的軸，收成一格反而是偏離。
 *
 * **它與九個註冊點不同軸**，理由跟 lifecycle 一樣：產物不進 `createDeepAgent` 的參數。
 * 遙測是會話事件的第二個出口，走的不是 agent 那條線。
 *
 * **`WIRE_CHANNELS` 那份下行白名單擋不到這條路。** 那是 web 傳輸的邊界，遙測是另一個
 * 出口——脫敏規則要自己長一份，不能靠 wire 那份代勞。
 *
 * **與 dsh 的偏離**（AGENTS.md 的偏離規則）：dsh 的脫敏是 waterfall 事件
 * `session-telemetry/record`，而**我們沒有事件匯流排**——`deepagents` / LangChain JS /
 * LangGraph JS 三者都不提供可掛任意具名事件的 waterfall。退到最接近的：`redact` 用依序
 * 折疊取代 waterfall。折疊丟掉的是「不呼叫 `next()` 就截斷底下所有規則」那個能力，**刻意
 * 丟的**——理由見 {@link ./session-telemetry.ts | SessionTelemetryRedactRule}。
 *
 * （後端那一半原本也在這裡，配一張只收一個的具名表，登記的理由是「我們沒有 service
 * 註冊」。[#459](https://github.com/DemianLi/nexus-agent/issues/459) 落地之後那個前提沒了，
 * 所以那條偏離連同它的載體一起收掉。）
 */
export interface TelemetryRegistrationPoint {
  /**
   * 掛一條脫敏規則。多條依**註冊順序**折疊：前一條的回傳是後一條的輸入。
   * @param rule - 同步的轉換，拋錯會讓那一筆記錄被扣住（fail-closed）。
   * @returns 只撤銷這一條的冪等 undo。
   */
  redact(rule: SessionTelemetryRedactRule): () => void;
  /**
   * 目前掛著的脫敏規則。協調器每次捕獲都現讀這個。
   * @returns 依註冊順序的每一條，帶著是誰掛的。
   */
  rules(): NamedEntry<SessionTelemetryRedactRule>[];
}

/**
 * `invariants` 通道：各 package 註冊**自己擁有的跨筆關係**的檢查。
 *
 * 註冊表自己一條產品檢查都沒有——這是 dsh 的核心設計，檢查放在擁有者旁邊。
 * 只註冊而沒有人接線時什麼都不會跑；接線在
 * {@link ./invariants.ts | createInvariantRunner}。
 *
 * **與 dsh 的偏離**（AGENTS.md 的偏離規則），四條：
 *
 * 1. **Cordis `ctx.effect` ＋子 fiber** —— dsh 的 `register()` 開一個子
 *    `ctx.plugin(installer)`、await 它的 setup、失敗原子 dispose 並收回保留。
 *    `deepagents` / LangChain JS / LangGraph JS 都沒有 fiber 這個東西，我們每個註冊點
 *    回的是裸 `() => void`。退到：註冊只保留名字，安裝與失敗回滾歸 runner 那一格。
 * 2. **`installer.inject`** —— dsh 用它宣告子 fiber 拿得到哪些服務。我們沒有 service
 *    locator，`PluginRegistry` 是固定的一組註冊點。退到：installer 收一個明確的
 *    {@link InvariantSubject}。
 *
 *    **那個 subject 交出什麼，這一格就是全部的答案**，所以它交出什麼要照 dsh 的答案來。
 *    dsh 的註冊表交給配套入口的是一個乾淨的子 context，一份 session 都不帶；要看得到
 *    session 的配套入口自己 `inject: ['sessions']`，而那樣拿到的 `Session` 寫得動。
 *    也就是說**寫入不是被禁止，是要另外去要**。[#127](https://github.com/DemianLi/nexus-agent/issues/127)
 *    之後我們一樣：subject 上的日誌收窄成
 *    {@link ./session-log.ts | SessionLogView}，要寫的走
 *    {@link ./sessions.ts | registry.sessions}。
 * 3. **一次註冊看所有 session** —— dsh 有 `ctx.sessions.list()` ＋ `session/created`。
 *    **這一條補上了**（[#137](https://github.com/DemianLi/nexus-agent/issues/137)）：
 *    {@link ./session-registry.ts | SessionRegistry} 就是那個服務，`observe()` 就是那兩行。
 *    installer 仍然**每一份會話各跑一次**——那不是退讓，dsh 的配套入口也是每一份 session
 *    各 seed 一次（`packages/core/session/src/invariant.ts:218-220`）。差別只在誰負責掃：
 *    以前是組裝點手接，現在是註冊表。
 * 4. **違規的去處** —— dsh 的 `fail()` 從報告它的 context 拋出去；我們這側日誌會把
 *    listener 的拋錯吞成 warn（#99 刻意的）。退到：runner 擁有訂閱、接住
 *    `InvariantError` 轉給 `onViolation`。**看得見，但否決不了**（[#101](https://github.com/DemianLi/nexus-agent/issues/101) 的決定 b）。
 *
 * schemastery ＋ cordis-loader 的 config 驗證退到工廠函式裡的值檢查，同
 * [#100](https://github.com/DemianLi/nexus-agent/pull/100) 已標註過的那一條。
 */
export interface InvariantRegistrationPoint {
  /**
   * 註冊一個 package 的配套入口。**包名在這裡被保留**，即使之後過濾器讓它不裝——
   * 保留是為了兩個 plugin 不會靜默認領同一個名字。
   * @param packageName - 完整 package 名，表內唯一。
   * @param installer - 裝這個 package 檢查的函式。
   * @returns 只撤銷這一次註冊的冪等 undo。
   */
  register(packageName: string, installer: InvariantInstaller): () => void;
  /**
   * 目前註冊著的配套入口。接線那一層讀它。
   * @returns 依註冊順序的每一筆，帶著包名與是誰註冊的。
   */
  companions(): InvariantCompanion[];
}

/**
 * `commands` 通道：**人打的斜線命令**。
 *
 * **它與九個註冊點不同軸**，理由同 lifecycle 與 telemetry：產物不進 `createDeepAgent`
 * 的參數。命令由進入點發派，不經過模型——`@nexus/plugin-commands` 的執行器讀這裡。
 *
 * **形狀差異，不是偏離**（AGENTS.md 的偏離規則只蓋「基座表達不出來」，這兩條不是）：
 *
 * 1. dsh 的命令面是 Cordis 的**可選服務**——`packages/plan/plan-mode/src/index.ts` 用
 *    `ctx.inject(['commands'], …)` 掛子節點，「命令註冊表被組進來時才啟用」。我們的
 *    `PluginRegistry` 是固定介面，每個註冊點永遠都在。**代價是零**：不存在「命令面
 *    缺席」的組裝。
 * 2. dsh 有 `ScopedLayers` / `view(agent)`，全域註冊被 per-agent 註冊遮蔽。我們一次
 *    `createNexusAgent` 一個 registry，**遮蔽沒有指涉對象**。寫在這裡是為了後面的人
 *    不要「還原」它。
 */
export interface CommandRegistrationPoint {
  /**
   * 註冊一個命令。中繼資料在這裡就驗（見 {@link normalizeCommandDefinition}）。
   * @param definition - 命令名、描述、可選的輸入提示與 handler。
   * @returns 只撤銷這一次註冊的冪等 undo。
   * @throws 名字重複，或中繼資料不合格。
   */
  register(definition: CommandDefinition): () => void;
  /**
   * 探索清單，**依名字排序**、不帶 handler。
   * @returns 凍過的 descriptor。
   */
  list(): readonly CommandDescriptor[];
  /**
   * 解析一個命令名。
   * @param name - 不帶斜線的命令名。
   * @returns 那一筆定義，沒有時是 `undefined`。
   */
  find(name: string): CommandDefinition | undefined;
}

/**
 * `sessions` 通道：**誰拿得到這個會話的日誌**。
 *
 * 與另外十三個不同軸的理由同 lifecycle 與 telemetry：產物不進 `createDeepAgent` 的參數。
 * 接線在組裝點（`apps/harness/src/agent-factory.ts` 的 `attachSession`），而且**每一份
 * 日誌各接一次**——CLI 一份、web 那條每個 thread 一份。
 *
 * **交出去的日誌是可寫的**，理由與否掉沿用 `invariants` 的兩條見
 * {@link ./sessions.ts | SessionSubject}。
 *
 * **不具名，同 `approvals` 與 `middleware`。** `invariants` 那條路保留包名是因為包名會
 * 出現在每一則違規訊息裡；這裡沒有那種訊息，強加一條「一個包名一位」的唯一性規則會擋
 * 掉一個合法的組裝（同一個 plugin 掛兩次，各自參與），而換不到任何診斷。註冊者的身分
 * 照樣記著——`origin` 在，安裝失敗指得出是誰。
 */
export interface SessionRegistrationPoint {
  /**
   * 掛一位參與者。**只註冊，不安裝**——安裝是接線那一層的事，而且一份會話一次。
   *
   * @param installer - 拿到日誌與觀察面，回一個收拾函式或什麼都不回。
   * @returns 只撤銷這一次掛載的冪等 undo。
   */
  join(installer: SessionInstaller): () => void;
  /**
   * 目前掛著的參與者。接線那一層讀它。
   * @returns 依註冊順序的每一位。
   */
  installers(): NamedEntry<SessionInstaller>[];
  /**
   * **模型工具問「我這次呼叫該寫進哪一份日誌」的地方。**
   *
   * 這是 dsh 的 `exec.agent.session` 在我們這裡的對應物。它那側由 agent loop 派發工具時
   * 塞進來（`packages/core/agent-loop/src/tool-calls.ts:78`），我們的派發點是 LangGraph 的
   * ToolNode，插不進去，所以身分從 config 推出來——見
   * {@link ./session-address.ts | toolCallSessionAddress}。
   *
   * **找不到的時候分三種，而且刻意不合成一種。** 三種都要工具說得出口，但說的不是同一
   * 句話：「這次組裝沒接上會話」是組裝點漏了一步，「認不出這次呼叫」是這顆工具不在圖裡
   * 跑，「不只一張註冊表」是同一次組裝被兩條 thread 共用。併成一個 `undefined` 的話，
   * 後兩種都會被讀成第一種，然後沒有人去看真正的原因。
   *
   * @param config - 工具 handler 的第二個參數。
   * @returns 判別得出來的四種結果之一。
   */
  forCall(config: unknown): SessionLookup;
  /**
   * 把一張會話註冊表綁上來。**組裝點的一步，不是 plugin 的**。
   *
   * **綁第二張不拋。** 「剛好一份」是一個假設而不是一條保證——`attachSession` 是組裝點
   * 自己呼叫的一步，沒有東西攔得住它被呼叫兩次，而 `serve.ts` 那種一次組裝配多條 thread
   * 的用法會真的走到。照 `@nexus/plugin-goal` 對同一件事的做法（`goalAmbiguousMessage`）：
   * **多了或少了都由呼叫當場說出來**，不在接線的時候拋。這裡拋的話，倒下的是一個
   * HTTP 請求，而真正的問題（`forCall` 挑不出來）根本還沒發生。
   *
   * @param sessions - 要綁的註冊表。
   * @returns 只解綁這一次的冪等函式。
   */
  bind(sessions: SessionRegistry): () => void;
}

/**
 * {@link SessionRegistrationPoint.forCall} 的三種結果。
 *
 * **判別式有目的地**：三格各自對到工具要回給模型的一句話，不是「認出來就好」。
 */
export type SessionLookup =
  /** 找到了。 */
  | { readonly kind: 'ok'; readonly address: SessionAddress; readonly log: SessionLog }
  /** 這次組裝沒有接上會話註冊表——組裝點漏了 `attachSession`。 */
  | { readonly kind: 'not-attached' }
  /** 認不出這次呼叫屬於誰（沒有 `checkpoint_ns`）。**不猜成 root**，理由見 session-address。 */
  | { readonly kind: 'unknown-caller' }
  /**
   * 這次組裝綁著不只一張註冊表，挑不出來。
   *
   * 一次組裝配多條 thread 時會走到（每條 thread 一張）。`checkpoint_ns` 分得出 root 與
   * 每一次 spawn，**但分不出 thread**——`thread_id` 才分得出，而那要另一條路。挑一張猜
   * 的話，一條 thread 的工具會寫進另一條 thread 的日誌，那是這條路上最貴的那種靜默錯。
   */
  | { readonly kind: 'ambiguous'; readonly count: number };

/**
 * 清單上**明著被關掉**的那些條目（`disabled: true`）。**不是註冊點**——沒有人往裡面
 * 註冊東西，它是「產生這個 registry 的那份清單說了什麼」的一個唯讀視圖。
 *
 * 它回答折疊那側問不出來的一個問題：**「這一顆沒有提供服務」有兩種成因**——條目被關掉了，
 * 或者這次組裝根本沒有經過部署設定層（低層嵌入方與測試手搭清單，見
 * [#455](https://github.com/DemianLi/nexus-agent/issues/455)）。兩者的正確答案相反：前者
 * 要真的不掛，後者要維持內建預設。少了這個視圖，兩者在 `services.get()` 眼中一模一樣。
 *
 * **dsh 沒有這第三態，所以這是登記過的偏離**
 * （[#456](https://github.com/DemianLi/nexus-agent/issues/456)）：它的 `boot()` 只有一個
 * 來源——設定樹，條目不在就是不掛（`fs-observation-policy` 的檔頭逐字：“Without this
 * plugin, tools retain the bare provider's unconditional mutation behavior”）。我們的
 * {@link ./fold.ts | foldRegistry} 同時是公開的程式介面而且帶內建預設，於是多出一態。
 */
export interface DisabledEntryView {
  /**
   * 這個 plugin 名有沒有出現在某個明著被關掉的條目上。
   *
   * **比對的是 {@link ../plugin.ts | NexusPlugin.name} 而不是條目的 id**：id 是使用者的
   * patch 改得動的字串，拿它當行為開關等於讓改名變成關功能。
   *
   * @param pluginName - 那顆 plugin 的 `name`。
   */
  has(pluginName: string): boolean;
  /** 全部，依清單順序；同一顆掛載多次又都被關掉時會出現重複。 */
  names(): readonly string[];
}

export interface PluginRegistry {
  readonly tools: ToolRegistrationPoint;
  readonly subagents: SubAgentRegistrationPoint;
  readonly capabilities: CapabilityRegistrationPoint;
  readonly services: ServiceRegistrationPoint;
  readonly backend: BackendRegistrationPoint;
  readonly middleware: MiddlewareRegistrationPoint;
  readonly permissions: PermissionRegistrationPoint;
  readonly approvals: ApprovalRegistrationPoint;
  readonly skills: SkillSourceRegistrationPoint;
  readonly memory: MemorySourceRegistrationPoint;
  readonly lifecycle: LifecycleRegistrationPoint;
  readonly telemetry: TelemetryRegistrationPoint;
  readonly invariants: InvariantRegistrationPoint;
  readonly commands: CommandRegistrationPoint;
  readonly sessions: SessionRegistrationPoint;
  /** 清單上明著被關掉的條目，見 {@link DisabledEntryView}。**不算註冊點。** */
  readonly disabledEntries: DisabledEntryView;
}

/**
 * registry 的內部形狀：多了一個「現在是誰在註冊」的游標。
 *
 * 註冊必須發生在某個 plugin 的 `apply` 之內——沒有 origin 就沒有辦法在重名時
 * 指名是誰，而指名是這些錯誤訊息唯一的價值。
 */
export interface InternalPluginRegistry extends PluginRegistry {
  /**
   * 把游標指向某個 plugin，回傳把它放掉的函式。
   * @param origin - 接下來的註冊要記在誰頭上。
   * @returns 清掉游標的函式。
   */
  enter(origin: PluginOrigin): () => void;
  /**
   * 記下清單上明著被關掉的一個條目。
   *
   * **只有 {@link ./load.ts | loadPlugins} 叫得到它**，因為只有它看得見 `disabled`；
   * plugin 的 `apply` 拿到的是窄的 {@link PluginRegistry}，碰不到這個方法。
   *
   * @param pluginName - 被跳過的那顆 plugin 的 `name`。
   */
  markDisabled(pluginName: string): void;
}

function duplicateToolError(scope: ScopeKey | undefined) {
  return (name: string, existing: PluginOrigin, incoming: PluginOrigin): Error => {
    const where = scope === undefined ? '全域' : `subagent "${scope}"`;
    return new Error(
      `${where}已經有名為 "${name}" 的工具：${formatOrigin(existing)} 註冊過，` +
        `${formatOrigin(incoming)} 又註冊一次。` +
        `同名工具要嘛換名字，要嘛其中一個改註冊到某個 subagent 層（跨層是遮蔽，不是衝突）。`,
    );
  };
}

/**
 * 建一個空的 registry。
 * @returns 尚未進入任何 plugin 的 registry。
 */
export function createRegistry(): InternalPluginRegistry {
  const globalLayer: Layer = { tools: new NamedEntries(duplicateToolError(undefined)) };
  const scopedLayers = new Map<ScopeKey, Layer>();
  const subagents = new NamedEntries<SubAgent>(
    (name, existing, incoming) =>
      new Error(
        `已經有名為 "${name}" 的 subagent：${formatOrigin(existing)} 註冊過，` +
          `${formatOrigin(incoming)} 又註冊一次。subagent 只有全域一層，沒有遮蔽可用。`,
      ),
  );
  const capabilities = new CapabilitySet();
  const serviceEntries = new NamedEntries<unknown>(
    (name, existing, incoming) =>
      new Error(
        `服務 "${name}" 已經有人提供了：${formatOrigin(existing)} 提供過，` +
          `${formatOrigin(incoming)} 又提供一次。服務是單一佔位——` +
          `讓後來的蓋掉前面的，等於消費者拿到誰由載入順序決定。`,
      ),
  );
  const backends = new NamedEntries<AnyBackendProtocol>(
    (routePrefix, existing, incoming) =>
      new Error(
        `掛載點 "${routePrefix}" 已經有 backend 了：${formatOrigin(existing)} 掛過，` +
          `${formatOrigin(incoming)} 又掛一次。一個路徑前綴只能路由到一個 backend。`,
      ),
  );
  const skillSources = new NamedEntries<string>(
    (path, existing, incoming) =>
      new Error(
        `skill 來源 "${path}" 已經註冊過了：${formatOrigin(existing)} 加過，` +
          `${formatOrigin(incoming)} 又加一次。同一個目錄載兩次只會讓同名 skill 自己覆蓋自己。`,
      ),
  );
  const middlewares = new AnonymousEntries<MiddlewareRegistration>();
  const denyRules = new AnonymousEntries<DenyRule>();
  const approvalListeners = new AnonymousEntries<PreToolListener>();
  const memorySources = new AnonymousEntries<string>();
  const sessionInstallers = new AnonymousEntries<SessionInstaller>();
  const disposers = new AnonymousEntries<Disposer>();
  const redactRules = new AnonymousEntries<SessionTelemetryRedactRule>();
  const companions = new NamedEntries<InvariantInstaller>(duplicateCompanionError);
  const commandEntries = new NamedEntries<{
    definition: CommandDefinition;
    descriptor: CommandDescriptor;
  }>(
    (name, existing, incoming) =>
      new Error(
        `命令 "/${name}" 已經註冊過了：${formatOrigin(existing)} 註冊過，` +
          `${formatOrigin(incoming)} 又註冊一次。一個名字只能有一個 handler——` +
          `讓後來的靜靜蓋掉前面的，等於使用者打的那一行意思會隨載入順序改變。`,
      ),
  );

  let current: PluginOrigin | undefined;
  function requireOrigin(what: string): PluginOrigin {
    if (current === undefined) {
      throw new Error(`${what}只能在 plugin 的 apply 裡呼叫——registry 之外沒有註冊者可以指名。`);
    }
    return current;
  }

  function layerFor(scope: ScopeKey | undefined): Layer {
    if (scope === undefined) return globalLayer;
    const existing = scopedLayers.get(scope);
    if (existing !== undefined) return existing;
    const created: Layer = { tools: new NamedEntries(duplicateToolError(scope)) };
    scopedLayers.set(scope, created);
    return created;
  }

  // 身分為鍵而不是名字：`NamedEntries` 的 undo 就是靠身分比對才不會誤刪後來占用同名
  // 的別人，這一格若以名字為鍵就會漏掉那個保護——撤銷過的 root-only 註冊會把旗標留在
  // 名字上，蓋到下一個同名工具身上。
  // 值是那一次註冊自己帶的拒絕句與碼；只給 `true` 的是 `undefined`。
  const rootOnlyTools = new Map<StructuredTool, RootOnlyRefusal | undefined>();
  // 同一條理由：以身分為鍵，撤銷時跟著刪。
  const outputSchemas = new Map<StructuredTool, ZodType>();

  const tools: ToolRegistrationPoint = {
    register(tool, options) {
      const origin = requireOrigin('tools.register()');
      const scope = options?.scope;
      // 物件形式也是 root-only：三處判斷都讀這一格，不各自比 `=== true`。
      const rootOnly = options?.rootOnly === true || typeof options?.rootOnly === 'object';
      if (rootOnly && scope !== undefined) {
        throw new Error(
          `${formatOrigin(origin)} 把 "${tool.name}" 註冊到 subagent "${scope}" 的同時要求 rootOnly。` +
            `這兩個是矛盾的：rootOnly 的意思就是 subagent 不給用，往 subagent 層掛它沒有意義。` +
            `要嘛拿掉 scope，要嘛拿掉 rootOnly。`,
        );
      }
      const layer = layerFor(scope);
      const undo = layer.tools.insert(tool.name, tool, origin);
      if (rootOnly) {
        rootOnlyTools.set(
          tool,
          typeof options?.rootOnly === 'object' ? options.rootOnly : undefined,
        );
      }
      if (options?.outputSchema !== undefined) outputSchemas.set(tool, options.outputSchema);
      return () => {
        undo();
        rootOnlyTools.delete(tool);
        outputSchemas.delete(tool);
        // 空層不留下來：層是註冊行為的產物，`scopes()` 是 fold 的輸入，回滾過的
        // plugin 不該讓 fold 看到一個它其實沒碰過的 subagent 名。
        if (scope !== undefined && layer.tools.size === 0 && scopedLayers.get(scope) === layer) {
          scopedLayers.delete(scope);
        }
      };
    },
    resolve(name, scope) {
      if (scope !== undefined) {
        const scoped = scopedLayers.get(scope)?.tools.get(name);
        if (scoped !== undefined) return scoped;
      }
      return globalLayer.tools.get(name);
    },
    effective(scope) {
      const merged = new Map(globalLayer.tools.entries());
      if (scope !== undefined) {
        const layer = scopedLayers.get(scope);
        if (layer !== undefined) {
          for (const [name, entry] of layer.tools.entries()) merged.set(name, entry);
        }
      }
      return merged;
    },
    own(scope) {
      const layer = scopedLayers.get(scope);
      return layer === undefined ? new Map() : new Map(layer.tools.entries());
    },
    scopes() {
      return [...scopedLayers.keys()];
    },
    isRootOnly(name) {
      const entry = globalLayer.tools.get(name);
      return entry !== undefined && rootOnlyTools.has(entry.value);
    },
    rootOnlyRefusalOf(name) {
      const entry = globalLayer.tools.get(name);
      return entry === undefined ? undefined : rootOnlyTools.get(entry.value);
    },
    outputSchemaOf(tool) {
      return outputSchemas.get(tool as StructuredTool);
    },
  };

  const subagentPoint: SubAgentRegistrationPoint = {
    register(subagent) {
      const origin = requireOrigin('subagents.register()');
      return subagents.insert(subagent.name, subagent, origin);
    },
    get: (name) => subagents.get(name),
    entries: () => subagents.entries(),
  };

  const capabilityPoint: CapabilityRegistrationPoint = {
    provide(name) {
      const origin = requireOrigin('capabilities.provide()');
      return capabilities.provide(name, origin);
    },
    has: (name) => capabilities.has(name),
    providers: (name) => capabilities.providers(name),
    names: () => capabilities.names(),
  };

  const servicePoint: ServiceRegistrationPoint = {
    provide(name: string, value: unknown) {
      const origin = requireOrigin('services.provide()');
      return serviceEntries.insert(name, value, origin);
    },
    use(name: string) {
      const entry = serviceEntries.get(name);
      if (entry === undefined) throw missingServiceError(name);
      return entry.value as never;
    },
    get(name: string) {
      return serviceEntries.get(name)?.value as never;
    },
    provider: (name) => serviceEntries.get(name)?.origin,
    names: () => [...serviceEntries.entries()].map(([name]) => name),
  };

  /**
   * 缺件的錯誤訊息。**兩種呼叫端要講兩句不一樣的話**：在某個 `apply` 裡缺件時，
   * 「誰要的」就是那個 plugin，要修的是清單；在載入之外缺件時，問的人是組裝點自己，
   * 那句話只能講「沒有人提供」。把「誰要的」寫成一個有時候是空的子句，空的那次會
   * 讀起來像 bug。
   */
  function missingServiceError(name: string): Error {
    const available = [...serviceEntries.entries()].map(([serviceName]) => serviceName);
    const known = available.length === 0 ? '（這個組裝一個服務都沒有）' : available.join('、');
    if (current === undefined) {
      return new Error(`沒有人提供服務 "${name}"。目前被提供的服務：${known}。`);
    }
    return new Error(
      `${formatOrigin(current)} 要服務 "${name}"，但沒有人提供它。` +
        `目前被提供的服務：${known}。提供者要排在消費者前面——` +
        `載入是一趟到底的，不會回頭等。`,
    );
  }

  const backendPoint: BackendRegistrationPoint = {
    mount(routePrefix, backend) {
      const origin = requireOrigin('backend.mount()');
      if (!routePrefix.startsWith('/') || !routePrefix.endsWith('/')) {
        throw new Error(
          `${formatOrigin(origin)} 掛的 routePrefix "${routePrefix}" 不合法：` +
            `必須以 "/" 開頭且以 "/" 結尾（例如 "/memories/"）。` +
            `基座的 CompositeBackend 直接對前綴做字串切割，少了尾斜線會切錯路徑。`,
        );
      }
      return backends.insert(routePrefix, backend, origin);
    },
    mounts: () => [...backends.entries()],
  };

  const middlewarePoint: MiddlewareRegistrationPoint = {
    use(middleware, options) {
      const origin = requireOrigin('middleware.use()');
      return middlewares.append({ middleware, prepend: options?.prepend === true }, origin);
    },
    useWithBackend(build, options) {
      const origin = requireOrigin('middleware.useWithBackend()');
      return middlewares.append({ build, prepend: options?.prepend === true }, origin);
    },
    list: () => [...middlewares.entries()],
  };

  const permissionPoint: PermissionRegistrationPoint = {
    deny(paths, options) {
      const origin = requireOrigin('permissions.deny()');
      return denyRules.append({ paths: [...paths], except: [...(options?.except ?? [])] }, origin);
    },
    rules: () => [...denyRules.entries()],
  };

  const approvalPoint: ApprovalRegistrationPoint = {
    gate(listener) {
      const origin = requireOrigin('approvals.gate()');
      return approvalListeners.append(listener, origin);
    },
    listeners: () => [...approvalListeners.entries()],
  };

  const skillPoint: SkillSourceRegistrationPoint = {
    addSource(path) {
      const origin = requireOrigin('skills.addSource()');
      // key 用正規化後的，value 留原文——`/skills/` 與 `/skills` 是同一個目錄，
      // 但交給基座的要是 plugin 真正寫下的那一串。
      const normalized = assertLoadableSkillsPath(path, origin);
      return skillSources.insert(normalized, path, origin);
    },
    sources: () => [...skillSources.entries()].map(([, entry]) => entry.value),
  };

  const memoryPoint: MemorySourceRegistrationPoint = {
    addSource(path) {
      const origin = requireOrigin('memory.addSource()');
      assertLoadableMemoryPath(path, origin);
      return memorySources.append(path, origin);
    },
    sources: () => [...memorySources.entries()].map((entry) => entry.value),
  };

  const telemetryPoint: TelemetryRegistrationPoint = {
    redact(rule) {
      const origin = requireOrigin('telemetry.redact()');
      return redactRules.append(rule, origin);
    },
    rules: () => [...redactRules.entries()],
  };

  const invariantPoint: InvariantRegistrationPoint = {
    register(packageName, installer) {
      const origin = requireOrigin('invariants.register()');
      if (packageName.length === 0 || packageName.trim() !== packageName) {
        throw new Error(`${formatOrigin(origin)} 註冊的不變量包名不能是空的、也不能帶前後空白。`);
      }
      return companions.insert(packageName, installer, origin);
    },
    companions: () =>
      [...companions.entries()].map(([packageName, entry]) => ({
        packageName,
        installer: entry.value,
        origin: entry.origin,
      })),
  };

  const commandPoint: CommandRegistrationPoint = {
    register(definition) {
      const origin = requireOrigin('commands.register()');
      const normalized = normalizeCommandDefinition(definition);
      return commandEntries.insert(normalized.definition.name, normalized, origin);
    },
    list: () =>
      Object.freeze(
        [...commandEntries.entries()]
          .map(([, entry]) => entry.value.descriptor)
          // 名字在表裡唯一，所以不會有相等的一對。
          .sort((left, right) => (left.name < right.name ? -1 : 1)),
      ),
    find: (name) => commandEntries.get(name)?.value.definition,
  };

  // 插入序，而且**允許多於一張**——理由見 `SessionRegistrationPoint.bind`。
  const boundSessions = new Set<SessionRegistry>();
  const sessionPoint: SessionRegistrationPoint = {
    join(installer) {
      const origin = requireOrigin('sessions.join()');
      return sessionInstallers.append(installer, origin);
    },
    installers: () => [...sessionInstallers.entries()],
    forCall(config) {
      if (boundSessions.size === 0) return { kind: 'not-attached' };
      if (boundSessions.size > 1) return { kind: 'ambiguous', count: boundSessions.size };
      const address = toolCallSessionAddress(config);
      if (address === undefined) return { kind: 'unknown-caller' };
      const [sessions] = boundSessions;
      // `open` 而不是 `get`：subagent 的日誌在第一次有人要寫的時候才出生，理由見
      // `SessionRegistry` 的偏離第 1 條。訂閱者在這一行之內就裝好了。
      return { kind: 'ok', address, log: sessions!.open(address) };
    },
    bind(sessions) {
      boundSessions.add(sessions);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        boundSessions.delete(sessions);
      };
    },
  };

  const lifecyclePoint: LifecycleRegistrationPoint = {
    onDispose(dispose) {
      const origin = requireOrigin('lifecycle.onDispose()');
      return disposers.append(dispose, origin);
    },
    disposers: () => [...disposers.entries()],
    takeDisposers: () => disposers.drain(),
  };

  /** 明著被關掉的條目留下的唯一痕跡，見 {@link DisabledEntryView}。 */
  const disabledNames: string[] = [];

  return {
    tools,
    subagents: subagentPoint,
    capabilities: capabilityPoint,
    services: servicePoint,
    backend: backendPoint,
    middleware: middlewarePoint,
    permissions: permissionPoint,
    approvals: approvalPoint,
    skills: skillPoint,
    memory: memoryPoint,
    lifecycle: lifecyclePoint,
    telemetry: telemetryPoint,
    invariants: invariantPoint,
    commands: commandPoint,
    sessions: sessionPoint,
    disabledEntries: {
      has: (pluginName) => disabledNames.includes(pluginName),
      names: () => [...disabledNames],
    },
    markDisabled(pluginName) {
      disabledNames.push(pluginName);
    },
    enter(origin) {
      if (current !== undefined) {
        throw new Error(
          `registry 已經在 ${formatOrigin(current)} 裡了——plugin 的 apply 不巢狀執行。`,
        );
      }
      current = origin;
      return () => {
        current = undefined;
      };
    },
  };
}

/**
 * memory 來源必須是 backend 命名空間下的絕對路徑。
 *
 * **這道檢查存在的理由是基座那一側完全沒有。** `createMemoryMiddleware` 的載入迴圈是
 * `try { ... } catch { console.debug(...) }`，而且只在內容為真時才收進來
 * （`if (content) contents[path] = content`）。所以「讀不到」「不存在」「是個空檔」
 * 三者在 prompt 裡塌成同一個 `(No memory loaded)`——**沒有任何東西會紅**，agent 只是
 * 安靜地沒有記憶。而 `memoryContents` 又快取在 state 裡，配上 checkpointer 就是一個
 * thread 只載一次：連「下一輪會不會好」都沒有。
 *
 * 這跟 `permissions.deny()` 刻意**不**驗第二次是相反的情況，不是不一致：那邊基座自己
 * 會拋（`validatePermissionPaths()`），我們再驗只會讓同一個錯誤有兩個出處；這邊基座
 * 什麼都不做，我們不驗就沒有人驗。
 *
 * `~` 是最值得擋的那個：基座 JSDoc 裡那個 `"~/.deepagents/AGENTS.md"` 是**已 deprecated
 * 的 `createAgentMemoryMiddleware`** 留下的，backend-agnostic 這條路上沒有任何一處展開
 * `~`（`os.homedir()` 只出現在 node-only 的 `createSettings`）。照抄那個例子的下場正好
 * 就是上面那種靜默。
 *
 * **偏離 dsh，標註如下。** dsh 的對應機制是 `@deepseek-ai/dsh-agent-instructions`，而它
 * 的設定收的是**檔名候選**（`['AGENTS.md', 'CLAUDE.md']`），`resolveInstructionFileCandidates`
 * 把任何含 `/` 或 `\` 的候選連同 `RESERVED_PATH_SEGMENTS`（`''` / `'.'` / `'..'`）一起
 * **靜默濾掉**——因為路徑走查（往上找 project root）與 `~` / `$DSH_HOME` 的展開都由
 * loader 自己擁有。**這個形狀我們表達不出來**：`deepagents` 的 `memory` 參數收的就是
 * backend 路徑，它的 loader 不做走查也不展開任何東西。退到最接近的：**把 dsh 濾掉的那
 * 三種路段照樣擋下，但改成拋錯而不是靜默濾掉**。靜默濾掉在 dsh 那邊無害（濾完還有其他
 * 候選、還有走查），在這裡則等於把唯一的來源刪掉，正好製造出這道檢查要防的那種靜默。
 *
 * @param path - 註冊進來的來源路徑。
 * @param origin - 註冊者，錯誤訊息要指名是誰寫的。
 * @throws 路徑以 `~` 開頭、不是絕對路徑、或含 `.` / `..` / 空的路段。
 */
function assertLoadableMemoryPath(path: string, origin: PluginOrigin): void {
  const reject = (why: string): never => {
    throw new Error(
      `${formatOrigin(origin)} 註冊的 memory 來源 "${path}" ${why}。` +
        `memory 來源要用 backend 命名空間下的絕對路徑（例如 "/AGENTS.md"）——` +
        `基座把路徑原樣交給 backend，讀不到不會拋錯也不會警告，只會在 prompt 裡` +
        `變成 "(No memory loaded)"。這種路徑寫錯不擋在這裡就永遠不會被發現。`,
    );
  };

  if (path.startsWith('~')) reject('以 "~" 開頭——沒有任何一層會把它展開成家目錄');
  if (!path.startsWith('/')) reject('不是絕對路徑');
  // 首段是前置斜線切出來的空字串，永遠存在，不算數。
  const segments = path.split('/').slice(1);
  if (segments.includes('..')) reject('含 ".." 路段');
  if (segments.includes('.')) reject('含 "." 路段');
  if (segments.includes('')) reject('含空路段（連續斜線或結尾斜線）——記憶來源是檔不是目錄');
}

/**
 * 擋下 backend 載不到的 skill 來源路徑。
 *
 * 與 {@link assertLoadableMemoryPath} 同一個理由、**不同一組規則**，所以是兩個函式而不是
 * 一個帶旗標的：memory 來源**是檔**（那邊明文拒絕結尾斜線），skill 來源**是目錄**，
 * 基座還會自己補上斜線（`listSkillsFromBackend` 的 `normalizedPath`）。把兩者併成一個
 * 函式，遲早會有人把「是檔不是目錄」那句錯誤訊息噴到目錄路徑上。
 *
 * 靜默的形狀也不同，而且比 memory 那邊更難察覺。`listSkillsFromBackend` 對
 * `ls` 失敗是 `return []`、對讀不到 `SKILL.md` 是 `continue`——**兩條都完全無聲**（連
 * `console.debug` 都沒有，那個只包在最外層的 `catch`）。路徑寫錯的下場是 system prompt
 * 裡出現 `(No skills available yet. You can create skills in ...)`，字面上像「這個工作區
 * 還沒有 skill」，實際上是「那個目錄根本不存在」。這兩件事在模型眼裡一模一樣。
 *
 * **`\\` 是刻意收窄的一格。** 基座支援 Windows 分隔（`sourcePath.includes("\\\\")` 決定
 * `pathSep`），這裡直接擋掉。理由是 backend 命名空間不是宿主檔案系統：路徑最後交給
 * 哪個 backend、那個 backend 用什麼分隔，註冊時看不出來，混用只會讓
 * `normalizedPath` 拼出兩種分隔並存的字串。要支援 Windows 宿主路徑是 backend 那一層的事。
 *
 * **對 dsh 的偏離（標註）**：dsh 的 `@deepseek-ai/dsh-skill-filesystem` 收的是
 * `customSkillDirs`——**額外**的根，疊在五個 rank 過的預設根之上（project `.dsh/skills`
 * =100、`.agents/skills`=200、custom=300、user `<dshHome>/skills`=400、
 * `<agentsHome>/skills`=500），project root 由「最近含 `.git` 的祖先」走查決定。
 * **這個形狀我們表達不出來**：`deepagents` 的 `skills` 參數就是一組平等的 backend 路徑，
 * 沒有 rank、沒有走查、沒有 `$DSH_HOME`。退到最接近的：照 `sources` 的有序 last-wins，
 * 把 rank 語意能保留的唯一一格（順序即優先序）寫進 plugin 文件，並在註冊期擋掉
 * dsh 的 `RESERVED_PATH_SEGMENTS`（`''` / `'.'` / `'..'`）那一組路段。
 *
 * @param path - 註冊進來的來源路徑。
 * @param origin - 註冊者，錯誤訊息要指名是誰寫的。
 * @returns 去掉結尾斜線的路徑，給重複檢查當 key 用——`/skills/` 與 `/skills` 是同一個
 *   目錄，載兩次只會讓同名 skill 自己覆蓋自己，那正是重複檢查要擋的事。
 * @throws 路徑以 `~` 開頭、含 `\\`、不是絕對路徑、或含 `.` / `..` / 空的中間路段。
 */
function assertLoadableSkillsPath(path: string, origin: PluginOrigin): string {
  const reject = (why: string): never => {
    throw new Error(
      `${formatOrigin(origin)} 註冊的 skill 來源 "${path}" ${why}。` +
        `skill 來源要用 backend 命名空間下的絕對目錄路徑（例如 "/skills/"）——` +
        `基座把路徑原樣交給 backend，列不到不會拋錯也不會警告，只會在 prompt 裡` +
        `變成 "(No skills available yet...)"，看起來像這裡本來就沒有 skill。`,
    );
  };

  if (path.startsWith('~')) reject('以 "~" 開頭——沒有任何一層會把它展開成家目錄');
  if (path.includes('\\')) reject('含 "\\"——backend 命名空間一律用 "/"');
  if (!path.startsWith('/')) reject('不是絕對路徑');
  // 結尾斜線合法（來源是目錄，基座自己也會補），先剝掉再切；首段的空字串是前置斜線
  // 切出來的，永遠存在，不算數。
  const normalized = path.replace(/\/$/, '');
  const segments = normalized.split('/').slice(1);
  if (segments.includes('..')) reject('含 ".." 路段');
  if (segments.includes('.')) reject('含 "." 路段');
  if (segments.includes('')) reject('含空路段（連續斜線）');
  return normalized;
}
