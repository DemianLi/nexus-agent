/**
 * Cordis 樹上的插件那一面（[#1416](https://github.com/DemianLi/nexus-agent/issues/1416) PR 2，決議 §3-1 第 5 條的第二步）。
 *
 * `cordis-root.ts` 的樹上本來只有兩列（相容層與入口）。這一刀起還有三種東西：
 *
 * | 列 | 是什麼 | dsh 對應 |
 * |---|---|---|
 * | `tools` | 行程級的工具登記處（`@nexus/tools/provider`），契約服務，一列 | `tools` 服務的提供者 |
 * | `projections` | 行程級的投影登記處（`@nexus/projections/provider`，#1421），契約服務，一列 | `sessionProjections` 服務的提供者 |
 * | `skill-sources` | 行程級的技能來源登記處（`@nexus/skills/provider`，#1446），契約服務，一列 | `skills` 服務的提供者（形狀不同：收路徑，不收提供者，偏離登記在 `@nexus/skills`） |
 * | `commands` | 行程級的命令登記處（`@nexus/commands/provider`，#1456），契約服務，一列 | `commands` 服務的提供者 |
 * | `approval-channel` | 行程級的預設答題管道（`@nexus/approval-channel/provider`，#1458），契約服務，一列；**宿主在建樹時給值**，不是插件登記進來的 | （dsh 沒有這一種：它的答題者是 `session.interrupt` 事件的監聽者；偏離登記在 `@nexus/approval-channel`） |
 * | `session-lookup` | 行程級的會話查找（`@nexus/session/provider`，#1463），契約服務，一列；**宿主給挑法**（行程裡每一條活著的 thread 綁上的註冊表，`thread-sessions.ts`），不是插件登記進來的 | （dsh 沒有這一種：工具從 `exec.agent.session` 拿；偏離登記在 `@nexus/session`） |
 * | `fs` | 行程級的 fs 查找（`@nexus/fs/provider`，#1466），契約服務，一列；**宿主給挑法**（同一張登記表、同一支 `pickBoundForCall`，每一筆登記同時帶這條 thread 的 fs 把手），不是插件登記進來的 | （dsh 的 `fs` 是行程全域一份、每個 agent 不同的東西以參數傳入；偏離登記在 `@nexus/fs`） |
 * | `pre-step` | 行程級的 `agent/pre-step` 登記處（`@nexus/agent-loop/provider`，#1474），契約服務，一列；插件登記 listener，**宿主**把登記者是某一列的那幾位建成 middleware 折進每條 thread（`pre-step-middleware.ts`） | `agent/pre-step` 事件（dsh 沒有 middleware 服務；偏離登記在 `@nexus/agent-loop`） |
 * | `include` | vendor 的 Include：讀出貨的 `cordis.yml`，疊上 patch，把樹掛起來 | `include`（`app-boot` 的 `entry.update({ config: { ...includeConfig, patches } })`） |
 * | `include:<id>` | Include 底下的列，模組有 `manifest` 匯出的才上樹（遷出了哪幾顆以 `migrated-plugin-gate.test.ts` 的 `EXPECTED_MIGRATED` 為準） | 各插件 |
 *
 * ## 清單怎麼進樹
 *
 * 變更紀錄折出來的 patch 與 `--patch` 的 patch，原樣推給 Include（`entry.update({ config: { ...config, patches } })`），
 * 樹上的列由 Include 自己疊（上游 `applyPatches`）。**Include 不寫回任何檔**（`vendor/README.md` 第 7 條）：寫入口只有變更紀錄一個。Loader 上游會在安裝樹建 `.cordis/` 輔助檔，這裡給了解析函式（{@link resolveBareSpecifier}，第 9 條）就不建：產品路徑不依賴安裝樹可寫。
 * 疊的規則跟相容層那邊（`applyEntryPatches`）是兩支，所以每次推完都對一次：樹上那一列的 `disabled` 與 `config` 跟相容層
 * 疊出來的不一致，那一列就算掉了，不靜靜地各走各的（`diverged`）。
 *
 * ## 臨界區
 *
 * 「讀清單 → 推給樹 → 等收斂 → 取工具快照」是一段（{@link PluginTree.run}）：兩條 thread 同時組裝時各自要拿到
 * **跟自己讀到的清單相符**的工具，不能一條讀到舊清單、另一條推了新清單、它又取到新的。**只包這一段，不包整個組裝**。
 * 清單沒變時（簽章同上一次）不推，只重取快照。
 *
 * ## 收斂的語意（實測，`vendor/include/nexus-tests/convergence.spec.ts`）
 *
 * `await entry.update({ config })` 回來時 Include 底下的樹已經收斂：停用的那一列已卸載、登記處已撤；啟用的已重掛；
 * 改設定的舊值已撤、新值已進；同值的什麼都沒動。所以快照在這之後取，不必再輪詢。
 *
 * ## 偏離登記
 *
 * - **插件自我停用只在行程裡停著，紀錄只記不折**（#1424，demian 2026-10-14 拍板 Q1 (b)、Q2 (a)；PM 決議 Q-C 的後續）：
 *   Loader 處理自我停用的那一格把那一列在樹上標成 `disabled`，Include 不寫檔，也不折進清單。樹把「這一列自我停用過、當時的宣告是什麼」記在
 *   記憶體裡（{@link PluginTree}`.#selfDisabled`，鍵是列 id、值是整份宣告的簽章）：**宣告沒變就不推 `epoch`、不重掛，判成 `off`**，
 *   並由宿主替那一列推一條 `{ id, disabled: true }` 給 Include——Include 每次重疊（樹上別列的設定改了、整列重建）都把每一列的
 *   options 整份換掉，不推的話那一列會被蓋回啟用、重掛一次再停一次（閃動）。serve 重啟、或那一列的宣告改了（模組名或設定），
 *   下一次同步才再試；清單自己把它停用（`disable`）也算了結，之後啟用回同一份宣告會重掛、再停用，去重鍵同所以不再記一筆。
 *   Loader 在自我停用那一格的呼叫點發的 `loader/self-disable`（`vendor/loader` 本地修改第 10 條，只有那一格發；`ctx.fiber.update()`
 *   走的 `internal/commit` 不發）經 {@link PluginTree.onSelfDisable} 交給宿主，serve 把它記成 `self-disabled`
 *   （`plugin-failure-recorder.ts`）。
 *   **偏離 dsh（未實測的推論，撤除條件：讀清單改成不是每條 thread 都推）**：dsh 任何一次協調（plugin-manager 操作、HMR 偵測到
 *   patch 檔改了）都會把 Include 的樹重疊一遍、把自我停用的列蓋回啟用；這裡只在那一列自己的宣告改了才重試，因為 nexus 每條
 *   thread 都重推一次——照 dsh「每次協調都蓋回」就是原本的閃動。
 * - **`cordis.serve.yml` 不經 Include**：Include 只有一個 `path`，serve 專屬那一層是相容層疊在出貨層後面的另一個檔。
 *   那一層裡的函式插件上不了樹（它們會在這裡被判成 `absent`，指名原因）；今天那一層沒有函式插件。
 *
 * @module
 */

import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

import type { StructuredToolInterface } from '@langchain/core/tools';
import { createAgentLoopProvider } from '@nexus/agent-loop/provider';
import type { PreStepEntry } from '@nexus/agent-loop/provider';
import type { ApprovalChannel } from '@nexus/approval-channel';
import { createApprovalChannelProvider } from '@nexus/approval-channel/provider';
import { createCommandsProvider } from '@nexus/commands/provider';
import type { CommandEntry } from '@nexus/commands/provider';
import type { CommandDefinition, ProjectionUnit, SessionLookup } from '@nexus/core';
import { Context } from '@nexus/cordis';
import type { Message } from '@nexus/cordis';
import Include from '@nexus/cordis-plugin-include';
import Loader from '@nexus/cordis-plugin-loader';
import type { EntryOptions } from '@nexus/cordis-plugin-loader';
import { createProjectionsProvider } from '@nexus/projections/provider';
import type { ProjectionEntry } from '@nexus/projections/provider';
import { feedbackToken } from '@nexus/feedback';
import { goalsToken } from '@nexus/goal';
import { permissionPresetsToken } from '@nexus/permission-presets';
import { ContractError, FIBER_STATE, missingServices } from '@nexus/sdk';
import type { ServiceToken } from '@nexus/sdk';
import { createSessionLookupProvider } from '@nexus/session/provider';
import type { SessionParticipantEntry } from '@nexus/session/provider';
import { createFsLookupProvider } from '@nexus/fs/provider';
import type { FsLookup } from '@nexus/fs';
import { createSkillSourcesProvider } from '@nexus/skills/provider';
import { systemPromptToken } from '@nexus/system-prompt';
import type { SystemPrompt, SystemPromptAssembly } from '@nexus/system-prompt';
import type { SkillSourceEntry } from '@nexus/skills/provider';
import { createToolsProvider } from '@nexus/tools/provider';
import type { ToolGateListener, ToolRegisterOptions, ToolResultListener } from '@nexus/tools';
import type { ToolEntry } from '@nexus/tools/provider';
import semver from 'semver';

