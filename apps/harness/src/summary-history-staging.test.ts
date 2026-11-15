/**
 * **被摘掉的原文從會話日誌讀回，各段互不重複**（[#1389](https://github.com/DemianLi/nexus-agent/issues/1389)、
 * [#2777](https://github.com/DemianLi/nexus-agent/issues/2777)）。
 *
 * 接了日誌、讀回工具也註冊了的組裝不寫歷史檔：被摘掉的原文留在日誌上，`recallHistory` 把每一顆生效的 `compaction/summary`
 * 推回它遮掉的那一段。這裡走產品路徑（`ThreadPump` 管日誌、使用者訊息也進日誌），逐輪量兩件事：checkpoint 的 `files`
 * 是空的、日誌上那幾筆的 `filePath` 是 `null`；以及這一輪結束時從日誌讀回的段落。
 *
 * | 情境 | 讀回的段落 |
 * | --- | --- |
 * | S1 同一步內摘要後超窗、retain 0 重摘 | 一段，內容是第二次的（兩顆事件帶同一個條目序號，後面那顆取代前面那顆） |
 * | S6 超窗兩次 | 一段，不是三段巢狀 |
 * | S2 生摘要的呼叫自己失敗 | 失敗那輪沒有事件、沒有段落；下一輪一段，原文不重複 |
 * | S3／S4／S10 摘要後主請求失敗／被停 | 事件在日誌上，那一段就在；下一輪的段落接著它，互不重複 |
 *
 * 沒接日誌的組裝照寫歷史檔，那一層的暫存提交（`packages/nexus-core/src/summary-history-staging.ts`）在它旁邊的單元測試裡量。
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
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { recallHistory, replayConversation, SessionRegistry } from '@nexus/core';
import type { PluginEntry, RecalledHistory, SessionEvent } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toolResultAsSeen } from './conversation-restore.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

type Behavior = 'ok' | 'overflow' | 'error' | 'hang';

/** 第 `n` 次呼叫（累計，含摘要那幾次）怎麼回。 */
class BehaviorModel extends BaseChatModel {
  readonly seen: string[][] = [];
  calls = 0;
  onHang: (() => void) | undefined;

  constructor(
    private readonly behavior: (call: number) => Behavior,
    shared?: BehaviorModel,
  ) {
    super({});
    if (shared !== undefined) {
      this.seen = shared.seen;
      this.root = shared.root;
    }
  }

  private root: BehaviorModel = this;

  _llmType(): string {
    return 'behavior';
  }

  override bindTools(): BehaviorModel {
    return new BehaviorModel(this.behavior, this.root);
  }

  async _generate(messages: BaseMessage[], options: { signal?: AbortSignal }): Promise<ChatResult> {
    const root = this.root;
    root.calls += 1;
    const n = root.calls;
    root.seen.push(messages.map((m) => `${m.getType()}:${String(m.content)}`));
    const behavior = this.behavior(n);
    if (behavior === 'overflow') {
      throw new ContextOverflowError('Input exceeded the model context window.');
    }
    if (behavior === 'error') throw new Error('upstream 503 service unavailable');
    if (behavior === 'hang') {
      root.onHang?.();
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted === true) reject(new Error('aborted'));
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    const isSummary = messages[0]?.getType() !== 'system';
    const message = new AIMessage(isSummary ? '摘要。' : `第 ${String(n)} 次回話。${REPLY_PAD}`);
    return { generations: [{ text: message.text, message }], llmOutput: {} };
  }
}

/**
 * 墊料（#1396）：框好的摘要要比被取代那段小才會提交。使用者句墊得比回話長，因為第一次摘要取代的就是它一則；
 * 摘要呼叫（沒有系統訊息的那種）反過來回短字串，不然摘要本身就比被取代的大。
 */
const USER_PAD = '內容'.repeat(200);
const REPLY_PAD = '內容'.repeat(120);
/** 保留量：使用者句約 210 token、回話約 130 token，這個值在這份對話上留下尾巴的最後兩則（N = 2）。 */
const RETAIN_TOKENS = 250;
/** 日誌讀回的逐字稿裡那兩種行。 */
const user = (n: number) => `User: 第 ${String(n)} 句。${USER_PAD}`;
const assistant = (n: number) => `Assistant: 第 ${String(n)} 次回話。${REPLY_PAD}`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-history-staging-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Snapshot {
  readonly end: string | undefined;
  /** 這一輪結束後 checkpoint `files` 的鍵。 */
  readonly files: string[];
  /** 這一輪日誌上新增的 `compaction/summary` 切點。 */
  readonly logCutoffs: number[];
  /** 同上那幾筆的 `filePath`。 */
  readonly filePaths: (string | null)[];
  /** 這一輪結束時從日誌讀回的段落（一則訊息一行，以 ` | ` 相接）。 */
  readonly segments: string[];
  readonly failure: RecalledHistory['failure'];
}

