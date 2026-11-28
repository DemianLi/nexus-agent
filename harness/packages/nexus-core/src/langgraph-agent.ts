import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';

import {
  danglingToolCalls,
  type DanglingCall,
  type InvokeConfig,
  type LoopAgent,
  type LoopDefaults,
  type LoopInput,
  type RawProtocolEvent,
  type RunProjections,
  type StreamConfig,
  type StreamEventsConfig,
  type ThreadConfig,
} from './loop-agent.js';
import type { LoopState } from './native-loop/state.js';

export interface LangGraphLike {
  streamEvents(input: never, config: never): Promise<unknown>;
  stream(input: never, config: never): Promise<unknown>;
  invoke(input: never, config?: never): Promise<unknown>;
  withConfig(config: never): LangGraphLike;
  getState(config: never): Promise<{ readonly values: unknown }>;
  updateState(config: never, values: never): Promise<unknown>;
}

class LangGraphLoopAgent implements LoopAgent {
  constructor(private readonly graph: LangGraphLike) {}

  async streamEvents(
    input: LoopInput,
    config: StreamEventsConfig,
  ): Promise<AsyncIterable<RawProtocolEvent> & RunProjections> {
    return (await this.graph.streamEvents(
      input as never,
      config as never,
    )) as AsyncIterable<RawProtocolEvent> & RunProjections;
  }

  async stream(
    input: LoopInput,
    config: StreamConfig,
  ): Promise<AsyncIterable<readonly [mode: string, payload: unknown]>> {
    return (await this.graph.stream(input as never, config as never)) as AsyncIterable<
      readonly [string, unknown]
    >;
  }

  async invoke(input: LoopInput, config?: InvokeConfig): Promise<LoopState> {
    return (await this.graph.invoke(input as never, config as never)) as LoopState;
  }

  withConfig(defaults: LoopDefaults): LoopAgent {
    return new LangGraphLoopAgent(this.graph.withConfig(defaults as never));
  }

  getState(config: ThreadConfig): Promise<{ readonly values: unknown }> {
    return this.graph.getState(config as never);
  }

  async seedThread(
    config: ThreadConfig,
    messages: readonly BaseMessage[],
    _guard: (messages: readonly BaseMessage[]) => void,
  ): Promise<void> {
    await this.graph.updateState(config as never, { messages: [...messages] } as never);
  }

  async appendLoggedMessages(
    config: ThreadConfig,
    messages: readonly BaseMessage[],
  ): Promise<void> {
    let accepted = messages;
    if (messages.some((message) => ToolMessage.isInstance(message))) {
      const pending = new Set(
        danglingToolCalls((await this.graph.getState(config as never)).values).map(
          (call) => call.id,
        ),
      );
      accepted = messages.filter(
        (message) => !ToolMessage.isInstance(message) || pending.has(message.tool_call_id),
      );
    }
    if (accepted.length > 0) {
      await this.graph.updateState(config as never, { messages: [...accepted] } as never);
    }
  }

  discardSuspended(_config: ThreadConfig): void {}

  async danglingCalls(config: ThreadConfig): Promise<readonly DanglingCall[]> {
    return danglingToolCalls((await this.graph.getState(config as never)).values);
  }
}

/**
 * 把 LangGraph 編出來的圖（`createAgent`、`createDeepAgent`）包成 {@link LoopAgent}。
 *
 * @param graph - 帶存檔點的圖。
 */
export function adaptLangGraph(graph: LangGraphLike): LoopAgent {
  return new LangGraphLoopAgent(graph);
}
