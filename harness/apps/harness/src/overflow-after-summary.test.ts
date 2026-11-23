/**
 * **第一次已經摘要過、送出去端點還是回超窗：三處的樣子**（[#1381](https://github.com/DemianLi/nexus-agent/issues/1381)
 * 量清楚的邊界；讀回那一格見 [#1389](https://github.com/DemianLi/nexus-agent/issues/1389)、
 * [#2777](https://github.com/DemianLi/nexus-agent/issues/2777)）。
 *
 * 情境：訊息數門檻先到，基座用 N 則的保留量摘要一次（attempt 1），摘要之後的請求送出去，**端點回超窗**；
 * 分派器換上 retain 0 的實例，**從同一份 graph state 重新摘要**（attempt 2），再送一次。
 *
 * 走的是產品路徑（`ThreadPump` 管日誌，使用者訊息也進日誌），這樣日誌推導才有東西可比。
 *
 * | 項目 | 量到的 |
 * | --- | --- |
 * | 日誌 | 兩筆 `compaction/summary` 都在（attempt 1 的先記在它那次 `model/start` 之前，那次超窗了）。**每一次主呼叫，從日誌推出的歷史都等於實際送出的**，包括升級之後那一次 |
 * | graph state | 訊息串沒有被動到（切點在組裝的切點表，同一步裡落定的是最後一次：單元見 `harness/packages/nexus-core/src/summary-cutoffs.test.ts`「同一步 note 兩次」，整合見 `summary-shrink.test.ts`「不打摘要模型、不提交」那條） |
 * | 讀回的原文 | 沒有歷史檔（兩筆的 `filePath` 都是 `null`，`files` 是空的）。從日誌讀回**一段**：attempt 2 卸下的（含 attempt 1 那一則）。兩筆帶同一個條目序號，後面那筆取代前面那筆，第 1 句只出現一次 |
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
import { recallHistory, replayConversation } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toolResultAsSeen } from './conversation-restore.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

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
/** 使用者那句墊得更長：第一次摘要取代的就是它一則，要比框好的摘要大得多。 */
const USER_PAD = '內容'.repeat(200);

async function converse(overflowOn: number) {
  const root = await mkdtemp(join(tmpdir(), 'nexus-after-summary-'));
  const shared = { calls: 0, seen: [] as string[][] };
  const built = await createNexusAgent({
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
  type Snapshot = { messages: number; files: string[] };
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
        files?: Record<string, unknown>;
      };
      afterTurn.push({
        messages: values.messages.length,
        files: Object.keys(values.files ?? {}),
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
  // 第 1 輪：呼叫 1。第 2 輪：呼叫 2、3 是摘要（索引條目、現況），呼叫 4 是摘要之後的請求——在這裡超窗；
  // 升級之後呼叫 5、6 是 retain 0 的摘要，呼叫 7 是重送。
  it('日誌兩筆都在、推導與實送逐呼叫相等；state 的訊息串沒動；沒有歷史檔，日誌讀回一段', async () => {
    const { events, shared, afterTurn } = await converse(4);

    // 前提：真的走到了升級（第 5、6 次呼叫是摘要，第 7 次是重送）。
    expect(shared.calls).toBe(7);

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

    // 2. graph state：訊息串長度就是兩輪四則。
    expect(afterTurn[1]).toMatchObject({ messages: 4 });

    // 3. 讀回的原文：沒有歷史檔；日誌讀回一段（attempt 2 的），第 1 句只出現一次（見檔頭）。
    expect(summaries.map((event) => (event.data as { filePath: string | null }).filePath)).toEqual([
      null,
      null,
    ]);
    expect(afterTurn.map((snapshot) => snapshot.files)).toEqual([[], []]);
    const recalled = recallHistory(events);
    expect(recalled.failure).toBeUndefined();
    expect(recalled.segments.map((segment) => segment.text)).toEqual([
      `User: 第 1 句。${USER_PAD}\n\nAssistant: 第 1 次回話。${PAD}`,
    ]);
  });

  it('對照：沒有超窗時只有一筆摘要事件、日誌讀回一段', async () => {
    const { events, afterTurn } = await converse(0);

    const summaries = events.filter((event) => event.type === 'compaction/summary');
    expect(summaries.map((event) => (event.data as { cutoffIndex: number }).cutoffIndex)).toEqual([
      1,
    ]);
    expect(summaries.map((event) => (event.data as { filePath: string | null }).filePath)).toEqual([
      null,
    ]);
    expect(afterTurn[1]).toMatchObject({ messages: 4, files: [] });
    const recalled = recallHistory(events);
    expect(recalled.failure).toBeUndefined();
    expect(recalled.segments.map((segment) => segment.text)).toEqual([
      `User: 第 1 句。${USER_PAD}`,
    ]);
  });
});
