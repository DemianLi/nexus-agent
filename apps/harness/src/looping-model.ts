/**
 * 永遠再叫一次工具的假模型 —— **迴圈上限唯一的零憑證驗法**。
 *
 * `ScriptedChatModel` 驗不了這件事：它的腳本用完就拋，所以「迴圈跑得太久」在它身上
 * 表現成「腳本不夠長」，跟護欄有沒有生效分不開。這一個永遠不停，所以停下來的一定是
 * 護欄；停在第幾輪就是護欄設在哪裡。
 *
 * **實測的換算是 `recursionLimit = 2 × 模型輪數 + 2`**（`8` → 3 輪、`10` → 4 輪）：
 * 一輪模型加一輪工具各算一個 super-step。看到一個上限值時要記得除以二再讀。
 */

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';

export interface LoopingChatModelOptions extends BaseChatModelParams {
  /** 每一輪要呼叫的工具名。預設 `echo`。 */
  readonly toolName?: string;
  /**
   * 每一輪先等幾毫秒。
   *
   * **預設 0，但驗 `signal` 那種靠計時器的護欄時一定要給一個正數。** 純 microtask 的
   * 迴圈會把 event loop 的計時器餓死 —— 實測過一次：`AbortSignal.timeout(1000)` 在
   * 不 await 任何真東西的模型上完全沒有觸發，跑滿 35.6 秒到迴圈上限才停，
   * 看起來完全像是「signal 這條路行不通」。給 5ms 之後它 1.0 秒準時中止。
   * 真模型每一輪都有真的 I/O，所以那個結論是探針的產物，不是基座的行為。
   */
  readonly delayMs?: number;
}

/** 每一輪都回同一個工具呼叫的假模型。 */
export class LoopingChatModel extends BaseChatModel {
  /** 被問了幾輪。護欄停在哪裡就看它。 */
  calls = 0;

  private readonly toolName: string;
  private readonly delayMs: number;

  constructor(options: LoopingChatModelOptions = {}) {
    const { toolName, delayMs, ...rest } = options;
    super(rest);
    this.toolName = toolName ?? 'echo';
    this.delayMs = delayMs ?? 0;
  }

  _llmType(): string {
    return 'looping';
  }

  override bindTools(): this {
    return this;
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    this.calls += 1;
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));

    const content = '再來一次。';
    const message = new AIMessage({
      content,
      tool_calls: [
        {
          id: `loop_${this.calls}`,
          name: this.toolName,
          args: { message: 'x' },
          type: 'tool_call' as const,
        },
      ],
      usage_metadata: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
    });
    return { generations: [{ text: content, message }], llmOutput: {} };
  }
}
