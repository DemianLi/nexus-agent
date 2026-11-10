/*
 * 照搬 `@langchain/openai@1.5.10`（MIT，Copyright (c) LangChain, Inc.；授權全文見
 * https://github.com/langchain-ai/langchainjs/blob/main/LICENSE）的 Chat Completions 那一支：
 * `dist/chat_models/index.js`（`ChatOpenAI` 外殼）、`dist/chat_models/base.js`（`BaseChatOpenAI`）、
 * `dist/chat_models/completions.js`（`ChatOpenAICompletions`）、`dist/converters/completions.js`，以及
 * `dist/utils/{client,errors,misc,tools,output}.js` 裡用得到的函式。兩層類別併成一層，請求與回應的處理照原樣。
 *
 * 沒搬的，nexus 一處都沒用到：Responses API（含內建工具、custom 工具與偏好 Responses 的模型名）、Azure、LangSmith gateway、
 * `OPENAI_*` 環境變數後備（`openai` SDK 自己仍會讀它那幾個，例如 `OPENAI_BASE_URL`）、結構化輸出、moderation、token 估算與它唯一的用處（`streaming: true` 欄位走的那支 `_generate`）、
 * MCP 工具的追蹤遮蔽、logprobs 等沒有呼叫端傳的建構欄位。真的傳了沒搬的工具形狀會拋，不會靜靜換成別的請求。
 * 也沒搬 OpenAI 自家型號的 `profile` 表：`profile` 是基底的 `{}`。讀它的只有摘要器的 `fraction` 門檻，而設定不收 `fraction`
 * （`@nexus/core` 的 `summarization.ts`）。
 * 跟原版不同的三處：
 * - 不往 SDK 的預設標頭塞 `langchainjs-openai` 的 `User-Agent`；送出前的 fetch 一律換成我們的（`live-model.ts` 的 `withAttribution`）。
 * - 不經 `@langchain/openai`，所以 callback 的 `metadata.versions` 沒有它那一格。
 * - 兩層併成一層，建好之後才改實例欄位（例如 `modelKwargs`），同一個實例之後的請求就會帶上；原版改的是外層，請求不受影響。
 */

/**
 * 直接呼叫 `openai` SDK 的 chat model（[#2361](https://github.com/DemianLi/nexus-agent/issues/2361)）：請求本文、串流事件、錯誤包裝
 * 跟 `@langchain/openai@1.5.10` 的 `ChatOpenAI` 走 Chat Completions 時逐位元組相同（`base-chat-openai.test.ts` 對同一個假端點比對）。
 *
 * 仍是 `BaseChatModel`：`langgraph` 的 AgentNode 要 `bindTools`／`invoke`；線上的 token、請求快照、`model/start` 都靠它發的 callback。
 *
 * @module
 */

import { ContextOverflowError, stampRetryable } from '@langchain/core/errors';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import { isOpenAITool } from '@langchain/core/language_models/base';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type {
  BaseChatModelCallOptions,
  BaseChatModelParams,
  BindToolsInput,
} from '@langchain/core/language_models/chat_models';
import type { ChatModelStreamEvent } from '@langchain/core/language_models/event';
import { convertOpenAICompletionsStream } from '@langchain/core/language_models/openai_completions_stream';
import type { OpenAICompletionsStreamChunk } from '@langchain/core/language_models/openai_completions_stream';
import {
  AIMessage,
  AIMessageChunk,
  ChatMessage,
  ChatMessageChunk,
  FunctionMessageChunk,
  HumanMessageChunk,
  SystemMessageChunk,
  ToolMessage,
  ToolMessageChunk,
  convertToProviderContentBlock,
  isAIMessage,
  isDataContentBlock,
  parseBase64DataUrl,
  parseMimeType,
} from '@langchain/core/messages';
import type { BaseMessage, BaseMessageChunk } from '@langchain/core/messages';
import {
  convertLangChainToolCallToOpenAI,
  makeInvalidToolCall,
  parseToolCall,
} from '@langchain/core/output_parsers/openai_tools';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import type { ChatGeneration, ChatResult } from '@langchain/core/outputs';
import type { Runnable } from '@langchain/core/runnables';
import { convertToOpenAITool, isLangChainTool } from '@langchain/core/utils/function_calling';
import { APIConnectionTimeoutError, APIUserAbortError, OpenAI } from 'openai';
import type { ClientOptions } from 'openai';

/** {@link BaseChatOpenAI} 的建構欄位：nexus 實際傳的那幾格。 */
export interface BaseChatOpenAIFields extends BaseChatModelParams {
  readonly model?: string;
  /** 被 `configuration.apiKey` 蓋過（同 `@langchain/openai`）。 */
  readonly apiKey?: ClientOptions['apiKey'];
  readonly configuration?: ClientOptions;
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxTokens?: number;
  readonly timeout?: number;
  /** 併進請求本文的其餘參數。 */
  readonly modelKwargs?: Record<string, unknown>;
  /** 串流請求帶 `stream_options.include_usage`。預設 `true`。 */
  readonly streamUsage?: boolean;
}

/** 呼叫時的選項；請求參數那幾格照 `@langchain/openai` 的 `ChatOpenAICallOptions` 讀，多半由 `bindTools` 與 middleware 帶進來。 */
export interface BaseChatOpenAICallOptions extends BaseChatModelCallOptions {
  readonly tools?: readonly unknown[];
  readonly strict?: boolean;
  readonly promptIndex?: number;
  readonly functions?: unknown;
  readonly function_call?: unknown;
  readonly response_format?: unknown;
  readonly stream_options?: unknown;
  readonly seed?: unknown;
  readonly parallel_tool_calls?: unknown;
  readonly audio?: unknown;
  readonly modalities?: unknown;
  readonly promptCacheKey?: unknown;
  readonly promptCacheRetention?: unknown;
  readonly verbosity?: unknown;
  readonly prediction?: unknown;
  readonly service_tier?: unknown;
  readonly reasoning?: unknown;
  readonly reasoningEffort?: unknown;
  readonly maxRetries?: number;
  /** 原樣交給 SDK 的請求選項（`headers` 之類）。 */
  readonly options?: Record<string, unknown>;
}

