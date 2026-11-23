/**
 * **S6 第 3 輪：摘要之後再來一輪、要取代的只剩上一顆摘要，就不摘**（[#1396](https://github.com/DemianLi/nexus-agent/issues/1396)、
 * [#2086](https://github.com/DemianLi/nexus-agent/issues/2086)）。
 *
 * 尾巴剛好蓋住全部新內容時，照保留量切，切點前只剩上一顆摘要。摘要器把它當成摘不到東西（`retainedMessageCount` 回整串長度），
 * 不打摘要模型、不提交。提交的話，日誌多一筆沒有新內容的 `compaction/summary`，從日誌讀回的段落多一段只有
 * `[prior summary]` 的。
 *
 * 這一檔走產品路徑（`ThreadPump` 管日誌），量兩件事：
 *
 * | 情境 | 結果 |
 * | --- | --- |
 * | S6 第 3 輪：要取代的只剩舊摘要 | 不打摘要模型、不提交：日誌沒有那一筆、讀回的段落不變、沒有摘要失敗的 warn、原請求照送 |
 * | 前兩輪的正常摘要 | 提交：原文從日誌讀回，不寫歷史檔 |
 *
 * shrink 檢查（#1396）自己的案例（被取代的不是只有舊摘要、新摘要卻不比它小；剛好等於不提交、多一個 token 提交）與端點超窗那條路
 * 在 `packages/nexus-core/src/summary-failure.test.ts`。
 *
 * 零憑證、零外部連線。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextOverflowError } from '@langchain/core/errors';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { MemorySaver } from '@langchain/langgraph';
import { recallHistory, replayConversation } from '@nexus/core';
import type { RecalledHistory } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toolResultAsSeen } from './conversation-restore.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

/** 摘要呼叫（沒有系統訊息的那種）回的字串。 */
const SUMMARY_TEXT = '摘要：之前聊了一些事。';
/** 墊料（#1396）：被取代的那段要比「框架＋摘要」大，正常摘要才提交。 */
const USER_PAD = '內容'.repeat(200);
const REPLY_PAD = '內容'.repeat(120);
/** 保留量：兩輪都留下尾巴的最後兩則；第 3 輪那兩則是「上一輪回話＋這一句」，再加舊摘要就裝不下，所以要取代的只剩舊摘要。 */
const RETAIN_TOKENS = 250;

/** 第幾次呼叫（累計，含摘要那幾次）回超窗；其餘照常。 */
class ShrinkModel extends BaseChatModel {
  readonly seen: string[][] = [];
  calls = 0;
  private root: ShrinkModel = this;

  constructor(
    private readonly overflowOn: readonly number[],
    shared?: ShrinkModel,
  ) {
    super({});
    if (shared !== undefined) {
      this.seen = shared.seen;
      this.root = shared.root;
    }
  }

  _llmType(): string {
    return 'shrink';
  }

