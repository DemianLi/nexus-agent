import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
  createRepeatReminder,
  DEFAULT_REPEAT_REMINDER,
  GOAL_WRAPUP_MARKER,
  REPEAT_REMINDER_MARKER,
  resolveRepeatReminderSettings,
} from './repeat-reminder.js';
import type { RepeatReminderSettings } from './repeat-reminder.js';

/** `beforeModel` 拿出來直接呼叫用的形狀。 */
type BeforeModel = (state: {
  messages: readonly BaseMessage[];
}) => { messages: BaseMessage[] } | undefined;

/** 從 middleware 上取出 `beforeModel`，沒有就當場失敗。 */
function hookOf(settings?: Partial<RepeatReminderSettings>): BeforeModel {
  const middleware = createRepeatReminder(resolveRepeatReminderSettings(settings));
  const hook = (middleware as { beforeModel?: BeforeModel }).beforeModel;
  if (hook === undefined) throw new Error('這個 middleware 沒有 beforeModel');
  return hook;
}

/** 一次工具呼叫加上它的結果，兩則訊息。 */
function turn(name: string, args: Record<string, unknown>, id: string): BaseMessage[] {
  return [
    new AIMessage({
      content: '',
      tool_calls: [{ id, name, args, type: 'tool_call' as const }],
    }),
    new ToolMessage({ content: 'ok', tool_call_id: id, name }),
  ];
}

/**
 * 跑一場對話，逐輪收下提醒。
 *
 * **每一輪都把上一輪的提醒接回訊息串**——`beforeModel` 回的更新在圖裡是 append 進
 * `state.messages` 的，不接回去就等於在測一個不會發生的狀態，而「提醒本身會不會把鏈
 * 打斷」正好只有接回去才看得見。
 *
 * @param hook - 要跑的 `beforeModel`。
 * @param calls - 依序的工具呼叫。
 * @param prefix - 第一則之前先放的訊息，預設一句人講的話。
 * @returns 每一輪產出的提醒全文（沒有就是空陣列）。
 */
function conversation(
  hook: BeforeModel,
  calls: readonly { name: string; args: Record<string, unknown> }[],
  prefix: readonly BaseMessage[] = [new HumanMessage('開始')],
): string[][] {
  const messages: BaseMessage[] = [...prefix];
  const perTurn: string[][] = [];
  for (const [index, call] of calls.entries()) {
    messages.push(...turn(call.name, call.args, `c${index}`));
    const update = hook({ messages });
    const texts = (update?.messages ?? []).map((message) => message.text);
    perTurn.push(texts);
    messages.push(...(update?.messages ?? []));
  }
  return perTurn;
}

/** 同一個工具同一份參數，叫 n 次。 */
function same(n: number, name = 'grep'): { name: string; args: Record<string, unknown> }[] {
  return Array.from({ length: n }, () => ({ name, args: { pattern: 'x' } }));
}

const GENTLE_HEAD = 'You are repeating the exact same tool call with identical arguments.';
const DETAILED_HEAD = 'Repeated tool call detected:';

describe('resolveRepeatReminderSettings', () => {
  it('預設值就是 dsh 那組：3／5／8、全部工具、500 字', () => {
    expect(resolveRepeatReminderSettings()).toEqual({
      thresholds: [3, 5, 8],
      include: [],
      exclude: [],
      argumentsPreviewChars: 500,
    });
    // 匯出的常數與解出來的是同一組——會漂走的是「文件說 3／5／8、程式碼是別的」。
    expect(DEFAULT_REPEAT_REMINDER.thresholds).toEqual([3, 5, 8]);
  });

  it('門檻排序過才交出去 —— 升級規則讀的是 thresholds[0]', () => {
    expect(resolveRepeatReminderSettings({ thresholds: [8, 3, 5] }).thresholds).toEqual([3, 5, 8]);
  });

  /**
   * **設定錯了當場拋，不是靜默回退**（照 dsh 的 fail-loud 契約）。
   *
   * 逐條各給一個獨立的訊息片段，所以一個「只檢查了第一條」的實作過不了整組——全部
   * 共用一句話的話，`it.each` 會變成一條測試四個名字。
   */
  it.each([
    [{ thresholds: [] }, /是空陣列/],
    [{ thresholds: [1, 3] }, /1 不是重複/],
    [{ thresholds: [3, 2.5] }, /2\.5.*≥ 2 的整數/s],
    [{ thresholds: [3, 5, 3] }, /有重複的值/],
    [{ argumentsPreviewChars: 0 }, /argumentsPreviewChars 是 0/],
    [{ argumentsPreviewChars: 1.5 }, /argumentsPreviewChars 是 1\.5/],
  ] as const)('壞設定 %o 當場拋', (override, pattern) => {
    expect(() => resolveRepeatReminderSettings(override)).toThrow(pattern);
  });
});

