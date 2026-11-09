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
import { context, countTokensApproximately, createMiddleware } from 'langchain';

import type { AgentMiddleware } from './base-types.js';
import { applySummaryCutoff, previousSummaryCutoff } from './summary-cutoffs.js';

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

  async function createSummary(
    messages: readonly BaseMessage[],
    chatModel: unknown,
  ): Promise<string> {
    const conversation = getBufferString([...messages]);
    const prompt = summaryPrompt.replace('{conversation}', conversation);
    const reply = await (
      chatModel as { invoke(input: BaseMessage[]): Promise<{ text: string }> }
    ).invoke([new HumanMessage({ content: prompt })]);
    return reply.text;
  }

  function buildSummaryMessage(summary: string, filePath: string | null): HumanMessage {
    const content = filePath
      ? context`
        You are in the middle of a conversation that has been summarized.

        The full conversation history has been saved to ${filePath} should you need to refer back to it for details.

        A condensed summary follows:

        <summary>
        ${summary}
        </summary>
      `
      : `Here is a summary of the conversation to date:\n\n${summary}`;
    return new HumanMessage({ content, additional_kwargs: { lc_source: 'summarization' } });
  }

  async function summarizeMessages(
    messagesToSummarize: readonly BaseMessage[],
    resolvedModel: unknown,
    request: EngineRequest,
  ): Promise<{ summaryMessage: HumanMessage; filePath: string | null }> {
    const filePath = await offloadToBackend(messagesToSummarize, request);
    if (filePath === null)
      console.warn(
        '[SummarizationMiddleware] Backend offload failed during summarization. Proceeding with summary generation.',
      );
    return {
      summaryMessage: buildSummaryMessage(
        await createSummary(messagesToSummarize, resolvedModel),
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
    const { summaryMessage } = await summarizeMessages(messagesToSummarize, resolvedModel, request);
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
