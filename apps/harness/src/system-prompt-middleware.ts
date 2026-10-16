/**
 * `systemPrompt` 服務的**宿主端**（[#1477](https://github.com/DemianLi/nexus-agent/issues/1477) Q1 (a)、Q2 (a)、Q4）：把快照渲染成一顆
 * 掛在模型呼叫上的 middleware，與組裝點交給它的 `model`／`cwd` 預設值。
 *
 * 服務由 `system-prompt` 那一列提供（`@nexus/plugin-system-prompt`），契約在 `@nexus/system-prompt`。宿主在組 thread 的臨界區裡
 * `assemble()` 一次取快照（`plugin-tree.ts` 的 `#assignSystemPrompt`；無樹的路徑在 `mountDetached` 卸載之前取），之後**每次模型呼叫只代入
 * 變數、不再碰服務**。這裡不 import 服務、不 import 插件的實作，只吃快照這份資料。
 *
 * ## 渲染：逐字照今天的 `applyParts`（golden C）
 *
 * 位元組敏感的細節都保留，**不改用 dsh 的 `renderPrompt`**：
 *
 * - 前段只在有內容時加；`systemMessage` 的內容是字串就 `` `${head}\n\n${原文}` ``，是區塊陣列就在最前面加一塊 `` `${head}\n\n` ``；
 * - 後段用 `SystemMessage.concat` 接 `` `\n\n${tail}` ``；
 * - 沒有 `systemMessage` 時走 `systemPrompt` 這個字串欄位：`[head, body, tail]` 濾掉空的再以 `\n\n` 接，而且**不同時改兩個欄位**；
 * - `new SystemMessage({ content })` 會丟掉原訊息的其他欄位，這個行為照舊；
 * - 插值與錯誤訊息沿用 `interpolateStrict`（中文），不用 dsh 的 `interpolate`。
 *
 * ## 什麼時候不掛
 *
 * 條件是**代入之後頭尾都是空的**，不是「有沒有服務」：服務在、`includeHarnessIdentity: false`、前後綴都空時也不掛，否則沒有
 * `systemMessage` 的請求會讓 `systemPrompt` 從 `undefined` 變成 `''`，middleware 清單也會多一顆。
 *
 * ## `model` 跟著那一步實際用的模型走（#723）
 *
 * `taggedRouteOf(request.model)?.model` 取模型實例上明著貼過的路由標籤（組裝點建的模型實例都有）；沒貼標籤的（測試替身、子代理自帶的
 * 模型）維持組裝時定的那份。同一個 id 只算一次。這就是今天 `byModel` 的語意。
 *
 * ## 預設值怎麼交：宿主內部的路，不是 `NexusServices` 擴充（PM 條件 4）
 *
 * `registerFolded` 拿到的只有這條 thread 的 registry，而 `model` 的預設（組裝的模型 id）與 `cwd`（`/`）只在 `createNexusAgent` 的選項裡。
 * 做法是組裝點在清單最前面放一個條目 {@link systemPromptDefaultsEntry}，它的 `apply` 把值記在一個以 registry 為鍵的 `WeakMap`
 * 上（鍵見 {@link DEFAULTS}）；`registerFolded` 以同一次組裝讀回。**不經 `registry.services`**，所以相容層的插件讀不到它、`NexusServices` 的型別也沒有多一格。
 * registry 是每次組裝一份（`createRegistry()`），`WeakMap` 隨它回收，兩份組裝各讀各的。
 *
 * @module
 */

import { SystemMessage } from '@langchain/core/messages';
import { taggedRouteOf } from '@nexus/core';
import type { PluginEntry, PluginRegistry } from '@nexus/core';
import { SYSTEM_PROMPT_SECTION_NAMES } from '@nexus/plugin-system-prompt';
import type { SystemPromptVariables } from '@nexus/plugin-system-prompt';
import { composeSystemPromptParts, SYSTEM_PROMPT_MIDDLEWARE_NAME } from '@nexus/system-prompt';
import type { SystemPromptAssembly, SystemPromptParts } from '@nexus/system-prompt';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';

/** 錯誤訊息裡指名的格子：段的名字 → 設定裡的欄位名。 */
const FIELD_OF: Readonly<Record<string, string>> = {
  [SYSTEM_PROMPT_SECTION_NAMES.prefix]: 'personaPrefix',
  [SYSTEM_PROMPT_SECTION_NAMES.suffix]: 'personaSuffix',
};

/**
 * 預設值的登記處：這次組裝的 `registry.middleware`（middleware 註冊點）→ 這次組裝的 `model`／`cwd`。
 *
 * **鍵是註冊點，不是 registry 本身**：觀察者會把 registry 包一層 `Proxy`（`shipped-service-reads.test.ts` 的 `watch`），同一次組裝的
 * 兩個條目拿到的就不是同一個物件；而 `registry.middleware` 是每次組裝一份、穿過 `Proxy` 仍是同一個物件的欄位，也是這個預設值最後
 * 用在的地方。
 */
