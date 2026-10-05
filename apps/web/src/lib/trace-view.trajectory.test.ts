import type { ConversationState, TrajectoryApproval, TrajectoryReply } from '@nexus/wire';
import {
  REQUEST_SNAPSHOTS_PROJECTION,
  REQUEST_SNAPSHOTS_VERSION,
  TRAJECTORY_PROJECTION,
  TRAJECTORY_VERSION,
  emptyConversation,
  reduceAll,
} from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { appendDecision } from '@nexus/wire';
import { Script } from '@/test/conversation-frames';
import {
  call,
  decision,
  digest,
  projectionFrame,
  tool,
  turn,
  view,
  withTrajectory,
} from '@/test/trajectory-fixtures';
import {
  TRACE_LIMITS,
  TRACE_STRUCTURED_LIMITS,
  sameRow,
  traceModel,
  traceTurns,
  turnSeqOfMessage,
} from '@/lib/trace-view';
import type { TraceRow } from '@/lib/trace-view';

const kinds = (rows: readonly TraceRow[]) => rows.map((row) => row.kind);
const reply = (seq: number, messageId: string | undefined, chars = 5): TrajectoryReply => ({
  seq,
  time: 1_700_000_000_000 + seq,
  ...(messageId === undefined ? {} : { messageId }),
  textChars: chars,
  reasoningChars: 0,
  toolCalls: 0,
});

/**
 * 兩輪、即時的形狀（探針量過）：人話是 `inbox:<runId>`、回覆的條目 id 是 run id 而 `messageId` 是 `run-<id>`、
 * 工具是 `tool-<callId>`。第二輪沒有任何工具。
 */
function live() {
  const script = new Script();
  const state = reduceAll(emptyConversation(), [
    script.running(),
    ...script.human('inbox:r1', '第一輪'),
    ...script.ai('a1', { reasoning: '先看看' }),
    script.started('c1', 'ls', { path: '/' }),
    script.finished('c1', 'ok'),
    ...script.ai('a2', { text: '看完了' }),
    script.completed(),
    script.running(),
    ...script.human('inbox:r2', '第二輪'),
    ...script.ai('b1', { text: '好的' }),
    script.completed(),
  ]);
  const trajectory = view([
    turn(0, {
      calls: [
        call(5, { reply: reply(11, 'run-a1'), tools: [tool('c1')] }),
        call(16, { reply: reply(18, 'run-a2') }),
      ],
    }),
    turn(1, { calls: [call(32, { reply: reply(34, 'run-b1') })] }),
  ]);
  return { script, state, trajectory };
}

