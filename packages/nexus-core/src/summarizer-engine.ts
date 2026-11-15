/**
 * 摘要器的引擎：判斷要不要摘要、切在哪、寫歷史、生摘要、溢出時重摘。演算法、門檻與字串取自 `deepagents@1.13.1` 的
 * `createSummarizationMiddleware`（`dist/langsmith-zm0ILQsV.js:2716-3237`）。`summarization.ts` 外面那幾層靠這些行為：
 * 摘要訊息的 `lc_source` 與兩種開頭（`summaryFilePathOf` 與摘要提示詞認的就是它們）、交下去的是「摘要＋留下的尾巴」；
 * 由 `summarizer-engine.test.ts` 釘住。
 *
 * 組裝點一定給 `trigger`、`keep`、`truncateArgsSettings` 與 `summaryPrompt`，不給 `model`、`trimTokensToSummarize`，
 * 所以沒有「依模型 profile 補預設」與 `initChatModel` 那兩條。
 *
 * @module
 */

import { ContextOverflowError } from '@langchain/core/errors';
import {
  AIMessage,
  getBufferString,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { resolveBackend } from 'deepagents';
import type { AnyBackendProtocol } from 'deepagents';
import { countTokensApproximately, createMiddleware } from 'langchain';

import type { AgentMiddleware } from './base-types.js';
import {
  applySummaryCutoff,
  previousSummaryCutoff,
  summaryCutoffIndex,
} from './summary-cutoffs.js';
import {
  composeSummaryHead,
  parseEntryDraft,
  parseSummaryHead,
  SUMMARY_ENTRY_INSTRUCTION,
  SUMMARY_STATE_MAX_CHARS,
} from './summary-head.js';
import type { SummaryEntryDraft } from './summary-head.js';

/** 門檻或保留量，同基座的 `ContextSize`。 */
export type EngineContextSize =
  | { readonly type: 'messages'; readonly value: number }
  | { readonly type: 'tokens'; readonly value: number }
  | { readonly type: 'fraction'; readonly value: number };

/** 引擎的設定，欄位同基座的 `SummarizationMiddlewareOptions`（只留 nexus 給的那幾個；`sessionIdOf` 基座沒有）。 */
export interface SummarizerEngineOptions {
  readonly backend: AnyBackendProtocol;
  readonly summaryPrompt: string;
  readonly trigger: readonly EngineContextSize[];
  readonly keep: EngineContextSize;
  readonly historyPathPrefix?: string;
  /**
   * 這次呼叫的歷史檔會話名（`<historyPathPrefix>/<sessionId>.md`）。每次要寫歷史檔時拿那次的 `request` 問一次。
   *
   * @param request - 這次的 `wrapModelCall` 請求。
   * @returns 會話名，不含前綴與 `.md`；同一個呼叫身分要回同一個值。
   */
  readonly sessionIdOf: (request: SessionRequest) => string;
  readonly truncateArgsSettings: {
    readonly trigger?: EngineContextSize;
    readonly keep?: EngineContextSize;
    readonly maxLength?: number;
    readonly truncationText?: string;
  };
  /**
   * 生摘要的那一次呼叫改送什麼（[#2775](https://github.com/DemianLi/nexus-agent/issues/2775)）。回 `undefined`，或沒給這一格，
   * 就照 `summaryPrompt` 的模板送一則訊息。
   *
   * @param request - 這次的 `wrapModelCall` 請求。
   * @param messagesToSummarize - 要摘的那一段，有效訊息串的開頭。
   * @param total - 有效訊息串的則數。
   * @param instruction - 最後一則 user 訊息的指令；省略是現況那一次的指令。
   * @returns 整份請求，或 `undefined`。
   */
  readonly summaryCallOf?: (
    request: SessionRequest,
    messagesToSummarize: readonly BaseMessage[],
    total: number,
    instruction?: string,
  ) => SummaryCall | undefined;
}

/** {@link SummarizerEngineOptions.summaryCallOf} 交回來的那一次呼叫。 */
export interface SummaryCall {
  /** 送出的訊息串。 */
  readonly input: BaseMessage[];
  /** 這次呼叫的選項（工具等）。 */
  readonly options: Readonly<Record<string, unknown>>;
}

/** {@link SummarizerEngineOptions.sessionIdOf} 讀得到的那一部分請求。 */
export interface SessionRequest {
  readonly runtime?: { readonly configurable?: unknown };
}

interface EngineRequest extends SessionRequest {
  readonly messages?: BaseMessage[];
  readonly state: unknown;
  readonly model?: unknown;
  readonly systemMessage?: unknown;
  readonly tools?: unknown;
}

type Handler = (request: EngineRequest) => Promise<unknown>;

const SUMMARY_PREAMBLE_HEAD =
  'You are in the middle of a conversation that has been summarized.\n\nThe full conversation history has been saved to ';
const SUMMARY_PREAMBLE_TAIL =
  ' should you need to refer back to it for details.\n\nA condensed summary follows:\n\n<summary>\n';
const SUMMARY_CLOSE = '\n</summary>';
const SUMMARY_PLAIN_PREFIX = 'Here is a summary of the conversation to date:\n\n';

/** 現況兩次都超過上限：這次摘要不成立。 */
export class SummaryStateTooLongError extends Error {
  constructor(readonly length: number) {
    super(`摘要的現況有 ${length} 個字元，超過上限 ${SUMMARY_STATE_MAX_CHARS}；不截斷，這次不摘要`);
    this.name = 'SummaryStateTooLongError';
  }
}

/**
 * @param message - 摘要訊息。
 * @returns 去掉前言與 `<summary>` 包法之後的本文；認不出包法就回整份文字。
 */
export function summaryBodyOf(message: BaseMessage): string {
  const text = message.text;
  if (text.startsWith(SUMMARY_PLAIN_PREFIX)) return text.slice(SUMMARY_PLAIN_PREFIX.length);
  const open = text.indexOf('<summary>\n');
  if (open < 0 || !text.endsWith(SUMMARY_CLOSE)) return text;
  return text.slice(open + '<summary>\n'.length, text.length - SUMMARY_CLOSE.length);
}

function isSummaryMessage(message: BaseMessage): boolean {
  if (!HumanMessage.isInstance(message)) return false;
  return message.additional_kwargs?.lc_source === 'summarization';
}

function isContextOverflow(error: unknown): boolean {
  let cause = error;
  for (;;) {
    if (!cause) break;
    if (ContextOverflowError.isInstance(cause)) return true;
    cause = typeof cause === 'object' && 'cause' in cause ? cause.cause : undefined;
  }
  return false;
}

/**
 * 建一顆摘要器引擎。回傳的 middleware 名字是 `SummarizationMiddleware`，只有 `wrapModelCall`。
 *
 * - 有效訊息串不空而 `request.model` 缺席就拋錯：摘要模型取自請求。
 * - 歷史檔寫不進去記兩條 warn、照樣摘要，摘要文字不帶歷史檔那句，外層讀成 `null`（#66）。
 * - 溢出重摘時放大的 token 估算倍率留在這顆實例裡，之後的請求沿用。
 *
 * @param options - 門檻、保留量、參數截斷、歷史檔前綴、backend、提示詞。
 * @returns 摘要器引擎。
 */
export function createSummarizerEngine(options: SummarizerEngineOptions): AgentMiddleware {
  const {
    backend,
    summaryPrompt,
    sessionIdOf,
    summaryCallOf,
    historyPathPrefix = '/conversation_history',
  } = options;
  const trigger = options.trigger;
  const keep = options.keep;
  const truncateTrigger = options.truncateArgsSettings.trigger;
  const truncateKeep: EngineContextSize = options.truncateArgsSettings.keep ?? {
    type: 'messages',
    value: 20,
  };
  const maxArgLength = options.truncateArgsSettings.maxLength ?? 2e3;
  const truncationText = options.truncateArgsSettings.truncationText ?? '...(argument truncated)';

  let tokenEstimationMultiplier = 1;

  function getMaxInputTokens(resolvedModel: unknown): number | undefined {
    const profile = (resolvedModel as { profile?: unknown }).profile;
    if (
      profile &&
      typeof profile === 'object' &&
      'maxInputTokens' in profile &&
      typeof profile.maxInputTokens === 'number'
    )
      return profile.maxInputTokens;
    return undefined;
  }

  function shouldSummarize(
    messages: readonly BaseMessage[],
    totalTokens: number,
    maxInputTokens: number | undefined,
  ): boolean {
    const adjustedTokens = totalTokens * tokenEstimationMultiplier;
    for (const t of trigger) {
      if (t.type === 'messages' && messages.length >= t.value) return true;
      if (t.type === 'tokens' && adjustedTokens >= t.value) return true;
      if (t.type === 'fraction' && maxInputTokens) {
        if (adjustedTokens >= Math.floor(maxInputTokens * t.value)) return true;
      }
    }
    return false;
  }

  function findSafeCutoffPoint(messages: readonly BaseMessage[], cutoffIndex: number): number {
    if (cutoffIndex >= messages.length || !ToolMessage.isInstance(messages[cutoffIndex]))
      return cutoffIndex;
    let forwardIdx = cutoffIndex;
    while (forwardIdx < messages.length && ToolMessage.isInstance(messages[forwardIdx]))
      forwardIdx++;
    const toolCallIds = new Set<string>();
    for (let i = cutoffIndex; i < forwardIdx; i++) {
      const toolMsg = messages[i] as ToolMessage;
      if (toolMsg.tool_call_id) toolCallIds.add(toolMsg.tool_call_id);
    }
    let backwardIdx: number | null = null;
    for (let i = cutoffIndex - 1; i >= 0; i--) {
      const msg = messages[i];
      if (AIMessage.isInstance(msg) && msg.tool_calls) {
        const aiToolCallIds = new Set(
          msg.tool_calls.map((tc) => tc.id).filter((id): id is string => id != null),
        );
        for (const id of toolCallIds)
          if (aiToolCallIds.has(id)) {
            backwardIdx = i;
            break;
          }
        if (backwardIdx !== null) break;
      }
    }
    if (backwardIdx === null) return forwardIdx;
    if (cutoffIndex - backwardIdx > cutoffIndex / 2 && cutoffIndex > 2) return forwardIdx;
    return backwardIdx;
  }

  function determineCutoffIndex(
    messages: readonly BaseMessage[],
    maxInputTokens: number | undefined,
  ): number {
    let rawCutoff: number;
    if (keep.type === 'messages') {
      if (messages.length <= keep.value) return 0;
      rawCutoff = messages.length - keep.value;
    } else if (keep.type === 'tokens' || keep.type === 'fraction') {
      const targetTokenCount =
        keep.type === 'fraction' && maxInputTokens
          ? Math.floor(maxInputTokens * keep.value)
          : keep.value;
      let tokensKept = 0;
      rawCutoff = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        const msgTokens = countTokensApproximately([messages[i]!]);
        if (tokensKept + msgTokens > targetTokenCount) {
          rawCutoff = i + 1;
          break;
        }
        tokensKept += msgTokens;
      }
    } else return 0;
    return findSafeCutoffPoint(messages, rawCutoff);
  }

  function shouldTruncateArgs(
    messages: readonly BaseMessage[],
    totalTokens: number,
    maxInputTokens: number | undefined,
  ): boolean {
    if (!truncateTrigger) return false;
    const adjustedTokens = totalTokens * tokenEstimationMultiplier;
    if (truncateTrigger.type === 'messages') return messages.length >= truncateTrigger.value;
    if (truncateTrigger.type === 'tokens') return adjustedTokens >= truncateTrigger.value;
    if (truncateTrigger.type === 'fraction' && maxInputTokens)
      return adjustedTokens >= Math.floor(maxInputTokens * truncateTrigger.value);
    return false;
  }

  function determineTruncateCutoffIndex(
    messages: readonly BaseMessage[],
    maxInputTokens: number | undefined,
  ): number {
    let rawCutoff: number;
    if (truncateKeep.type === 'messages') {
      if (messages.length <= truncateKeep.value) return messages.length;
      rawCutoff = messages.length - truncateKeep.value;
    } else if (truncateKeep.type === 'tokens' || truncateKeep.type === 'fraction') {
      const targetTokenCount =
        truncateKeep.type === 'fraction' && maxInputTokens
          ? Math.floor(maxInputTokens * truncateKeep.value)
          : truncateKeep.value;
      let tokensKept = 0;
      rawCutoff = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        const msgTokens = countTokensApproximately([messages[i]!]);
        if (tokensKept + msgTokens > targetTokenCount) {
          rawCutoff = i + 1;
          break;
        }
        tokensKept += msgTokens;
      }
    } else return messages.length;
    return findSafeCutoffPoint(messages, rawCutoff);
  }

  function countTotalTokens(
    messages: readonly BaseMessage[],
    systemMessage: unknown,
    tools: unknown,
  ): number {
    const countedMessages =
      systemMessage && SystemMessage.isInstance(systemMessage)
        ? [systemMessage, ...messages]
        : [...messages];
    const toolsArray = tools && Array.isArray(tools) && tools.length > 0 ? tools : null;
    return countTokensApproximately(countedMessages, toolsArray as never);
  }

  function compactToolResults(
    messages: BaseMessage[],
    maxInputTokens: number,
    systemMessage: unknown,
    tools: unknown,
  ): { messages: BaseMessage[]; modified: boolean } {
    const toolMessageIndices: number[] = [];
    for (let i = 0; i < messages.length; i++)
      if (ToolMessage.isInstance(messages[i])) toolMessageIndices.push(i);
    if (toolMessageIndices.length === 0) return { messages, modified: false };
    const overheadTokens = countTotalTokens(
      messages.filter((m) => !ToolMessage.isInstance(m)),
      systemMessage,
      tools,
    );
    const adjustedMax = maxInputTokens / tokenEstimationMultiplier;
    const budgetForTools = Math.max(adjustedMax * 0.7 - overheadTokens, 1e3);
    const perToolBudgetChars = Math.floor(budgetForTools / toolMessageIndices.length) * 4;
    let modified = false;
    const result = [...messages];
    for (const idx of toolMessageIndices) {
      const msg = messages[idx] as ToolMessage;
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      if (content.length > perToolBudgetChars) {
        result[idx] = new ToolMessage({
          content: content.substring(0, perToolBudgetChars) + '\n...(result truncated)',
          tool_call_id: msg.tool_call_id,
          name: msg.name,
        });
        modified = true;
      }
    }
    return { messages: result, modified };
  }

  function truncateArgs(
    messages: BaseMessage[],
    maxInputTokens: number | undefined,
    totalTokens: number,
  ): { messages: BaseMessage[]; modified: boolean } {
    if (!shouldTruncateArgs(messages, totalTokens, maxInputTokens))
      return { messages, modified: false };
    const cutoffIndex = determineTruncateCutoffIndex(messages, maxInputTokens);
    if (cutoffIndex >= messages.length) return { messages, modified: false };
    const truncatedMessages: BaseMessage[] = [];
    let modified = false;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      if (i < cutoffIndex && AIMessage.isInstance(msg) && msg.tool_calls) {
        const truncatedToolCalls = msg.tool_calls.map((toolCall) => {
          const args = (toolCall.args || {}) as Record<string, unknown>;
          const truncatedArgs: Record<string, unknown> = {};
          let toolModified = false;
          for (const [key, value] of Object.entries(args))
            if (
              typeof value === 'string' &&
              value.length > maxArgLength &&
              (toolCall.name === 'write_file' || toolCall.name === 'edit_file')
            ) {
              truncatedArgs[key] = value.substring(0, 20) + truncationText;
              toolModified = true;
            } else truncatedArgs[key] = value;
          if (toolModified) {
            modified = true;
            return { ...toolCall, args: truncatedArgs };
          }
          return toolCall;
        });
        // 同基座：`modified` 是整串累計的旗標，一旦為真，之後每一則帶工具呼叫的舊訊息都重建一顆。
        if (modified) {
          truncatedMessages.push(
            new AIMessage({
              content: msg.content,
              tool_calls: truncatedToolCalls,
              additional_kwargs: msg.additional_kwargs,
            }),
          );
        } else truncatedMessages.push(msg);
      } else truncatedMessages.push(msg);
    }
    return { messages: truncatedMessages, modified };
  }

  async function offloadToBackend(
    messages: readonly BaseMessage[],
    request: EngineRequest,
  ): Promise<string | null> {
    const resolvedBackend = await resolveBackend(backend, { state: request.state } as never);
    const filePath = `${historyPathPrefix}/${sessionIdOf(request)}.md`;
    const filteredMessages = messages.filter((msg) => !isSummaryMessage(msg));
    const newSection = `## Summarized at ${new Date().toISOString()}\n\n${getBufferString(filteredMessages)}\n\n`;
    const sectionBytes = new TextEncoder().encode(newSection);
    try {
      let existingBytes: Uint8Array | null = null;
      if (resolvedBackend.downloadFiles)
        try {
          const responses = await resolvedBackend.downloadFiles([filePath]);
          if (responses.length > 0 && responses[0]!.content && !responses[0]!.error)
            existingBytes = responses[0]!.content;
        } catch {
          // 同基座：讀不到就當成沒有舊檔。
        }
      let result: { error?: unknown };
      if (existingBytes && resolvedBackend.uploadFiles) {
        const combined = new Uint8Array(existingBytes.byteLength + sectionBytes.byteLength);
        combined.set(existingBytes, 0);
        combined.set(sectionBytes, existingBytes.byteLength);
        const uploadResults = await resolvedBackend.uploadFiles([[filePath, combined]]);
        result = uploadResults[0]!.error ? { error: uploadResults[0]!.error } : {};
      } else if (!existingBytes) result = await resolvedBackend.write(filePath, newSection);
      else {
        const existingContent = new TextDecoder().decode(existingBytes);
        result = await resolvedBackend.edit(
          filePath,
          existingContent,
          existingContent + newSection,
        );
      }
      if (result.error) {
        console.warn(
          `Failed to offload conversation history to ${filePath}: ${String(result.error)}`,
        );
        return null;
      }
      return filePath;
    } catch (e) {
      console.warn(`Exception offloading conversation history to ${filePath}:`, e);
      return null;
    }
  }

  type SummaryModel = {
    invoke(input: BaseMessage[], options?: unknown): Promise<{ text: string }>;
  };

  /** 現況那一次呼叫：輸入是有效串的開頭（含上一份摘要訊息），回新的現況全文。 */
  async function createState(
    messages: readonly BaseMessage[],
    model: SummaryModel,
    request: EngineRequest,
    total: number,
  ): Promise<string> {
    const call = summaryCallOf?.(request, messages, total);
    if (call !== undefined) return (await model.invoke(call.input, call.options)).text;
    const conversation = getBufferString([...messages]);
    const prompt = summaryPrompt.replace('{conversation}', conversation);
    return (await model.invoke([new HumanMessage({ content: prompt })])).text;
  }

  /**
   * 索引條目那一次呼叫（#2776）：回覆讀不成條目就再叫一次，還是不成、或那次回覆被拒收，退成只有指標的條目。
   * 中止與其他錯誤照拋。
   */
  async function createEntryDraft(
    messages: readonly BaseMessage[],
    model: SummaryModel,
    request: EngineRequest,
    total: number,
    earlierEntries: number,
  ): Promise<SummaryEntryDraft | undefined> {
    const call = summaryCallOf?.(request, messages, total, SUMMARY_ENTRY_INSTRUCTION);
    const input = call?.input ?? [
      new HumanMessage({
        content: `Conversation to condense:\n${getBufferString(
          messages.filter((message) => !isSummaryMessage(message)),
        )}\n\n--- END OF CONVERSATION ---\n\n${SUMMARY_ENTRY_INSTRUCTION}`,
      }),
    ];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let text: string;
      try {
        text = (await model.invoke(input, call?.options)).text;
      } catch (error) {
        if ((error as { name?: unknown } | null)?.name === 'SummaryRejectedError') return undefined;
        throw error;
      }
      const draft = parseEntryDraft(text, earlierEntries);
      if (draft !== undefined) return draft;
    }
    return undefined;
  }

  /**
   * 摘要本文：上一份的索引原樣抄、接這次的新條目，再接重寫過的現況。兩次呼叫都回來才有本文，任一次拋就整次不摘。
   *
   * @throws {SummaryStateTooLongError} 現況兩次都超過 {@link SUMMARY_STATE_MAX_CHARS}。
   */
  async function createSummary(
    messages: readonly BaseMessage[],
    chatModel: unknown,
    request: EngineRequest,
    total: number,
  ): Promise<string> {
    const model = chatModel as SummaryModel;
    const first = messages[0];
    const previous =
      first !== undefined && isSummaryMessage(first)
        ? parseSummaryHead(summaryBodyOf(first))
        : undefined;
    const previousCutoff = previousSummaryCutoff()?.cutoffIndex;
    const range = [
      previousCutoff ?? 0,
      summaryCutoffIndex(previousCutoff, total, 1 + (total - messages.length)),
    ] as const;
    const earlier = previous?.entries ?? 0;
    const draft = await createEntryDraft(messages, model, request, total, earlier);
    let state = await createState(messages, model, request, total);
    if (state.length > SUMMARY_STATE_MAX_CHARS) {
      state = await createState(messages, model, request, total);
      if (state.length > SUMMARY_STATE_MAX_CHARS) throw new SummaryStateTooLongError(state.length);
    }
    return composeSummaryHead(
      previous?.indexText ?? '',
      { index: earlier + 1, range, ...(draft === undefined ? {} : { draft }) },
      state,
    );
  }

  function buildSummaryMessage(summary: string, filePath: string | null): HumanMessage {
    const content = filePath
      ? `${SUMMARY_PREAMBLE_HEAD}${filePath}${SUMMARY_PREAMBLE_TAIL}${summary}${SUMMARY_CLOSE}`
      : `${SUMMARY_PLAIN_PREFIX}${summary}`;
    return new HumanMessage({ content, additional_kwargs: { lc_source: 'summarization' } });
  }

  async function summarizeMessages(
    messagesToSummarize: readonly BaseMessage[],
    resolvedModel: unknown,
    request: EngineRequest,
    total: number,
  ): Promise<{ summaryMessage: HumanMessage; filePath: string | null }> {
    const filePath = await offloadToBackend(messagesToSummarize, request);
    if (filePath === null)
      console.warn(
        '[SummarizationMiddleware] Backend offload failed during summarization. Proceeding with summary generation.',
      );
    return {
      summaryMessage: buildSummaryMessage(
        await createSummary(messagesToSummarize, resolvedModel, request, total),
        filePath,
      ),
      filePath,
    };
  }

  async function performSummarization(
    request: EngineRequest,
    handler: Handler,
    truncatedMessages: BaseMessage[],
    resolvedModel: unknown,
    maxInputTokens: number | undefined,
  ): Promise<unknown> {
    const cutoffIndex = determineCutoffIndex(truncatedMessages, maxInputTokens);
    if (cutoffIndex <= 0) return handler({ ...request, messages: truncatedMessages });
    const messagesToSummarize = truncatedMessages.slice(0, cutoffIndex);
    const preservedMessages = truncatedMessages.slice(cutoffIndex);
    if (preservedMessages.length === 0 && maxInputTokens) {
      const compact = compactToolResults(
        truncatedMessages,
        maxInputTokens,
        request.systemMessage,
        request.tools,
      );
      if (compact.modified)
        try {
          return await handler({ ...request, messages: compact.messages });
        } catch (err) {
          if (!isContextOverflow(err)) throw err;
        }
    }
    const { summaryMessage } = await summarizeMessages(
      messagesToSummarize,
      resolvedModel,
      request,
      truncatedMessages.length,
    );
    const modifiedMessages: BaseMessage[] = [summaryMessage, ...preservedMessages];
    const modifiedTokens = countTotalTokens(modifiedMessages, request.systemMessage, request.tools);
    try {
      return await handler({ ...request, messages: modifiedMessages });
    } catch (err) {
      if (!isContextOverflow(err)) throw err;
      if (maxInputTokens && modifiedTokens > 0) {
        const observedRatio = maxInputTokens / modifiedTokens;
        if (observedRatio > tokenEstimationMultiplier)
          tokenEstimationMultiplier = observedRatio * 1.1;
      }
      const reSumResult = await summarizeMessages(
        [...messagesToSummarize, ...preservedMessages],
        resolvedModel,
        request,
        truncatedMessages.length,
      );
      return await handler({ ...request, messages: [reSumResult.summaryMessage] });
    }
  }

  return createMiddleware({
    name: 'SummarizationMiddleware',
    async wrapModelCall(request, handler) {
      const req = request as unknown as EngineRequest;
      const next = handler as unknown as Handler;
      const effectiveMessages = [
        ...applySummaryCutoff(req.messages ?? [], previousSummaryCutoff()),
      ];
      if (effectiveMessages.length === 0) return next(req) as never;
      if (req.model === undefined)
        throw new Error(
          'Summarization middleware could not resolve a model. Provide `options.model` or ensure `request.model` is present.',
        );
      const resolvedModel = req.model;
      const maxInputTokens = getMaxInputTokens(resolvedModel);
      const totalTokens = countTotalTokens(effectiveMessages, req.systemMessage, req.tools);
      const { messages: truncatedMessages, modified: truncateModified } = truncateArgs(
        effectiveMessages,
        maxInputTokens,
        totalTokens,
      );
      const tokensForSummary = truncateModified
        ? countTotalTokens(truncatedMessages, req.systemMessage, req.tools)
        : totalTokens;
      if (!shouldSummarize(truncatedMessages, tokensForSummary, maxInputTokens))
        try {
          return (await next({ ...req, messages: truncatedMessages })) as never;
        } catch (err) {
          if (!isContextOverflow(err)) throw err;
          if (maxInputTokens && tokensForSummary > 0) {
            const observedRatio = maxInputTokens / tokensForSummary;
            if (observedRatio > tokenEstimationMultiplier)
              tokenEstimationMultiplier = observedRatio * 1.1;
          }
        }
      return (await performSummarization(
        req,
        next,
        truncatedMessages,
        resolvedModel,
        maxInputTokens,
      )) as never;
    },
  }) as unknown as AgentMiddleware;
}
