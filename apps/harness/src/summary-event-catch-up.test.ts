/**
 * **摘要生成了、請求卻失敗：下一輪從哪裡接**（[#1390](https://github.com/DemianLi/nexus-agent/issues/1390)）。
 *
 * 基座只在請求**成功**時才把 `_summarizationEvent` 交給 graph state。摘要之後的請求失敗（503、使用者停止）：
 * 日誌上 `compaction/summary` 已經記下（#1301），state 沒有事件。沒補的話兩種壞法：
 *
 * 1. 下一輪不再摘要（窗口換大、或重新量過沒到門檻）：模型收到完整原文，日誌推出來的卻套用了那筆事件
 *    —— 推導與實送對不上（#1339 的驗收條件）。
 * 2. 下一輪又要摘要：基座從沒摘要過的狀態重摘，歷史檔疊一份重複的區段（#1389）。
 *
 * 補的位置與理由見 `packages/nexus-core/src/summary-catch-up.ts`。這裡走產品路徑（`ThreadPump` 管日誌、
 * 使用者訊息也進日誌，日誌推導才有東西可比），零憑證、零外部連線。
 *
 * ## 窗口怎麼變
 *
 * 門檻是 token 100,000（出廠值）、窗口夾在 4,200：第 2 輪一則 2,400 字的使用者訊息把請求推過夾窗，摘要器在這一步
 * 動手。第 3 輪把 `modelLimits` 換成大窗口（或換模型），請求量過沒到門檻、這一步不摘要。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import {
  ModelSelectionController,
  replayConversation,
  SUMMARY_PROMPT,
  tagModelRoute,
} from '@nexus/core';
import type { ModelContextLimits } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toolResultAsSeen } from './conversation-restore.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const SMALL: ModelContextLimits = { contextWindow: 4_200, maxOutputTokens: 200 };
const BIG: ModelContextLimits = { contextWindow: 700_045, maxOutputTokens: 16_384 };

const SECTION = /## Summarized at [^\n]+\n\n/;
const SUMMARY_MARK = SUMMARY_PROMPT.split('\n')[0]!;
const isSummaryCall = (prompt: readonly BaseMessage[]) =>
  prompt.some((message) => message.text.includes(SUMMARY_MARK));

const LONG = '長'.repeat(2_400);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-catch-up-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Round {
  /** 這一輪使用者說的。 */
  readonly text: string;
  /** 這一輪用哪個窗口；省略＝沿用上一輪。 */
  readonly limits?: ModelContextLimits;
  /** 這一輪開始前做的事（換模型、等等）。 */
  readonly before?: () => void;
  /** 等到第幾次模型呼叫進來（累計）就按停止。 */
  readonly cancelAtCall?: number;
}

interface Snapshot {
  /** `turn/end`（正常收尾，停止是帶 `reason: aborted` 的 `turn/end`）或 `turn/failed`。 */
  readonly end: string | undefined;
  /** `turn/end` 的 `reason.kind`；沒有就是 `undefined`。 */
  readonly reason: string | undefined;
  /** 這一輪結束後 graph state 上的 `_summarizationEvent.cutoffIndex`。 */
  readonly stateCutoff: number | undefined;
  /** 這一輪日誌上新增的 `compaction/summary` 切點。 */
  readonly logCutoffs: number[];
  /** 這一輪結束後歷史檔的各個區段（去掉標題行、換行換成 ` | `）。 */
  readonly sections: string[];
}

