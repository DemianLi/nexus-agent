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
import { SessionLog } from './session-log.js';
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

  it('只記日誌的事件不產訊息', () => {
    const log = new SessionLog('replay');
    log.append('command/run', { commandId: 'k1', name: 'plan', source: { kind: 'user' } });
    log.append('command/done', { commandId: 'k1', kind: 'success' });
    log.append('plan/mode', { active: true });
    chat(log, '嗨', '你好');
    log.append('todo/write', { todos: [] });
    log.append('model/usage', { inputTokens: 1, outputTokens: 1, totalTokens: 2 });

    expect(shape(replayConversation(log.events))).toEqual(['human:嗨', 'ai:你好']);
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
 * **切點直接用在推出來的串上，對不上就整串不灌。** `compaction/summary` 落在它那次呼叫的回覆之後，所以那一刻
 * 推出來的是 `messagesBefore + 1` 則（對真的摘要器量過：三次壓縮都是）。
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
