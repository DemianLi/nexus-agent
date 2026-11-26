/**
 * 模型請求綁上工具與設定的那一步，與「綁完之後這次呼叫會送出什麼參數」的預覽（[#2361](https://github.com/DemianLi/nexus-agent/issues/2361)）。
 *
 * **綁定只有一份**：native 的 `callModel` 真的送出前綁（{@link bindRequestModel}），請求快照在推導之前預先算也綁同一支，
 * 兩邊不會各自漂移。綁定照 `langchain` 的 `_simpleBindTools`：裸模型直接綁，`RunnableBinding` 綁裡面那顆再把外層的 config／kwargs 包回去。
 *
 * **預覽不送請求**：{@link previewCallParams} 問模型自己「這次呼叫的供應商層參數」，就是 LangChain 在 `handleChatModelStart` 傳給
 * callback 的 `invocation_params` 與 `options`（`BaseChatModel` 的 `_streamIterator`、`_generateUncached` 都先問 `_getInvocationParamsForTracing` 與 `_getCallOptionsForTracing`）。這兩支都是純函式：
 * `ChatOpenAI` 的 `invocationParams` 只讀實例欄位與傳入的選項，不碰網路、不改實例（讀 `@langchain/openai@1.5.10`）。
 *
 * @module
 */

import { RunnableBinding } from '@langchain/core/runnables';

interface BindsTools {
  bindTools(tools: readonly unknown[], options: Record<string, unknown>): unknown;
}

function canBindTools(model: unknown): model is BindsTools {
  return typeof (model as Partial<BindsTools> | null)?.bindTools === 'function';
}

/**
 * 同 langchain 的 `_simpleBindTools`。
 *
 * @param model - 模型，裸的或一層 `RunnableBinding`。
 * @param tools - 這次呼叫的工具。
 * @param options - 綁進去的選項（`modelSettings` 加 `tool_choice`）。
 * @returns 綁好的模型。
 * @throws {Error} 模型沒有 `bindTools`。
 */
export function bindTools(
  model: unknown,
  tools: readonly unknown[],
  options: Record<string, unknown>,
): unknown {
  if (canBindTools(model)) return model.bindTools(tools, options);
  if (RunnableBinding.isRunnableBinding(model) && canBindTools(model.bound)) {
    const bound = model.bound.bindTools(tools, options);
    if (RunnableBinding.isRunnableBinding(bound)) {
      return new RunnableBinding({
        bound: bound.bound,
        config: { ...model.config, ...bound.config },
        kwargs: { ...model.kwargs, ...bound.kwargs },
        configFactories: bound.configFactories ?? model.configFactories,
      });
    }
    return new RunnableBinding({
      bound: bound as never,
      config: model.config,
      kwargs: model.kwargs,
      configFactories: model.configFactories,
    });
  }
  throw new Error(`llm ${String(model)} must define bindTools method.`);
}

/** 模型請求上綁定用得到的那幾格。 */
export interface BindableRequest {
  readonly model: unknown;
  readonly tools: readonly unknown[];
  readonly modelSettings?: Record<string, unknown> | undefined;
  readonly toolChoice?: unknown;
}

/**
 * 照請求綁工具與設定：`callModel` 送出與快照預覽共用的那一支。
 *
 * @param request - 這次模型請求。
 * @returns 綁好的模型。
 */
export function bindRequestModel(request: BindableRequest): unknown {
  return bindTools(request.model, request.tools, {
    ...request.modelSettings,
    tool_choice: request.toolChoice,
  });
}

/** 預覽出的、LangChain 在 `handleChatModelStart` 會傳給 callback 的兩樣。 */
export interface PreviewedCallParams {
  /** `extraParams.invocation_params`。 */
  readonly invocation: unknown;
  /** `extraParams.options`。 */
  readonly options: unknown;
  /** 供應商層沒報模型 id 時的備援（模型實例序列化出來的 `model`）。 */
  readonly fallbackModel: string | undefined;
}

interface TracingModel {
  _separateRunnableConfigFromCallOptionsCompat?(options: unknown): [unknown, unknown];
  _getInvocationParamsForTracing?(options: unknown): unknown;
  _getCallOptionsForTracing?(options: unknown, invocationParams: unknown): unknown;
  toJSON?(): unknown;
}

/**
 * 預覽綁好的模型這次呼叫會報給 callback 的參數，不送請求。
 *
 * 動態模型與非 LangChain 物件（沒有那幾支）回 `undefined`；不報參數的 `BaseChatModel`（如 `ScriptedChatModel`）回空參數，跟 callback 那邊一樣。
 *
 * @param bound - {@link bindRequestModel} 的結果。
 * @returns 預覽；問不出來是 `undefined`。
 */
export function previewCallParams(bound: unknown): PreviewedCallParams | undefined {
  if (typeof bound !== 'object' || bound === null) return undefined;
  const binding = RunnableBinding.isRunnableBinding(bound) ? bound : undefined;
  const model = (binding === undefined ? bound : binding.bound) as TracingModel | null;
  if (
    model === null ||
    typeof model !== 'object' ||
    typeof model._separateRunnableConfigFromCallOptionsCompat !== 'function' ||
    typeof model._getInvocationParamsForTracing !== 'function' ||
    typeof model._getCallOptionsForTracing !== 'function'
  ) {
    return undefined;
  }
  const merged = binding === undefined ? {} : { ...binding.kwargs, ...binding.config };
  const [, callOptions] = model._separateRunnableConfigFromCallOptionsCompat(merged);
  const invocation = model._getInvocationParamsForTracing(callOptions);
  const options = model._getCallOptionsForTracing(callOptions, invocation);
  const kwargs = (model.toJSON?.() as { kwargs?: Record<string, unknown> } | undefined)?.kwargs;
  const fallback = kwargs?.['model'] ?? kwargs?.['model_name'] ?? kwargs?.['modelName'];
  return {
    invocation,
    options,
    fallbackModel: typeof fallback === 'string' ? fallback : undefined,
  };
}
