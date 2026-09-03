/**
 * fold：把載入完的 registry 折成一次 `createDeepAgent(...)` 要的參數。
 *
 * core 是純轉換層——**不呼叫** `createDeepAgent`，只產出參數；那一次呼叫住在
 * `apps/harness`，而且只有那一個地方。組裝點自有的七樣（default backend、工具
 * 呈現順序清單、model、checkpointer / store、核准政策的 session 開關、摘要的門檻與
 * 去向、重複呼叫提醒的門檻與射程）從 {@link FoldOptions} 傳進來：所有權留在 harness，
 * 檢查跑在這裡。
 *
 * 「純轉換層」不代表這裡不建東西：核准閘門、摘要器與提醒器都是在這裡建的 middleware。
 * 分界是**不碰基座的建構**（`createDeepAgent`），不是「不 new 任何東西」。
 *
 * 這裡也是幾條後置條件的落點——它們**不能**在註冊當下驗，因為 `requires` 不排序，
 * 清單裡靠前的 plugin 本來就可以往靠後的 plugin 才註冊的 subagent 上加工具。
 * 「全部載完了」這個時刻只有 fold 有。
 */

import { tool as makeTool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { CompositeBackend } from 'deepagents';
import type { AnyBackendProtocol, FilesystemPermission, SubAgent } from 'deepagents';
import type { AgentCheckpointer, AgentMiddleware, AgentModel, AgentStore } from './base-types.js';
import { createApprovalGateMiddleware } from './approval.js';
import type { ApprovalChannel } from './approval.js';
import type { NamedEntry } from './entries.js';
import { formatOrigin } from './plugin.js';
import type { PluginOrigin } from './plugin.js';
import type { PluginRegistry } from './registry.js';
import { createRepeatReminder, resolveRepeatReminderSettings } from './repeat-reminder.js';
import type { RepeatReminderSettings } from './repeat-reminder.js';
import { createSummarizer, resolveSummarizationSettings } from './summarization.js';
import type { SummarizationSettings } from './summarization.js';

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
 * subagent 叫到 root-only 工具時，那顆樁回的話。
 *
 * **回字串而不是拋。** dsh 那側是拋（`tool-todo/src/index.ts:205-210` 的
 * `throw new Error('todo_write requires an owning agent session')`），理由是「拒絕，
 * 不要靜默 no-op」——那個理由我們照收，但**拋在我們這裡達不到它**：
 * `ToolNode.runTool` 只要 `wrapToolCall` 存在就把工具自己拋的錯當成 middleware 的錯並
 * 重拋，而 `createDeepAgent` 永遠掛著帶 `wrapToolCall` 的 `FilesystemMiddleware`，
 * 所以工具一拋就是**整場 run 死掉**，除非 `@nexus/plugin-validation` 的圍堵剛好也在清單
 * 裡（見 `packages/nexus-plugin-validation/src/containment.ts` 的檔頭）。fold 是 core，
 * 它產出的東西不能假設某個 plugin 在場。回字串在兩種組裝下都是同一則模型看得到的回饋。
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
 * @param original - 全域註冊的那一顆。
 * @param scope - 這顆樁要放進哪個 subagent。
 * @returns 只回 {@link rootOnlyRefusal} 的同名工具。
 */
function rootOnlyStub(original: StructuredTool, scope: string): StructuredTool {
  return makeTool(() => rootOnlyRefusal(original.name, scope), {
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
  /** 模型。 */
  model?: AgentModel;
  /** checkpointer。`false` 與缺席同義。 */
  checkpointer?: AgentCheckpointer;
  /** 長期記憶用的 store。 */
  store?: AgentStore;
  /** 核准政策的 session 開關。 */
  approvals?: ApprovalPolicy;
  /**
   * 摘要的門檻與去向。省略即 {@link DEFAULT_SUMMARIZATION}，給物件就逐格淺合併上去。
   *
   * **`false` 是明著放棄。** 它讓 fold 一份摘要器都不建，於是 root 與每個 subagent 拿
   * 回基座無條件建的那個——也就是一組沒有人在檢查的門檻，加上預設的
   * `/conversation_history`。那是這張卡要消滅的狀態，所以它只能是**明著寫出來**的選擇，
   * 沒有靜默退回這條路。用得到它的是「我就是要看裸基座」的測試。
   *
   * 建摘要器需要一個 backend。**用的是這裡的 {@link FoldOptions.defaultBackend}，不是
   * {@link foldBackend} 折出來的那個**，理由見 {@link foldRegistry}。所以沒給
   * default backend 又沒關掉摘要時，fold 當場拋。
   */
  summarization?: Partial<SummarizationSettings> | false;
  /**
   * 重複工具呼叫的提醒門檻與射程。省略即 {@link DEFAULT_REPEAT_REMINDER}，給物件就
   * 逐格淺合併上去，`false` 是明著不要。
   *
   * **這一格跟 {@link FoldOptions.summarization} 不同型**：那一格的 `false` 是退回基座
   * 無條件建的那個，這一格的 `false` 是**真的沒有**——基座沒有這種 middleware，
   * `recursionLimit` 是唯一會讓打轉停下來的東西，而它不分辨在進展還是在打轉。
   *
   * 它建的 middleware 是無狀態的（鏈從 `state.messages` 現算），所以 root 與每個
   * subagent 共用同一份實例，不像摘要器要逐個建。
   *
   * **關掉它會拿回一點迴圈預算**：它掛在 `beforeModel` 上，那是圖裡的一個節點，
   * 每一輪多一個 super-step。見 {@link createRepeatReminder}。
   */
  repeatReminder?: Partial<RepeatReminderSettings> | false;
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

  const permissions = foldPermissions(registry);
  const approvalGate = foldApprovalGate(registry, options);
  const summarizer = foldSummarizer(options);
  const repeatReminder = foldRepeatReminder(options);

  const params: FoldedAgentParams = {
    tools: orderTools(globalTools, toolOrder),
    subagents: foldSubAgents(registry, {
      toolOrder,
      permissions,
      approvalGate,
      summarizer,
      repeatReminder,
    }),
    middleware: foldMiddleware(registry, approvalGate, summarizer?.(), repeatReminder),
  };

  if (permissions.length > 0) params.permissions = permissions;

  const backend = foldBackend(registry, options.defaultBackend);
  if (backend !== undefined) params.backend = backend;

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
 * **基座自帶的 `general-purpose` 也不算，而且這是對的答案不是暫行做法。** 讀過
 * `deepagents` 的 `src/agent.ts` 之後有兩條事實：(1) 它只在 `subagents` 裡**沒有**叫
 * `general-purpose` 的東西時才自己補一個，所以我們真的註冊一個同名的會把它整個換掉；
 * (2) 它補的那個拿 `tools: effectiveTools`，也就是 root 的工具參數本身——全域工具本來
 * 就已經在裡面了。所以往 `'general-purpose'` 這個層加工具**永遠不是**把工具送進它的
 * 正確方式：要嘛註冊全域（自動流進去），要嘛自己註冊一個同名 subagent（那就是明著換掉
 * 基座的版本）。擋下來還附帶擋住打錯字的層名，兩邊都划算。
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
  const channel: ApprovalChannel =
    options.approvals?.enabled === false
      ? { kind: 'policy-never' }
      : options.checkpointer === undefined || options.checkpointer === false
        ? { kind: 'no-channel' }
        : { kind: 'human' };
  return createApprovalGateMiddleware(registry.approvals.listeners(), channel);
}

/**
 * middleware 折成一份清單：`prepend` 的在前，核准閘門接著，其餘依註冊順序。
 *
 * **與 dsh 的偏離**：dsh 的匿名表只有 `append`，沒有 prepend 這個概念。deepagents
 * 的 middleware 是一份順序有意義的陣列，「插到最前」表達不出來，所以退到最接近的
 * 實作：一張表加一次穩定分割，兩個分區各自維持註冊順序。
 *
 * **核准閘門排在 `prepend` 之後、其餘之前，而那個位置有唯一正確答案。**
 * `wrapToolCall` 是層層相包的，陣列越前面越外層：
 *
 * - **不能排在最前**。最外層是圍堵（`@nexus/plugin-validation` 以 `prepend` 掛上去），
 *   它的射程要涵蓋內層每一個 plugin middleware，閘門自己的 bug 也在裡面。把閘門推到
 *   它外面，閘門一拋就整場 run 死掉。實測中斷穿得過圍堵的 `isGraphBubbleUp` 分支，
 *   所以待在裡面不會讓核准點消失。
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
 * **提醒器排在摘要器之後，那個順序是有意義的。** 兩個都會動訊息串，而它們在圖裡是照
 * 陣列順序串起來的節點。摘要器先剪、提醒器後附 ＝ 提醒一定活到模型那一格；反過來的話
 * 提醒可能在同一輪就被剪掉。代價是鏈從剪過的訊息串推導，所以摘要之後鏈會歸零——那一格
 * 登記在 {@link createRepeatReminder} 的檔頭。
 */
function foldMiddleware(
  registry: PluginRegistry,
  approvalGate: AgentMiddleware,
  summarizer: AgentMiddleware | undefined,
  repeatReminder: AgentMiddleware | undefined,
): AgentMiddleware[] {
  const entries = registry.middleware.list();
  return [
    ...entries.filter((entry) => entry.value.prepend).map((entry) => entry.value.middleware),
    approvalGate,
    ...(summarizer === undefined ? [] : [summarizer]),
    ...(repeatReminder === undefined ? [] : [repeatReminder]),
    ...entries.filter((entry) => !entry.value.prepend).map((entry) => entry.value.middleware),
  ];
}

/**
 * 提醒器，或在明著關掉時回 `undefined`。
 *
 * **回一份實例而不是工廠，跟 {@link foldSummarizer} 相反，而且是量過的差別**：摘要器的
 * `sessionId` 在 closure 裡，共用會讓兩個 agent 的歷史混進同一個檔；提醒器的 closure 裡
 * 只有設定，鏈每次從 `state.messages` 現算，而 `state` 本來就逐 thread、逐 agent 各一份。
 *
 * @param options - 組裝點自有的那些。
 * @returns 一份可以掛在任意多個 agent 上的 middleware，或 `undefined`。
 */
function foldRepeatReminder(options: FoldOptions): AgentMiddleware | undefined {
  if (options.repeatReminder === false) return undefined;
  return createRepeatReminder(resolveRepeatReminderSettings(options.repeatReminder));
}

/**
 * 摘要器的**工廠**，或在明著關掉時回 `undefined`。
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
 * **沒有 default backend 又沒關掉是拋，不是靜默跳過。** 這一格的失敗方向有主人：
 * 靜默跳過等於退回基座那組沒有人檢查的門檻，而那正是
 * [#142](https://github.com/DemianLi/nexus-agent/issues/142) 要消滅的狀態——它會長得
 * 跟「一切正常」一模一樣。同型的前例是 {@link foldBackend} 對「掛了路由卻沒給兜底」
 * 那條。**檢查跑在這裡一次**，工廠被呼叫幾次都不重驗。
 */
function foldSummarizer(options: FoldOptions): (() => AgentMiddleware) | undefined {
  if (options.summarization === false) return undefined;
  const settings = resolveSummarizationSettings(options.summarization);
  const backend = options.defaultBackend;
  if (backend === undefined)
    throw new Error(
      '要配摘要器，但組裝點沒給 default backend——摘要器把歷史寫進 backend，沒有它就沒有' +
        '地方放。給一個 default backend，或明著傳 `summarization: false` 退回基座那個' +
        '（那等於接受一組沒有人在檢查的門檻，見 #142）。',
    );
  return () => createSummarizer(backend, settings);
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
 * 每個 subagent 的有效集合。
 *
 * 三件事在這裡合起來，共同的軸線是**全域的東西主動併進每個 subagent**：基座對
 * `permissions` 與 `tools` 都是整組替換而非合併（`SubAgentBase` 的 `permissions`
 * 明文 full replacement，`tools` 缺席才 fallback 到 defaultTools）。所以同名項一律
 * **全域勝**：subagent 可以多要求，不能少要求。
 *
 * **核准閘門必須逐個 subagent 注進去，不能靠繼承。** deepagents 對
 * `SubAgentBase.middleware` 的說明是 “Additional middleware to append after
 * default_middleware”（`deepagents@1.13.1`，`dist/agent-D50BBbJT.d.ts:1527`）——
 * subagent 拿的是基座那份預設 stack 加自己宣告的那些，**root 的 plugin middleware
 * 一個都不繼承**。舊機制靠的是 `interruptOn` 這個欄位可以逐個 subagent 傳，換成
 * middleware 之後那條路沒了，不注就是默默地讓 subagent 失去核准。
 *
 * **順帶暴露一件既有事實**：圍堵（以及其餘所有 plugin middleware）今天同樣射不進
 * subagent。這張沒有修它——只有核准這一格是這次換機制**造成**的落差，其餘是本來就在
 * 的。要修是另一張。
 *
 * **寫 subagent 的人要知道這件事**：基座對 `SubAgentBase.permissions` 的說明是
 * 「these rules **replace** the parent agent's permissions」，它自己的範例就是
 * 「parent 擋 `/restricted/**`，這個 subagent 讀得到」。**那個逃生口在我們這裡打不開。**
 * 全域規則排在你的規則前面，先命中者決定，所以你的 `permissions` 只加得了限制、
 * 鬆不了綁。要放寬只有一條路：讓那條全域 deny 自己帶 `except`。
 */
function foldSubAgents(
  registry: PluginRegistry,
  context: {
    toolOrder: readonly string[] | undefined;
    permissions: readonly FilesystemPermission[];
    approvalGate: AgentMiddleware;
    summarizer: (() => AgentMiddleware) | undefined;
    repeatReminder: AgentMiddleware | undefined;
  },
): SubAgent[] {
  const folded: SubAgent[] = [];
  for (const [name, entry] of registry.subagents.entries()) {
    const spec = entry.value;

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
      merged.set(
        toolName,
        registry.tools.isRootOnly(toolName)
          ? { ...globalEntry, value: rootOnlyStub(globalEntry.value, name) }
          : globalEntry,
      );
    }
    for (const tool of spec.tools ?? [])
      merged.set(tool.name, { value: tool, origin: entry.origin });
    for (const [toolName, scoped] of registry.tools.own(name)) merged.set(toolName, scoped);

    const permissions = [...context.permissions, ...(spec.permissions ?? [])];

    const next: SubAgent = {
      ...spec,
      tools: orderTools(merged, context.toolOrder),
      // 閘門排在 subagent 自帶的那些之前——同「全域勝」那條軸線：subagent 自己掛的
      // middleware 繞不過它。
      //
      // **摘要器也排在前面，但那是相反的意思。** 閘門的名字不撞任何東西，位置決定的是
      // 包裹層次（越前越外層）；摘要器的名字撞上基座內建那個，位置決定的是**同名誰贏**
      // ——`mergeMiddleware$1` 是一個以 `name` 為鍵的 `Map`，後設的覆蓋前設的。排在
      // `spec.middleware` 之前 ＝ subagent 自己帶的版本贏得過我們這份。
      //
      // 這是「打底」不是「強制」，而那是選的：跟同一個函式裡 `tools` 那條軸線一致
      // （全域打底 → 自帶的 → 該層註冊的，越後面越近）。摘要門檻是效能與正確性的預設值，
      // 不是安全邊界；明著在 spec 裡寫了一個同名 middleware 的人是想要它，靜靜被蓋掉
      // 才是壞的。安全邊界那幾格（`permissions`、閘門）維持全域勝，沒有動。
      //
      // 打底本身不可省：`buildSubagentMiddleware` 每個 subagent 各建一份新的
      // `createSummarizationMiddleware({ backend })`，root 的註冊點到不了它們。留給
      // plugin 作者自己記得的下場是那個 subagent 靜靜用回基座那組沒人檢查的門檻，
      // 而長任務的 token 大戶正是 subagent（[#142](https://github.com/DemianLi/nexus-agent/issues/142) 的決定 2）。
      //
      // **各建一份，不共用**：摘要器的 `sessionId` 在 closure 裡，共用會讓 root 與這個
      // subagent 的歷史 append 進同一個檔。理由見 {@link foldSummarizer}。
      //
      // **提醒器也打底，理由跟摘要器同一條，但它是共用同一份實例的**：dsh 每個 agent
      // 分開計數，而我們的鏈是從那個 agent 自己的 `state.messages` 現算的，所以「分開」
      // 是結構上的，不必逐個建。root 的註冊點一樣到不了 subagent，而長任務裡真的會
      // 打轉的正是 subagent（[#147](https://github.com/DemianLi/nexus-agent/issues/147)）。
      middleware: [
        context.approvalGate,
        ...(context.summarizer === undefined ? [] : [context.summarizer()]),
        ...(context.repeatReminder === undefined ? [] : [context.repeatReminder]),
        ...(spec.middleware ?? []),
      ],
    };
    // 空的就不要放：基座對 `permissions` 的空陣列與缺席不同義（前者是「整組替換成
    // 沒有規則」）。
    if (permissions.length > 0) next.permissions = permissions;
    folded.push(next);
  }
  return folded;
}
