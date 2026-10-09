/**
 * fold：把載入完的 registry 折成一次 `createDeepAgent(...)` 要的參數。
 *
 * core 是純轉換層——**不呼叫** `createDeepAgent`，只產出參數；那一次呼叫住在
 * `apps/harness`，而且只有那一個地方。組裝點自有的七樣（default backend、工具
 * 呈現順序清單、model、checkpointer / store、核准政策的 session 開關、摘要的門檻與
 * 去向、重複呼叫提醒的門檻與射程）從 {@link FoldOptions} 傳進來：所有權留在 harness，
 * 檢查跑在這裡。
 *
 * 「純轉換層」不代表這裡不建東西：核准閘門、摘要器、提醒器與用量記錄器都是在這裡建的
 * middleware。分界是**不碰基座的建構**（`createDeepAgent`），不是「不 new 任何東西」。
 *
 * 這裡也是幾條後置條件的落點——它們**不能**在註冊當下驗，因為 `requires` 不排序，
 * 清單裡靠前的 plugin 本來就可以往靠後的 plugin 才註冊的 subagent 上加工具。
 * 「全部載完了」這個時刻只有 fold 有。
 */

import { tool as makeTool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { CompositeBackend, GENERAL_PURPOSE_SUBAGENT } from 'deepagents';
import type { AnyBackendProtocol, FilesystemPermission, SubAgent } from 'deepagents';
import { modelCallLimitMiddleware } from 'langchain';
import type { AgentCheckpointer, AgentMiddleware, AgentModel, AgentStore } from './base-types.js';
import type { EventDispatcher } from './events.js';
import { createApprovalGateMiddleware } from './approval.js';
import type { ApprovalPolicySource } from './approval-policy.js';
import {
  createSubagentDelegationMiddleware,
  FOREGROUND_SUBAGENT_DELEGATION_CONTEXT,
} from './subagent-delegation.js';
import {
  assertToolFilter,
  createSubagentToolFilterMiddleware,
  toolKept,
} from './subagent-tool-filter.js';
import type { ToolFilter } from './subagent-tool-filter.js';
import type { ApprovalChannel } from './approval.js';
import { deriveApprovalChannel } from './approval.js';
import { createContainmentMiddleware } from './containment.js';
import { createToolBarrierMiddleware } from './tool-barrier.js';
import { createOutputSchemaMiddleware } from './output-schema.js';
import { createFsToolErrorsMiddleware, recordBackendOutcomes } from './fs-tool-errors.js';
import { FS_SERVICE, settleFsService } from './fs-service.js';
import { createReadContinuationMiddleware, recordReadExtent } from './read-continuation.js';
import { recordToolResultMeta } from './tool-result-meta.js';
import { createInvalidToolArgsMiddleware } from './invalid-tool-args.js';
import { createMaxTokensCarrier, createMaxTokensMiddleware } from './max-tokens.js';
import { createSpillPolicyMiddleware } from './spill-policy.js';
import type { SpillPolicyOptions } from './spill-policy.js';
import { capSearchResults, createSearchOverflowMiddleware } from './search-overflow.js';
import type { SearchOverflowOptions } from './search-overflow.js';
import { createObservationPolicy, OBSERVATION_POLICY_PLUGIN_NAME } from './observation.js';
import type { NamedEntry } from './entries.js';
import { formatOrigin } from './plugin.js';
import type { PluginOrigin } from './plugin.js';
import type {
  MiddlewareRegistration,
  NexusSubAgent,
  PluginRegistry,
  RootOnlyRefusal,
} from './registry.js';
import { createModelCallRecorder } from './model-calls.js';
import { createStreamRetryMiddleware } from './stream-retry.js';
import type { StreamRetryOptions } from './stream-retry.js';
import { createRequestSnapshotRecorder } from './request-snapshot.js';
import { createModelUsageRecorder, MODEL_USAGE_PLUGIN_NAME } from './model-usage.js';
import {
  createSessionCheckpointMiddleware,
  SESSION_CHECKPOINT_PLUGIN_NAME,
} from './session-checkpoint-policy.js';
import type { SessionLog } from './session-log.js';
import { createStepInboxMiddleware } from './step-inbox.js';
import {
  createModelSwapMiddleware,
  createSubagentModelFollowMiddleware,
} from './model-selection.js';
import type { ModelSelectionController } from './model-selection.js';
import { createTurnCancelGuard, createTurnCancelModelSignal } from './turn-cancel.js';
import {
  REPEAT_REMINDER_PLUGIN_NAME,
  REPEAT_REMINDER_SERVICE,
  createRepeatReminder,
  createStepNoticeMiddleware,
  resolveRepeatReminderSettings,
} from './repeat-reminder.js';
import type { RepeatReminderSettings } from './repeat-reminder.js';
import type { ModelContextLimits } from './summarization.js';
import {
  createImageOffloadMiddleware,
  createImageOffloadRecoveryMiddleware,
} from './image-offload.js';
import {
  createSummarizer,
  resolveSummarizationSettings,
  SUMMARIZATION_MIDDLEWARE_NAME,
  SUMMARIZATION_PLUGIN_NAME,
  SUMMARIZATION_SERVICE,
} from './summarization.js';
import type { SummarizationSettings } from './summarization.js';
import { TokenAnchorBook } from './token-estimate.js';
import { toolCallIdOf, toolRefusal } from './tool-events.js';
import {
  createToolExecuteMiddleware,
  createToolPostExecuteMiddleware,
  createToolPreExecuteMiddleware,
} from './tool-pipeline.js';
import {
  resolveToolResultPruneConfig,
  TOOL_RESULT_PRUNE_SERVICE,
  TOOL_RESULT_PRUNER_PLUGIN_NAME,
} from './tool-result-pruner.js';
import type { ToolResultPruneConfig } from './tool-result-pruner.js';

/**
 * 工具呈現順序清單裡代表「其餘未列出者」的保留項。
 *
 * 名字與語義照 dsh 的 `TOOL_ORDER_REST`（`packages/core/system-prompt/src/index.ts`）：
 * 列到的工具站在它被列的位置，沒列到的在這一格依字典序插進來。deepagents 沒有
 * 對應機制——註冊順序是 plugin 載入順序的產物，dsh 的 Agent Note 記過它造成的
 * CI flake。
 */
export const TOOL_ORDER_REST = '<unlisted-tools>';

/**
 * 接在 root-only 工具描述後面的那句話。**這句話是機制的一部分，不是註解。**
 *
 * dsh 把同一件事寫進工具描述裡——`tool-goal` 的描述末尾是 “Execution rejects non-human
 * and subagent authority.”（`references/deepseek-harness/packages/goal/tool-goal/src/index.ts:48`，
 * SHA `0a53fb55bea101816fa226bb964ae2bed71c343b`）。理由是模型看得到的只有描述：不寫在
 * 那裡，subagent 每一輪都會再叫一次，然後每一次都被拒絕。
 *
 * dsh 靠工具作者自己寫，我們由 fold 補上去。**這是刻意的**：`rootOnly` 是宣告式的一個
 * 布林值，把「要記得在描述裡講」留給註冊者就等於留一個沒有人會紅的漏。
 */
export const ROOT_ONLY_NOTICE = '這個工具只在 root agent 上執行；在 subagent 裡呼叫一定會被拒絕。';

/**
 * subagent 叫到 root-only 工具時，那顆樁回給模型的那一句。
 *
 * 樁把它包成一則 `status: 'error'` 的工具結果，不拋。dsh 那側是拋
 * （`tool-todo/src/index.ts:205-210` 的
 * `throw new Error('todo_write requires an owning agent session')`），理由是「拒絕，
 * 不要靜默 no-op」——那個理由我們照收，所以它是錯誤；不拋是因為拋給圍堵的話模型看到的字
 * 會變成「工具 X 執行失敗：…」。**不帶碼**：dsh 沒有 root-only 這個旗標。決議見
 * [#271](https://github.com/DemianLi/nexus-agent/issues/271)。
 *
 * 這是預設句。dsh 那側有現成的句與碼的工具，註冊時自己帶（`RegisterOptions.rootOnly` 給一個
 * {@link RootOnlyRefusal}）——問答那顆帶 `DELEGATED_CALLER`（[#324](https://github.com/DemianLi/nexus-agent/issues/324)）。
 *
 * @param name - 被叫到的工具名。
 * @param scope - 叫它的那個 subagent。
 * @returns 給模型看的那一句。
 */
export function rootOnlyRefusal(name: string, scope: string): string {
  return `${name} 只在 root agent 上執行，而這裡是 subagent "${scope}"。這次呼叫沒有生效。`;
}

/**
 * 把一顆 root-only 工具換成同名同參數、只會拒絕的樁。
 *
 * 名字與參數 schema 照抄：換掉的是行為，不是模型看到的介面——名字變了模型會以為工具
 * 不見了，schema 變了它連參數都填不出來。
 *
 * 註冊時自己帶了拒絕句與碼的（{@link RootOnlyRefusal}）用它的，沒帶的用 {@link rootOnlyRefusal}、不帶碼。
 * 描述的 {@link ROOT_ONLY_NOTICE} 兩種都接。
 *
 * @param original - 全域註冊的那一顆。
 * @param scope - 這顆樁要放進哪個 subagent。
 * @param refusal - 註冊時自己帶的拒絕句與碼，沒有就是 `undefined`。
 * @returns 只回那則錯誤訊息的同名工具。
 */
function rootOnlyStub(
  original: StructuredTool,
  scope: string,
  refusal: RootOnlyRefusal | undefined,
): StructuredTool {
  const refuse = (_args: unknown, config?: unknown) =>
    toolRefusal(refusal?.message ?? rootOnlyRefusal(original.name, scope), {
      callId: toolCallIdOf(config) ?? '',
      name: original.name,
      ...(refusal?.error !== undefined && { error: refusal.error }),
    });
  return makeTool(refuse, {
    name: original.name,
    description: `${original.description} ${ROOT_ONLY_NOTICE}`,
    schema: original.schema,
  }) as unknown as StructuredTool;
}

/** 核准政策：這個 session 有沒有人可以按核准。 */
export interface ApprovalPolicy {
  /**
   * 這個 session 是否接受人工核准。預設 `true`。
   *
   * 關掉的意思是**這個 session 沒有人在**（例如批次跑的 CLI）。**關掉之後 agent 照樣
   * 組得起來也跑得完**：不需要核准的工具照跑，需要核准的回一則 `status: 'error'` 的
   * ToolMessage，理由說明是「沒有人被問到」而不是「有人拒絕」。
   *
   * 這對到 dsh 的 `ApprovalPolicy: 'never'`（`docs/subsystems/approval.md:42`）——
   * “never prompt anyone: every ask resolves `'rejected'` deterministically”。
   *
   * **這一格問的是政策，不是能力。** 「根本沒有核准管道」是另一個問題，由缺席的
   * checkpointer 表達，兩者的拒絕理由刻意不同（見 {@link ApprovalChannel}）。
   *
   * 舊版在這裡是**建構期直接拋**：關著卻有 plugin 宣告了核准需求，fold 報錯，於是任何
   * bundle 了 approval-gated 工具的 plugin 在批次／CI 模式下變成載不起來。
   * [#111](https://github.com/DemianLi/nexus-agent/issues/111) 的 (c) 拍板拿掉它——
   * 那道拋比 dsh 嚴，而且嚴在錯的地方：dsh 的 agent 在 headless 下跑得起來。
   */
  enabled?: boolean;
  /**
   * 核准政策的來源（`ask`／`never`，[#437](https://github.com/DemianLi/nexus-agent/issues/437)），**每次要問人之前問一次**。
   * 省略即永遠 `ask`。**與 {@link ApprovalPolicy.enabled} 是兩個問題**：那一格問「這個入口有沒有人在」，這一格問「要不要問」，
   * 見 `approval-policy.ts`。只管核准——`ask_user_question` 與 `exit_plan_mode` 不讀它。
   */
  policy?: ApprovalPolicySource;
}

/** 組裝點在 fold 時交出來的那七樣，加一份基座工具名單。 */
export interface FoldOptions {
  /**
   * default backend。plugin 不得提供——`backend.mount()` 掛的是路由分支，
   * 兜底的那個是組裝點的事。有 plugin 掛了路由卻沒給 default backend → 報錯。
   */
  defaultBackend?: AnyBackendProtocol;
  /**
   * 工具呈現順序。省略即字典序（照 dsh：省略不代表隨便排，代表另一種確定的排法）。
   * 給了就必須恰好含一個 {@link TOOL_ORDER_REST}、沒有重複名字、列到的名字都有對應
   * 的已註冊工具。
   */
  toolOrder?: readonly string[];
  /**
   * 基座自己帶進來、不經過我們 registry 的工具名（`write_file` / `delete` / `execute` /
   * `task` 那些）。
   *
   * 形狀照 dsh 的 `ToolProviderResult.knownNames`（`packages/core/system-prompt/src/index.ts`）：
   * 「這一次組裝**可見**的工具」與「設定驗證用的**名字宇宙**」是兩件事，宇宙由提供者
   * 貢獻，省略即等於可見那些。fold 只拿它驗名字，不會把它變成工具——那些工具是基座的
   * middleware stack 自己註冊的。
   *
   * 沒有它的話，`toolOrder: ['write_file', ...]` 會被誤判成「沒人註冊」，而那幾個恰好是
   * 最該排在前面的。所有權留在 harness——它是唯一呼叫 `createDeepAgent` 的地方，知道
   * 自己開了哪些工具。
   *
   * **消費者從兩個減成一個了。** 核准過去也吃這份宇宙（`interrupts.require('delete', ...)`
   * 要驗名字存在），現在閘門拿的是執行當下的那一次呼叫，沒有名字要對齊
   * （[#111](https://github.com/DemianLi/nexus-agent/issues/111)）。
   */
  baseToolNames?: readonly string[];
  /**
   * 子代理的工具允許／拒絕清單（[#707](https://github.com/DemianLi/nexus-agent/issues/707)），套在**每個**子代理上，
   * 含 fold 補的 `general-purpose`；root 不受影響。省略時 fold 的產物與沒有這一格時逐字相同。
   *
   * 只遮**繼承來的**：全域註冊的工具從子代理的 `tools` 扣掉，基座的檔案工具（{@link FoldOptions.baseToolNames}）
   * 由一顆只放進子代理的 middleware 從請求拿掉、叫了也不執行。子代理自帶的與它那層註冊的不受影響。
   * 規則與檢查見 {@link ./subagent-tool-filter.ts}（空 filter、未知名字在組裝期拋）。
   */
  subagentToolFilter?: ToolFilter;
  /** 模型。 */
  model?: AgentModel;
  /** checkpointer。`false` 與缺席同義。 */
  checkpointer?: AgentCheckpointer;
  /** 長期記憶用的 store。 */
  store?: AgentStore;
  /** 核准政策的 session 開關。 */
  approvals?: ApprovalPolicy;
  /**
   * 摘要的門檻與去向。給物件就逐格淺合併到 {@link DEFAULT_SUMMARIZATION} 上。
   *
   * **省略時不一定是預設值**：那時改由部署設定層的 `@nexus/core/summarization` 條目決定，
   * 四態的順序見 {@link summarizationDisposition}
   * （[#456](https://github.com/DemianLi/nexus-agent/issues/456)）。那一列標成
   * `disabled: true` 的效果跟這裡傳 `false` 一樣——**都是一顆同名空殼，不是「沒有」**。
   * 手搭 plugin 清單、沒有經過設定檔的組裝拿到的還是內建預設。
   *
   * **`false` 是真的關掉**（[#446](https://github.com/DemianLi/nexus-agent/issues/446)）：
   * root、宣告的 subagent 與 fold 補的 `general-purpose` 各拿到一顆同名空殼，基座無條件
   * 建的那顆被它原地取代，於是沒有摘要、沒有歷史 offload、也沒有
   * {@link FoldOptions.toolResultPruning} 那把剪刀。這是 dsh minimal preset 的形狀
   * （不掛 compaction）。**連帶沒有的**：上下文溢出時基座那條緊急摘要——dsh 沒掛
   * compaction 時一樣沒有溢出恢復。
   *
   * 建摘要器需要一個 backend。**用的是這裡的 {@link FoldOptions.defaultBackend}，不是
   * {@link foldBackend} 折出來的那個**，理由見 {@link foldRegistry}。所以沒給
   * default backend 又沒關掉摘要時，fold 當場拋；關掉時不需要。
   */
  summarization?: Partial<SummarizationSettings> | false;
  /**
   * 錨定估算的帳（[#588](https://github.com/DemianLi/nexus-agent/issues/588)、[#702](https://github.com/DemianLi/nexus-agent/issues/702)）：
   * 摘要器的預算層用它估「這份請求送出去會是幾個 token」，並在每次呼叫回來時記下供應商報的實數。
   *
   * **帳由進入點建、注入**，不是模組全域。要跨 thread 借錨的進入點（`runServe`）建一本傳給每一條 thread 的組裝；
   * **省略即這次組裝各建一本**——這次組裝裡的 root 與子代理共用它（`foldSummarizer` 只建一次），不同組裝彼此不借。
   * 只在摘要開著時有作用。
   */
  tokenAnchorBook?: TokenAnchorBook;
  /**
   * 摘要器外面那把工具結果剪刀的預算。給物件就逐格淺合併到
   * {@link DEFAULT_TOOL_RESULT_PRUNE} 上，`false` 是明著不要——摘要照跑，只是不先剪。
   *
   * **省略時不一定是預設值**：那時改由部署設定層的 `@nexus/core/tool-result-pruner` 條目
   * 決定，四態的順序見 {@link toolResultPruningDisposition}
   * （[#456](https://github.com/DemianLi/nexus-agent/issues/456)）。手搭 plugin 清單、
   * 沒有經過設定檔的組裝拿到的還是內建預設。
   *
   * **照 dsh，它只在摘要開著時有作用**：dsh 的 pruner 唯一的消費者是 compaction，摘要
   * 不掛就沒人叫它。所以 {@link FoldOptions.summarization} 是 `false` 時這一格不發生作用，
   * 但**給了物件照樣驗**：設定寫錯在載入期失敗，不因為今天剛好沒用到就放過。
   * 形狀與理由見 {@link ./tool-result-pruner.ts}。
   */
  toolResultPruning?: Partial<ToolResultPruneConfig> | false;
  /**
   * 重複工具呼叫的提醒門檻與射程。給物件就逐格淺合併到 {@link DEFAULT_REPEAT_REMINDER}
   * 上，`false` 是明著不要。
   *
   * **省略時不一定是預設值**：那時改由部署設定層的 `@nexus/core/repeat-reminder` 條目決定，
   * 四態的順序見 {@link repeatReminderDisposition}
   * （[#456](https://github.com/DemianLi/nexus-agent/issues/456)）。手搭 plugin 清單、
   * 沒有經過設定檔的組裝拿到的還是內建預設。
   *
   * `false` 之後**真的沒有**——基座沒有這種 middleware，`recursionLimit` 是唯一會讓
   * 打轉停下來的東西，而它不分辨在進展還是在打轉。
   *
   * 它建的 middleware 是無狀態的（鏈從 `state.messages` 現算），所以 root 與每個
   * subagent 共用同一份實例，不像摘要器要逐個建。
   *
   * **關掉它會拿回一點迴圈預算**：它掛在 `beforeModel` 上，那是圖裡的一個節點，
   * 每一輪多一個 super-step。見 {@link createRepeatReminder}。
   */
  repeatReminder?: Partial<RepeatReminderSettings> | false;
  /**
   * 「先讀後改」策略：沒讀過的檔不准改。省略即開著，`false` 是明著關掉。
   *
   * **省略時還有第二條關法**：部署設定層把 `@nexus/core/observation-policy` 那一列標成
   * `disabled: true`（[#456](https://github.com/DemianLi/nexus-agent/issues/456)）。這一顆
   * **沒有設定**，所以它只有三態而不是四態，理由見
   * {@link ./observation.ts | observationPolicyPlugin}。
   *
   * **預設開著是照 dsh**：它那側這是預設載入的插件，連工具描述都寫著「the **default**
   * fs-observation-policy requires it」。關掉的意思是「這個組裝接受盲改」——例如一個
   * 只寫新檔、從不編輯的批次流程。
   *
   * **它需要一個 backend，而且是折出來的那個**（{@link foldBackend} 的產物，可能是
   * `CompositeBackend`），不是 {@link FoldOptions.defaultBackend}——版本 token 必須從
   * 工具實際讀寫的那一個取，掛了路由的路徑才不會量到別人的版本。**這一格因此跟摘要器
   * 相反**：摘要器刻意拿兜底那個，理由見 {@link foldRegistry}。
   *
   * 沒有任何 backend（組裝點沒給、也沒人掛路由）又沒關掉時，fold 當場拋——同
   * {@link foldSummarizer} 那條軸線：靜默跳過會長得跟「一切正常」一模一樣。
   *
   * 它建的 middleware **有狀態**（觀測紀錄在 closure 裡），所以 root 與每個 subagent
   * **各建一份**，不共用。見 {@link createObservationPolicy}。
   */
  observationPolicy?: boolean;

  /**
   * 工具結果的外溢層（[#719](https://github.com/DemianLi/nexus-agent/issues/719)）：一則結果超過 `maxInlineTokens`，
   * 全文存進 `store`，模型只收到預覽加定位。**省略就不掛**——那時超過 80,000 字元的結果仍由基座換成預覽。
   *
   * 沒有 closure 狀態，root 與每個子代理共用同一份實例（儲存本身按會話分）。見 {@link ./spill-policy.ts}。
   */
  spillPolicy?: SpillPolicyOptions;

  /**
   * 搜尋結果的筆數上限（[#735](https://github.com/DemianLi/nexus-agent/issues/735)）：`grep` 命中、`glob`／`ls` 路徑
   * 超過上限時，行內留前段，完整的存進 `store`。**省略就不掛**——基座的三顆照原樣，超過 80,000 字元自己截掉。
   *
   * 沒有 backend、或 root／任何子代理有 `permissions` 規則時也不掛（同搜尋卡，見 {@link searchMetaAllowed}）。
   * 見 {@link ./search-overflow.ts}。
   */
  searchOverflow?: SearchOverflowOptions;

  /**
   * 每一次模型呼叫的 token 帳目要不要記進會話日誌。省略即開著，`false` 是明著關掉。
   *
   * **省略時還有第二條關法**：部署設定層把 `@nexus/core/model-usage` 那一列標成
   * `disabled: true`（[#456](https://github.com/DemianLi/nexus-agent/issues/456)）。這一顆
   * **沒有設定**，所以它只有三態而不是四態，理由見
   * {@link ./model-usage.ts | modelUsagePlugin}。
   *
   * **關掉它不會讓任何東西失敗，所以它的代價要自己讀出來**：不見的是落盤日誌裡那本
   * 逐次呼叫的 token 帳（`model/usage`），連帶 web 用量表的「目前大小」那一行（#528）。
   * **加總它的仍然沒有**——評估那條路的數字是它自己從 `usage_metadata` 加的，跟這一顆無關
   * （數過，見 {@link ./model-usage.ts | modelUsagePlugin}）。它坐在 request path 上但不准拋，
   * 所以也沒有「留著它會弄壞什麼」這一面可以拿來權衡。
   *
   * 它**無狀態**，所以 root 與每個 subagent 共用同一份實例，不像「先讀後改」那樣逐個建。
   * 見 {@link createModelUsageRecorder}。
   */
  modelUsage?: boolean;

  /**
   * 掛不掛插話的載體（[#710](https://github.com/DemianLi/nexus-agent/issues/710)）。省略即不掛。
   *
   * **要在 `configurable` 放收件匣 handle 的進入點才開**（web 的 pump）：沒有 handle 時它什麼都不做，但它的
   * `beforeModel` 照樣是圖裡的一個節點，每一步多一個 super-step。CLI 一行一輪、沒有插話，不必付那一格。
   * 只折進 root 的 middleware 陣列，見 {@link ./step-inbox.ts}。
   */
  stepInbox?: boolean;

  /**
   * 同一步的工具呼叫一顆一顆串行（[#711](https://github.com/DemianLi/nexus-agent/issues/711) 收尾）：每一顆都當獨佔，不看宣告。
   * 對應 dsh 的 `maxParallelToolCalls: 1`。省略即照宣告重疊。由組裝點按 `#settings/agent-loop` 的上限是不是 1 給；
   * root 與每個子代理的屏障都吃它。見 {@link ./tool-barrier.ts | createToolBarrierMiddleware}。
   */
  serialToolCalls?: boolean;

  /**
   * 宿主持有的事件派發面（`registry.dispatch`，[#1248](https://github.com/DemianLi/nexus-agent/issues/1248)）。省略即不掛
   * 工具事件的生產者，工具呼叫的行為與沒有這一格時一樣。
   *
   * 給了會多四件事：`tools/pre-execute`（核准閘門外側）、`tools/post-execute`、`tools/execute` 三顆 middleware 進槽位表，
   * 圍堵多派發 `tools/result`。**沒有任何監聽者時全部是直通**，連請求物件都不造。位置與理由見 {@link ./tool-pipeline.ts}。
   *
   * **省略會讓已經搬上匯流排的消費者靜靜失效**（[#1272](https://github.com/DemianLi/nexus-agent/issues/1272)）：plan-mode 的
   * 模式外拒絕是 `tools/pre-execute` 上的監聽者，沒有生產者就不會被問到。產品路徑只有 `apps/harness/src/agent-factory.ts`
   * 呼叫 `foldRegistry`，且傳了 `registry.dispatch`；自己折 registry 的測試或量測要載入有監聽者的 plugin 時也得傳。
   */
  events?: EventDispatcher;

  /**
   * 串流第一則事件之後才出錯的模型呼叫，整次重打的預算（[#520](https://github.com/DemianLi/nexus-agent/issues/520)）。省略或 `maxRetries`
   * 為 0 就不掛這一顆。由組裝點按 `live-model` 的設定給；root 與每個子代理的模型呼叫都吃它。見 {@link ./stream-retry.ts}。
   */
  streamRetry?: StreamRetryOptions;

  /**
   * 每會話模型選擇的控制器（[#723](https://github.com/DemianLi/nexus-agent/issues/723)）。省略即不掛，請求逐欄與沒有這一格時一樣。
   *
   * 給了會多三件事：root 的 middleware 疊最外面多一顆換模型的（{@link ./model-selection.ts | createModelSwapMiddleware}）；
   * 換模型的通知借重複提醒的 `beforeModel` 附上，**重複提醒被關掉時才另掛一顆節點**（每一步多一個 super-step）；
   * root 的換模型只折進 root；**子代理另有一顆跟隨的**（{@link ./model-selection.ts | createSubagentModelFollowMiddleware}，#328 第 3 項）：
   * 每次叫模型前換成定義釘住的、沒釘就是父代理當下選擇的那顆（照 dsh 子代理沿用父代理當下路由）。
   */
  modelSelection?: ModelSelectionController;

  /**
   * 一顆模型自己的窗口與輸出上限，查不到回 `undefined`。給了，摘要的 `tokens` 門檻逐步夾在當步模型撐得住的範圍內
   * （{@link ./summarization.ts | effectiveTrigger}）。傳進來的是 `request.model`（換模型之後就是選中的那顆）。
   */
  modelLimits?: (model: unknown) => ModelContextLimits | undefined;
}

/**
 * fold 的產物：`createDeepAgent(...)` 的參數。
 *
 * 刻意是 `CreateDeepAgentParams` 的一個子集而不是重打一份——`fold.test.ts` 有一條
 * 把它指派給 `CreateDeepAgentParams` 的型別斷言，基座改了形狀會在 typecheck 當場紅。
 */
export interface FoldedAgentParams {
  /** 依呈現順序的全域工具。 */
  tools: StructuredTool[];
  /** 每個 subagent 都補上了它的有效工具集合、權限與核准標記。 */
  subagents: SubAgent[];
  /** `prepend` 的在前，其餘依註冊順序。 */
  middleware: AgentMiddleware[];
  /** deny 規則，含每條 deny 自己挖的洞。空的時候不出現。 */
  permissions?: FilesystemPermission[];
  /** 有 plugin 掛過路由時是 `CompositeBackend`，否則就是組裝點給的那個。 */
  backend?: AnyBackendProtocol;
  /** skill 來源路徑。空的時候不出現。 */
  skills?: string[];
  /** memory 來源路徑。空的時候不出現。 */
  memory?: string[];
  /** 組裝點給的模型。 */
  model?: AgentModel;
  /** 組裝點給的 checkpointer。 */
  checkpointer?: AgentCheckpointer;
  /** 組裝點給的 store。 */
  store?: AgentStore;
}

/**
 * 把 registry 折成 `createDeepAgent(...)` 的參數。
 *
 * ## 摘要器為什麼吃 `defaultBackend` 而不是折出來的那個
 *
 * `foldBackend` 回的可能是 `CompositeBackend(defaultBackend, routes)`。餵它給摘要器
 * 等於**讓 plugin 掛的路由決定會話歷史落在哪**——一個掛在 `/conversation_history` 上
 * 的路由會安靜地接管一條 agent 自己不知道的寫入路徑，而那條路徑本來就已經繞過
 * permissions（[#66](https://github.com/DemianLi/nexus-agent/issues/66)）。
 *
 * 歷史是基礎建設，不是 agent 的工作區；`backend.mount()` 掛的是後者。所以摘要器拿的是
 * 兜底那個，跟 agent 走不走路由無關。這同時延續
 * `summarization.test.ts` 已經釘住的一件事：**摘要器的 backend 是獨立的一格**。
 *
 * @param registry - 已經跑完 `loadPlugins()` 的 registry。
 * @param options - 組裝點自有的那些。
 * @returns 可以直接展進 `createDeepAgent(...)` 的參數。
 */
export function foldRegistry(
  registry: PluginRegistry,
  options: FoldOptions = {},
): FoldedAgentParams {
  assertScopesHaveSubAgents(registry);

  const toolOrder = options.toolOrder;
  const globalTools = registry.tools.effective();
  assertNoReservedToolName(registry);
  // 名字宇宙只剩一個消費者了：`toolOrder`。**核准那一條跟著機制一起走了** —— 閘門
  // 不再以工具名為 key，沒有「標在不存在的工具上」這回事，所以 `assertInterruptToolsExist`
  // 沒有主體可檢，跟著刪（#111 的 (a)①）。
  const known = knownToolNames(registry, options.baseToolNames);
  if (toolOrder !== undefined) validateToolOrder(toolOrder, known);
  // 工具過濾的宇宙比 `toolOrder` 窄：只收**可遮的繼承來的**，照 dsh 的 `restrictableNames`。
  if (options.subagentToolFilter !== undefined) {
    assertToolFilter(
      options.subagentToolFilter,
      restrictableToolNames(registry, options.baseToolNames),
    );
  }

  const permissions = foldPermissions(registry);
  // 解不開的參數的原字串記在那則 AI 訊息上，三個讀者（圍堵、核准閘門、最內層那顆）各自從
  // `request.state` 讀，沒有要共用的東西。見 {@link ./invalid-tool-args.ts}。
  const invalidToolArgs = createInvalidToolArgsMiddleware();
  // **撞到輸出上限（#433）也是一份載體、一顆實例走遍 root 與每個子代理**：子代理的模型呼叫記、
  // 父圖的 `task` 取，得看到同一份。見 {@link ./max-tokens.ts}。
  const maxTokens = createMaxTokensMiddleware(createMaxTokensCarrier());
  // **輸出校驗也是一份走遍**：無狀態，schema 每次從那一顆工具實例現查（#252）。它是性質不是
  // 功能，理由同圍堵，見 {@link ./output-schema.ts}。
  const outputSchema = createOutputSchemaMiddleware((tool) => registry.tools.outputSchemaOf(tool));
  // **一份實例走遍 root 與每個 subagent。** 它無狀態，見 {@link ./containment.ts}。
  // 它也是工具事件的生產者（#264），所以要拿得到 `sessions` 那個通道。
  const containment = createContainmentMiddleware(registry.sessions, options.events);
  // 工具事件的三顆生產者（#1248）：一份實例走遍 root 與每個子代理，無狀態；呼叫者身分從每次請求現算。
  const toolPreExecute =
    options.events === undefined ? undefined : createToolPreExecuteMiddleware(options.events);
  const toolPostExecute =
    options.events === undefined ? undefined : createToolPostExecuteMiddleware(options.events);
  const toolExecute =
    options.events === undefined ? undefined : createToolExecuteMiddleware(options.events);
  // **中止這一輪的兩顆，也是一份實例走遍 root 與每個子代理**：訊號每次從那一次呼叫的
  // `configurable` 現讀。位置一外一內，理由見 {@link ./turn-cancel.ts}。
  const turnCancel = createTurnCancelGuard();
  const turnCancelModelSignal = createTurnCancelModelSignal();
  const approvalGate = foldApprovalGate(registry, options);
  // **前景子代理共用 root 這一顆閘門**（[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 1 項，翻了 #324）：前景時主對話本來就停著等，
  // 子代理要核准的操作把中斷冒到使用者面前（基座的 `task` 在同一次呼叫裡跑子圖，中斷會往上傳；#1098 的 MCP 反問已經走這條），
  // 政策與管道就是 root 當下的（`options.approvals.policy` 每次要問人之前問一次，#437）。沒有人的入口、沒有存檔點、政策 `never`
  // 時一樣確定性回絕，理由說的是真正的原因。**背景子代理不走這裡**：它們背後沒有人，圖由 {@link createBackgroundApprovalGate}
  // 那一顆（管道固定 `policy-never`，#324／#737 照 dsh `child-agent.ts:220-247`）在編圖時換掉。
  const subagentDelegation = createSubagentDelegationMiddleware(
    FOREGROUND_SUBAGENT_DELEGATION_CONTEXT,
  );
  const summarizer = foldSummarizer(registry, options);
  const repeatReminder = foldRepeatReminder(registry, options);
  // **一份實例走遍 root 與每個 subagent**，或在明著關掉時沒有。它無狀態，見
  // {@link ./model-usage.ts}。
  const modelUsage = foldModelUsage(registry, options);
  // 同上，無狀態、一份走遍。位置緊貼用量記錄器，理由見 {@link ./model-calls.ts}。
  const modelCalls = createModelCallRecorder(registry.sessions);
  // 串流中段出錯的整次重打（#520）：排在起訖與用量記錄器外面，每一次嘗試各是一對起訖。無狀態、一份走遍。
  const streamRetry =
    options.streamRetry === undefined || options.streamRetry.maxRetries <= 0
      ? undefined
      : createStreamRetryMiddleware(options.streamRetry, registry.sessions);
  // 請求快照（#1020）：同上，無狀態、一份走遍；基準住在日誌上。排在最內層，見 {@link ./request-snapshot.ts}。
  const requestSnapshot = createRequestSnapshotRecorder(registry.sessions);
  // 耐久檢查點（#599）：同上，無狀態、一份走遍 root 與每個子代理。位置緊貼用量記錄器內側，
  // 理由見 {@link foldMiddleware}。
  const sessionCheckpoint = foldSessionCheckpoint(registry);
  // **backend 提前折**：策略要的版本 token 得從工具實際讀寫的那一個取，所以它不能等到
  // 下面才算。摘要器刻意拿的是兜底那個，兩者的差別見各自的文件。
  const backend = foldBackend(registry, options.defaultBackend);
  // **工具拿的也是這一個**（#694）：組裝點提供了 `fs` 那一格的話，在這裡填。填的是折出來的這個，不是兜底那個、
  // 也不是下面交給基座前再包上記錄層的那一份——後者只給基座的檔案工具記結果用。見 {@link ./fs-service.ts}。
  settleFsService(registry.services.get(FS_SERVICE), backend);
  const observationPolicy = foldObservationPolicy(registry, options, backend);
  // 檔案工具的失敗標成錯誤（#293）：只在有 backend 時掛——包的是交給基座的那一份，策略手上
  // 那一個是同一個實例，見 {@link ./fs-tool-errors.ts}。無狀態，一份走遍 root 與每個 subagent。
  const fsToolErrors = backend === undefined ? undefined : createFsToolErrorsMiddleware();
  // 讀檔結果最後補上讀到哪（#594）：同上，只在有 backend 時掛、包的是交給基座的那一份，無狀態、
  // 一份走遍 root 與每個 subagent。見 {@link ./read-continuation.ts}。
  const readContinuation = backend === undefined ? undefined : createReadContinuationMiddleware();
  // 外溢層（#719）：無狀態、一份走遍 root 與每個 subagent，位置緊貼中止（在 plugin 與核准閘門外側），
  // 圍堵記進日誌的就是它換過的那一則。見 {@link ./spill-policy.ts}。
  const spill =
    options.spillPolicy === undefined
      ? undefined
      : createSpillPolicyMiddleware(options.spillPolicy);
  // **plugin middleware 在這裡就攤平，只攤一次**：要 backend 的那一種（`useWithBackend`，#388）
  // 建出來的實例得走遍 root 與每個子代理，這裡各算一次的話兩邊拿到的會是兩份。
  const plugins = pluginMiddleware(registry, backend);
  // 搜尋結果的筆數上限（#735）：middleware 與 backend 包裝是一對，只在這裡一起組（#698）。沒有 backend、或有
  // `permissions` 規則（同搜尋卡）就整對不掛。見 {@link ./search-overflow.ts}。
  const searchOverflow =
    options.searchOverflow !== undefined &&
    backend !== undefined &&
    searchMetaAllowed(registry, permissions)
      ? options.searchOverflow
      : undefined;
  const searchOverflowMiddleware =
    searchOverflow === undefined ? undefined : createSearchOverflowMiddleware(searchOverflow);
  const subagentPlugins = subagentPluginMiddleware(plugins);
  // 工具過濾（#707）遮的基座工具：過濾對每個子代理一樣，所以名單一樣；基座工具不可能被子代理自己同名註冊（基座拒絕），
  // 不必扣自帶的。
  const hiddenBaseTools = new Set(
    options.subagentToolFilter === undefined
      ? []
      : (options.baseToolNames ?? []).filter(
          (each) => !toolKept(options.subagentToolFilter!, each),
        ),
  );

  // **槽位表：root 與每個子代理的 middleware 疊都從這一張導出**（#664），順序就是兩邊的包裹順序。
  // 新增一顆 core middleware = 上面建一個實例、這裡加一列。子代理那一欄要寫「不給」得明著寫，漏接在這裡寫不出來。
  const slots: readonly MiddlewareSlot[] = [
    // 插話排最前面：它的 `beforeModel` 先於其餘每一顆（重複提醒在同一步就看得到人插了話、清零），它的
    // `afterAgent` 最後才問（排在它後面的 `afterAgent` 先走完）。它沒有 `wrap*`，不影響洋蔥的層次。
    // 只折進 root。見 {@link ./step-inbox.ts}。
    rootOnly(
      'stepInbox',
      same(options.stepInbox === true ? createStepInboxMiddleware() : undefined),
    ),
    // 換模型排在洋蔥最外面（#723）：摘要器、起訖、用量與 plugin middleware 看到的 `request.model` 都是這一步選中的那顆。
    // root 的每一步快照一次；子代理另給一顆（#328 第 3 項）：沒釘模型就跟父代理**當下**的選擇，釘了就用定義釘的，見
    // {@link ./model-selection.ts | createSubagentModelFollowMiddleware}。背景圖若是 `subagent` 工具替這一次委派挑了模型，
    // `compileSubagentGraph` 會把這一顆濾掉（模型自己挑的勝過一切，dsh `requestedAgentOptions`）。
    {
      name: 'modelSelection',
      root: same(
        options.modelSelection === undefined
          ? undefined
          : createModelSwapMiddleware(options.modelSelection),
      ),
      subagent: make((spec) =>
        options.modelSelection === undefined
          ? undefined
          : createSubagentModelFollowMiddleware(options.modelSelection, {
              ...(typeof spec.model === 'string' && { model: spec.model }),
              ...(spec.reasoningEffort !== undefined && { reasoningEffort: spec.reasoningEffort }),
            }),
      ),
    },
    // 圖片額度與 `image/offload`（#1270）緊貼換模型之後、摘要器外面：摘要器的門檻估算、起訖紀錄與請求快照看到的都是省略過的請求。
    // 這一顆只把日誌上**已經下的決定**標在請求上；新的決定由 adapter 量到超額、上層接住下（見下面 `imageOffloadRecovery`）。
    // 只折進 root：圖由人送出、住在 root 的日誌上。沒給 `modelLimits`（沒有型錄，也就沒有誰宣告得了圖片額度）就整顆不掛，請求與以前逐位元組相同；沒有圖的請求原樣通過、不讀日誌。
    rootOnly(
      'imageOffload',
      same(
        options.modelLimits === undefined
          ? undefined
          : createImageOffloadMiddleware({ sessions: registry.sessions }),
      ),
    ),
    // 子代理一次執行最多叫幾次模型（#328 第 3 項，dsh 沒有）：到了就收尾。只給子代理，root 的上限是遞迴上限（#858）。
    subagentOnly(
      'subagentMaxTurns',
      make((spec) =>
        spec.maxTurns === undefined
          ? undefined
          : (modelCallLimitMiddleware({
              runLimit: spec.maxTurns,
              exitBehavior: 'end',
            }) as unknown as AgentMiddleware),
      ),
    ),
    // 同一步多顆工具呼叫的獨佔屏障（#711 第 2 步）排在圍堵外面：等待中的呼叫在通過屏障前**什麼都不做**，不能先被圍堵記一顆
    // `tool/call`（resume 重跑會記第二顆）。**各建一份**：紀錄在閉包裡，root 與每個子代理各有各的步。見 {@link ./tool-barrier.ts}。
    perAgent('toolBarrier', () =>
      createToolBarrierMiddleware(undefined, options.serialToolCalls === true),
    ),
    // 圍堵在第 0 格：它要包住下面每一個，包含子代理 `spec.middleware` 自己帶的那些。
    shared('containment', containment),
    // 緊貼圍堵：在它裡面（換過的結果圍堵才記得到碼），在起訖紀錄器外面（中止之後被擋下的那次呼叫不算一步）。
    // root 按了停止，訊號經 `configurable` 傳到子代理（#265 的 Q10）。見 {@link ./turn-cancel.ts}。
    shared('turnCancel', turnCancel),
    // 外溢層在 plugin 與核准閘門的外側、圍堵的內側：內層每一顆換過的結果它都看得到，而圍堵寫進日誌的是它換過的那一則
    // （紀錄只記預覽，同 dsh `tool-calls.ts:152-156`）。見 {@link ./spill-policy.ts}。
    shared('spill', spill),
    // 搜尋結果的筆數上限（#735）緊貼外溢層內側：外溢層看到的是它換過的那則（行內前段加定位），同 dsh `tools/post-execute`
    // 先於外溢；在 plugin 與核准閘門外側。無狀態、一份走遍 root 與每個子代理（槽逐次呼叫開）。見 {@link ./search-overflow.ts}。
    shared('searchOverflow', searchOverflowMiddleware),
    // plugin 以 `prepend` 掛的：在中止內側、閘門外側（#327）。子代理拿的是同一批實例，去掉撞名摘要器的那一顆。
    {
      name: 'plugins.prepended',
      root: same(plugins.prepended),
      subagent: same(subagentPlugins.prepended),
    },
    // 工具過濾（#707）遮基座工具，排在閘門外側：被遮的呼叫碰不到閘門與工具本體。沒設或沒有基座工具被遮就不放。
    subagentOnly(
      'toolFilter',
      make(() =>
        hiddenBaseTools.size === 0
          ? undefined
          : createSubagentToolFilterMiddleware(hiddenBaseTools),
      ),
    ),
    // `tools/pre-execute`（#1248）緊貼閘門外側：`prepend: true` 的 plugin（plan-mode 的拒絕）今天就在閘門外側，派發點放內側會變成
    // 「先跳核准卡、再被拒」。拒絕在問人之前，同 dsh（hooks／permission／sandbox 先於 approval）。核准本身沒有搬上去。
    shared('toolPreExecute', toolPreExecute),
    // 閘門排在子代理自帶的那些之前——同「全域勝」那條軸線：子代理自己掛的 middleware 繞不過它。
    // 前景子代理用同一顆（#328 第 1 項）；背景圖編圖時換成 `policy-never` 那顆（{@link createBackgroundApprovalGate}）。
    { name: 'approvalGate', root: same(approvalGate), subagent: same(approvalGate) },
    // **各建一份，不共用**：觀測紀錄在 closure 裡，共用等於讓 root 讀過的檔變成這個 subagent 也可以直接改。
    // 理由見 {@link foldObservationPolicy}。
    perAgent('observationPolicy', () => observationPolicy?.()),
    // **摘要器也各建一份，不共用**：`sessionId` 在 closure 裡，共用會讓 root 與這個 subagent 的歷史 append 進同一個檔。
    // 理由見 {@link foldSummarizer}。排在子代理自帶的 middleware 之前 ＝ 自帶的同名版本贏得過我們這份（打底不是強制）。
    perAgent('summarizer', () => summarizer()),
    // 提醒器與用量記錄器同樣打底、共用一份：它們無狀態，不注的話子代理那幾輪完全沒有——沒有人會紅
    // （#147）。見 {@link ./model-usage.ts}。
    shared('repeatReminder', repeatReminder),
    // 委派聲明排在 `spec.middleware` 外層：子代理自己帶的 middleware 看到的是接好聲明的請求。只給子代理。
    subagentOnly('delegation', same(subagentDelegation)),
    // 起訖排在用量外層、plugin middleware 外層：一個自己重試模型的 plugin，重試幾次都只算一步——同 dsh 的
    // `llm/retry` 在一步之內。摘要器不管排哪都在它外面，見 `model-calls.ts`。
    // 串流中段出錯的整次重打（#520）在起訖與用量外面：每次嘗試各有自己的 `model/start`／`model/end` 與用量，失敗那次帶
    // `outcome: 'error'`。見 {@link ./stream-retry.ts}。
    shared('streamRetry', streamRetry),
    shared('modelCalls', modelCalls),
    shared('modelUsage', modelUsage),
    // 耐久檢查點排在起訖紀錄器內側：排空時 `model/start` 已經記下，同 dsh「記好的請求前綴」；在其餘 plugin
    // middleware 外側：一個自己重試模型的 plugin 重試幾次都只排空一次。子代理的模型呼叫排空的是子代理那一份日誌。
    // 工具那一側，`tool/call` 由最外層的圍堵記，這裡一定看得到它。見 {@link ./session-checkpoint-policy.ts}。
    shared('sessionCheckpoint', sessionCheckpoint),
    // 其餘 plugin 的：排在子代理 `spec.middleware` 外層，plugin 打底、自帶的在內側，同 `tools` 那條「全域 → 自帶」的軸線。
    { name: 'plugins.rest', root: same(plugins.rest), subagent: same(subagentPlugins.rest) },
    // 子代理自己帶的 middleware：每個子代理不同，所以是「逐個取」而不是共用。
    subagentOnly(
      'spec.middleware',
      make((spec) => spec.middleware ?? []),
    ),
    // 以 `last` 掛的（#720）：在其餘每一顆會往 system prompt 附加文字的內側（連子代理自帶的也在它外側），所以它附加的仍是最後一段。
    { name: 'plugins.last', root: same(plugins.last), subagent: same(subagentPlugins.last) },
    // `tools/post-execute`（#1248）在輸出校驗等貼著工具本體的那幾顆外側（dsh 在 post-execute 之前驗輸出）、在每一個 plugin
    // middleware 內側：plugin 與圍堵看到的是替換過的那則。
    shared('toolPostExecute', toolPostExecute),
    // 輸出校驗在每一個 plugin middleware 的內側：看到的是工具原本的輸出，不是外層改過的版本（dsh 在
    // `tools/post-execute` 之前驗）。解不開參數的那顆在它更內側，換上的樁回的是錯誤，這裡照規矩不驗。
    // 見 {@link ./output-schema.ts}。
    shared('outputSchema', outputSchema),
    // 檔案工具的失敗標成錯誤：貼著工具本體（dsh 在工具裡拋），在輸出校驗、先讀後改與圍堵的內側，它們讀到的都是
    // 改過的狀態。子代理的檔案工具由基座用 root 那一份 `backend` 建，所以記錄的那一層在它們身上一樣在。
    // 解不開參數的樁不叫 backend，排在它裡面沒有東西可記。見 {@link ./fs-tool-errors.ts}。
    shared('fsToolErrors', fsToolErrors),
    // 讀檔結果最後補上讀到哪：同一個時刻、同一個理由貼著工具本體。在失敗記錄的內側，它只補成功的，兩者不相干；
    // 外面每一顆（含圍堵寫進日誌的那一則）看到的都是補過的。見 {@link ./read-continuation.ts}。
    shared('readContinuation', readContinuation),
    // 解不開的參數：`wrapToolCall` 在核准與每個 plugin 的內側（dsh 執行時才驗參數），改寫在其餘 `wrapModelCall`
    // 的內側（外面看到的都是改寫過的那則）。root 與子代理同一顆（#269 的 Q7）。見 {@link ./invalid-tool-args.ts}。
    shared('invalidToolArgs', invalidToolArgs),
    // `tools/execute`（#1248）環繞工具本體，排在解不開參數那顆的內側（樁回的錯誤它看得到）、撞到輸出上限那顆的外側：後者的
    // `wrapToolCall` 只對 `task` 把結果換成 dsh 那句錯誤，dsh 是在前景 `task` 本體裡拋，所以那個替換在 execute 的內側才對得上。
    shared('toolExecute', toolExecute),
    // 撞到輸出上限：清工具呼叫排在修補的內側（被切斷的那顆不會先被修成 `{}` 參數），外面每一顆看到的都是清過的；
    // 子代理的截斷要記進同一份載體給父圖的 `task` 讀。見 {@link ./max-tokens.ts}。
    shared('maxTokens', maxTokens),
    // `image/offload` 的接住端（#1270）：adapter 在請求轉換前量到圖超過額度，以 `IMAGE_OFFLOAD_REQUIRED` 失敗；這一顆接住、下決定、再送一次。
    // **排在起訖紀錄器、用量記錄器、串流重打的內側**（它們在上面）：失敗的那一次沒送出任何東西，不算一次模型呼叫、不花重試額度、不記 `llm/retry`。
    // 只折進 root，同 `imageOffload`。見 {@link ./image-offload.ts}。
    rootOnly(
      'imageOffloadRecovery',
      same(
        options.modelLimits === undefined
          ? undefined
          : createImageOffloadRecoveryMiddleware({ sessions: registry.sessions }),
      ),
    ),
    // 請求快照（#1020）緊貼最內層、在中止訊號外面：它也包 `request.model`，排在這裡外面每一顆看到的仍是原本的模型。
    // 記錄點其實在模型被叫的那一刻（callback），不靠這個位置——deepagents 自己還有幾顆在我們這串後面，見 {@link ./request-snapshot.ts}。
    shared('requestSnapshot', requestSnapshot),
    // 最內層：只替模型綁中止訊號，外面每一顆看到的都是原本的模型。見 {@link ./turn-cancel.ts}。
    shared('turnCancelModelSignal', turnCancelModelSignal),
  ];

  const params: FoldedAgentParams = {
    tools: orderTools(globalTools, toolOrder),
    subagents: foldSubAgents(registry, {
      toolOrder,
      toolFilter: options.subagentToolFilter,
      baseToolNames: options.baseToolNames ?? [],
      skills: registry.skills.sources(),
      permissions,
      slots,
    }),
    middleware: foldMiddleware(slots),
  };

  if (permissions.length > 0) params.permissions = permissions;
  // 三層都轉交同一個實例；讀到哪那一層在內側，失敗記錄看到的是它切回去之後的那份。
  // 抓 meta 的那層在最內側，看到的是 backend 原本交出的結果，見 {@link ./tool-result-meta.ts}。
  if (backend !== undefined) {
    params.backend = recordBackendOutcomes(
      recordReadExtent(
        // 筆數上限的包裝在搜尋卡那層內側：卡片看到的是截過的前段，跟模型同一份。
        recordToolResultMeta(searchOverflow === undefined ? backend : capSearchResults(backend), {
          search: searchMetaAllowed(registry, permissions),
        }),
      ),
    );
  }

  const skills = registry.skills.sources();
  if (skills.length > 0) params.skills = skills;
  const memory = registry.memory.sources();
  if (memory.length > 0) params.memory = memory;

  if (options.model !== undefined) params.model = options.model;
  if (options.checkpointer !== undefined) params.checkpointer = options.checkpointer;
  if (options.store !== undefined) params.store = options.store;

  return params;
}

/**
 * 有工具註冊到某個 subagent 層，卻沒有任何 plugin 註冊過那個名字的 subagent。
 *
 * 這條只能在 fold 驗：層是按名字延遲建立的，註冊當下不知道那個 subagent 之後會不會
 * 出現。
 *
 * **fold 自己補的 `general-purpose` 也不算。** 那一份不在 registry 裡
 * （{@link generalPurposeSpec}），它的工具集合就是全域那組（root-only 換成樁）。所以往
 * `'general-purpose'` 這個層加工具不是把工具送進它的方式：要嘛註冊全域（自動流進去），
 * 要嘛自己註冊一個同名 subagent——那就是明著換掉 fold 補的那份，這個層也跟著合法。擋下來
 * 還附帶擋住打錯字的層名。
 */
function assertScopesHaveSubAgents(registry: PluginRegistry): void {
  const orphans = registry.tools
    .scopes()
    .filter((scope) => registry.subagents.get(scope) === undefined);
  if (orphans.length === 0) return;
  const detail = orphans
    .map((scope) => {
      const culprits = [...registry.tools.own(scope).values()].map((entry) =>
        formatOrigin(entry.origin),
      );
      return `"${scope}"（${[...new Set(culprits)].join('、')} 往它加了工具）`;
    })
    .join('；');
  throw new Error(
    `有工具註冊到不存在的 subagent 上：${detail}。` +
      `名字打錯了，或是那個 subagent 的 plugin 沒放進清單。`,
  );
}

/**
 * 以工具名為 key 的設定驗證所用的**名字宇宙**——比任何一層看得見的集合都寬。
 *
 * 四個來源：全域層、各 subagent 層、**subagent 定義自帶的 `tools`**（它們沒走
 * `tools.register()` 那條路進來，但一樣是真工具），以及組裝點宣告的
 * {@link FoldOptions.baseToolNames}（基座 middleware stack 自己註冊的那些）。
 *
 * 分成「宇宙」與「可見集合」兩件事是照 dsh 的 `ToolProviderResult.knownNames`：
 * 設定裡列到一個此處不可見、但別處確實存在的名字，是合法的，不是打錯字。
 */
/**
 * 搜尋（`grep`／`glob`／`ls`）的 meta 開不開：**root 與每個 subagent 都沒有 `permissions` 規則才開。**
 *
 * 基座的搜尋工具拿到 backend 的結果之後還會照 `permissions` 濾一次，而抓 meta 的那一層看到的是濾之前的
 * 那份——照樣放進 meta，模型看不到的路徑就會出現在畫面上。比對規則是基座沒匯出的 `filterByPermissions`，
 * 自己重寫一份寫錯的代價是外洩，所以在組裝期整類關掉，同 dsh 在工具自己那一層產生 meta 的保證
 * （它的 meta 由濾過的結果算）。**今天產品碼沒有人註冊規則**，出貨的組裝一律開著。
 */
function searchMetaAllowed(
  registry: PluginRegistry,
  permissions: readonly FilesystemPermission[],
): boolean {
  if (permissions.length > 0) return false;
  for (const [, entry] of registry.subagents.entries()) {
    if ((entry.value.permissions ?? []).length > 0) return false;
  }
  return true;
}

/**
 * 工具過濾可以指到的名字：**全域註冊的**加上基座工具名。照 dsh 的 `restrictableNames`（只含繼承來的），
 * 子代理自己那層的名字不收——遮不到的東西列了就是寫錯。
 */
function restrictableToolNames(
  registry: PluginRegistry,
  baseToolNames: readonly string[] | undefined,
): Set<string> {
  const names = new Set(registry.tools.effective().keys());
  for (const name of baseToolNames ?? []) names.add(name);
  return names;
}

function knownToolNames(
  registry: PluginRegistry,
  baseToolNames: readonly string[] | undefined,
): Set<string> {
  const names = new Set(registry.tools.effective().keys());
  for (const scope of registry.tools.scopes()) {
    for (const name of registry.tools.own(scope).keys()) names.add(name);
  }
  for (const [, entry] of registry.subagents.entries()) {
    for (const tool of entry.value.tools ?? []) names.add(tool.name);
  }
  for (const name of baseToolNames ?? []) names.add(name);
  return names;
}

/**
 * 保留名不能是真工具的名字，否則 rest 那一格會變成有歧義。
 *
 * 三個來源都要掃：全域層、各 subagent 層，以及 **subagent 定義自帶的 `tools`**。最後那個
 * 不經過 registry，漏掉它的下場是無聲的——沒給 `toolOrder` 時那個工具就以保留名活著，
 * 組裝點哪天補上清單，它會從該 subagent 的集合裡憑空消失（rest 那一格把清單列到的名字
 * 濾掉，而字面分支又永遠對不上保留名）。
 */
function assertNoReservedToolName(registry: PluginRegistry): void {
  for (const scope of [undefined, ...registry.tools.scopes()]) {
    const found =
      scope === undefined
        ? registry.tools.effective().get(TOOL_ORDER_REST)
        : registry.tools.own(scope).get(TOOL_ORDER_REST);
    if (found !== undefined) throw reservedToolNameError(found.origin);
  }
  for (const [name, entry] of registry.subagents.entries()) {
    if ((entry.value.tools ?? []).some((tool) => tool.name === TOOL_ORDER_REST)) {
      throw reservedToolNameError(entry.origin, name);
    }
  }
}

/** 保留名撞名的診斷。`subagentName` 給的是「自帶在 subagent 定義裡」那個來源。 */
function reservedToolNameError(origin: PluginOrigin, subagentName?: string): Error {
  const where =
    subagentName === undefined
      ? '註冊的工具'
      : `註冊的 subagent "${subagentName}" 自帶的工具裡有一個`;
  return new Error(
    `${formatOrigin(origin)} ${where}叫 "${TOOL_ORDER_REST}"，` +
      `那是工具呈現順序清單保留給「其餘未列出者」的那一格，不能拿來當工具名。`,
  );
}

/** 清單本身的形狀，以及列到的名字有沒有對應的工具。 */
function validateToolOrder(toolOrder: readonly string[], known: ReadonlySet<string>): void {
  const seen = new Set<string>();
  for (const name of toolOrder) {
    if (seen.has(name)) {
      throw new Error(`工具呈現順序清單裡 "${name}" 出現超過一次，排哪一個位置沒有答案。`);
    }
    seen.add(name);
  }
  if (!seen.has(TOOL_ORDER_REST)) {
    throw new Error(
      `工具呈現順序清單少了 "${TOOL_ORDER_REST}" 這一格（未列出的工具插在那裡）。` +
        `沒有它的話，之後每多一個 plugin 就會多一個沒有位置的工具。`,
    );
  }
  const unknown = toolOrder.filter((name) => name !== TOOL_ORDER_REST && !known.has(name));
  if (unknown.length > 0) {
    const knownList = [...known].sort().join('、') || '（沒有任何工具）';
    throw new Error(
      `工具呈現順序清單列了沒人註冊的工具：${unknown.map((name) => `"${name}"`).join('、')}。` +
        `目前註冊過的工具：${knownList}`,
    );
  }
}

/**
 * 套用呈現順序：列到的站在被列的位置，其餘依字典序落在 rest 那一格。
 *
 * 沒給清單就是純字典序（code-unit 比較，與 locale 無關，每台機器排出來一樣）。
 */
function orderTools(
  tools: Map<string, NamedEntry<StructuredTool>>,
  toolOrder: readonly string[] | undefined,
): StructuredTool[] {
  const present = [...tools].map(([name, entry]) => ({ name, tool: entry.value }));
  if (toolOrder === undefined) return sortedByName(present).map((item) => item.tool);
  const listed = new Set(toolOrder);
  const rest = sortedByName(present.filter((item) => !listed.has(item.name)));
  // 列到但這一層沒有的工具自然消失：全域清單列了某個只在別的 subagent 存在的工具時，
  // 這一層不該憑空多出它。
  return toolOrder.flatMap((name) =>
    name === TOOL_ORDER_REST
      ? rest.map((item) => item.tool)
      : present.filter((item) => item.name === name).map((item) => item.tool),
  );
}

/** 字典序（code-unit 比較），不用 localeCompare。 */
function sortedByName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * deny 規則折成基座的 `FilesystemPermission[]`。
 *
 * 基座的規則是**宣告順序、先命中者決定、無人命中即 allow**，所以一條 deny 自己的
 * `except` 只能寫成排在它前面的 allow。逐條 deny 緊接著自己的例外放，跨 plugin 的
 * 相對順序因此不變。
 *
 * **聯集只在一個方向上成立**：靠前的 plugin 擋掉的東西，靠後的 plugin 的例外挖不開；
 * 反過來，靠前的 plugin 的 `except` 會贏過靠後的 plugin 對同一條路徑的 deny——那個
 * allow 排在前面，先命中者決定。glob 的差集算不出來，所以這裡不修，只把它講明白：
 * `except` 的射程是整份規則表往後全部，不是只有自己那一條 deny。真的要一條擋死的
 * 規則，就不要有人替它開例外。
 *
 * **`delete` 是例外，而且方向相反。** 它不走 `decidePathAccess()` 那條先命中者決定的路，
 * 而是 `findDeleteDenyPatterns()`：目標可能是目錄時（遞迴刪除會掃掉整棵子樹）它**完全
 * 忽略 allow 規則**，只要有任何一條 deny 可能命中目標或其後代就擋。所以 `except` 在那條
 * 路徑上挖不開任何東西——射程「整份規則表往後全部」在 `delete` 上不成立。方向是
 * fail-closed，不是破口，但別以為 `except` 開的洞刪得掉東西。
 */
function foldPermissions(registry: PluginRegistry): FilesystemPermission[] {
  const rules: FilesystemPermission[] = [];
  for (const entry of registry.permissions.rules()) {
    const { paths, except } = entry.value;
    if (except.length > 0) {
      rules.push({ operations: ['read', 'write'], paths: [...except], mode: 'allow' });
    }
    rules.push({ operations: ['read', 'write'], paths: [...paths], mode: 'deny' });
  }
  return rules;
}

/**
 * 核准閘門折成一個 `wrapToolCall` middleware。
 *
 * **這裡有兩個 dsh 時刻疊在一起，值得說破。** 閘門答的是 `tools/pre-execute`
 * （決策詞彙見 {@link ./approval.ts}），但**承載它的是一個 `tools/execute` 位置的
 * `wrapToolCall`**——dsh 那兩個時刻是兩層權限不同的東西，我們這側是同一種機制的兩個
 * 陣列位置，而位置由這個檔案決定、不由註冊順序決定。索引見 `apps/harness/src/interception-index.test.ts`。
 *
 * **這一格取代了整個 `foldInterrupts`。** 舊版在這裡做四件事：工具名存在檢查、
 * 核准政策開關、缺 checkpointer 即拋、以及同工具多方標記逐欄位 OR。四件全部消失，
 * 而消失的原因各不相同，值得逐條說清楚（決議見
 * [#111](https://github.com/DemianLi/nexus-agent/issues/111)）：
 *
 * - **工具名存在檢查**：沒有主體了。閘門不再以工具名為 key，名字是執行當下拿到的。
 *   那條檢查當初的定位就寫著「止血不是根治」，根治的方式正是讓名字不再是宣告出來的。
 * - **核准政策開關**：從「建構期拋」變成「執行期確定性拒絕」——(c) 的拍板。
 * - **缺 checkpointer 即拋**：同上，變成另一個理由的確定性拒絕。**這一條不能只是刪掉**：
 *   實測沒有 checkpointer 時 `interrupt()` 是執行期拋 `No checkpointer set`，所以要在
 *   問人之前就攔下來，不是讓它炸。
 * - **多方標記 OR**：waterfall 本來就是這個語義的一般化——第一個回非 allow 的人決定，
 *   而且它回的是**自己的理由**，不是把幾個人的理由用「；」黏起來。
 *
 * `enabled` 與 checkpointer 這兩格答的是不同的問題，映射見 {@link ApprovalChannel}。
 */
function foldApprovalGate(registry: PluginRegistry, options: FoldOptions): AgentMiddleware {
  const channel: ApprovalChannel = deriveApprovalChannel({
    ...(options.approvals?.enabled !== undefined && {
      approvalsEnabled: options.approvals.enabled,
    }),
    hasCheckpointer: options.checkpointer !== undefined && options.checkpointer !== false,
  });
  return createApprovalGateMiddleware(
    registry.approvals.listeners(),
    channel,
    registry.sessions,
    options.approvals?.policy,
  );
}

/**
 * 背景子代理的核准閘門：管道固定 `policy-never`（[#324](https://github.com/DemianLi/nexus-agent/issues/324)、[#737](https://github.com/DemianLi/nexus-agent/issues/737)），
 * 要人看過的操作一律確定性回絕，不發中斷。照 dsh 委派時把子代理的核准政策釘成 `never`
 * （`packages/subagent/subagent/src/child-agent.ts:220-247`）；背景子代理被叫醒時主對話沒有在等，沒有人可以按。
 *
 * **由 {@link ./subagent-graph.ts | compileSubagentGraph} 的呼叫端在編背景圖時傳進去**，換掉 fold 放進子代理規格的那一顆（前景用的、跟 root 同一顆）。
 * 組裝時就分開，不在執行期查身分——分得開就沒有「查不到是誰」那幾種情況。listener 與審計通道同一組：判斷「要不要問」不因誰叫而變，
 * 變的是問不問得到人。無狀態，一份走遍每張背景圖。
 *
 * @param registry - 載入完的註冊表（listener 與審計通道從這裡來）。
 */
export function createBackgroundApprovalGate(registry: PluginRegistry): AgentMiddleware {
  return createApprovalGateMiddleware(
    registry.approvals.listeners(),
    { kind: 'policy-never' },
    registry.sessions,
  );
}

/**
 * root 的 middleware 疊：把槽位表（{@link MiddlewareSlot}）展成一份清單——圍堵在最前，`prepend` 的接著，
 * 核准閘門再接著，其餘依註冊順序。**子代理那一疊從同一張表導出**（{@link foldSubagentMiddleware}），
 * 下面每一條位置的理由兩邊共用。
 *
 * **與 dsh 的偏離**：dsh 的匿名表只有 `append`，沒有 prepend 這個概念。deepagents
 * 的 middleware 是一份順序有意義的陣列，「插到最前」表達不出來，所以退到最接近的
 * 實作：一張表加一次穩定分割，兩個分區各自維持註冊順序。
 *
 * **圍堵是第 0 格，而那是約束不是偏好。** `wrapToolCall` 是層層相包的，陣列越前面越外層，
 * 而圍堵的射程要涵蓋內層**每一個** middleware——包含以 `prepend` 掛進來的那些，也包含
 * 核准閘門自己。漏在它外面的任何一層一拋，就是整場 run 死掉，而那正是這整件事要修的
 * 東西（[#159](https://github.com/DemianLi/nexus-agent/issues/159)）。它由 fold 自己建，
 * 不經過 registry，所以沒有「這次清單裡有沒有」這回事。
 *
 * **核准閘門排在 `prepend` 之後、其餘之前，而那個位置有唯一正確答案。** 這條論證沒有變，
 * 只是外面那一層從「某個 plugin 掛的圍堵」變成 fold 自己打底的那份，因此**更強**：
 *
 * - **不能排在最前**。最外層是圍堵，閘門自己的 bug 也要在它裡面。把閘門推到它外面，
 *   閘門一拋就整場 run 死掉。實測中斷穿得過圍堵的 `isGraphBubbleUp` 分支，所以待在
 *   裡面不會讓核准點消失。
 * - **不能排在其餘之後**。閘門越內層，能繞過它的 middleware 越多——排最後等於任何一個
 *   plugin middleware 都可以在它之前把工具跑掉。
 *
 * **摘要器排在閘門之後、其餘之前，而它的位置不決定包裹層次。** 上面那整段論證只管
 * `nexusApprovalGate` 這種**名字不撞**的 middleware——它們是 novel entry，被基座插在
 * default 段與 tail 段之間，陣列順序就是包裹順序。摘要器不一樣：它的名字撞上內建那個，
 * 會被**原地取代回 default 段**，所以它在這個陣列裡排第幾根本影響不到它最後跑在哪一層。
 * 它的位置只決定一件事——**同名的兩個誰贏**（`mergeMiddleware$1` 是一個以 `name` 為鍵的
 * `Map`，後設的覆蓋前設的）。排在所有 registry middleware 之前 ＝ 任何 plugin 註冊一個
 * 同名的都蓋得過我們這份，那就是「打底」的意思，跟 {@link foldSubAgents} 同一條規則。
 *
 * 放在閘門**之後**而不是陣列最前面，純粹是為了不讓下一個讀這段註解的人以為上面那個
 * 「閘門不能排在最前」的結論改了。
 *
 * **提醒器排在摘要器之後，而那個位置一樣不決定包裹層次。** 理由跟上一段不同：它的名字
 * 不撞任何內建的，所以它是 novel entry、順序就是包裹順序——但**它跟摘要器之間沒有層次
 * 可言**。摘要器只定義 `wrapModelCall`（`deepagents@1.13.1`，
 * `dist/langsmith-zm0ILQsV.js:3193-3195`），那是模型節點**內部**的一層；提醒器是
 * `beforeModel`，那是模型節點**之前**的一個獨立節點。誰先跑由圖決定，不由這個陣列決定。
 *
 * 所以放在摘要器後面純粹是讓這一段讀起來跟它上面那兩根一致：我們自己打底的都排在
 * registry middleware 之前，同名的誰都蓋得過。
 *
 * **用量記錄器排在其餘 plugin middleware 之前，而那個位置有代價。** 它的名字不撞任何
 * 東西，所以位置決定的是包裹層次：排在 plugin middleware 外層 ＝ 一個自己重試模型的
 * plugin middleware，重試幾次都只會被記一筆。dsh 那側是**每一次 attempt 各算一筆再加
 * 總**（`packages/llm/token-meter/src/turn-usage.ts` 的 `llm/retry-started` 會重開一個
 * attempt）。今天樹裡沒有那種 plugin，所以先照全樹一致的順序放；哪天有了，把它移到
 * 最內層就對——**但那會反轉 {@link foldSubAgents} 那條「同名時 subagent 自己帶的贏」
 * 的政策**，兩件事要一起想。
 */
function foldMiddleware(slots: readonly MiddlewareSlot[]): AgentMiddleware[] {
  return slots.flatMap((slot) => takeFrom(slot.root));
}

/**
 * 一個子代理的 middleware 疊：同一張表，取每一列的子代理那一欄。
 *
 * @param slots - 槽位表。
 * @param spec - 這個子代理的規格；「子代理自帶」那一列從它取。
 * @returns 依表的順序展開的 middleware。
 */
function foldSubagentMiddleware(
  slots: readonly MiddlewareSlot[],
  spec: NexusSubAgent,
): AgentMiddleware[] {
  return slots.flatMap((slot) => takeFrom(slot.subagent, spec));
}

/**
 * 槽位表的一列：一個位置，以及 root 與子代理各自從這個位置拿什麼。
 *
 * **這張表取代了兩份手寫的清單**（#664）：以前 root 是 `foldMiddleware` 的 16 個位置參數加一個陣列，子代理是
 * `foldSubAgents` 的 20 欄 context 加另一個陣列，對齊只靠每一格的「同 root」註解。漏接子代理沒有任何東西會紅：
 * 漏核准閘門「默默地讓 subagent 失去核准」，漏用量記錄器「沒有人會紅」。現在新增一顆只寫一列，子代理那一疊自動
 * 跟上；要漏掉就得在那一列明寫 {@link NONE}。
 *
 * **偏離（登記）**：dsh 的子代理不另組一份，`applyChildComposition` 第一步就是 `composeFrom(childCtx, parent.ctx)`，
 * 併入父代理保留的同一版組合，所以「子代理沒併入」在呼叫點寫不出來（dsh
 * `packages/subagent/subagent/src/child-agent.ts:190-205`、`packages/preset/agent-preset-registry/src/index.ts:268-273`，
 * `477b4f4`）。**表達不出來的理由**：deepagents 1.13.1 沒有「子代理繼承 root middleware」的通道——
 * `SubAgentBase.middleware` 的說明是 “Additional middleware to append after default_middleware”
 * （`dist/agent-D50BBbJT.d.ts`），執行期的 `buildSubagentMiddleware` 只合子代理預設 stack、這個 spec 的 `middleware`、
 * harness profile 的 `extraMiddleware` 與快取／記憶那幾顆，root 的 `middleware` 參數不在裡面；唯一的例外是基座自己補的
 * `general-purpose`（`appendNew: false`，只原地換掉同名的預設），而 fold 一律自己補它。同時進 root 與子代理的只有
 * harness profile 的 `extraMiddleware`，它落在 tail 段、又是以模型為鍵的全域註冊，排不出「圍堵在第 0 格」
 * 「plugin 在 `spec.middleware` 外層」這些位置。**退到**：fold 內一張有序的槽位表導出兩份陣列，這是在只能逐個注的
 * 前提下最接近 `composeFrom` 的形狀。
 */
interface MiddlewareSlot {
  /** 這一列的名字，診斷與讀表用；不是 middleware 自己的 `name`。 */
  readonly name: string;
  /** root 取什麼。 */
  readonly root: SlotTake<[]>;
  /** 每個子代理取什麼；`spec` 是那個子代理的規格。 */
  readonly subagent: SlotTake<[spec: NexusSubAgent]>;
}

/** 一列在一個 agent 身上產出的東西：一顆、一批，或什麼都沒有。 */
type SlotContribution = AgentMiddleware | readonly AgentMiddleware[] | undefined;

/**
 * 一列在某個 agent 身上怎麼取：
 *
 * - `none`：不給。**這是明寫的**，不是漏接。
 * - `same`：交出一份現成的——同一個實例走遍每個拿它的 agent（無狀態的那些），或是另一顆（核准閘門）。
 * - `make`：每次展開時現建——逐個 agent 各建一份（有閉包狀態的那些），或從這個 agent 的規格現取。
 */
type SlotTake<Args extends unknown[]> =
  | { readonly kind: 'none' }
  | { readonly kind: 'same'; readonly value: SlotContribution }
  | { readonly kind: 'make'; readonly make: (...args: Args) => SlotContribution };

/** 這個 agent 不拿這一列。 */
const NONE = { kind: 'none' } as const;

function same(value: SlotContribution): {
  readonly kind: 'same';
  readonly value: SlotContribution;
} {
  return { kind: 'same', value };
}

function make<Args extends unknown[]>(
  build: (...args: Args) => SlotContribution,
): { readonly kind: 'make'; readonly make: (...args: Args) => SlotContribution } {
  return { kind: 'make', make: build };
}

/** root 與每個子代理共用同一個實例（或同樣是「沒有」）。 */
function shared(name: string, value: SlotContribution): MiddlewareSlot {
  return { name, root: same(value), subagent: same(value) };
}

/** root 與每個子代理各建一份：它的狀態在閉包裡，共用會讓兩個 agent 串台。 */
function perAgent(name: string, build: () => SlotContribution): MiddlewareSlot {
  return { name, root: make(build), subagent: make(build) };
}

/** 只給 root。 */
function rootOnly(name: string, root: SlotTake<[]>): MiddlewareSlot {
  return { name, root, subagent: NONE };
}

/** 只給子代理。 */
function subagentOnly(name: string, subagent: SlotTake<[spec: NexusSubAgent]>): MiddlewareSlot {
  return { name, root: NONE, subagent };
}

/** 把一列的一欄展開成零到多顆 middleware。 */
function takeFrom<Args extends unknown[]>(take: SlotTake<Args>, ...args: Args): AgentMiddleware[] {
  const value =
    take.kind === 'none' ? undefined : take.kind === 'same' ? take.value : take.make(...args);
  if (value === undefined) return [];
  return Array.isArray(value)
    ? [...(value as readonly AgentMiddleware[])]
    : [value as AgentMiddleware];
}

/**
 * plugin 註冊的 middleware，照 `prepend` 分成兩區，各自維持註冊順序。
 *
 * root 與每個子代理拿的是**同一份切法、同一批實例**（[#327](https://github.com/DemianLi/nexus-agent/issues/327)），
 * 所以切法只寫在這裡一次：兩邊各切一次的話，哪天一邊改了分區規則，子代理的順序會悄悄跟 root 不一樣。
 */
function pluginMiddleware(
  registry: PluginRegistry,
  backend: AnyBackendProtocol | undefined,
): PluginMiddleware {
  // **工廠在這裡攤成實例**（`useWithBackend`，#388）。沒有 backend 就整條略過：那一種 middleware
  // 要的就是檔案系統，沒有它的時候「什麼都不做」是唯一誠實的結果，見
  // `MiddlewareRegistrationPoint.useWithBackend`。
  const materialize = (entry: NamedEntry<MiddlewareRegistration>): AgentMiddleware | undefined =>
    entry.value.build === undefined
      ? entry.value.middleware
      : backend === undefined
        ? undefined
        : entry.value.build(backend);
  const isMiddleware = (value: AgentMiddleware | undefined): value is AgentMiddleware =>
    value !== undefined;
  const entries = registry.middleware.list();
  return {
    prepended: entries
      .filter((entry) => entry.value.prepend)
      .map(materialize)
      .filter(isMiddleware),
    rest: entries
      .filter((entry) => !entry.value.prepend && !entry.value.last)
      .map(materialize)
      .filter(isMiddleware),
    last: entries
      .filter((entry) => entry.value.last)
      .map(materialize)
      .filter(isMiddleware),
  };
}

/** {@link pluginMiddleware} 攤平之後的兩區。 */
interface PluginMiddleware {
  prepended: AgentMiddleware[];
  rest: AgentMiddleware[];
  /** 以 `last` 掛的（#720）：root 排在其餘 plugin 之後，子代理連它自帶的也排在它前面。 */
  last: AgentMiddleware[];
}

/**
 * 攤進子代理的那一份：{@link pluginMiddleware} 去掉名字撞上摘要器的那一顆。
 *
 * **偏離（登記，#327 動工時 demian 拍板）**：plugin 用同名換掉摘要器（`apps/harness/src/contained-backend.ts`
 * 教的那條路）的那一顆是**一份實例**，而摘要器的 `sessionId` 在閉包裡。攤過去的話它會蓋掉 {@link foldSubAgents}
 * 替每個子代理各建的那份，root 與子代理的歷史混進同一個檔——{@link foldSummarizer} 做成工廠要防的正是這件事。
 * dsh 那側子代理拿到同一套壓縮設定、狀態逐 session 分開；我們沒有「逐個建」的註冊介面，所以退一步：**那一顆只到
 * root**，子代理照舊用 fold 逐個建的那份（明著關掉摘要時是基座自己的）。真的要子代理也吃那份設定時，開卡加工廠。
 *
 * 只挑這一個名字，不是「撞上基座的一律不給」：其他撞名的今天樹上一顆都沒有，也沒有量過它們的閉包。
 */
function subagentPluginMiddleware({ prepended, rest, last }: PluginMiddleware): PluginMiddleware {
  const keep = (middleware: AgentMiddleware) =>
    (middleware as { name?: string }).name !== SUMMARIZATION_MIDDLEWARE_NAME;
  return { prepended: prepended.filter(keep), rest: rest.filter(keep), last: last.filter(keep) };
}

/**
 * 提醒器，或在明著關掉時回 `undefined`。
 *
 * **回一份實例而不是工廠，跟 {@link foldSummarizer} 相反，而且是量過的差別**：摘要器的
 * `sessionId` 在 closure 裡，共用會讓兩個 agent 的歷史混進同一個檔；提醒器的 closure 裡
 * 只有設定，鏈每次從 `state.messages` 現算，而 `state` 本來就逐 thread、逐 agent 各一份。
 *
 * @param options - 組裝點自有的那些。
 * @param sessions - 註冊表的 `sessions` 通道：提醒也記進日誌（#305）。它是查詢不是狀態，共用照舊成立。
 * @returns 一份可以掛在任意多個 agent 上的 middleware，或 `undefined`。
 */
function foldRepeatReminder(
  registry: PluginRegistry,
  options: FoldOptions,
): AgentMiddleware | undefined {
  const settings = repeatReminderDisposition(registry, options);
  const controller = options.modelSelection;
  const notices =
    controller === undefined ? undefined : (log: SessionLog) => controller.noticeFor(log);
  if (settings === undefined) {
    // 提醒關著：通知沒有節點可借，另掛一顆（多一個 super-step，只在有模型選擇的組裝上付）。
    return notices === undefined
      ? undefined
      : createStepNoticeMiddleware(notices, registry.sessions);
  }
  return createRepeatReminder(settings, registry.sessions, notices);
}

/**
 * 這次組裝要不要提醒器、用哪一份設定——**四態，依序問**。
 *
 * ```
 * 1. 組裝點明著傳了 `repeatReminder`        → 它贏（`false` 就是不要）
 * 2. 部署設定層提供了服務                    → 用那一份（條目在清單上、沒被關）
 * 3. 條目在清單上但被明著關掉                → 真的不掛
 * 4. 以上都沒有                              → 內建預設（維持今天的行為）
 * ```
 *
 * **第 1 與第 2 的先後是拍板過的**（[#456](https://github.com/DemianLi/nexus-agent/issues/456)）：
 * `FoldOptions` 是低層嵌入方與測試走的程式路徑（[#455](https://github.com/DemianLi/nexus-agent/issues/455)
 * 的分工），最靠近呼叫端的那一句話應該贏。**今天沒有人踩到這個先後**：量過，載出貨
 * `cordis.yml` 的六個測試檔裡，傳這幾個 option 的是零個，而產品程式碼一處都沒有在傳。
 *
 * **第 3 與第 4 分得開才是這一整張卡的關鍵。** 兩者在 `services.get()` 眼中一模一樣
 * （都是 `undefined`），而正確答案相反：把第 4 態也當成關掉的話，188 個手搭清單的
 * `createNexusAgent` 呼叫點會**靜靜**少掉這一顆；把第 3 態當成預設的話，設定檔裡的
 * `disabled: true` 就只是一行沒有作用的字。分野的載體是
 * {@link ./registry.ts | DisabledEntryView}。
 *
 * @param registry - 已經跑完 `loadPlugins()` 的 registry。
 * @param options - 組裝點自有的那些。
 * @returns 正規化過的設定，或「這次不掛」。
 */
function repeatReminderDisposition(
  registry: PluginRegistry,
  options: FoldOptions,
): RepeatReminderSettings | undefined {
  if (options.repeatReminder !== undefined) {
    return options.repeatReminder === false
      ? undefined
      : resolveRepeatReminderSettings(options.repeatReminder);
  }
  // 條目提供的那一份**已經正規化過**（在它的 `apply` 裡），這裡不再 resolve 一次。
  const provided = registry.services.get(REPEAT_REMINDER_SERVICE);
  if (provided !== undefined) return provided;
  if (registry.disabledEntries.has(REPEAT_REMINDER_PLUGIN_NAME)) return undefined;
  return resolveRepeatReminderSettings();
}

/**
 * 摘要器的**工廠**。明著關掉時工廠給的是同名空殼。
 *
 * **回工廠而不是一份實例，是量出來的。** `createSummarizationMiddleware` 把
 * `sessionId` 與 `tokenEstimationMultiplier` 放在 closure 裡（`let sessionId = null`），
 * 歷史檔名是 `${historyPathPrefix}/${sessionId}.md`。一份實例同時掛在 root 與每個
 * subagent 上的話，**它們共用那個 closure**——實測到的下場是 root 與 subagent 的歷史
 * 一起 append 進同一個檔，一份摘要裡混著兩個 agent 的對話。
 *
 * 這也是基座的形狀：`createSubagentDefaultMiddleware` 每個 subagent 各呼叫一次
 * `createSummarizationMiddleware({ backend })`，不共用。基座另外還在 `task` 工具裡替
 * subagent 的 state 塞一個新的 `_summarizationSessionId`，但那條路徑在共用實例底下
 * 沒有把兩邊分開——所以答案是別共用，不是靠那個欄位。
 *
 * **關掉是給空殼，不是不給。** 不給的話基座會補回它自己那顆——一組沒有人在檢查的門檻，
 * 加上寫死的 `/conversation_history`，那正是
 * [#142](https://github.com/DemianLi/nexus-agent/issues/142) 要消滅的狀態。同名取代是
 * 唯一能讓基座那顆消失的縫（見 {@link SUMMARIZATION_MIDDLEWARE_NAME}）；基座的
 * `excludedMiddleware` 掛在按模型名稱查的行程級 profile 上，做不成「這次組裝關掉」。
 * 空殼沒有任何鉤子、也沒有 `stateSchema`：基座的 `task` 照樣往子代理的 state 塞
 * `_summarizationSessionId`，實測委派不受影響（`summarization.test.ts`）。
 * [#446](https://github.com/DemianLi/nexus-agent/issues/446)。
 *
 * **沒有 default backend 又沒關掉是拋，不是靜默跳過。** 這一格的失敗方向有主人：
 * 靜默跳過等於讓基座那顆回來，而它會長得跟「一切正常」一模一樣。同型的前例是
 * {@link foldBackend} 對「掛了路由卻沒給兜底」那條。**檢查跑在這裡一次**，工廠被呼叫
 * 幾次都不重驗；剪刀的預算也是。
 *
 * `registry.sessions` 一路傳下去是為了 `compaction/summary` 那顆事件
 * （[#143](https://github.com/DemianLi/nexus-agent/issues/143)）。**它跟工廠不衝突**：
 * 那個通道無狀態，逐個 agent 建的是摘要器不是它，每次呼叫現問「這次屬於哪一份日誌」。
 *
 * @param registry - 折的那張註冊表：`sessions`，以及剪刀預算走的那兩條（服務與
 *   {@link ./registry.ts | DisabledEntryView}，見 {@link toolResultPruningDisposition}）。
 * @param options - 組裝點自有的那些。
 * @returns 每呼叫一次就給一份新的摘要器（或空殼）。
 */
function foldSummarizer(registry: PluginRegistry, options: FoldOptions): () => AgentMiddleware {
  // **在摘要那條早退之前就問。** 關掉時照樣驗：設定寫錯在載入期失敗，見
  // {@link FoldOptions.toolResultPruning}。挪到早退之後就等於默默放掉這條不變式。
  const pruning = toolResultPruningDisposition(registry, options);
  const settings = summarizationDisposition(registry, options);
  // **空殼要在拋之前。** 不要摘要的組裝沒有歷史要寫，也就不必有 backend；而「不要」今天
  // 有兩個來源（明著傳的 `false`、條目的 `disabled: true`），兩個都走這條早退。
  if (settings === false) return () => ({ name: SUMMARIZATION_MIDDLEWARE_NAME });
  const backend = options.defaultBackend;
  if (backend === undefined)
    throw new Error(
      '要配摘要器，但組裝點沒給 default backend——摘要器把歷史寫進 backend，沒有它就沒有' +
        '地方放。給一個 default backend、明著傳 `summarization: false`，或在部署設定裡把' +
        ' `@nexus/core/summarization` 那一列標成 `disabled: true`。',
    );
  // **一次組裝一本，root 與子代理共用**：放在工廠外面，每呼叫一次工廠才不會各建一本、把借錨切碎。
  const book = options.tokenAnchorBook ?? new TokenAnchorBook();
  return () =>
    createSummarizer(backend, settings, book, registry.sessions, pruning, options.modelLimits);
}

/**
 * 這次組裝要不要摘要、用哪一份設定——**四態，依序問**，同
 * {@link repeatReminderDisposition}。
 *
 * **第 3 態（條目被明著關掉）落在 `false`，而 `false` 在這一顆是「一顆同名空殼」，
 * 不是「沒有」。** 基座無條件建一顆摘要器，同名取代是唯一消得掉它的辦法；真的不掛的話
 * 它會補回來，而它的兜底門檻在測試裡碰不到——那會長得跟「關掉了」一模一樣。
 *
 * **這是 `foldSummarizer` 裡唯一讀 `options.summarization` 的地方**，刻意的：第二個讀取點
 * 會讓「條目關掉」與「明著傳 false」在某一處悄悄分岔，而今天這兩個述詞永遠同進同出，
 * 沒有任何測試看得到那個分岔。
 *
 * @param registry - 已經跑完 `loadPlugins()` 的 registry。
 * @param options - 組裝點自有的那些。
 * @returns 正規化過的設定，或 `false`＝發一顆同名空殼。
 */
function summarizationDisposition(
  registry: PluginRegistry,
  options: FoldOptions,
): SummarizationSettings | false {
  if (options.summarization !== undefined)
    return options.summarization === false
      ? false
      : resolveSummarizationSettings(options.summarization);
  const provided = registry.services.get(SUMMARIZATION_SERVICE);
  if (provided !== undefined) return provided;
  if (registry.disabledEntries.has(SUMMARIZATION_PLUGIN_NAME)) return false;
  return resolveSummarizationSettings();
}

/**
 * 「先讀後改」策略的**工廠**，或在明著關掉時回 `undefined`。
 *
 * **回工廠而不是一份實例**，同 {@link foldSummarizer}：觀測紀錄在 closure 裡，共用會讓
 * root 讀過的檔變成 subagent 也可以直接改——那正好把這件事要擋的東西放掉。dsh 那側的
 * owner 是 `agent.session`，而那邊 agent id ≡ session id、child agent 各自一份，所以
 * 「逐個 agent 一份」不是我們的發明，是照抄。
 *
 * **沒有 backend 又沒關掉是拋，不是靜默跳過。** 拿不到版本 token 的策略沒有東西可以比，
 * 而它會長得跟「一切正常」一模一樣。同型的前例是 {@link foldSummarizer}。
 *
 * **三態不是四態。** 這一顆沒有設定，所以「條目在場」與「沒有經過部署設定層」的正確答案
 * 都是「照預設開著」，一顆只能表達「開著」的服務帶不了任何資訊——要分的只有「有沒有被
 * 明著關掉」。細節見 {@link ./observation.ts | observationPolicyPlugin}。
 *
 * @param registry - 已經跑完 `loadPlugins()` 的 registry，這裡只問它
 *   {@link ./registry.ts | DisabledEntryView}。
 * @param options - 組裝點自有的那些。
 * @param backend - {@link foldBackend} 折出來的那個。
 * @returns 每呼叫一次就給一份新的策略 middleware，或 `undefined`。
 */
function foldObservationPolicy(
  registry: PluginRegistry,
  options: FoldOptions,
  backend: AnyBackendProtocol | undefined,
): (() => AgentMiddleware) | undefined {
  if (options.observationPolicy === false) return undefined;
  // **這一格要問在拋之前。** `disabled: true` 是第二條正當的「不要」，而不要的組裝不必
  // 有 backend——問在拋之後的話，一個正確關掉了它、又沒有 backend 的組裝會當場炸。
  if (
    options.observationPolicy === undefined &&
    registry.disabledEntries.has(OBSERVATION_POLICY_PLUGIN_NAME)
  )
    return undefined;
  if (backend === undefined)
    throw new Error(
      '要配「先讀後改」策略，但這次組裝一個 backend 都沒有——策略要從 backend 取版本' +
        'token，沒有它就沒有東西可以比。給一個 default backend、明著傳' +
        '`observationPolicy: false`，或在部署設定裡把 `@nexus/core/observation-policy` ' +
        '那一列標成 `disabled: true`（三者都等於接受盲改）。',
    );
  return () => createObservationPolicy(backend);
}

/**
 * 用量記錄器，或在明著關掉時回 `undefined`——**三態，依序問**。
 *
 * ```
 * 1. 組裝點明著傳了 `modelUsage: false`     → 不要
 * 2. 條目在清單上但被明著關掉               → 不要
 * 3. 以上都沒有                             → 掛著（維持今天的行為）
 * ```
 *
 * **三態不是四態**，同 {@link foldObservationPolicy}：這一顆沒有設定，「條目在場」與
 * 「沒有經過部署設定層」的正確答案都是「照預設開著」。細節見
 * {@link ./model-usage.ts | modelUsagePlugin}。
 *
 * **回一份實例而不是工廠**，跟「先讀後改」相反而且是量過的差別：這一顆的 closure 裡
 * 一個狀態都沒有，鏈與身分每次從執行期的 `configurable` 現算。見
 * {@link createModelUsageRecorder}。
 *
 * **沒有「沒有 X 就拋」那一條。** 它要的 `sessions` 通道每個 registry 都有，而
 * `forCall` 回 `not-attached` 是**常態不是異常**（檔頭最後一段：`eval/runner.ts`、
 * `spike` 與絕大多數測試的組裝都不接日誌）。所以它跟摘要器、「先讀後改」那兩顆不同型
 * ——那兩顆缺了 backend 會長得跟一切正常一樣，這一顆缺了日誌本來就該安靜。
 *
 * @param registry - 已經跑完 `loadPlugins()` 的 registry。
 * @param options - 組裝點自有的那些。
 * @returns 一份可以掛在任意多個 agent 上的 middleware，或 `undefined`。
 */
function foldModelUsage(
  registry: PluginRegistry,
  options: FoldOptions,
): AgentMiddleware | undefined {
  if (options.modelUsage === false) return undefined;
  if (options.modelUsage === undefined && registry.disabledEntries.has(MODEL_USAGE_PLUGIN_NAME))
    return undefined;
  return createModelUsageRecorder(registry.sessions);
}

/**
 * 耐久檢查點（#599）：**兩態**——條目被明著關掉就不要，否則掛著。組裝點沒有旗標：它沒有
 * 要調的東西，而「這次組裝不接持久化」本來就讓它什麼都不做（沒有排空者，`flush` 立刻
 * resolve）。
 *
 * 回一份實例，同 {@link foldModelUsage}：closure 裡沒有狀態。見
 * {@link ./session-checkpoint-policy.ts | createSessionCheckpointMiddleware}。
 *
 * @param registry - 已經跑完 `loadPlugins()` 的 registry。
 * @returns 一份可以掛在任意多個 agent 上的 middleware，或 `undefined`。
 */
function foldSessionCheckpoint(registry: PluginRegistry): AgentMiddleware | undefined {
  if (registry.disabledEntries.has(SESSION_CHECKPOINT_PLUGIN_NAME)) return undefined;
  return createSessionCheckpointMiddleware(registry.sessions);
}

/**
 * 這次組裝的剪刀預算——**四態，依序問**，同
 * {@link repeatReminderDisposition}。第 3 態（條目被明著關掉）落在 `false`，不是
 * `undefined`：消費端的形狀是 `ToolResultPruneConfig | false`，`false` 才是「不剪」。
 *
 * **條目提供的那一份已經驗過**（在它的 `apply` 裡），這裡不再驗一次。
 *
 * @param registry - 已經跑完 `loadPlugins()` 的 registry。
 * @param options - 組裝點自有的那些。
 * @returns 要用的預算，或 `false`＝不剪。
 */
function toolResultPruningDisposition(
  registry: PluginRegistry,
  options: FoldOptions,
): ToolResultPruneConfig | false {
  if (options.toolResultPruning !== undefined)
    return resolveToolResultPruneConfig(options.toolResultPruning);
  const provided = registry.services.get(TOOL_RESULT_PRUNE_SERVICE);
  if (provided !== undefined) return provided;
  if (registry.disabledEntries.has(TOOL_RESULT_PRUNER_PLUGIN_NAME)) return false;
  return resolveToolResultPruneConfig(undefined);
}

/** 有人掛過路由就包成 `CompositeBackend`，否則原樣交出組裝點給的那個。 */
function foldBackend(
  registry: PluginRegistry,
  defaultBackend: AnyBackendProtocol | undefined,
): AnyBackendProtocol | undefined {
  const mounts = registry.backend.mounts();
  if (mounts.length === 0) return defaultBackend;
  if (defaultBackend === undefined) {
    const cited = [...new Set(mounts.map(([, entry]) => formatOrigin(entry.origin)))].join('、');
    throw new Error(
      `${cited} 掛了 backend 路由，但組裝點沒給 default backend。` +
        `路由是分支，沒有兜底的那個就沒有東西可以接住其餘路徑。`,
    );
  }
  const routes = Object.fromEntries(mounts.map(([prefix, entry]) => [prefix, entry.value]));
  return new CompositeBackend(defaultBackend, routes);
}

/**
 * fold 自己補的 `general-purpose`：**基座那份的複本，差在它拿得到我們的 stack。**
 *
 * 基座只在 `subagents` 裡沒有叫 `general-purpose` 的東西時才自己補一個
 * （`deepagents@1.13.1`，`dist/langsmith-zm0ILQsV.js` 的 `createDeepAgent`），而它補的那份
 * 走 `mergeMiddlewareStack(gp, customMiddleware, [], { appendNew: false })`——**名字不撞內建
 * 的一律丟掉**。我們的 stack 除了摘要器全是新名字，所以圍堵、中止、閘門、先讀後改、提醒、
 * 起訖、用量、解不開的參數一顆都沒進去；撞名留下來的摘要器是 root 那一份實例，歷史會混進
 * 同一個檔（見 {@link foldSummarizer}）。在產品組裝上實測過：被標成 `ask` 的工具照跑、
 * 沒有中斷、沒有它自己的會話日誌，而 `task` 的描述對模型列著它。
 *
 * 所以 fold 自己補，讓它跟每個註冊進來的 subagent 一樣走 {@link foldSubAgents}；基座看到
 * 同名的就不補了。**有 plugin 註冊了同名的就不補**——明著換掉這一份是那個 plugin 的事，
 * 它拿到的一樣是整組 stack。
 *
 * **對照 dsh**：標準 preset 的委派是明著掛的一列 `tool-subagent`（`provider: spawn`，
 * `packages/preset/agent-presets/presets/standard/agent.cordis.yml`，SHA
 * `c291e7961a515f6d7af9304e7fd1d257929aef26`）。spawn 出來的是同一個 cordis context 上的
 * 一般 child agent，全域的 `tools/pre-execute` 照樣經過它（`packages/core/tools/src/index.ts`
 * 的 `scopeTarget(this, exec.agent)`）。那裡沒有「沒人設定就自動冒出來、閘門管不到」的
 * 子代理；這裡把它變成 fold 明著註冊的一個。
 *
 * 照抄的：名字、描述、提示詞與 `mode` 取基座匯出的 `GENERAL_PURPOSE_SUBAGENT`；root 的
 * `skills` 照基座那份傳過去（`apps/harness/src/skills.test.ts` 守著）。
 *
 * **抄不到的兩格，是偏離**：harness profile 對 gp 提示詞的改寫（`applyProfilePrompt`）與
 * profile 的 `generalPurposeSubagent` 設定。profile 是基座在 fold 之後才從 model 解出來的，
 * 這裡看不到。**自有組裝點（`agent-assembly.ts`）不套 profile**，所以這兩格不是 no-op 而是不存在：
 * 模型字串不影響 gp 的提示詞。
 *
 * **工具不照抄，也是刻意的**：基座那份拿 root 的 `tools` 原樣（`effectiveTools`），root-only
 * 工具在它裡面是原件、叫得到。這裡走 {@link foldSubAgents} 的集合，換成拒絕樁，跟每個
 * subagent 一致。
 *
 * @param skills - root 的 skills 來源。
 * @returns 還沒補 stack 的 spec，交給 {@link foldSubAgents}。
 */
function generalPurposeSpec(skills: readonly string[]): SubAgent {
  return {
    ...GENERAL_PURPOSE_SUBAGENT,
    // 空的就不要放，同 root 那格：空陣列會讓基座建一個掃不到東西的 skills middleware。
    ...(skills.length > 0 && { skills: [...skills] }),
  };
}

/**
 * 每個 subagent 的有效集合。
 *
 * 三件事在這裡合起來，共同的軸線是**全域的東西主動併進每個 subagent**：基座對
 * `permissions` 與 `tools` 都是整組替換而非合併（`SubAgentBase` 的 `permissions`
 * 明文 full replacement，`tools` 缺席才 fallback 到 defaultTools）。所以同名項一律
 * **全域勝**：subagent 可以多要求，不能少要求。
 *
 * **核准閘門必須從 fold 這一側明著交給每個 subagent，不能靠繼承。** deepagents 對
 * `SubAgentBase.middleware` 的說明是 “Additional middleware to append after
 * default_middleware”（`deepagents@1.13.1`，`dist/agent-D50BBbJT.d.ts:1527`）——
 * subagent 拿的是基座那份預設 stack 加自己宣告的那些，**root 的 middleware 參數
 * 一個都不繼承**——這一段交出去的每一顆都是這個原因。舊機制靠的是 `interruptOn` 這個欄位可以逐個
 * subagent 傳，換成 middleware 之後那條路沒了，不交就是默默地讓 subagent 失去核准。
 *
 * **交的方式是從同一張槽位表導出**（{@link MiddlewareSlot}，#664），不是各自手寫一份清單：理由沒變（基座
 * 沒有繼承的通道），變的是漏接的後果——以前新增一顆只補 root、子代理漏掉沒有任何東西會紅，現在每一列都得為
 * 子代理那一欄表態，不給也要明寫。偏離的登記與表達不出來的理由寫在 {@link MiddlewareSlot} 上。
 *
 * **注進去的是另一顆，管道固定 `policy-never`**（[#324](https://github.com/DemianLi/nexus-agent/issues/324)）：
 * 照 dsh，子代理不停下來等人，需要核准的操作一律自動拒絕。listener 同一組，所以該問的照樣被判成「要問」，
 * 只是問不到人——不注的話那些工具在子代理裡會**直接執行**，那是更糟的一邊。同一張卡的另外兩面：問答那顆
 * 以 `rootOnly` 換成樁，以及只放進子代理的委派聲明（{@link ./subagent-delegation.ts}）。
 *
 * **圍堵同樣明著交給每個 subagent，理由同上一條。** 它以前是 plugin middleware，而那時 plugin
 * middleware 一顆都射不進 subagent——也就是說 subagent 裡任何一個工具拋錯，整場 run 照樣
 * 死。[#159](https://github.com/DemianLi/nexus-agent/issues/159) 把它搬進 fold 打底，
 * 兩個掛點缺一個就是漏掉半棵樹。**排在第 0 格**，理由與 {@link foldMiddleware} 那份同一條：
 * 它要包住這個 subagent 的閘門、摘要器、以及 spec 自己帶的每一個 middleware。
 *
 * **root 與所有 subagent 共用同一份實例**，跟提醒器與用量記錄器同一格：圍堵沒有 closure
 * 狀態，`try/catch` 裡讀到的一切都來自那一次呼叫的 `request`。
 *
 * **plugin 的 middleware 也逐個注進去，同一批實例、同 root 的位置**（[#327](https://github.com/DemianLi/nexus-agent/issues/327)）。
 * 照 dsh：子代理 `composeFrom` 綁到父代理同一份組合——同樣的 plugin 物件、同樣的提示詞段落
 * （`packages/preset/agent-presets/src/index.ts:459-492`，dsh `e459e32`），沒有「只給 root」的註冊。
 * 但 dsh 段落的**文字**逐個 agent 從 `context.agent.session` 現算，所以子代理講的是它自己的沙箱模式、
 * 看到的是它自己（永遠沒開）的計劃模式。對應到這裡：共用一份的 middleware 要從這一次呼叫的身分分出
 * 是誰，不能把逐 agent 的狀態放在閉包裡——契約寫在 `MiddlewareRegistrationPoint.use` 上。
 *
 * **偏離（登記）：共用一份、不逐個建。** 摘要器與先讀後改做成工廠，是因為它們的狀態在閉包裡；plugin
 * middleware 今天全樹零顆帶逐 agent 的閉包狀態，所以不先做工廠介面。後果是**沒有絆索**：哪天有一顆
 * 帶閉包狀態的掛進來，root 與子代理會靜靜串台，沒有測試會紅。
 *
 * **位置只對名字不撞基座的成立。** 撞上基座子代理預設 stack 裡的名字會被原地取代，陣列位置就不決定
 * 包裹層次了（同下面摘要器那段）。今天樹上的兩顆都不撞。**名字撞上摘要器的那一顆不攤過來**，理由見
 * {@link subagentPluginMiddleware}。
 *
 * **寫 subagent 的人要知道這件事**：基座對 `SubAgentBase.permissions` 的說明是
 * 「these rules **replace** the parent agent's permissions」，它自己的範例就是
 * 「parent 擋 `/restricted/**`，這個 subagent 讀得到」。**那個逃生口在我們這裡打不開。**
 * 全域規則排在你的規則前面，先命中者決定，所以你的 `permissions` 只加得了限制、
 * 鬆不了綁。要放寬只有一條路：讓那條全域 deny 自己帶 `except`。
 *
 * **沒有人註冊 `general-purpose` 時，清單最前面多一個 fold 自己補的**，走的是同一條路。
 * 理由見 {@link generalPurposeSpec}。
 */
function foldSubAgents(
  registry: PluginRegistry,
  context: {
    toolOrder: readonly string[] | undefined;
    /** 子代理的工具過濾（#707）；`undefined`＝沒有，產物與沒這一格時逐字相同。 */
    toolFilter: ToolFilter | undefined;
    /** 基座自己帶的工具名：過濾遮它們時的宇宙（它們不在 registry 裡）。 */
    baseToolNames: readonly string[];
    /** root 的 skills 來源。只給 fold 補的 `general-purpose`，同基座那份。 */
    skills: readonly string[];
    permissions: readonly FilesystemPermission[];
    /** middleware 槽位表：每個子代理的疊從它導出，見 {@link MiddlewareSlot}。 */
    slots: readonly MiddlewareSlot[];
  },
): SubAgent[] {
  // 自帶的 tools 先配上來源：它們沒走 registry 那條路，來源只有這裡知道。
  const specs = [...registry.subagents.entries()].map(([name, entry]) => ({
    name,
    spec: entry.value,
    own: (entry.value.tools ?? []).map((tool) => ({ value: tool, origin: entry.origin })),
  }));
  // 排在最前，同基座 `inlineSubagents.unshift(generalPurposeSpec)`：`task` 的描述照清單
  // 順序列，換位置就是改了模型讀到的字。
  if (registry.subagents.get(GENERAL_PURPOSE_SUBAGENT.name) === undefined) {
    specs.unshift({
      name: GENERAL_PURPOSE_SUBAGENT.name,
      spec: generalPurposeSpec(context.skills),
      own: [],
    });
  }

  const folded: SubAgent[] = [];
  for (const { name, spec, own } of specs) {
    // 全域打底 → subagent 自帶的 tools → 該層註冊的，越後面越近。自帶的那些不會被
    // 抹掉：它們是這個 subagent 自己的東西，只是沒走 registry 那條路進來。
    //
    // 明著寫 `tools` 蓋掉基座的 `agentParams.tools ?? defaultTools` 是安全的：基座的
    // `defaultTools` 就是 root 的 `tools` 參數本身（`effectiveTools`，只多了 harness
    // profile 的描述覆寫），內建的檔案系統工具不從那裡來，而是 subagent 那份
    // middleware stack 裡的 `createFilesystemMiddleware` 帶的。蓋掉它不會讓 subagent
    // 掉工具——這一層算出來的集合本來就以全域那份為底。
    // **root-only 的替換發生在這裡，在 scope 覆蓋之前。** 順序有意義：明著往這個
    // subagent 註冊同名工具的人贏得過樁——那是「這個 subagent 有它自己的版本」，
    // 跟「這個工具不給 subagent」不是同一件事。
    const merged = new Map<string, NamedEntry<StructuredTool>>();
    for (const [toolName, globalEntry] of registry.tools.effective()) {
      // 工具過濾（#707）：只遮繼承來的，所以在這裡扣、在下面的自帶與 scoped 之前。root-only 的樁在過濾**之後**才換：
      // `deny` 列到就整顆消失，`allow` 留下就仍是拒絕樁。
      if (context.toolFilter !== undefined && !toolKept(context.toolFilter, toolName)) continue;
      merged.set(
        toolName,
        registry.tools.isRootOnly(toolName)
          ? {
              ...globalEntry,
              value: rootOnlyStub(
                globalEntry.value,
                name,
                registry.tools.rootOnlyRefusalOf(toolName),
              ),
            }
          : globalEntry,
      );
    }
    for (const ownEntry of own) merged.set(ownEntry.value.name, ownEntry);
    for (const [toolName, scoped] of registry.tools.own(name)) merged.set(toolName, scoped);

    const permissions = [...context.permissions, ...(spec.permissions ?? [])];

    // 我們自己的三格不交給基座：`maxTurns`、`reasoningEffort` 它不認得；`model` 是字串時是**型錄 id**，基座會當
    // `provider:model` 去 `initChatModel`，所以拿掉，由跟隨的 middleware 每次叫模型前換成那條路由的實例（沒有控制器時，
    // 註冊那一刻就拒絕字串 model，走不到這裡）。給實例的 `model` 原樣留著。
    const { maxTurns: _maxTurns, reasoningEffort: _reasoningEffort, ...declared } = spec;
    if (typeof declared.model === 'string') delete declared.model;
    const next: SubAgent = {
      ...declared,
      tools: orderTools(merged, context.toolOrder),
      // 從同一張槽位表導出（#664）：每一個位置的理由寫在 {@link foldRegistry} 那一列上，那裡也決定了
      // 哪些共用一份、哪些逐個建、哪些只給子代理。
      middleware: foldSubagentMiddleware(context.slots, spec),
    };
    // 空的就不要放：基座對 `permissions` 的空陣列與缺席不同義（前者是「整組替換成
    // 沒有規則」）。
    if (permissions.length > 0) next.permissions = permissions;
    folded.push(next);
  }
  return folded;
}
