/**
 * **摘要之後重新量測，仍超過門檻就再摘要**（[#2028](https://github.com/DemianLi/nexus-agent/issues/2028)）的驗收，走整棵樹。
 *
 * 對話的形狀刻意讓「保留的尾巴」本身就超過門檻：第 1 輪的回話很大，第 2 輪的使用者句很短。保留量（`retainTokens` 12）從最新往前
 * 累加，跨過的那則也留，所以第一次摘要留下的是 `[大回話, 短句]`，摘要完仍超過；換 retain 0 只留最新那則，第二次摘要之後就低於門檻。
 * 另外兩種形狀：最新那則自己就超過（少留也沒用，不重試），以及第二次摘要本身就大（重試用完仍超過）。
 *
 * 零憑證、零外部連線。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { ContextOverflowError } from '@langchain/core/errors';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { MemorySaver } from '@langchain/langgraph';
import { SessionRegistry } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';

/** 第 1 輪的使用者句：要比摘要大，第一次摘要（只取代它一則）才提交得了（#1396）。 */
const FIRST = `第一句 ${'alpha '.repeat(600)}`;
/** 撐爆門檻的那一則。 */
const BIG = `大段 ${'bravo '.repeat(8000)}`;
const TRIGGER_TOKENS = 4000;

type Call = 'main' | 'summary';

/**
 * 主呼叫（有系統訊息）照 `replies` 依序回；摘要呼叫（沒有系統訊息）照 `summaries` 依序回。`overflowAt` 是第幾次主呼叫拋端點超窗。
 */
class SizedModel extends BaseChatModel {
  constructor(
    private readonly replies: string[],
    private readonly summaries: string[],
    readonly log: Call[] = [],
    private readonly overflowAt?: number,
  ) {
    super({});
  }

  _llmType(): string {
    return 'sized';
  }

  override bindTools(): SizedModel {
    return new SizedModel(this.replies, this.summaries, this.log, this.overflowAt);
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const isSummary = messages[0]?.getType() !== 'system';
    this.log.push(isSummary ? 'summary' : 'main');
    if (!isSummary && this.log.filter((call) => call === 'main').length === this.overflowAt)
      throw new ContextOverflowError('Input exceeded the model context window.');
    const text = (isSummary ? this.summaries.shift() : this.replies.shift()) ?? '好。';
    return { generations: [{ text, message: new AIMessage(text) }], llmOutput: {} };
  }
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-remeasure-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/** 歷史檔在 checkpoint `files` 裡的鍵（同 `summary-history-staging.test.ts`）。 */
const HISTORY_FILE = /^\/session_[^/]+\.md$/;

async function converse(options: {
  readonly users: readonly string[];
  readonly replies: string[];
  readonly summaries: string[];
  readonly compactionRetries?: number;
  readonly overflowAt?: number;
}): Promise<{
  readonly calls: readonly Call[];
  readonly events: readonly SessionEvent[];
  readonly history: readonly string[];
  readonly warns: readonly string[];
}> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const model = new SizedModel(options.replies, options.summaries, [], options.overflowAt);
  const { agent, attachSession, dispose } = await createNexusAgent({
    model,
    backend: new ContainedFilesystemBackend({ rootDir: dir }),
    checkpointer: new MemorySaver(),
    plugins: [],
    summarization: {
      trigger: [{ type: 'tokens', value: TRIGGER_TOKENS }],
      retainTokens: 12,
      ...(options.compactionRetries === undefined
        ? {}
        : { compactionRetries: options.compactionRetries }),
    },
  });
  const sessions = new SessionRegistry('remeasure');
  const detach = attachSession(sessions);
  try {
    for (const text of options.users)
      await agent.invoke(toAgentInvocation(text), { configurable: { thread_id: 'remeasure' } });
    const state = await (
      agent as unknown as { getState(config: unknown): Promise<{ values: unknown }> }
    ).getState({ configurable: { thread_id: 'remeasure' } });
    const history = Object.entries(
      (state.values as { files?: Record<string, { content?: string }> }).files ?? {},
    )
      .filter(([path]) => HISTORY_FILE.test(path))
      .map(([, data]) => data.content ?? '');
    return {
      calls: [...model.log],
      events: [...sessions.root.events],
      history,
      warns: warn.mock.calls.map((call) => String(call[0])),
    };
  } finally {
    detach();
    await dispose();
  }
}

const summariesOf = (events: readonly SessionEvent[]) =>
  events.filter((event) => event.type === 'compaction/summary');
const remeasureWarns = (warns: readonly string[]) =>
  warns.filter((line) => line.includes('摘要之後仍超過門檻'));
/** `text` 在 `haystack` 裡出現幾次。 */
const occurrences = (haystack: string, text: string) => haystack.split(text).length - 1;

