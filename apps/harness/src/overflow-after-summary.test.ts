/**
 * **第一次已經摘要過、送出去端點還是回超窗：三處的樣子**（[#1381](https://github.com/DemianLi/nexus-agent/issues/1381)
 * PM 要求量清楚的邊界）。
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
 * | 歷史檔 | 兩個區段：attempt 1 卸載的、attempt 2 卸載的。**第 1 句出現兩次**——與基座既有行為同形（見下） |
 *
 * ## 歷史檔重複不是 #1381 引進的
 *
 * 在沒有 #1381 的 develop 上跑同一個情境：日誌同樣兩筆 `compaction/summary`（切點 1、3）、歷史檔同樣兩個區段
 * （第 1 句出現兩次，第二段多了第 2 句）、推導與實送同樣逐呼叫相等。原因在基座：摘要之後的 handler 超窗它會再接一次、
 * 再摘要一次，而 attempt 1 的卸載已經寫進檔了。dsh 沒有這個形狀：它的壓縮是 `compactRegion` 的交易（`compaction/start`
 * ～`end`）、不寫任何檔案，overflow 時對**已經提交的** surface 重新 `selectCompactableRange(..., 0)`。
 * 我們這邊 attempt 1 的摘要沒有提交進 state（請求失敗了），只留下檔案區段與日誌事件這兩個副作用，所以不是同一種東西。
 *
 * 這一條把量到的釘住，是為了讓日後有人動到這裡時看得出「這一格不是新壞的」。要不要消除重複是另一個決定。
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
    const message = new AIMessage(`第 ${this.shared.calls} 次回話。`);
    return { generations: [{ text: message.text, message }], llmOutput: {} };
  }
}

const SECTION = /## Summarized at [^\n]+\n\n/;

async function converse(overflowOn: number) {
  const root = await mkdtemp(join(tmpdir(), 'nexus-after-summary-'));
  const shared = { calls: 0, seen: [] as string[][] };
  const built = await createNexusAgent({
    model: new RecordingModel(shared, overflowOn),
    backend: new ContainedFilesystemBackend({ rootDir: root }),
    checkpointer: new MemorySaver(),
    plugins: [],
    // 第 2 輪進來是 3 則，到了訊息數門檻；保留量 12 token 在這份對話上算出 N = 2。
    summarization: { trigger: [{ type: 'messages', value: 3 }], retainTokens: 12 },
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
      await pump.submit({ kind: 'message', text: `第 ${turn} 句。`, id: `m${turn}` });
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
  it('日誌兩筆都在、推導與實送逐呼叫相等；state 是第二次的切點；歷史檔兩個區段', async () => {
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

    // 3. 歷史檔：兩個區段，第 1 句出現兩次（與沒有 #1381 的基座同形，見檔頭）。
    const sections = afterTurn[1]!.history!.split(SECTION).filter((text) => text.trim() !== '');
    expect(sections.map((text) => text.trim())).toEqual([
      'Human: 第 1 句。',
      'Human: 第 1 句。\nAI: model, 第 1 次回話。',
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
    expect(sections.map((text) => text.trim())).toEqual(['Human: 第 1 句。']);
  });
});