import { declarationSignature, normalizedConfig } from './plugin-row-state.js';
import { ThreadSessions } from './thread-sessions.js';

/** 工具登記處那一列的 id。 */
export const TOOLS_ROW_ID = 'tools';

/** 投影登記處那一列的 id。 */
export const PROJECTIONS_ROW_ID = 'projections';

/** 技能來源登記處那一列的 id。 */
export const SKILL_SOURCES_ROW_ID = 'skill-sources';

/** 命令登記處那一列的 id。 */
export const COMMANDS_ROW_ID = 'commands';

/** 答題管道那一列的 id（#1458）。 */
export const APPROVAL_CHANNEL_ROW_ID = 'approval-channel';

/** 會話查找那一列的 id（#1463）。 */
export const SESSION_LOOKUP_ROW_ID = 'session-lookup';

/** fs 查找那一列的 id（#1466）。 */
export const FS_ROW_ID = 'fs';

/**
 * `agent/pre-step` 登記處那一列的 id（#1474）。**刻意不叫 `agent-loop`**：`startup-audit.ts` 已經把 dsh 名單上的 `agent-loop` 對到
 * 「組裝本身」（`nexus-compat`），同名會讓兩個對照分不清。
 */
export const PRE_STEP_ROW_ID = 'pre-step';

/** Include 那一列的 id。 */
export const INCLUDE_ROW_ID = 'include';

/**
 * 宿主從樹上讀的服務的契約範圍（#1456 Q2 (a)）：**插件提供、宿主消費**的那一類。
 *
 * 前面的接縫都是插件消費宿主的服務，範圍寫在插件的 `inject` 裡，由 Cordis 在消費者 fiber 注入時檢查
 * （`ContractService` 的 `[Service.check]`）。這一類反過來，宿主從 root 讀，**沒有 fiber，那道檢查不會發生**——所以宿主自己
 * 在取的那一處比：範圍寫在這裡，取定義套件契約版本的主版號。不合就判**提供者那一列**掉（`stage: 'requires'`），
 * 訊息的消費者寫「宿主」，指名提供者與兩個版本。
 */
export const FEEDBACK_SERVICE_RANGE = '^1.0.0';

/**
 * `goals` 服務的契約範圍（#1486 Q3 (a)）：跟 {@link FEEDBACK_SERVICE_RANGE} 同一類——插件提供、宿主消費，折進這條 thread 的
 * `registry.services`。**它不是 #1477 條件 2 那一類**（活的 `systemPrompt` 不准折進去，因為它的段會跨 thread 越疊越多）：`goals` 的狀態是
 * 逐份 root 日誌（`WeakMap<SessionLog, GoalService>`），折進每條 thread 的是同一份服務、問的是各自的日誌；相容層的插件拿得到它，
 * 拿任何日誌去問都只是建出（或取到）那份日誌自己的一份，不會互相疊加。契約寫明只收 root 日誌。
 */
export const GOALS_SERVICE_RANGE = '^1.0.0';

/**
 * `permissionPresets` 服務的契約範圍（#1491 Q3 (a)）：跟 {@link FEEDBACK_SERVICE_RANGE} 同一類——插件提供、宿主消費，折進這條 thread 的
 * `registry.services`。宿主組一條 thread 時叫它的 `start`（純函式：不碰日誌也不碰控制器）拿起始值與這條 thread 的目錄。
 */
export const PERMISSION_PRESETS_SERVICE_RANGE = '^1.2.0';

/** 宿主取的每一個服務：token 與範圍。加一個「插件提供、宿主消費」的服務就在這裡多一格。 */
const HOST_SERVICES: readonly { readonly token: ServiceToken<unknown>; readonly range: string }[] =
  [
    { token: feedbackToken as ServiceToken<unknown>, range: FEEDBACK_SERVICE_RANGE },
    { token: goalsToken as ServiceToken<unknown>, range: GOALS_SERVICE_RANGE },
    {
      token: permissionPresetsToken as ServiceToken<unknown>,
      range: PERMISSION_PRESETS_SERVICE_RANGE,
    },
  ];

/**
 * `systemPrompt` 服務的契約範圍（#1477）。它**不在 {@link HOST_SERVICES} 裡**：那一類的值是活的 proxy、整個折進這條 thread 的
 * `registry.services`（`registerFolded` 自動 `provide`）；`systemPrompt` 不准這樣——相容層的插件拿到行程級的活服務就能呼叫 `section()`，
 * 段會跨 thread 越疊越多。宿主改在 {@link PluginTree} 的臨界區裡 `assemble()` 一次，只留**資料**（快照）。
 */
export const SYSTEM_PROMPT_SERVICE_RANGE = '^1.0.0';

/** 樹上某一列提供、宿主取到的服務：服務名與當下取到的值（Cordis 的 traceable proxy，列卸載之後仍能呼叫）。 */
export interface HostService {
  readonly name: string;
  readonly value: unknown;
}

/**
 * 從樹上讀一個服務的歸屬與契約版本。**`strict` 預設**：只認 ACTIVE 的提供者，列掉了或卸載了就是 `undefined`。
 * 讀不出字串型的 `provider` 與 `contractVersion` 的不是契約服務，不認。
 */
function readHostService(
  root: Context,
  token: ServiceToken<unknown>,
): { value: unknown; provider: string; version: string } | undefined {
  const value = root.get(token.name) as
    { readonly provider?: unknown; readonly contractVersion?: unknown } | undefined;
  if (value === undefined || value === null) return undefined;
  const { provider, contractVersion } = value;
  if (typeof provider !== 'string' || typeof contractVersion !== 'string') return undefined;
  return { value, provider, version: contractVersion };
}

/** 契約版本不在宿主要的範圍裡時的訊息；沒有問題回 `undefined`。 */
function hostRangeProblem(
  token: ServiceToken<unknown>,
  range: string,
  provider: string,
  version: string,
): string | undefined {
  if (semver.satisfies(version, range)) return undefined;
  return `宿主要的服務 ${token.name} 是 ${range}，${provider} 提供的是 ${version}`;
}

/** Include 底下每一列 id 的前綴（上游 Include 的命名空間規則）。 */
const NAMESPACE = `${INCLUDE_ROW_ID}:`;

/** 一顆函式插件模組：有 `manifest` 具名匯出。 */
export interface FunctionPluginModule {
  readonly name?: unknown;
  readonly manifest: unknown;
  readonly [key: string]: unknown;
}

/**
 * 這個模組是不是樹上的函式插件。
 *
 * **這是唯一的判別式**：`resolveEntryModule` 用它決定一列走橋接還是走 `NexusPlugin`，Include 的允許名單
 * （`only`）是從走橋接的那幾列算出來的，所以兩邊不會漂移。判別看的是「有沒有 `manifest` 具名匯出」，不看 default：
 * 函式插件不能有 default（一致性套件的 `export-form` 格），所以有 `manifest` 又有 default 的模組是寫壞的函式插件，
 * 該報的是 manifest／匯出形式的錯，不是把它當 `NexusPlugin` 悄悄掛上。
 *
 * @param namespace - `import()` 回來的模組命名空間。
 */
export function isFunctionPluginModule(namespace: unknown): namespace is FunctionPluginModule {
  if (typeof namespace !== 'object' || namespace === null) return false;
  return (namespace as { manifest?: unknown }).manifest !== undefined;
}

