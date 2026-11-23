/**
 * native 迴圈、歷史從日誌推（出廠預設的組合）時，生摘要那一段排在 `model/start` 之前
 * （[#2813](https://github.com/DemianLi/nexus-agent/issues/2813)）。
 *
 * token-meter 的殘差會扣掉生摘要的耗時（`summaryMs`）。生摘要若落在某一對 `model/start`／`model/end` 中間，同一段牆鐘會被
 * `modelMs` 與 `summaryMs` 各扣一次。這個組合下 `historyFromLog` 會預先寫 `model/start`，所以另外釘一條：
 * `compaction-log.test.ts` 的同名斷言在 `vitest.native.config.ts` 下跑的是 native 配 `state`（見 `native-loop.setup.ts`）。
 *
 * 迴圈與歷史來源都明著給，兩份 vitest 設定下跑的是同一個組合。
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatGenerationChunk, ChatResult } from '@langchain/core/outputs';
import { MemorySaver } from '@langchain/langgraph';
import { SessionRegistry } from '@nexus/core';
import type { SessionEvent, SessionEventMap } from '@nexus/core';
import { applyTokenMeter, initialTokenMeter, viewTokenMeter } from '@nexus/plugin-token-meter';
import { describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { runRepl } from './cli.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedModelState, ScriptedTurn } from './scripted-model.js';
import { isSummaryCallPrompt } from './summary-call.fixture.js';

type CompactionSummary = SessionEventMap['compaction/summary'];

/**
 * 生摘要那一次呼叫刻意慢這麼久。耗時是 0 的話，被扣兩次也還是 0，殘差那條什麼都量不到。
 */
const SUMMARY_DELAY_MS = 40;

/** 使用者每一句的墊料與模型每一輪的回話，大小同 `compaction-log.test.ts`：幾句就頂過 3,000 token 的門檻。 */
const USER_PAD = '內容'.repeat(100);
/** 第一行加「- 」的兩三行是合格的索引條目，所以條目那次不重叫，每次摘要恰好兩次呼叫（條目、現況）。 */
const BODY_LINE = `- ${'這是一段普通長度的回話。'.repeat(10)}`;
const BODY = ['本段對話', BODY_LINE, BODY_LINE, BODY_LINE].join('\n');

/**
 * 照腳本回答，但生摘要那一次先等 {@link SUMMARY_DELAY_MS}。生摘要那一次由 {@link isSummaryCallPrompt} 認。
 */
class SlowSummaryModel extends ScriptedChatModel {
  private readonly script: {
    readonly turns: readonly ScriptedTurn[];
    readonly shared: ScriptedModelState;
  };

  constructor(script: {
    readonly turns: readonly ScriptedTurn[];
    readonly shared: ScriptedModelState;
  }) {
    super(script);
    this.script = script;
  }

  override bindTools(tools: readonly unknown[]): SlowSummaryModel {
    super.bindTools(tools);
    return new SlowSummaryModel(this.script);
  }

  override async _generate(
    messages: BaseMessage[],
    options?: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    if (isSummaryCallPrompt(messages)) await sleep(SUMMARY_DELAY_MS);
    return super._generate(messages, options);
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options?: this['ParsedCallOptions'],
  ): AsyncGenerator<ChatGenerationChunk> {
    if (isSummaryCallPrompt(messages)) await sleep(SUMMARY_DELAY_MS);
    yield* super._streamResponseChunks(messages, options);
  }
}

/** 跑一場會摘要好幾次的對話，每一行是一輪；回傳 root 那份日誌。 */
async function runTurns(lines: number): Promise<readonly SessionEvent[]> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-native-log-summary-'));
  const model = new SlowSummaryModel({
    // 生摘要也從同一份腳本拿，所以多備。
    turns: Array.from({ length: lines * 3 }, () => ({ content: BODY })),
    shared: { turn: 0, boundToolNames: [], lastPrompt: [], prompts: [] },
  });
  const { agent, commands, attachSession, dispose } = await createNexusAgent({
    model,
    backend: new ContainedFilesystemBackend({ rootDir: root }),
    checkpointer: new MemorySaver(),
    agentLoop: 'native',
    historySource: 'log',
    plugins: [],
    summarization: { trigger: [{ type: 'tokens', value: 3_000 }], retainTokens: 12 },
  });
  const sessions = new SessionRegistry('native-log-summary');
  const detach = attachSession(sessions);
  const input = new PassThrough();
  input.end(
    Array.from({ length: lines }, (_, index) => `第 ${index + 1} 句。${USER_PAD}\n`).join(''),
  );
  const errors: string[] = [];
  try {
    await runRepl(
      agent,
      { input, output: new PassThrough() },
      { log: () => {}, error: (message: string) => void errors.push(String(message)) },
      sessions.root,
      commands,
      undefined,
      undefined,
      undefined,
      undefined,
      'native',
    );
  } finally {
    detach();
    await dispose();
  }
  expect(errors).toEqual([]);
  return [...sessions.root.events];
}

describe('native 從日誌推歷史時，生摘要排在 model/start 之前（#2813）', () => {
  it('compaction/summary 不在任何一對 model/start／model/end 中間，生摘要的耗時也沒被扣兩次', async () => {
    const events = await runTurns(20);

    const positions = events.flatMap((event, index) =>
      event.type === 'compaction/summary' ? [index] : [],
    );
    // 兩筆以上：第二筆之後才有「上一輪留下的 model/end」可以排錯位置。
    expect(positions.length).toBeGreaterThan(1);
    // 每一次呼叫都有起訖，下面「前一個是 model/end」才等於「不在一對中間」。
    const starts = events.filter((event) => event.type === 'model/start').length;
    expect(starts).toBeGreaterThan(positions.length);
    expect(events.filter((event) => event.type === 'model/end')).toHaveLength(starts);

    for (const index of positions) {
      const previous = events
        .slice(0, index)
        .filter((event) => event.type === 'model/start' || event.type === 'model/end')
        .at(-1);
      expect(previous === undefined || previous.type === 'model/end', `seq ${index}`).toBe(true);
      const next = events
        .slice(index + 1)
        .find((event) => event.type === 'model/start' || event.type === 'model/end');
      expect(next?.type, `seq ${index}`).toBe('model/start');
      // 那一段真的有長度，下面的殘差才量得到東西。
      const summary = events[index]!.data as CompactionSummary;
      expect(summary.durationMs).toBeGreaterThanOrEqual(SUMMARY_DELAY_MS / 2);
    }

    const meter = viewTokenMeter(
      events.reduce((state, event) => applyTokenMeter(state, event), initialTokenMeter()),
    );
    const summarized = meter.turns.filter((turn) => turn.summaryMs !== undefined);
    expect(summarized.length).toBeGreaterThan(1);
    for (const turn of summarized) {
      expect(turn.summaryMs).toBeGreaterThanOrEqual(SUMMARY_DELAY_MS / 2);
      // 被扣兩次的話，每一筆摘要讓殘差少掉整段 SUMMARY_DELAY_MS。門檻留半段：事件的時間是整數毫秒、`durationMs` 四捨五入，
      // 兩種鐘相減可以差出一兩毫秒，那不是重複扣。
      expect(turn.unaccountedMs, `第 ${turn.index} 輪`).toBeGreaterThan(-SUMMARY_DELAY_MS / 2);
    }
  });
});
