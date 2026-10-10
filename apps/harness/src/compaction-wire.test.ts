/**
 * **壓縮過這件事，即時看得到，重新整理之後也一樣**——[#896](https://github.com/DemianLi/nexus-agent/issues/896)
 * 的 harness 那一半。
 *
 * 真的圖、真的 pump、真的摘要器（`createNexusAgent` 的 `summarization`），模型是腳本；門檻調小讓它在幾輪內壓縮。
 * 每個檢查點都比兩條路：即時的 frame 與歷史路由各折一次，壓縮那一格要相等。規則：
 *
 * 1. root 日誌每記一顆 `compaction/summary` 就長一格，位置在用到它的那次呼叫的回覆**之前**（日誌就是這個順序，格式 45；
 *    以前在回覆之後，#1301）。
 * 2. `cutoff` 是日誌的 `cutoffIndex`；`saved` 看 `filePath` 是不是 `null`。
 * 3. 摘要全文已拿掉面向模型的外框，套工具結果文字的位元組上限。
 * 4. 子代理自己的壓縮不進來。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。摘要器自己也從腳本拿輪，所以腳本要多備。
 */

import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry, SessionEvent } from '@nexus/core';
import type { CompactionEntry, Event } from '@nexus/wire';
import { COMPACTION, emptyConversation, reduceAll } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { compactionData, historyFrames, historyPage } from './conversation-history.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { toolTextConfigSchema } from './settings/tool-text.js';
import { DEFAULT_TOOL_TEXT_MAX_BYTES } from './settings/tool-text.js';
import type { PumpAgent } from './thread-pump.js';
import { ThreadPump } from './thread-pump.js';

/** 每則約 100 token。 */
const BODY = '這是一段普通長度的回話。'.repeat(32);
/** subagent 那條用的大回話，每則約 600 token。 */
const BIG_BODY = '這是一段普通長度的回話。'.repeat(200);

const settle = () => new Promise((resolve) => setImmediate(resolve));

const withWorker: PluginEntry = {
  plugin: {
    name: 'compaction-wire-worker',
    apply(registry) {
      registry.subagents.register({ name: 'worker', description: '幹活的。' });
    },
  },
};

const SUMMARIZATION = {
  trigger: [{ type: 'tokens' as const, value: 3_000 }],
  keep: { type: 'messages' as const, value: 2 },
};

interface Ran {
  readonly frames: Event[];
  readonly events: readonly SessionEvent[];
  readonly subagentLogs: readonly (readonly SessionEvent[])[];
}

/** 跑一場會壓縮的對話：每句話一輪，下行一路抽進 `frames`。 */
async function run(
  turns: readonly ScriptedTurn[],
  options: {
    messages: number;
    plugins?: readonly PluginEntry[];
    toolTextMaxBytes?: number;
  },
): Promise<Ran> {
  const model = new ScriptedChatModel({ turns });
  const built = await createNexusAgent({
    model: model as never,
    checkpointer: new MemorySaver(),
    plugins: [...(options.plugins ?? [])],
    summarization: SUMMARIZATION,
  });
  const toolText =
    options.toolTextMaxBytes === undefined
      ? undefined
      : toolTextConfigSchema.parse({ maxBytes: options.toolTextMaxBytes });
  const pump = new ThreadPump(
    built.agent as unknown as PumpAgent,
    'compaction-wire',
    undefined,
    undefined,
    toolText,
  );
  const detach = built.attachSession(pump.sessions);
  const frames: Event[] = [];
  const line = new AbortController();
  const stream = pump.subscribe(['messages', 'tools', 'lifecycle', 'custom'], line.signal);
  const draining = (async () => {
    for await (const frame of stream) frames.push(frame);
  })();
  try {
    for (let index = 0; index < options.messages; index += 1) {
      await pump.submit({ kind: 'message', text: `第 ${index + 1} 句。` });
      await settle();
    }
    return {
      frames,
      events: [...pump.sessionLog.events],
      subagentLogs: pump.sessions
        .list()
        .filter((entry) => entry.address.kind === 'subagent')
        .map((entry) => [...entry.log.events]),
    };
  } finally {
    line.abort();
    await draining;
    detach();
    await built.dispose();
  }
}

const chatter = (count = 60): ScriptedTurn[] =>
  Array.from({ length: count }, () => ({ content: BODY }));

const entriesOf = (frames: readonly Event[]) => reduceAll(emptyConversation(), frames).entries;
const compactionsOf = (frames: readonly Event[]): CompactionEntry[] =>
  entriesOf(frames).filter((entry): entry is CompactionEntry => entry.kind === 'compaction');
const kindsOf = (frames: readonly Event[]) => entriesOf(frames).map((entry) => entry.kind);
/**
 * 拿掉時刻再比：兩條路的時鐘不同（#1030），即時是 pump 合成那一刻、歷史是日誌那一筆，同一格可以差一毫秒。
 * 時刻本身由 `wire-entry-timestamps.test.ts` 量。
 */
const untimed = (entries: readonly CompactionEntry[]) =>
  entries.map(({ startedAt: _startedAt, ...rest }) => rest);