type CallOptions = BaseChatOpenAICallOptions;
type Params = Record<string, unknown> & { model: string; stream?: boolean };
type RawToolCall = Parameters<typeof parseToolCall>[0];

const DEFAULT_MODEL = 'gpt-3.5-turbo';

/**
 * Chat Completions 的 chat model：三條呼叫路徑（`_generate`、`_streamResponseChunks`、`_streamChatModelEvents`）都經
 * {@link BaseChatOpenAI.completionWithRetry} 打 `openai` SDK，SDK 本身不重試。子類（`GuardedChatOpenAI` 等）要覆寫
 * `withConfig`，否則 `bindTools`／`withConfig` 建出來的會是這個基底類別。
 */
export class BaseChatOpenAI extends BaseChatModel<BaseChatOpenAICallOptions, AIMessageChunk> {
  model: string;
  /** 序列化時記成 `OPENAI_API_KEY` 的秘密佔位（同 `@langchain/openai`），值不會寫出去。 */
  apiKey: ClientOptions['apiKey'] | undefined;
  temperature: number | undefined;
  topP: number | undefined;
  maxTokens: number | undefined;
  timeout: number | undefined;
  modelKwargs: Record<string, unknown>;
  streaming = false;
  streamUsage: boolean;
  /** 建構欄位原樣留著，`withConfig` 建新實例時用。 */
  fields: BaseChatOpenAIFields;
  defaultOptions: Partial<CallOptions> | undefined;
  /** @internal 第一次請求時才建。 */
  client: OpenAI | undefined;
  /** @internal */
  clientConfig: ClientOptions;

  override _llmType(): string {
    return 'openai';
  }

  static override lc_name(): string {
    return 'ChatOpenAI';
  }

  override get callKeys(): string[] {
    return [
      ...super.callKeys,
      'options',
      'function_call',
      'functions',
      'tools',
      'tool_choice',
      'promptIndex',
      'response_format',
      'seed',
      'reasoning',
      'reasoning_effort',
      'service_tier',
      'useResponsesApi',
    ];
  }

  override lc_serializable = true;

  override get lc_secrets(): Record<string, string> {
    return { apiKey: 'OPENAI_API_KEY', organization: 'OPENAI_ORGANIZATION' };
  }

  override get lc_aliases(): Record<string, string> {
    return { apiKey: 'openai_api_key', modelName: 'model' };
  }

  override get lc_serializable_keys(): string[] {
    return [
      'configuration',
      'logprobs',
      'topLogprobs',
      'prefixMessages',
      'supportsStrictToolCalling',
      'modalities',
      'audio',
      'temperature',
      'maxTokens',
      'topP',
      'frequencyPenalty',
      'presencePenalty',
      'n',
      'logitBias',
      'user',
      'streaming',
      'streamUsage',
      'model',
      'modelName',
      'modelKwargs',
      'stop',
      'stopSequences',
      'timeout',
      'apiKey',
      'cache',
      'maxConcurrency',
      'maxRetries',
      'verbose',
      'callbacks',
      'tags',
      'metadata',
      'disableStreaming',
      'zdrEnabled',
      'reasoning',
      'promptCacheKey',
      'promptCacheRetention',
      'verbosity',
      'useResponsesApi',
    ];
  }

  constructor(fields: BaseChatOpenAIFields) {
    super(fields);
    this.fields = fields;
    const configApiKey =
      typeof fields.configuration?.apiKey === 'string' ||
      typeof fields.configuration?.apiKey === 'function'
        ? fields.configuration.apiKey
        : undefined;
    this.apiKey = fields.apiKey ?? configApiKey;
    this.model = fields.model ?? DEFAULT_MODEL;
    this.modelKwargs = fields.modelKwargs ?? {};
    this.timeout = fields.timeout;
    this.temperature = fields.temperature;
    this.topP = fields.topP;
    this.maxTokens = fields.maxTokens;
    this.streamUsage = fields.streamUsage ?? true;
    this.clientConfig = {
      apiKey: this.apiKey,
      dangerouslyAllowBrowser: true,
      ...fields.configuration,
    };
  }

  override getLsParams(options: this['ParsedCallOptions']) {
    const params = this.invocationParams(options);
    return {
      ls_provider: 'openai',
      ls_model_name: this.model,
      ls_model_type: 'chat' as const,
      ls_temperature: (params['temperature'] as number | undefined) ?? undefined,
      ls_max_tokens: (params['max_tokens'] as number | undefined) ?? undefined,
      ls_stop: options.stop,
    };
  }

  /** @ignore */
  override _identifyingParams(): Record<string, unknown> {
    return { model_name: this.model, ...this.invocationParams(), ...this.clientConfig };
  }

  identifyingParams(): Record<string, unknown> {
    return this._identifyingParams();
  }

  _combineCallOptions(additionalOptions?: Partial<CallOptions>): CallOptions {
    return { ...this.defaultOptions, ...(additionalOptions ?? {}) } as CallOptions;
  }

