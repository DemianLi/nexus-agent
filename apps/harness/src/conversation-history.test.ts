/**
 * 日誌 → 畫面的那張表（[#306](https://github.com/DemianLi/nexus-agent/issues/306) 的畫面那一刀），逐條一格。
 *
 * **判準是折出來的畫面**，不是 frame 的形狀：frame 由 `@nexus/wire` 的 `reduceConversation` 折，那才是 web 畫出來
 * 的東西，而同一個畫面可以由不同的 frame 折出來。對著真的 server 重開一次的在 `serve-history.test.ts`。
 */

import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { GoalId, SessionEvent } from '@nexus/core';
import { TOOL_ABORTED, toLoggedMessage } from '@nexus/core';
import type { ConversationEntry, ConversationState } from '@nexus/wire';
import { UNFINISHED_TOOL_TEXT, emptyConversation, prependEntries, reduceAll } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import type { AwaitingInput } from './conversation-history.js';
import { HistoryQueryError, historyFrames, historyPage } from './conversation-history.js';

type Draft = Pick<SessionEvent, 'type' | 'data'>;

/** 排好 `seq` 與 `time`。 */
function log(...drafts: Draft[]): SessionEvent[] {
  return drafts.map((draft, seq) => ({ ...draft, seq, time: 1000 + seq }) as SessionEvent);
}

const human = (text: string): Draft => ({ type: 'turn/start', data: { kind: 'message', text } });
const resume: Draft = { type: 'turn/start', data: { kind: 'resume' } };
const turnEnd: Draft = { type: 'turn/end', data: {} };

function reply(text: string, callIds: readonly string[] = [], interrupted?: true): Draft {
  return {
    type: 'assistant/message',
    data: {
      message: toLoggedMessage(
        new AIMessage({
          content: text,
          tool_calls: callIds.map((id) => ({ id, name: 'echo', args: { message: id } })),
        }),
      ),
      ...(interrupted === undefined ? {} : { interrupted }),
    },
  };
}

const call = (callId: string, name = 'echo'): Draft => ({
  type: 'tool/call',
  data: { callId, name, arguments: `{"message":"${callId}"}` },
});

function result(callId: string, text: string, isError = false): Draft {
  return {
    type: 'tool/result',
    data: {
      callId,
      isError,
      message: toLoggedMessage(
        new ToolMessage({
          content: text,
          tool_call_id: callId,
          ...(isError && { status: 'error' }),
        }),
      ),
    },
  };
}

/** 一則條目攤成一行，好比對。 */
function line(entry: ConversationEntry): string {
  switch (entry.kind) {
    case 'human':
      return `human:${entry.text}`;
    case 'ai':
      return `ai:${entry.text}${entry.stopped === true ? '（已停止）' : ''}`;
    case 'tool':
      return `tool:${entry.name}:${entry.status}${entry.error === undefined ? '' : `:${entry.error}`}`;
    default:
      return entry.kind;
  }
}

function screen(events: readonly SessionEvent[], awaitingInput?: AwaitingInput): ConversationState {
  return reduceAll(emptyConversation(), historyFrames(events, awaitingInput));
}

/** 掛著中斷，停在閘門上的是這幾個名字。 */
const gated = (...names: string[]): AwaitingInput => ({ gatedTools: new Set(names) });

const TWO_TURNS = log(
  human('記住暗號是藍鯨'),
  { type: 'model/start', data: {} },
  reply('先回聲一次。', ['c1']),
  { type: 'model/end', data: {} },
  call('c1'),
  result('c1', '回聲：c1'),
  reply('記住了。'),
  turnEnd,
  human('暗號是什麼'),
  reply('藍鯨。'),
  turnEnd,
);