const DEFAULTS = new WeakMap<object, SystemPromptVariables>();

/**
 * 組裝點交預設值的條目：**放在清單最前面**（先於 `system-prompt` 那一列折進 thread）。它不提供任何服務，只在 `apply` 當下把值記在
 * 這次組裝的 registry 上。
 *
 * @param variables - 這次組裝的 `model`（模型 id 或標籤）與 `cwd`（工具位址空間的根，`/`）。
 * @param name - 條目名，省略即 `system-prompt-variables`。一次組裝要交兩批時才會用到。
 */
export function systemPromptDefaultsEntry(
  variables: SystemPromptVariables,
  name = 'system-prompt-variables',
): PluginEntry {
  return {
    plugin: {
      name,
      apply(registry) {
        DEFAULTS.set(registry.middleware, { model: variables.model, cwd: variables.cwd });
      },
    },
  };
}

/**
 * 讀這次組裝的預設值。
 *
 * @param registry - 這條 thread（這次組裝）的 registry。
 * @returns 組裝點交的值；組裝點沒有交就是 `undefined`。
 */
export function systemPromptDefaultsOf(
  registry: PluginRegistry,
): SystemPromptVariables | undefined {
  return DEFAULTS.get(registry.middleware);
}

/**
 * 把一段文字接在系統訊息的最前面。內容可能是字串，也可能是內容區塊的陣列（提示詞快取那類會把它拆成區塊）。
 */
function prependText(message: SystemMessage, text: string): SystemMessage {
  const { content } = message;
  return new SystemMessage({
    content:
      typeof content === 'string'
        ? `${text}\n\n${content}`
        : [{ type: 'text', text: `${text}\n\n` }, ...content],
  });
}

/**
 * 把前後段接進一次模型請求。兩條入口是同一件事（照 sandbox-policy 那段註解）：`systemMessage` 在的時候改它，不在的時候
 * 由 `systemPrompt` 這個字串欄位承接；**基座兩個都讀，同一個請求裡不能同時改兩個**。
 *
 * @param request - 模型請求。
 * @param parts - 前後段。
 */
export function applySystemPromptParts<
  Request extends { systemMessage?: SystemMessage; systemPrompt?: string },
>(request: Request, { head, tail }: SystemPromptParts): Request {
  const { systemMessage } = request;
  if (systemMessage === undefined) {
    const body = request.systemPrompt ?? '';
    const text = [head, body, tail].filter((part) => part.length > 0).join('\n\n');
    return { ...request, systemPrompt: text };
  }
  let next = systemMessage;
  if (head.length > 0) next = prependText(next, head);
  if (tail.length > 0) next = next.concat(`\n\n${tail}`);
  return { ...request, systemMessage: next };
}

/**
 * 用快照建那顆 `nexusSystemPrompt` middleware。
 *
 * @param assembly - 組 thread 時取的快照（各段原文與已登記的變數名）。
 * @param defaults - 這次組裝的 `model`／`cwd`。
 * @returns middleware；**代入之後頭尾都是空的就回 `undefined`**（不掛）。
 * @throws {SystemPromptTemplateError} 某一段引用了沒有值的變數（掛載當下已驗過名字，這裡只會是別的插件登記的段出了問題）。
 */
export function createSystemPromptMiddleware(
  assembly: SystemPromptAssembly,
  defaults: SystemPromptVariables,
): AgentMiddleware | undefined {
  // 值表只有 `model`、`cwd` 兩格；快照上登記了而這裡沒有值的名字，在那次呼叫拋（`composeSystemPromptParts` 只認快照登記過的名字）。
  const valuesOf = (model: string): Record<string, string> => ({ model, cwd: defaults.cwd });
  const parts = composeSystemPromptParts(assembly, valuesOf(defaults.model), FIELD_OF);
  if (parts.head.length === 0 && parts.tail.length === 0) return undefined;
  // `{{model}}` 跟著這一步實際用的模型走（#723）：只認明著貼過路由標籤的實例；沒貼標籤的維持組裝時定的那份。同一個 id 只算一次。
  const byModel = new Map<string, SystemPromptParts>();
  const partsFor = (model: unknown): SystemPromptParts => {
    const id = taggedRouteOf(model)?.model;
    if (id === undefined || id === defaults.model) return parts;
    let cached = byModel.get(id);
    if (cached === undefined) {
      cached = composeSystemPromptParts(assembly, valuesOf(id), FIELD_OF);
      byModel.set(id, cached);
    }
    return cached;
  };
  return createMiddleware({
    name: SYSTEM_PROMPT_MIDDLEWARE_NAME,
    wrapModelCall: (request, handler) =>
      handler(applySystemPromptParts(request, partsFor((request as { model?: unknown }).model))),
  });
}