describe('traceModel：結構化模式的歸位', () => {
  it('輪界由成員決定：人話歸給它後面第一個歸得進去的條目所在的輪', () => {
    const { script, state, trajectory } = live();
    const model = traceModel(withTrajectory(state, script, trajectory));
    expect(model.structured).toBe(true);
    expect(model.turns.map((t) => [t.legacy, t.head?.number])).toEqual([
      [false, 1],
      [false, 2],
    ]);
    expect(kinds(model.turns[0]!.rows)).toEqual([
      'input',
      'call',
      'thinking',
      'tool',
      'call',
      'reply',
    ]);
    expect(kinds(model.turns[1]!.rows)).toEqual(['input', 'call', 'reply']);
  });

  it('歷史的形狀（條目 id 是 history-<seq>，回覆沒有 messageId）照樣歸得進去', () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('history-2', '第一輪'),
      ...script.ai('history-11', { text: '好' }),
      script.completed(),
    ]);
    const trajectory = view([turn(0, { calls: [call(5, { reply: reply(11, undefined) })] })]);
    const model = traceModel(withTrajectory(state, script, trajectory));
    expect(model.turns).toHaveLength(1);
    expect(kinds(model.turns[0]!.rows)).toEqual(['input', 'call', 'reply']);
  });

  it('目標自己排的輪沒有人話，也是自己一組（取代第 0 版限制 1 的釘子）', () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('inbox:r1', '第一輪'),
      ...script.ai('a1', { text: '好' }),
      script.completed(),
      script.running(),
      // 目標排的一輪：沒有人話。
      ...script.ai('g1', { text: '目標繼續做' }),
      script.completed(),
    ]);
    const trajectory = view([
      turn(0, { calls: [call(5, { reply: reply(11, 'run-a1') })] }),
      turn(1, { kind: 'goal', calls: [call(20, { reply: reply(22, 'run-g1') })] }),
    ]);
    const model = traceModel(withTrajectory(state, script, trajectory));
    expect(model.turns).toHaveLength(2);
    expect(model.turns[1]!.head?.kind).toBe('goal');
    expect(kinds(model.turns[1]!.rows)).toEqual(['call', 'reply']);
    // 同一份對話在沒有投影時（第 0 版）仍黏在前一輪——那條限制還在、仍寫在畫面上。
    expect(traceTurns(state)).toHaveLength(1);
  });

  it('工具按 callId 歸位，不是跟著前一個條目走：晚到的工具列照樣歸給它自己的那次呼叫', () => {
    const script = new Script();
    // 兩則回覆都先到，工具條目排在第二則回覆後面（例如長時間執行的工具，結果晚到）。
    const state = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('inbox:r1', '問'),
      ...script.ai('a1', { reasoning: '想' }),
      ...script.ai('a2', { text: '又想' }),
      script.started('c1', 'ls', {}),
      script.finished('c1', 'ok'),
      script.completed(),
    ]);
    const trajectory = view([
      turn(0, {
        calls: [
          call(5, { reply: reply(11, 'run-a1'), tools: [tool('c1')] }),
          call(16, { reply: reply(18, 'run-a2') }),
        ],
      }),
    ]);
    const [only] = traceModel(withTrajectory(state, script, trajectory)).turns;
    // 工具列在第一次呼叫的段落裡（第二個呼叫段落之前），而不是掉進最後一次呼叫。
    expect(kinds(only!.rows)).toEqual(['input', 'call', 'thinking', 'tool', 'call', 'reply']);
  });

  it('輪中插進來的人話留在發生的位置（上一次呼叫的工具之後），不退回那一輪的開頭', () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('inbox:r1', '先做這個'),
      ...script.ai('a1', { reasoning: '想' }),
      script.started('c1', 'ls', {}),
      script.finished('c1', 'ok'),
      ...script.human('inbox:steer', '不對，改做那個'),
      ...script.ai('a2', { text: '改了' }),
      script.completed(),
    ]);
    const trajectory = view([
      turn(0, {
        calls: [
          call(5, { reply: reply(11, 'run-a1'), tools: [tool('c1')] }),
          call(16, { reply: reply(18, 'run-a2') }),
        ],
      }),
    ]);
    const [only, ...rest] = traceModel(withTrajectory(state, script, trajectory)).turns;
    expect(rest).toHaveLength(0);
    // 插話發生在第一次呼叫的工具之後、第二次呼叫開始之前，所以排在第二個呼叫段落之前。
    expect(kinds(only!.rows)).toEqual([
      'input',
      'call',
      'thinking',
      'tool',
      'input',
      'call',
      'reply',
    ]);
  });
});

