/**
 * 離線起草——[#280](https://github.com/DemianLi/nexus-agent/issues/280) 的驗收。
 *
 * 前半是手寫的事件，量規則；後半是**真的組裝寫出來的 jsonl**：輪的起頭、`resume` 併回去、跑壞與
 * 打轉都是執行期自己寫的，手寫的 fixture 證明不了它們的 `seq` 與先後跟規則對得上。
 *
 * **零憑證、零外部連線**：模型是 `LoopingChatModel` 與 `ScriptedChatModel`。
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { attachSessionPersistence, SESSION_LOG_FORMAT_VERSION } from '@nexus/core';
import type { NexusPlugin, SessionEvent } from '@nexus/core';
import { createEchoPlugin, ECHO_TOOL_NAME } from '@nexus/plugin-echo';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createNexusAgent } from '../agent-factory.js';
import { createJsonlSessionStore } from '../jsonl-session-store.js';
import { LoopingChatModel } from '../looping-model.js';
import { ScriptedChatModel } from '../scripted-model.js';
import { ThreadPump } from '../thread-pump.js';
import type { PumpAgent } from '../thread-pump.js';
import { draftSessionLog, formatDraftReport, rankDrafts } from './session-draft.js';
import type { DraftTurn, SessionDrafts } from './session-draft.js';
import { readSessionLogs, scanSessionLog } from './session-scan.js';
import type { LoadedSessionLog } from './session-scan.js';

/** 一顆手寫的事件：種類與酬載。 */
type Entry = readonly [type: string, data: Record<string, unknown>];

/** 排好 `seq` 的一份日誌。 */
function events(entries: readonly Entry[]): SessionEvent[] {
  return entries.map(
    ([type, data], seq) => ({ type, seq, time: seq, data }) as unknown as SessionEvent,
  );
}

let nextCall = 0;
/** 一次呼叫，`callId` 每次新的。 */
function call(name: string, args: Record<string, unknown>, callId = `c${nextCall++}`): Entry {
  return ['tool/call', { callId, name, arguments: JSON.stringify(args) }];
}

/** 同一個工具同一份參數，叫 n 次。 */
function same(n: number, name = 'grep'): Entry[] {
  return Array.from({ length: n }, () => call(name, { pattern: 'x' }));
}

const say = (text: string): Entry => ['turn/start', { kind: 'message', text }];
const resume: Entry = ['turn/start', { kind: 'resume' }];
const end: Entry = ['turn/end', {}];
const aborted: Entry = ['turn/end', { reason: { kind: 'aborted', cause: { kind: 'user' } } }];
const failed = (message: string): Entry => ['turn/failed', { message }];

function put(turn: number, rating: 'positive' | 'negative', note?: string): Entry {
  return [
    'feedback/message-put',
    {
      item: {
        turn,
        rating,
        ...(note !== undefined && { note }),
        version: `v-${turn}-${rating}`,
        createdAt: 0,
        updatedAt: 0,
      },
    },
  ];
}

function log(
  entries: readonly Entry[],
  options: { id?: string; version?: number; parentSession?: string } = {},
): LoadedSessionLog {
  const id = options.id ?? 's';
  return {
    file: `/logs/${id}.jsonl`,
    header: {
      id,
      version: options.version ?? SESSION_LOG_FORMAT_VERSION,
      ...(options.parentSession !== undefined && { parentSession: options.parentSession }),
    },
    events: events(entries),
  };
}

const draft = (
  entries: readonly Entry[],
  options: { id?: string; version?: number; parentSession?: string } = {},
): SessionDrafts => draftSessionLog(log(entries, options));

const candidates = (drafts: SessionDrafts): DraftTurn[] =>
  drafts.turns.filter((turn) => turn.signals.length > 0);

const report = (sessions: readonly SessionDrafts[]): string =>
  formatDraftReport(sessions, [], { threshold: 5 }).join('\n');

