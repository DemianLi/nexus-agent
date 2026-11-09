/**
 * 系統提示詞的**中段**接在洋蔥的哪一格（[#2414](https://github.com/DemianLi/nexus-agent/issues/2414)）。
 *
 * 中段是插件與組裝點交的文字（計劃模式指引、先讀後改、沙箱政策、核准政策句…）。頭尾兩段（身分句、前後綴）是 `@nexus/system-prompt`
 * 的契約、由樹上的 `system-prompt` 那一列提供；中段的形狀與值在這裡，`@nexus/core` 的 runtime 不經那個契約套件（它掛著 `@nexus/sdk`）。
 * 這裡把「文字」與「接在哪一格」拆開：文字是段，接法是這裡的轉接，**一格一顆**，各在 `fold.ts` 槽位表裡固定的那一格。
 * 兩個 loop 跑的是同一顆。
 *
 * ## 為什麼不在洋蔥外一次接完
 *
 * 摘要器估 token 時算的是當下的 `request.systemMessage`（`token-estimate.ts`）。它同名取代回預設疊第三格（`fold.ts` 換模型那一格的說明），
 * 這裡的每一段——計劃指引、平行句、先讀後改、插件政策段（沙箱、MCP、`@` 路徑）、委派聲明、核准政策句——都在它內層，它看不到；頭尾兩段
 * （`nexusSystemPrompt`）與記憶也在它內層，同樣看不到。它看得到的只有基底那句與 Skills（子代理的 Skills 在它內層，子代理的估算只看得到
 * `spec.systemPrompt`）。槽位表上的順序是輸出清單的順序，不是包裹層次。那個估算決定什麼時候摘要，也落盤成 `context/measure.approxTokens`。
 * 一次接完會改這兩件事，所以估算只算外層段。
 *
 * ## 接法
 *
 * - 每一格登記成系統提示那一步（`system-prompt-step.ts`）：native 的 root 與前景子代理原位直接呼叫，`langgraph` 與背景子代理經 `wrapModelCall`。
 * - 每一段各成請求裡的一塊：`SystemMessage.concat(字串)` 在內容是區塊陣列時另開一塊（`@langchain/core` `messages/base.js` 的 `mergeContent`），
 *   開頭是段自己的 `separator`。
 * - 函式型的段每次模型呼叫現算，回 `''` 就這一次不接（先讀後改在沒有寫檔工具時、平行句在這一格看不到 `subagent` 時）。
 * - 同一格裡照 `order`、同值照登記的先後。
 *
 * @module
 */

import type { SystemMessage } from '@langchain/core/messages';

import type { AgentMiddleware } from './base-types.js';
import { toolCallSessionAddress } from './session-address.js';
import { createSystemPromptStepMiddleware, systemPromptWrapWith } from './system-prompt-step.js';
import type { SystemPromptCell, SystemPromptPiece } from './system-prompt-step.js';

/**
 * 中段的排序值。照各段在洋蔥裡的先後：宿主依值把段交給它那一格接，值一換順序就跟著換，送出的位元組也跟著變
 * （`apps/harness/src/middle-section-orders.test.ts` 釘住每一個值）。全部落在 `@nexus/system-prompt` 的前綴（0）與後綴（10200）之間。
 */
export const MIDDLE_SECTION_ORDERS = {
  /** 計劃模式的指引。 */
  PLAN_POLICY: 500,
  /** 背景子代理「一起派、別乾等」那一句。 */
  BACKGROUND_DELEGATION: 510,
  /** 先讀後改的規則。 */
  FS_OBSERVATION: 1000,
  /** 子代理被委派的身分與權限範圍。只給子代理。 */
  SUBAGENT_DELEGATION: 1100,
  /** 插件的政策段：沙箱政策、MCP 伺服器、`@` 路徑。同值照登記的先後，也就是插件在出貨清單上的先後。 */
  PLUGIN_POLICY: 2000,
  /** 核准政策句。 */
  APPROVAL_POLICY: 3000,
} as const;

/** 這一次模型呼叫是誰的：root，或某一次委派出去的子代理。 */
export type SectionAgent =
  | { readonly kind: 'root' }
  | {
      readonly kind: 'subagent';
      /** 那一次委派的編號。 */
      readonly id: string;
    };

/** 函式型的段收到的：這一次模型呼叫，在這一段被接上的那一格看到的。 */
export interface SectionContext {
  /** 呼叫者。認不出來（不在圖裡、身分壞掉）是 `undefined`。 */
  readonly agent: SectionAgent | undefined;
  /** 這一次呼叫的身分，原樣交給 `registry.sessions.forCall`；段不自己解析它。 */
  readonly call: unknown;
  /** 這一格看到的工具名，照請求裡的順序。外層的 middleware 換過、濾過的，這裡是換過之後的。 */
  readonly tools: readonly string[];
}

/** 段的文字：原文，或每次模型呼叫現算的函式。函式回 `''` 就是這一次不接。 */
export type SectionText = string | ((context: SectionContext) => string);

