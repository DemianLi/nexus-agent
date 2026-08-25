/**
 * `PluginRegistry`——plugin 的 `apply` 拿到的那個東西。
 *
 * 九個註冊點：`tools` / `subagents` / `capabilities` 是具名的，`backend` / `skills`
 * 也靠名字（`routePrefix` 與來源路徑）擋重複，其餘三個（`middleware` /
 * `permissions` / `interrupts`）沒有名字可撞，走匿名追加。折疊成
 * `createDeepAgent` 參數的部分在 {@link ./fold.ts}。
 */

import type { StructuredTool } from '@langchain/core/tools';
import type { AnyBackendProtocol, SubAgent } from 'deepagents';
import type { AgentMiddleware, WhenPredicate } from './base-types.js';
import { AnonymousEntries, CapabilitySet, NamedEntries } from './entries.js';
import type { NamedEntry } from './entries.js';
import { formatOrigin } from './plugin.js';
import type { PluginOrigin } from './plugin.js';

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
  /** 只在這個述詞為真時才中斷；省略即無條件中斷。 */
  readonly when?: WhenPredicate;
}

/** `interrupts` 註冊點：同工具多方標記不報錯，`when` 取 OR。 */
export interface InterruptRegistrationPoint {
  /**
   * 標記一個工具需要人核准。
   * @param toolName - 工具名。同一個工具被多方標記是正常的，不報錯。
   * @param options - `reason` 給人看，`when` 省略即無條件中斷。
   * @returns 只撤銷這一次標記的冪等 undo。
   */
  require(toolName: string, options: { reason: string; when?: WhenPredicate }): () => void;
  /**
   * 目前的核准標記。
   * @returns 依註冊順序的每一筆。
   */
  requirements(): NamedEntry<InterruptRequirement>[];
}

/** `skills` 註冊點：同一來源路徑重複註冊報錯。 */
export interface SkillSourceRegistrationPoint {
  /**
   * 加一個 skill 來源路徑。
   * @param path - 來源目錄路徑。
   * @returns 只撤銷這一次註冊的冪等 undo。
   */
  addSource(path: string): () => void;
  /**
   * 目前的來源路徑。
   * @returns 依註冊順序的路徑。
   */
  sources(): string[];
}

/** `memory` 註冊點：純累加，基座自理。 */
export interface MemorySourceRegistrationPoint {
  /**
   * 加一個 memory 來源路徑（AGENTS.md）。重複路徑不報錯——併入 prompt 的規則是
   * 基座的事，這裡只負責把清單交出去。
   * @param path - 來源檔路徑。
   * @returns 只撤銷這一次註冊的冪等 undo。
   */
  addSource(path: string): () => void;
  /**
   * 目前的來源路徑。
   * @returns 依註冊順序的路徑。
   */
  sources(): string[];
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
      return skillSources.insert(path, path, origin);
    },
    sources: () => [...skillSources.entries()].map(([path]) => path),
  };

  const memoryPoint: MemorySourceRegistrationPoint = {
    addSource(path) {
      const origin = requireOrigin('memory.addSource()');
      return memorySources.append(path, origin);
    },
    sources: () => [...memorySources.entries()].map((entry) => entry.value),
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