/** 一列要上樹的：相容層解析後的 id、模組名、最終宣告。 */
export interface TreeRowInput {
  /** 相容層解析後的列 id（補過號）。樹上那一列是 `include:<id>`。 */
  readonly id: string;
  /** 模組 specifier，即那一列的 `name`；Include 的允許名單比它。 */
  readonly module: string;
  /** 相容層疊完之後這一列是停用的（含設定驗不過被標成停用）。 */
  readonly disabled: boolean;
  /** 相容層疊完之後這一列的 `config`（原始的，沒驗過）。 */
  readonly config: unknown;
  /**
   * 這一列的 manifest 宣告提供的服務名（`provides[].token`）。宿主據此知道「這一列**應該**提供 `systemPrompt`」：它 `active` 卻取不到
   * 服務，是這一列掉了（#1477 PM 更正 3），不是「沒有服務所以不掛」。
   */
  readonly provides: readonly string[];
}

/** 交給樹的一份輸入。 */
export interface TreeInput {
  /** 出貨 `cordis.yml` 的絕對路徑；Include 讀它。 */
  readonly shipped: string;
  /** 推給 Include 的 patch，已過濾、已補 id、已補 `config: {}`。 */
  readonly patches: readonly Record<string, unknown>[];
  /** 這一份清單上走橋接的每一列。 */
  readonly rows: readonly TreeRowInput[];
}

/** 一列在樹上的結果。 */
export type RowVerdict =
  | {
      readonly kind: 'active';
      /** 登記者就是這一列的工具。 */
      readonly tools: readonly StructuredToolInterface[];
      /**
       * 這一列登記工具時帶的註冊選項（#1458 Q3）：`rootOnly`、`outputSchema`。**只有帶了選項的工具才有一格**，沒帶的不在裡面。
       * 折進這條 thread 的 registry 時跟著工具一起交給註冊點——宿主不認得選項的語意，原樣轉交，照 dsh 的 `defineTool`。
       */
      readonly toolOptions: ReadonlyMap<StructuredToolInterface, ToolRegisterOptions>;
      /**
       * 這一列登記的核准閘門監聽（#1466 Q1 (a)，`@nexus/tools` 1.2.0 的 `gate`），**依登記順序**。折進這條 thread 的 registry
       * 時一條一條交給 `registry.approvals.gate`——來源登記成這一列的 id，所以 `approval-gate-order.test.ts` 看到的
       * 層一來源仍是 `submit-record (submit-record)`。
       */
      readonly gates: readonly ToolGateListener[];
      /**
       * 這一列登記的 `tools/result` 觀察者（#1469，`@nexus/tools` 1.3.0 的 `onResult`），**依登記順序**。折進這條 thread 的 registry
       * 時一條一條交給 `registry.events.on('tools/result', …)`：派發的時機與次序（`tool/call` → 觀察者 → `tool/result`）仍是核心
       * 圍堵的，這一層只決定「誰聽」。工具與觀察者在同一個折疊裡進同一條 thread，所以之後列被卸載也不影響已開著的 thread。
       */
      readonly resultListeners: readonly ToolResultListener[];
      /**
       * 這一列登記的 `agent/pre-step` listener（#1474，`@nexus/agent-loop` 1.0.0 的 `preStep`），**依登記順序**。折進這條 thread 的
       * registry 時一位建一顆 middleware（`registry.middleware.use`，不帶位置旗標，所以落點就是這一列在清單上的位置）：建法在
       * `pre-step-middleware.ts`，日誌用這條 thread 自己的 `registry.sessions`。
       */
      readonly preSteps: readonly Pick<PreStepEntry, 'name' | 'listener'>[];
      /**
       * 這一列登記的會話參與者（#1491，`@nexus/session` 1.1.0 的 `join`），**依登記順序**。折進這條 thread 的 registry 時一位一位交給
       * `registry.sessions.join`，**位置就是這一列在清單上的位置**（`bindToTree` 照清單順序呼叫）：日誌上事件的相對順序靠它。
       */
      readonly participants: readonly SessionParticipantEntry['participant'][];
      /**
       * **這一列負責折進這條 thread 的**投影單元（#1421）：登記者是這一列、而且這一列是那個 key 目前還活著的第一個登記者。
       * 同一個 key 由兩列共用時（提供者那一層引用計數共用，PM 決策 1），每個 key 只交給其中一列，這條 thread 的登記處才
       * 不會撞上它自己的重複拒絕（`NamedEntries`，照舊）。
       */
      readonly projections: readonly ProjectionUnit[];
      /**
       * 這一列登記的技能來源路徑（#1446），**照它登記的順序**（`sources` 依序即優先序，後面的來源贏過前面的同名 skill）。
       * 技能來源不共用：同一個目錄兩列登記，後者在提供者那裡就拒絕（Q3 (a)），所以每條路徑只會屬於一列。
       */
      readonly skillSources: readonly string[];
      /**
       * 這一列登記的命令定義（#1456），**依登記順序**。同一個名字只會屬於一列：後登記的在提供者那裡就拒絕（Q5 (a)）。
       */
      readonly commands: readonly CommandDefinition[];
      /**
       * 這一列提供、宿主取到的服務（#1456）：歸屬（`.provider`）是這一列、契約版本在宿主要的範圍裡。**每一格是組 thread
       * 時取的快照**——列之後卸載，開著的 thread 手上的這一份仍能呼叫（服務的方法不碰 `this.ctx`）。
       */
      readonly services: readonly HostService[];
      /**
       * 這一列提供的 `systemPrompt` 服務在**組 thread 的臨界區裡**取的快照（#1477）：各段原文與已登記的變數名，**純資料**。
       * 只有 manifest 宣告提供它的列才有（`undefined` 代表這一列不是它的提供者）；宣告了卻取不到的列判成 `dropped`。
       * 活的服務不外漏：折進 thread 的只有這份資料。
       */
      readonly systemPrompt: SystemPromptAssembly | undefined;
    }
  | { readonly kind: 'off' }
  | {
      readonly kind: 'dropped';
      /** 對到 `startup-audit.ts` 的 stage：FAILED／缺席是 `apply`，PENDING（缺服務、契約不相容）是 `requires`。 */
      readonly stage: 'apply' | 'requires';
      readonly message: string;
    };

/** 一次同步之後每一列的結果。 */
export interface TreeSnapshot {
  verdict(id: string): RowVerdict;
}

/** 推不上樹：Include 起不來，或清單裡有樹不收的東西。整份的錯，不是某一列的。 */
export class PluginTreeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PluginTreeError';
  }
}

/**
 * 樹上裸 specifier（`@nexus/plugin-echo`）的解析：錨在這個檔所在的專案（`apps/harness`），跟 Loader 預設的輔助檔
 * 錨在 `cordis.yml` 所在目錄是同一個專案。**給了它 Loader 就不在安裝樹裡寫 `.cordis/{.gitignore,resolve.mjs}`**
 * （`vendor/loader` 本地修改第 9 條）：唯讀的安裝樹、別的帳號建過的目錄，都不該讓插件掛不上，也不該在
 * 安裝樹裡多出檔案。
 */
const resolveBareSpecifier = (specifier: string): string => import.meta.resolve(specifier);

const treeId = (id: string): string => `${NAMESPACE}${id}`;

/**
 * 樹上帶 `__jsExpr` 的物件會被 Loader 的 `interpolate` 當 JavaScript `eval` 掉（`vendor/loader/src/config/utils.ts`），
 * 而設定來自變更紀錄與 `--patch`：寫入口的使用者、部署端都不該有「經設定檔執行任意程式」的路。
 *
 * 三個地方各擋一次：相容層讀清單時掃走橋接那幾列的最終 `config`（寫入前驗證走同一條，所以寫入口當場擋下、
 * 不會把會讓之後每次啟動都失敗的東西寫進紀錄）；推上樹之前再把整份 patch 掃一遍，是「演算法對不上」時的後盾；
 * 第三道在 vendor 的 Include：它讀完出貨檔、疊完 patch、交給 Loader 之前，掃那份真正會被 eval 的樹（`vendor/README.md`
 * 本地修改第 11 條，#1461）。rc.11 起 Loader 連 `disabled` 都會 eval，而出貨檔那一列不經 patch，前兩道看不到它。
 *
 * @param value - 要掃的東西（設定或 patch）。
 * @param where - 訊息裡怎麼稱呼它的位置。
 * @returns 第一個帶 `__jsExpr` 的位置；沒有就是 `undefined`。
 */
