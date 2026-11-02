import { ChatOpenAI } from '@langchain/openai';
import type { ChatOpenAIFields } from '@langchain/openai';

/** {@link GuardedChatOpenAI} 的欄位。放在 `fields` 裡，`withConfig` 建新實例時才帶得到。 */
export interface GuardedChatOpenAIFields extends ChatOpenAIFields {
  /** 模型呼叫拋出來的錯，換成要往外拋的那顆。不用換就回原錯誤。 */
  readonly translateFailure?: (error: unknown) => unknown;
}

/**
 * 模型呼叫的三個入口拋出來的錯，先過一次 {@link GuardedChatOpenAIFields.translateFailure}（[#2267](https://github.com/DemianLi/nexus-agent/issues/2267)）。
 *
 * 放在模型物件上，不放在 `wrapModelCall`：標題那顆不在模型呼叫圖裡，而重試那一顆在 `maxRetries` 為 0 時不掛。錯誤從這裡出去之後，
 * 基座發的 `tool-error`、圍堵翻的工具結果、`turn/failed` 拿到的都是換過的。
 */
export class GuardedChatOpenAI extends ChatOpenAI {
  readonly #translate: (error: unknown) => unknown;

  constructor(fields: GuardedChatOpenAIFields) {
    super(fields);
    this.#translate = fields.translateFailure ?? ((error) => error);
  }

  override async _generate(
    ...args: Parameters<ChatOpenAI['_generate']>
  ): ReturnType<ChatOpenAI['_generate']> {
    try {
      return await super._generate(...args);
    } catch (error: unknown) {
      throw this.#translate(error);
    }
  }

  override async *_streamChatModelEvents(
    ...args: Parameters<ChatOpenAI['_streamChatModelEvents']>
  ): ReturnType<ChatOpenAI['_streamChatModelEvents']> {
    try {
      yield* super._streamChatModelEvents(...args);
    } catch (error: unknown) {
      throw this.#translate(error);
    }
  }

  override async *_streamResponseChunks(
    ...args: Parameters<ChatOpenAI['_streamResponseChunks']>
  ): ReturnType<ChatOpenAI['_streamResponseChunks']> {
    try {
      yield* super._streamResponseChunks(...args);
    } catch (error: unknown) {
      throw this.#translate(error);
    }
  }

  /** `ChatOpenAI.withConfig` 寫死 `new ChatOpenAI`，不覆寫的話 `bindTools` 之後就沒有這一層。 */
  override withConfig(
    config: Parameters<ChatOpenAI['withConfig']>[0],
  ): ReturnType<ChatOpenAI['withConfig']> {
    const next = new GuardedChatOpenAI(this.fields ?? {});
    next.defaultOptions = { ...this.defaultOptions, ...config };
    return next as never;
  }
}