describe('偵測：連續同工具同參數', () => {
  it('第 1、2 次沒有提醒，第 3 次是溫和版原文', () => {
    const perTurn = conversation(hookOf(), same(3));
    expect(perTurn[0]).toEqual([]);
    expect(perTurn[1]).toEqual([]);
    expect(perTurn[2]).toHaveLength(1);
    expect(perTurn[2]?.[0]).toContain(GENTLE_HEAD);
  });

  /**
   * **這條才是記號那一格的驗收句。**
   *
   * 提醒本身是一則 `HumanMessage`，而「新的使用者訊息清零」是規則之一。少了
   * {@link REPEAT_REMINDER_MARKER} 的排除，第 3 次那條提醒會把鏈重置成 1，第 5 次
   * **永遠到不了**——而且第 3 次照樣出現，只驗第 3 次的測試整條綠。
   */
  it('第 3 次的提醒不會把鏈打斷，第 5、8 次照樣來而且是詳細版', () => {
    const perTurn = conversation(hookOf(), same(8));
    expect(perTurn.map((texts) => texts.length)).toEqual([0, 0, 1, 0, 1, 0, 0, 1]);
    expect(perTurn[4]?.[0]).toContain(DETAILED_HEAD);
    expect(perTurn[4]?.[0]).toContain('- tool: grep');
    expect(perTurn[4]?.[0]).toContain('- consecutive_calls: 5');
    expect(perTurn[4]?.[0]).toContain('- arguments: {"pattern":"x"}');
    expect(perTurn[7]?.[0]).toContain('- consecutive_calls: 8');
  });

  it('同工具不同參數連叫 8 次，一次提醒都沒有', () => {
    const calls = Array.from({ length: 8 }, (_, index) => ({
      name: 'grep',
      args: { pattern: `x${index}` },
    }));
    expect(conversation(hookOf(), calls).flat()).toEqual([]);
  });

  it('屬性順序不同算同一次 —— 規範化是逐層 key 排序', () => {
    const calls = [
      { name: 'grep', args: { a: 1, b: { c: 2, d: 3 } } },
      { name: 'grep', args: { b: { d: 3, c: 2 }, a: 1 } },
      { name: 'grep', args: { b: { c: 2, d: 3 }, a: 1 } },
    ];
    expect(conversation(hookOf(), calls)[2]).toHaveLength(1);
  });

  it('中間換一個別的工具，鏈就斷了', () => {
    const calls = [...same(2), { name: 'read', args: { path: '/a' } }, ...same(2)];
    expect(conversation(hookOf(), calls).flat()).toEqual([]);
  });

  /**
   * **真的使用者訊息會清零**：人插了話就換了脈絡，跨過它的重複不是打轉。
   *
   * 跟上面那條「提醒不打斷鏈」是一對：一個驗真的重置有效，一個驗我們自己那則不算。
   * 少了任何一條，另一條都可能靠著錯誤的實作矇混過去。
   */
  it('人插一句話會清零，跨過它的重複不算', () => {
    const hook = hookOf();
    const messages: BaseMessage[] = [new HumanMessage('開始')];
    for (const [index, call] of same(2).entries())
      messages.push(...turn(call.name, call.args, `a${index}`));
    messages.push(new HumanMessage('等一下，改成這樣'));
    const perTurn: string[][] = [];
    for (const [index, call] of same(3).entries()) {
      messages.push(...turn(call.name, call.args, `b${index}`));
      const update = hook({ messages });
      perTurn.push((update?.messages ?? []).map((message) => message.text));
      messages.push(...(update?.messages ?? []));
    }
    // 人插話之後重新從 1 數，所以第 3 次才提醒。
    expect(perTurn.map((texts) => texts.length)).toEqual([0, 0, 1]);
    // **看的是哪一版提醒，不只是「有沒有」。** 沒有重置的話這一輪是總第 5 次，
    // 命中的是 `thresholds[1]` 的詳細版——次數對不對只有這一格分得出來。
    expect(perTurn[2]?.[0]).toContain(GENTLE_HEAD);
    expect(perTurn[2]?.[0]).not.toContain(DETAILED_HEAD);
  });

  it('同一則 AI 訊息裡並行的重複也算進同一條鏈', () => {
    const hook = hookOf();
    const call = (
      id: string,
    ): { id: string; name: string; args: Record<string, unknown>; type: 'tool_call' } => ({
      id,
      name: 'grep',
      args: { pattern: 'x' },
      type: 'tool_call',
    });
    const messages: BaseMessage[] = [
      new HumanMessage('開始'),
      new AIMessage({ content: '', tool_calls: [call('p1'), call('p2'), call('p3')] }),
      new ToolMessage({ content: 'ok', tool_call_id: 'p1', name: 'grep' }),
      new ToolMessage({ content: 'ok', tool_call_id: 'p2', name: 'grep' }),
      new ToolMessage({ content: 'ok', tool_call_id: 'p3', name: 'grep' }),
    ];
    const update = hook({ messages });
    // 三次都在同一輪，第三次命中門檻。
    expect(update?.messages).toHaveLength(1);
    expect(update?.messages[0]?.text).toContain(GENTLE_HEAD);
  });

  it('提醒帶著記號與 <tool> × <count>，不是一則看不出來歷的 human 訊息', () => {
    const perTurn = createRepeatReminder(resolveRepeatReminderSettings());
    const hook = (perTurn as { beforeModel?: BeforeModel }).beforeModel;
    if (hook === undefined) throw new Error('沒有 beforeModel');
    const messages: BaseMessage[] = [new HumanMessage('開始')];
    for (const [index, call] of same(3).entries())
      messages.push(...turn(call.name, call.args, `m${index}`));
    const update = hook({ messages });
    expect(update?.messages[0]?.additional_kwargs[REPEAT_REMINDER_MARKER]).toEqual({
      tool: 'grep',
      count: 3,
    });
  });
});

