/**
 * 永遠再叫一次工具的假模型 —— **迴圈上限唯一的零憑證驗法**。
 *
 * `ScriptedChatModel` 驗不了這件事：它的腳本用完就拋，所以「迴圈跑得太久」在它身上
 * 表現成「腳本不夠長」，跟護欄有沒有生效分不開。這一個永遠不停，所以停下來的一定是
 * 護欄；停在第幾輪就是護欄設在哪裡。
 *
 * **實測的換算是 `recursionLimit = 2 × 模型輪數 + 2`**（`8` → 3 輪、`10` → 4 輪）：
 * 一輪模型加一輪工具各算一個 super-step。看到一個上限值時要記得除以二再讀。
 *
 * **但「兩個」是裸組裝的格數，預設組裝不是它。** 每多一個帶 `beforeModel` 的 middleware，
 * 每一輪就多一個 super-step——`beforeModel` 在 LangGraph 裡是圖裡的一個節點
 * （`langchain@1.5.10`，`dist/agents/ReactAgent.js:126-134`），而
 * [#147](https://github.com/DemianLi/nexus-agent/issues/147) 打底的提醒器就是一個。
 *
 * 通式是 **`模型輪數 = floor((recursionLimit - 1) / 每輪格數)`**，2026-09-03 逐格實測：
 *
 * | 組裝 | 每輪格數 | `8` | `100` |
 * | --- | --- | --- | --- |
 * | `repeatReminder: false` | 2 | 3 輪 | 49 輪 |
 * | 預設（提醒器打底） | 3 | 2 輪 | 33 輪 |
 *
 * 拿這個模型量護欄時，**要先確定被量的那個組裝有幾個 `beforeModel` 節點**，不然對不上的
 * 輪數看起來會像護欄壞了。
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
  /**
   * 第 n 輪（1 起算）要用的參數。預設每一輪都是同一份 `{ message: 'x' }`。
   *
   * **在的理由是對照組**：重複偵測要能證明它認的是「同工具**同參數**」，而不是「同工具」
   * ——後者會把合理的多次呼叫都當成打轉。給一個每輪不同的參數，提醒就該一次都不出現。
   */
  readonly argsFor?: (call: number) => Record<string, unknown>;
}

/** 每一輪都回同一個工具呼叫的假模型。 */
export class LoopingChatModel extends BaseChatModel {
  /** 被問了幾輪。護欄停在哪裡就看它。 */
  calls = 0;

  /**
   * 每一輪送進模型的訊息串，依輪次。
   *
   * **驗「提醒真的進了 prompt」只能靠它**：提醒是被附進 `state.messages` 的，而 run 結束
   * 時的最終狀態分不出它是在第幾輪出現的。這裡存的是每一輪模型當下看到的那一份。
   */
  readonly seen: BaseMessage[][] = [];

  private readonly toolName: string;
  private readonly delayMs: number;
  private readonly argsFor: (call: number) => Record<string, unknown>;

  constructor(options: LoopingChatModelOptions = {}) {
    const { toolName, delayMs, argsFor, ...rest } = options;
    super(rest);
    this.toolName = toolName ?? 'echo';
    this.delayMs = delayMs ?? 0;
    this.argsFor = argsFor ?? ((): Record<string, unknown> => ({ message: 'x' }));
  }

  _llmType(): string {
    return 'looping';
  }

  override bindTools(): this {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls += 1;
    this.seen.push([...messages]);
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));

    const content = '再來一次。';
    const message = new AIMessage({
      content,
      tool_calls: [
        {
          id: `loop_${this.calls}`,
          name: this.toolName,
          args: this.argsFor(this.calls),
          type: 'tool_call' as const,
        },
      ],
      usage_metadata: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
    });
    return { generations: [{ text: content, message }], llmOutput: {} };
  }
}
