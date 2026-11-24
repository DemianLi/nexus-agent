/**
 * 往 `request.model` 上掛執行期設定（訊號、callback）的**唯一入口**。
 *
 * 兩顆 middleware 都要掛：{@link ./turn-cancel.ts | turnCancelModelSignal} 綁中止訊號，
 * {@link ./request-snapshot.ts | requestSnapshot} 掛抓請求的 callback。**不能各包一層**：基座在 middleware 鏈走完之後
 * 才對 `request.model` 綁工具（`langchain` 的 `bindTools`），它只認「一層 `RunnableBinding` 包著聊天模型」，
 * 兩層疊起來就是 `llm [object Object] must define bindTools method`（實測：產品路徑上訊號與 callback 同時在時整輪失敗，
 * 沒有訊號的 REPL 路徑看不出來）。所以已經是綁定的就用它的 `withConfig` 併成同一層，不是的才新建。
 *
 * `RunnableBinding.withConfig` 是**淺合併**（`{ ...舊, ...新 }`），不是 `ChatOpenAI.withConfig` 那個重建實例、
 * 把選項塞進 `defaultOptions` 的版本（後者會被呼叫時的 `signal: undefined` 蓋掉，見 `turn-cancel.ts` 檔頭）。
 * 淺合併的代價是同一個鍵後掛的蓋掉先掛的，所以 `callbacks` 由呼叫端自己接上舊的。
 */

import type { RunnableConfig } from '@langchain/core/runnables';
import { RunnableBinding } from '@langchain/core/runnables';

/**
 * @param model - `request.model`：聊天模型，或已經被前一顆 middleware 綁過設定的 `RunnableBinding`。
 * @param patch - 要併上去的設定；`callbacks` 之外的鍵，同名的會蓋掉。
 * @returns 一層 `RunnableBinding`。
 */
export function bindModelConfig<T>(
  model: T,
  patch: (current: RunnableConfig) => RunnableConfig,
): T {
  if (RunnableBinding.isRunnableBinding(model)) {
    const binding = model as unknown as RunnableBinding<unknown, unknown>;
    return binding.withConfig(patch(binding.config)) as unknown as T;
  }
  return new RunnableBinding({
    bound: model as never,
    config: patch({}),
    kwargs: {},
  }) as unknown as T;
}
