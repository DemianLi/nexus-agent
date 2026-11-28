/**
 * LangGraph 的圖包成 {@link LoopAgent}（[#3342](https://github.com/DemianLi/nexus-agent/issues/3342)）。
 *
 * 圖沒有的三件事由這一層補：灌回對話與接上日誌的訊息經存檔點（`updateState`），收回停在等待點的 run 沒有東西可收（LangGraph 的中斷當場收掉那次
 * run，下一次照樣開）。哪幾顆呼叫還懸著問存檔點（{@link danglingToolCalls}）。
 *
 * TODO(#2363) 刪 `langgraph` 時連同這一層與 {@link LoopAgent.danglingCalls} 一起刪。
 *
 * @module
 */

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

/**
 * 這一層要用到的圖的成員。參數寫 `never`，所以 `createAgent`、`createDeepAgent` 推導出來的型別都收得下；實際的形狀由 {@link LoopAgent} 的簽名擔保，
 * 這一層只負責轉手。
 */
export interface LangGraphLike {
  streamEvents(input: never, config: never): Promise<unknown>;
  stream(input: never, config: never): Promise<unknown>;
  invoke(input: never, config?: never): Promise<unknown>;
  withConfig(config: never): LangGraphLike;
  getState(config: never): Promise<{ readonly values: unknown }>;
  updateState(config: never, values: never): Promise<unknown>;
}

class LangGraphLoopAgent implements LoopAgent {
  /** `#` 的私有欄位不列舉，`patch-tool-calls-mount.test.ts` 要從這個把手走進圖裡找 middleware 疊，所以用 TypeScript 的 `private`。 */
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
