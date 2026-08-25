/**
 * agent 工廠——**唯一呼叫 `createDeepAgent` 的地方**。
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
 */

import {
  foldRegistry,
  formatOrigin,
  loadPlugins,
  type AgentCheckpointer,
  type AgentModel,
  type AgentStore,
  type ApprovalPolicy,
  type NexusPlugin,
  type PluginRegistry,
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
}

/**
 * 依一份 plugin 清單建一個 agent。
 *
 * @param options - 清單，加上組裝點自有的那些。
 * @returns 建好的 deep agent。
 * @throws 清單載入失敗（重名、`requires` 缺件、`apply` 拋錯）、fold 的前置條件不成立，
 *   或基座自己在建構時擋下這份組裝——三種都在載入期發生，不會拖到跑起來才炸。
 */
export async function createNexusAgent(options: CreateNexusAgentOptions) {
  const { registry } = await loadPlugins(options.plugins);

  assertNoBaseToolNameCollision(registry);

  const params = foldRegistry(registry, {
    defaultBackend: options.backend ?? new StateBackend(),
    toolOrder: options.toolOrder,
    baseToolNames: options.baseToolNames ?? BASE_TOOL_NAMES,
    model: options.model,
    checkpointer: options.checkpointer,
    store: options.store,
    approvals: options.approvals,
  });

  return createDeepAgent({
    ...params,
    ...(options.systemPrompt !== undefined && { systemPrompt: options.systemPrompt }),
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
 * 那兩者現在恰好同一份名單，但**不是同一個概念**——`baseToolNames` 是刻意寬的驗證宇宙
 * （寬了只是多認得幾個名字），這裡是「不准叫這些名字」（寬了會擋掉合法的組裝）。
 * 把它們接成同一個旋鈕，改動其中一邊的理由就會拖著另一邊走。
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
    `工具名撞到基座內建的工具：${collisions.join('；')}。` +
      `這些名字由基座的 middleware stack 自己註冊（檔案系統工具與 task），佔用它們` +
      `不會取代基座的版本，只會讓兩個同名工具擠在一起。換個名字。` +
      `目前被基座佔住的：${[...RESERVED_BASE_TOOL_NAMES].sort().join('、')}`,
  );
}