describe('traceModel：兩個方向的對不上', () => {
  it('窗口之前、不在任何一輪裡的條目：照第 0 版以人那一句切成組，標 legacy，排在最前面', () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('history-0', '很久以前'),
      ...script.ai('history-3', { text: '舊回覆' }),
      script.completed(),
      script.running(),
      ...script.human('history-6', '也是很久以前'),
      ...script.ai('history-9', { text: '舊回覆二' }),
      script.completed(),
      script.running(),
      ...script.human('inbox:r1', '第一輪'),
      ...script.ai('a1', { text: '好' }),
      script.completed(),
    ]);
    const trajectory = view([turn(7, { calls: [call(5, { reply: reply(11, 'run-a1') })] })]);
    const model = traceModel(withTrajectory(state, script, trajectory));
    expect(model.turns.map((t) => [t.legacy, t.head?.number ?? null])).toEqual([
      [true, null],
      [true, null],
      [false, 1],
    ]);
    // 舊的兩組是以人那一句切的：各自一句話、一則回覆。
    expect(kinds(model.turns[0]!.rows)).toEqual(['input', 'reply']);
    expect(kinds(model.turns[1]!.rows)).toEqual(['input', 'reply']);
    // 窗口裡的輪不被它們吃掉。
    expect(kinds(model.turns[2]!.rows)).toEqual(['input', 'call', 'reply']);
  });

  it('投影有、條目沒載入的輪：標題與呼叫段落照畫，沒有內文列，呼叫標「沒載入」', () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [script.running(), script.completed()]);
    const trajectory = view([
      turn(0, {
        calls: [call(5, { reply: reply(11, 'run-x'), tools: [tool('c1')] })],
      }),
    ]);
    const [only] = traceModel(withTrajectory(state, script, trajectory)).turns;
    expect(only!.head?.number).toBe(1);
    expect(kinds(only!.rows)).toEqual(['call']);
    const row = only!.rows[0] as Extract<TraceRow, { kind: 'call' }>;
    expect(row.hasContent).toBe(true);
    expect(row.loaded).toBe(false);
    expect(row.target).toBeUndefined();
  });

  it('窗口外的輪只剩摘要：digests 與 omitted 原樣帶出，沒有定位用的鍵', () => {
    const { script, state, trajectory } = live();
    const model = traceModel(
      withTrajectory(state, script, {
        ...trajectory,
        digests: [digest(20), digest(21)],
        omitted: 7,
      }),
    );
    // 被省略的 7 輪當成邏輯輪，摘要接著編 8、9。
    expect(model.digests.map((d) => [d.key, d.number, d.callCount])).toEqual([
      ['digest-20', 8, 2],
      ['digest-21', 9, 2],
    ]);
    expect(model.omitted).toBe(7);
  });

  it('投影還沒跟上的最新一句：開在最新那個沒有成員、還沒結束的輪；更早的沒鍵人話是舊對話，退回第 0 版', () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('inbox:r1', '剛送出'),
      ...script.human('inbox:r2', '又一句'),
    ]);
    const trajectory = view([turn(0, { end: undefined as never, calls: [] })]);
    const model = traceModel(withTrajectory(state, script, trajectory));
    expect(model.turns.map((t) => [t.legacy, kinds(t.rows)])).toEqual([
      [true, ['input']],
      [false, ['input']],
    ]);
  });

  it('最新那一輪已經結束、條目沒載入時，更晚的人話不會被認領進去', () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('inbox:r1', '新的一句'),
    ]);
    const trajectory = view([turn(0, { end: 'completed', calls: [call(5)] })]);
    const model = traceModel(withTrajectory(state, script, trajectory));
    expect(model.turns.map((t) => [t.legacy, kinds(t.rows)])).toEqual([
      [false, ['call']],
      [true, ['input']],
    ]);
  });

  it('還在吐字、還在跑的條目歸給進行中的那次呼叫，回覆落地時不會從段落上方跳到下方', () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('inbox:r1', '問'),
      script.openAi('a1'),
      script.delta('a1', '講到一半'),
    ]);
    // 呼叫已開（model/start），回覆還沒進日誌。
    const trajectory = view([
      turn(0, { end: undefined as never, calls: [call(5, { endTime: undefined as never })] }),
    ]);
    const [only] = traceModel(withTrajectory(state, script, trajectory)).turns;
    expect(kinds(only!.rows)).toEqual(['input', 'call', 'reply']);
  });

  it('最後一次呼叫已經有回覆時，歸不進去的 root 條目不硬塞給它：留在這一輪的開頭、不猜', () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('inbox:r1', '問'),
      ...script.ai('x1', { text: '這則的 messageId 對不上任何一次呼叫' }),
    ]);
    const trajectory = view([
      turn(0, { end: undefined as never, calls: [call(5, { reply: reply(11, 'run-other') })] }),
    ]);
    const [only] = traceModel(withTrajectory(state, script, trajectory)).turns;
    expect(kinds(only!.rows)).toEqual(['input', 'reply', 'call']);
  });

  it('子代理的列照出現的先後夾在主對話的列之間', () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('inbox:r1', '問'),
      ...script.ai('a1', { text: '派一個' }),
      ...script.ai('sub1', { text: '子代理在說話', namespace: ['tools:a', 'model_request:y'] }),
      script.completed(),
    ]);
    const trajectory = view([turn(0, { calls: [call(5, { reply: reply(11, 'run-a1') })] })]);
    const [only] = traceModel(withTrajectory(state, script, trajectory)).turns;
    expect(only!.rows.filter((r) => r.kind === 'reply')).toHaveLength(2);
    expect(only!.rows.at(-1)?.kind).toBe('reply');
  });
});

