/**
 * 從日誌推回模型歷史的規則（[#306](https://github.com/DemianLi/nexus-agent/issues/306)）。
 *
 * 日誌照生產者真的寫的順序手排：寫的一側各自的測試證它們寫得出這些事件，這裡只問推的規則。
 * 「推出來的串跟 graph state 一則對一則」這件事對真的組裝量過（併發工具、壓縮），量的結果就是下面
 * 那幾條的前提；接到產品路徑上的驗收在 `apps/harness` 的 `conversation-restore.test.ts`。
 */

import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import {
  replayConversation,
  TOOL_NOT_STARTED_TEXT,
  TOOL_OUTCOME_UNKNOWN_TEXT,
} from './conversation-replay.js';
import type { ConversationReplay } from './conversation-replay.js';
import type { GoalId } from './goal.js';
import { toLoggedMessage } from './logged-message.js';
import { isModelVisibleEvent, MODEL_VISIBLE_EVENT_TYPES, SessionLog } from './session-log.js';
import type { SessionEvent } from './session-log.js';
import { TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN, toolErrorOf } from './tool-events.js';
import { INTERRUPTED_REPLY_MARKER } from './turn-cancel.js';

/** 推出來的串攤成「類別:文字」，工具結果多帶它配的 callId。 */
function shape(replay: ConversationReplay): string[] {
  if (replay.kind !== 'replayed')
    throw new Error(`推不出來：${replay.reason}（seq ${replay.seq}）`);
  return replay.messages.map((message: BaseMessage) =>
    ToolMessage.isInstance(message)
      ? `tool:${message.tool_call_id}:${message.text}`
      : `${message.getType()}:${message.text}`,
  );
}

/** 一則要叫工具的回覆。 */
function asking(text: string, calls: readonly (readonly [id: string, name: string])[]) {
  return toLoggedMessage(
    new AIMessage({
      content: text,
      tool_calls: calls.map(([id, name]) => ({ id, name, args: {}, type: 'tool_call' as const })),
    }),
  );
}

function reply(text: string) {
  return toLoggedMessage(new AIMessage(text));
}

function result(id: string, name: string, text: string) {
  return toLoggedMessage(new ToolMessage({ content: text, tool_call_id: id, name }));
}

/** 一次工具呼叫，照圍堵的順序：`tool/call` 然後 `tool/result`。 */
function tool(log: SessionLog, id: string, name: string, text: string): void {
  log.append('tool/call', { callId: id, name, arguments: '{}' });
  log.append('tool/result', { callId: id, isError: false, message: result(id, name, text) });
}

function summaryMessage(text: string) {
  return toLoggedMessage(
    new HumanMessage({ content: text, additional_kwargs: { lc_source: 'summarization' } }),
  );
}

/** 一輪只講話：`turn/start` → 回覆 → `turn/end`。 */
function chat(log: SessionLog, said: string, answered: string): void {
  log.append('turn/start', { kind: 'message', text: said });
  log.append('assistant/message', { message: reply(answered) });
  log.append('turn/end', {});
}