describe('日誌 → 畫面', () => {
  it('人打的字、回覆、工具卡依序畫出來，最後停在就緒', () => {
    const state = screen(TWO_TURNS);

    expect(state.entries.map(line)).toEqual([
      'human:記住暗號是藍鯨',
      'ai:先回聲一次。',
      'tool:echo:done',
      'ai:記住了。',
      'human:暗號是什麼',
      'ai:藍鯨。',
    ]);
    expect(state.status).toBe('idle');
  });

  /** 見 `@nexus/wire` 的 `historyPath`：帶了耐久 seq，之後的即時 frame 全被當成重複丟掉。 */
  it('一顆 frame 都不帶 seq', () => {
    const frames = historyPage(TWO_TURNS).events;

    expect(frames.length).toBeGreaterThan(0);
    expect(frames.filter((frame) => frame.seq !== undefined)).toEqual([]);
  });

  /**
   * **成功那一側也帶結果文字**（[#439](https://github.com/DemianLi/nexus-agent/issues/439)）。
   * 重新整理之後提問卡要靠它逐題配答案——少了這一格，答案只有作答的那個分頁記得。
   * 「即時與重播是同一串」那一條在 `tool-card-from-log.test.ts`。
   */
  it('工具成功：卡是完成，結果文字帶上、紅字不給', () => {
    const state = screen(
      log(human('跑'), reply('', ['c1']), call('c1'), result('c1', '回聲：c1'), turnEnd),
    );
    const tool = state.entries.find((entry) => entry.kind === 'tool');

    expect(tool?.kind === 'tool' ? tool.text : undefined).toBe('回聲：c1');
    expect(tool?.kind === 'tool' ? tool.error : '有紅字').toBeUndefined();
    expect(state.entries.map(line)).toEqual(['human:跑', 'tool:echo:done']);
  });

  it('工具失敗：卡是失敗，紅字是模型收到的那則', () => {
    const state = screen(
      log(human('跑'), reply('', ['c1']), call('c1'), result('c1', '找不到那個檔', true), turnEnd),
    );

    expect(state.entries.map(line)).toEqual(['human:跑', 'tool:echo:failed:找不到那個檔']);
  });

  /**
   * **多塊內容的失敗訊息：紅字退回泛用那句**（#439 的副作用，明著釘住）。以前這裡是把每一塊
   * 接起來，現在照 dsh 的規則不是剛好一塊就不給——退路是錯誤碼，再退是「未指名的錯誤」。
   * 今天樹上沒有產多塊內容的工具，所以這條釘的是規則，不是現況。
   */
  it('失敗訊息是多塊內容：不自己拼，紅字退回錯誤碼', () => {
    const state = screen(
      log(
        human('跑'),
        reply('', ['c1']),
        call('c1'),
        {
          type: 'tool/result',
          data: {
            callId: 'c1',
            isError: true,
            error: { name: 'FsError', code: 'FS_SANDBOX_DENIED' },
            message: toLoggedMessage(
              new ToolMessage({
                content: [
                  { type: 'text', text: '第一塊' },
                  { type: 'text', text: '第二塊' },
                ],
                tool_call_id: 'c1',
                status: 'error',
              }),
            ),
          },
        },
        turnEnd,
      ),
    );

    expect(state.entries.map(line)).toEqual(['human:跑', 'tool:echo:failed:FS_SANDBOX_DENIED']);
  });

  it('舊格式的失敗結果沒有內容：紅字是錯誤碼', () => {
    const state = screen(
      log(
        human('跑'),
        call('c1'),
        {
          type: 'tool/result',
          data: { callId: 'c1', isError: true, error: { name: 'x', code: TOOL_ABORTED } },
        },
        turnEnd,
      ),
    );

    expect(state.entries.map(line)).toEqual(['human:跑', `tool:echo:failed:${TOOL_ABORTED}`]);
  });

  it('講到一半被停止：那則標成已停止，沒結果的卡收成失敗', () => {
    const state = screen(
      log(human('跑'), reply('寫到一半', [], true), call('c1'), {
        type: 'turn/end',
        data: { reason: { kind: 'aborted', cause: { kind: 'user' } } },
      }),
    );

    expect(state.entries.map(line)).toEqual([
      'human:跑',
      'ai:寫到一半（已停止）',
      `tool:echo:failed:${UNFINISHED_TOOL_TEXT}`,
    ]);
    expect(state.status).toBe('stopped');
  });

  it('一輪失敗：狀態是失敗，下一輪跑完就回到就緒', () => {
    const failed = log(human('跑'), { type: 'turn/failed', data: { message: '供應商掛了' } });
    expect(screen(failed).status).toBe('failed');
    expect(screen(failed).error).toBe('供應商掛了');

    const recovered = screen(log(...failed, human('再來'), reply('好了。'), turnEnd));
    expect(recovered.status).toBe('idle');
  });

  /**
   * 停在核准點的那一輪收掉時卡先收成失敗；人答了之後 `resume` 那一輪以同一個 `callId` 再記一次 `tool/call`，
   * 同一張卡翻回執行中、再照結果收——**一張卡，不是兩張**。
   */
  it('核准之後接著跑：同一顆呼叫只有一張卡，終態照結果', () => {
    const state = screen(
      log(
        human('寫檔'),
        reply('', ['c1']),
        call('c1', 'write_file'),
        { type: 'interrupt/raised', data: { interruptId: 'i1' } },
        turnEnd,
        resume,
        call('c1', 'write_file'),
        result('c1', '寫好了'),
        reply('寫好了。'),
        turnEnd,
      ),
    );

    expect(state.entries.map(line)).toEqual(['human:寫檔', 'tool:write_file:done', 'ai:寫好了。']);
  });

  /**
   * 兩種等法照即時分開畫（#317）：停在閘門上的是「執行中」，本體拋了中斷的是「等你回答」。
   *
   * **第一條原本釘的是「停在閘門上也是等你回答」**（#310），換機制時翻面寫；少了混著掛的那一條，把每張卡都畫成
   * 執行中的實作也會綠。
   */
  describe('最後一輪停下來等人', () => {
    const interrupt = (interruptId: string): Draft => ({
      type: 'interrupt/raised',
      data: { interruptId },
    });
    const pending = log(
      human('寫檔'),
      reply('', ['c1']),
      call('c1', 'write_file'),
      interrupt('i1'),
      turnEnd,
    );

    it('停在核准閘門上、這條 thread 還掛著那顆中斷：卡跟即時一樣是「執行中」，畫面停在忙著', () => {
      const state = screen(pending, gated('write_file'));

      expect(state.entries.map(line)).toEqual(['human:寫檔', 'tool:write_file:running']);
      expect(state.status).toBe('running');
    });

    it('本體拋了中斷的（問答）：卡是「等你回答」', () => {
      const state = screen(
        log(
          human('問'),
          reply('', ['c1']),
          call('c1', 'ask_user_question'),
          interrupt('i1'),
          turnEnd,
        ),
        gated(),
      );

      expect(state.entries.map(line)).toEqual(['human:問', 'tool:ask_user_question:suspended']);
      expect(state.status).toBe('running');
    });

    it('同一輪一題問答、一顆核准：問答是「等你回答」，核准是「執行中」', () => {
      const state = screen(
        log(
          human('兩個都動'),
          reply('', ['c1', 'c2']),
          call('c1', 'ask_user_question'),
          call('c2', 'write_file'),
          interrupt('i1'),
          interrupt('i2'),
          turnEnd,
        ),
        gated('write_file'),
      );

      expect(state.entries.map(line)).toEqual([
        'human:兩個都動',
        'tool:ask_user_question:suspended',
        'tool:write_file:running',
      ]);
    });

    it('行程重開過、中斷已經不在了：卡照即時那條規則收成失敗', () => {
      const state = screen(pending);

      expect(state.entries.map(line)).toEqual([
        'human:寫檔',
        `tool:write_file:failed:${UNFINISHED_TOOL_TEXT}`,
      ]);
      expect(state.status).toBe('idle');
    });

    it('掛著的判斷只作用在最後一頁', () => {
      const page = historyPage(
        log(...pending, human('之後'), reply('好。'), turnEnd),
        {},
        gated('write_file'),
      );

      expect(reduceAll(emptyConversation(), page.events).entries.map(line)).toContain(
        `tool:write_file:failed:${UNFINISHED_TOOL_TEXT}`,
      );
    });
  });

  it('上一個行程死在一輪中間：那一輪在 end-seed 收掉', () => {
    const state = screen(
      log(
        human('跑'),
        call('c1'),
        { type: 'session/end-seed', data: {} },
        human('還在嗎'),
        reply('在。'),
        turnEnd,
      ),
    );

    expect(state.entries.map(line)).toEqual([
      'human:跑',
      `tool:echo:failed:${UNFINISHED_TOOL_TEXT}`,
      'human:還在嗎',
      'ai:在。',
    ]);
    expect(state.status).toBe('idle');
  });

  /**
   * **切回去之後的第一眼就是這個樣子**：上一個行程死在一輪中間，這個行程還沒說過話，日誌停在 end-seed。上一條
   * 後面還接了一輪，而 `turn/start` 本來就會收掉還開著的那一輪——少了 end-seed 那一步它照樣綠。
   */
  it('日誌停在 end-seed：那一輪收掉，畫面不停在執行中', () => {
    const state = screen(log(human('跑'), call('c1'), { type: 'session/end-seed', data: {} }));

    expect(state.entries.map(line)).toEqual([
      'human:跑',
      `tool:echo:failed:${UNFINISHED_TOOL_TEXT}`,
    ]);
    expect(state.status).toBe('idle');
  });

  it('目標排的輪次不畫那一串指示，同即時', () => {
    const state = screen(
      log(
        {
          type: 'turn/start',
          data: { kind: 'goal', text: '繼續做', goalId: 'g1' as GoalId, revision: 1, round: 1 },
        },
        reply('做完了。'),
        turnEnd,
      ),
    );

    expect(state.entries.map(line)).toEqual(['ai:做完了。']);
  });

  it('壓縮與外掛注入的訊息不畫，同即時', () => {
    const state = screen(
      log(
        human('跑'),
        reply('好。'),
        {
          type: 'user/message',
          data: {
            message: toLoggedMessage(new AIMessage('提醒')),
            source: { kind: 'plugin', plugin: 'repeat-reminder' },
          },
        },
        {
          type: 'compaction/summary',
          data: {
            cutoffIndex: 1,
            messagesBefore: 2,
            filePath: null,
            summary: toLoggedMessage(new AIMessage('摘要')),
          },
        },
        turnEnd,
      ),
    );

    expect(state.entries.map(line)).toEqual(['human:跑', 'ai:好。']);
  });
});

