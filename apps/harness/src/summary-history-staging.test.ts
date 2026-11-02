/**
 * **摘要歷史檔不留重複的原文**（[#1389](https://github.com/DemianLi/nexus-agent/issues/1389)）。
 *
 * 基座先把被換掉的原文寫進歷史檔、才生摘要、才送請求。`packages/nexus-core/src/summary-history-staging.ts` 把那個寫入
 * 暫存到這一步結束，再依「這一步有沒有生出摘要」提交。這裡走產品路徑（`ThreadPump` 管日誌、使用者訊息也進日誌），
 * 逐輪量 graph state（checkpoint 裡的 `files`）：
 *
 * | 情境 | 以前（`91c87252`） | 現在 |
 * | --- | --- | --- |
 * | S1 同一步內摘要後超窗、retain 0 重摘 | 兩段（第 1 句出現兩次） | 一段，內容是第二次的 |
 * | S6 超窗兩次 | 三段巢狀 | 一段 |
 * | S2 生摘要的呼叫自己失敗 | 檔寫了、沒有事件；下一輪再 append，原文兩份 | 不寫；下一輪一段 |
 * | S3／S4／S10 摘要後主請求失敗／被停 | 區段互不重複（#1390 之後） | **不變**：檔留著，下一輪接著它 |
 *
 * 最後一列是這一層刻意**不**動的：摘要生出來了、事件在日誌上，檔要在。
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
import { replayConversation, SessionRegistry } from '@nexus/core';
import type { PluginEntry } from '@nexus/core';
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
/** 日誌與歷史檔裡長出來的那兩種行。 */
const human = (n: number) => `Human: 第 ${String(n)} 句。${USER_PAD}`;
const reply = (n: number) => `AI: model, 第 ${String(n)} 次回話。${REPLY_PAD}`;

const SECTION = /## Summarized at [^\n]+\n\n/;
/**
 * 歷史檔在 checkpoint `files` 裡的鍵：`CompositeBackend` 把 `/conversation_history/` 路由前綴剝掉再交給
 * `StateBackend`（`agent-factory.ts` 的 `withConversationHistory`），所以是 `/session_<id>.md`，不帶前綴。
 */