describe('goal 收尾指示這則合成訊息', () => {
  /** 一則帶記號的收尾指示，形狀同 `@nexus/plugin-goal` 造的那顆。 */
  function wrapup(): HumanMessage {
    return new HumanMessage({
      content: '<goal_complete>\n…\n</goal_complete>',
      additional_kwargs: { [GOAL_WRAPUP_MARKER]: { action: 'complete' } },
    });
  }

  /**
   * **收尾指示不是人插的話，所以鏈跨過它繼續數。**
   *
   * 它出現的時機正好是模型剛被告知不要再叫工具；清零的話，模型無視它繼續打轉時，
   * 門檻 3 的提醒要晚兩次才到——那跟收尾指示本身的目的相反。
   */
  it('鏈跨過收尾指示繼續累積，不像人插話那樣清零', () => {
    const hook = hookOf();
    const messages: BaseMessage[] = [new HumanMessage('開始')];
    for (const [index, call] of same(2).entries())
      messages.push(...turn(call.name, call.args, `w${index}`));
    messages.push(wrapup());
    messages.push(...turn('grep', { pattern: 'x' }, 'w2'));
    const update = hook({ messages });
    // 總第 3 次，門檻命中。清零的話這裡是第 1 次，一則提醒都沒有。
    expect((update?.messages ?? []).map((message) => message.text)).toHaveLength(1);
    expect(update?.messages[0]?.text).toContain(GENTLE_HEAD);
  });

  /**
   * **重入護欄問的是相反的問題，所以述詞不能只有一個。**
   *
   * 上面那條要求「鏈走訪把收尾指示當成不是人講的」。若把
   * {@link isReminder} 直接加寬成也認收尾指示的記號，這一條就會紅：收尾指示注入之後
   * 正好落在最後一則 AI 訊息之後，而那道護欄看到「這一輪貼過提醒了」就整輪不發。
   *
   * 兩條一起才釘得住「窄的留給護欄、寬的留給鏈走訪」。
   */
  it('收尾指示落在最後一則 AI 之後時，這一輪的提醒照樣發', () => {
    const hook = hookOf();
    const messages: BaseMessage[] = [new HumanMessage('開始')];
    for (const [index, call] of same(3).entries())
      messages.push(...turn(call.name, call.args, `g${index}`));
    messages.push(wrapup());
    const update = hook({ messages });
    expect((update?.messages ?? []).map((message) => message.text)).toHaveLength(1);
    expect(update?.messages[0]?.text).toContain(GENTLE_HEAD);
  });
});