describe('traceModel：閘門，沒有就整個退回第 0 版', () => {
  const v0 = (state: ConversationState) => traceModel(state);

  it('沒有投影：結構化是 false，輸出與只看條目時一模一樣', () => {
    const { state } = live();
    const model = v0(state);
    expect(model.structured).toBe(false);
    expect(model.turns.every((t) => t.legacy && t.head === undefined)).toBe(true);
    expect(model.digests).toEqual([]);
  });

  it('failed 的旗標單獨就擋得住：即使同時帶著一份看起來合法的 view 也不畫', () => {
    const { state, trajectory } = live();
    const stale = {
      ...state,
      projections: {
        ...state.projections,
        [TRAJECTORY_PROJECTION]: {
          version: TRAJECTORY_VERSION,
          view: trajectory,
          failed: true as const,
        },
      },
    };
    expect(v0(stale).structured).toBe(false);
  });

  it.each([
    [
      '拋過（failed）',
      (s: Script) =>
        projectionFrame(s, TRAJECTORY_PROJECTION, TRAJECTORY_VERSION, null, { failed: true }),
    ],
    [
      '版本不認得',
      (s: Script) => projectionFrame(s, TRAJECTORY_PROJECTION, TRAJECTORY_VERSION + 1, view([])),
    ],
    [
      'view 形狀不對',
      (s: Script) => projectionFrame(s, TRAJECTORY_PROJECTION, TRAJECTORY_VERSION, { turns: 'x' }),
    ],
    [
      'view 是空的',
      (s: Script) => projectionFrame(s, TRAJECTORY_PROJECTION, TRAJECTORY_VERSION, null),
    ],
  ])('%s：退回第 0 版，不畫過期或看不懂的值', (_label, frame) => {
    const { script, state } = live();
    const model = v0(reduceAll(state, [frame(script)]));
    expect(model.structured).toBe(false);
    expect(model.turns.every((t) => t.legacy)).toBe(true);
  });
});

describe('traceModel：事實讀投影，缺席不補 0', () => {
  it('呼叫的起訖、耗時、模型、用量取自投影；缺席的欄位不出現在列上', () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [script.running(), script.completed()]);
    const bare = call(7, {
      model: undefined,
      usage: undefined,
      durationMs: undefined,
      endTime: undefined,
    });
    const trajectory = view([turn(0, { calls: [call(5), bare] })]);
    const rows = traceModel(withTrajectory(state, script, trajectory)).turns[0]!.rows;
    const [full, sparse] = rows as [
      Extract<TraceRow, { kind: 'call' }>,
      Extract<TraceRow, { kind: 'call' }>,
    ];
    expect([full.model, full.durationMs, full.inputTokens, full.outputTokens]).toEqual([
      'fake-model',
      400,
      10,
      5,
    ]);
    for (const field of ['model', 'durationMs', 'endTime', 'inputTokens', 'outputTokens']) {
      expect(sparse).not.toHaveProperty(field);
    }
  });

  it('工具列的時刻與耗時取自投影（條目的 startedAt 在歷史上等於 settledAt，算出來是錯的）', () => {
    const { script, state, trajectory } = live();
    const patched = view([
      turn(0, {
        calls: [
          call(5, {
            reply: reply(11, 'run-a1'),
            tools: [tool('c1', { time: 1_700_000_123_000, durationMs: 777 })],
          }),
          call(16, { reply: reply(18, 'run-a2') }),
        ],
      }),
      trajectory.turns[1]!,
    ]);
    const rows = traceModel(withTrajectory(state, script, patched)).turns[0]!.rows;
    const toolRow = rows.find((r) => r.kind === 'tool') as Extract<TraceRow, { kind: 'tool' }>;
    expect([toolRow.time, toolRow.durationMs]).toEqual([1_700_000_123_000, 777]);
  });

  it('請求快照：沒記是 none、指到的已被擠掉是 gone、還在是 kept（含字元數、截斷、工具個數）', () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [script.running(), script.completed()]);
    const trajectory = view([
      turn(0, {
        calls: [call(5, { system: 8, header: 9 }), call(6, { system: 1, header: 2 }), call(7)],
      }),
    ]);
    const snapshots = {
      system: [
        {
          seq: 8,
          time: 1,
          reason: 'initial' as const,
          text: 'x',
          chars: 70_000,
          truncated: true as const,
        },
      ],
      header: [
        { seq: 9, time: 1, reason: 'initial' as const, header: { config: {}, tools: [1, 2, 3] } },
      ],
    };
    const rows = traceModel(withTrajectory(state, script, trajectory, snapshots)).turns[0]!
      .rows as Extract<TraceRow, { kind: 'call' }>[];
    expect(
      rows.map((r) => [r.system, r.systemChars, r.systemTruncated, r.header, r.headerTools]),
    ).toEqual([
      ['kept', 70_000, true, 'kept', 3],
      ['gone', undefined, undefined, 'gone', undefined],
      ['none', undefined, undefined, 'none', undefined],
    ]);
  });

  it('沒有請求快照投影時，有指向的呼叫算「已不保留」，不是壞掉', () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [script.running(), script.completed()]);
    const trajectory = view([turn(0, { calls: [call(5, { system: 8, header: 9 })] })]);
    const [row] = traceModel(withTrajectory(state, script, trajectory)).turns[0]!.rows as [
      Extract<TraceRow, { kind: 'call' }>,
    ];
    expect([row.system, row.header]).toEqual(['gone', 'gone']);
    // 請求快照投影本身拋過也一樣。
    const failed = reduceAll(withTrajectory(state, script, trajectory), [
      projectionFrame(script, REQUEST_SNAPSHOTS_PROJECTION, REQUEST_SNAPSHOTS_VERSION, null, {
        failed: true,
      }),
    ]);
    const [again] = traceModel(failed).turns[0]!.rows as [Extract<TraceRow, { kind: 'call' }>];
    expect(again.system).toBe('gone');
  });
});