describe('輪的單位：起頭那顆不是 resume 的 turn/start', () => {
  it('resume 那一段併回起頭那一輪：它的呼叫、結果與中止都算在起頭上', () => {
    const drafts = draft([
      say('做危險的事'),
      call('danger', {}, 'd'),
      ['interrupt/raised', { interruptId: 'i' }],
      end,
      resume,
      // 核准之後以同一個 callId 再記一顆——不多算一次。
      call('danger', {}, 'd'),
      ['tool/result', { callId: 'd', isError: true, error: { code: 'ABORTED' } }],
      aborted,
    ]);
    expect(drafts.turns).toHaveLength(1);
    expect(drafts.turns[0]).toMatchObject({
      seq: 0,
      ordinal: 1,
      text: '做危險的事',
      signals: ['aborted'],
      toolCalls: [{ name: 'danger', result: { isError: true, code: 'ABORTED' } }],
    });
    expect(drafts.turns[0]?.toolCalls).toHaveLength(1);
  });

  it('session/end-seed 收掉當下那一輪：之後到下一顆起頭之前的事件不歸任何一輪', () => {
    const drafts = draft([
      say('上一個行程'),
      ['session/end-seed', {}],
      failed('沒有輪可歸'),
      say('這個行程'),
      failed('爆了'),
    ]);
    expect(drafts.turns.map((turn) => [turn.seq, turn.failures])).toEqual([
      [0, []],
      [3, ['爆了']],
    ]);
  });

  it('一種信號都沒命中的輪不起草', () => {
    const drafts = draft([
      say('打招呼'),
      call('echo', { message: 'hi' }, 'e'),
      ['tool/result', { callId: 'e', isError: false }],
      end,
    ]);
    expect(drafts.turns).toHaveLength(1);
    expect(candidates(drafts)).toEqual([]);
    expect(report([drafts])).toContain('// 沒有命中任何信號的輪。');
  });
});