describe('射程：include 與 exclude', () => {
  /**
   * **不受追蹤的呼叫對鏈透明——既不計數也不重置。**
   *
   * 這一格在 dsh 的偵測故事裡承重：穿插進迴圈的記錄類工具（`todo_write` 那種）不能
   * 掩蓋迴圈。實作成「重置」的話這條會紅，實作成「計數」的話門檻會提早命中。
   */
  it('exclude 的工具穿插進來，鏈不斷也不算它', () => {
    const calls = [
      { name: 'grep', args: { pattern: 'x' } },
      { name: 'todo_write', args: { todos: [] } },
      { name: 'grep', args: { pattern: 'x' } },
      { name: 'todo_write', args: { todos: [] } },
      { name: 'grep', args: { pattern: 'x' } },
    ];
    const perTurn = conversation(hookOf({ exclude: ['todo_write'] }), calls);
    // 三次 grep 落在第 1、3、5 輪，提醒跟著第三次 grep 走。
    expect(perTurn.map((texts) => texts.length)).toEqual([0, 0, 0, 0, 1]);
  });

  it('include 非空時，沒列到的工具整個不參與', () => {
    expect(conversation(hookOf({ include: ['read'] }), same(8)).flat()).toEqual([]);
  });

  it('include 的萬用字元只認 *，其餘元字元當字面', () => {
    // `mcp_*` 認得出 `mcp_search`。
    expect(conversation(hookOf({ include: ['mcp_*'] }), same(3, 'mcp_search'))[2]).toHaveLength(1);
    // `a.c` 不該認得 `abc`——`.` 是字面的點。
    expect(conversation(hookOf({ include: ['a.c'] }), same(3, 'abc')).flat()).toEqual([]);
  });
});

describe('參數預覽的上限', () => {
  it('超過上限就截斷，尾巴是 dsh 那個格式', () => {
    const long = 'y'.repeat(200);
    const calls = Array.from({ length: 5 }, () => ({ name: 'write', args: { text: long } }));
    const text = conversation(hookOf({ argumentsPreviewChars: 20 }), calls)[4]?.[0] ?? '';
    expect(text).toContain('… (+');
    expect(text).toMatch(/… \(\+\d+ more chars\)/);
    // **上限只限制模型看到的字，不限制偵測**：鏈的鍵比的是完整字串，所以這一輪本來就
    // 該提醒——它提醒了，就是那件事的證據。
    expect(text).toContain('- consecutive_calls: 5');
  });

  it('沒超過上限就原樣，不會多一條尾巴', () => {
    const calls = Array.from({ length: 5 }, () => ({ name: 'grep', args: { pattern: 'x' } }));
    expect(conversation(hookOf(), calls)[4]?.[0]).not.toContain('more chars');
  });
});