describe('traceModel：重試、提醒與決策點', () => {
  it('重試列跟在它那次呼叫的段落後面，帶原因碼、狀態與實際等了多久', () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [script.running(), script.completed()]);
    const trajectory = view([
      turn(0, {
        calls: [
          call(5, {
            retries: [
              {
                seq: 6,
                time: 1,
                retryId: 'r',
                retry: 1,
                maxRetries: 3,
                code: 'RATE_LIMIT',
                status: 429,
                waitedMs: 1500,
              },
              { seq: 8, time: 2, retryId: 'r', retry: 2, maxRetries: 3, code: 'SERVER' },
            ],
          }),
        ],
      }),
    ]);
    const rows = traceModel(withTrajectory(state, script, trajectory)).turns[0]!.rows;
    expect(kinds(rows)).toEqual(['call', 'retry', 'retry']);
    expect(rows.slice(1)).toMatchObject([
      { retry: 1, maxRetries: 3, code: 'RATE_LIMIT', status: 429, waitedMs: 1500 },
      { retry: 2, maxRetries: 3, code: 'SERVER' },
    ]);
    expect(rows[2]).not.toHaveProperty('waitedMs');
    expect(rows[2]).not.toHaveProperty('status');
  });

  it('決策點照 seq 插在對應的呼叫前；壓縮不長列（對話裡已有那一則標記）', () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [script.running(), script.completed()]);
    const trajectory = view([
      turn(0, {
        calls: [call(5), call(20)],
        decisions: [
          decision('goal', 2, { operation: 'create', phase: 'active' }),
          decision('compaction', 10, { cutoffIndex: 1, messagesBefore: 9 }),
          decision('reminder', 15, { tool: 'ls', count: 3 }),
          decision('interrupt', 30, {}),
        ],
      }),
    ]);
    const rows = traceModel(withTrajectory(state, script, trajectory)).turns[0]!.rows;
    expect(rows.map((r) => (r.kind === 'signal' ? `signal:${r.signal}` : r.kind))).toEqual([
      'signal:goal',
      'call',
      'signal:reminder',
      'call',
      'signal:interrupt',
    ]);
    expect(
      rows.filter((r) => r.kind === 'signal').map((r) => (r as { summary: string }).summary),
    ).toEqual(['建立目標（進行中）', '重複呼叫：ls 連續第 3 次', '停下來等人決定']);
  });

  it('單輪上限摺掉的呼叫：段落編號從摺掉的數量接著算，標題標出摺了多少', () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [script.running(), script.completed()]);
    const trajectory = view([
      turn(0, {
        callCount: 40,
        toolCount: 12,
        calls: [call(100), call(101)],
        elided: { calls: 38, tools: 9, inputs: 0, decisions: 0 },
      }),
    ]);
    const [only] = traceModel(withTrajectory(state, script, trajectory)).turns;
    expect(only!.rows.map((r) => (r as { n?: number }).n)).toEqual([39, 40]);
    expect(only!.head).toMatchObject({
      callCount: 40,
      toolCount: 12,
      elidedCalls: 38,
      elidedTools: 9,
    });
  });
});