  /**
   * 請求本文除了 `messages` 以外的那些格。
   * @param options - 呼叫選項（先併上 `withConfig` 帶的預設）。
   * @param extra - `streaming` 為真（或實例的 `streaming` 為真）時，沒指定 `stream_options` 且 `streamUsage` 開著才帶 `include_usage`。
   * @returns 請求參數；值是 `undefined` 的格送出時不會出現。
   */
  override invocationParams(
    options?: Partial<CallOptions>,
    extra?: { readonly streaming?: boolean },
  ): Params {
    const combined = this._combineCallOptions(options);
    let strict: boolean | undefined;
    if (combined.strict !== undefined) strict = combined.strict;
    const responseFormat = combined.response_format as { type?: unknown } | undefined;
    if (
      !(this.streaming || extra?.streaming) &&
      responseFormat?.type === 'json_schema' &&
      strict !== false
    )
      strict = true;
    let streamOptionsConfig: Record<string, unknown> = {};
    if (combined.stream_options !== undefined)
      streamOptionsConfig = { stream_options: combined.stream_options };
    else if (this.streamUsage && (this.streaming || extra?.streaming))
      streamOptionsConfig = { stream_options: { include_usage: true } };
    const audio = combined.audio;
    const modalities = combined.modalities;
    const params: Params = {
      model: this.model,
      temperature: this.temperature,
      top_p: this.topP,
      frequency_penalty: undefined,
      presence_penalty: undefined,
      logprobs: undefined,
      top_logprobs: undefined,
      n: undefined,
      logit_bias: undefined,
      stop: combined.stop,
      user: undefined,
      stream: this.streaming,
      functions: combined.functions,
      function_call: combined.function_call,
      tools: combined.tools?.length
        ? combined.tools.map((tool) => toCompletionsTool(tool, { strict }))
        : undefined,
      tool_choice: formatToOpenAIToolChoice(combined.tool_choice),
      response_format: combined.response_format,
      seed: combined.seed,
      ...streamOptionsConfig,
      parallel_tool_calls: combined.parallel_tool_calls,
      ...(audio ? { audio } : {}),
      ...(modalities ? { modalities } : {}),
      ...this.modelKwargs,
      prompt_cache_key: combined.promptCacheKey,
      prompt_cache_retention: combined.promptCacheRetention,
      verbosity: combined.verbosity,
    };
    if (combined.prediction !== undefined) params['prediction'] = combined.prediction;
    if (combined.service_tier !== undefined) params['service_tier'] = combined.service_tier;
    const effort = reasoningEffortOf(this.model, combined);
    if (effort !== undefined) params['reasoning_effort'] = effort;
    if (isReasoningModel(params.model))
      params['max_completion_tokens'] = this.maxTokens === -1 ? undefined : this.maxTokens;
    else params['max_tokens'] = this.maxTokens === -1 ? undefined : this.maxTokens;
    return params;
  }

  override bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<CallOptions>,
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, CallOptions> {
    const strict = kwargs?.strict;
    return this.withConfig({
      tools: tools.map((tool) => {
        if (hasProviderToolDefinition(tool)) return tool.extras.providerToolDefinition;
        const converted = toCompletionsTool(tool, { strict }) as Record<string, unknown>;
        if (isLangChainTool(tool) && tool.extras?.['defer_loading'] === true)
          return { ...converted, defer_loading: true };
        return converted;
      }),
      ...kwargs,
    } as Partial<CallOptions>);
  }

