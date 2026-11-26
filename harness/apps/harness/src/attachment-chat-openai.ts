/**
 * 會在送出請求之前投影附件的 `BaseChatOpenAI`（[#732](https://github.com/DemianLi/nexus-agent/issues/732)）。
 *
 * ## 為什麼是子類，而且覆寫三個方法
 *
 * （三個方法本身覆寫在基底 `GatedChatOpenAI`：全機的模型請求並行閘 #1505 也掛在同三個方法上，這個子類只提供「送出前做什麼」。）
 *
 * LangChain 的 `handleChatModelStart` 在 `_generate`／`_streamChatModelEvents`／`_streamResponseChunks` 之前跑，所以 callback
 * 與我們自己的日誌、軌跡看到的是**參照**；請求轉換（`toCompletionsMessages`）在它們裡面，這時換掉區塊，base64 就只存在於
 * 這次請求的記憶體裡。三條路是基座依呼叫方式挑的（`@langchain/core` 1.2.9 的 `chat_models.js:118-154,229-272,309`）：`invoke` 平常走 `_generate`，
 * 有偏好 stream-event 的 handler 時走 `_streamChatModelEvents`、有偏好串流的 handler 時走 `_streamResponseChunks`；`stream()` 走
 * `_streamResponseChunks`，v3 的 `streamEvents()` 走 `_streamChatModelEvents`——漏一條，那一條路上附件就會以原樣的區塊進請求轉換。
 *
 * ## `withConfig` 也要覆寫
 *
 * `BaseChatOpenAI.withConfig` 是 `new BaseChatOpenAI(this.fields)`（`bindTools` 也走它），會把子類丟掉、換回沒有投影的本尊。
 * 覆寫成重建同一個子類，並接上同一份投影。
 *
 * ## 圖片額度的檢查也在這裡（[#1270](https://github.com/DemianLi/nexus-agent/issues/1270)）
 *
 * **adapter 只量、不決定**。請求轉換之前先量 `imageBudget`，留著的圖超過這顆模型的額度時拋 `IMAGE_OFFLOAD_REQUIRED`（帶還要省略幾張），
 * 這時**還沒讀附件位元組、沒有任何東西送出去**。接住、下決定、再送一次是上層的事（`@nexus/core` 的 `createImageOffloadRecoveryMiddleware`）。
 * 檢查放在投影前面：量的是參照上的 `bytes`，不必為了一個注定要被丟掉的請求讀檔。
 *
 * 額度也掛在 `IMAGE_BUDGET_PROPERTY` 上：上層（`createImageOffloadMiddleware`）在記 `model/start` 之前讀它先量、先下決定；只有上層量不到的（adapter 沒掛額度、或上層挑不到可省略的）才會在這裡超額。
 *
 * @module
 */

import type { BaseMessage } from '@langchain/core/messages';

import { assertImageBudget, IMAGE_BUDGET_PROPERTY } from '@nexus/core';
import type { ImageBudget } from '@nexus/core';

import type { BaseChatOpenAI, BaseChatOpenAIFields } from './base-chat-openai.js';
import { GatedChatOpenAI } from './gated-chat-openai.js';
import type { RequestGate } from './request-gate.js';

/** 一次請求前的投影：回要送出的訊息。 */
export type MessageProjector = (
  messages: readonly BaseMessage[],
) => Promise<readonly BaseMessage[]>;

export class AttachmentChatOpenAI extends GatedChatOpenAI {
  readonly #project: MessageProjector;
  readonly #imageBudget: ImageBudget | undefined;

  constructor(
    fields: BaseChatOpenAIFields,
    project: MessageProjector,
    imageBudget?: ImageBudget,
    gate?: RequestGate,
  ) {
    super(fields, gate);
    this.#project = project;
    this.#imageBudget = imageBudget;
  }

  /** 這顆模型的圖片額度，給上層先量（`@nexus/core` 的 `imageBudgetOf`）。 */
  get [IMAGE_BUDGET_PROPERTY](): ImageBudget | undefined {
    return this.#imageBudget;
  }

  /** 先量額度（超額就拋，不碰附件）；排在取全機名額之前，見 `gated-chat-openai.ts`。 */
  protected override precheck(messages: readonly BaseMessage[]): void {
    if (this.#imageBudget !== undefined) assertImageBudget(messages, this.#imageBudget);
  }

  /** 取到名額之後才投影，排隊的那段時間不抱著剛讀進來的位元組。 */
  protected override project(messages: readonly BaseMessage[]): Promise<readonly BaseMessage[]> {
    return this.#project(messages);
  }

  override withConfig(
    config: Parameters<BaseChatOpenAI['withConfig']>[0],
  ): ReturnType<BaseChatOpenAI['withConfig']> {
    const next = new AttachmentChatOpenAI(
      this.fields,
      this.#project,
      this.#imageBudget,
      this.requestGate,
    );
    next.defaultOptions = { ...this.defaultOptions, ...config };
    return next as never;
  }
}
