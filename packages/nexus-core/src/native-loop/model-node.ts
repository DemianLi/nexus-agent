/**
 * native loop 的模型節點，照 `langchain@1.5.10` 的 `dist/agents/nodes/AgentNode.js` 的 `#invokeModel`：第一格在最外層、系統訊息兩種改法互斥、
 * 回 `Command` 時用最內層記下的 AI 訊息補寫。每一格經 `langgraph-compat.ts` 的 `NodeTask.run` 跑，`getConfig()` 等讀到的是那裡合成的 config。
 *
 * @module
 */

import type { BaseMessage } from '@langchain/core/messages';
import { AIMessage, SystemMessage } from '@langchain/core/messages';
import { RunnableBinding } from '@langchain/core/runnables';
import { isCommand } from '@langchain/langgraph';
import type { Command } from '@langchain/langgraph';
import { MiddlewareError } from 'langchain';

import type { NodeTask } from './langgraph-compat.js';
import {
  runtimeOf,
  type InvokableTool,
  type LoopMiddleware,
  type ModelHandler,
} from './middleware.js';

/** 系統提示詞正規化成 `SystemMessage`，同 langchain 的 `normalizeSystemPrompt`。 */
export function systemMessageOf(systemPrompt: string | undefined): SystemMessage {
  if (systemPrompt === undefined || systemPrompt === '') return new SystemMessage('');
  return new SystemMessage({ content: [{ type: 'text', text: systemPrompt }] });
}

interface BindsTools {
  bindTools(tools: readonly unknown[], options: Record<string, unknown>): unknown;
}

function canBindTools(model: unknown): model is BindsTools {
  return typeof (model as Partial<BindsTools> | null)?.bindTools === 'function';
}