  /** 用同一份建構欄位建新實例、併上呼叫預設；不沿用建好之後才改的實例欄位。子類覆寫成建自己。 */
  override withConfig(
    config: Partial<CallOptions>,
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, CallOptions> {
    const next = new BaseChatOpenAI(this.fields);
    next.defaultOptions = { ...this.defaultOptions, ...config };
    return next;
  }

  override async stream(input: BaseLanguageModelInput, options?: Partial<CallOptions>) {
    return super.stream(input, this._combineCallOptions(options));
  }

  override async invoke(input: BaseLanguageModelInput, options?: Partial<CallOptions>) {
    return super.invoke(input, this._combineCallOptions(options));
  }

  override async _generate(
    messages: BaseMessage[],
    rawOptions: this['ParsedCallOptions'],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const options = this._combineCallOptions(rawOptions);
    options.signal?.throwIfAborted();
    const usageMetadata: Record<string, unknown> = {};
    const params = this.invocationParams(options);
    const messagesMapped = toCompletionsMessages(messages, this.model);
    const data = (await this.completionWithRetry(
      { ...params, stream: false, messages: messagesMapped },
      {
        signal: options.signal,
        maxRetries: options.maxRetries,
        ...options.options,
      },
    )) as CompletionResponse;
    const usage = data?.usage ?? {};
    const {
      completion_tokens: completionTokens,
      prompt_tokens: promptTokens,
      total_tokens: totalTokens,
      prompt_tokens_details: promptTokensDetails,
      completion_tokens_details: completionTokensDetails,
    } = usage;
    if (completionTokens)
      usageMetadata['output_tokens'] =
        ((usageMetadata['output_tokens'] as number) ?? 0) + completionTokens;
    if (promptTokens)
      usageMetadata['input_tokens'] =
        ((usageMetadata['input_tokens'] as number) ?? 0) + promptTokens;
    if (totalTokens)
      usageMetadata['total_tokens'] =
        ((usageMetadata['total_tokens'] as number) ?? 0) + totalTokens;
    if (
      promptTokensDetails?.audio_tokens !== null ||
      promptTokensDetails?.cached_tokens !== null ||
      promptTokensDetails?.cache_write_tokens != null
    )
      usageMetadata['input_token_details'] = {
        ...(promptTokensDetails?.audio_tokens !== null && {
          audio: promptTokensDetails?.audio_tokens,
        }),
        ...(promptTokensDetails?.cached_tokens !== null && {
          cache_read: promptTokensDetails?.cached_tokens,
        }),
        ...(promptTokensDetails?.cache_write_tokens != null && {
          cache_creation: promptTokensDetails?.cache_write_tokens,
        }),
      };
    if (
      completionTokensDetails?.audio_tokens !== null ||
      completionTokensDetails?.reasoning_tokens !== null
    )
      usageMetadata['output_token_details'] = {
        ...(completionTokensDetails?.audio_tokens !== null && {
          audio: completionTokensDetails?.audio_tokens,
        }),
        ...(completionTokensDetails?.reasoning_tokens !== null && {
          reasoning: completionTokensDetails?.reasoning_tokens,
        }),
      };
    const generations: ChatGeneration[] = [];
    for (const part of data?.choices ?? []) {
      const message = toBaseMessage(part.message ?? { role: 'assistant' }, data);
      const generation: ChatGeneration = {
        text: (part.message?.content as string | null | undefined) ?? '',
        message,
      };
      generation.generationInfo = {
        ...(part.finish_reason ? { finish_reason: part.finish_reason } : {}),
        ...(part.logprobs ? { logprobs: part.logprobs } : {}),
      };
      if (isAIMessage(generation.message))
        generation.message.usage_metadata = usageMetadata as never;
      generation.message = new AIMessage(
        Object.fromEntries(
          Object.entries(generation.message).filter(([key]) => !key.startsWith('lc_')),
        ) as never,
      );
      generations.push(generation);
    }
    return {
      generations,
      llmOutput: {
        tokenUsage: {
          promptTokens: usageMetadata['input_tokens'],
          completionTokens: usageMetadata['output_tokens'],
          totalTokens: usageMetadata['total_tokens'],
        },
      },
    };
  }

  /** content-block 那一套串流事件（core 在有偏好 stream-event 的 handler 時把 `invoke` 轉到這裡；v3 的 `streamEvents()` 也走這裡）。 */
  override async *_streamChatModelEvents(
    messages: BaseMessage[],
    rawOptions: this['ParsedCallOptions'],
    _runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatModelStreamEvent> {
    const options = this._combineCallOptions(rawOptions);
    const params = {
      ...this.invocationParams(options, { streaming: true }),
      messages: toCompletionsMessages(messages, this.model),
      stream: true,
    };
    const streamIterable = (await this.completionWithRetry(
      params,
      options,
    )) as AsyncIterable<OpenAICompletionsStreamChunk>;
    yield* convertOpenAICompletionsStream(abortable(streamIterable, options.signal), {
      streamUsage: this.streamUsage,
      provider: 'openai',
    });
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    rawOptions: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const options = this._combineCallOptions(rawOptions);
    const params = {
      ...this.invocationParams(options, { streaming: true }),
      messages: toCompletionsMessages(messages, this.model),
      stream: true,
    };
    let defaultRole: string | undefined;
    const streamIterable = (await this.completionWithRetry(
      params,
      options,
    )) as AsyncIterable<CompletionChunk>;
    let usage: CompletionUsage | undefined;
    for await (const data of streamIterable) {
      if (options.signal?.aborted) return;
      const choice = data?.choices?.[0];
      if (data.usage) usage = data.usage;
      if (!choice) continue;
      const { delta } = choice;
      if (!delta) continue;
      const chunk = toMessageChunk(delta, data, defaultRole);
      defaultRole = delta.role ?? defaultRole;
      const newTokenIndices = { prompt: options.promptIndex ?? 0, completion: choice.index ?? 0 };
      if (typeof chunk.content !== 'string') {
        console.log(
          '[WARNING]: Received non-string content from OpenAI. This is currently not supported.',
        );
        continue;
      }
      const generationInfo: Record<string, unknown> = { ...newTokenIndices };
      if (choice.finish_reason != null) {
        generationInfo['finish_reason'] = choice.finish_reason;
        generationInfo['system_fingerprint'] = data.system_fingerprint;
        generationInfo['model_name'] = data.model;
        generationInfo['service_tier'] = data.service_tier;
      }
      const generationChunk = new ChatGenerationChunk({
        message: chunk,
        text: chunk.content,
        generationInfo,
      });
      yield generationChunk;
      await runManager?.handleLLMNewToken(
        generationChunk.text ?? '',
        newTokenIndices,
        undefined,
        undefined,
        undefined,
        { chunk: generationChunk },
      );
    }
    if (usage) {
      const inputTokenDetails = {
        ...(usage.prompt_tokens_details?.audio_tokens !== null && {
          audio: usage.prompt_tokens_details?.audio_tokens,
        }),
        ...(usage.prompt_tokens_details?.cached_tokens !== null && {
          cache_read: usage.prompt_tokens_details?.cached_tokens,
        }),
        ...(usage.prompt_tokens_details?.cache_write_tokens != null && {
          cache_creation: usage.prompt_tokens_details?.cache_write_tokens,
        }),
      };
      const outputTokenDetails = {
        ...(usage.completion_tokens_details?.audio_tokens !== null && {
          audio: usage.completion_tokens_details?.audio_tokens,
        }),
        ...(usage.completion_tokens_details?.reasoning_tokens !== null && {
          reasoning: usage.completion_tokens_details?.reasoning_tokens,
        }),
      };
      const generationChunk = new ChatGenerationChunk({
        message: new AIMessageChunk({
          content: '',
          response_metadata: { usage: { ...usage } },
          usage_metadata: {
            input_tokens: usage.prompt_tokens,
            output_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
            ...(Object.keys(inputTokenDetails).length > 0 && {
              input_token_details: inputTokenDetails,
            }),
            ...(Object.keys(outputTokenDetails).length > 0 && {
              output_token_details: outputTokenDetails,
            }),
          } as never,
        }),
        text: '',
      });
      yield generationChunk;
      await runManager?.handleLLMNewToken(
        generationChunk.text ?? '',
        { prompt: 0, completion: 0 },
        undefined,
        undefined,
        undefined,
        { chunk: generationChunk },
      );
    }
    if (options.signal?.aborted) throw new Error('AbortError');
  }

  /**
   * 打一次 SDK。`maxRetries` 交給 `this.caller`（建構時的 `maxRetries`／`onFailedAttempt`），其餘選項連同建構時的 client 設定原樣當成
   * SDK 的請求選項。
   * @param request - 請求本文。
   * @param requestOptions - 呼叫選項。
   * @returns SDK 的回應；串流請求是可迭代的 chunk。
   */
  async completionWithRetry(
    request: Params & { messages: unknown[] },
    requestOptions?: object,
  ): Promise<unknown> {
    const { maxRetries, ...sdkOptions } = (requestOptions ?? {}) as { maxRetries?: unknown };
    const clientOptions = this._getClientOptions(sdkOptions);
    return this.caller.callWithOptions(
      { maxRetries: maxRetries as number | undefined } as never,
      async () => {
        try {
          return await this.#client().chat.completions.create(
            request as never,
            clientOptions as never,
          );
        } catch (error) {
          throw wrapOpenAIClientError(error);
        }
      },
    );
  }

  /** @internal */
  _getClientOptions(options?: Record<string, unknown>): Record<string, unknown> {
    if (this.client === undefined) {
      const params: ClientOptions = { ...this.clientConfig, timeout: this.timeout, maxRetries: 0 };
      if (!params.baseURL) delete params.baseURL;
      this.client = new OpenAI(params);
    }
    return { ...this.clientConfig, ...options };
  }

  #client(): OpenAI {
    if (this.client === undefined) this._getClientOptions();
    return this.client as OpenAI;
  }
}