describe('摘要完仍超過門檻：換 retain 0 再摘一次', () => {
  it('第一次摘要後仍超過 → 再摘要；第二次後低於門檻，不 warn', async () => {
    const run = await converse({
      users: [FIRST, '短句'],
      replies: [BIG, '收到。'],
      summaries: ['摘要一。', '摘要二。'],
    });
    // 第 1 輪一次主呼叫；第 2 輪：摘要、（重量超過）retain 0 的摘要、主呼叫。
    expect(run.calls).toEqual(['main', 'summary', 'summary', 'main']);
    expect(remeasureWarns(run.warns)).toEqual([]);
  });

  it('白做的第一次摘要不留痕：日誌只有一筆 compaction/summary，歷史檔只有一段、原文不重複', async () => {
    const run = await converse({
      users: [FIRST, '短句'],
      replies: [BIG, '收到。'],
      summaries: ['摘要一。', '摘要二。'],
    });
    const logged = summariesOf(run.events);
    expect(logged).toHaveLength(1);
    // 交出去的是第二次（retain 0）的那份。
    expect(JSON.stringify(logged[0]!.data)).toContain('摘要二。');
    expect(JSON.stringify(logged[0]!.data)).not.toContain('摘要一。');
    expect(run.history).toHaveLength(1);
    expect(occurrences(run.history[0]!, '第一句')).toBe(1);
    expect(occurrences(run.history[0]!, '大段')).toBe(1);
  });

  it('第一次摘要後已經低於門檻 → 只摘要一次', async () => {
    // 大的是第 1 輪的使用者句；尾巴是 `[回話, 短句]`（回話約 20 token，跨過保留量），摘掉大段之後就低於門檻。
    const run = await converse({
      users: [BIG, '短句'],
      replies: [`回話 ${'echo '.repeat(20)}`, '收到。'],
      summaries: ['摘要一。', '摘要二。'],
    });
    expect(run.calls).toEqual(['main', 'summary', 'main']);
    expect(summariesOf(run.events)).toHaveLength(1);
    expect(remeasureWarns(run.warns)).toEqual([]);
  });
});

describe('不重試的三種情況：warn 一條、照摘要完的那份送，這一輪不失敗', () => {
  it('重試用完仍超過（第二次摘要本身就大）→ warn 一條、照送', async () => {
    const run = await converse({
      users: [FIRST, '短句'],
      replies: [BIG, '收到。'],
      summaries: ['摘要一。', `大摘要 ${'charlie '.repeat(3000)}`],
    });
    expect(run.calls).toEqual(['main', 'summary', 'summary', 'main']);
    const lines = remeasureWarns(run.warns);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('重摘過 1 次');
    expect(summariesOf(run.events)).toHaveLength(1);
  });

  it('最新那則自己就超過（retain 0 不會留得比較少）→ 不重試，也不退回基座重摘；warn 一條、照送', async () => {
    const run = await converse({
      users: [FIRST, BIG],
      replies: ['不大的回話。', '收到。'],
      summaries: ['摘要一。', '摘要二。'],
    });
    // 只摘一次：沒有 retain 0 那次，也沒有基座「整串重摘成一則」那次。
    expect(run.calls).toEqual(['main', 'summary', 'main']);
    const lines = remeasureWarns(run.warns);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('保留的尾巴已經是最小的');
    expect(summariesOf(run.events)).toHaveLength(1);
  });

  it('端點真的超窗、升級到 retain 0 之後仍超過門檻 → 不再要求重摘（那一次沒有 try 接），warn 一條、照送', async () => {
    // 第 2 輪：預算觸發的摘要之後已經低於門檻、送出去端點卻回超窗；升級到 retain 0 重摘，那份摘要本身就超過門檻。
    const run = await converse({
      users: [BIG, '短句'],
      replies: [`回話 ${'echo '.repeat(20)}`, '收到。'],
      summaries: ['摘要一。', `大摘要 ${'charlie '.repeat(3900)}`],
      overflowAt: 2,
    });
    expect(run.calls).toEqual(['main', 'summary', 'main', 'summary', 'main']);
    expect(remeasureWarns(run.warns)).toHaveLength(1);
  });

  it('compactionRetries 設成 0 → 不重試，warn 一條、照送', async () => {
    const run = await converse({
      users: [FIRST, '短句'],
      replies: [BIG, '收到。'],
      summaries: ['摘要一。', '摘要二。'],
      compactionRetries: 0,
    });
    expect(run.calls).toEqual(['main', 'summary', 'main']);
    const lines = remeasureWarns(run.warns);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('compactionRetries 是 0');
  });
});

describe('compactionRetries 只收 0 或 1', () => {
  it.each([2, -1, 0.5])('%s → 組裝當場拒收', async (value) => {
    await expect(
      createNexusAgent({
        model: new SizedModel([], []),
        backend: new ContainedFilesystemBackend({ rootDir: dir }),
        checkpointer: new MemorySaver(),
        plugins: [],
        summarization: { compactionRetries: value },
      }),
    ).rejects.toThrow(/compactionRetries.*只收 0 或 1/);
  });
});