async function converse(options: {
  readonly script: readonly ScriptedTurn[];
  readonly rounds: readonly Round[];
  readonly trigger?: readonly { type: 'tokens' | 'messages'; value: number }[];
  readonly modelSelection?: ModelSelectionController;
  readonly model?: ScriptedChatModel;
  readonly limits?: (model: unknown) => ModelContextLimits | undefined;
}) {
  const model = options.model ?? new ScriptedChatModel({ turns: options.script });
  let current = SMALL;
  const built = await createNexusAgent({
    model,
    backend: new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' }),
    checkpointer: new MemorySaver(),
    plugins: [],
    summarization: {
      trigger: (options.trigger ?? [{ type: 'tokens', value: 100_000 }]).map((each) => ({
        ...each,
      })),
      retainTokens: 12,
    },
    modelLimits: (candidate) => options.limits?.(candidate) ?? current,
    ...(options.modelSelection !== undefined && { modelSelection: options.modelSelection }),
  });
  const pump = new ThreadPump(
    built.agent as unknown as PumpAgent,
    'catch-up',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    built.stepInbox,
  );
  const detach = built.attachSession(pump.sessions);
  options.modelSelection?.attach(pump.sessionLog);
  const snapshots: Snapshot[] = [];
  try {
    for (const [index, round] of options.rounds.entries()) {
      if (round.limits !== undefined) current = round.limits;
      round.before?.();
      const before = pump.sessionLog.events.length;
      const submitted = pump
        .submit({ kind: 'message', text: round.text, id: `m${index + 1}` })
        .catch(() => undefined);
      if (round.cancelAtCall !== undefined) {
        // 等到那一次呼叫進來（模型在串流中間），再按停止。
        for (
          let waited = 0;
          model.prompts.length < round.cancelAtCall && waited < 200;
          waited += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        pump.cancel();
      }
      await submitted;
      await pump.whenIdle().catch(() => undefined);
      const state = await (
        built.agent as unknown as { getState(config: unknown): Promise<{ values: unknown }> }
      ).getState({ configurable: { thread_id: 'catch-up' } });
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
        reason: (end?.data as { reason?: { kind?: string } } | undefined)?.reason?.kind,
        stateCutoff: values._summarizationEvent?.cutoffIndex,
        logCutoffs: slice
          .filter((event) => event.type === 'compaction/summary')
          .map((event) => (event.data as { cutoffIndex: number }).cutoffIndex),
        sections: (Object.values(values.files ?? {})[0]?.content ?? '')
          .split(SECTION)
          .map((text) => text.trim())
          .filter((text) => text !== '')
          .map((text) => text.replace(/\n/g, ' | ')),
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

/** 每一次主呼叫：從日誌推出的歷史，是不是實際送出的那一串。回逐次的結果（`'EQ'` 或差在哪）。 */
function derivedVersusActual(run: Run): string[] {
  const mains = run.model.prompts.filter((prompt) => !isSummaryCall(prompt));
  const starts = run.events.filter((event) => event.type === 'model/start');
  expect(starts).toHaveLength(mains.length);
  return starts.map((start, index) => {
    const replay = replayConversation(
      run.events.filter((event) => event.seq < start.seq),
      { toolResultAsSeen, applyPrunes: true, applyArgTruncations: true },
    );
    if (replay.kind !== 'replayed') return `call${index + 1}:${replay.kind}`;
    const derived = replay.messages.map((m) => `${m.getType()}:${String(m.content)}`);
    const actual = mains[index]!.slice(1).map((m) => `${m.getType()}:${String(m.content)}`);
    return JSON.stringify(derived) === JSON.stringify(actual) ? 'EQ' : `call${index + 1}:DIFF`;
  });
}

const ok = (content: string): ScriptedTurn => ({ content });

describe('摘要之後請求失敗，下一輪從日誌上那筆接著', () => {
  /**
   * 第 1 輪 → 第 2 輪（摘要＋請求 503）→ 第 3 輪（窗口換大，不摘要）。
   * 呼叫順序：1 ＝ 第 1 輪、2 ＝ 摘要、3 ＝ 第 2 輪的請求（503）、4 ＝ 第 3 輪。
   */
  it('503：下一輪不摘要時，state 補上那筆事件，每次呼叫推導等於實送', async () => {
    const run = await converse({
      script: [ok('好 1'), ok('摘要一'), { content: '', error: 'upstream 503' }, ok('好 3')],
      rounds: [{ text: '第 1 句。' }, { text: LONG }, { text: '第 3 句。', limits: BIG }],
    });

    // 前提：第 2 輪真的摘要了、請求真的失敗了、第 3 輪真的沒有再摘要。
    expect(run.snapshots.map((s) => s.end)).toEqual(['turn/end', 'turn/failed', 'turn/end']);
    expect(run.snapshots[1]!.logCutoffs).toEqual([2]);
    expect(run.snapshots[2]!.logCutoffs).toEqual([]);
    expect(run.model.prompts.filter(isSummaryCall)).toHaveLength(1);

    // 失敗那輪結束時 state 沒有事件（基座沒提交）。第 3 輪的請求前補上，結束時 state 與日誌同一個切點。
    expect(run.snapshots[1]!.stateCutoff).toBeUndefined();
    expect(run.snapshots[2]!.stateCutoff).toBe(2);

    // 日誌推導＝實送：第 3 輪那次呼叫是修之前對不上的那一次。
    expect(derivedVersusActual(run)).toEqual(['EQ', 'EQ', 'EQ']);

    // 歷史檔只有第 2 輪摘要卸下的那一段。
    expect(run.snapshots[2]!.sections).toEqual(['Human: 第 1 句。 | AI: model, 好 1']);
  });

  /**
   * 使用者在摘要之後、請求串流到一半按停止：失敗路徑與 503 不同（取消），state 的樣子一樣沒有事件。
   * 呼叫順序：1 ＝ 第 1 輪、2 ＝ 摘要、3 ＝ 第 2 輪的請求（串流中被停）、4 ＝ 第 3 輪。
   */
  it('使用者停止：同樣補上，每次呼叫推導等於實送', async () => {
    const run = await converse({
      script: [
        ok('好 1'),
        ok('摘要一'),
        { content: '好'.repeat(400), tokenDelayMs: 25 },
        ok('好 3'),
      ],
      rounds: [
        { text: '第 1 句。' },
        { text: LONG, cancelAtCall: 3 },
        { text: '第 3 句。', limits: BIG },
      ],
    });

    expect(run.snapshots[1]!.logCutoffs).toEqual([2]);
    // 前提：這一輪是被使用者停掉的（`turn/end` 帶 `reason: aborted`），不是正常收尾。
    expect(run.snapshots[1]!.reason).toBe('aborted');
    expect(run.snapshots[2]!.logCutoffs).toEqual([]);
    expect(run.model.prompts.filter(isSummaryCall)).toHaveLength(1);

    expect(run.snapshots[2]!.stateCutoff).toBe(2);
    expect(derivedVersusActual(run)).toEqual(['EQ', 'EQ', 'EQ']);
    expect(run.snapshots[2]!.sections).toEqual(['Human: 第 1 句。 | AI: model, 好 1']);
  });

  /**
   * 下一輪又要摘要：切點接著提交過的那一筆，不從頭重摘。**沒補的話第二個區段會把第一個區段的內容再抄一遍。**
   * 呼叫順序：1、2 ＝ 摘要、3 ＝ 請求（503）、4 ＝ 第 3 輪的摘要、5 ＝ 第 3 輪的請求。
   */
  it('503 之後下一輪又摘要：歷史檔不疊區段，兩段內容互不重複', async () => {
    const run = await converse({
      script: [
        ok('好 1'),
        ok('摘要一'),
        { content: '', error: 'upstream 503' },
        ok('摘要二'),
        ok('好 3'),
      ],
      rounds: [{ text: '第 1 句。' }, { text: LONG }, { text: `${LONG}。` }],
    });

    expect(run.snapshots.map((s) => s.end)).toEqual(['turn/end', 'turn/failed', 'turn/end']);
    expect(run.model.prompts.filter(isSummaryCall)).toHaveLength(2);

    const sections = run.snapshots[2]!.sections;
    expect(sections).toHaveLength(2);
    // 第一段：第 2 輪卸下的；第二段：第 3 輪新卸下的（第 2 輪那句長的），不含第一段的任何一則。
    expect(sections[0]).toBe('Human: 第 1 句。 | AI: model, 好 1');
    expect(sections[1]).toBe(`Human: ${LONG}`);
    expect(sections[1]).not.toContain('第 1 句');

    // 第 3 輪的切點接著第 2 輪那筆（2）往後走，state 與日誌同一個切點。
    const [first, second] = [run.snapshots[1]!.logCutoffs[0]!, run.snapshots[2]!.logCutoffs[0]!];
    expect(second).toBeGreaterThan(first);
    expect(run.snapshots[2]!.stateCutoff).toBe(second);
    expect(derivedVersusActual(run)).toEqual(['EQ', 'EQ', 'EQ']);
  });

  /** 沒有失敗：這一層什麼都不做（單元測試釘住它不回 `Command`；這裡看行為不變）。 */
  it('沒有失敗：摘要照舊由基座提交，一筆事件、一個區段', async () => {
    const run = await converse({
      script: [ok('好 1'), ok('摘要一'), ok('好 2'), ok('好 3')],
      rounds: [{ text: '第 1 句。' }, { text: LONG }, { text: '第 3 句。', limits: BIG }],
    });

    expect(run.snapshots.map((s) => s.end)).toEqual(['turn/end', 'turn/end', 'turn/end']);
    expect(run.snapshots[1]!.logCutoffs).toEqual([2]);
    expect(run.snapshots[1]!.stateCutoff).toBe(2);
    expect(run.snapshots[2]!.logCutoffs).toEqual([]);
    expect(run.snapshots[2]!.stateCutoff).toBe(2);
    expect(run.snapshots[2]!.sections).toEqual(['Human: 第 1 句。 | AI: model, 好 1']);
    expect(derivedVersusActual(run)).toEqual(['EQ', 'EQ', 'EQ']);
  });

  /**
   * 換模型：第 2 輪在小窗口那顆上摘要、請求失敗；第 3 輪選到大窗口那顆。補不補、補什麼不看 `request.model`，
   * 這一條走真的 `modelSelection`（不是改 `modelLimits` 的回傳）。
   */
  it('換模型：第 3 輪換到大窗口那顆，補的規則不看這一步選中的模型', async () => {
    const defaultModel = tagModelRoute(
      new ScriptedChatModel({ turns: [ok('好 1'), ok('摘要一'), { content: '', error: '503' }] }),
      { model: 'default' },
    );
    const bigModel = tagModelRoute(new ScriptedChatModel({ turns: [ok('好 3')] }), {
      model: 'big',
    });
    const controller = new ModelSelectionController({
      defaultRoute: { model: 'default' },
      instanceFor: (route) => (route.model === 'big' ? bigModel : undefined),
    });
    const run = await converse({
      model: defaultModel,
      script: [],
      modelSelection: controller,
      limits: (candidate) =>
        candidate === bigModel ? BIG : candidate === defaultModel ? SMALL : undefined,
      rounds: [
        { text: '第 1 句。' },
        { text: LONG },
        { text: '第 3 句。', before: () => controller.select({ model: 'big' }) },
      ],
    });

    // 前提：第 3 輪那次請求真的走在換上去那顆，而且沒有再摘要。
    expect(bigModel.prompts).toHaveLength(1);
    expect(isSummaryCall(bigModel.prompts[0]!)).toBe(false);
    expect(run.snapshots.map((s) => s.end)).toEqual(['turn/end', 'turn/failed', 'turn/end']);

    expect(run.snapshots[1]!.stateCutoff).toBeUndefined();
    expect(run.snapshots[2]!.stateCutoff).toBe(2);
    // 日誌推導＝實送：第 3 輪的請求在 `bigModel.prompts` 裡，前兩次在 `defaultModel.prompts` 裡。
    const mains = [
      ...defaultModel.prompts.filter((prompt) => !isSummaryCall(prompt)),
      ...bigModel.prompts,
    ];
    const starts = run.events.filter((event) => event.type === 'model/start');
    expect(starts).toHaveLength(mains.length);
    for (const [index, start] of starts.entries()) {
      const replay = replayConversation(
        run.events.filter((event) => event.seq < start.seq),
        { toolResultAsSeen, applyPrunes: true, applyArgTruncations: true },
      );
      expect(replay.kind).toBe('replayed');
      if (replay.kind !== 'replayed') continue;
      expect(
        replay.messages.map((m) => `${m.getType()}:${String(m.content)}`),
        `第 ${index + 1} 次主呼叫`,
      ).toEqual(mains[index]!.slice(1).map((m) => `${m.getType()}:${String(m.content)}`));
    }
  });

  /**
   * 子代理讀的是自己那份日誌：root 日誌上有摘要事件，子代理（一份全新的 state）的請求**不能**被補上 root 的事件。
   *
   * 切點取 1（訊息數門檻 3、保留量 12 token），子代理 state 只有一則（任務描述）：切點 ≤ 長度，
   * 「切點落在訊息串之外就不補」那一道擋不住——能擋住的只有「讀的是誰的日誌」。
   * 呼叫順序：1 ＝ 第 1 輪、2 ＝ root 摘要、3 ＝ root 請求（叫 task）、4 ＝ 子代理、5、6 ＝ root 收尾（又摘要一次）。
   */
  it('子代理：請求前不會被補上 root 日誌上的事件', async () => {
    const run = await converse({
      script: [
        ok('好 1'),
        ok('摘要一'),
        {
          content: '',
          toolCalls: [
            { name: 'task', args: { description: '去做。', subagent_type: 'general-purpose' } },
          ],
        },
        ok('子代理做完了。'),
        ok('摘要二'),
        ok('收工。'),
      ],
      trigger: [{ type: 'messages', value: 3 }],
      rounds: [{ text: '第 1 句。' }, { text: '第 2 句。' }],
    });

    // 前提：root 日誌上先有一筆摘要，切點 1。
    expect(run.snapshots[1]!.logCutoffs[0]).toBe(1);
    // 子代理的請求：只有它自己的 system 與任務描述，沒有 root 的摘要。
    const subagentPrompt = run.model.prompts.find((prompt) =>
      prompt.some((message) => message.getType() === 'human' && message.text === '去做。'),
    );
    expect(subagentPrompt).toBeDefined();
    expect(subagentPrompt!.map((message) => message.getType())).toEqual(['system', 'human']);
    expect(subagentPrompt!.some((message) => message.text.includes('摘要一'))).toBe(false);
  });
});
