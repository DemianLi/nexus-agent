/**
 * fold：把載入完的 registry 折成一次 `createDeepAgent(...)` 要的參數。
 *
 * core 是純轉換層——**不呼叫** `createDeepAgent`，只產出參數；那一次呼叫住在
 * `apps/harness`，而且只有那一個地方。組裝點自有的五樣（default backend、工具
 * 呈現順序清單、model、checkpointer / store、核准政策的 session 開關）從
 * {@link FoldOptions} 傳進來：所有權留在 harness，檢查跑在這裡。
 *
 * 這裡也是幾條後置條件的落點——它們**不能**在註冊當下驗，因為 `requires` 不排序，
 * 清單裡靠前的 plugin 本來就可以往靠後的 plugin 才註冊的 subagent 上加工具。
 * 「全部載完了」這個時刻只有 fold 有。
 */

import type { StructuredTool } from '@langchain/core/tools';
import { CompositeBackend } from 'deepagents';
import type { AnyBackendProtocol, FilesystemPermission, SubAgent } from 'deepagents';
import type {
  AgentCheckpointer,
  AgentMiddleware,
  AgentModel,
  AgentStore,
  InterruptOnConfig,
  WhenPredicate,
} from './base-types.js';
import type { NamedEntry } from './entries.js';
import { formatOrigin } from './plugin.js';
import type { PluginOrigin } from './plugin.js';
import type { InterruptRequirement, PluginRegistry } from './registry.js';

/**
 * 工具呈現順序清單裡代表「其餘未列出者」的保留項。
 *
 * 名字與語義照 dsh 的 `TOOL_ORDER_REST`（`packages/core/system-prompt/src/index.ts`）：
 * 列到的工具站在它被列的位置，沒列到的在這一格依字典序插進來。deepagents 沒有
 * 對應機制——註冊順序是 plugin 載入順序的產物，dsh 的 Agent Note 記過它造成的
 * CI flake。
 */
export const TOOL_ORDER_REST = '<unlisted-tools>';

/** 核准政策：這個 session 有沒有人可以按核准。 */
export interface ApprovalPolicy {
  /**
   * 這個 session 是否接受人工核准。預設 `true`。
   *
   * 關掉的意思是**這個 session 沒有人在**（例如批次跑的 CLI），不是「把核准靜音」：
   * 關著卻有 plugin 宣告了 `interrupts.require(...)`，fold 直接報錯，而不是把那些
   * 標記丟掉——沒人回答的中斷會把 agent 掛在那裡，靜默放行則是把核准政策解除武裝。
   * 兩邊都是缺席即拒絕。
   *
   * **代價要知道**：任何 bundle 了 approval-gated 工具的 plugin，在關掉核准的模式下
   * 會變成**載不起來**，唯一的補救是去動 plugin 清單。dsh 的對應旋鈕（`ApprovalPolicy`
   * 的 `'never'`）走的是另一條路——每次 ask 確定性地回 `rejected`，agent 照樣跑得起來，
   * 只是碰到要核准的操作就被拒。那個讀法在 `interruptOn` 上表達不出來（`false` 是
   * auto-approve，`allowedDecisions: ['reject']` 仍然會去問人），要換掉這個機制才做得到。
   */
  enabled?: boolean;
}

/** 組裝點在 fold 時交出來的那五樣，加一份基座工具名單。 */
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
   * 沒有它的話，`interrupts.require('delete', ...)` 與 `toolOrder: ['write_file', ...]`
   * 都會被誤判成「沒人註冊」，而那幾個恰好是最該被核准、也最該排在前面的。
   * 所有權留在 harness——它是唯一呼叫 `createDeepAgent` 的地方，知道自己開了哪些工具。
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
  /** 需要人核准的工具。空的時候不出現。 */
  interruptOn?: Record<string, InterruptOnConfig>;
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
  // 一份名字宇宙餵給兩條檢查：以工具名為 key 的設定只有這兩處，兩邊的嚴格程度必須一致
  // ——排版列錯了只是難看，核准標在錯的名字上是把閘門解除武裝。
  const known = knownToolNames(registry, options.baseToolNames);
  if (toolOrder !== undefined) validateToolOrder(toolOrder, known);

  const permissions = foldPermissions(registry);
  const interruptOn = foldInterrupts(registry, options, known);

  const params: FoldedAgentParams = {
    tools: orderTools(globalTools, toolOrder),
    subagents: foldSubAgents(registry, { toolOrder, permissions, interruptOn }),
    middleware: foldMiddleware(registry),
  };

  if (permissions.length > 0) params.permissions = permissions;
  if (Object.keys(interruptOn).length > 0) params.interruptOn = interruptOn;

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
 * 核准標記折成基座的 `interruptOn`：同一個工具的多方標記逐欄位 OR，不報錯。
 *
 * 詞彙是封閉的——`allowedDecisions` 固定 `["approve", "reject"]`，`argsSchema`
 * 不使用（dsh 明文「Input rewrite is deliberately not offered」）。
 *
 * **標在不存在的工具名上要報錯。** 基座那端不會救：`humanInTheLoopMiddleware` 拿
 * `toolCall.name` 查 `interruptOn`，查不到就走 auto-approve，所以一個打錯字的核准閘門
 * 會靜靜地什麼都不擋——比沒宣告更糟，因為它看起來有守。fold 是「全部載完了」唯一
 * 的時刻，這條後置檢查只有這裡做得了。
 */