  override bindTools(): ShrinkModel {
    return new ShrinkModel(this.overflowOn, this.root);
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const root = this.root;
    root.calls += 1;
    const n = root.calls;
    root.seen.push(messages.map((m) => `${m.getType()}:${String(m.content)}`));
    const isSummary = messages[0]?.getType() !== 'system';
    if (!isSummary && this.overflowOn.includes(n)) {
      throw new ContextOverflowError('Input exceeded the model context window.');
    }
    const message = new AIMessage(
      isSummary ? SUMMARY_TEXT : `第 ${String(n)} 次回話。${REPLY_PAD}`,
    );
    return { generations: [{ text: message.text, message }], llmOutput: {} };
  }
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-summary-shrink-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

interface Snapshot {
  /** 這一輪日誌上新增的 `compaction/summary` 切點。 */
  readonly logCutoffs: number[];
  /** 同上那幾筆的 `filePath`。 */
  readonly filePaths: (string | null)[];
  /** 這一輪結束後 checkpoint `files` 的鍵。 */
  readonly files: string[];
  /** 這一輪結束時從日誌讀回的段落（逐字稿原樣）；只遮掉舊摘要的那段是 `[prior summary]`，這裡**不**濾掉。 */
  readonly segments: string[];
  readonly failure: RecalledHistory['failure'];
  /** 這一輪結束時的 `turn/end`／`turn/failed`。 */
  readonly end: string | undefined;
}

async function converse(options: {
  readonly overflowOn: readonly number[];
  readonly turns: number;
}) {
  const model = new ShrinkModel(options.overflowOn);
  const built = await createNexusAgent({
    model,
    backend: new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' }),
    checkpointer: new MemorySaver(),
    plugins: [],
    summarization: { trigger: [{ type: 'messages', value: 3 }], retainTokens: RETAIN_TOKENS },
  });
  const pump = new ThreadPump(
    built.agent as unknown as PumpAgent,
    'summary-shrink',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    built.stepInbox,
  );
  const detach = built.attachSession(pump.sessions);
  const snapshots: Snapshot[] = [];
  try {
    for (let turn = 1; turn <= options.turns; turn += 1) {
      const before = pump.sessionLog.events.length;
      await pump
        .submit({ kind: 'message', text: `第 ${turn} 句。${USER_PAD}`, id: `m${turn}` })
        .catch(() => undefined);
      await pump.whenIdle().catch(() => undefined);
      const state = await (
        built.agent as unknown as { getState(config: unknown): Promise<{ values: unknown }> }
      ).getState({ configurable: { thread_id: 'summary-shrink' } });
      const values = state.values as { files?: Record<string, unknown> };
      const slice = pump.sessionLog.events.slice(before);
      const end = [...slice]
        .reverse()
        .find((event) => event.type === 'turn/end' || event.type === 'turn/failed');
      const summaries = slice.filter((event) => event.type === 'compaction/summary');
      const recalled = recallHistory(pump.sessionLog.events);
      snapshots.push({
        end: end?.type,
        logCutoffs: summaries.map((event) => (event.data as { cutoffIndex: number }).cutoffIndex),
        filePaths: summaries.map((event) => (event.data as { filePath: string | null }).filePath),
        files: Object.keys(values.files ?? {}),
        segments: recalled.segments.map((segment) => segment.text),
        failure: recalled.failure,
      });
    }
    return { model, snapshots, events: [...pump.sessionLog.events] };
  } finally {
    pump.close();
    detach();
    await built.dispose();
  }
}

type Run = Awaited<ReturnType<typeof converse>>;

/** 每一次主呼叫：日誌推出的歷史是不是實際送出的那一串。 */
function derivedVersusActual(run: Run): string[] {
  const mains = run.model.seen
    .map((messages, index) => ({ call: index + 1, messages }))
    .filter((entry) => entry.messages[0]?.startsWith('system:'));
  const starts = run.events.filter((event) => event.type === 'model/start');
  expect(starts).toHaveLength(mains.length);
  return starts.map((start, index) => {
    const replay = replayConversation(
      run.events.filter((event) => event.seq < start.seq),
      { toolResultAsSeen, applyPrunes: true, applyArgTruncations: true },
    );
    if (replay.kind !== 'replayed') return `call${mains[index]!.call}:${replay.kind}`;
    const derived = replay.messages.map((m) => `${m.getType()}:${String(m.content)}`);
    return JSON.stringify(derived) === JSON.stringify(mains[index]!.messages.slice(1))
      ? 'EQ'
      : `call${mains[index]!.call}:DIFF`;
  });
}

describe('S6 第 3 輪：要取代的只剩舊摘要', () => {
  /**
   * 呼叫：1 ＝ 第 1 輪；2、3 ＝ 摘要（條目、現況）、4 ＝ 摘要之後的請求（超窗）、5、6 ＝ retain 0 的摘要、7 ＝ 重送（超窗）、
   * 8、9 ＝ 再摘要、10 ＝ 重送；第 3 輪：11 ＝ 原請求照送，沒有摘要那一次。
   */
  it('不打摘要模型、不提交：日誌沒有那一筆、讀回的段落不多一段、沒有摘要失敗的 warn、推導等於實送', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const run = await converse({ overflowOn: [4, 7], turns: 3 });

    // 前提：第 2 輪的兩次超窗真的升級到底（三筆事件，最後切點 3）。第 3 輪只有一次呼叫，而且是主呼叫。
    expect(run.snapshots[1]!.logCutoffs).toEqual([1, 2, 3]);
    expect(run.model.calls).toBe(11);
    expect(run.model.seen[10]![0]).toMatch(/^system:/);
    expect(run.snapshots[2]!.end).toBe('turn/end');

    // 第 3 輪：沒有新事件、讀回的還是第 2 輪那一段（沒有只遮掉舊摘要的那種）。
    expect(run.snapshots[2]!.logCutoffs).toEqual([]);
    expect(run.snapshots.map((s) => s.failure)).toEqual([undefined, undefined, undefined]);
    expect(run.snapshots[1]!.segments).toHaveLength(1);
    expect(run.snapshots[2]!.segments).toEqual(run.snapshots[1]!.segments);
    expect(run.snapshots[2]!.segments[0]).toMatch(/^User: 第 1 句。/);
    expect(run.snapshots[2]!.segments[0]).not.toContain('[prior summary]');

    // 沒有走「摘要壞了、照原請求送出」那條路。
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => line.includes('照原請求送出'))).toEqual([]);
    expect(lines.filter((line) => line.includes('不比被取代'))).toEqual([]);

    // 日誌推導＝實送：每一次主呼叫。
    expect(derivedVersusActual(run).every((each) => each === 'EQ')).toBe(true);
  });
});

describe('正常摘要不受影響', () => {
  it('前兩輪的摘要照常提交：被取代的比框好的摘要大，原文從日誌讀回一段、不寫歷史檔', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const run = await converse({ overflowOn: [], turns: 2 });

    expect(run.snapshots.map((s) => s.logCutoffs.length)).toEqual([0, 1]);
    expect(run.snapshots[1]!.filePaths).toEqual([null]);
    expect(run.snapshots.map((s) => s.files)).toEqual([[], []]);
    expect(run.snapshots[1]!.failure).toBeUndefined();
    expect(run.snapshots[1]!.segments).toEqual([`User: 第 1 句。${USER_PAD}`]);
    expect(
      warn.mock.calls.map((call) => String(call[0])).filter((l) => l.includes('不比被取代')),
    ).toEqual([]);
    expect(derivedVersusActual(run).every((each) => each === 'EQ')).toBe(true);
  });
});
