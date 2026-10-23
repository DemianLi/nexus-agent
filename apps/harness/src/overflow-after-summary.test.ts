/**
 * **第一次已經摘要過、送出去端點還是回超窗：三處的樣子**（[#1381](https://github.com/DemianLi/nexus-agent/issues/1381)
 * PM 要求量清楚的邊界；歷史檔那一格在 [#1389](https://github.com/DemianLi/nexus-agent/issues/1389) 翻面）。
 *
 * 情境：訊息數門檻先到，基座用 N 則的保留量摘要一次（attempt 1），摘要之後的請求送出去，**端點回超窗**；
 * 分派器換上 retain 0 的實例，**從同一份 graph state 重新摘要**（attempt 2），再送一次。
 *
 * 走的是產品路徑（`ThreadPump` 管日誌，使用者訊息也進日誌），這樣日誌推導才有東西可比。
 *
 * | 項目 | 量到的 |
 * | --- | --- |
 * | 日誌 | 兩筆 `compaction/summary` 都在（attempt 1 的先記在它那次 `model/start` 之前，那次超窗了）。**每一次主呼叫，從日誌推出的歷史都等於實際送出的**，包括升級之後那一次 |
 * | graph state | `_summarizationEvent` 是 attempt 2 的（切點 2），不是 attempt 1 的（切點 1）；訊息串沒有被動到 |
 * | 歷史檔 | **一個區段**：attempt 2 卸載的（含 attempt 1 那一則）。attempt 1 的寫入在同一步內被 attempt 2 取代，第 1 句只出現一次 |
 *
 * ## 歷史檔那一格的前後
 *
 * #1389 之前是兩個區段、第 1 句出現兩次。原因在基座：摘要之後的 handler 超窗它會再接一次、再摘要一次，而 attempt 1 的
 * 卸載已經寫進檔了（dsh 沒有這個形狀：壓縮是不寫檔的交易）。現在摘要器的 backend 換成暫存層
 * （`packages/nexus-core/src/summary-history-staging.ts`）：同一步內同一個路徑最後一次寫入勝出，這一步結束時才寫。
 * 兩個 attempt 都讀「已提交的」內容，所以第二個區段不含第一個的。
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextOverflowError } from '@langchain/core/errors';
import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatResult } from '@langchain/core/outputs';
import { MemorySaver } from '@langchain/langgraph';
import { replayConversation } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toolResultAsSeen } from './conversation-restore.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

/**
 * 裸 agent 沒有系統提示詞。以前模型那一側的第一則 system 是觀察政策的 `wrapModelCall` 追加的（#1563 起規則改寫進工具描述、不再追加），
 * 這份測試用「第一則是不是 system」分辨主呼叫與摘要呼叫，所以自己給一則。
 */
const TEST_SYSTEM_PROMPT = '你是測試用的助理。';

/** 記下每次收到的訊息，第 `overflowOn` 次呼叫回真的 `ContextOverflowError`。 */
class RecordingModel extends BaseChatModel {
  constructor(
    private readonly shared: { calls: number; seen: string[][] },
    private readonly overflowOn: number,
  ) {
    super({});
  }

  _llmType(): string {
    return 'recording';
  }

  override bindTools(): RecordingModel {
    return new RecordingModel(this.shared, this.overflowOn);
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.shared.calls += 1;
    this.shared.seen.push(
      messages.map((message) => `${message.getType()}:${String(message.content)}`),
    );
    if (this.shared.calls === this.overflowOn)
      throw new ContextOverflowError('Input exceeded the model context window.');
    const isSummary = messages[0]?.getType() !== 'system';
    const message = new AIMessage(isSummary ? '摘要。' : `第 ${this.shared.calls} 次回話。${PAD}`);
    return { generations: [{ text: message.text, message }], llmOutput: {} };
  }
}

/**
 * 墊料：框好的摘要要比被取代那段小才會提交（#1396）。被取代的那段是第 1 句，所以那一句要比摘要框架大；
 * 摘要呼叫（沒有系統訊息的那種）反過來回短字串，不然摘要本身就比被取代的大。
 */
const PAD = '內容'.repeat(80);
/** 使用者那句墊得更長：第一次摘要取代的就是它一則，要比「框架＋歷史檔路徑」大得多。 */
const USER_PAD = '內容'.repeat(200);

const SECTION = /## Summarized at [^\n]+\n\n/;

