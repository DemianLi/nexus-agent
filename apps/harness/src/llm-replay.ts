/**
 * **重放模型**（[#1556](https://github.com/DemianLi/nexus-agent/issues/1556) C077）：照一份錄好的會話日誌，每一次模型呼叫吐回當時那一則
 * `assistant/message`，in-process，不連外、不讀金鑰。
 *
 * - **腳本從日誌推**：每一則 `assistant/message` 是一次呼叫，依日誌順序。夾具同時是重放的輸入與預期的落盤結果。
 * - **只照位置吐，不比對請求**：走歪了由事後比對落盤日誌抓。
 * - **多叫一次就拋，腳本那一格不是 `ai` 也拋。** 少叫不在這裡擋：直接拿模型的呼叫端讀 {@link ReplayChatModel.consumed}；
 *   走 serve 的快照比落盤的回覆數（`snapshot/snapshot.test.ts`）。
 * - **不重現串流切塊**：日誌存的是組好的整則訊息（`@nexus/core` 的 `logged-message.ts`，紀律是「記下來的推得回同一則」），
 *   切塊的邊界沒有記。每一塊只吐一顆 delta；比對的是落盤日誌，不受影響。
 * - **子代理不支援**：重放的 serve 一條 thread 一顆模型，腳本只綁 root 那一份日誌。
 * - **`llm/stream` 照派、不改吐的內容**：native 帶進來的環繞函式拿到一顆從錄好那則推出來的 chunk，它交回的串流排乾就丟；
 *   吐的仍是腳本那一則，監聽者短路也一樣。
 *
 * @module
 */

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type { ChatModelStreamEvent, FinishReason } from '@langchain/core/language_models/event';
import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage, ContentBlock, UsageMetadata } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { fromLoggedMessage } from '@nexus/core';
import type { LoggedMessage, SessionEvent } from '@nexus/core';

import { passAroundOnce, takeAround, withoutAround } from './base-chat-openai.js';

/** 腳本游標。`bindTools` 產生的副本與本體共用同一份，同 `ScriptedChatModel`。 */
export interface ReplayModelState {
  /** 已經吐出幾次。 */
  next: number;
}

/**
 * 從一份會話日誌推出重放腳本：每一則 `assistant/message` 一次呼叫，依日誌順序。
 *
 * @param events - 日誌本文的事件。
 * @returns 每一次呼叫要吐的那一則。
 */
export function replayScriptFromEvents(events: readonly SessionEvent[]): readonly LoggedMessage[] {
  const script: LoggedMessage[] = [];
  for (const event of events) {
    if (event.type === 'assistant/message') {
      script.push((event as SessionEvent<'assistant/message'>).data.message);
    }
  }
  return script;
}

/** 落盤那一則回覆的 `data` 裡，重放要讀的幾格。 */
interface LoggedReplyData {
  readonly id?: unknown;
  readonly content?: unknown;
  readonly response_metadata?: Record<string, unknown>;
  readonly usage_metadata?: UsageMetadata;
}

interface ReplayChatModelOptions extends BaseChatModelParams {
  readonly script: readonly LoggedMessage[];
  /** 自報的型號（`model`）。給了就是錄的那一顆：估算照型錄認它（例如數字逐位切詞），借錨也對得上錄到的回覆。 */
  readonly model?: string;
  readonly shared?: ReplayModelState;
}

/** 照腳本吐回錄好的訊息。見模組說明。 */
export class ReplayChatModel extends BaseChatModel {
  private readonly script: readonly LoggedMessage[];
  private readonly shared: ReplayModelState;
  readonly model: string | undefined;

  constructor(options: ReplayChatModelOptions) {
    const { script, shared, model, ...rest } = options;
    super(rest);
    this.script = script;
    this.shared = shared ?? { next: 0 };
    this.model = model;
  }

  /** 已經吐出幾次。 */
  get consumed(): number {
    return this.shared.next;
  }

  /** 腳本一共幾次。 */
  get length(): number {
    return this.script.length;
  }

  _llmType(): string {
    return 'replay';
  }

  override bindTools(_tools: readonly unknown[]): ReplayChatModel {
    return new ReplayChatModel({
      script: this.script,
      shared: this.shared,
      ...(this.model !== undefined && { model: this.model }),
    });
  }

  override async invoke(
    input: BaseLanguageModelInput,
    options?: Parameters<BaseChatModel['invoke']>[1],
  ): ReturnType<BaseChatModel['invoke']> {
    return super.invoke(input, takeAround(options as never) as never);
  }