export function findJsExpr(value: unknown, where: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findJsExpr(item, `${where}[${String(index)}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === '__jsExpr') return where;
    const found = findJsExpr(item, `${where}.${key}`);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** {@link findJsExpr} 找到了就拋。 */
function assertNoJsExpr(value: unknown, where: string): void {
  const found = findJsExpr(value, where);
  if (found === undefined) return;
  throw new PluginTreeError(
    `${found} 帶了 \`__jsExpr\`：樹上的設定不接受表達式（Loader 會把它 eval 掉）。拒絕這一份清單。`,
  );
}

/** 一列插件自己停用了自己（#1424）：Loader 在自我停用那一格的呼叫點發的，經 {@link PluginTree.onSelfDisable} 交給宿主。 */
export interface SelfDisableEvent {
  /** 相容層解析後的列 id（不帶樹上的 `include:` 前綴）。 */
  readonly id: string;
  /** 模組 specifier，即那一列的 `name`。 */
  readonly module: string;
}

/** {@link PluginTree} 的建構選項。 */
export interface PluginTreeOptions {
  /**
   * 這棵樹上預設的答題管道（#1458 Q1 (c)）：進入點（serve「有人在」、CLI headless）依自己的情境算出來，建樹時交進來，
   * 樹把它放進 `approval-channel` 那一列。ask-user 只消費它，不自己決定。不給就是「宿主沒有指定」：那一列照樣掛著，
   * 服務的值是 `undefined`，ask-user 在呼叫當下拒絕（fail-closed，#669）。
   */
  readonly channel?: ApprovalChannel;
  /**
   * 這個行程的工作區根（主機路徑；#1491 Q4 (a)）：進入點照 `resolveWorkspaceRoot(invocation.workspace, cwd)` 算出來，建樹時交進來，
   * 樹把它放進 `fs` 那一列（`@nexus/fs` 的 `workspaceRoot()`）。`permission-presets` 在 `apply` 當下據它決定掛不掛 `/permission`。
   * 不給就是沒有 `--workspace`（檔案系統沒有圍堵）。
   */
  readonly workspaceRoot?: string;
}

/** 一棵 Cordis 樹加上它的工具登記處與 Include。 */
export class PluginTree {
  readonly #channel: ApprovalChannel | undefined;
  #context?: Promise<Context>;
  #provider = createToolsProvider();
  #projections = createProjectionsProvider();
  #skillSources = createSkillSourcesProvider();
  #preSteps = createAgentLoopProvider();
  #commands = createCommandsProvider();
  #approvalChannel: ReturnType<typeof createApprovalChannelProvider>;
  /** 行程裡每一條活著的 thread 綁上的註冊表（#1463）：`session-lookup` 那一列問它，入口的 `attachSession` 往它登記。 */
  readonly #threadSessions = new ThreadSessions();
  #sessionLookup = createSessionLookupProvider((config) => this.#threadSessions.forCall(config));
  /** fs 查找（#1466）：同一張登記表、同一支挑法，一筆登記同時帶這條 thread 的 fs 把手；另帶行程級的工作區根（#1491）。 */
  #fsLookup: ReturnType<typeof createFsLookupProvider>;
  readonly #workspaceRoot: string | undefined;
  /** 串行化 {@link run}。 */
  #chain: Promise<unknown> = Promise.resolve();
  /** 最後一次推給 Include 的設定簽章；一樣就不推。 */
  #signature?: string;
  #epoch = 0;
  /** 契約不相容的錯誤，以消費者那一列的 id 為鍵：Cordis 把它交給提供者的 logger，要對回消費者得自己收。 */
  readonly #contractErrors = new Map<string, ContractError>();
  #disposed = false;
  /**
   * **自我停用過的列**（#1424，Q1 (b)）：鍵是樹上的列 id，值是它**停用當時**宣告的簽章。宣告沒變就一直算停著（不推
   * `epoch`、判成 `off`，並由宿主替它推一條 `{ id, disabled: true }` 給 Include，見 {@link sync}）；宣告改了、那一列又起來了、
   * 或清單自己把它停用了就忘掉。只活在這個行程裡：重啟就是新的一棵樹，那一列重新試一次。
   */
  readonly #selfDisabled = new Map<string, string>();
  /** 已經交給 {@link onSelfDisable} 的（列 id ＋ 宣告簽章）：同一個行程裡同一件事只講一次（#1424 推導 4）。 */
  readonly #announced = new Set<string>();

  /**
   * 宿主掛上來的接收者：插件自己停用了自己時呼叫（同一個行程裡、同一列同一份宣告只呼叫一次）。**同步呼叫，不要拋、
   * 不要等**：它在 Loader 卸載那一列的路上被叫到。今天只有 serve 掛它，把這件事記進變更紀錄；CLI 與沒有樹的呼叫端不掛，
   * 閃動照樣止住（記憶體那一頭）。
   */
  onSelfDisable?: (event: SelfDisableEvent) => void;