describe('每一種產訊息的事件', () => {
  it('人打的字、回覆、工具結果照順序回來', () => {
    const log = new SessionLog('replay');
    log.append('turn/start', { kind: 'message', text: '列一下' });
    log.append('assistant/message', { message: asking('好', [['c1', 'ls']]) });
    tool(log, 'c1', 'ls', 'a.txt');
    log.append('assistant/message', { message: reply('有一個檔') });
    log.append('turn/end', {});

    expect(shape(replayConversation(log.events))).toEqual([
      'human:列一下',
      'ai:好',
      'tool:c1:a.txt',
      'ai:有一個檔',
    ]);
  });

  it('一份空的日誌推出空的串', () => {
    expect(replayConversation([])).toEqual({ kind: 'replayed', messages: [] });
  });

  it('`resume` 那一輪沒有人話，goal 那一輪的字照樣是一則人話', () => {
    const log = new SessionLog('replay');
    log.append('turn/start', { kind: 'message', text: '寫檔' });
    log.append('assistant/message', { message: asking('要核准', [['c1', 'write_file']]) });
    log.append('tool/call', { callId: 'c1', name: 'write_file', arguments: '{}' });
    log.append('interrupt/raised', { interruptId: 'i1' });
    log.append('turn/end', {});
    log.append('turn/start', { kind: 'resume' });
    log.append('tool/call', { callId: 'c1', name: 'write_file', arguments: '{}' });
    log.append('tool/result', {
      callId: 'c1',
      isError: false,
      message: result('c1', 'write_file', '寫好了'),
    });
    log.append('assistant/message', { message: reply('寫好了') });
    log.append('turn/end', {});
    log.append('turn/start', {
      kind: 'goal',
      text: '繼續做目標',
      goalId: 'g1' as GoalId,
      revision: 1,
      round: 1,
    });
    log.append('assistant/message', { message: reply('做完了') });
    log.append('turn/end', {});

    expect(shape(replayConversation(log.events))).toEqual([
      'human:寫檔',
      'ai:要核准',
      'tool:c1:寫好了',
      'ai:寫好了',
      'human:繼續做目標',
      'ai:做完了',
    ]);
  });

  it('講到一半被停下的回覆帶著記號回來', () => {
    const log = new SessionLog('replay');
    log.append('turn/start', { kind: 'message', text: '講長一點' });
    log.append('model/start', {});
    log.append('model/end', {});
    log.append('assistant/message', {
      message: toLoggedMessage(
        new AIMessage({
          content: '從前從前',
          additional_kwargs: { [INTERRUPTED_REPLY_MARKER]: true },
        }),
      ),
      interrupted: true,
    });
    log.append('turn/end', { reason: { kind: 'aborted', cause: { kind: 'user' } } });

    const replay = replayConversation(log.events);
    expect(shape(replay)).toEqual(['human:講長一點', 'ai:從前從前']);
    expect(replay.kind === 'replayed' && replay.messages[1]?.additional_kwargs).toEqual({
      [INTERRUPTED_REPLY_MARKER]: true,
    });
  });

  it('llm/retry 與 llm/retry-started 不進模型：夾進起訖之間推出來的串逐字相同（#712）', () => {
    const plain = new SessionLog('replay');
    chat(plain, '嗨', '你好');

    const retried = new SessionLog('replay');
    retried.append('turn/start', { kind: 'message', text: '嗨' });
    retried.append('model/start', {});
    retried.append('llm/retry', {
      retryId: 'r1',
      retry: 1,
      maxRetries: 2,
      failure: { message: '壞了', code: 'SERVER', status: 500 },
    });
    retried.append('llm/retry-started', { retryId: 'r1', retry: 1, waitedMs: 1200 });
    retried.append('assistant/message', { message: reply('你好') });
    retried.append('model/end', {});
    retried.append('turn/end', {});

    expect(shape(replayConversation(retried.events))).toEqual(
      shape(replayConversation(plain.events)),
    );
  });

  it('只記日誌的事件不產訊息', () => {
    const log = new SessionLog('replay');
    log.append('model/start', {});
    log.append('model/end', {});
    log.append('session/end-seed', {});
    log.append('subagent/model-selection-policy', { allowedModels: ['m'] });
    chat(log, '嗨', '你好');
    log.append('model/usage', { inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    log.append('llm/retry-started', { retryId: 'r1', retry: 1, waitedMs: 0 });

    expect(shape(replayConversation(log.events))).toEqual(['human:嗨', 'ai:你好']);
  });
});

describe('哪幾種事件進模型（#681）', () => {
  it('恰好五種：turn/start、assistant/message、tool/result、user/message、compaction/summary', () => {
    expect([...MODEL_VISIBLE_EVENT_TYPES].sort()).toEqual([
      'assistant/message',
      'compaction/summary',
      'tool/result',
      'turn/start',
      'user/message',
    ]);
  });

  it('守衛對只記日誌的種類為假，對進模型的為真', () => {
    const log = new SessionLog('replay');
    // `model/usage` 留在 core、不會被搬走（#679 第 4 步），拿它當「不進模型」的代表。
    log.append('model/usage', { inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    log.append('turn/start', { kind: 'message', text: '嗨' });
    expect(log.events.map((event) => isModelVisibleEvent(event))).toEqual([false, true]);
  });

  it('不認得的種類（別的套件補進來的）不進模型，也不炸', () => {
    const unknown = {
      type: 'plugin-x/custom',
      seq: 0,
      time: 0,
      data: {},
    } as unknown as SessionEvent;
    expect(isModelVisibleEvent(unknown)).toBe(false);
    expect(shape(replayConversation([unknown]))).toEqual([]);
  });
});

/**
 * **併發的工具結果照 `tool_calls` 的順序放，不照日誌的先後**——量過：先叫的慢、後叫的快時，日誌是快、慢，
 * graph state 是慢、快。照日誌的先後放的話，一則對一則就斷了，壓縮的切點會切錯地方。
 */
describe('一批工具結果', () => {
  it('照回覆裡要的順序放，不照落定的先後', () => {
    const log = new SessionLog('replay');
    log.append('turn/start', { kind: 'message', text: '兩個一起' });
    log.append('assistant/message', {
      message: asking('好', [
        ['slow', 'grep'],
        ['fast', 'ls'],
      ]),
    });
    log.append('tool/call', { callId: 'slow', name: 'grep', arguments: '{}' });
    log.append('tool/call', { callId: 'fast', name: 'ls', arguments: '{}' });
    log.append('tool/result', {
      callId: 'fast',
      isError: false,
      message: result('fast', 'ls', '快'),
    });
    log.append('tool/result', {
      callId: 'slow',
      isError: false,
      message: result('slow', 'grep', '慢'),
    });
    log.append('assistant/message', { message: reply('都好了') });
    log.append('turn/end', {});

    expect(shape(replayConversation(log.events))).toEqual([
      'human:兩個一起',
      'ai:好',
      'tool:slow:慢',
      'tool:fast:快',
      'ai:都好了',
    ]);
  });

  it('goal 收尾注入的那則跟著它那顆結果搬；repeat-reminder 的提醒在整批之後', () => {
    const log = new SessionLog('replay');
    log.append('turn/start', { kind: 'message', text: '收尾' });
    log.append('assistant/message', {
      message: asking('好', [
        ['done', 'update_goal'],
        ['look', 'ls'],
      ]),
    });
    log.append('tool/call', { callId: 'done', name: 'update_goal', arguments: '{}' });
    log.append('tool/call', { callId: 'look', name: 'ls', arguments: '{}' });
    log.append('tool/result', {
      callId: 'look',
      isError: false,
      message: result('look', 'ls', '檔'),
    });
    log.append('tool/result', {
      callId: 'done',
      isError: false,
      message: result('done', 'update_goal', '完成'),
    });
    log.append('user/message', {
      message: toLoggedMessage(new HumanMessage('寫一份總結')),
      source: { kind: 'plugin', plugin: 'update_goal' },
    });
    log.append('user/message', {
      message: toLoggedMessage(new HumanMessage('你在重複')),
      source: { kind: 'plugin', plugin: 'repeat-reminder' },
    });
    log.append('assistant/message', { message: reply('總結') });
    log.append('turn/end', {});

    expect(shape(replayConversation(log.events))).toEqual([
      'human:收尾',
      'ai:好',
      'tool:done:完成',
      'human:寫一份總結',
      'tool:look:檔',
      'human:你在重複',
      'ai:總結',
    ]);
  });

  it('`toolResultAsSeen` 只換工具結果', () => {
    const log = new SessionLog('replay');
    log.append('turn/start', { kind: 'message', text: '讀' });
    log.append('assistant/message', { message: asking('好', [['c1', 'execute']]) });
    tool(log, 'c1', 'execute', '很長的輸出');
    log.append('assistant/message', { message: reply('讀完了') });
    log.append('turn/end', {});

    const replay = replayConversation(log.events, {
      toolResultAsSeen: (message) =>
        new ToolMessage({ content: `預覽：${message.text}`, tool_call_id: message.tool_call_id }),
    });
    expect(shape(replay)).toEqual(['human:讀', 'ai:好', 'tool:c1:預覽：很長的輸出', 'ai:讀完了']);
  });
});

/**
 * **沒配到結果的呼叫補 dsh 的原字串，不是讓基座補**：基座那句說「another message came in」，續接之後
 * 走得到它（實測），而那不是成因。所以這幾條斷言的是**字**——只斷言「推出來的串裡有一則 ToolMessage」
 * 的話，把補結果整段拿掉之後基座照樣補一則，驗收照樣綠。
 */
describe('沒配到結果的呼叫', () => {
  function crashed(): SessionLog {
    const log = new SessionLog('replay');
    log.append('turn/start', { kind: 'message', text: '跑兩個' });
    log.append('assistant/message', {
      message: asking('好', [
        ['recorded', 'execute'],
        ['unrecorded', 'ls'],
      ]),
    });
    log.append('tool/call', { callId: 'recorded', name: 'execute', arguments: '{}' });
    return log;
  }

  it('記過 `tool/call` 的說結果不明，沒記過的說還沒開始——照 dsh 的 repair.ts', () => {
    const log = crashed();
    const replay = replayConversation([
      ...log.events,
      { type: 'session/end-seed', seq: log.length, time: 0, data: {} },
    ]);

    expect(shape(replay)).toEqual([
      'human:跑兩個',
      'ai:好',
      `tool:recorded:${TOOL_OUTCOME_UNKNOWN_TEXT}`,
      `tool:unrecorded:${TOOL_NOT_STARTED_TEXT}`,
    ]);
    const [, , recorded, unrecorded] = replay.kind === 'replayed' ? replay.messages : [];
    expect((recorded as ToolMessage).status).toBe('error');
    expect(toolErrorOf(recorded)).toEqual({
      name: 'ToolOutcomeUnknownError',
      code: TOOL_OUTCOME_UNKNOWN,
    });
    expect(toolErrorOf(unrecorded)).toEqual({
      name: 'ToolNotStartedError',
      code: TOOL_NOT_STARTED,
    });
  });

  it('日誌停在半路、還沒有 end-seed：一樣補', () => {
    expect(shape(replayConversation(crashed().events)).slice(2)).toEqual([
      `tool:recorded:${TOOL_OUTCOME_UNKNOWN_TEXT}`,
      `tool:unrecorded:${TOOL_NOT_STARTED_TEXT}`,
    ]);
  });

  it('停在核准點時行程結束：那一輪收掉了，那顆呼叫一樣要補', () => {
    const log = new SessionLog('replay');
    log.append('turn/start', { kind: 'message', text: '寫檔' });
    log.append('assistant/message', { message: asking('要核准', [['c1', 'write_file']]) });
    log.append('tool/call', { callId: 'c1', name: 'write_file', arguments: '{}' });
    log.append('interrupt/raised', { interruptId: 'i1' });
    log.append('turn/end', {});
    const resumed = new SessionLog('replay', { seed: log.events });
    resumed.append('turn/start', { kind: 'message', text: '算了' });
    resumed.append('assistant/message', { message: reply('好') });
    resumed.append('turn/end', {});

    expect(shape(replayConversation(resumed.events))).toEqual([
      'human:寫檔',
      'ai:要核准',
      `tool:c1:${TOOL_OUTCOME_UNKNOWN_TEXT}`,
      'human:算了',
      'ai:好',
    ]);
  });

  it('補在那一批的位置，不在串尾：之後的訊息照舊接在後面', () => {
    const log = crashed();
    const resumed = new SessionLog('replay', { seed: log.events });
    chat(resumed, '還在嗎', '在');

    expect(shape(replayConversation(resumed.events))).toEqual([
      'human:跑兩個',
      'ai:好',
      `tool:recorded:${TOOL_OUTCOME_UNKNOWN_TEXT}`,
      `tool:unrecorded:${TOOL_NOT_STARTED_TEXT}`,
      'human:還在嗎',
      'ai:在',
    ]);
  });
});

/**
 * **切點直接用在推出來的串上，對不上就整串不灌。** 這一組是**舊順序**（格式 44 以前，沒有 `beforeCall`）：
 * `compaction/summary` 落在它那次呼叫的回覆之後，所以那一刻推出來的是 `messagesBefore + 1` 則（對真的摘要器量過：三次壓縮都是）。
 * 新順序見下一組。
 */
describe('壓縮', () => {
  /** 四則之後，第三次呼叫時壓縮：那時 state 有五則，切在 3。 */
  function compacted(log: SessionLog): void {
    chat(log, '一', 'A');
    chat(log, '二', 'B');
    log.append('turn/start', { kind: 'message', text: '三' });
    log.append('assistant/message', { message: reply('C') });
    log.append('compaction/summary', {
      cutoffIndex: 3,
      messagesBefore: 5,
      filePath: null,
      summary: summaryMessage('摘要一'),
    });
    log.append('turn/end', {});
  }

  it('模型拿到的是摘要加上切點之後的', () => {
    const log = new SessionLog('replay');
    compacted(log);
    chat(log, '四', 'D');

    expect(shape(replayConversation(log.events))).toEqual([
      'human:摘要一',
      'ai:B',
      'human:三',
      'ai:C',
      'human:四',
      'ai:D',
    ]);
  });

  /**
   * `origin` 交出每一則出自哪一顆（#631 的內容搜尋拿它判哪幾顆還在串上）。對得上的只有留下來的那幾則：
   * 被壓掉的「一」「A」「二」叫過 `origin`，但不在回傳的串裡；補上的結果不叫。
   */
  it('`origin`：留下來的每一則都對得回它那一顆，補上的結果沒有來源', () => {
    const log = new SessionLog('replay');
    compacted(log);
    log.append('turn/start', { kind: 'message', text: '四' });
    log.append('assistant/message', { message: asking('查', [['c1', 'ls']]) });
    log.append('turn/end', {});

    const seqOf = new Map<BaseMessage, number>();
    const replay = replayConversation(log.events, {
      origin: (message, event) => seqOf.set(message, event.seq),
    });
    if (replay.kind !== 'replayed') throw new Error(replay.reason);
    const typeOf = new Map(log.events.map((event) => [event.seq, event.type]));
    expect(
      replay.messages.map((message) => {
        const seq = seqOf.get(message);
        return seq === undefined
          ? `補:${message.text.slice(0, 10)}`
          : `${typeOf.get(seq)}:${message.text}`;
      }),
    ).toEqual([
      'compaction/summary:摘要一',
      'assistant/message:B',
      'turn/start:三',
      'assistant/message:C',
      'turn/start:四',
      'assistant/message:查',
      `補:${TOOL_NOT_STARTED_TEXT.slice(0, 10)}`,
    ]);
    // 被壓掉的三則也叫過，所以「叫過」不等於「在串上」：讀者要拿回傳的串去對。
    expect(seqOf.size).toBe(9);
  });

  it('壓了兩次：以最後一次為準，切點仍是原始串的座標', () => {
    const log = new SessionLog('replay');
    compacted(log);
    log.append('turn/start', { kind: 'message', text: '四' });
    log.append('assistant/message', { message: reply('D') });
    log.append('compaction/summary', {
      cutoffIndex: 5,
      messagesBefore: 7,
      filePath: null,
      summary: summaryMessage('摘要二'),
    });
    log.append('turn/end', {});

    expect(shape(replayConversation(log.events))).toEqual([
      'human:摘要二',
      'ai:C',
      'human:四',
      'ai:D',
    ]);
  });

  /**
   * **續接之後的切點以灌回去的那一串為座標**：`end-seed` 之後 state 從「摘要＋之後」起算。穿過 end-seed 時
   * 不換座標的話，這裡推出來是 9 則、對不上 `messagesBefore + 1`，整串不灌。
   */
  it('續接之後再壓一次：切點以那時灌回去的那一串為座標', () => {
    const first = new SessionLog('replay');
    compacted(first);
    const resumed = new SessionLog('replay', { seed: first.events });
    // 灌回去的是 [摘要一, B, 三, C]，這一輪問的時候 state 是那四則加上「四」。
    resumed.append('turn/start', { kind: 'message', text: '四' });
    resumed.append('assistant/message', { message: reply('D') });
    resumed.append('compaction/summary', {
      cutoffIndex: 2,
      messagesBefore: 5,
      filePath: null,
      summary: summaryMessage('摘要二'),
    });
    resumed.append('turn/end', {});

    expect(shape(replayConversation(resumed.events))).toEqual([
      'human:摘要二',
      'human:三',
      'ai:C',
      'human:四',
      'ai:D',
    ]);
  });

  it('那一刻的則數對不上：推不出來，不切', () => {
    const log = new SessionLog('replay');
    chat(log, '一', 'A');
    log.append('turn/start', { kind: 'message', text: '二' });
    log.append('assistant/message', { message: reply('B') });
    const misaligned = log.append('compaction/summary', {
      cutoffIndex: 1,
      messagesBefore: 9,
      filePath: null,
      summary: summaryMessage('摘要'),
    });

    expect(replayConversation(log.events)).toEqual({
      kind: 'unreplayable',
      reason: 'compaction-misaligned',
      seq: misaligned.seq,
    });
  });
});

/**
 * **摘要事件排在用到它的呼叫之前**（#1301，format 45，照 dsh 的 `compaction-basic`）：事件帶 `beforeCall: true`，
 * 記下它時還沒有那次呼叫的回覆，所以推出來的是 `messagesBefore` 則；舊日誌沒有這個欄位，仍是 `messagesBefore + 1`。
 * 逐筆判，不是逐檔——續接舊檔會把標頭版本改成新的，同一個檔可以兩種順序都有。
 */
describe('壓縮（摘要事件在呼叫之前）', () => {
  /** 同 `compacted`，但摘要事件在第三次呼叫的回覆之前：那時 state 有五則（一 A 二 B 三），切在 3。 */
  function compactedBefore(log: SessionLog): void {
    chat(log, '一', 'A');
    chat(log, '二', 'B');
    log.append('turn/start', { kind: 'message', text: '三' });
    log.append('compaction/summary', {
      cutoffIndex: 3,
      messagesBefore: 5,
      filePath: null,
      summary: summaryMessage('摘要一'),
      beforeCall: true,
    });
    log.append('assistant/message', { message: reply('C') });
    log.append('turn/end', {});
  }

  it('推出來的串與舊順序逐則相同', () => {
    const before = new SessionLog('replay');
    compactedBefore(before);
    chat(before, '四', 'D');
    const after = new SessionLog('replay');
    chat(after, '一', 'A');
    chat(after, '二', 'B');
    after.append('turn/start', { kind: 'message', text: '三' });
    after.append('assistant/message', { message: reply('C') });
    after.append('compaction/summary', {
      cutoffIndex: 3,
      messagesBefore: 5,
      filePath: null,
      summary: summaryMessage('摘要一'),
    });
    after.append('turn/end', {});
    chat(after, '四', 'D');

    const expected = ['human:摘要一', 'ai:B', 'human:三', 'ai:C', 'human:四', 'ai:D'];
    expect(shape(replayConversation(before.events))).toEqual(expected);
    expect(shape(replayConversation(after.events))).toEqual(expected);
  });

  it('只有摘要事件、回覆還沒到（呼叫失敗或當機）：摘要照用，之後補不到的回覆不補', () => {
    const log = new SessionLog('replay');
    chat(log, '一', 'A');
    chat(log, '二', 'B');
    log.append('turn/start', { kind: 'message', text: '三' });
    log.append('compaction/summary', {
      cutoffIndex: 3,
      messagesBefore: 5,
      filePath: null,
      summary: summaryMessage('摘要一'),
      beforeCall: true,
    });

    expect(shape(replayConversation(log.events))).toEqual(['human:摘要一', 'ai:B', 'human:三']);
  });

  it('呼叫失敗後重打又摘要一次：兩筆之間沒有新訊息，以最後一筆為準', () => {
    const log = new SessionLog('replay');
    chat(log, '一', 'A');
    chat(log, '二', 'B');
    log.append('turn/start', { kind: 'message', text: '三' });
    log.append('compaction/summary', {
      cutoffIndex: 3,
      messagesBefore: 5,
      filePath: null,
      summary: summaryMessage('摘要甲'),
      beforeCall: true,
    });
    // 模型呼叫失敗，graph state 沒存到 `_summarizationEvent`，下一次呼叫從原始的五則再摘要：座標仍是原始串的。
    log.append('compaction/summary', {
      cutoffIndex: 3,
      messagesBefore: 5,
      filePath: null,
      summary: summaryMessage('摘要乙'),
      beforeCall: true,
    });
    log.append('assistant/message', { message: reply('C') });
    log.append('turn/end', {});

    expect(shape(replayConversation(log.events))).toEqual([
      'human:摘要乙',
      'ai:B',
      'human:三',
      'ai:C',
    ]);
  });

  it('同一個檔新舊順序混著：舊的用 +1、新的用 +0，各判各的', () => {
    const log = new SessionLog('replay');
    // 舊順序：回覆之後才記，messagesBefore 5
    chat(log, '一', 'A');
    chat(log, '二', 'B');
    log.append('turn/start', { kind: 'message', text: '三' });
    log.append('assistant/message', { message: reply('C') });
    log.append('compaction/summary', {
      cutoffIndex: 3,
      messagesBefore: 5,
      filePath: null,
      summary: summaryMessage('摘要一'),
    });
    log.append('turn/end', {});
    log.append('turn/start', { kind: 'message', text: '四' });
    log.append('compaction/summary', {
      cutoffIndex: 5,
      messagesBefore: 7,
      filePath: null,
      summary: summaryMessage('摘要二'),
      beforeCall: true,
    });
    log.append('assistant/message', { message: reply('D') });
    log.append('turn/end', {});

    expect(shape(replayConversation(log.events))).toEqual([
      'human:摘要二',
      'ai:C',
      'human:四',
      'ai:D',
    ]);
  });

  it('標了 beforeCall 卻用回覆之後的則數（+1）：對不上，不切', () => {
    const log = new SessionLog('replay');
    chat(log, '一', 'A');
    log.append('turn/start', { kind: 'message', text: '二' });
    const wrong = log.append('compaction/summary', {
      cutoffIndex: 1,
      messagesBefore: 2, // 這一刻是 3 則；記成 +1 之前的 2 就不對
      filePath: null,
      summary: summaryMessage('摘要'),
      beforeCall: true,
    });

    expect(replayConversation(log.events)).toEqual({
      kind: 'unreplayable',
      reason: 'compaction-misaligned',
      seq: wrong.seq,
    });
  });

  it('沒標 beforeCall 卻在回覆之前記（則數少一）：對不上，不切', () => {
    const log = new SessionLog('replay');
    chat(log, '一', 'A');
    log.append('turn/start', { kind: 'message', text: '二' });
    const wrong = log.append('compaction/summary', {
      cutoffIndex: 1,
      messagesBefore: 3,
      filePath: null,
      summary: summaryMessage('摘要'),
    });

    expect(replayConversation(log.events)).toEqual({
      kind: 'unreplayable',
      reason: 'compaction-misaligned',
      seq: wrong.seq,
    });
  });
});

/**
 * **工具結果剪刀的剪法**（#1302，格式 46）：`compaction/prune` 記了哪幾顆工具結果剪成什麼。`applyPrunes` 開著，推出來的是模型實際收到的
 * 那一份；省略（續接灌回 graph state 用的）仍是原文，剪刀下一次請求會照日誌換上去。
 */
describe('工具結果剪刀的剪法（applyPrunes）', () => {
  const ORIGINAL = '字'.repeat(300);

  /** 叫一次工具、得到一顆大結果，然後記下剪法。 */
  function pruned(log: SessionLog, originalChars = 300): void {
    log.append('turn/start', { kind: 'message', text: '查' });
    log.append('assistant/message', { message: asking('好', [['c1', 'grep']]) });
    tool(log, 'c1', 'grep', ORIGINAL);
    log.append('compaction/prune', {
      results: [{ callId: 'c1', originalChars, content: '頭…尾' }],
    });
    log.append('assistant/message', { message: reply('找到了') });
    log.append('turn/end', {});
  }

  it('預設不套：仍是原文', () => {
    const log = new SessionLog('replay');
    pruned(log);
    expect(shape(replayConversation(log.events))).toEqual([
      'human:查',
      'ai:好',
      `tool:c1:${ORIGINAL}`,
      'ai:找到了',
    ]);
  });

  it('applyPrunes：被剪的那顆換成記下的內容，其餘不動', () => {
    const log = new SessionLog('replay');
    pruned(log);
    expect(shape(replayConversation(log.events, { applyPrunes: true }))).toEqual([
      'human:查',
      'ai:好',
      'tool:c1:頭…尾',
      'ai:找到了',
    ]);
  });

  it('文字量對不上（同一個 callId 是另一顆結果）不換', () => {
    const log = new SessionLog('replay');
    pruned(log, 299);
    expect(shape(replayConversation(log.events, { applyPrunes: true }))[2]).toBe(
      `tool:c1:${ORIGINAL}`,
    );
  });

  it('只用 `model/start` 之前的日誌推：剪法還沒記的那一次請求仍是原文', () => {
    const log = new SessionLog('replay');
    log.append('turn/start', { kind: 'message', text: '查' });
    log.append('assistant/message', { message: asking('好', [['c1', 'grep']]) });
    tool(log, 'c1', 'grep', ORIGINAL);
    const before = log.events;
    log.append('compaction/prune', {
      results: [{ callId: 'c1', originalChars: 300, content: '頭…尾' }],
    });
    log.append('model/start', {});

    expect(shape(replayConversation(before, { applyPrunes: true }))[2]).toBe(`tool:c1:${ORIGINAL}`);
    expect(shape(replayConversation(log.events.slice(0, -1), { applyPrunes: true }))[2]).toBe(
      'tool:c1:頭…尾',
    );
  });

  it('壓縮的切點仍是原始串的座標：剪法不改則數，摘要之後被剪的結果照樣換', () => {
    const log = new SessionLog('replay');
    chat(log, '一', 'A');
    log.append('turn/start', { kind: 'message', text: '查' });
    log.append('assistant/message', { message: asking('好', [['c1', 'grep']]) });
    tool(log, 'c1', 'grep', ORIGINAL);
    log.append('compaction/prune', {
      results: [{ callId: 'c1', originalChars: 300, content: '頭…尾' }],
    });
    log.append('compaction/summary', {
      cutoffIndex: 2,
      messagesBefore: 5,
      filePath: null,
      summary: summaryMessage('摘要'),
      beforeCall: true,
    });
    log.append('assistant/message', { message: reply('找到了') });

    expect(shape(replayConversation(log.events, { applyPrunes: true }))).toEqual([
      'human:摘要',
      'human:查',
      'ai:好',
      'tool:c1:頭…尾',
      'ai:找到了',
    ]);
  });

  it('沒有 compaction/prune 時 applyPrunes 與不套逐則相同', () => {
    const log = new SessionLog('replay');
    log.append('turn/start', { kind: 'message', text: '查' });
    log.append('assistant/message', { message: asking('好', [['c1', 'grep']]) });
    tool(log, 'c1', 'grep', ORIGINAL);
    log.append('assistant/message', { message: reply('找到了') });
    log.append('turn/end', {});
    expect(shape(replayConversation(log.events, { applyPrunes: true }))).toEqual(
      shape(replayConversation(log.events)),
    );
  });
});

/**
 * **舊工具呼叫參數的縮短**（#1303，格式 47）：`compaction/truncate-args` 記了哪幾個參數縮成什麼。`applyArgTruncations` 開著，推出來的是
 * 模型實際收到的那一份；省略（續接灌回 graph state 用的）仍是原文，請求端下一次請求會照日誌換上去。
 */
describe('舊工具呼叫參數的縮短（applyArgTruncations）', () => {
  const ORIGINAL = 'abc'.repeat(100);
  const SHORT = 'abc...(argument truncated)';

  const argsOf = (replay: ConversationReplay, index: number): unknown => {
    if (replay.kind !== 'replayed') throw new Error(`推不出來：${replay.reason}`);
    return (replay.messages[index] as AIMessage).tool_calls?.[0]?.args;
  };

  /** 寫一次檔、得到結果，然後記下縮短。 */
  function truncated(log: SessionLog, originalChars = 300): void {
    log.append('turn/start', { kind: 'message', text: '寫' });
    log.append('assistant/message', {
      message: toLoggedMessage(
        new AIMessage({
          content: '好',
          tool_calls: [
            {
              id: 'c1',
              name: 'write_file',
              args: { file_path: '/a.txt', content: ORIGINAL },
              type: 'tool_call' as const,
            },
          ],
        }),
      ),
    });
    tool(log, 'c1', 'write_file', '寫好了');
    log.append('compaction/truncate-args', {
      calls: [{ callId: 'c1', args: { content: { originalChars, value: SHORT } } }],
    });
    log.append('assistant/message', { message: reply('完成') });
    log.append('turn/end', {});
  }

  it('預設不套：仍是原文', () => {
    const log = new SessionLog('replay');
    truncated(log);
    expect(argsOf(replayConversation(log.events), 1)).toEqual({
      file_path: '/a.txt',
      content: ORIGINAL,
    });
  });

  it('applyArgTruncations：被縮短的參數換成記下的字串，其餘參數與其他訊息不動', () => {
    const log = new SessionLog('replay');
    truncated(log);
    const replay = replayConversation(log.events, { applyArgTruncations: true });
    expect(argsOf(replay, 1)).toEqual({ file_path: '/a.txt', content: SHORT });
    expect(shape(replay)).toEqual(['human:寫', 'ai:好', 'tool:c1:寫好了', 'ai:完成']);
  });

  it('長度對不上（同一個 callId 是另一個呼叫）不換', () => {
    const log = new SessionLog('replay');
    truncated(log, 299);
    expect(argsOf(replayConversation(log.events, { applyArgTruncations: true }), 1)).toEqual({
      file_path: '/a.txt',
      content: ORIGINAL,
    });
  });

  it('只用 `model/start` 之前的日誌推：縮短還沒記的那一次請求仍是原文', () => {
    const log = new SessionLog('replay');
    log.append('turn/start', { kind: 'message', text: '寫' });
    log.append('assistant/message', {
      message: toLoggedMessage(
        new AIMessage({
          content: '好',
          tool_calls: [
            {
              id: 'c1',
              name: 'write_file',
              args: { content: ORIGINAL },
              type: 'tool_call' as const,
            },
          ],
        }),
      ),
    });
    tool(log, 'c1', 'write_file', '寫好了');
    const before = log.events;
    log.append('compaction/truncate-args', {
      calls: [{ callId: 'c1', args: { content: { originalChars: 300, value: SHORT } } }],
    });
    log.append('model/start', {});

    expect(argsOf(replayConversation(before, { applyArgTruncations: true }), 1)).toEqual({
      content: ORIGINAL,
    });
    expect(
      argsOf(replayConversation(log.events.slice(0, -1), { applyArgTruncations: true }), 1),
    ).toEqual({ content: SHORT });
  });

  it('與 applyPrunes 各管各的：同開時兩邊都換，只開一個只換那一個', () => {
    const log = new SessionLog('replay');
    truncated(log);
    log.append('compaction/prune', {
      results: [{ callId: 'c1', originalChars: 3, content: '短' }],
    });
    const both = replayConversation(log.events, { applyPrunes: true, applyArgTruncations: true });
    expect(argsOf(both, 1)).toEqual({ file_path: '/a.txt', content: SHORT });
    expect(shape(both)[2]).toBe('tool:c1:短');
    const onlyArgs = replayConversation(log.events, { applyArgTruncations: true });
    expect(argsOf(onlyArgs, 1)).toEqual({ file_path: '/a.txt', content: SHORT });
    expect(shape(onlyArgs)[2]).toBe('tool:c1:寫好了');
  });

  it('沒有 compaction/truncate-args 時 applyArgTruncations 與不套逐則相同', () => {
    const log = new SessionLog('replay');
    log.append('turn/start', { kind: 'message', text: '查' });
    log.append('assistant/message', { message: asking('好', [['c1', 'grep']]) });
    tool(log, 'c1', 'grep', '找到了');
    log.append('assistant/message', { message: reply('完成') });
    log.append('turn/end', {});
    expect(replayConversation(log.events, { applyArgTruncations: true })).toEqual(
      replayConversation(log.events),
    );
  });
});

/**
 * 沒有內容也沒有工具呼叫的助手訊息（#1300，照 dsh `surface.ts:136-142`）：推導時丟掉，
 * 但壓縮切點的座標仍算它——它在 graph state 裡有一格。
 */
describe('空的助手訊息', () => {
  /** 撞輸出上限那一步留下的：`max-tokens.ts` 清掉呼叫之後什麼都沒有。 */
  const emptyReply = () => toLoggedMessage(new AIMessage({ content: [] }));

  it('空內容、沒有工具呼叫的不進推導結果（內容是空陣列或空字串都一樣）', () => {
    for (const content of [[] as [], '']) {
      const log = new SessionLog('replay');
      log.append('turn/start', { kind: 'message', text: '一' });
      log.append('assistant/message', { message: toLoggedMessage(new AIMessage({ content })) });
      log.append('turn/end', {});
      chat(log, '二', 'B');

      expect(shape(replayConversation(log.events)), JSON.stringify(content)).toEqual([
        'human:一',
        'human:二',
        'ai:B',
      ]);
    }
  });

  it('對照：有內容的、只有工具呼叫（內容空）的都還在', () => {
    const log = new SessionLog('replay');
    log.append('turn/start', { kind: 'message', text: '一' });
    log.append('assistant/message', {
      message: toLoggedMessage(
        new AIMessage({
          content: [],
          tool_calls: [{ id: 'c1', name: 'ls', args: {}, type: 'tool_call' as const }],
        }),
      ),
    });
    tool(log, 'c1', 'ls', 'a.txt');
    log.append('assistant/message', { message: reply('有一個檔') });
    log.append('turn/end', {});

    expect(shape(replayConversation(log.events))).toEqual([
      'human:一',
      'ai:',
      'tool:c1:a.txt',
      'ai:有一個檔',
    ]);
  });

  /**
   * 切點與 `messagesBefore` 是 graph state 的座標，而 state 裡有那一格空訊息。
   * 丟早了，這裡推出來是 5 則、對不上 `messagesBefore + 1`，整串不灌。
   */
  it('壓縮的切點仍用 state 的座標：空訊息在切點之前也對得上', () => {
    const log = new SessionLog('replay');
    chat(log, '一', 'A');
    log.append('turn/start', { kind: 'message', text: '二' });
    log.append('assistant/message', { message: emptyReply() });
    log.append('turn/end', {});
    log.append('turn/start', { kind: 'message', text: '三' });
    log.append('assistant/message', { message: reply('C') });
    // state：[一, A, 二, ∅, 三, C]，壓縮時還沒有 C，所以 messagesBefore 是 5；切在 4，留下「三」。
    log.append('compaction/summary', {
      cutoffIndex: 4,
      messagesBefore: 5,
      filePath: null,
      summary: summaryMessage('摘要'),
    });
    log.append('turn/end', {});

    expect(shape(replayConversation(log.events))).toEqual(['human:摘要', 'human:三', 'ai:C']);
  });

  it('空訊息留在切點之後也被濾掉，其他照舊', () => {
    const log = new SessionLog('replay');
    chat(log, '一', 'A');
    log.append('turn/start', { kind: 'message', text: '二' });
    log.append('assistant/message', { message: emptyReply() });
    // state：[一, A, 二, ∅]；壓縮在下一輪問之前記不到，這裡直接在 ∅ 之後壓：messagesBefore 3，切在 2。
    log.append('compaction/summary', {
      cutoffIndex: 2,
      messagesBefore: 3,
      filePath: null,
      summary: summaryMessage('摘要'),
    });
    log.append('turn/end', {});

    expect(shape(replayConversation(log.events))).toEqual(['human:摘要', 'human:二']);
  });

  /**
   * 續接灌回去的串沒有空訊息，所以 `end-seed` 之後的座標也沒有它。
   * 穿過 end-seed 時不濾的話，這裡切點對不上 `messagesBefore + 1`。
   */
  it('續接之後再壓一次：切點以灌回去的那一串（沒有空訊息）為座標', () => {
    const first = new SessionLog('replay');
    chat(first, '一', 'A');
    first.append('turn/start', { kind: 'message', text: '二' });
    first.append('assistant/message', { message: emptyReply() });
    first.append('turn/end', {});
    chat(first, '三', 'C');
    const resumed = new SessionLog('replay', { seed: first.events });
    // 灌回去的是 [一, A, 二, 三, C]；這一輪問的時候 state 多一則「四」，回覆 D 之前壓縮：messagesBefore 6，切在 3。
    resumed.append('turn/start', { kind: 'message', text: '四' });
    resumed.append('assistant/message', { message: reply('D') });
    resumed.append('compaction/summary', {
      cutoffIndex: 3,
      messagesBefore: 6,
      filePath: null,
      summary: summaryMessage('摘要'),
    });
    resumed.append('turn/end', {});

    expect(shape(replayConversation(resumed.events))).toEqual([
      'human:摘要',
      'human:三',
      'ai:C',
      'human:四',
      'ai:D',
    ]);
  });

  it('`origin` 照舊對每一顆事件叫，但空訊息不在回傳的串裡', () => {
    const log = new SessionLog('replay');
    log.append('turn/start', { kind: 'message', text: '一' });
    const empty = log.append('assistant/message', { message: emptyReply() });
    log.append('turn/end', {});

    const seen: number[] = [];
    const replay = replayConversation(log.events, { origin: (_m, event) => seen.push(event.seq) });
    expect(seen).toContain(empty.seq);
    expect(shape(replay)).toEqual(['human:一']);
  });
});

/** 拍板 2：推不出完整的歷史，就不灌半截進去。 */
describe('推不出來', () => {
  it('一輪正常收尾卻沒有回覆（格式 8 以前每一輪都長這樣）', () => {
    const log = new SessionLog('replay');
    log.append('turn/start', { kind: 'message', text: '嗨' });
    log.append('model/start', {});
    log.append('model/end', {});
    const end = log.append('turn/end', {});

    expect(replayConversation(log.events)).toEqual({
      kind: 'unreplayable',
      reason: 'reply-missing',
      seq: end.seq,
    });
  });

  it('對照：停在核准點、被中止、拋錯收尾的那一輪可以沒有回覆', () => {
    const log = new SessionLog('replay');
    log.append('turn/start', { kind: 'resume' });
    log.append('interrupt/raised', { interruptId: 'i2' });
    log.append('turn/end', {});
    log.append('turn/start', { kind: 'message', text: '講' });
    log.append('turn/end', { reason: { kind: 'aborted', cause: { kind: 'user' } } });
    log.append('turn/start', { kind: 'message', text: '再講' });
    log.append('turn/failed', { message: '供應商掛了' });

    expect(shape(replayConversation(log.events))).toEqual(['human:講', 'human:再講']);
  });

  /**
   * **逐輪那道檢查碰不到的兩種舊日誌**：每一輪都被中止、或唯一那一輪沒收尾。它們推得出來的只有人話，
   * 灌進去就是半截，入口還會說「推回了 N 則」。所以整份日誌叫過模型卻一則回覆都沒有，也算推不出來。
   */
  it.each([
    [
      '每一輪都被中止',
      (log: SessionLog) => {
        log.append('turn/start', { kind: 'message', text: '講' });
        log.append('model/start', {});
        log.append('model/end', {});
        log.append('turn/end', { reason: { kind: 'aborted', cause: { kind: 'user' } } });
      },
    ],
    [
      '唯一那一輪沒收尾（行程死在半路）',
      (log: SessionLog) => {
        log.append('turn/start', { kind: 'message', text: '跑' });
        log.append('tool/call', { callId: 'c1', name: 'ls', arguments: '{}' });
      },
    ],
  ])('格式 8 以前、%s：推不出來', (_, write) => {
    const log = new SessionLog('replay');
    write(log);
    const firstRun = log.events.find(
      (event) => event.type === 'model/start' || event.type === 'tool/call',
    );

    expect(replayConversation(log.events)).toEqual({
      kind: 'unreplayable',
      reason: 'reply-missing',
      seq: firstRun?.seq,
    });
  });

  it('停在半路的呼叫（只有 model/start，沒配到 model/end）：推不出來', () => {
    const log = new SessionLog('replay');
    log.append('turn/start', { kind: 'message', text: '跑' });
    const started = log.append('model/start', {});

    expect(replayConversation(log.events)).toEqual({
      kind: 'unreplayable',
      reason: 'reply-missing',
      seq: started.seq,
    });
  });

  /**
   * **#1190**：第一次模型呼叫就沒正常回來（使用者按了停止、或供應商拋錯），整份日誌因此一則回覆都沒有。
   * 這不是格式 8 以前漏記，而是本來就沒有回覆；線上的圖狀態裡使用者那句話還在，下一次請求照樣帶它，
   * 所以續接推回來也要有——整份拒推會讓續接後的模型少看到一句。
   */
  it.each([
    ['使用者按了停止', 'aborted' as const],
    ['供應商拋錯', 'error' as const],
  ])('第一次呼叫就沒正常回來（%s）：使用者的話照樣推回來', (_, outcome) => {
    const log = new SessionLog('replay');
    log.append('turn/start', { kind: 'message', text: '第一句' });
    const start = log.append('model/start', {});
    log.append('model/end', { outcome, modelCall: start.seq });
    log.append('turn/end', { reason: { kind: 'aborted', cause: { kind: 'user' } } });
    // 第二句還沒得到回覆就重啟：整份日誌一則回覆都沒有。
    log.append('turn/start', { kind: 'message', text: '第二句' });

    expect(shape(replayConversation(log.events))).toEqual(['human:第一句', 'human:第二句']);
  });

  it('之後有了回覆也一樣（不靠「後來有回覆」才放行）', () => {
    const log = new SessionLog('replay');
    log.append('turn/start', { kind: 'message', text: '第一句' });
    const start = log.append('model/start', {});
    log.append('model/end', { outcome: 'aborted', modelCall: start.seq });
    log.append('turn/end', { reason: { kind: 'aborted', cause: { kind: 'user' } } });
    chat(log, '第二句', '好');

    expect(shape(replayConversation(log.events))).toEqual([
      'human:第一句',
      'human:第二句',
      'ai:好',
    ]);
  });

  it('行程死在第一次呼叫中途，續接補的 model/end { outcome: error } 之後推得出來', () => {
    const log = new SessionLog('replay');
    log.append('turn/start', { kind: 'message', text: '跑' });
    const start = log.append('model/start', {});
    // `resumeClosingInterruptedTurn` 補寫的收尾（#721）。
    log.append('model/end', { outcome: 'error', modelCall: start.seq });
    log.append('turn/end', { reason: { kind: 'interrupted' } });
    log.append('session/end-seed', {});

    expect(shape(replayConversation(log.events))).toEqual(['human:跑']);
  });

  it('對照：有一次正常回來的呼叫卻沒有回覆，仍然推不出來（格式 8 以前漏記），帶 outcome 的呼叫不改變這件事', () => {
    const log = new SessionLog('replay');
    log.append('turn/start', { kind: 'message', text: '一' });
    const aborted = log.append('model/start', {});
    log.append('model/end', { outcome: 'aborted', modelCall: aborted.seq });
    log.append('turn/end', { reason: { kind: 'aborted', cause: { kind: 'user' } } });
    log.append('turn/start', { kind: 'message', text: '二' });
    const normal = log.append('model/start', {});
    log.append('model/end', { modelCall: normal.seq });
    log.append('turn/end', { reason: { kind: 'aborted', cause: { kind: 'user' } } });

    expect(replayConversation(log.events)).toEqual({
      kind: 'unreplayable',
      reason: 'reply-missing',
      seq: normal.seq,
    });
  });

  it('對照：有回覆的日誌裡夾著一輪中止時一個字都沒出的，照樣推得出來', () => {
    const log = new SessionLog('replay');
    chat(log, '嗨', '你好');
    log.append('turn/start', { kind: 'message', text: '講長一點' });
    log.append('model/start', {});
    log.append('model/end', {});
    log.append('turn/end', { reason: { kind: 'aborted', cause: { kind: 'user' } } });

    expect(shape(replayConversation(log.events))).toEqual([
      'human:嗨',
      'ai:你好',
      'human:講長一點',
    ]);
  });

  it('工具結果沒帶內容（格式 8 以前）', () => {
    const log = new SessionLog('replay');
    log.append('turn/start', { kind: 'message', text: '列' });
    log.append('assistant/message', { message: asking('好', [['c1', 'ls']]) });
    log.append('tool/call', { callId: 'c1', name: 'ls', arguments: '{}' });
    const bare = log.append('tool/result', { callId: 'c1', isError: false });

    expect(replayConversation(log.events)).toEqual({
      kind: 'unreplayable',
      reason: 'result-missing',
      seq: bare.seq,
    });
  });

  it('壓縮沒帶摘要（格式 8 以前）', () => {
    const log = new SessionLog('replay');
    chat(log, '一', 'A');
    const bare = log.append('compaction/summary', {
      cutoffIndex: 1,
      messagesBefore: 2,
      filePath: null,
    });

    expect(replayConversation(log.events)).toEqual({
      kind: 'unreplayable',
      reason: 'summary-missing',
      seq: bare.seq,
    });
  });
});