interface CompletionUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
  readonly prompt_tokens_details?: {
    readonly audio_tokens?: number | null;
    readonly cached_tokens?: number | null;
    readonly cache_write_tokens?: number | null;
  } | null;
  readonly completion_tokens_details?: {
    readonly audio_tokens?: number | null;
    readonly reasoning_tokens?: number | null;
  } | null;
}

interface CompletionDelta {
  readonly role?: string;
  readonly content?: string | null;
  readonly function_call?: unknown;
  readonly tool_calls?: readonly {
    readonly index?: number;
    readonly id?: string;
    readonly function?: { readonly name?: string; readonly arguments?: string };
  }[];
  readonly reasoning_content?: unknown;
  readonly audio?: Record<string, unknown>;
  readonly name?: string;
  readonly tool_call_id?: string;
}

interface CompletionChunk {
  readonly id?: string;
  readonly model?: string;
  readonly system_fingerprint?: string | null;
  readonly service_tier?: string | null;
  readonly usage?: CompletionUsage | null;
  readonly choices?: readonly {
    readonly index?: number;
    readonly finish_reason?: string | null;
    readonly delta?: CompletionDelta;
  }[];
}

interface CompletionMessage {
  readonly role?: string;
  readonly content?: unknown;
  readonly tool_calls?: readonly RawToolCall[];
  readonly function_call?: unknown;
  readonly reasoning_content?: unknown;
  readonly audio?: unknown;
}

interface CompletionResponse {
  readonly id?: string;
  readonly model?: string;
  readonly system_fingerprint?: string | null;
  readonly usage?: CompletionUsage;
  readonly choices?: readonly {
    readonly message?: CompletionMessage;
    readonly finish_reason?: string | null;
    readonly logprobs?: unknown;
  }[];
}

/** 收到中止訊號就停止往下交 chunk（照 `ChatOpenAICompletions._streamChatModelEvents` 的 `abortableStream`）。 */
async function* abortable<T>(source: AsyncIterable<T>, signal: AbortSignal | undefined) {
  for await (const data of source) {
    if (signal?.aborted) return;
    yield data;
  }
}

function isReasoningModel(model: string | undefined): boolean {
  if (!model) return false;
  if (/^o\d/.test(model)) return true;
  if (model.startsWith('gpt-5') && !model.startsWith('gpt-5-chat')) return true;
  return false;
}

/** 推理模型才帶 `reasoning_effort`：先看 `reasoning.effort`，沒有再看 `reasoningEffort`。 */
function reasoningEffortOf(model: string, options: CallOptions): unknown {
  if (!isReasoningModel(model)) return undefined;
  let reasoning: Record<string, unknown> | undefined;
  const fromOptions = options.reasoning as Record<string, unknown> | undefined;
  if (fromOptions !== undefined) reasoning = { ...reasoning, ...fromOptions };
  if (options.reasoningEffort !== undefined && reasoning?.['effort'] === undefined)
    reasoning = { ...reasoning, effort: options.reasoningEffort };
  return reasoning?.['effort'];
}

function hasProviderToolDefinition(
  tool: unknown,
): tool is { extras: { providerToolDefinition: Record<string, unknown> } } {
  if (typeof tool !== 'object' || tool === null || !('extras' in tool)) return false;
  const extras = (tool as { extras?: unknown }).extras;
  return (
    typeof extras === 'object' &&
    extras !== null &&
    'providerToolDefinition' in extras &&
    typeof (extras as { providerToolDefinition?: unknown }).providerToolDefinition === 'object' &&
    (extras as { providerToolDefinition?: unknown }).providerToolDefinition !== null
  );
}

/**
 * 工具定義換成 Chat Completions 的 `function` 形狀。Responses 才收的形狀（內建工具、custom 工具）拋錯：`@langchain/openai` 碰到它們會改走
 * Responses API，這裡沒有那一支。
 */
function toCompletionsTool(
  tool: unknown,
  fields: { readonly strict?: boolean | undefined },
): unknown {
  if (typeof tool === 'object' && tool !== null) {
    if ('type' in tool && (tool as { type?: unknown }).type !== 'function')
      throw new Error(
        `不支援 Chat Completions 以外的工具形狀（type: ${String((tool as { type?: unknown }).type)}）`,
      );
    const metadata = (tool as { metadata?: unknown }).metadata;
    if (typeof metadata === 'object' && metadata !== null && 'customTool' in metadata)
      throw new Error('不支援 custom 工具（只有 Responses API 收）');
  }
  if (isOpenAITool(tool)) {
    if (fields.strict !== undefined)
      return { ...tool, function: { ...tool.function, strict: fields.strict } };
    return tool;
  }
  const toolDef = (isLangChainTool(tool as never) ? convertToOpenAITool(tool as never) : tool) as {
    function: { strict?: boolean };
  };
  if (fields.strict !== undefined) toolDef.function.strict = fields.strict;
  return toolDef;
}