/** 同 langchain 的 `_simpleBindTools`：裸模型直接綁，`RunnableBinding` 綁裡面那顆再把外層的 config／kwargs 包回去。 */
function bindTools(
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

/** 模型那一步的結果：要寫進 state 的 AI 訊息，加上 middleware 回的 `Command`。 */
export interface ModelStepResult {
  readonly message: AIMessage | undefined;
  readonly commands: readonly Command[];
}

/** 一次模型呼叫的固定參數。 */
export interface ModelChain {
  readonly model: unknown;
  readonly systemMessage: SystemMessage;
  readonly tools: readonly InvokableTool[];
  readonly middleware: readonly LoopMiddleware[];
  /** 有沒有誰執行 `wrapModelCall` 新加的工具：任一顆 middleware 有 `wrapToolCall`。沒有就拒收新加的工具，同 langchain。 */
  readonly executesAddedTools: boolean;
  /** 環繞最內層那次打模型（`llm/stream`）；不給就直接打。 */
  readonly around?: (call: () => Promise<AIMessage>) => Promise<AIMessage>;
}

/**
 * 跑一次模型呼叫，經過整串 `wrapModelCall`。照 `AgentNode.js` 的 `#invokeModel`，拿掉結構化輸出（nexus 不用 `responseFormat`）。
 * @param chain - 模型、系統訊息、工具、middleware。
 * @param task - 這次呼叫的環境（`model_request:<id>`）。
 * @returns AI 訊息（蓋上 `name = 'model'`）與收集到的 `Command`。
 */
export async function callModel(chain: ModelChain, task: NodeTask): Promise<ModelStepResult> {
  const state = task.state;
  const registered = new Map(chain.tools.map((tool) => [tool.name, tool]));
  let currentSystemMessage = chain.systemMessage;
  let lastAiMessage: AIMessage | undefined;
  const collected: Command[] = [];

  const base: ModelHandler = async (request) => {
    const bound = bindTools(request.model, request.tools, {
      ...request.modelSettings,
      tool_choice: request.toolChoice,
    }) as { invoke(messages: BaseMessage[], config: unknown): Promise<AIMessage> };
    const messages = [
      ...(currentSystemMessage.text === '' ? [] : [currentSystemMessage]),
      ...request.messages,
    ];
    const call = () => bound.invoke(messages, task.config);
    const response = await (chain.around === undefined ? call() : chain.around(call));
    lastAiMessage = response;
    return response;
  };

  let wrapped = base;
  for (let i = chain.middleware.length - 1; i >= 0; i--) {
    const middleware = chain.middleware[i]!;
    const wrapModelCall = middleware.wrapModelCall;
    if (wrapModelCall === undefined) continue;
    const inner = wrapped;
    wrapped = async (request) => {
      const baseline = currentSystemMessage;
      const withValidation: ModelHandler = async (req) => {
        currentSystemMessage = baseline;
        const tools = req.tools ?? [];
        const added = tools.filter(
          (tool) => isClientTool(tool) && !registered.has((tool as InvokableTool).name),
        );
        const replaced = tools.filter((tool) => {
          if (!isClientTool(tool)) return false;
          const original = registered.get((tool as InvokableTool).name);
          return original !== undefined && original !== tool;
        });
        if (added.length > 0 && !chain.executesAddedTools) {
          throw new Error(
            `You have added a new tool in "wrapModelCall" hook of middleware "${middleware.name}": ${added.map((tool) => (tool as InvokableTool).name).join(', ')}. This is not supported unless a middleware provides a "wrapToolCall" handler to execute it.`,
          );
        }
        if (replaced.length > 0) {
          throw new Error(
            `You have modified a tool in "wrapModelCall" hook of middleware "${middleware.name}": ${replaced.map((tool) => (tool as InvokableTool).name).join(', ')}. This is not supported.`,
          );
        }
        let normalized = req;
        const promptChanged = req.systemPrompt !== currentSystemMessage.text;
        const messageChanged = req.systemMessage !== currentSystemMessage;
        if (promptChanged && messageChanged) {
          throw new Error('Cannot change both systemPrompt and systemMessage in the same request.');
        }
        if (promptChanged) {
          currentSystemMessage = new SystemMessage({
            content: [{ type: 'text', text: req.systemPrompt }],
          });
          normalized = {
            ...req,
            systemPrompt: currentSystemMessage.text,
            systemMessage: currentSystemMessage,
          };
        }
        if (messageChanged) {
          currentSystemMessage = new SystemMessage({ ...req.systemMessage });
          normalized = {
            ...req,
            systemPrompt: currentSystemMessage.text,
            systemMessage: currentSystemMessage,
          };
        }
        const result = await inner(normalized);
        if (isCommand(result) && lastAiMessage !== undefined) {
          if (!collected.includes(result)) collected.push(result);
          return lastAiMessage;
        }
        return result;
      };
      try {
        const response = await wrapModelCall(
          {
            ...request,
            state: { ...state, messages: state.messages },
            runtime: runtimeOf(task, undefined),
          },
          withValidation,
        );
        if (AIMessage.isInstance(response)) lastAiMessage = response;
        else if (isCommand(response)) collected.push(response);
        else {
          throw new Error(
            `Invalid response from "wrapModelCall" in middleware "${middleware.name}": expected AIMessage or Command, got ${typeof response}`,
          );
        }
        return response;
      } catch (error) {
        throw MiddlewareError.wrap(error, middleware.name);
      }
    };
  }

  currentSystemMessage = chain.systemMessage;
  const response = await task.run(() =>
    wrapped({
      model: chain.model,
      systemPrompt: currentSystemMessage.text,
      systemMessage: currentSystemMessage,
      messages: state.messages,
      tools: chain.tools,
      state,
      runtime: runtimeOf(task, undefined),
    }),
  );
  const message = AIMessage.isInstance(response) ? response : lastAiMessage;
  if (message !== undefined) {
    message.name = 'model';
    message.lc_kwargs.name = 'model';
  }
  const commands = [...collected];
  if (isCommand(response) && !commands.includes(response)) commands.unshift(response);
  return { message, commands };
}

/** 有 `invoke` 的物件（非 provider 內建工具），同 langchain 的 `isClientTool`。 */
function isClientTool(tool: unknown): boolean {
  return (
    typeof tool === 'object' &&
    tool !== null &&
    typeof (tool as { invoke?: unknown }).invoke === 'function'
  );
}
