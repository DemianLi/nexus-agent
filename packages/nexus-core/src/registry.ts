/**
 * `PluginRegistry`——plugin 的 `apply` 拿到的那個東西。
 *
 * 九個註冊點：`tools` / `subagents` / `capabilities` 是具名的，`backend` / `skills`
 * 也靠名字（`routePrefix` 與來源路徑）擋重複，其餘三個（`middleware` /
 * `permissions` / `interrupts`）沒有名字可撞，走匿名追加。折疊成
 * `createDeepAgent` 參數的部分在 {@link ./fold.ts}。
 *
 * 外加三條**不折進 `createDeepAgent` 任何參數**的通道，所以它們不算進那九個：
 * {@link LifecycleRegistrationPoint} 回答「這些東西怎麼收掉」，
 * {@link TelemetryRegistrationPoint} 回答「這個會話發生的事往哪裡送、送之前怎麼洗」，
 * {@link InvariantRegistrationPoint} 回答「這個會話發生的事有沒有破壞誰的約定」。
 * 九個註冊點回答的是「這個 agent 由什麼組成」，四者正交。
 */

import type { StructuredTool } from '@langchain/core/tools';
import type { AnyBackendProtocol, SubAgent } from 'deepagents';
import type { AgentMiddleware, WhenPredicate } from './base-types.js';
import { AnonymousEntries, CapabilitySet, NamedEntries } from './entries.js';
import type { NamedEntry } from './entries.js';
import { formatOrigin } from './plugin.js';
import type { PluginOrigin } from './plugin.js';
import { duplicateCompanionError } from './invariants.js';
import type { InvariantCompanion, InvariantInstaller } from './invariants.js';
import type { SessionTelemetryRedactRule, SessionTelemetryService } from './session-telemetry.js';

/**
 * 註冊層的定址。`undefined` 是全域（root agent），字串是那個名字的 subagent。
 *
 * 只有兩層，沒有巢狀——層結構由 deepagents 的形狀決定（root 加一排 subagents），
 * 不是 dsh 那種來自 Cordis context 樹的任意深度。
 */
export type ScopeKey = string;