describe('traceModel：核准後續接併回同一個邏輯輪', () => {
  /** v0 的 `richTurn` 的結構化版：讀檔、停在核准點、人核准（本地決定）、續接、收尾；另有第二則人話。 */
  function approvalConversation(interrupt: { id?: string; approval?: TrajectoryApproval } = {}) {
    const script = new Script();
    const asked = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('inbox:r1', '幫我改 README'),
      ...script.ai('a', { reasoning: '先讀' }),
      script.started('c1', 'read_file', { file_path: 'README.md' }),
      script.finished('c1', '# 專案'),
      ...script.ai('b', { text: '接下來改寫' }),
      script.started('c2', 'edit_file', { file_path: 'README.md' }),
      script.approval('int-1', 'edit_file'),
    ]);
    const decided = appendDecision(asked, 'int-1', 'approve');
    const state = reduceAll(decided, [
      script.finished('c2', '已改'),
      ...script.ai('c', { text: '改好了' }),
      script.completed(),
      script.running(),
      ...script.human('inbox:r2', '再問一件事'),
      ...script.ai('d', { text: '好' }),
      script.completed(),
    ]);
    const trajectory = view([
      turn(0, {
        end: 'completed',
        time: 1_000,
        endTime: 3_000,
        durationMs: 2_000,
        calls: [
          call(5, { reply: reply(11, 'run-a'), tools: [tool('c1')] }),
          call(16, { reply: reply(18, 'run-b'), tools: [tool('c2', { status: 'running' })] }),
        ],
        decisions: [decision('interrupt', 20, interrupt)],
      }),
      turn(1, {
        kind: 'resume',
        logical: false,
        time: 9_000,
        endTime: 10_000,
        durationMs: 1_000,
        calls: [call(30, { reply: reply(32, 'run-c') })],
      }),
      turn(2, { time: 20_000, calls: [call(40, { reply: reply(42, 'run-d') })] }),
    ]);
    return { script, state, trajectory };
  }

  it('續接的那一段不另開一組：同一組裡，本地的決定列落在停下來的工具之後、續接的呼叫之前', () => {
    const { script, state, trajectory } = approvalConversation();
    const model = traceModel(withTrajectory(state, script, trajectory));
    expect(model.turns).toHaveLength(2);
    expect(kinds(model.turns[0]!.rows)).toEqual([
      'input',
      'call',
      'thinking',
      'tool',
      'call',
      'reply',
      'tool',
      'signal',
      'decision',
      'call',
      'reply',
    ]);
    // 第二則人話開的才是第 2 輪。
    expect(model.turns.map((t) => t.head?.number)).toEqual([1, 2]);
    expect(kinds(model.turns[1]!.rows)).toEqual(['input', 'call', 'reply']);
  });

  it('併起來的標題：計數相加、收尾取續接那一段、牆鐘含等人核准的時間；續接的呼叫編號接著算', () => {
    const { script, state, trajectory } = approvalConversation();
    const [first] = traceModel(withTrajectory(state, script, trajectory)).turns;
    expect(first!.head).toMatchObject({
      number: 1,
      kind: 'message',
      callCount: 3,
      toolCount: 2,
      end: 'completed',
      time: 1_000,
      endTime: 10_000,
      // 第一段 2 秒＋等人 6 秒＋續接 1 秒：從第一顆 turn/start 起算到最後收尾。
      durationMs: 9_000,
    });
    const callNumbers = first!.rows
      .filter((r) => r.kind === 'call')
      .map((r) => (r as { n: number }).n);
    expect(callNumbers).toEqual([1, 2, 3]);
  });

  it('軌跡帶著核准結局：停下來那一列照結局說，本地的決定列不再重複出現', () => {
    const approval: TrajectoryApproval = {
      tool: 'edit_file',
      outcome: 'allowed-once',
      decidedAt: 1_700_000_000_020 + 5_000,
    };
    const { script, state, trajectory } = approvalConversation({ id: 'int-1', approval });
    const [first] = traceModel(withTrajectory(state, script, trajectory)).turns;
    expect(kinds(first!.rows)).not.toContain('decision');
    const signal = first!.rows.find((r) => r.kind === 'signal');
    expect(signal).toMatchObject({ summary: '核准 edit_file：允許一次（等了 5.0 秒）' });
  });

  it('軌跡的核准還沒有結局：本地的決定列照舊留著，停下來那一列說還沒有結局', () => {
    const { script, state, trajectory } = approvalConversation({
      id: 'int-1',
      approval: { tool: 'edit_file' },
    });
    const [first] = traceModel(withTrajectory(state, script, trajectory)).turns;
    expect(kinds(first!.rows)).toContain('decision');
    const signal = first!.rows.find((r) => r.kind === 'signal');
    expect((signal as { summary: string }).summary).toContain('還沒有結局');
  });

  it('結局對不上本地決定的中斷 id：兩邊都留著（只認同一顆）', () => {
    const { script, state, trajectory } = approvalConversation({
      id: 'int-other',
      approval: { tool: 'edit_file', outcome: 'rejected' },
    });
    const [first] = traceModel(withTrajectory(state, script, trajectory)).turns;
    expect(kinds(first!.rows)).toContain('decision');
  });

  it('重新整理之後（沒有本地決定）：只靠軌跡就看得到結局', () => {
    const { script, state, trajectory } = approvalConversation({
      id: 'int-1',
      approval: { tool: 'edit_file', outcome: 'rejected' },
    });
    const reloaded: ConversationState = {
      ...state,
      entries: state.entries.filter((entry) => entry.kind !== 'decision'),
    };
    const [first] = traceModel(withTrajectory(reloaded, script, trajectory)).turns;
    expect(kinds(first!.rows)).not.toContain('decision');
    expect(first!.rows.find((r) => r.kind === 'signal')).toMatchObject({
      summary: '核准 edit_file：已拒絕',
    });
  });

  it('一顆中斷同時問了好幾個動作：本地那一列說得全，不被軌跡的單一工具名取代', () => {
    const { script, state, trajectory } = approvalConversation({
      id: 'int-1',
      approval: { tool: 'edit_file', outcome: 'allowed-once' },
    });
    const multi: ConversationState = {
      ...state,
      entries: state.entries.map((entry) =>
        entry.kind === 'decision' ? { ...entry, actions: ['edit_file', 'write_file'] } : entry,
      ),
    };
    const [first] = traceModel(withTrajectory(multi, script, trajectory)).turns;
    expect(kinds(first!.rows)).toContain('decision');
  });

  it('回那一組的 seq；續接併回前一輪，所以續接之後的回覆答的是併起來那一組', () => {
    const { script, state, trajectory } = approvalConversation();
    const withView = withTrajectory(state, script, trajectory);
    const model = traceModel(withView);
    const [first, second] = model.turns;
    expect(first!.seq).toBeDefined();
    // 第一輪的兩段（run-a、run-b）與續接之後的 run-c 都在第一組；第二輪的 run-d 在第二組。
    expect(turnSeqOfMessage(model, withView.entries, 'run-a')).toBe(first!.seq);
    expect(turnSeqOfMessage(model, withView.entries, 'run-c')).toBe(first!.seq);
    expect(turnSeqOfMessage(model, withView.entries, 'run-d')).toBe(second!.seq);
    expect(first!.seq).not.toBe(second!.seq);
  });

  it('答不出就 undefined：不在對話裡的訊息 id、沒有軌跡投影（第 0 版的組沒有 seq）', () => {
    const { script, state, trajectory } = approvalConversation();
    const withView = withTrajectory(state, script, trajectory);
    expect(turnSeqOfMessage(traceModel(withView), withView.entries, 'run-nowhere')).toBeUndefined();
    expect(turnSeqOfMessage(traceModel(state), state.entries, 'run-a')).toBeUndefined();
  });

  it('續接還沒收尾時，併起來的標題沒有收尾也沒有牆鐘（不拿第一段的充數）', () => {
    const { script, state, trajectory } = approvalConversation();
    const open = view([
      trajectory.turns[0]!,
      turn(1, {
        kind: 'resume',
        logical: false,
        end: undefined as never,
        endTime: undefined as never,
        durationMs: undefined as never,
        calls: [],
      }),
    ]);
    const [only] = traceModel(withTrajectory(state, script, open)).turns;
    expect(only!.head).not.toHaveProperty('end');
    expect(only!.head).not.toHaveProperty('durationMs');
    expect(only!.head).not.toHaveProperty('endTime');
  });

  it('摘要也折：續接併回前一輪，編號是邏輯輪的序號；被省略的輪當成邏輯輪往後數', () => {
    const { script, state } = approvalConversation();
    const trajectory = view([turn(9, { calls: [call(5)] })], {
      digests: [
        digest(0),
        digest(1, {
          kind: 'resume',
          logical: false,
          callCount: 1,
          toolCount: 0,
          inputTokens: 5,
          outputTokens: 2,
        }),
        digest(2),
      ],
      omitted: 3,
    });
    const model = traceModel(withTrajectory(state, script, trajectory));
    // 省略 3 輪；摘要 0 → 第 4 輪，續接併進它，摘要 2 → 第 5 輪；窗口裡那一輪 → 第 6 輪。
    expect(model.digests.map((d) => [d.number, d.callCount])).toEqual([
      [4, 3],
      [5, 2],
    ]);
    expect(model.turns.find((t) => t.head !== undefined)?.head?.number).toBe(6);
  });
});