describe('四種信號', () => {
  it('點踩：每一輪取最後狀態，收回的、改成讚的都不算；備註帶著走', () => {
    const drafts = draft([
      say('一'),
      end,
      say('二'),
      end,
      say('三'),
      end,
      put(0, 'negative', '改錯檔了'),
      put(2, 'negative'),
      put(2, 'positive'),
      put(4, 'negative'),
      ['feedback/message-delete', { turn: 4 }],
    ]);
    expect(candidates(drafts).map((turn) => [turn.seq, turn.signals, turn.rating?.note])).toEqual([
      [0, ['negative'], '改錯檔了'],
    ]);
  });

  it('取消與失敗各自入選，失敗的訊息照順序留著', () => {
    // 真的訊息常以換行收尾（LangGraph 的遞迴上限那段就是）：留著原樣，印的時候才修掉尾巴。
    const drafts = draft([
      say('停'),
      aborted,
      say('跑'),
      failed('Recursion limit of 20 reached\n'),
    ]);
    expect(candidates(drafts).map((turn) => [turn.text, turn.signals, turn.failures])).toEqual([
      ['停', ['aborted'], []],
      ['跑', ['failed'], ['Recursion limit of 20 reached\n']],
    ]);
    expect(report([drafts]).split('\n')).toContain('// 失敗：Recursion limit of 20 reached');
  });

  it('打轉以輪為單位：兩輪各叫幾次不湊在一起，resume 那一段接得上', () => {
    const split = draft([say('a'), ...same(2), end, say('b'), ...same(5), end]);
    expect(
      candidates(split).map((turn) => [turn.text, turn.signals, turn.longestRun?.count]),
    ).toEqual([['b', ['looping'], 5]]);
    const merged = draft([say('a'), ...same(3), end, resume, ...same(2), end]);
    expect(candidates(merged).map((turn) => [turn.text, turn.longestRun?.count])).toEqual([
      ['a', 5],
    ]);
  });

  /**
   * 被核准閘門停下的那次，resume 之後以同一個 `callId` 再記一顆。`toolCalls` 是照 `callId` 收的，
   * 重記不重記看不出差別——**差別在鏈**：不去重的話每一次核准都讓鏈多一格，4 次會被讀成 5 次。
   */
  it('同一個 callId 重記不推進鏈：核准一次不會把 4 次讀成打轉', () => {
    const drafts = draft([
      say('a'),
      ...same(3),
      call('grep', { pattern: 'x' }, 'gated'),
      ['interrupt/raised', { interruptId: 'i' }],
      end,
      resume,
      call('grep', { pattern: 'x' }, 'gated'),
      ['tool/result', { callId: 'gated', isError: false }],
      end,
    ]);
    expect(drafts.turns[0]).toMatchObject({ signals: [], longestRun: { count: 4 } });
  });

  /**
   * **檔頭那句「鏈清零的地方就是輪的邊界」的絆索。** 兩邊哪天各自改了邊界，這裡的最大值就對不上。
   */
  it('逐輪的最長串取最大，等於 scan 的逐份最長串', () => {
    const fixtures: Entry[][] = [
      [say('a'), ...same(2), say('b'), ...same(4)],
      [say('a'), ...same(3), resume, ...same(3), ['session/end-seed', {}], say('b'), ...same(2)],
      [say('a'), ...same(2), call('grep', { pattern: 'y' }), ...same(2)],
      [say('a'), ...same(2), end, say('b'), end, resume, ...same(1)],
    ];
    for (const entries of fixtures) {
      const loaded = log(entries);
      const longest = Math.max(
        0,
        ...draftSessionLog(loaded).turns.map((turn) => turn.longestRun?.count ?? 0),
      );
      expect(longest).toBe(scanSessionLog(loaded).longestRun?.count ?? 0);
    }
  });

  it('舊版格式沒記的信號講明，不當成沒命中', () => {
    expect(draft([say('a')]).unrecorded).toEqual([]);
    expect(draft([say('a')], { version: 7 }).unrecorded).toEqual(['negative']);
    expect(draft([say('a')], { version: 6 }).unrecorded).toEqual(['negative', 'aborted']);
    expect(draft([say('a')], { version: 4 }).unrecorded).toEqual([
      'negative',
      'aborted',
      'looping',
    ]);
    expect(report([draft([say('a')], { id: 'old', version: 6 })])).toContain(
      '//   old（格式版本 6）：沒記 點踩、取消',
    );
  });
});

describe('排序：先比命中幾種，同數時 點踩 > 取消 > 失敗 > 打轉', () => {
  it('兩種的一律在一種的前面；同數逐位比', () => {
    const sessions = [
      draft([say('只打轉'), ...same(5), end], { id: 'a' }),
      draft([say('取消＋失敗'), failed('x'), aborted], { id: 'b' }),
      draft([say('只點踩'), end, put(0, 'negative')], { id: 'c' }),
      draft([say('點踩＋打轉'), ...same(5), end, put(0, 'negative')], { id: 'd' }),
      draft([say('只取消'), aborted], { id: 'e' }),
      draft([say('只失敗'), failed('y')], { id: 'f' }),
    ];
    expect(rankDrafts(sessions).map(({ turn }) => turn.text)).toEqual([
      '點踩＋打轉',
      '取消＋失敗',
      '只點踩',
      '只取消',
      '只失敗',
      '只打轉',
    ]);
  });
});