describe('評分要的兩格（#382）', () => {
  /** 一則有 id 的回覆。 */
  function replyWithId(text: string, id: string, callIds: readonly string[] = []): Draft {
    return {
      type: 'assistant/message',
      data: {
        message: toLoggedMessage(
          new AIMessage({
            content: text,
            id,
            tool_calls: callIds.map((callId) => ({ id: callId, name: 'echo', args: {} })),
          }),
        ),
      },
    };
  }

  it('回覆帶日誌記的訊息 id；key 照舊是 history-<seq>；沒記 id 的就沒有', () => {
    const state = screen(
      log(human('跑'), replyWithId('有 id。', 'm-1'), reply('沒 id。'), turnEnd),
    );
    expect(
      state.entries.flatMap((entry) => (entry.kind === 'ai' ? [[entry.id, entry.messageId]] : [])),
    ).toEqual([
      ['history-1', 'm-1'],
      ['history-2', undefined],
    ]);
    // 人那一則沒有訊息 id：它不是評分的目標。
    expect(state.entries[0]).toEqual({ kind: 'human', id: 'history-0', text: '跑' });
  });

  it('停在核准點又續接的一輪不在中間收掉：收尾只有續接後那則，同即時', () => {
    const state = screen(
      log(
        human('寫檔'),
        replyWithId('要動手了。', 'm-1', ['c1']),
        call('c1', 'write_file'),
        { type: 'interrupt/raised', data: { interruptId: 'i1' } },
        turnEnd,
        resume,
        call('c1', 'write_file'),
        result('c1', '寫好了'),
        replyWithId('寫好了。', 'm-2'),
        turnEnd,
      ),
    );
    expect(
      state.entries.flatMap((entry) =>
        entry.kind === 'ai' ? [[entry.text, entry.turnTail === true]] : [],
      ),
    ).toEqual([
      ['要動手了。', false],
      ['寫好了。', true],
    ]);
    expect(state.entries.map(line)).toContain('tool:write_file:done');
  });

  it('停在中斷上、之後另起一輪（沒有續接）：那一輪在下一輪開頭收掉，卡照即時收成失敗', () => {
    const state = screen(
      log(
        human('寫檔'),
        replyWithId('要動手了。', 'm-1', ['c1']),
        call('c1', 'write_file'),
        { type: 'interrupt/raised', data: { interruptId: 'i1' } },
        turnEnd,
        human('算了'),
        replyWithId('好。', 'm-2'),
        turnEnd,
      ),
    );
    expect(state.entries.map(line)).toEqual([
      'human:寫檔',
      'ai:要動手了。',
      `tool:write_file:failed:${UNFINISHED_TOOL_TEXT}`,
      'human:算了',
      'ai:好。',
    ]);
    expect(
      state.entries.flatMap((entry) => (entry.kind === 'ai' && entry.turnTail ? [entry.text] : [])),
    ).toEqual(['要動手了。', '好。']);
  });

  it('停在中斷上、之後只有別的事件（例如人送了回饋）而現在還掛著：照舊停在等人', () => {
    const state = screen(
      log(
        human('寫檔'),
        replyWithId('', 'm-1', ['c1']),
        call('c1', 'write_file'),
        { type: 'interrupt/raised', data: { interruptId: 'i1' } },
        turnEnd,
        { type: 'feedback/record', data: { text: '慢' } },
      ),
      gated('write_file'),
    );
    expect(state.status).toBe('running');
    expect(state.entries.map(line)).toEqual(['human:寫檔', 'tool:write_file:running']);
  });
});