  override _getCallOptionsForTracing(
    options: this['ParsedCallOptions'],
    invocationParams: ReturnType<this['invocationParams']>,
  ): this['ParsedCallOptions'] {
    return withoutAround(super._getCallOptionsForTracing(options, invocationParams));
  }

  private nextLogged(): LoggedMessage {
    const logged = this.script[this.shared.next];
    if (logged === undefined) {
      throw new Error(
        `重放腳本只錄了 ${String(this.script.length)} 次模型呼叫，這一次是第 ${String(this.shared.next + 1)} 次`,
      );
    }
    this.shared.next += 1;
    if (logged.type !== 'ai') {
      throw new Error(`重放腳本第 ${String(this.shared.next)} 次不是模型的回覆（${logged.type}）`);
    }
    return logged;
  }

  private nextMessage(): AIMessage {
    const message = fromLoggedMessage(this.nextLogged());
    if (!(message instanceof AIMessage)) {
      throw new Error(
        `重放腳本第 ${String(this.shared.next)} 次不是模型的回覆（${message.getType()}）`,
      );
    }
    return message;
  }

  async _generate(
    _messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    const message = this.nextMessage();
    await passAroundOnce(options, message);
    return { generations: [{ text: message.text, message }], llmOutput: {} };
  }

  /**
   * v3 typed stream 那條（serve 走的就是它：`BaseChatModel._generateUncached` 的 typed-stream 分支，`@langchain/core` 1.2.9）：
   * 直接吐事件，不經基座的 `convertChunksToEvents`。那座橋把 `response_metadata` 丟掉、結束原因寫死 `stop`，
   * 吐片段的話落盤那則就少了模型名、真正的結束原因。基座組最後那一則的規則（`ChatModelStream._assembleMessage`）：id 取
   * `message-start`、內容取每一塊的 `content-block-finish`、`response_metadata` 是 `message-finish` 的
   * `responseMetadata` 加上 `finish_reason`（取 `reason`）與 `output_version: v1`。照這個規則反推回去，
   * 落盤的就是錄的那一則，同 ChatOpenAI 自己覆寫這一格。
   *
   * serve 落盤的回覆 content 一律是標準區塊（`output_version: v1`）；字串形狀的（CLI 走 `_generate` 的那種）
   * 當成一塊文字吐，落盤會變成區塊陣列，不在這條路的保真範圍內。
   */
  override async *_streamChatModelEvents(
    _messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): AsyncGenerator<ChatModelStreamEvent> {
    const logged = this.nextLogged();
    const message = fromLoggedMessage(logged);
    if (message instanceof AIMessage) await passAroundOnce(options, message);
    const data = logged.data as LoggedReplyData;
    yield { event: 'message-start', ...(typeof data.id === 'string' ? { id: data.id } : {}) };
    const blocks: readonly ContentBlock[] = Array.isArray(data.content)
      ? data.content
      : typeof data.content === 'string' && data.content !== ''
        ? [{ type: 'text', text: data.content }]
        : [];
    for (const [index, content] of blocks.entries()) {
      // 文字與推理要有一顆 delta：下行畫回覆只收 `text-delta`／`reasoning-delta`（`@nexus/wire` 的
      // `conversation.ts`），只有 start 與 finish 的話畫面上是空的。落盤取的是 finish 那一塊，不受影響。
      if (content.type === 'text' && typeof content.text === 'string') {
        yield { event: 'content-block-start', index, content: { ...content, text: '' } };
        yield {
          event: 'content-block-delta',
          index,
          delta: { type: 'text-delta', text: content.text },
        };
      } else if (content.type === 'reasoning' && typeof content.reasoning === 'string') {
        yield { event: 'content-block-start', index, content: { ...content, reasoning: '' } };
        yield {
          event: 'content-block-delta',
          index,
          delta: { type: 'reasoning-delta', reasoning: content.reasoning },
        };
      } else {
        yield { event: 'content-block-start', index, content };
      }
      yield { event: 'content-block-finish', index, content };
    }
    const {
      finish_reason: reason,
      output_version: _outputVersion,
      ...responseMetadata
    } = data.response_metadata ?? {};
    yield {
      event: 'message-finish',
      ...(reason === undefined ? {} : { reason: reason as FinishReason }),
      ...(data.usage_metadata === undefined ? {} : { usage: data.usage_metadata }),
      responseMetadata,
    };
  }
}