describe('草稿', () => {
  /**
   * **判準是真的拿去執行**：比對字串只證明印了什麼，證明不了貼進 `dataset.ts` 之後還是合法的程式碼。
   * prompt 與備註刻意帶換行、引號與 `*\/`——註解與字串的跳脫壞了，這裡會拋或還原不回原字串。
   */
  it('整份輸出貼進陣列是合法的程式碼，prompt 原樣還原', () => {
    const prompt = '第一行\n第二行 "雙引號" \'單引號\' `反引號` */ 結尾';
    const drafts = draft(
      [
        say(prompt),
        call('echo', { message: '換\n行' }, 'e'),
        failed('爆了\n第二行'),
        put(0, 'negative', '備註\n換行 */'),
        ['feedback/record', { text: '會話\n評語' }],
      ],
      { id: 'cli/3' },
    );
    const text = report([drafts]);
    const parsed = new Function(`return [\n${text}\n];`)() as unknown;
    expect(parsed).toEqual([{ id: 'draft-cli-3-0', prompt, expected: { toolCalls: [] } }]);
  });

  it('實際呼叫照順序列，連續同一顆摺成 × n，錯誤帶碼、沒落定的講明', () => {
    const drafts = draft([
      say('找東西'),
      call('read_file', { file_path: '/a.md' }, 'r'),
      ['tool/result', { callId: 'r', isError: true, error: { code: 'INVALID_ARGS' } }],
      call('echo', { message: 'x' }, 'e'),
      ['tool/result', { callId: 'e', isError: true }],
      ...same(5),
    ]);
    const text = report([drafts]);
    expect(text).toContain('//   1. read_file {"file_path":"/a.md"} ✗ INVALID_ARGS');
    expect(text).toContain('//   2. echo {"message":"x"} ✗ 無碼');
    expect(text).toContain('//   3. grep {"pattern":"x"} …未落定 × 5');
    expect(text).toContain('// 打轉：grep × 5 {"pattern":"x"}');
  });

  it('/feedback 印在該會話第一份草稿前面；沒有候選輪的會話另列在最後', () => {
    const loud = draft(
      [say('壞了'), failed('x'), ['feedback/record', { text: '整段都很慢', category: 'slow' }]],
      { id: 'loud' },
    );
    const quiet = draft([say('好好的'), end, ['feedback/record', {}]], { id: 'quiet' });
    const lines = formatDraftReport([quiet, loud], [], { threshold: 5 });
    const at = (needle: string): number => lines.findIndex((line) => line.includes(needle));
    expect(at('〔slow〕整段都很慢')).toBeGreaterThan(at('會話 loud'));
    expect(at('〔slow〕整段都很慢')).toBeLessThan(at("id: 'draft-loud-0'"));
    expect(at('會話 quiet')).toBeGreaterThan(at("id: 'draft-loud-0'"));
    expect(lines).toContain('// /feedback：（沒寫內容）');
  });

  it('子代理那幾份不起草，份數報出來', () => {
    const root = draft([say('委派'), end], { id: 'root' });
    const sub = draft(same(6), { id: 'root/sub-1', parentSession: 'root' });
    expect(report([root, sub])).toContain('// 起草：2 份日誌（子代理 1 份不起草），候選 0 輪。');
  });

  it('goal 續行輪次標出來：prompt 是機器排的', () => {
    const drafts = draft([
      ['turn/start', { kind: 'goal', text: '繼續完成目標', goalId: 'g', revision: 1, round: 2 }],
      failed('x'),
    ]);
    expect(candidates(drafts)[0]).toMatchObject({ kind: 'goal', text: '繼續完成目標' });
    expect(report([drafts])).toContain('// goal 續行輪次：prompt 是機器排的，不是人說的話。');
  });
});

/**
 * 真的組裝接上 pump 與 JSONL 後端（serve 那條路的形狀），跑完之後起草 root 那一份。
 *
 * @returns root 那一份起草的結果，與它原樣的事件。
 */
