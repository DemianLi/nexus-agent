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
 * checkpointer / store、核准政策的 session 開關，加一份基座工具名單）從
 * {@link CreateNexusAgentOptions} 進來，原樣交給 fold：**所有權在這裡，檢查跑在 core**。
 *
 * 這也是 fold 的產物第一次真的碰到基座。基座在建構時還有三道自己的檢查是 fold 看不到的：
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
 *
 * 組裝點還負責一件基座**設了但等於沒設**的事：agent 迴圈的上限。見
 * {@link DEFAULT_RECURSION_LIMIT}。
 */

import {
  assertInvariantSelection,
  createInvariantRunner,
  foldRegistry,
  formatOrigin,
  loadPlugins,
  SessionTelemetryCoordinator,
  type AgentCheckpointer,
  type AgentModel,
  type AgentStore,
  type ApprovalPolicy,
  type InvariantError,
  type InvariantSelection,
  type NexusPlugin,
  type PluginRegistry,
  type SessionLog,
  type SessionTelemetrySharingStatus,
} from '@nexus/core';
import { createDeepAgent, StateBackend } from 'deepagents';
import type { AnyBackendProtocol } from 'deepagents';
import { BASE_TOOL_NAMES, RESERVED_BASE_TOOL_NAMES } from './base-tools.js';