  constructor(options: PluginTreeOptions = {}) {
    this.#channel = options.channel;
    this.#approvalChannel = createApprovalChannelProvider(options.channel);
    this.#workspaceRoot = options.workspaceRoot;
    this.#fsLookup = createFsLookupProvider(
      (config) => this.#threadSessions.fsForCall(config),
      options.workspaceRoot,
    );
  }

  /** 這棵樹上 `fs` 那一列交出去的工作區根（建樹時交進來的那一份）；沒有圍堵是 `undefined`。給測試與審計對照用。 */
  get workspaceRoot(): string | undefined {
    return this.#workspaceRoot;
  }

  /**
   * 這棵樹預設的答題管道（建樹時交進來的那一份）。**給測試與審計對照用**：樹上 `approvalChannel` 服務的值與這個一致，
   * 進入點算出來的與組裝根（`createHostServicesPlugin`）算出來的一致，是 #1458 驗收 E 的一格。
   */
  get channel(): ApprovalChannel | undefined {
    return this.#channel;
  }

  /**
   * 這棵樹上活著的 thread 的註冊表（#1463）。**登記面**給 `createNexusAgent` 的 `attachSession`（綁上去之後才登記、撤除掛在它的
   * detach 上）；**查找面**是樹上 `session-lookup` 那一列，插件只從那裡問。
   */
  get threadSessions(): ThreadSessions {
    return this.#threadSessions;
  }

  /**
   * 這棵樹的根 context。第一次呼叫才建：根、Loader 與 `tools`、`projections`、`skill-sources`、`commands`、
   * `approval-channel`、`session-lookup`、`fs`、`pre-step` 那八列。
   *
   * @returns 已掛好 Loader 與上述八列的根。
   */
  context(): Promise<Context> {
    this.#context ??= this.#build();
    return this.#context;
  }

  async #build(): Promise<Context> {
    const root = new Context();
    root.logger.exporter({
      export: (message: Message) => {
        if (message.type !== 'error') return;
        for (const arg of message.args) {
          if (arg instanceof ContractError) this.#contractErrors.set(arg.consumer, arg);
        }
      },
    });
    await root.plugin(Loader);
    root.loader.resolver = resolveBareSpecifier;
    // Loader 自我停用那一格的呼叫點發的（`vendor/loader` 本地修改第 10 條）：只有插件自己 `ctx.fiber.dispose()` 才有。
    root.on('loader/self-disable', (entry, legacy) => this.#noteSelfDisable(root, entry, legacy));
    Object.assign(root.loader.builtins, {
      [TOOLS_ROW_ID]: this.#provider.Provider,
      [PROJECTIONS_ROW_ID]: this.#projections.Provider,
      [SKILL_SOURCES_ROW_ID]: this.#skillSources.Provider,
      [COMMANDS_ROW_ID]: this.#commands.Provider,
      [APPROVAL_CHANNEL_ROW_ID]: this.#approvalChannel.Provider,
      [SESSION_LOOKUP_ROW_ID]: this.#sessionLookup.Provider,
      [FS_ROW_ID]: this.#fsLookup.Provider,
      [PRE_STEP_ROW_ID]: this.#preSteps.Provider,
      [INCLUDE_ROW_ID]: Include,
    });
    await this.#create(root, { id: TOOLS_ROW_ID, name: `cordis:${TOOLS_ROW_ID}` });
    await this.#create(root, { id: PROJECTIONS_ROW_ID, name: `cordis:${PROJECTIONS_ROW_ID}` });
    await this.#create(root, { id: SKILL_SOURCES_ROW_ID, name: `cordis:${SKILL_SOURCES_ROW_ID}` });
    await this.#create(root, { id: COMMANDS_ROW_ID, name: `cordis:${COMMANDS_ROW_ID}` });
    await this.#create(root, {
      id: APPROVAL_CHANNEL_ROW_ID,
      name: `cordis:${APPROVAL_CHANNEL_ROW_ID}`,
    });
    await this.#create(root, {
      id: SESSION_LOOKUP_ROW_ID,
      name: `cordis:${SESSION_LOOKUP_ROW_ID}`,
    });
    await this.#create(root, { id: FS_ROW_ID, name: `cordis:${FS_ROW_ID}` });
    await this.#create(root, { id: PRE_STEP_ROW_ID, name: `cordis:${PRE_STEP_ROW_ID}` });
    await root.loader.await();
    return root;
  }

  #noteSelfDisable(
    root: Context,
    entry: { readonly options: { readonly id: string; readonly name: string } },
    legacy: { readonly config?: unknown },
  ): void {
    // 只管 Include 底下的列（橋接列）：它們在 Include 的群組裡，`entry.options.id` 是不帶前綴的本地 id，樹上的完整 id 是
    // `include:<id>`；`tools`、`projections`、`include` 自己是樹的骨架，不在這一組。用身分比，不用字串猜。
    const id = entry.options.id;
    const treeRowId = treeId(id);
    try {
      if (root.loader.resolve(treeRowId) !== entry) return;
    } catch {
      return;
    }
    const module = entry.options.name;
    const signature = declarationSignature(id, module, legacy.config);
    this.#selfDisabled.set(treeRowId, signature);
    if (this.#announced.has(signature)) return;
    this.#announced.add(signature);
    try {
      this.onSelfDisable?.({ id, module });
    } catch {
      // 接收者不該拋；拋了也不能讓 Loader 卸載那一列的路上多一種結局。
    }
  }

  /** `EntryTree.create` 的型別不收 id，執行期照用（探針 `tree.ts` 的 `createEntry`）：列 id 要由我們決定。 */
  #create(root: Context, options: EntryOptions): Promise<unknown> {
    return root.loader.create(options as Omit<EntryOptions, 'id'>);
  }

  /**
   * 跑一段臨界區：同一棵樹上的 {@link run} 一次只跑一段。
   *
   * @param work - 臨界區的內容，通常是「讀清單、{@link sync}、取快照」。
   */
  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(work, work);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  /**
   * 把清單推給 Include、等收斂、取每一列的結果。**呼叫端要在 {@link run} 裡。**
   *
   * @param input - 這一份清單。
   * @returns 每一列的結果。
   * @throws {PluginTreeError} Include 起不來，或清單帶了樹不收的東西。
   */
  async sync(input: TreeInput): Promise<TreeSnapshot> {
    const root = await this.context();
    assertNoJsExpr(input.patches, 'patch');
    const only = [...new Set(input.rows.map((row) => row.module))];
    this.#forgetSettled(input);
    const forced = this.#needsRetry(root, input);
    if (forced) this.#epoch += 1;
    // 自我停用過、宣告沒變的列：由宿主替它推一條 `disabled`（#1424）。Include 每次重疊（改了樹上別列的設定、整列重建）都把
    // 每一列的 options 整份換掉，不推的話那一列會被蓋回啟用、重掛一次；推了，不論怎麼重疊它都維持停用。宣告一改記憶就
    // 忘掉（`#needsRetry`），這一條也跟著不推，那一列重試。
    const held = input.rows
      .filter((row) => !row.disabled && this.#stillSelfDisabled(treeId(row.id), row))
      .map((row) => ({ id: row.id, disabled: true }));
    const config = {
      path: pathToFileURL(input.shipped).href,
      patches: [...structuredClone(input.patches), ...held],
      only,
      ...(this.#epoch === 0 ? {} : { epoch: this.#epoch }),
    };
    const signature = JSON.stringify(config);
    const loader = root.loader;
    const existing = this.#includeEntry(root);
    if (existing === undefined) {
      await this.#create(root, { id: INCLUDE_ROW_ID, name: `cordis:${INCLUDE_ROW_ID}`, config });
      await loader.await();
    } else if (signature !== this.#signature) {
      if (this.#includeState(root) !== FIBER_STATE.ACTIVE) {
        // 上一次沒起來（檔壞了又好了）：整列拆掉重建，不在 FAILED 的 fiber 上更新。
        await existing.fiber?.ctx.fiber.dispose();
        loader.remove(INCLUDE_ROW_ID);
        await this.#create(root, { id: INCLUDE_ROW_ID, name: `cordis:${INCLUDE_ROW_ID}`, config });
      } else {
        try {
          await existing.update({ config } as never);
        } catch (error) {
          // Include 已經起來之後的更新被它自己拒了（例如重讀到的檔帶 `__jsExpr`，vendor 本地修改第 11 條）：同樣是整份的錯。
          throw new PluginTreeError(
            `清單推不上樹：${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }
      await loader.await();
    }
    this.#signature = signature;
    if (this.#includeState(root) !== FIBER_STATE.ACTIVE) {
      const message = await this.#failureOf(root, INCLUDE_ROW_ID);
      throw new PluginTreeError(`Include 那一列沒有起來，清單推不上樹：${message}`);
    }
    return this.#snapshot(root, input.rows);
  }

  #includeEntry(root: Context) {
    try {
      return root.loader.resolve(INCLUDE_ROW_ID);
    } catch {
      return undefined;
    }
  }

  #includeState(root: Context): number | undefined {
    return this.#includeEntry(root)?.fiber?.ctx.fiber.state;
  }

  /**
   * 這一份清單要不要強推一次（推 `epoch`）：有一列清單想要它起來、樹上卻是停用的，而且**不是**「自我停用過、宣告沒變」那一種。
   *
   * 自我停用過的列（#1424）宣告沒變就一直停著，不強推——這就是止住閃動的那一處；宣告變了就忘掉記憶、強推一次，插件重新
   * 掛上、重新試一次。樹上停用卻沒有記憶的（不是自我停用留下的，或是兩邊疊出來的不一致）照舊強推，`#verdictOf` 會報成掉了。
   */
  #needsRetry(root: Context, input: TreeInput): boolean {
    if (this.#includeEntry(root) === undefined) return false;
    let retry = false;
    for (const row of input.rows) {
      if (row.disabled) continue;
      let disabled = false;
      try {
        disabled = root.loader.resolve(treeId(row.id)).options.disabled === true;
      } catch {
        continue;
      }
      if (!disabled) continue;
      if (this.#stillSelfDisabled(treeId(row.id), row)) continue;
      this.#selfDisabled.delete(treeId(row.id));
      retry = true;
    }
    return retry;
  }

  /**
   * 這一份清單已經「了結」的記憶：清單自己把那一列停用了（之後再啟用回同一份宣告，要讓插件重掛、再停用——去重鍵同，不會再記
   * 一筆），或那一列已不在清單上。
   */
  #forgetSettled(input: TreeInput): void {
    const live = new Set(input.rows.filter((row) => !row.disabled).map((row) => treeId(row.id)));
    for (const id of [...this.#selfDisabled.keys()]) {
      if (!live.has(id)) this.#selfDisabled.delete(id);
    }
  }

  /** 這一列自我停用過、而且清單上它現在的宣告（簽章）跟停用當時一樣。 */
  #stillSelfDisabled(id: string, row: TreeRowInput): boolean {
    const remembered = this.#selfDisabled.get(id);
    return (
      remembered !== undefined &&
      remembered === declarationSignature(row.id, row.module, row.config)
    );
  }

  async #failureOf(root: Context, id: string): Promise<string> {
    try {
      const fiber = root.loader.resolve(id).fiber?.ctx.fiber;
      if (fiber === undefined) return '模組載不進來';
      const error = await fiber.await().then(
        () => undefined,
        (reason: unknown) => reason,
      );
      return error instanceof Error
        ? error.message
        : String(error ?? `fiber 狀態 ${String(fiber.state)}`);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async #snapshot(root: Context, rows: readonly TreeRowInput[]): Promise<TreeSnapshot> {
    const entries = this.#provider.entries();
    const verdicts = new Map<string, RowVerdict>();
    for (const row of rows) verdicts.set(row.id, await this.#verdictOf(root, row, entries));
    // 宿主取的服務先分：契約版本不合的那一列在這裡判掉，後面三個 `#assign*` 只看 `active` 的列，掉了的不會被當成登記者。
    this.#assignServices(root, rows, verdicts);
    await this.#assignSystemPrompt(root, rows, verdicts);
    this.#assignProjections(rows, verdicts, this.#projections.entries());
    this.#assignSkillSources(rows, verdicts, this.#skillSources.entries());
    this.#assignCommands(rows, verdicts, this.#commands.entries());
    return {
      verdict: (id) =>
        verdicts.get(id) ?? {
          kind: 'dropped',
          stage: 'apply',
          message: `樹上沒有 ${id} 這一列的結果（它不在這一次推給樹的清單裡）`,
        },
    };
  }

  /**
   * 把共用的投影單元分給列（#1421）：每個 key 只給**這一份清單上起來了的**第一個登記者。
   *
   * 提供者那一層引用計數共用：同 key 同 `stateVersion` 的兩列都起來，登記處只有一份。這條 thread 的登記處每個 key 只收
   * 一份（重複拒絕照舊），所以折進去的人只能有一個——取「登記順序上第一個、在這份清單上是 `active` 的列」，而不是提供者
   * 記的第一個：登記者在提供者那裡還在、在清單上卻掉了（設定與樹上對不上）時，單元不能跟著它一起丟掉，要換下一個。
   */
  #assignProjections(
    rows: readonly TreeRowInput[],
    verdicts: Map<string, RowVerdict>,
    entries: readonly ProjectionEntry[],
  ): void {
    const owned = new Map<string, ProjectionUnit[]>();
    const rowIdOf = new Map(rows.map((row) => [treeId(row.id), row.id]));
    for (const entry of entries) {
      // 登記順序上第一個、在這份清單上是 `active` 的登記者。
      const owner = entry.sources
        .map((source) => rowIdOf.get(source))
        .find((id) => id !== undefined && verdicts.get(id)?.kind === 'active');
      if (owner === undefined) continue;
      const units = owned.get(owner) ?? [];
      units.push(entry.unit);
      owned.set(owner, units);
    }
    for (const row of rows) {
      const verdict = verdicts.get(row.id);
      if (verdict?.kind !== 'active') continue;
      verdicts.set(row.id, { ...verdict, projections: owned.get(row.id) ?? [] });
    }
  }

  /**
   * 把技能來源路徑分給列（#1446）：登記者是哪一列就交給哪一列，**照登記順序**。
   *
   * 不共用，所以不像 {@link #assignProjections} 要挑「第一個起來的」：提供者已經讓同一個目錄只有一個登記者。登記者不是
   * `active` 的列（掉了、停用）它的登記已經隨那一列撤掉，這裡再用 verdict 擋一次，是「提供者還沒撤、清單上已經判掉」
   * 的那一小段不外漏。
   */
  #assignSkillSources(
    rows: readonly TreeRowInput[],
    verdicts: Map<string, RowVerdict>,
    entries: readonly SkillSourceEntry[],
  ): void {
    const owned = new Map<string, string[]>();
    const rowIdOf = new Map(rows.map((row) => [treeId(row.id), row.id]));
    for (const entry of entries) {
      const owner = rowIdOf.get(entry.source);
      if (owner === undefined || verdicts.get(owner)?.kind !== 'active') continue;
      const paths = owned.get(owner) ?? [];
      paths.push(entry.path);
      owned.set(owner, paths);
    }
    for (const row of rows) {
      const verdict = verdicts.get(row.id);
      if (verdict?.kind !== 'active') continue;
      verdicts.set(row.id, { ...verdict, skillSources: owned.get(row.id) ?? [] });
    }
  }

  /**
   * 把宿主取的服務分給列（#1456）：提供者（`.provider`）是哪一列就交給哪一列，**只交給 `active` 的那一列**。
   *
   * 讀的是 root 上當下的值：`root.get` 預設 strict，列沒起來（PENDING、FAILED）或已卸載的提供者讀不到。歸屬對不到這一份清單上
   * 任何一列的（別的東西提供的同名服務）不認。契約版本不在宿主要的範圍裡（{@link FEEDBACK_SERVICE_RANGE}）就判提供者那一列
   * 掉在 `requires`——Cordis 的 `check` 只在消費者 fiber 注入時跑，宿主從 root 讀沒有那道檢查（#1456 Q2 (a)）。
   */
  #assignServices(
    root: Context,
    rows: readonly TreeRowInput[],
    verdicts: Map<string, RowVerdict>,
  ): void {
    const rowIdOf = new Map(rows.map((row) => [treeId(row.id), row.id]));
    const owned = new Map<string, HostService[]>();
    for (const { token, range } of HOST_SERVICES) {
      const found = readHostService(root, token);
      if (found === undefined) continue;
      const owner = rowIdOf.get(found.provider);
      if (owner === undefined || verdicts.get(owner)?.kind !== 'active') continue;
      const problem = hostRangeProblem(token, range, found.provider, found.version);
      if (problem !== undefined) {
        verdicts.set(owner, { kind: 'dropped', stage: 'requires', message: problem });
        owned.delete(owner);
        continue;
      }
      const services = owned.get(owner) ?? [];
      services.push({ name: token.name, value: found.value });
      owned.set(owner, services);
    }
    for (const row of rows) {
      const verdict = verdicts.get(row.id);
      if (verdict?.kind !== 'active') continue;
      verdicts.set(row.id, { ...verdict, services: owned.get(row.id) ?? [] });
    }
  }

  /**
   * 取 `systemPrompt` 服務的快照，交給提供它的那一列（#1477）。**在 `run` 的臨界區裡取**（`#snapshot` 本來就在臨界區裡）：臨界區只包
   * 「讀清單、sync、取快照」，不包組裝，如果等到 `registerFolded` 才問，中間可能已經被別條 thread 的重讀插隊，拿到的是新的 persona，甚至是空段。
   *
   * - 只看 manifest 宣告提供 `systemPrompt` 的、`active` 的列。
   * - **宣告了卻取不到**（讀不出字串型的 `provider`／`contractVersion`、歸屬不是這一列、`assemble()` 拋）：判成 `dropped`，寫明原因，
   *   讓必掛稽核接住——不然這一列 `active`、稽核也過，宿主卻看到「沒有服務」就不掛，一條沒有 persona 的 thread 靜靜組起來。
   * - 契約版本不在 {@link SYSTEM_PROMPT_SERVICE_RANGE} 裡：判在 `requires`（同 {@link #assignServices} 的做法）。
   * - 取到的是 `assemble()` 回的資料（各段原文、變數名）；活的服務物件不往下傳。
   */
  async #assignSystemPrompt(
    root: Context,
    rows: readonly TreeRowInput[],
    verdicts: Map<string, RowVerdict>,
  ): Promise<void> {
    const found = readHostService(root, systemPromptToken as ServiceToken<unknown>);
    for (const row of rows) {
      if (!row.provides.includes(systemPromptToken.name)) continue;
      const verdict = verdicts.get(row.id);
      if (verdict?.kind !== 'active') continue;
      const id = treeId(row.id);
      if (found === undefined || found.provider !== id) {
        verdicts.set(row.id, {
          kind: 'dropped',
          stage: 'apply',
          message:
            `${id} 的 manifest 宣告提供 ${systemPromptToken.name}，樹上卻取不到它的服務` +
            (found === undefined
              ? '（讀不到，或讀到的不是契約服務）'
              : `（歸屬是 ${found.provider}）`),
        });
        continue;
      }
      const problem = hostRangeProblem(
        systemPromptToken as ServiceToken<unknown>,
        SYSTEM_PROMPT_SERVICE_RANGE,
        found.provider,
        found.version,
      );
      if (problem !== undefined) {
        verdicts.set(row.id, { kind: 'dropped', stage: 'requires', message: problem });
        continue;
      }
      try {
        const assembly = await (found.value as SystemPrompt).assemble();
        verdicts.set(row.id, { ...verdict, systemPrompt: assembly });
      } catch (error) {
        verdicts.set(row.id, {
          kind: 'dropped',
          stage: 'apply',
          message: `${id} 的 ${systemPromptToken.name} 服務取不了快照：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  /**
   * 把命令定義分給列（#1456）：登記者是哪一列就交給哪一列，**照登記順序**。
   *
   * 不共用，所以不像 {@link #assignProjections} 要挑「第一個起來的」：提供者已經讓同一個名字只有一個登記者。登記者不是
   * `active` 的列（掉了、停用，包括 {@link #assignServices} 剛判掉的）它的登記已經隨那一列撤掉，這裡再用 verdict 擋一次，是
   * 「提供者還沒撤、清單上已經判掉」的那一小段不外漏。
   */
  #assignCommands(
    rows: readonly TreeRowInput[],
    verdicts: Map<string, RowVerdict>,
    entries: readonly CommandEntry[],
  ): void {
    const owned = new Map<string, CommandDefinition[]>();
    const rowIdOf = new Map(rows.map((row) => [treeId(row.id), row.id]));
    for (const entry of entries) {
      const owner = rowIdOf.get(entry.source);
      if (owner === undefined || verdicts.get(owner)?.kind !== 'active') continue;
      const definitions = owned.get(owner) ?? [];
      definitions.push(entry.definition);
      owned.set(owner, definitions);
    }
    for (const row of rows) {
      const verdict = verdicts.get(row.id);
      if (verdict?.kind !== 'active') continue;
      verdicts.set(row.id, { ...verdict, commands: owned.get(row.id) ?? [] });
    }
  }

  async #verdictOf(
    root: Context,
    row: TreeRowInput,
    entries: readonly ToolEntry[],
  ): Promise<RowVerdict> {
    const id = treeId(row.id);
    if (row.disabled) {
      // 關掉的列不再等契約：留著舊的錯，之後重新啟用時會把別的原因講成它。
      this.#contractErrors.delete(id);
      return { kind: 'off' };
    }
    let entry;
    try {
      entry = root.loader.resolve(id);
    } catch {
      this.#contractErrors.delete(id);
      return {
        kind: 'dropped',
        stage: 'apply',
        message:
          `樹上沒有 ${id} 這一列：Include 只讀出貨的 cordis.yml，` +
          '寫在 cordis.serve.yml 的函式插件、或出貨檔裡沒寫 id 的列上不了樹',
      };
    }
    // 兩支疊 patch 的演算法對不上時，不靜靜地各走各的。
    if (entry.options.disabled === true) {
      // 自我停用過、宣告沒變：不是掉了，是它自己停的（#1424）。判成 `off`，不進 `failed` 的記錄器。
      if (this.#stillSelfDisabled(id, row)) return { kind: 'off' };
      return {
        kind: 'dropped',
        stage: 'apply',
        message:
          '樹上這一列是停用的，清單疊出來卻是啟用的（插件自己停用了自己，或兩邊疊出來的不一致）',
      };
    }
    if (!isDeepStrictEqual(normalizedConfig(entry.options.config), normalizedConfig(row.config))) {
      return {
        kind: 'dropped',
        stage: 'apply',
        message: '樹上這一列的設定與清單疊出來的不一致（兩邊疊 patch 的結果對不上）',
      };
    }
    const fiber = entry.fiber?.ctx.fiber;
    if (fiber === undefined) {
      return { kind: 'dropped', stage: 'apply', message: '模組載不進來' };
    }
    if (fiber.state === FIBER_STATE.ACTIVE) {
      // 起來了：之前記的契約錯誤作廢（只有仍在等服務的列才用得到它）；自我停用的記憶也作廢。
      this.#contractErrors.delete(id);
      this.#selfDisabled.delete(id);
      return {
        kind: 'active',
        tools: entries.filter((item) => item.source === id).map((item) => item.tool),
        toolOptions: toolOptionsOf(entries.filter((item) => item.source === id)),
        gates: this.#provider
          .gates()
          .filter((item) => item.source === id)
          .map((item) => item.listener),
        resultListeners: this.#provider
          .resultListeners()
          .filter((item) => item.source === id)
          .map((item) => item.listener),
        preSteps: this.#preSteps
          .preSteps()
          .filter((item) => item.source === id)
          .map(({ name, listener }) => ({ name, listener })),
        participants: this.#sessionLookup
          .participants()
          .filter((item) => item.source === id)
          .map((item) => item.participant),
        // 投影單元由 `#assignProjections` 在所有列的結果都有了之後再分：共用的 key 只能給一列。
        projections: [],
        // 技能來源路徑由 `#assignSkillSources` 在所有列的結果都有了之後再分。
        skillSources: [],
        // 命令定義與宿主取的服務也一樣（`#assignCommands`、`#assignServices`）。
        commands: [],
        services: [],
        // 系統提示詞的快照由 `#assignSystemPrompt` 取（要 await 服務的 `assemble()`，且要在所有列的結果都有了之後）。
        systemPrompt: undefined,
      };
    }
    if (fiber.state === FIBER_STATE.FAILED) {
      return { kind: 'dropped', stage: 'apply', message: await this.#failureOf(root, id) };
    }
    if (fiber.state === FIBER_STATE.PENDING) {
      const contract = this.#contractErrors.get(id);
      if (contract !== undefined) {
        return { kind: 'dropped', stage: 'requires', message: contract.message };
      }
      const missing = missingServices(fiber);
      return {
        kind: 'dropped',
        stage: 'requires',
        message: `等不到 ${missing.join('、') || '（不明）'}`,
      };
    }
    return {
      kind: 'dropped',
      stage: 'apply',
      message: `fiber 狀態停在 ${String(fiber.state)}`,
    };
  }

  /** 卸載整棵樹；還沒建或已卸載時什麼都不做。 */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const pending = this.#context;
    this.#context = undefined;
    const root = await pending?.catch(() => undefined);
    await root?.fiber.dispose();
  }
}

/** 一組工具登記裡帶了選項的那些：工具實例 → 選項。沒帶選項的不進表（`Map` 只是索引，不是清單）。 */
function toolOptionsOf(
  entries: readonly ToolEntry[],
): ReadonlyMap<StructuredToolInterface, ToolRegisterOptions> {
  const options = new Map<StructuredToolInterface, ToolRegisterOptions>();
  for (const entry of entries) {
    if (entry.options !== undefined) options.set(entry.tool, entry.options);
  }
  return options;
}

/** {@link mountDetached} 的輸入。 */
export interface DetachedMount {
  /** 列 id。 */
  readonly id: string;
  /** 模組命名空間（`import()` 的結果）。 */
  readonly module: FunctionPluginModule;
  /** 那一列的設定（原始的）。 */
  readonly config: unknown;
  /** 這一列的 manifest 宣告提供的服務名；同 {@link TreeRowInput.provides}，用來判斷「應該提供 `systemPrompt`」。省略就是空。 */
  readonly provides?: readonly string[];
  /**
   * 這一次單獨掛上時預設的答題管道（#1458）。**沒有樹的呼叫端也要有**：`bindDetached` 從組裝的 registry 讀 `channel` 服務交進來，
   * 不給等於「宿主沒有指定」（ask-user 在呼叫當下拒絕）。
   */
  readonly channel?: ApprovalChannel;
  /**
   * 這一次單獨掛上時的會話查找（#1463）。**沒有樹的呼叫端也要有**：`bindDetached` 把那一次組裝自己的
   * `registry.sessions.forCall` 交進來——**只看那一份註冊表**，所以同一個行程裡兩份無樹組裝互不相見。不給等於這次組裝沒接上
   * 會話（`not-attached`，插件在呼叫當下拒絕）。
   */
  readonly sessionLookup?: (config: unknown) => SessionLookup;
  /**
   * 這一次單獨掛上時的 fs 查找（#1466）。**沒有樹的呼叫端也要有**：`bindDetached` 把那一次組裝自己的 host-services
   * `fs` 服務交進來（呼叫當下才讀它的 backend）——只看那一份，所以兩份無樹組裝互不相見。不給等於這次組裝沒有 fs
   * （`not-attached`，插件在呼叫當下拒絕）。
   */
  readonly fsLookup?: (config: unknown) => FsLookup;
  /**
   * 這一次單獨掛上時的工作區根（#1491 Q4 (a)）。**沒有樹的呼叫端也要有**：`bindDetached` 從那一次組裝的 host 服務 `workspaceRoot`
   * 讀出來交進來（組裝點只在有 `--workspace` 時提供它）；不給等於沒有圍堵。
   */
  readonly workspaceRoot?: string;
}

/** {@link mountDetached} 取出的東西：這一列登記的工具、投影單元、技能來源路徑、命令定義，與它提供、宿主取到的服務。 */
export interface DetachedContributions {
  readonly tools: readonly StructuredToolInterface[];
  /** 帶了註冊選項的工具與它的選項（#1458 Q3），同 {@link RowVerdict} 的 `toolOptions`。 */
  readonly toolOptions: ReadonlyMap<StructuredToolInterface, ToolRegisterOptions>;
  /** 這一列登記的核准閘門監聽（#1466），同 {@link RowVerdict} 的 `gates`。 */
  readonly gates: readonly ToolGateListener[];
  /** 這一列登記的 `tools/result` 觀察者（#1469），同 {@link RowVerdict} 的 `resultListeners`。 */
  readonly resultListeners: readonly ToolResultListener[];
  /** 這一列登記的 `agent/pre-step` listener（#1474），同 {@link RowVerdict} 的 `preSteps`。 */
  readonly preSteps: readonly Pick<PreStepEntry, 'name' | 'listener'>[];
  /** 這一列登記的會話參與者（#1491），同 {@link RowVerdict} 的 `participants`。 */
  readonly participants: readonly SessionParticipantEntry['participant'][];
  readonly projections: readonly ProjectionUnit[];
  readonly skillSources: readonly string[];
  readonly commands: readonly CommandDefinition[];
  readonly services: readonly HostService[];
  /** 這一列提供的 `systemPrompt` 服務的快照（#1477），**在卸載之前取**；同 {@link RowVerdict} 的 `systemPrompt`。 */
  readonly systemPrompt: SystemPromptAssembly | undefined;
}

/**
 * 不經產品的樹，把一顆函式插件單獨掛一次、取出它登記的工具、投影單元與技能來源路徑、立刻卸載。
 *
 * 給**沒有樹的呼叫端**用：手搭 `PluginEntry` 清單、直接 `createCliAgent` 的測試與基準任務，以及 `shippedPlugins()`。
 * 走的是跟產品同一條路（真的 Loader、真的 `tools` 提供者、真的 `ctx.effect`），差別只在樹是用完即丟的。
 * **產品路徑不走這裡**：`cli.ts`／`serve.ts` 把 {@link PluginTree} 交給 `loadDefaultPlugins`，工具從那棵長壽的樹來。
 *
 * 卸載之後拿出去的工具物件照樣能用——它們是閉包了設定值的純函式（決議 §3-2 第 6 條）。
 *
 * @throws {Error} 那一列沒有起來，訊息同樹上的判定。
 */
export async function mountDetached(mount: DetachedMount): Promise<DetachedContributions> {
  const provider = createToolsProvider();
  const projections = createProjectionsProvider();
  const skillSources = createSkillSourcesProvider();
  const commands = createCommandsProvider();
  const approvalChannel = createApprovalChannelProvider(mount.channel);
  const sessionLookup = createSessionLookupProvider(
    mount.sessionLookup ?? (() => ({ kind: 'not-attached' })),
  );
  const fsLookup = createFsLookupProvider(
    mount.fsLookup ?? (() => ({ kind: 'not-attached' })),
    mount.workspaceRoot,
  );
  const preSteps = createAgentLoopProvider();
  const root = new Context();
  const contractErrors = new Map<string, ContractError>();
  root.logger.exporter({
    export: (message: Message) => {
      if (message.type !== 'error') return;
      for (const arg of message.args) {
        if (arg instanceof ContractError) contractErrors.set(arg.consumer, arg);
      }
    },
  });
  try {
    await root.plugin(Loader);
    root.loader.resolver = resolveBareSpecifier;
    Object.assign(root.loader.builtins, {
      [TOOLS_ROW_ID]: provider.Provider,
      [PROJECTIONS_ROW_ID]: projections.Provider,
      [SKILL_SOURCES_ROW_ID]: skillSources.Provider,
      [COMMANDS_ROW_ID]: commands.Provider,
      [APPROVAL_CHANNEL_ROW_ID]: approvalChannel.Provider,
      [SESSION_LOOKUP_ROW_ID]: sessionLookup.Provider,
      [FS_ROW_ID]: fsLookup.Provider,
      [PRE_STEP_ROW_ID]: preSteps.Provider,
      plugin: mount.module,
    });
    const create = (options: EntryOptions) =>
      root.loader.create(options as Omit<EntryOptions, 'id'>);
    await create({ id: TOOLS_ROW_ID, name: `cordis:${TOOLS_ROW_ID}` });
    await create({ id: PROJECTIONS_ROW_ID, name: `cordis:${PROJECTIONS_ROW_ID}` });
    await create({ id: SKILL_SOURCES_ROW_ID, name: `cordis:${SKILL_SOURCES_ROW_ID}` });
    await create({ id: COMMANDS_ROW_ID, name: `cordis:${COMMANDS_ROW_ID}` });
    await create({ id: APPROVAL_CHANNEL_ROW_ID, name: `cordis:${APPROVAL_CHANNEL_ROW_ID}` });
    await create({ id: SESSION_LOOKUP_ROW_ID, name: `cordis:${SESSION_LOOKUP_ROW_ID}` });
    await create({ id: FS_ROW_ID, name: `cordis:${FS_ROW_ID}` });
    await create({ id: PRE_STEP_ROW_ID, name: `cordis:${PRE_STEP_ROW_ID}` });
    await create({
      id: mount.id,
      name: 'cordis:plugin',
      config: normalizedConfig(mount.config) as Record<string, unknown>,
    });
    await root.loader.await();
    const fiber = root.loader.resolve(mount.id).fiber?.ctx.fiber;
    if (fiber?.state === FIBER_STATE.ACTIVE) {
      // 宿主取的服務：歸屬是這一列、契約版本在範圍裡；不合就拋，同樹上那一條（`#assignServices`）。這一份列掛在用完即丟的根上，
      // 之後根被卸載，取到的值仍能呼叫。
      const services: HostService[] = [];
      for (const { token, range } of HOST_SERVICES) {
        const found = readHostService(root, token);
        if (found === undefined || found.provider !== mount.id) continue;
        const problem = hostRangeProblem(token, range, found.provider, found.version);
        if (problem !== undefined) throw new Error(problem);
        services.push({ name: token.name, value: found.value });
      }
      // 系統提示詞的快照：**在 `finally` 卸載這棵用完即丟的根之前取**（卸載後三段已撤）。宣告了提供卻取不到就拋，同樹上的 `dropped`。
      let systemPrompt: SystemPromptAssembly | undefined;
      if (mount.provides?.includes(systemPromptToken.name) === true) {
        const found = readHostService(root, systemPromptToken as ServiceToken<unknown>);
        if (found === undefined || found.provider !== mount.id) {
          throw new Error(
            `${mount.id} 的 manifest 宣告提供 ${systemPromptToken.name}，掛上之後卻取不到它的服務`,
          );
        }
        const problem = hostRangeProblem(
          systemPromptToken as ServiceToken<unknown>,
          SYSTEM_PROMPT_SERVICE_RANGE,
          found.provider,
          found.version,
        );
        if (problem !== undefined) throw new Error(problem);
        systemPrompt = await (found.value as SystemPrompt).assemble();
      }
      const owned = provider.entries().filter((entry) => entry.source === mount.id);
      return {
        tools: owned.map((entry) => entry.tool),
        toolOptions: toolOptionsOf(owned),
        gates: provider
          .gates()
          .filter((entry) => entry.source === mount.id)
          .map((entry) => entry.listener),
        resultListeners: provider
          .resultListeners()
          .filter((entry) => entry.source === mount.id)
          .map((entry) => entry.listener),
        preSteps: preSteps
          .preSteps()
          .filter((entry) => entry.source === mount.id)
          .map(({ name, listener }) => ({ name, listener })),
        participants: sessionLookup
          .participants()
          .filter((entry) => entry.source === mount.id)
          .map((entry) => entry.participant),
        projections: projections
          .entries()
          .filter((entry) => entry.sources.includes(mount.id))
          .map((entry) => entry.unit),
        skillSources: skillSources
          .entries()
          .filter((entry) => entry.source === mount.id)
          .map((entry) => entry.path),
        commands: commands
          .entries()
          .filter((entry) => entry.source === mount.id)
          .map((entry) => entry.definition),
        services,
        systemPrompt,
      };
    }
    if (fiber?.state === FIBER_STATE.FAILED) {
      const error = await fiber.await().then(
        () => undefined,
        (reason: unknown) => reason,
      );
      throw error instanceof Error ? error : new Error(String(error));
    }
    const contract = contractErrors.get(mount.id);
    if (contract !== undefined) throw contract;
    const missing = fiber === undefined ? [] : missingServices(fiber);
    throw new Error(
      `${mount.id} 沒有起來（狀態 ${String(fiber?.state ?? '沒有 fiber')}）：等不到 ${missing.join('、') || '（不明）'}`,
    );
  } finally {
    await root.fiber.dispose();
  }
}