async function runAndDraft(
  model: ScriptedChatModel | LoopingChatModel,
  plugins: readonly NexusPlugin[],
  drive: (pump: ThreadPump) => Promise<void>,
  options: { recursionLimit?: number } = {},
): Promise<{ drafts: SessionDrafts; root: readonly SessionEvent[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-draft-live-'));
  const store = createJsonlSessionStore({ rootDir: dir });
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    plugins: [...plugins],
    summarization: false,
    ...(options.recursionLimit !== undefined && { recursionLimit: options.recursionLimit }),
  });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'draft-root');
  const detach = built.attachSession(pump.sessions);
  const persistence = attachSessionPersistence(pump.sessions, store);
  try {
    await drive(pump);
  } finally {
    await persistence.dispose();
    detach();
    await built.dispose();
  }
  const { logs, unreadable } = await readSessionLogs([store.directory]);
  expect(unreadable).toEqual([]);
  const root = logs.find((entry) => entry.header.id === 'draft-root');
  if (root === undefined) throw new Error('root 那一份沒寫出來');
  return { drafts: draftSessionLog(root), root: root.events };
}

describe('跟真的組裝對得上', () => {
  it('迴圈撞到遞迴上限：pump 寫的 turn/failed 與打轉都落在那一輪，prompt 是人說的那句', async () => {
    const { drafts } = await runAndDraft(
      new LoopingChatModel({ toolName: ECHO_TOOL_NAME }),
      [createEchoPlugin()],
      async (pump) => {
        await expect(pump.submit({ kind: 'message', text: '一直跑' })).rejects.toThrow(
          /Recursion limit/,
        );
      },
      { recursionLimit: 20 },
    );
    const found = candidates(drafts);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ text: '一直跑', signals: ['failed', 'looping'] });
    expect(found[0]?.failures[0]).toMatch(/Recursion limit/);
  });

  /**
   * **前提先斷言**：真的日誌上是 message、resume、message 三顆 `turn/start`。不然「resume 併回去」
   * 量的是一件沒發生的事。點踩直接 append 進 root 那份——那正是 `@nexus/plugin-feedback` 寫的
   * 事件；這裡要量的是它指的 `seq` 是執行期寫的那顆起頭。
   */
  it('停在核准點再 resume：那一段併回起頭那一輪，點踩綁在起頭那顆的 seq 上', async () => {
    const tools: NexusPlugin = {
      name: 'draft-tools',
      apply(registry) {
        registry.tools.register(
          tool(() => '做完了', { name: 'danger', description: '要核准。', schema: z.object({}) }),
        );
        registry.approvals.gate((exec, next) =>
          exec.name === 'danger' ? { kind: 'ask', reason: '危險' } : next(),
        );
      },
    };
    const model = new ScriptedChatModel({
      turns: [
        { content: '動手。', toolCalls: [{ name: 'danger', args: {} }] },
        { content: '好了。' },
        { content: '不客氣。' },
      ],
    });
    const { drafts, root } = await runAndDraft(model, [tools], async (pump) => {
      await pump.submit({ kind: 'message', text: '做危險的事' });
      await pump.submit({
        kind: 'resume',
        interruptId: pump.pendings[0]?.interruptId ?? '',
        response: { decisions: [{ type: 'approve' }] },
      });
      await pump.submit({ kind: 'message', text: '謝了' });
      const origin = pump.sessions.root.events.find((event) => event.type === 'turn/start');
      pump.sessions.root.append('feedback/message-put', {
        item: {
          turn: origin?.seq ?? -1,
          rating: 'negative',
          note: '不該做',
          version: 'v1',
          createdAt: 0,
          updatedAt: 0,
        },
      });
    });
    expect(root.flatMap((event) => (event.type === 'turn/start' ? [event.data.kind] : []))).toEqual(
      ['message', 'resume', 'message'],
    );
    expect(drafts.turns.map((turn) => turn.text)).toEqual(['做危險的事', '謝了']);
    const found = candidates(drafts);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      text: '做危險的事',
      signals: ['negative'],
      rating: { note: '不該做' },
      toolCalls: [{ name: 'danger', result: { isError: false } }],
    });
    expect(found[0]?.toolCalls).toHaveLength(1);
  });
});
