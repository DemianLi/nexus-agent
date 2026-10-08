/**
 * 會在送出請求之前投影附件的 `ChatOpenAI`（[#732](https://github.com/DemianLi/nexus-agent/issues/732)）。
 *
 * ## 為什麼是子類，而且覆寫三個方法
 *
 * LangChain 的 `handleChatModelStart` 在 `_generate`／`_streamChatModelEvents`／`_streamResponseChunks` 之前跑，所以 callback
 * 與我們自己的日誌、軌跡看到的是**參照**；底層請求轉換（`completions._generate` 等）在它們裡面，這時換掉區塊，base64 就只存在於
 * 這次請求的記憶體裡。三條路是基座依呼叫方式挑的：`invoke` 走 `_generate`（或有串流 handler 時走 `_streamResponseChunks`），
 * v3 的 `stream()` 走 `_streamChatModelEvents`（`@langchain/core` 的 `chat_models.js:115,231`）——漏一條，那一條路上附件
 * 就會以原樣的區塊進請求轉換。
 *
 * ## `withConfig` 也要覆寫
 *
 * 基座的 `ChatOpenAI.withConfig` 是 `new ChatOpenAI(this.fields)`（`bindTools` 也走它），會把子類丟掉、換回沒有投影的本尊。
 * 覆寫成重建同一個子類，並接上同一份投影。
 *
 * @module
 */

import { ChatOpenAI } from '@langchain/openai';
import type { ChatOpenAIFields } from '@langchain/openai';
import type { BaseMessage } from '@langchain/core/messages';

/** 一次請求前的投影：回要送出的訊息。 */
export type MessageProjector = (
  messages: readonly BaseMessage[],
) => Promise<readonly BaseMessage[]>;

export class AttachmentChatOpenAI extends ChatOpenAI {
  readonly #project: MessageProjector;

  constructor(fields: ChatOpenAIFields, project: MessageProjector) {
    super(fields);
    this.#project = project;
  }

  override async _generate(
    ...[messages, options, runManager]: Parameters<ChatOpenAI['_generate']>
  ): ReturnType<ChatOpenAI['_generate']> {
    return super._generate([...(await this.#project(messages))], options, runManager);
  }

  override async *_streamChatModelEvents(
    ...[messages, options, runManager]: Parameters<ChatOpenAI['_streamChatModelEvents']>
  ): ReturnType<ChatOpenAI['_streamChatModelEvents']> {
    yield* super._streamChatModelEvents([...(await this.#project(messages))], options, runManager);
  }

  override async *_streamResponseChunks(
    ...[messages, options, runManager]: Parameters<ChatOpenAI['_streamResponseChunks']>
  ): ReturnType<ChatOpenAI['_streamResponseChunks']> {
    yield* super._streamResponseChunks([...(await this.#project(messages))], options, runManager);
  }

  override withConfig(
    config: Parameters<ChatOpenAI['withConfig']>[0],
  ): ReturnType<ChatOpenAI['withConfig']> {
    const next = new AttachmentChatOpenAI(this.fields ?? {}, this.#project);
    next.defaultOptions = { ...this.defaultOptions, ...config };
    return next as never;
  }
}