/** 一個中段。 */
export interface MiddleSection {
  /** 段的名字，同一次組裝內不可重名。 */
  readonly name: string;
  /** 排序值，見 {@link MIDDLE_SECTION_ORDERS}。 */
  readonly order: number;
  /** 文字，照原文接，不代入變數。 */
  readonly text: SectionText;
  /** 接在前一塊後面時，自己這一塊開頭加的字（`'\n'`、`'\n\n'`、`''`）。省略即 `'\n\n'`。 */
  readonly separator?: string;
}

/**
 * 檢查一段的形狀：登記時就拋，不留到渲染才發現。`order` 接不接得上由登記的那一方再檢查。
 *
 * @param section - 要登記的段。
 * @throws 不是物件、`name` 空、`order` 不是有限的數字、帶了 `complete`／`interpolate`、`text` 不是字串或函式、`separator` 不是字串。
 */
export function assertMiddleSection(section: unknown): asserts section is MiddleSection {
  if (typeof section !== 'object' || section === null) {
    throw new TypeError('prompt.section() 要收一個物件 { name, order, text }');
  }
  const { name, order, text, separator } = section as Record<string, unknown>;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('prompt.section() 的 name 要是非空字串');
  }
  if (typeof order !== 'number' || !Number.isFinite(order)) {
    throw new TypeError(`prompt.section() "${name}" 的 order 要是有限的數字`);
  }
  for (const unsupported of ['complete', 'interpolate'] as const) {
    if (unsupported in section) {
      throw new TypeError(`prompt.section() "${name}" 帶了 ${unsupported}：不支援，不會靜靜丟掉`);
    }
  }
  if (typeof text !== 'string' && typeof text !== 'function') {
    throw new TypeError(`prompt.section() "${name}" 的 text 要是字串或函式`);
  }
  if (separator !== undefined && typeof separator !== 'string') {
    throw new TypeError(`prompt.section() "${name}" 的 separator 要是字串`);
  }
}

/**
 * 中段這一次要接的那一塊：分隔字加上文字。函式這次回 `''` 的就不接。
 *
 * @param section - 一個中段。
 * @param context - 這一次呼叫在那一格看到的。
 * @returns 要接上的一塊；`undefined` 是這一次不接。
 */
export function renderMiddleSection(
  section: MiddleSection,
  context: SectionContext,
): string | undefined {
  const text = typeof section.text === 'function' ? section.text(context) : section.text;
  if (text === '') return undefined;
  return `${section.separator ?? '\n\n'}${text}`;
}

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
  prepended: [MIDDLE_SECTION_ORDERS.PLAN_POLICY, MIDDLE_SECTION_ORDERS.BACKGROUND_DELEGATION],
  /** `plugins.rest` 的最前面：沙箱政策、MCP、`@` 路徑。 */
  plugins: [MIDDLE_SECTION_ORDERS.PLUGIN_POLICY],
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
  sections: readonly MiddleSection[],
  orders: readonly number[],
): MiddleSection[] {
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
 * 這幾段在這一次模型呼叫要接上的那幾塊，每段一塊、照順序；回 `''` 的段不接。
 *
 * @param request - 模型請求。
 * @param sections - 這一格的段，已照順序。
 */
function sectionPieces(
  request: SectionRequest,
  sections: readonly MiddleSection[],
): SystemPromptPiece[] {
  const context = sectionContextOf(request);
  return sections.flatMap((section) => {
    const block = renderMiddleSection(section, context);
    return block === undefined ? [] : [{ append: block }];
  });
}

/** 一格的系統提示那一步。 */
function sectionCell(sections: readonly MiddleSection[]): SystemPromptCell {
  return {
    step: (request) => sectionPieces(request as SectionRequest, sections),
    withoutSystemMessage: 'empty',
  };
}

/**
 * 把這幾段接上一次模型請求。
 *
 * 沒有 `systemMessage` 的請求在兩個 loop 上都不會出現（`langchain` 的 `AgentNode` 與 native 的模型節點（`native-loop/model-node.ts`）都先建好一則），這裡當它是空的
 * 一則接。
 *
 * @param request - 模型請求。
 * @param sections - 這一格的段，已照順序。
 */
export function applySections<Request extends SectionRequest>(
  request: Request,
  sections: readonly MiddleSection[],
): Request {
  return systemPromptWrapWith<Request, Request>(sectionCell(sections))(request, (next) => next);
}

/**
 * 一格的轉接：每次模型呼叫把這幾段接上去，並登記這一步（`system-prompt-step.ts`）。
 *
 * @param name - middleware 的名字。背景子代理的圖照名字換掉核准政策句與委派聲明那兩格（`subagent-graph.ts`），所以那兩格的名字是
 *   `APPROVAL_POLICY_PROMPT_MIDDLEWARE_NAME`、`SUBAGENT_DELEGATION_MIDDLEWARE_NAME`。
 * @param sections - 這一格的段，已照順序（{@link sectionsIn}）。
 * @returns middleware。
 */
export function createSectionSlotMiddleware(
  name: string,
  sections: readonly MiddleSection[],
): AgentMiddleware {
  return createSystemPromptStepMiddleware(name, sectionCell(sections));
}