describe('分頁', () => {
  /** 五輪，每輪一句人話一則回覆。 */
  const FIVE = log(
    ...[1, 2, 3, 4, 5].flatMap((n): Draft[] => [human(`第 ${n} 句`), reply(`第 ${n} 則`), turnEnd]),
  );

  it('省略參數：整份放得下就是一頁，前面沒有更多', () => {
    const page = historyPage(FIVE);

    expect(page).toMatchObject({ firstSeq: 0, throughSeq: FIVE.length - 1, hasMore: false });
  });

  it('以則數切，切在一輪的開頭；往前翻接得起來，接完就是整份', () => {
    const last = historyPage(FIVE, { maxMessages: 3 });
    // 最後 3 則是「第 4 則」「第 5 句」「第 5 則」，退到第 4 輪的開頭：一輪不拆兩頁。
    expect(last.firstSeq).toBe(9);
    expect(last.hasMore).toBe(true);

    let state = reduceAll(emptyConversation(), last.events);
    let cursor = last;
    while (cursor.hasMore) {
      const earlier = historyPage(FIVE, {
        maxMessages: 3,
        beforeSeq: cursor.firstSeq,
        throughSeq: last.throughSeq,
      });
      state = prependEntries(state, reduceAll(emptyConversation(), earlier.events));
      cursor = earlier;
    }

    expect(state.entries.map(line)).toEqual(screen(FIVE).entries.map(line));
  });

  it('throughSeq 定住上界：之後寫進來的不會出現在往前翻的頁裡', () => {
    const first = historyPage(FIVE, { maxMessages: 2 });
    const grown = log(...FIVE, human('後來的'), reply('後來的回覆'), turnEnd);

    const earlier = historyPage(grown, {
      maxMessages: 100,
      beforeSeq: first.firstSeq,
      throughSeq: first.throughSeq,
    });

    expect(reduceAll(emptyConversation(), earlier.events).entries.map(line)).not.toContain(
      'human:後來的',
    );
  });

  it('不從 resume 那一輪切：同一顆呼叫的卡不會分在兩頁', () => {
    const events = log(
      human('寫檔'),
      reply('', ['c1']),
      call('c1', 'write_file'),
      { type: 'interrupt/raised', data: { interruptId: 'i1' } },
      turnEnd,
      resume,
      call('c1', 'write_file'),
      result('c1', '寫好了'),
      reply('寫好了。'),
      turnEnd,
    );

    const page = historyPage(events, { maxMessages: 1 });

    expect(page.firstSeq).toBe(0);
  });

  it('前面只有看不見的事件：沒有更多', () => {
    const events = log(
      { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
      human('第一句'),
    );

    expect(historyPage(events, { maxMessages: 1 })).toMatchObject({ firstSeq: 1, hasMore: false });
  });

  it('空的日誌：一顆 frame 都沒有', () => {
    expect(historyPage([])).toEqual({
      events: [],
      firstSeq: 0,
      throughSeq: -1,
      hasMore: false,
      legacy: false,
    });
  });

  it.each([
    ['maxMessages 是 0', { maxMessages: 0 }],
    ['beforeSeq 是負的', { beforeSeq: -1 }],
    ['beforeSeq 不是整數', { beforeSeq: 1.5 }],
    ['beforeSeq 在 throughSeq 之後', { beforeSeq: 5, throughSeq: 2 }],
  ])('參數不對：拋 HistoryQueryError（%s）', (_label, query) => {
    expect(() => historyPage(FIVE, query)).toThrow(HistoryQueryError);
  });
});

describe('舊格式', () => {
  /** 格式 8 的一輪：叫過模型、沒記下回覆，工具結果不帶內容。 */
  const V8 = log(
    human('跑一下'),
    { type: 'model/start', data: {} },
    { type: 'model/end', data: {} },
    call('c1'),
    { type: 'tool/result', data: { callId: 'c1', isError: false } },
    { type: 'model/start', data: {} },
    { type: 'model/end', data: {} },
    turnEnd,
  );

  it('標成舊格式；人打的字與工具卡照樣畫得出來', () => {
    const page = historyPage(V8);

    expect(page.legacy).toBe(true);
    expect(reduceAll(emptyConversation(), page.events).entries.map(line)).toEqual([
      'human:跑一下',
      'tool:echo:done',
    ]);
  });

  it('對照：格式 9 的不是舊格式', () => {
    expect(historyPage(TWO_TURNS).legacy).toBe(false);
  });
});