function formatToOpenAIToolChoice(toolChoice: unknown): unknown {
  if (!toolChoice) return undefined;
  if (toolChoice === 'any' || toolChoice === 'required') return 'required';
  if (toolChoice === 'auto') return 'auto';
  if (toolChoice === 'none') return 'none';
  if (typeof toolChoice === 'string') return { type: 'function', function: { name: toolChoice } };
  return toolChoice;
}

function messageToOpenAIRole(message: BaseMessage): string {
  const type = message._getType();
  switch (type) {
    case 'system':
      return 'system';
    case 'ai':
      return 'assistant';
    case 'human':
      return 'user';
    case 'function':
      return 'function';
    case 'tool':
      return 'tool';
    case 'generic': {
      if (!ChatMessage.isInstance(message)) throw new Error('Invalid generic chat message');
      const role = message.role;
      if (!['system', 'developer', 'assistant', 'user', 'function', 'tool'].includes(role))
        console.warn(`Unknown message role: ${role}`);
      return role;
    }
    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}

const LC_AUTOGENERATED_FILENAME = 'LC_AUTOGENERATED';

function requiredFilenameOf(block: { metadata?: Record<string, unknown> }): unknown {
  const filename =
    block.metadata?.['filename'] ?? block.metadata?.['name'] ?? block.metadata?.['title'];
  if (!filename) {
    console.warn(
      "OpenAI may require a filename for file uploads. Specify a filename in the content block metadata, e.g.: { type: 'file', mimeType: '...', data: '...', metadata: { filename: 'my-file.pdf' } }. Using placeholder filename 'LC_AUTOGENERATED'.",
    );
    return LC_AUTOGENERATED_FILENAME;
  }
  return filename;
}

type DataBlock = {
  source_type?: string;
  url?: string;
  data?: string;
  mime_type?: string;
  id?: string;
  text?: string;
  metadata?: Record<string, unknown>;
};

function audioFormatOf(sourceType: string | undefined, rawMimeType: string): string {
  let mimeType: { type: string; subtype: string };
  try {
    mimeType = parseMimeType(rawMimeType);
  } catch {
    throw new Error(
      `Audio blocks with source_type ${sourceType} must have mime type of audio/wav or audio/mp3`,
    );
  }
  if (mimeType.type !== 'audio' || (mimeType.subtype !== 'wav' && mimeType.subtype !== 'mp3'))
    throw new Error(
      `Audio blocks with source_type ${sourceType} must have mime type of audio/wav or audio/mp3`,
    );
  return mimeType.subtype;
}

/** 標準內容區塊（`isDataContentBlock`）換成 Chat Completions 的內容片段。 */
const completionsApiContentBlockConverter = {
  providerName: 'ChatOpenAI',
  fromStandardTextBlock(block: DataBlock) {
    return { type: 'text', text: block.text };
  },
  fromStandardImageBlock(block: DataBlock) {
    const detail = block.metadata?.['detail'];
    if (block.source_type === 'url')
      return { type: 'image_url', image_url: { url: block.url, ...(detail ? { detail } : {}) } };
    if (block.source_type === 'base64')
      return {
        type: 'image_url',
        image_url: {
          url: `data:${block.mime_type ?? ''};base64,${block.data}`,
          ...(detail ? { detail } : {}),
        },
      };
    throw new Error(
      `Image content blocks with source_type ${block.source_type} are not supported for ChatOpenAI`,
    );
  },
  fromStandardAudioBlock(block: DataBlock) {
    if (block.source_type === 'url') {
      const data = parseBase64DataUrl({ dataUrl: block.url ?? '' });
      if (!data)
        throw new Error(
          `URL audio blocks with source_type ${block.source_type} must be formatted as a data URL for ChatOpenAI`,
        );
      const format = audioFormatOf(block.source_type, data.mime_type || block.mime_type || '');
      return { type: 'input_audio', input_audio: { format, data: data.data } };
    }
    if (block.source_type === 'base64') {
      const format = audioFormatOf(block.source_type, block.mime_type ?? '');
      return { type: 'input_audio', input_audio: { format, data: block.data } };
    }
    throw new Error(
      `Audio content blocks with source_type ${block.source_type} are not supported for ChatOpenAI`,
    );
  },
  fromStandardFileBlock(block: DataBlock) {
    if (block.source_type === 'url') {
      const data = parseBase64DataUrl({ dataUrl: block.url ?? '' });
      const filename = requiredFilenameOf(block);
      if (!data)
        throw new Error(
          `URL file blocks with source_type ${block.source_type} must be formatted as a data URL for ChatOpenAI`,
        );
      return { type: 'file', file: { file_data: block.url, filename } };
    }
    if (block.source_type === 'base64') {
      const filename = requiredFilenameOf(block);
      return {
        type: 'file',
        file: { file_data: `data:${block.mime_type ?? ''};base64,${block.data}`, filename },
      };
    }
    if (block.source_type === 'id') return { type: 'file', file: { file_id: block.id } };
    throw new Error(
      `File content blocks with source_type ${block.source_type} are not supported for ChatOpenAI`,
    );
  },
};

/** v1 輸出格式（`response_metadata.output_version === 'v1'`）的使用者訊息內容片段。 */
function standardBlockToContentPart(block: Record<string, unknown>): unknown {
  if (block['type'] === 'image') {
    if (block['url']) return { type: 'image_url', image_url: { url: block['url'] } };
    if (block['data'])
      return {
        type: 'image_url',
        image_url: { url: `data:${String(block['mimeType'])};base64,${String(block['data'])}` },
      };
  }
  if (block['type'] === 'audio' && block['data']) {
    const [, subtype] = String(block['mimeType']).split('/');
    const format = subtype === 'wav' || subtype === 'mp3' ? subtype : 'wav';
    return { type: 'input_audio', input_audio: { data: String(block['data']), format } };
  }
  if (block['type'] === 'file') {
    if (block['data']) {
      const filename = requiredFilenameOf(block as DataBlock);
      return {
        type: 'file',
        file: {
          file_data: `data:${String(block['mimeType'])};base64,${String(block['data'])}`,
          filename,
        },
      };
    }
    if (block['fileId']) return { type: 'file', file: { file_id: block['fileId'] } };
  }
  return undefined;
}

/** v1 輸出格式的訊息。原版呼叫它時沒傳 `model`，所以這裡的 `system` 不會換成 `developer`，照原樣。 */
function standardMessageToCompletionsMessage(message: BaseMessage): Record<string, unknown> {
  const role = messageToOpenAIRole(message);
  const blocks = message.contentBlocks as unknown as Record<string, unknown>[];
  const textBlocks = () => blocks.filter((block) => block['type'] === 'text');
  if (role === 'developer') return { role: 'developer', content: textBlocks() };
  if (role === 'system') return { role: 'system', content: textBlocks() };
  if (role === 'assistant') {
    const param: Record<string, unknown> = { role: 'assistant', content: textBlocks() };
    if (AIMessage.isInstance(message) && !!message.tool_calls?.length)
      param['tool_calls'] = message.tool_calls.map(convertLangChainToolCallToOpenAI);
    else if (message.additional_kwargs['tool_calls'] != null)
      param['tool_calls'] = message.additional_kwargs['tool_calls'];
    if (
      Array.isArray(param['content']) &&
      param['content'].length === 0 &&
      param['tool_calls'] != null
    )
      param['content'] = null;
    return param;
  }
  if (role === 'tool' && ToolMessage.isInstance(message))
    return { role: 'tool', tool_call_id: message.tool_call_id, content: textBlocks() };
  if (role === 'function')
    return { role: 'function', name: message.name ?? '', content: textBlocks().join('') };
  const content: unknown[] = [];
  for (const block of blocks) {
    if (block['type'] === 'text') content.push({ type: 'text', text: block['text'] });
    const part = standardBlockToContentPart(block);
    if (part) content.push(part);
  }
  return { role: 'user', content };
}

const DROPPED_BLOCK_TYPES = new Set([
  'tool_use',
  'tool_call',
  'functionCall',
  'reasoning',
  'reasoning_content',
  'thinking',
]);

/**
 * LangChain 訊息換成 Chat Completions 的 `messages`（照 `convertMessagesToCompletionsMessageParams`）。
 * @param messages - 要送出的訊息。
 * @param model - 模型 id；推理模型的 `system` 換成 `developer`。
 * @returns 請求本文的 `messages`。
 */
export function toCompletionsMessages(messages: readonly BaseMessage[], model: string): unknown[] {
  return messages.flatMap((message) => {
    if (
      'output_version' in message.response_metadata &&
      message.response_metadata['output_version'] === 'v1'
    )
      return standardMessageToCompletionsMessage(message);
    let role = messageToOpenAIRole(message);
    if (role === 'system' && isReasoningModel(model)) role = 'developer';
    const content =
      typeof message.content === 'string'
        ? message.content
        : message.content.flatMap((part) => {
            if (isDataContentBlock(part))
              return convertToProviderContentBlock(
                part,
                completionsApiContentBlockConverter as never,
              );
            if (
              typeof part === 'object' &&
              part !== null &&
              'type' in part &&
              DROPPED_BLOCK_TYPES.has(part.type as string)
            )
              return [];
            return part;
          });
    const param: Record<string, unknown> = { role, content };
    if (message.name != null) param['name'] = message.name;
    if (message.additional_kwargs['function_call'] != null)
      param['function_call'] = message.additional_kwargs['function_call'];
    if (AIMessage.isInstance(message) && !!message.tool_calls?.length)
      param['tool_calls'] = message.tool_calls.map(convertLangChainToolCallToOpenAI);
    else {
      if (message.additional_kwargs['tool_calls'] != null)
        param['tool_calls'] = message.additional_kwargs['tool_calls'];
      if (ToolMessage.isInstance(message) && message.tool_call_id != null)
        param['tool_call_id'] = message.tool_call_id;
    }
    const audio = message.additional_kwargs['audio'];
    if (audio && typeof audio === 'object' && 'id' in audio)
      return [param, { role: 'assistant', audio: { id: (audio as { id: unknown }).id } }];
    return param;
  });
}

/** OpenRouter 的生圖回應把圖放在 `message.images`：有的話內容改成文字加圖片區塊。 */
function multiModalOutputOf(content: unknown, message: unknown): unknown {
  if (
    message &&
    typeof message === 'object' &&
    'images' in message &&
    Array.isArray((message as { images?: unknown }).images)
  ) {
    const images = (
      (message as { images: unknown[] }).images as { image_url?: { url?: unknown } }[]
    )
      .filter((image) => typeof image?.image_url?.url === 'string')
      .map((image) => ({ type: 'image', url: image.image_url?.url }));
    return [{ type: 'text', text: content }, ...images];
  }
  return content;
}

/** 非串流回應的那一則換成 LangChain 訊息（照 `convertCompletionsMessageToBaseMessage`）。 */
function toBaseMessage(message: CompletionMessage, rawResponse: CompletionResponse): BaseMessage {
  const rawToolCalls = message.tool_calls;
  switch (message.role) {
    case 'assistant': {
      const toolCalls = [];
      const invalidToolCalls = [];
      for (const rawToolCall of rawToolCalls ?? []) {
        try {
          toolCalls.push(parseToolCall(rawToolCall, { returnId: true }));
        } catch (error) {
          invalidToolCalls.push(makeInvalidToolCall(rawToolCall, (error as Error).message));
        }
      }
      const additional_kwargs: Record<string, unknown> = {
        function_call: message.function_call,
        tool_calls: rawToolCalls,
      };
      if (message.reasoning_content !== undefined)
        additional_kwargs['reasoning_content'] = message.reasoning_content;
      const response_metadata = {
        model_provider: 'openai',
        model_name: rawResponse.model,
        usage: { ...rawResponse.usage },
        ...(rawResponse.system_fingerprint
          ? { system_fingerprint: rawResponse.system_fingerprint }
          : {}),
      };
      if (message.audio) additional_kwargs['audio'] = message.audio;
      return new AIMessage({
        content: multiModalOutputOf(
          message.content || '',
          rawResponse.choices?.[0]?.message,
        ) as never,
        tool_calls: toolCalls as never,
        invalid_tool_calls: invalidToolCalls,
        additional_kwargs,
        response_metadata,
        id: rawResponse.id,
      } as never);
    }
    default:
      return new ChatMessage((message.content as string) || '', message.role ?? 'unknown');
  }
}

/** 串流的一段 delta 換成 LangChain 的訊息片段（照 `convertCompletionsDeltaToBaseMessageChunk`）。 */
function toMessageChunk(
  delta: CompletionDelta,
  rawResponse: CompletionChunk,
  defaultRole: string | undefined,
): BaseMessageChunk {
  const role = delta.role ?? defaultRole;
  const content = delta.content ?? '';
  let additional_kwargs: Record<string, unknown>;
  if (delta.function_call) additional_kwargs = { function_call: delta.function_call };
  else if (delta.tool_calls) additional_kwargs = { tool_calls: delta.tool_calls };
  else additional_kwargs = {};
  if (delta.reasoning_content !== undefined)
    additional_kwargs['reasoning_content'] = delta.reasoning_content;
  if (delta.audio)
    additional_kwargs['audio'] = { ...delta.audio, index: rawResponse.choices?.[0]?.index };
  const response_metadata = { model_provider: 'openai', usage: { ...rawResponse.usage } };
  if (role === 'user') return new HumanMessageChunk({ content, response_metadata });
  if (role === 'assistant') {
    const toolCallChunks = (Array.isArray(delta.tool_calls) ? delta.tool_calls : []).map(
      (rawToolCall) => ({
        name: rawToolCall.function?.name,
        args: rawToolCall.function?.arguments,
        id: rawToolCall.id,
        index: rawToolCall.index,
        type: 'tool_call_chunk' as const,
      }),
    );
    return new AIMessageChunk({
      content,
      tool_call_chunks: toolCallChunks,
      additional_kwargs,
      id: rawResponse.id,
      response_metadata,
    } as never);
  }
  if (role === 'system') return new SystemMessageChunk({ content, response_metadata });
  if (role === 'developer')
    return new SystemMessageChunk({
      content,
      response_metadata,
      additional_kwargs: { __openai_role__: 'developer' },
    });
  if (role === 'function')
    return new FunctionMessageChunk({
      content,
      additional_kwargs,
      name: delta.name as string,
      response_metadata,
    });
  if (role === 'tool')
    return new ToolMessageChunk({
      content,
      additional_kwargs,
      tool_call_id: delta.tool_call_id as string,
      response_metadata,
    });
  return new ChatMessageChunk({ content, role: role as string, response_metadata });
}

function isContextOverflow(error: object): boolean {
  if (String(error).includes('context_length_exceeded')) return true;
  const message = (error as { message?: unknown }).message;
  return (
    typeof message === 'string' &&
    (message.includes('Input tokens exceed the configured limit') ||
      message.includes('exceeds the context window') ||
      message.includes('maximum context length'))
  );
}

/** 在錯誤上記 `lc_error_code`，訊息後面接 LangChain 的排錯網址（照 `addLangChainErrorFields`，下游的分類與日誌讀的是同一串字）。 */
function withLangChainErrorCode<T extends object>(error: T, code: string): T {
  const target = error as T & { lc_error_code?: string; message: string };
  target.lc_error_code = code;
  target.message = `${target.message}\n\nTroubleshooting URL: https://docs.langchain.com/oss/javascript/langchain/errors/${code}/\n`;
  return target;
}

/**
 * SDK 拋出來的錯換成 LangChain 那一套（照 `wrapOpenAIClientError`）：逾時與中止換成具名的 `Error`，溢出換成 `ContextOverflowError`，
 * 幾個狀態碼補 `lc_error_code`，並標可不可以重試。
 * @param error - SDK 拋的錯。
 * @returns 要往外拋的錯。
 */
export function wrapOpenAIClientError(error: unknown): unknown {
  if (!error || typeof error !== 'object') return error;
  const message = (error as { message?: unknown }).message;
  const status = (error as { status?: unknown }).status;
  if (error.constructor.name === APIConnectionTimeoutError.name && typeof message === 'string') {
    const wrapped = new Error(message);
    wrapped.name = 'TimeoutError';
    return stampRetryable(wrapped, true);
  }
  if (error.constructor.name === APIUserAbortError.name && typeof message === 'string') {
    const wrapped = new Error(message);
    wrapped.name = 'AbortError';
    return stampRetryable(wrapped, false);
  }
  if (isContextOverflow(error)) return ContextOverflowError.fromError(error as Error);
  if (status === 400 && typeof message === 'string' && message.includes('tool_calls'))
    return stampRetryable(withLangChainErrorCode(error, 'INVALID_TOOL_RESULTS'), false);
  if (status === 401)
    return stampRetryable(withLangChainErrorCode(error, 'MODEL_AUTHENTICATION'), false);
  if (status === 429)
    return stampRetryable(withLangChainErrorCode(error, 'MODEL_RATE_LIMIT'), true);
  if (status === 404)
    return stampRetryable(withLangChainErrorCode(error, 'MODEL_NOT_FOUND'), false);
  return error;
}