function foldInterrupts(
  registry: PluginRegistry,
  options: FoldOptions,
  known: ReadonlySet<string>,
): Record<string, InterruptOnConfig> {
  const requirements = registry.interrupts.requirements();
  if (requirements.length === 0) return {};

  // 名字先驗：那是 plugin 自己的缺陷，跟這個 session 怎麼設定無關，先報它才不會讓人
  // 修完 session 設定再撞一次。
  assertInterruptToolsExist(requirements, known);

  const cited = [...new Set(requirements.map((entry) => formatOrigin(entry.origin)))].join('、');
  if (options.approvals?.enabled === false) {
    throw new Error(
      `這個 session 關掉了人工核准，但 ${cited} 宣告了需要核准的工具。` +
        `沒有人可以按核准的話，中斷只會把 agent 掛在那裡——` +
        `要嘛打開核准，要嘛把那個 plugin 從清單裡拿掉。`,
    );
  }
  if (options.checkpointer === undefined || options.checkpointer === false) {
    throw new Error(
      `${cited} 宣告了需要核准的工具，但組裝點沒給 checkpointer。` +
        `基座的 interrupt 靠 checkpointer 才能在核准後接回去——缺席即拒絕，不是放行。`,
    );
  }

  const byTool = new Map<string, InterruptRequirement[]>();
  for (const entry of requirements) {
    const bucket = byTool.get(entry.value.toolName) ?? [];
    if (bucket.length === 0) byTool.set(entry.value.toolName, bucket);
    bucket.push(entry.value);
  }
  return Object.fromEntries(
    [...byTool].map(([toolName, reqs]) => [toolName, mergeInterrupt(reqs)]),
  );
}

/** 每個核准標記都要指向一個真的存在的工具，訊息指名是誰標的。 */
function assertInterruptToolsExist(
  requirements: readonly NamedEntry<InterruptRequirement>[],
  known: ReadonlySet<string>,
): void {
  const unknown = requirements.filter((entry) => !known.has(entry.value.toolName));
  if (unknown.length === 0) return;
  const detail = unknown
    .map((entry) => `${formatOrigin(entry.origin)} 標了 "${entry.value.toolName}"`)
    .join('；');
  const knownList = [...known].sort().join('、') || '（沒有任何工具）';
  throw new Error(
    `核准標記指向不存在的工具：${detail}。名字打錯的話那個閘門什麼都不會擋——` +
      `基座查不到就直接放行。目前認得的工具：${knownList}。` +
      `如果標的是基座自己帶的工具（write_file / delete / execute / task 那些），` +
      `要把它加進組裝點的 baseToolNames。`,
  );
}

/**
 * 同一個工具的多筆標記合成一份設定。
 *
 * `when` 缺席的語義是**無條件中斷**，所以只要有一方沒給 `when`，OR 的結果就是無條件
 * ——合出來的設定不帶 `when`，而不是包一個永遠回 true 的述詞。全都給了才 OR：依序
 * 求值、任一為真就短路，`when` 本來就可以回 promise。
 */
function mergeInterrupt(requirements: readonly InterruptRequirement[]): InterruptOnConfig {
  const reasons = [...new Set(requirements.map((requirement) => requirement.reason))];
  const config: InterruptOnConfig = {
    allowedDecisions: ['approve', 'reject'],
    description: reasons.join('；'),
  };
  const predicates: WhenPredicate[] = [];
  for (const requirement of requirements) {
    if (requirement.when === undefined) return config;
    predicates.push(requirement.when);
  }
  const when: WhenPredicate = async (request) => {
    for (const predicate of predicates) {
      if (await predicate(request)) return true;
    }
    return false;
  };
  return { ...config, when };
}

/**
 * middleware 折成一份清單：`prepend` 的在前，其餘依註冊順序。
 *
 * **與 dsh 的偏離**：dsh 的匿名表只有 `append`，沒有 prepend 這個概念。deepagents
 * 的 middleware 是一份順序有意義的陣列，「插到最前」表達不出來，所以退到最接近的
 * 實作：一張表加一次穩定分割，兩個分區各自維持註冊順序。
 */
function foldMiddleware(registry: PluginRegistry): AgentMiddleware[] {
  const entries = registry.middleware.list();
  return [
    ...entries.filter((entry) => entry.value.prepend).map((entry) => entry.value.middleware),
    ...entries.filter((entry) => !entry.value.prepend).map((entry) => entry.value.middleware),
  ];
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
 * 明文 full replacement，`tools` 缺席才 fallback 到 defaultTools），`interruptOn`
 * 則是 `agentParams.interruptOn ?? defaultInterruptOn`——一個自帶設定的 subagent
 * 會把全域那些整組蓋掉。所以同名項一律**全域勝**：subagent 可以多要求，不能少要求。
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
    interruptOn: Record<string, InterruptOnConfig>;
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
    const merged = new Map(registry.tools.effective());
    for (const tool of spec.tools ?? [])
      merged.set(tool.name, { value: tool, origin: entry.origin });
    for (const [toolName, scoped] of registry.tools.own(name)) merged.set(toolName, scoped);

    const permissions = [...context.permissions, ...(spec.permissions ?? [])];
    const interruptOn = { ...spec.interruptOn, ...context.interruptOn };

    const next: SubAgent = { ...spec, tools: orderTools(merged, context.toolOrder) };
    // 空的就不要放：基座對 `permissions` 的空陣列與缺席不同義（前者是「整組替換成
    // 沒有規則」），而 `if (spec.interruptOn)` 對 `{}` 為真，會多掛一層什麼都不做的
    // HITL middleware。
    if (permissions.length > 0) next.permissions = permissions;
    if (Object.keys(interruptOn).length > 0) next.interruptOn = interruptOn;
    folded.push(next);
  }
  return folded;
}