/** 一份日誌讀回的段落；訊息之間的空行換成 ` | `。 */
function segmentsOf(events: readonly SessionEvent[]) {
  const recalled = recallHistory(events);
  return {
    segments: recalled.segments.map((segment) => segment.text.replace(/\n\n/g, ' | ')),
    failure: recalled.failure,
  };
}

async function converse(options: {
  readonly behavior: (call: number) => Behavior;
  readonly turns?: number;
  /** 哪一次呼叫掛住、並在 30ms 後按停止。 */
  readonly cancelAt?: number;
}) {
  const model = new BehaviorModel(options.behavior);
  const built = await createNexusAgent({
    model,
    backend: new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' }),
    checkpointer: new MemorySaver(),
    plugins: [],
    summarization: { trigger: [{ type: 'messages', value: 3 }], retainTokens: RETAIN_TOKENS },
  });
  const pump = new ThreadPump(
    built.agent as unknown as PumpAgent,
    'history-staging',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    built.stepInbox,
  );
  if (options.cancelAt !== undefined) {
    model.onHang = () => void setTimeout(() => pump.cancel(), 30);
  }
  const detach = built.attachSession(pump.sessions);
  const snapshots: Snapshot[] = [];
  try {
    for (let turn = 1; turn <= (options.turns ?? 3); turn += 1) {
      const before = pump.sessionLog.events.length;
      await pump
        .submit({ kind: 'message', text: `第 ${turn} 句。${USER_PAD}`, id: `m${turn}` })
        .catch(() => undefined);
      await pump.whenIdle().catch(() => undefined);
      const state = await (
        built.agent as unknown as { getState(config: unknown): Promise<{ values: unknown }> }
      ).getState({ configurable: { thread_id: 'history-staging' } });
      const slice = pump.sessionLog.events.slice(before);
      const end = [...slice]
        .reverse()
        .find((event) => event.type === 'turn/end' || event.type === 'turn/failed');
      const summaries = slice.filter((event) => event.type === 'compaction/summary');
      snapshots.push({
        end: end?.type,
        files: Object.keys((state.values as { files?: Record<string, unknown> }).files ?? {}),
        logCutoffs: summaries.map((event) => (event.data as { cutoffIndex: number }).cutoffIndex),
        filePaths: summaries.map((event) => (event.data as { filePath: string | null }).filePath),
        ...segmentsOf(pump.sessionLog.events),
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

/** 每一輪：沒有歷史檔、日誌上每一筆的 `filePath` 是 `null`、日誌推得到底（段落沒有在半途斷掉）。 */
function expectReadBackFromLog(run: Run): void {
  for (const [index, snapshot] of run.snapshots.entries()) {
    expect(snapshot.files, `第 ${index + 1} 輪`).toEqual([]);
    expect(snapshot.filePaths.every((path) => path === null)).toBe(true);
    expect(snapshot.failure, `第 ${index + 1} 輪`).toBeUndefined();
  }
}

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

/** 所有段落裡的每一行（`User: …` 與 `Assistant: …`）：同一行出現兩次就是原文被讀回兩份。 */
const linesOf = (segments: readonly string[]) =>
  segments.flatMap((segment) => segment.split(' | '));

describe('同一步內重摘：最後一次勝出（S1、S6）', () => {
  /**
   * 呼叫：1 ＝ 第 1 輪；2、3 ＝ 摘要（條目、現況）、4 ＝ 摘要之後的請求（超窗）、5、6 ＝ retain 0 的摘要、7 ＝ 重送。
   */
  it('S1 超窗一次：讀回一段，內容是第二次嘗試的', async () => {
    const run = await converse({ behavior: (n) => (n === 4 ? 'overflow' : 'ok') });

    // 前提：真的走到了升級（日誌上兩筆事件）。
    expect(run.snapshots[1]!.logCutoffs).toEqual([1, 2]);
    expect(run.snapshots[1]!.end).toBe('turn/end');

    expectReadBackFromLog(run);
    expect(run.snapshots[1]!.segments).toEqual([`${user(1)} | ${assistant(1)}`]);
    expect(derivedVersusActual(run)).toEqual(['EQ', 'EQ', 'EQ', 'EQ']);
  });

  /** 呼叫：4、7 超窗（每次摘要兩呼叫，各次重送之前是一次重摘（兩次呼叫））。 */
  it('S6 超窗兩次：讀回一段，不是三段巢狀', async () => {
    const run = await converse({ behavior: (n) => (n === 4 || n === 7 ? 'overflow' : 'ok') });

    expect(run.snapshots[1]!.logCutoffs).toEqual([1, 2, 3]);
    expectReadBackFromLog(run);
    expect(run.snapshots[1]!.segments).toEqual([`${user(1)} | ${assistant(1)} | ${user(2)}`]);
    expect(derivedVersusActual(run).every((each) => each === 'EQ')).toBe(true);
  });
});

describe('生摘要的呼叫自己失敗：不留段落（S2）', () => {
  /** 呼叫：2 ＝ 摘要的第一次呼叫（條目，失敗，基座吞掉、照原請求送出）。 */
  it('失敗那輪讀不回任何段落；下一輪摘要只有一段，原文不重複', async () => {
    const run = await converse({ behavior: (n) => (n === 2 ? 'error' : 'ok') });

    // 前提：第 2 輪沒有摘要事件（摘要沒生出來）、輪次照常收尾。
    expect(run.snapshots[1]!.end).toBe('turn/end');
    expect(run.snapshots[1]!.logCutoffs).toEqual([]);

    expectReadBackFromLog(run);
    expect(run.snapshots[1]!.segments).toEqual([]);

    // 第 3 輪摘要成功：一段，第 1 句只出現一次。
    expect(run.snapshots[2]!.logCutoffs).toHaveLength(1);
    expect(run.snapshots[2]!.segments).toEqual([`${user(1)} | ${assistant(1)} | ${user(2)}`]);
    const lines = linesOf(run.snapshots[2]!.segments);
    expect(lines.filter((line) => line.includes('第 1 句'))).toHaveLength(1);
    expect(new Set(lines).size).toBe(lines.length);
    expect(derivedVersusActual(run).every((each) => each === 'EQ')).toBe(true);
  });
});

describe('摘要之後主請求失敗或被停：那一段讀得回來，下一輪接著它（S3、S4、S10）', () => {
  it('S3 主請求拋錯：失敗那輪那一段就在；下一輪的段落與它互不重複', async () => {
    const run = await converse({ behavior: (n) => (n === 4 ? 'error' : 'ok') });

    expect(run.snapshots[1]!.end).toBe('turn/failed');
    expectReadBackFromLog(run);
    expect(run.snapshots[1]!.segments).toEqual([user(1)]);

    expect(run.snapshots[2]!.segments).toEqual([user(1), assistant(1)]);
    const lines = linesOf(run.snapshots[2]!.segments);
    expect(new Set(lines).size).toBe(lines.length);
    expect(derivedVersusActual(run)).toEqual(['EQ', 'EQ', 'EQ']);
  });

  it('S4 使用者在摘要之後按停止：同上', async () => {
    const run = await converse({
      behavior: (n) => (n === 4 ? 'hang' : 'ok'),
      cancelAt: 4,
    });

    expect(run.snapshots[1]!.logCutoffs).toEqual([1]);
    expectReadBackFromLog(run);
    expect(run.snapshots[1]!.segments).toEqual([user(1)]);
    expect(run.snapshots[2]!.segments).toEqual([user(1), assistant(1)]);
    expect(derivedVersusActual(run)).toEqual(['EQ', 'EQ', 'EQ']);
  });

  /** 連續三輪摘要之後都失敗，第五輪才成功：四段，每一段只含新卸下的。 */
  it('S10 連續三次失敗再成功：每一段只含新卸下的內容', async () => {
    const run = await converse({
      behavior: (n) => (n === 4 || n === 7 || n === 10 ? 'error' : 'ok'),
      turns: 5,
    });

    expect(run.snapshots.map((s) => s.end)).toEqual([
      'turn/end',
      'turn/failed',
      'turn/failed',
      'turn/failed',
      'turn/end',
    ]);
    expectReadBackFromLog(run);
    // 每一輪結束時段落數逐輪加一，而且各段互不重複。
    expect(run.snapshots.map((s) => s.segments.length)).toEqual([0, 1, 2, 3, 4]);
    expect(run.snapshots[4]!.segments).toEqual([user(1), assistant(1), user(2), user(3)]);
    const lines = linesOf(run.snapshots[4]!.segments);
    expect(new Set(lines).size).toBe(lines.length);
    expect(derivedVersusActual(run).every((each) => each === 'EQ')).toBe(true);
  });
});

describe('沒有失敗（S0）', () => {
  it('每輪摘要成功，段落逐輪加一、互不重複', async () => {
    const run = await converse({ behavior: () => 'ok' });

    expectReadBackFromLog(run);
    expect(run.snapshots.map((s) => s.segments.length)).toEqual([0, 1, 2]);
    expect(run.snapshots[2]!.segments).toEqual([user(1), `${assistant(1)} | ${user(2)}`]);
    expect(derivedVersusActual(run)).toEqual(['EQ', 'EQ', 'EQ']);
  });
});

describe('子代理被摘掉的原文在它自己的日誌上', () => {
  const poke: PluginEntry = {
    plugin: {
      name: 'history-staging-poke',
      apply: (registry) =>
        void registry.tools.register(
          tool(() => 'poked', { name: 'poke', description: '戳一下。', schema: z.object({}) }),
        ),
    },
  };
  /** 任務描述墊長（#1396）：子代理第一次摘要取代的是它與兩次 `poke`，要比框好的摘要大才會提交。 */
  const TASK = `去做。${USER_PAD}`;

  /**
   * root 叫 `task`、子代理叫兩次 `poke`，訊息數門檻 4：root 只有三則不摘要，子代理到第 4 次請求時有五則、摘要。
   * 子代理的 `files` 會回灌到 root 的 state，所以 root 最終的 state 裡有沒有歷史檔，就是子代理有沒有寫。
   */
  async function delegate(summaryCalls: readonly ScriptedTurn[]) {
    const turns: ScriptedTurn[] = [
      {
        content: '',
        toolCalls: [
          { name: 'task', args: { description: TASK, subagent_type: 'general-purpose' } },
        ],
      },
      { content: '', toolCalls: [{ name: 'poke', args: {}, id: 'poke_a' }] },
      { content: '', toolCalls: [{ name: 'poke', args: {}, id: 'poke_b' }] },
      ...summaryCalls,
      { content: '子代理做完了。' },
      { content: '收工。' },
    ];
    const model = new ScriptedChatModel({ turns });
    const built = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' }),
      checkpointer: new MemorySaver(),
      plugins: [poke],
      summarization: { trigger: [{ type: 'messages', value: 4 }], retainTokens: 12 },
    });
    const sessions = new SessionRegistry('root-1');
    const detach = built.attachSession(sessions, {});
    try {
      await built.agent.invoke(toAgentInvocation('第 1 句。'), {
        configurable: { thread_id: 'sub-staging' },
      });
      const state = await (
        built.agent as unknown as { getState(config: unknown): Promise<{ values: unknown }> }
      ).getState({ configurable: { thread_id: 'sub-staging' } });
      const subagents = sessions.list().filter((entry) => entry.address.kind === 'subagent');
      expect(subagents).toHaveLength(1);
      const events = subagents[0]!.log.events;
      return {
        calls: model.prompts.length,
        files: Object.keys((state.values as { files?: Record<string, unknown> }).files ?? {}),
        filePaths: events
          .filter((event) => event.type === 'compaction/summary')
          .map((event) => (event.data as { filePath: string | null }).filePath),
        ...segmentsOf(events),
      };
    } finally {
      detach();
      await built.dispose();
    }
  }

  /** 呼叫順序：1 ＝ root（叫 task）、2、3 ＝ 子代理（叫 poke）、4、5 ＝ 子代理的摘要（條目、現況）、6 ＝ 子代理收尾、7 ＝ root 收尾。 */
  it('子代理摘要成功：原文從子代理的日誌讀回一段，沒有歷史檔回灌到 root 的 state', async () => {
    const run = await delegate([{ content: '本段對話\n- 戳了兩下' }, { content: '摘要一' }]);

    expect(run.calls).toBe(7);
    expect(run.filePaths).toEqual([null]);
    expect(run.failure).toBeUndefined();
    expect(run.segments).toEqual([
      `User: ${TASK} | Tool call poke: {} | Tool result (poke): poked`,
    ]);
    expect(run.files).toEqual([]);
  });

  /** 呼叫順序：同上，但 4 ＝ 子代理的摘要（條目，失敗，基座吞掉），沒有第二次摘要呼叫。 */
  it('子代理生摘要失敗：子代理的日誌上沒有摘要事件、讀不回段落，root 的 state 沒有歷史檔', async () => {
    const run = await delegate([{ content: '', error: 'upstream 503' }]);

    // 前提：六次呼叫都發生了（子代理真的走到摘要、摘要真的失敗過）。
    expect(run.calls).toBe(6);
    expect(run.filePaths).toEqual([]);
    expect(run.failure).toBeUndefined();
    expect(run.segments).toEqual([]);
    expect(run.files).toEqual([]);
  });
});