export interface CreateNexusAgentOptions {
  /** plugin 清單。順序有意義：middleware 的順序、以及 `except` 的射程都跟著它。 */
  readonly plugins: readonly NexusPlugin[];
  /**
   * 模型。**刻意是必填**——基座省略時會退到它自己的預設（`anthropic:claude-sonnet-4-6`），
   * 那會讓「忘了指定」與「就是要 Anthropic」看起來一模一樣，而前者的代價是打一支
   * 沒人預期的付費 API。預設供應商的決策（Anthropic）不受影響：那是清單怎麼寫的事，
   * 不是這裡該替人填的預設值。
   */
  readonly model: AgentModel;
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
  /** checkpointer。有 plugin 宣告要核准的工具卻沒給，fold 會報錯。 */
  readonly checkpointer?: AgentCheckpointer;
  /** 長期記憶用的 store。 */
  readonly store?: AgentStore;
  /** 核准政策的 session 開關。省略即「這個 session 有人在」。 */
  readonly approvals?: ApprovalPolicy;
  /** 附加在基座 base prompt 前面的 system prompt。 */
  readonly systemPrompt?: string;
  /**
   * agent 迴圈的上限，單位是 LangGraph 的 super-step。省略即 {@link DEFAULT_RECURSION_LIMIT}。
   *
   * **一定要設，因為基座的預設等於沒有上限**——見 {@link DEFAULT_RECURSION_LIMIT}。
   * 換算是 `recursionLimit = 2 × 模型輪數 + 2`（模型一輪、工具一輪各算一個 super-step）。
   */
  readonly recursionLimit?: number;
  /**
   * 哪些 package 的不變量檢查要真的裝上去。省略即全裝。
   *
   * **這是次要的那個開關。** 條目層的 {@link NexusPlugin.disabled} 才是主要答案：一個配套
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
 * 迴圈上限的預設值。
 *
 * ## 為什麼要自己設一個
 *
 * **基座把它調到一個保證不會觸發的值。** `createDeepAgent` 最後一步是
 * `createAgent(...).withConfig({ recursionLimit: 1e4 })` —— 一萬個 super-step，換算成
 * **約 5,000 輪模型呼叫**。2026-08-28 用 [`LoopingChatModel`](./looping-model.ts) 實測過：裸基座與我們的
 * 組裝點都跑到 `GraphRecursionError: Recursion limit of 10000 reached`，模型分別被叫了
 * 5000 與 4999 次。**那不是護欄，是一個關掉的護欄。**
 *
 * 這是 [`baseline.test.ts`](./baseline.test.ts) 那條「基座還是不是我們以為的那個形狀」
 * 的另一型：上次是我們掛的 middleware 關掉了基座的預設，這次是**基座自己**把預設轉到底，
 * 而且它藏在 dist 的一行 `withConfig` 裡 —— 型別、文件、README 全都看不到。
 *
 * ## 為什麼是 100
 *
 * 換算後約 49 輪模型呼叫。實測跑掉的那一次（[#86](https://github.com/DemianLi/nexus-agent/pull/86)，
 * `llama-3.2-11b` 在一題基準任務上多叫了 25 次工具、792.8 秒、110,936 token）大約要
 * 57 個 super-step，所以這個值攔得住它，而正常的基準任務（最長 3 次工具呼叫 ≈ 8 個
 * super-step）離它還很遠。**它是「跑掉了」的界線，不是「複雜任務」的界線** —— 真的需要
 * 更長的呼叫端自己傳一個大的，那時那個數字會出現在呼叫端的程式碼裡而不是沒有人設過。
 */
export const DEFAULT_RECURSION_LIMIT = 100;

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
 * @throws 清單載入失敗（重名、`requires` 缺件、`apply` 拋錯）、`invariants` 的 pattern 不合法、
 *   fold 的前置條件不成立，或基座自己在建構時擋下這份組裝——四種都在載入期發生，
 *   不會拖到跑起來才炸。
 */
export async function createNexusAgent(options: CreateNexusAgentOptions) {
  const { registry, dispose } = await loadPlugins(options.plugins);

  try {
    assertNoBaseToolNameCollision(registry);
    // 選擇的合法性在**這裡**驗，不是等接線時才驗：runner 是每一份會話日誌各建一個的，
    // 壞掉的 regex 預設會拖到第一輪對話才炸，那不是組裝失敗該出現的地方。
    if (options.invariants !== undefined) assertInvariantSelection(options.invariants);

    const params = foldRegistry(registry, {
      defaultBackend: options.backend ?? new StateBackend(),
      toolOrder: options.toolOrder,
      baseToolNames: options.baseToolNames ?? BASE_TOOL_NAMES,
      model: options.model,
      checkpointer: options.checkpointer,
      store: options.store,
      approvals: options.approvals,
    });

    // `withConfig` 疊在基座自己那一層 `withConfig` 上面，後者贏（實測 `8` → 模型只被叫
    // 3 輪）。**推導出來的型別沒有塌**：包完之後 `invoke()` 的 `messages` 仍然是
    // `BaseMessage[]` 而不是 `any`，所以 {@link NexusAgentHandle} 那個別名照樣成立
    // ——這件事驗過，因為 `any` 是不會讓 typecheck 紅的那種壞掉。
    const agent = createDeepAgent({
      ...params,
      ...(options.systemPrompt !== undefined && { systemPrompt: options.systemPrompt }),
    }).withConfig({ recursionLimit: options.recursionLimit ?? DEFAULT_RECURSION_LIMIT });

    // 接上去但還沒收掉的協調器。**組裝點自己記著**，因為呼叫端可能只叫 `dispose()`
    // 就走人——那時 `shutdown` 標記與後端的排空都還沒發生，遙測會少掉最後一段。
    const attached = new Set<SessionTelemetryCoordinator>();
    return {
      agent,
      /**
       * 掛著的遙測服務說的共享策略，**沒掛任何東西時是 `undefined`**。
       *
       * 披露那一層只有在拿到 `undefined` 的時候才渲染「未配置」——這是 dsh 的規矩，
       * 也是為什麼這裡回的是「有沒有掛」而不是一個保險的預設值。
       */
      telemetrySharing: registry.telemetry.service()?.value.sharing as
        SessionTelemetrySharingStatus | undefined,
      /**
       * 把一份會話日誌接上遙測。**沒掛後端時回 `undefined`**——沒有後端就沒有出口，
       * 建一個把記錄丟進虛空的協調器只會讓熱路徑白付投影與脫敏的成本。
       *
       * @param log - 要鏡像的日誌。
       * @returns 收掉這一次接線的函式，或沒掛後端時的 `undefined`。
       */
      attachTelemetry(log: SessionLog): (() => Promise<void>) | undefined {
        const mounted = registry.telemetry.service();
        if (mounted === undefined) return undefined;
        const coordinator = new SessionTelemetryCoordinator({
          log,
          sink: mounted.value,
          // 現讀而不是快照：`rules()` 每次捕獲都重新問一遍，補送歷史時套的是**現在**
          // 掛著的策略。這是 dsh waterfall 的語意，折疊要接得住。
          rules: () => registry.telemetry.rules(),
        });
        attached.add(coordinator);
        return async () => {
          attached.delete(coordinator);
          await coordinator.dispose();
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
       * @param log - 要觀察的日誌。
       * @returns 收掉這一次接線的函式，或沒有配套入口時的 `undefined`。
       */
      attachInvariants(log: SessionLog): (() => void) | undefined {
        const companions = registry.invariants.companions();
        if (companions.length === 0) return undefined;
        return createInvariantRunner({
          log,
          companions,
          ...(options.invariants !== undefined && { selection: options.invariants }),
          ...(options.onInvariantViolation !== undefined && {
            onViolation: options.onInvariantViolation,
          }),
        });
      },
      async dispose() {
        // 遙測先收：後端很可能是某個 plugin 開的，plugin 的 disposer 一跑它就沒了，
        // 那時再送 `shutdown` 標記等於送進一個已經關掉的東西。
        for (const coordinator of [...attached]) {
          attached.delete(coordinator);
          await coordinator.dispose();
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

  const collect = (name: string, where: string, cite: string): void => {
    if (RESERVED_BASE_TOOL_NAMES.has(name)) collisions.push(`${cite} 在${where}註冊了 "${name}"`);
  };

  for (const [name, entry] of registry.tools.effective()) {
    collect(name, '全域', formatOrigin(entry.origin));
  }
  for (const scope of registry.tools.scopes()) {
    for (const [name, entry] of registry.tools.own(scope)) {
      collect(name, `subagent "${scope}"`, formatOrigin(entry.origin));
    }
  }
  for (const [name, entry] of registry.subagents.entries()) {
    for (const tool of entry.value.tools ?? []) {
      collect(tool.name, `subagent "${name}" 自帶的工具裡`, formatOrigin(entry.origin));
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
