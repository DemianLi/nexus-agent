/**
 * **摘要不比被取代的內容小，就不提交**（[#1396](https://github.com/DemianLi/nexus-agent/issues/1396)）。
 *
 * 照 dsh `compaction-basic` 的 shrink 檢查（`src/region.ts:417-420`）：生出來的摘要加上框架之後 ≥ 它取代的那一段，
 * 整次壓縮不提交。擋的是 S6 第 3 輪那一類：摘要之後再來一輪、尾巴剛好蓋住全部新內容，要取代的只剩上一份摘要一則——
 * 以前照樣提交，歷史檔多一個空的 `## Summarized at` 區段、日誌多一筆沒有新內容的 `compaction/summary`
 * （#1395 的暫存層只能擋「沒生出摘要」，擋不住「生出來但沒有東西可卸」）。
 *
 * 這一檔走產品路徑（`ThreadPump` 管日誌），量兩件事：
 *
 * | 情境 | 以前 | 現在 |
 * | --- | --- | --- |
 * | S6 第 3 輪：要取代的只剩舊摘要，新摘要與它一樣大 | 提交：日誌多一筆、歷史檔多一個空區段 | 不提交：日誌沒有那一筆、歷史檔不變、warn 一條、照原請求送出 |
 * | 前兩輪的正常摘要 | 提交 | **不變** |
 *
 * 「一樣大」是邊界：`>=` 改成 `>` 會讓第一列翻回去提交。逐 token 的等號案例（剛好等於不提交、多一個 token 提交）與
 * 端點超窗那條路在 `packages/nexus-core/src/summary-failure.test.ts`。
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
import { replayConversation } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toolResultAsSeen } from './conversation-restore.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

/** 摘要呼叫（沒有系統訊息的那種）回的字串。每次一樣長：第 3 輪新摘要與舊摘要框好之後恰好一樣大。 */
const SUMMARY_TEXT = '摘要：之前聊了一些事。';
/** 墊料（#1396）：被取代的那段要比「框架＋摘要」大，正常摘要才提交。 */
const USER_PAD = '內容'.repeat(200);
const REPLY_PAD = '內容'.repeat(120);
/** 保留量：兩輪都留下尾巴的最後兩則；第 3 輪那兩則是「上一輪回話＋這一句」，再加舊摘要就裝不下，所以要取代的只剩舊摘要。 */
const RETAIN_TOKENS = 250;

const SECTION = /## Summarized at [^\n]+\n\n/;
const HISTORY_FILE = /^\/session_[^/]+\.md$/;

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
  /** graph state 上 `_summarizationEvent.cutoffIndex`。 */
  readonly stateCutoff: number | undefined;
  /** 歷史檔的各區段（去掉標題行、換行換成 ` | `）；空區段就是空字串，這裡**不**濾掉。 */
  readonly sections: string[];
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
      const values = state.values as {
        files?: Record<string, { content?: string }>;
        _summarizationEvent?: { cutoffIndex: number };
      };
      const slice = pump.sessionLog.events.slice(before);
      const end = [...slice]
        .reverse()
        .find((event) => event.type === 'turn/end' || event.type === 'turn/failed');
      snapshots.push({
        end: end?.type,
        stateCutoff: values._summarizationEvent?.cutoffIndex,
        logCutoffs: slice
          .filter((event) => event.type === 'compaction/summary')
          .map((event) => (event.data as { cutoffIndex: number }).cutoffIndex),
        sections: Object.entries(values.files ?? {})
          .filter(([path]) => HISTORY_FILE.test(path))
          .flatMap(([, file]) => (file.content ?? '').split(/(?=## Summarized at )/))
          .filter((chunk) => chunk.startsWith('## Summarized at'))
          .map((chunk) => chunk.replace(SECTION, '').trim().replace(/\n/g, ' | ')),
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
   * 呼叫：1 ＝ 第 1 輪；2 ＝ 摘要、3 ＝ 摘要之後的請求（超窗）、4 ＝ retain 0 的摘要、5 ＝ 重送（超窗）、6 ＝ 再摘要、7 ＝ 重送；
   * 第 3 輪：8 ＝ 摘要（被擋）、9 ＝ 照原請求送出。
   */
  it('新摘要不比舊摘要小：不提交，日誌沒有那一筆、歷史檔不多空區段、warn 一條、推導等於實送', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const run = await converse({ overflowOn: [3, 5], turns: 3 });

    // 前提：第 2 輪的兩次超窗真的升級到底（三筆事件，最後切點 3），第 3 輪的摘要呼叫真的發生過。
    expect(run.snapshots[1]!.logCutoffs).toEqual([1, 2, 3]);
    expect(run.snapshots[1]!.stateCutoff).toBe(3);
    expect(run.model.calls).toBe(9);
    expect(run.snapshots[2]!.end).toBe('turn/end');

    // 第 3 輪：沒有新事件、state 切點不動、歷史檔還是第 2 輪那一段（沒有空區段）。
    expect(run.snapshots[2]!.logCutoffs).toEqual([]);
    expect(run.snapshots[2]!.stateCutoff).toBe(3);
    expect(run.snapshots[2]!.sections).toEqual(run.snapshots[1]!.sections);
    expect(run.snapshots[2]!.sections.every((section) => section !== '')).toBe(true);

    // 正好一條 warn：走 #1383 既有的「摘要壞了、照原請求送出」那條路。
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => line.includes('照原請求送出'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('不比被取代'))).toHaveLength(1);

    // 日誌推導＝實送：每一次主呼叫（含被擋之後照原請求送出的那一次）。
    expect(derivedVersusActual(run).every((each) => each === 'EQ')).toBe(true);
  });
});

describe('正常摘要不受影響', () => {
  it('前兩輪的摘要照常提交：被取代的比框好的摘要大', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const run = await converse({ overflowOn: [], turns: 2 });

    expect(run.snapshots.map((s) => s.logCutoffs.length)).toEqual([0, 1]);
    expect(run.snapshots[1]!.stateCutoff).toBe(run.snapshots[1]!.logCutoffs[0]);
    expect(run.snapshots[1]!.sections).toHaveLength(1);
    expect(
      warn.mock.calls.map((call) => String(call[0])).filter((l) => l.includes('不比被取代')),
    ).toEqual([]);
    expect(derivedVersusActual(run).every((each) => each === 'EQ')).toBe(true);
  });
});