export interface RegisterOptions {
  /** 註冊到哪一層。省略即全域。 */
  scope?: ScopeKey;
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

/** 一次 middleware 註冊。 */
export interface MiddlewareRegistration {
  readonly middleware: AgentMiddleware;
  /** 是否插到其他 plugin 的 middleware 之前。 */
  readonly prepend: boolean;
}

/** `middleware` 註冊點：清單順序，`prepend` 為唯一例外閥。 */
export interface MiddlewareRegistrationPoint {
  /**
   * 追加一個 middleware。
   * @param middleware - middleware 實例。
   * @param options - `prepend: true` 把它排到其他 plugin 的 middleware 之前。
   *   注意射程只到 plugin 之間——基座的標準 middleware stack 永遠在前面，
   *   `createDeepAgent` 的 `middleware` 參數整組接在它後面。
   * @returns 只撤銷這一次註冊的冪等 undo。
   */
  use(middleware: AgentMiddleware, options?: { prepend?: boolean }): () => void;
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

/** 一次「這個工具要人核准」的標記。 */
export interface InterruptRequirement {
  /** 要核准的工具名。 */
  readonly toolName: string;
  /** 給人看的理由。 */
  readonly reason: string;
  /**
   * 只在這個述詞為真時才中斷；省略即無條件中斷。
   *
   * **`request.tool` 一定是 `undefined`。** 基座在 `afterModel` 的批次語境求值這個
   * 述詞（`langchain@1.5.10`，`dist/agents/middleware/hitl.js:359-367` 實測），
   * request 是現搭的：`{ toolCall, tool: undefined, state, runtime }`，`runtime` 是
   * node 層的那個、不是某一次工具執行的。型別上 `tool` 是可選的，所以
   * `request.tool.name` 編得過、跑起來當場炸。要看工具名就讀 `request.toolCall.name`。
   */
  readonly when?: WhenPredicate;
}

/** `interrupts` 註冊點：同工具多方標記不報錯，`when` 取 OR。 */
export interface InterruptRegistrationPoint {
  /**
   * 標記一個工具需要人核准。
   *
   * **這道閘門的保證只到建構期。** 基座把 `interruptOn` 放在 HITL middleware 的
   * `contextSchema` 裡，執行期取的是 `{ ...options, ...runtime.context }`
   * （`hitl.js:421`）——所以呼叫端一句 `agent.invoke(input, { context: { interruptOn: {} } })`
   * 就把所有閘門整組換掉，不警告、不留痕跡。fold 這一側做的每一件事（工具名要存在、
   * 缺 checkpointer 即拒絕、核准政策開關）都擋不到那條路，因為它們都是建構期的。
   * 入口層（CLI、web）不得把使用者可控的東西直接當成 `context` 傳下去。
   * 絆索在 `apps/harness/src/interrupt.test.ts`。
   *
   * @param toolName - 工具名。同一個工具被多方標記是正常的，不報錯。
   * @param options - `reason` 給人看，`when` 省略即無條件中斷（`request.tool` 是
   *   `undefined`，見 {@link InterruptRequirement.when}）。
   * @returns 只撤銷這一次標記的冪等 undo。
   */
  require(toolName: string, options: { reason: string; when?: WhenPredicate }): () => void;
  /**
   * 目前的核准標記。
   * @returns 依註冊順序的每一筆。
   */
  requirements(): NamedEntry<InterruptRequirement>[];
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
 * `telemetry` 通道：掛遙測後端，以及**送出去之前**的脫敏規則。
 *
 * **它與九個註冊點不同軸**，理由跟 lifecycle 一樣：產物不進 `createDeepAgent` 的參數。
 * 遙測是會話事件的第二個出口，走的不是 agent 那條線。
 *
 * **`WIRE_CHANNELS` 那份下行白名單擋不到這條路。** 那是 web 傳輸的邊界，遙測是另一個
 * 出口——脫敏規則要自己長一份，不能靠 wire 那份代勞。
 *
 * **與 dsh 的偏離**（AGENTS.md 的偏離規則）：dsh 的後端是 Cordis `Service`
 * （`ctx.sessionTelemetry`，重複註冊由 Cordis 拋），脫敏是 waterfall 事件
 * `session-telemetry/record`。**我們沒有 service 註冊也沒有事件匯流排**，`deepagents` /
 * LangChain JS / LangGraph JS 三者都不提供可掛任意具名事件的 waterfall。退到最接近的：
 * 一個註冊點，`use` 用具名表擋重複（等價於 Service 的重複拋），`redact` 用依序折疊
 * 取代 waterfall。折疊丟掉的是「不呼叫 `next()` 就截斷底下所有規則」那個能力，**刻意
 * 丟的**——理由見 {@link ./session-telemetry.ts | SessionTelemetryRedactRule}。
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
  /**
   * 掛遙測服務。**一個 registry 只收一個**——兩個後端就是兩份出境資料，而披露那一層
   * 只講得出一種策略。
   * @param service - 後端實例，必須表態 `sharing`。
   * @returns 只撤銷這一次掛載的冪等 undo。
   */
  use(service: SessionTelemetryService): () => void;
  /**
   * 目前掛著的服務。**披露那一層要靠它回答「有沒有東西在送、策略是什麼」**——
   * `undefined` 才是「未配置」，這是 dsh 的規矩。
   * @returns 掛著的那個，或沒掛時的 `undefined`。
   */
  service(): NamedEntry<SessionTelemetryService> | undefined;
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
 * 3. **一次註冊看所有 session** —— dsh 有 `ctx.sessions.list()` ＋ `session/created`。
 *    我們沒有 session 服務，日誌是各進入點自己 `new` 的。退到：installer **每一份日誌
 *    各跑一次**。
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

export interface PluginRegistry {
  readonly tools: ToolRegistrationPoint;
  readonly subagents: SubAgentRegistrationPoint;
  readonly capabilities: CapabilityRegistrationPoint;
  readonly backend: BackendRegistrationPoint;
  readonly middleware: MiddlewareRegistrationPoint;
  readonly permissions: PermissionRegistrationPoint;
  readonly interrupts: InterruptRegistrationPoint;
  readonly skills: SkillSourceRegistrationPoint;
  readonly memory: MemorySourceRegistrationPoint;
  readonly lifecycle: LifecycleRegistrationPoint;
  readonly telemetry: TelemetryRegistrationPoint;
  readonly invariants: InvariantRegistrationPoint;
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
  const interruptRequirements = new AnonymousEntries<InterruptRequirement>();
  const memorySources = new AnonymousEntries<string>();
  const disposers = new AnonymousEntries<Disposer>();
  const redactRules = new AnonymousEntries<SessionTelemetryRedactRule>();
  // 具名表配一個固定的 key：唯一性與 undo 都不必另外寫，重複掛載直接撞在這裡。
  const SERVICE_KEY = 'service';
  const services = new NamedEntries<SessionTelemetryService>(
    (_key, existing, incoming) =>
      new Error(
        `已經有遙測服務了：${formatOrigin(existing)} 掛過，${formatOrigin(incoming)} 又掛一次。` +
          `一個 agent 只能有一個後端——兩個就是兩份出境資料，而披露只講得出一種策略。`,
      ),
  );

  const companions = new NamedEntries<InvariantInstaller>(duplicateCompanionError);

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

  const tools: ToolRegistrationPoint = {
    register(tool, options) {
      const origin = requireOrigin('tools.register()');
      const scope = options?.scope;
      const layer = layerFor(scope);
      const undo = layer.tools.insert(tool.name, tool, origin);
      return () => {
        undo();
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
    list: () => [...middlewares.entries()],
  };

  const permissionPoint: PermissionRegistrationPoint = {
    deny(paths, options) {
      const origin = requireOrigin('permissions.deny()');
      return denyRules.append({ paths: [...paths], except: [...(options?.except ?? [])] }, origin);
    },
    rules: () => [...denyRules.entries()],
  };

  const interruptPoint: InterruptRegistrationPoint = {
    require(toolName, options) {
      const origin = requireOrigin('interrupts.require()');
      const requirement: InterruptRequirement =
        options.when === undefined
          ? { toolName, reason: options.reason }
          : { toolName, reason: options.reason, when: options.when };
      return interruptRequirements.append(requirement, origin);
    },
    requirements: () => [...interruptRequirements.entries()],
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
    use(service) {
      const origin = requireOrigin('telemetry.use()');
      return services.insert(SERVICE_KEY, service, origin);
    },
    service: () => services.get(SERVICE_KEY),
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

  const lifecyclePoint: LifecycleRegistrationPoint = {
    onDispose(dispose) {
      const origin = requireOrigin('lifecycle.onDispose()');
      return disposers.append(dispose, origin);
    },
    disposers: () => [...disposers.entries()],
    takeDisposers: () => disposers.drain(),
  };

  return {
    tools,
    subagents: subagentPoint,
    capabilities: capabilityPoint,
    backend: backendPoint,
    middleware: middlewarePoint,
    permissions: permissionPoint,
    interrupts: interruptPoint,
    skills: skillPoint,
    memory: memoryPoint,
    lifecycle: lifecyclePoint,
    telemetry: telemetryPoint,
    invariants: invariantPoint,
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