describe('traceModel：還在進行的呼叫不只在每一輪的第一次', () => {
  it('第二次呼叫還在吐字：回覆歸在第二個呼叫段落之下，不是上一次呼叫的尾巴', () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('inbox:r1', '問'),
      ...script.ai('a1', { reasoning: '想' }),
      script.started('c1', 'ls', {}),
      script.finished('c1', 'ok'),
      script.openAi('a2'),
      script.delta('a2', '講到一半'),
    ]);
    const trajectory = view([
      turn(0, {
        end: undefined as never,
        calls: [
          call(5, { reply: reply(11, 'run-a1'), tools: [tool('c1')] }),
          call(16, { endTime: undefined as never }),
        ],
      }),
    ]);
    const [only] = traceModel(withTrajectory(state, script, trajectory)).turns;
    expect(kinds(only!.rows)).toEqual(['input', 'call', 'thinking', 'tool', 'call', 'reply']);
  });
});

describe('traceModel：列只放原始值，投影整份換掉時 memo 才擋得住', () => {
  it('同樣內容、全新物件的投影：每一列 sameRow 都成立', () => {
    const { script, state, trajectory } = live();
    const first = traceModel(withTrajectory(state, script, trajectory));
    const second = traceModel(withTrajectory(state, script, structuredClone(trajectory)));
    const flat = (m: typeof first) => m.turns.flatMap((t) => t.rows);
    expect(flat(second)).toHaveLength(flat(first).length);
    flat(first).forEach((row, i) => expect(sameRow(row, flat(second)[i]!)).toBe(true));
  });
});

describe('限制文字', () => {
  it('結構化的限制拿掉了「切輪靠人」；決定那條不再說「只存本地」（核准結局來自軌跡）', () => {
    expect(Object.keys(TRACE_STRUCTURED_LIMITS)).toEqual(['decisions', 'loaded', 'absent']);
    expect(TRACE_STRUCTURED_LIMITS.decisions).not.toBe(TRACE_LIMITS.decisions);
    expect(TRACE_STRUCTURED_LIMITS.decisions).toContain('重新整理後仍在');
    expect(TRACE_STRUCTURED_LIMITS.decisions).toContain('更早的輪只剩摘要');
    expect(TRACE_STRUCTURED_LIMITS.decisions).not.toContain('只記在這個分頁');
    expect(Object.keys(TRACE_LIMITS)).toEqual(['turns', 'decisions', 'loaded', 'absent']);
  });
});