const HISTORY_FILE = /^\/session_[^/]+\.md$/;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-history-staging-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Snapshot {
  readonly end: string | undefined;
  /** 這一輪結束後 checkpoint 裡所有歷史檔的區段（去掉標題行、換行換成 ` | `）。 */
  readonly sections: string[];
  /** 歷史檔的個數。 */
  readonly files: number;
  readonly logCutoffs: number[];
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
      const files = Object.entries(
        (state.values as { files?: Record<string, { content?: string }> }).files ?? {},
      ).filter(([path]) => HISTORY_FILE.test(path));
      const slice = pump.sessionLog.events.slice(before);
      const end = [...slice]
        .reverse()
        .find((event) => event.type === 'turn/end' || event.type === 'turn/failed');
      snapshots.push({
        end: end?.type,
        files: files.length,
        sections: files.flatMap(([, data]) =>
          (data.content ?? '')
            .split(SECTION)
            .map((text) => text.trim())
            .filter((text) => text !== '')
            .map((text) => text.replace(/\n/g, ' | ')),
        ),
        logCutoffs: slice
          .filter((event) => event.type === 'compaction/summary')
          .map((event) => (event.data as { cutoffIndex: number }).cutoffIndex),
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

/** 所有區段裡的每一行（`Human: …` 與 `AI: …`）：同一行出現兩次就是原文被抄了兩份。 */
const linesOf = (sections: readonly string[]) =>
  sections.flatMap((section) => section.split(' | '));

describe('同一步內重摘：最後一次勝出（S1、S6）', () => {
  /** 呼叫：1 ＝ 第 1 輪；2 ＝ 摘要、3 ＝ 摘要之後的請求（超窗）、4 ＝ retain 0 的摘要、5 ＝ 重送。 */
  it('S1 超窗一次：一段，內容是第二次嘗試的', async () => {
    const run = await converse({ behavior: (n) => (n === 3 ? 'overflow' : 'ok') });

    // 前提：真的走到了升級（日誌上兩筆事件、模型被叫了五次才進第 3 輪之前）。
    expect(run.snapshots[1]!.logCutoffs).toEqual([1, 2]);
    expect(run.snapshots[1]!.end).toBe('turn/end');

    expect(run.snapshots[1]!.sections).toEqual([`${human(1)} | ${reply(1)}`]);
    expect(run.snapshots[1]!.files).toBe(1);
    expect(derivedVersusActual(run)).toEqual(['EQ', 'EQ', 'EQ', 'EQ']);
  });

  /** 呼叫：3、5 超窗。 */
  it('S6 超窗兩次：一段，不是三段巢狀', async () => {
    const run = await converse({ behavior: (n) => (n === 3 || n === 5 ? 'overflow' : 'ok') });

    expect(run.snapshots[1]!.logCutoffs).toEqual([1, 2, 3]);
    expect(run.snapshots[1]!.sections).toEqual([`${human(1)} | ${reply(1)} | ${human(2)}`]);
    expect(run.snapshots[1]!.files).toBe(1);
    expect(derivedVersusActual(run).every((each) => each === 'EQ')).toBe(true);
  });
});

describe('生摘要的呼叫自己失敗：不留檔（S2）', () => {
  /** 呼叫：2 ＝ 摘要那次（失敗，基座吞掉、照原請求送出）。 */
  it('失敗那輪不寫檔；下一輪摘要只有一段，原文不重複', async () => {
    const run = await converse({ behavior: (n) => (n === 2 ? 'error' : 'ok') });

    // 前提：第 2 輪沒有摘要事件（摘要沒生出來）、輪次照常收尾。
    expect(run.snapshots[1]!.end).toBe('turn/end');
    expect(run.snapshots[1]!.logCutoffs).toEqual([]);

    expect(run.snapshots[1]!.files).toBe(0);
    expect(run.snapshots[1]!.sections).toEqual([]);

    // 第 3 輪摘要成功：一個檔、一段，第 1 句只出現一次。
    expect(run.snapshots[2]!.logCutoffs).toHaveLength(1);
    expect(run.snapshots[2]!.files).toBe(1);
    const lines = linesOf(run.snapshots[2]!.sections);
    expect(lines.filter((line) => line.includes('第 1 句'))).toHaveLength(1);
    expect(new Set(lines).size).toBe(lines.length);
    expect(derivedVersusActual(run).every((each) => each === 'EQ')).toBe(true);
  });
});

describe('摘要之後主請求失敗或被停：檔留著，下一輪接著它（S3、S4、S10）', () => {
  it('S3 主請求拋錯：失敗那輪檔就在；下一輪的區段與它互不重複', async () => {
    const run = await converse({ behavior: (n) => (n === 3 ? 'error' : 'ok') });

    expect(run.snapshots[1]!.end).toBe('turn/failed');
    expect(run.snapshots[1]!.sections).toEqual([human(1)]);

    expect(run.snapshots[2]!.sections).toEqual([human(1), reply(1)]);
    const lines = linesOf(run.snapshots[2]!.sections);
    expect(new Set(lines).size).toBe(lines.length);
    expect(derivedVersusActual(run)).toEqual(['EQ', 'EQ', 'EQ']);
  });

  it('S4 使用者在摘要之後按停止：同上', async () => {
    const run = await converse({
      behavior: (n) => (n === 3 ? 'hang' : 'ok'),
      cancelAt: 3,
    });

    expect(run.snapshots[1]!.logCutoffs).toEqual([1]);
    expect(run.snapshots[1]!.sections).toEqual([human(1)]);
    expect(run.snapshots[2]!.sections).toEqual([human(1), reply(1)]);
    expect(derivedVersusActual(run)).toEqual(['EQ', 'EQ', 'EQ']);
  });

  /** 連續三輪摘要之後都失敗，第五輪才成功：四段，每一段只含新卸下的。 */
  it('S10 連續三次失敗再成功：每一段只含新卸下的內容', async () => {
    const run = await converse({
      behavior: (n) => (n === 3 || n === 5 || n === 7 ? 'error' : 'ok'),
      turns: 5,
    });

    expect(run.snapshots.map((s) => s.end)).toEqual([
      'turn/end',
      'turn/failed',
      'turn/failed',
      'turn/failed',
      'turn/end',
    ]);
    // 每一輪結束時區段數逐輪加一，而且各段互不重複。
    expect(run.snapshots.map((s) => s.sections.length)).toEqual([0, 1, 2, 3, 4]);
    const lines = linesOf(run.snapshots[4]!.sections);
    expect(new Set(lines).size).toBe(lines.length);
    expect(derivedVersusActual(run).every((each) => each === 'EQ')).toBe(true);
  });
});

describe('沒有失敗：行為不變（S0）', () => {
  it('每輪摘要成功，區段逐輪加一、互不重複', async () => {
    const run = await converse({ behavior: () => 'ok' });

    expect(run.snapshots.map((s) => s.sections.length)).toEqual([0, 1, 2]);
    expect(run.snapshots[2]!.sections).toEqual([human(1), `${reply(1)} | ${human(2)}`]);
    expect(derivedVersusActual(run)).toEqual(['EQ', 'EQ', 'EQ']);
  });
});

describe('子代理的摘要器用自己那一份暫存', () => {
  /**
   * root 叫 `task`、子代理叫兩次 `poke`，訊息數門檻 4：root 只有三則不摘要，子代理到第 4 次請求時有五則、摘要。
   * 那次生摘要的呼叫失敗（基座吞掉）。子代理的 `files` 會回灌到 root 的 state，所以
   * root 最終的 state 裡有沒有歷史檔，就是子代理那次寫入有沒有留下。
   *
   * 呼叫順序：1 ＝ root（叫 task）、2、3 ＝ 子代理（叫 poke）、4 ＝ 子代理的摘要（失敗）、5 ＝ 子代理收尾、6 ＝ root 收尾。
   */
  it('子代理生摘要失敗：沒有歷史檔回灌到 root 的 state', async () => {
    const poke: PluginEntry = {
      plugin: {
        name: 'history-staging-poke',
        apply: (registry) =>
          void registry.tools.register(
            tool(() => 'poked', { name: 'poke', description: '戳一下。', schema: z.object({}) }),
          ),
      },
    };
    const turns: ScriptedTurn[] = [
      {
        content: '',
        toolCalls: [
          { name: 'task', args: { description: '去做。', subagent_type: 'general-purpose' } },
        ],
      },
      { content: '', toolCalls: [{ name: 'poke', args: {}, id: 'poke_a' }] },
      { content: '', toolCalls: [{ name: 'poke', args: {}, id: 'poke_b' }] },
      { content: '', error: 'upstream 503' },
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
      const files = Object.keys(
        (state.values as { files?: Record<string, unknown> }).files ?? {},
      ).filter((path) => HISTORY_FILE.test(path));

      // 前提：六次呼叫都發生了（子代理真的走到摘要、摘要真的失敗過）。
      expect(model.prompts).toHaveLength(6);
      expect(files).toEqual([]);
    } finally {
      detach();
      await built.dispose();
    }
  });
});
