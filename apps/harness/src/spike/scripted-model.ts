import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { ChatGenerationChunk, ChatResult } from '@langchain/core/outputs';

/** bindTools 會產生新實例，游標與綁定記錄要留在本體與副本共用的物件上。 */
interface ScriptedModelState {
  turn: number;
  boundToolNames: readonly string[];
}

/** 腳本裡的一次工具呼叫。 */
export interface ScriptedToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/** agent 迴圈的一輪：模型講一段話，並可選擇呼叫工具。 */
export interface ScriptedTurn {
  readonly content: string;
  readonly toolCalls?: readonly ScriptedToolCall[];
}

interface ScriptedChatModelOptions extends BaseChatModelParams {
  readonly turns: readonly ScriptedTurn[];
  /** bindTools 產生的副本要與本體共用這份狀態，否則每次綁定都會從第一輪重來。 */
  readonly shared?: ScriptedModelState;
}

/**
 * 照腳本回答的假模型。
 *
 * Phase 0 spike 沒有可用的模型 API key，所以用它把 agent 迴圈跑起來：
 * 迴圈的形狀、工具呼叫的接線、虛擬檔案的寫入、streaming 的事件序列
 * 都是真的，只有「模型決定要呼叫哪個工具」這一步是寫死的。
 * 真實供應商接線另外驗，見 PR 內文。
 */
export class ScriptedChatModel extends BaseChatModel {
  private readonly turns: readonly ScriptedTurn[];
  private readonly shared: ScriptedModelState;

  constructor(options: ScriptedChatModelOptions) {
    const { turns, shared, ...rest } = options;
    super(rest);
    this.turns = turns;
    this.shared = shared ?? { turn: 0, boundToolNames: [] };
  }

  /** bindTools 收到什麼，spike 用它斷言基座真的把工具交給了模型。 */
  get boundToolNames(): readonly string[] {
    return this.shared.boundToolNames;
  }

  _llmType(): string {
    return 'scripted';
  }

  override bindTools(tools: readonly unknown[]): ScriptedChatModel {
    this.shared.boundToolNames = tools.map((candidate) => {
      const name = (candidate as { name?: unknown }).name;
      return typeof name === 'string' ? name : '<anonymous>';
    });
    return new ScriptedChatModel({ turns: this.turns, shared: this.shared });
  }

  /** 腳本用完就代表 agent 迴圈跑得比預期多，直接失敗比靜默重播容易查。 */
  private nextTurn(): ScriptedTurn {
    const turn = this.turns[this.shared.turn];
    if (turn === undefined) {
      throw new Error(
        `腳本只有 ${this.turns.length} 輪，但 agent 迴圈要求第 ${this.shared.turn + 1} 輪`,
      );
    }
    this.shared.turn += 1;
    return turn;
  }

  private toMessage(turn: ScriptedTurn): AIMessage {
    return new AIMessage({
      content: turn.content,
      tool_calls: turn.toolCalls?.map((call, index) => ({
        id: `call_${this.shared.turn}_${index}`,
        name: call.name,
        args: call.args,
        type: 'tool_call' as const,
      })),
    });
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const turn = this.nextTurn();
    const message = this.toMessage(turn);
    return { generations: [{ text: turn.content, message }], llmOutput: {} };
  }

  /**
   * 逐字吐 token，讓 `streamMode: 'messages'` 真的有多個 chunk 可收，
   * 而不是退回 _generate 產生的單一 chunk。
   */
  override async *_streamResponseChunks(
    _messages: BaseMessage[],
    _options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const turn = this.nextTurn();
    const message = this.toMessage(turn);

    for (const token of [...turn.content]) {
      // handleLLMNewToken 要自己呼叫，基座才收得到 token 事件；
      // 少了這行，streamMode: 'messages' 只會拿到聚合後的整段訊息。
      await runManager?.handleLLMNewToken(token);
      yield {
        text: token,
        message: new AIMessageChunk({ content: token }),
      } as ChatGenerationChunk;
    }

    yield {
      text: '',
      message: new AIMessageChunk({ content: '', tool_calls: message.tool_calls }),
    } as ChatGenerationChunk;
  }
}
