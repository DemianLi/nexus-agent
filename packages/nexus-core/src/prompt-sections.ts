/**
 * 系統提示詞的**中段**接在洋蔥的哪一格（[#2414](https://github.com/DemianLi/nexus-agent/issues/2414)）。
 *
 * 中段是插件與組裝點交的文字（計劃模式指引、先讀後改、沙箱政策、核准政策句…），形狀見 `@nexus/system-prompt` 的 `PromptSection`。
 * 這裡把「文字」與「接在哪一格」拆開：文字是段，接法是這裡的轉接，**一格一顆**，各在 `fold.ts` 槽位表裡固定的那一格。
 * 兩個 loop 跑的是同一顆。
 *
 * ## 為什麼不在洋蔥外一次接完
 *
 * 摘要器排在其中幾格之間，估 token 時算的是當下的 `request.systemMessage`（`token-estimate.ts`）：計劃指引、平行句、先讀後改在它外層，
 * 它看得到；插件政策段（沙箱、MCP、`@` 路徑）、委派聲明、核准政策句在它內層，它看不到。那個估算決定什麼時候摘要，也落盤成 `context/measure.approxTokens`。一次接完會改這兩件事，
 * 所以跟摘要器一起留到 #2416。
 *
 * ## 接法
 *
 * - 每一段各成請求裡的一塊：`SystemMessage.concat(字串)` 在內容是區塊陣列時另開一塊（`@langchain/core` `messages/base.js` 的 `mergeContent`），
 *   開頭是段自己的 `separator`。
 * - 函式型的段每次模型呼叫現算，回 `''` 就這一次不接（先讀後改在沒有寫檔工具時、平行句在這一格看不到 `subagent` 時）。
 * - 同一格裡照 `order`、同值照登記的先後。
 *
 * @module
 */

import { SystemMessage } from '@langchain/core/messages';
import { renderMiddleSection, SECTION_ORDERS } from '@nexus/system-prompt';
import type { PromptSection, SectionAgent, SectionContext } from '@nexus/system-prompt';
import { createMiddleware } from 'langchain';

import type { AgentMiddleware } from './base-types.js';
import { toolCallSessionAddress } from './session-address.js';

/** `plugins.prepended` 最後面那一格的名字。 */
export const PREPENDED_SECTIONS_MIDDLEWARE_NAME = 'nexusPromptSections:prepended';
/** `plugins.rest` 最前面那一格的名字。 */
export const PLUGIN_SECTIONS_MIDDLEWARE_NAME = 'nexusPromptSections:plugins';
/** 先讀後改那一格的名字。 */
export const OBSERVATION_SECTION_MIDDLEWARE_NAME = 'nexusPromptSections:observation';

/**
 * 插件登記的段（`registry.prompt`）接在哪一格、接哪幾個 `order`。格的位置在 `fold.ts` 的 `pluginMiddleware`。
 *
 * 先讀後改、委派聲明、核准政策句三段是組裝點自己的，各在自己那一格（`fold.ts` 的槽位表），插件不能登記那三個值。
 */
export const SECTION_SLOT_ORDERS = {
  /** `plugins.prepended` 的最後面：計劃模式指引、平行句。 */
  prepended: [SECTION_ORDERS.PLAN_POLICY, SECTION_ORDERS.BACKGROUND_DELEGATION],
  /** `plugins.rest` 的最前面：沙箱政策、MCP、`@` 路徑。 */
  plugins: [SECTION_ORDERS.PLUGIN_POLICY],
} as const satisfies Record<string, readonly number[]>;

/** 插件登記得了的值。 */
export const PLUGIN_SECTION_ORDERS: readonly number[] = [
  ...SECTION_SLOT_ORDERS.prepended,
  ...SECTION_SLOT_ORDERS.plugins,
];

/**
 * 從一串段裡挑出落在某一格的，照 `order`、同值照原本的先後。
 *
 * @param sections - 依登記順序的段。
 * @param orders - 這一格接的值。
 */
export function sectionsIn(
  sections: readonly PromptSection[],
  orders: readonly number[],
): PromptSection[] {
  return sections
    .map((section, index) => ({ section, index }))
    .filter(({ section }) => orders.includes(section.order))
    .sort((a, b) => a.section.order - b.section.order || a.index - b.index)
    .map(({ section }) => section);
}

/** 這一次呼叫是誰，照 `toolCallSessionAddress` 的認法。 */
function agentOf(call: unknown): SectionAgent | undefined {
  const address = toolCallSessionAddress(call);
  if (address === undefined) return undefined;
  return address.kind === 'root' ? { kind: 'root' } : { kind: 'subagent', id: address.runId };
}

/** 一次模型請求裡，這幾格用得到的欄位。 */
interface SectionRequest {
  readonly systemMessage?: SystemMessage;
  readonly tools?: readonly unknown[];
  readonly runtime?: { readonly configurable?: unknown };
}

/**
 * 這一次呼叫在這一格看到的。
 *
 * @param request - 模型請求。
 */
export function sectionContextOf(request: SectionRequest): SectionContext {
  // middleware 拿不到 handler 形狀的 config，只有 `runtime.configurable`；包回一層就是 `forCall` 要的那份。
  const call = { configurable: request.runtime?.configurable };
  return {
    agent: agentOf(call),
    call,
    tools: (request.tools ?? []).flatMap((tool) => {
      const name = (tool as { readonly name?: unknown }).name;
      return typeof name === 'string' ? [name] : [];
    }),
  };
}

/**
 * 把這幾段接上一次模型請求。
 *
 * 沒有 `systemMessage` 的請求在兩個 loop 上都不會出現（`langchain` 的 `AgentNode` 與 native 的洋蔥起點都先建好一則），這裡當它是空的
 * 一則接。
 *
 * @param request - 模型請求。
 * @param sections - 這一格的段，已照順序。
 */
export function applySections<Request extends SectionRequest>(
  request: Request,
  sections: readonly PromptSection[],
): Request {
  const context = sectionContextOf(request);
  let message = request.systemMessage;
  for (const section of sections) {
    const block = renderMiddleSection(section, context);
    if (block === undefined) continue;
    message = (message ?? new SystemMessage('')).concat(block);
  }
  return message === request.systemMessage ? request : { ...request, systemMessage: message };
}

/**
 * 一格的轉接：每次模型呼叫把這幾段接上去。
 *
 * @param name - middleware 的名字。背景子代理的圖照名字換掉核准政策句與委派聲明那兩格（`subagent-graph.ts`），所以那兩格的名字是
 *   `APPROVAL_POLICY_PROMPT_MIDDLEWARE_NAME`、`SUBAGENT_DELEGATION_MIDDLEWARE_NAME`。
 * @param sections - 這一格的段，已照順序（{@link sectionsIn}）。
 * @returns middleware。
 */
export function createSectionSlotMiddleware(
  name: string,
  sections: readonly PromptSection[],
): AgentMiddleware {
  return createMiddleware({
    name,
    wrapModelCall: (request, handler) => handler(applySections(request, sections)),
  }) as unknown as AgentMiddleware;
}
