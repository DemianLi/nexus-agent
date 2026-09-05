/**
 * **供應商回上下文溢出時，基座那條緊急摘要的恢復路徑到底跑不跑得起來**——#150 的 go／no-go。
 *
 * 基座認的是型別化的 `ContextOverflowError`（`@langchain/core/errors`），`isContextOverflow`
 * 沿 `cause` 鏈走（`dist/langsmith-zm0ILQsV.js:3126`）。**問題在於錯誤到得了那裡嗎**：
 * 模型拋出來的東西會先經過 `MiddlewareError.wrap`，包完之後我們那顆還在不在鏈上，沒有人量過。
 * 這一格是紅的話，#150 就不是「補一個 matcher」而是另一個形狀的問題。
 *
 * **不打真端點**：這裡要驗的是**我們這棵樹**認不認得那個型別，不是供應商回什麼字——後者由
 * `live-model.test.ts` 那側負責。而且今天的 `LIVE_MODEL_ID` **根本逼不出上下文溢出**
 * （2026-09-04 量到 700,045 token 仍然 `200`，見 `live-model.ts` 的檔頭），所以就算想打
 * 真端點也驗不到這一條。
 */

import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextOverflowError } from '@langchain/core/errors';
import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import type { ChatResult } from '@langchain/core/outputs';
import { MemorySaver } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';

interface ThrowingState {
  calls: number;
}

/**
 * 第 `throwOnCall` 次呼叫時拋 `error`，其餘照常回話。
 *
 * 自己寫一顆而不是擴充 `ScriptedChatModel`，是因為那顆的腳本語義是「回什麼」，
 * 而這裡要的是「拋什麼」——混進去會讓那份腳本多一個只有這個檔在用的概念。
 */
class ThrowingChatModel extends BaseChatModel {
  private readonly error: unknown;
  private readonly throwOnCall: number;
  private readonly state: ThrowingState;

  constructor(
    options: BaseChatModelParams & {
      error: unknown;
      throwOnCall: number;
      state?: ThrowingState;
    },
  ) {
    const { error, throwOnCall, state, ...rest } = options;
    super(rest);
    this.error = error;
    this.throwOnCall = throwOnCall;
    this.state = state ?? { calls: 0 };
  }

  get calls(): number {
    return this.state.calls;
  }

  _llmType(): string {
    return 'throwing';
  }

  override bindTools(): ThrowingChatModel {
    return new ThrowingChatModel({
      error: this.error,
      throwOnCall: this.throwOnCall,
      state: this.state,
    });
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    this.state.calls += 1;
    if (this.state.calls === this.throwOnCall) throw this.error;
    const message = new AIMessage(`第 ${this.state.calls} 次回話。`);
    return { generations: [{ text: message.text, message }], llmOutput: {} };
  }
}

/**
 * 跑到第 `throwOnCall` 次呼叫，看那次拋出去之後整場活不活得下來。
 *
 * `trigger` 刻意設到高不可攀：這一格要走的是**壓力沒到、直接撞窗口**那條分支
 * （`:3220-3231`），不是正常的壓力壓縮。`keep` 要小，否則 `performSummarization` 算出
 * `cutoffIndex <= 0`，基座直接把同一個請求再送一次、當場再拋一次——那會讓恢復看起來
 * 失敗，而原因其實是設定。
 */
async function runUntilThrow(
  error: unknown,
  throwOnCall: number,
  invocations: number,
): Promise<{ rejected: unknown; calls: number; historyFiles: string[] }> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-overflow-'));
  const model = new ThrowingChatModel({ error, throwOnCall });
  const { agent, dispose } = await createNexusAgent({
    model,
    backend: new ContainedFilesystemBackend({ rootDir: root }),
    checkpointer: new MemorySaver(),
    plugins: [],
    summarization: {
      trigger: [{ type: 'tokens', value: 1_000_000 }],
      keep: { type: 'messages', value: 2 },
    },
  });
  let rejected: unknown = null;
  try {
    for (let index = 0; index < invocations; index += 1) {
      await agent.invoke(toAgentInvocation(`第 ${index + 1} 句。`), {
        configurable: { thread_id: 'overflow' },
      });
    }
  } catch (caught) {
    rejected = caught;
  } finally {
    await dispose();
  }
  let historyFiles: string[] = [];
  try {
    historyFiles = await readdir(join(root, 'conversation_history'));
  } catch {
    historyFiles = [];
  }
  return { rejected, calls: model.calls, historyFiles };
}

describe('供應商回上下文溢出', () => {
  /**
   * **go／no-go。** 第 4 次呼叫拋 `ContextOverflowError`：前三次各自留下一問一答，
   * 所以第 4 次進來時訊息串夠長，`keep: 2 則` 算得出正的切點。
   *
   * 這條綠 ＝ 錯誤真的沿著 `cause` 鏈到得了 `isContextOverflow`，基座的緊急摘要接住了它。
   */
  it('拋 ContextOverflowError → 整場活下來，而且真的摘要了一次', async () => {
    const { rejected, calls, historyFiles } = await runUntilThrow(
      new ContextOverflowError('Input exceeded the model context window.'),
      4,
      4,
    );

    expect(rejected).toBeNull();
    // 第 4 次拋掉，恢復又叫了至少一次（產摘要）＋ 重試那一次。
    expect(calls).toBeGreaterThan(4);
    // 摘要真的落了地——「活下來」若是靠別的路徑，這裡會是空的。
    expect(historyFiles.length).toBeGreaterThan(0);
  });

  /**
   * **對照組：認錯型別就不該接。** 普通的 `Error` 一路往外拋，整場倒。
   *
   * 沒有這一條的話，一個「什麼錯都吞掉」的實作在上面那條是綠的——而那種實作會把
   * 真正的 bug 變成一次無聲的重試。
   */
  it('拋普通 Error → 照樣殺掉整場', async () => {
    const { rejected } = await runUntilThrow(new Error('別的毛病'), 4, 4);

    expect(rejected).not.toBeNull();
    expect(String(rejected)).toContain('別的毛病');
  });

  /**
   * **`cause` 鏈是真的在走，不是只認最外層那顆。**
   *
   * 這一條釘住 `isContextOverflow` 的 `for(;;)` 迴圈：把 `ContextOverflowError` 埋在
   * 一個普通 `Error` 的 `cause` 底下，基座照樣要認得。它同時是我們之後要做的
   * brand-and-rethrow 的前提——那一層包出來的東西正是這個形狀。
   */
  it('埋在 cause 底下的 ContextOverflowError 照樣認得', async () => {
    const buried = new Error('400 Bad Request', {
      cause: new ContextOverflowError('Input exceeded the model context window.'),
    });
    const { rejected, historyFiles } = await runUntilThrow(buried, 4, 4);

    expect(rejected).toBeNull();
    expect(historyFiles.length).toBeGreaterThan(0);
  });
});