async function converse(overflowOn: number) {
  const root = await mkdtemp(join(tmpdir(), 'nexus-after-summary-'));
  const shared = { calls: 0, seen: [] as string[][] };
  const built = await createNexusAgent({
    systemPrompt: TEST_SYSTEM_PROMPT,
    model: new RecordingModel(shared, overflowOn),
    backend: new ContainedFilesystemBackend({ rootDir: root }),
    checkpointer: new MemorySaver(),
    plugins: [],
    // 第 2 輪進來是 3 則，到了訊息數門檻；使用者句約 210 token、回話約 90 token，保留量 250 token 在這份對話上算出 N = 2。
    summarization: { trigger: [{ type: 'messages', value: 3 }], retainTokens: 250 },
  });
  const pump = new ThreadPump(
    built.agent as unknown as PumpAgent,
    'after-summary',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    built.stepInbox,
  );
  const detach = built.attachSession(pump.sessions);
  type Snapshot = { cutoff: number | undefined; messages: number; history: string | undefined };
  const afterTurn: Snapshot[] = [];
  try {
    for (let turn = 1; turn <= 2; turn += 1) {
      await pump.submit({ kind: 'message', text: `第 ${turn} 句。${USER_PAD}`, id: `m${turn}` });
      await pump.whenIdle();
      const state = await (
        built.agent as unknown as {
          getState(config: unknown): Promise<{ values: unknown }>;
        }
      ).getState({ configurable: { thread_id: 'after-summary' } });
      const values = state.values as {
        messages: BaseMessage[];
        files?: Record<string, { content?: string }>;
        _summarizationEvent?: { cutoffIndex: number };
      };
      afterTurn.push({
        cutoff: values._summarizationEvent?.cutoffIndex,
        messages: values.messages.length,
        history: Object.values(values.files ?? {})[0]?.content,
      });
    }
    return { events: [...pump.sessionLog.events], shared, afterTurn };
  } finally {
    pump.close();
    detach();
    await built.dispose();
  }
}

describe('第一次已經摘要過、送出去端點還是回超窗', () => {
  // 第 1 輪：呼叫 1。第 2 輪：呼叫 2 是摘要、呼叫 3 是摘要之後的請求——在這裡超窗；
  // 升級之後呼叫 4 是 retain 0 的摘要、呼叫 5 是重送。
  it('日誌兩筆都在、推導與實送逐呼叫相等；state 是第二次的切點；歷史檔一個區段', async () => {
    const { events, shared, afterTurn } = await converse(3);

    // 前提：真的走到了升級（第 4 次呼叫是摘要，第 5 次是重送）。
    expect(shared.calls).toBe(5);

    // 1. 日誌
    const summaries = events.filter((event) => event.type === 'compaction/summary');
    expect(summaries.map((event) => (event.data as { cutoffIndex: number }).cutoffIndex)).toEqual([
      1, 2,
    ]);
    const mains = shared.seen
      .map((messages, index) => ({ call: index + 1, messages }))
      .filter((entry) => entry.messages[0]?.startsWith('system:'));
    const starts = events.filter((event) => event.type === 'model/start');
    expect(starts).toHaveLength(mains.length);
    for (const [index, start] of starts.entries()) {
      const replay = replayConversation(
        events.filter((event) => event.seq < start.seq),
        { toolResultAsSeen, applyPrunes: true, applyArgTruncations: true },
      );
      expect(replay.kind).toBe('replayed');
      if (replay.kind !== 'replayed') continue;
      const derived = replay.messages.map(
        (message) => `${message.getType()}:${String(message.content)}`,
      );
      // 去掉系統訊息：日誌上的 `request/system` 另外比，這裡比的是對話。
      expect(derived, `第 ${String(mains[index]!.call)} 次呼叫`).toEqual(
        mains[index]!.messages.slice(1),
      );
    }

    // 2. graph state：第二輪結束時是 attempt 2 的切點，不是 attempt 1 的；訊息串長度就是兩輪四則。
    expect(afterTurn[1]).toMatchObject({ cutoff: 2, messages: 4 });

    // 3. 歷史檔：一個區段（attempt 2 的），第 1 句只出現一次（見檔頭，#1389）。
    const sections = afterTurn[1]!.history!.split(SECTION).filter((text) => text.trim() !== '');
    expect(sections.map((text) => text.trim())).toEqual([
      `Human: 第 1 句。${USER_PAD}\nAI: model, 第 1 次回話。${PAD}`,
    ]);
  });

  it('對照：沒有超窗時只有一筆摘要事件、歷史檔一個區段', async () => {
    const { events, afterTurn } = await converse(0);

    const summaries = events.filter((event) => event.type === 'compaction/summary');
    expect(summaries.map((event) => (event.data as { cutoffIndex: number }).cutoffIndex)).toEqual([
      1,
    ]);
    expect(afterTurn[1]).toMatchObject({ cutoff: 1, messages: 4 });
    const sections = afterTurn[1]!.history!.split(SECTION).filter((text) => text.trim() !== '');
    expect(sections.map((text) => text.trim())).toEqual([`Human: 第 1 句。${USER_PAD}`]);
  });
});
