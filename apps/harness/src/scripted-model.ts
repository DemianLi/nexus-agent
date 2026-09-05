import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { ChatGenerationChunk, ChatResult } from '@langchain/core/outputs';

/**
 * bindTools 會產生新實例，游標與綁定記錄要留在本體與副本共用的物件上。
 *
 * **匯出是為了讓測試自己建一份**：`prompts` 是「模型真的讀到了什麼」唯一的證據，而有些
 * 驗收（`goal-driver-pump.test.ts`）要拿它跟日誌上寫的字逐字比對。
 */
export interface ScriptedModelState {
  turn: number;
  boundToolNames: readonly string[];
  lastPrompt: readonly BaseMessage[];
  prompts: (readonly BaseMessage[])[];
}

/** 腳本裡的一次工具呼叫。 */
export interface ScriptedToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/**
 * 這一輪的 token 用量。
 *
 * **假模型不會自己編這個數字**：省略即這一輪不帶 `usage_metadata`，跟真模型沒回報用量
 * 時一樣。給了才有，這樣「成本算得出來」與「成本是我們捏的」在測試裡分得開。
 */
export interface ScriptedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** agent 迴圈的一輪：模型講一段話，並可選擇呼叫工具。 */
export interface ScriptedTurn {
  readonly content: string;
  readonly toolCalls?: readonly ScriptedToolCall[];
  /** 這一輪的 token 用量。省略即不帶——見 {@link ScriptedUsage}。 */
  readonly usage?: ScriptedUsage;
}

/**
 * 腳本的用量翻成 LangChain 的 `usage_metadata`。
 *
 * `total_tokens` 由基座那邊的消費者拿來當單一數字用，所以這裡自己加總而不是留白——
 * 真模型回的也是三個欄位都齊。
 */
function toUsageMetadata(usage: ScriptedUsage): {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
} {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
  };
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
    this.shared = shared ?? { turn: 0, boundToolNames: [], lastPrompt: [], prompts: [] };
  }

  /** bindTools 收到什麼，spike 用它斷言基座真的把工具交給了模型。 */
  get boundToolNames(): readonly string[] {
    return this.shared.boundToolNames;
  }

  /**
   * 最近一輪送進模型的完整訊息串，含基座組出來的 system prompt。
   *
   * 組裝點傳給 `createDeepAgent` 的 `systemPrompt` 是否真的到得了模型，只有從這裡看得到
   * ——型別檢查擋不住「參數收下了但沒往下傳」。
   */
  get lastPrompt(): readonly BaseMessage[] {
    return this.shared.lastPrompt;
  }

  /**
   * 依發生順序的每一輪 prompt。
   *
   * **`lastPrompt` 看不到 subagent 那幾輪**——subagent 跑完之後 root 還會再問一次模型，
   * 所以最後一輪永遠是 root 的。「subagent 收到的 system prompt 長什麼樣」只有從這裡
   * 看得到，而那正是 memory 與 skills 這類「注入 system prompt」的擴充點在 subagent
   * 邊界上唯一的觀測點。
   *
   * 記在共用狀態上而不是實例上，理由跟 `turn` 一樣：`bindTools` 會產生新實例。
   */
  get prompts(): readonly (readonly BaseMessage[])[] {
    return this.shared.prompts;
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

  private record(messages: BaseMessage[]): void {
    this.shared.lastPrompt = messages;
    this.shared.prompts.push(messages);
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
      ...(turn.usage === undefined ? {} : { usage_metadata: toUsageMetadata(turn.usage) }),
    });
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.record(messages);
    const turn = this.nextTurn();
    const message = this.toMessage(turn);
    return { generations: [{ text: turn.content, message }], llmOutput: {} };
  }

  /**
   * 逐字吐 token，讓 `streamMode: 'messages'` 真的有多個 chunk 可收，
   * 而不是退回 _generate 產生的單一 chunk。
   *
   * **走 v3 typed stream 時，agent 迴圈整條都靠這個方法。** 基座裝上 stream 的 callback
   * handler 之後，`invoke` 也會被導到這裡來（`_generateUncached` 改走
   * `_streamChatModelEvents`），所以 `_generate` 的那條路上對的事情，在這裡不會自動成立。
   * 兩條路徑的一致性由 `stream-parity.test.ts` 釘住。
   */
  override async *_streamResponseChunks(
    messages: BaseMessage[],
    _options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    this.record(messages);
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

    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      // 用量掛在**最後一顆** chunk 上：`AIMessageChunk` 相加時 `usage_metadata` 會累加，
      // 每顆文字 chunk 都掛的話這一輪的數字會被乘上字數。
      if (turn.usage !== undefined) {
        yield {
          text: '',
          message: new AIMessageChunk({
            content: '',
            usage_metadata: toUsageMetadata(turn.usage),
          }),
        } as ChatGenerationChunk;
      }
      return;
    }

    // **這裡只能給 tool_call_chunks，不能給 tool_calls。**
    // 走 v3 typed stream 時基座會裝上 callback handler，`_generateUncached` 因而改走
    // `_streamChatModelEvents` → `convertChunksToEvents`
    // （`@langchain/core` `dist/language_models/compat.js`），而它**只讀
    // `tool_call_chunks`**。給 `tool_calls` 的話 v3 那條路上工具呼叫會整個消失，
    // 而且不拋錯——迴圈只跑一輪就乾淨地結束，測試照樣是綠的。
    yield {
      text: '',
      message: new AIMessageChunk({
        content: '',
        ...(turn.usage === undefined ? {} : { usage_metadata: toUsageMetadata(turn.usage) }),
        // id 一律取自 `toMessage()`，兩條路徑的 tool_call_id 才是同一份而不是碰巧相同。
        tool_call_chunks: toolCalls.map((call, index) => ({
          id: call.id,
          name: call.name,
          args: JSON.stringify(call.args),
          // **index 從 1 起跳。** 它與上面那些文字 chunk 的 content block 共用同一個
          // 編號空間，0 已經被那段文字佔走了；從 0 起跳會把文字那一塊寫壞。
          index: index + 1,
          type: 'tool_call_chunk' as const,
        })),
      }),
    } as ChatGenerationChunk;
  }
}