describe('壓縮過這件事在即時與重新整理之後都一樣', () => {
  it('每一次壓縮長一格，兩條路的內容與順序相同；位置在用到它的回覆之前', async () => {
    const { frames, events } = await run(chatter(), { messages: 14 });
    const logged = events.filter((event) => event.type === 'compaction/summary');
    // 前提：真的壓縮過不止一次，下面的「相同」才有東西可比。
    expect(logged.length).toBeGreaterThan(1);

    const live = compactionsOf(frames);
    const refreshed = compactionsOf(historyPage(events).events);
    expect(live).toHaveLength(logged.length);
    expect(untimed(refreshed)).toEqual(untimed(live));
    expect(live.map((entry) => entry.seq)).toEqual(logged.map((event) => event.seq));
    expect(live.map((entry) => entry.cutoff)).toEqual(
      logged.map((event) => (event.data as { cutoffIndex: number }).cutoffIndex),
    );
    // 被壓掉的原文寫成檔了。
    expect(live.every((entry) => entry.saved)).toBe(true);

    // 順序：兩條路長出同一串，而且每一格壓縮的下一格是 AI 的回覆（那則回覆是看著壓縮後的串寫的）。
    const liveKinds = kindsOf(frames);
    expect(kindsOf(historyPage(events).events)).toEqual(liveKinds);
    liveKinds.forEach((kind, index) => {
      if (kind === 'compaction') expect(liveKinds[index + 1]).toBe('ai');
    });
  }, 60000);

  it('摘要全文拿掉了面向模型的外框，只剩正文', async () => {
    const { frames } = await run(chatter(), { messages: 14 });
    const summaries = compactionsOf(frames).map((entry) => entry.summary);
    expect(summaries.length).toBeGreaterThan(0);
    for (const summary of summaries) {
      // 外框是基座寫的：它換了形狀的話，這條會紅，而不是畫面上悄悄多一段英文。
      expect(summary).toBeDefined();
      expect(summary).not.toContain('You are in the middle');
      expect(summary).not.toContain('<summary>');
      expect(summary).toContain('這是一段普通長度的回話。');
    }
  }, 60000);

  it('摘要全文套工具結果文字的上限，兩條路截得一樣', async () => {
    const maxBytes = 200;
    const { frames, events } = await run(chatter(), { messages: 14, toolTextMaxBytes: maxBytes });
    const live = compactionsOf(frames);
    expect(live.length).toBeGreaterThan(0);
    const toolText = toolTextConfigSchema.parse({ maxBytes });
    const refreshed = compactionsOf(historyPage(events, {}, undefined, undefined, toolText).events);
    expect(untimed(refreshed)).toEqual(untimed(live));
    for (const entry of live) {
      expect(Buffer.byteLength(entry.summary ?? '', 'utf8')).toBeLessThanOrEqual(maxBytes);
      // 對照：沒套上限時比這個長，不然「截得一樣」是兩邊都沒截。
      expect(entry.summary).toContain('位元組沒有送出來');
    }
  }, 60000);

  it('子代理自己的壓縮不進來', async () => {
    const { frames, events, subagentLogs } = await run(
      [
        {
          content: '委派。',
          toolCalls: [{ name: 'task', args: { description: '幹活', subagent_type: 'worker' } }],
        },
        ...Array.from({ length: 10 }, () => ({
          content: BIG_BODY,
          toolCalls: [{ name: 'ls', args: {} }],
        })),
        ...Array.from({ length: 8 }, () => ({ content: '收工。' })),
      ],
      { messages: 1, plugins: [withWorker] },
    );
    // 前提：壓力長在子代理身上，它真的壓縮過，root 自己沒有。
    expect(
      subagentLogs.some((log) => log.some((event) => event.type === 'compaction/summary')),
    ).toBe(true);
    expect(events.some((event) => event.type === 'compaction/summary')).toBe(false);
    expect(compactionsOf(frames)).toEqual([]);
    expect(compactionsOf(historyPage(events).events)).toEqual([]);
  }, 60000);
});

describe('compactionData', () => {
  const at = (
    data: Partial<{
      cutoffIndex: number;
      messagesBefore: number;
      filePath: string | null;
      summary: unknown;
    }>,
  ) =>
    ({
      seq: 7,
      data: { cutoffIndex: 3, messagesBefore: 5, filePath: '/f.md', ...data },
    }) as never;
  const human = (content: string) => ({ type: 'human', data: { content } });

  it('沒有外框標記就整段原樣給；有標記取最後一個結尾標記之前', () => {
    expect(
      compactionData(at({ summary: human('只有正文') }), DEFAULT_TOOL_TEXT_MAX_BYTES).payload,
    ).toMatchObject({ summary: '只有正文' });
    expect(
      compactionData(
        at({ summary: human('外框\n<summary>\n甲 </summary> 乙\n</summary>') }),
        DEFAULT_TOOL_TEXT_MAX_BYTES,
      ).payload,
    ).toMatchObject({ summary: '甲 </summary> 乙' });
  });

  it('舊日誌沒有摘要本文、檔沒寫成功：不放 summary，saved 為 false', () => {
    const { name, payload } = compactionData(at({ filePath: null }), DEFAULT_TOOL_TEXT_MAX_BYTES);
    expect(name).toBe(COMPACTION);
    expect(payload).toEqual({ seq: 7, cutoff: 3, saved: false });
  });

  it('歷史那一側：逐顆轉，沒有壓縮就沒有這一格', () => {
    const frames = historyFrames([], DEFAULT_TOOL_TEXT_MAX_BYTES);
    expect(compactionsOf(frames)).toEqual([]);
  });
});
