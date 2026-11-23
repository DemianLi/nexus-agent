import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import {
  createUnsummarizedHistoryReader,
  createVisibleHistoryReader,
  markHistoryFromLog,
} from './history-shadow.js';
import type { SessionLookup } from './registry.js';
import {
  createRepeatReminder,
  createStepNoticeMiddleware,
  DEFAULT_REPEAT_REMINDER,
  REPEAT_REMINDER_MARKER,
  resolveRepeatReminderSettings,
} from './repeat-reminder.js';
import type { RepeatReminderSettings } from './repeat-reminder.js';
import { sourceKwargs } from './message-source.js';
import type { MessageSource } from './message-source.js';
import { SessionLog } from './session-log.js';
import { toLoggedMessage } from './logged-message.js';

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
  /** 一則帶來源的收尾指示，形狀同 `@nexus/plugin-goal` 造的那顆（來源 `plugin`）。 */
  function wrapup(): HumanMessage {
    return new HumanMessage({
      content: '<goal_complete>\n…\n</goal_complete>',
      additional_kwargs: {
        nexus_goal_wrapup: { action: 'complete' },
        ...sourceKwargs({ kind: 'plugin', plugin: 'update_goal' }),
      },
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

/**
 * **只有人講話才清零，生產者自己宣告來源**（[#662](https://github.com/DemianLi/nexus-agent/issues/662)）。
 *
 * 判準讀的是 `additional_kwargs` 上通用的來源，不是 core 裡一張記號白名單：續行輪次的頭、插件在一輪中間注入的
 * 訊息，都不必在這裡登記。
 */
describe('誰算「人講話」：看來源，不看記號白名單', () => {
  /** 兩次呼叫、一則 `human`、一次呼叫：總共第 3 次命中門檻，除非 `human` 把鏈清零。 */
  function hitsAfter(human: HumanMessage): number {
    const messages: BaseMessage[] = [new HumanMessage('開始')];
    for (const [index, call] of same(2).entries())
      messages.push(...turn(call.name, call.args, `s${index}`));
    messages.push(human);
    messages.push(...turn('grep', { pattern: 'x' }, 's2'));
    return (hookOf()({ messages })?.messages ?? []).length;
  }
  const withSource = (source: MessageSource) =>
    new HumanMessage({ content: 'x', additional_kwargs: sourceKwargs(source) });

  it('續行輪次的頭（goal 來源）不清零：兩個續行輪各重複兩次，第 3 次拿到提醒', () => {
    expect(hitsAfter(withSource({ kind: 'goal', goalId: 'g', revision: 1, round: 2 }))).toBe(1);
  });

  it('沒有來源的 HumanMessage 是人講的話：清零', () => {
    expect(hitsAfter(new HumanMessage('等一下'))).toBe(0);
  });

  it('來源是 user（輪中插話）：清零', () => {
    expect(hitsAfter(withSource({ kind: 'user' }))).toBe(0);
  });

  it('沒見過的 kind 也不清零——新的生產者不必改提醒器', () => {
    expect(hitsAfter(withSource({ kind: 'some-future-producer' }))).toBe(1);
    for (const kind of ['subagent-settled', 'agent-message', 'session-reference', 'plugin']) {
      expect(hitsAfter(withSource({ kind }))).toBe(1);
    }
  });

  it('來源形狀不對（沒有字串 kind）當作沒有來源：清零', () => {
    for (const bad of [null, 'goal', 3, { kind: 3 }, {}]) {
      const message = new HumanMessage({
        content: 'x',
        additional_kwargs: { nexus_source: bad },
      });
      expect(hitsAfter(message)).toBe(0);
    }
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

/**
 * [#1665](https://github.com/DemianLi/nexus-agent/issues/1665)：提醒與通知都進模型歷史，日誌那一關拒收就照 dsh 讓這一步失敗
 * （`packages/core/agent-loop/src/agent.ts:427-436`，`687f282e`），不吞。提醒的內容是工具名與截過的參數預覽，日誌那一關拒不了它的值，
 * 所以這幾格用 spy 造拒收。
 */
describe('記不進去：這一步失敗', () => {
  type Hook = (
    state: { messages: readonly BaseMessage[] },
    runtime?: { readonly configurable?: unknown },
  ) => { messages: BaseMessage[] } | undefined;

  const sessionsOf = (log: SessionLog) => ({
    forCall: (): SessionLookup => ({ kind: 'ok', address: { kind: 'root' }, log }),
  });

  /** 讓 `user/message` 寫不進去，其餘照真的寫。 */
  function rejectUserMessages(log: SessionLog, error: Error): void {
    const real = log.append.bind(log);
    vi.spyOn(log, 'append').mockImplementation(((type: never, data: never, options: never) => {
      if (type === 'user/message') throw error;
      return real(type, data, options);
    }) as typeof log.append);
  }

  /** 叫三次同一顆工具之後的訊息串：第三次之後一定有一則提醒。 */
  const repeated = (): BaseMessage[] => [
    new HumanMessage('開始'),
    ...turn('grep', { pattern: 'x' }, 'c0'),
    ...turn('grep', { pattern: 'x' }, 'c1'),
    ...turn('grep', { pattern: 'x' }, 'c2'),
  ];

  const reminderHook = (log: SessionLog): Hook =>
    (
      createRepeatReminder(resolveRepeatReminderSettings(), sessionsOf(log)) as unknown as {
        beforeModel: Hook;
      }
    ).beforeModel;

  it('提醒寫不進去：原錯往外拋', () => {
    const log = new SessionLog('r');
    const boom = new Error('寫不進去');
    rejectUserMessages(log, boom);
    expect(() => reminderHook(log)({ messages: repeated() }, { configurable: {} })).toThrow(boom);
  });

  it('反例：寫得進去就照常記、照常送', () => {
    const log = new SessionLog('r');
    const update = reminderHook(log)({ messages: repeated() }, { configurable: {} });
    expect(update?.messages).toHaveLength(1);
    expect(log.events.map((event) => event.type)).toEqual(['user/message']);
  });

  it.each(['not-attached', 'unknown-caller', 'ambiguous'] as const)(
    '查找是 %s：照送不記；history-source=log 時拋（#2355）',
    (kind) => {
      const sessions = { forCall: (): SessionLookup => ({ kind }) as SessionLookup };
      const hook = (
        createRepeatReminder(resolveRepeatReminderSettings(), sessions) as unknown as {
          beforeModel: Hook;
        }
      ).beforeModel;
      expect(hook({ messages: repeated() }, { configurable: {} })?.messages).toHaveLength(1);
      markHistoryFromLog(sessions);
      expect(() => hook({ messages: repeated() }, { configurable: {} })).toThrow(
        `重複提醒找不到這次呼叫的日誌（${kind}）`,
      );
    },
  );

  it('通知來源拋的錯不被吞：原樣往外拋', () => {
    const log = new SessionLog('n');
    const boom = new Error('寫不進去');
    const hook = (
      createStepNoticeMiddleware(() => {
        throw boom;
      }, sessionsOf(log)) as unknown as { beforeModel: Hook }
    ).beforeModel;
    expect(() => hook({ messages: [] }, { configurable: {} })).toThrow(boom);
  });
});

/**
 * `history-source=log` 的 root：鏈從日誌推出來、沒套摘要的那一串算（#2362）。
 *
 * state 那一邊用現成的 {@link conversation}（`state.messages` 讀法當基準），log 那一邊餵同一串呼叫，兩邊逐輪比提醒全文。
 */
describe('history-source=log：鏈讀日誌沒套摘要的那一串', () => {
  /** 圖裡 root 的一次呼叫：`checkpoint_ns` 只有它自己那一段；子代理多一層。鏈讀哪一串只看這個，不看 `forCall`。 */
  const ROOT_CALL = { configurable: { checkpoint_ns: 'model_request:abc' } };
  const SUBAGENT_CALL = { configurable: { checkpoint_ns: 'tools:abc|model_request:def' } };

  type Hook = (
    state: { messages: readonly BaseMessage[] },
    runtime?: { readonly configurable?: unknown },
  ) => { messages: BaseMessage[] } | undefined;

  const loggedHook = (log: SessionLog, address: 'root' | 'subagent' = 'root'): Hook => {
    const sessions = {
      forCall: (): SessionLookup => ({
        kind: 'ok',
        address: address === 'root' ? { kind: 'root' } : ({ kind: 'subagent' } as never),
        log,
      }),
    };
    markHistoryFromLog(sessions);
    return (
      createRepeatReminder(resolveRepeatReminderSettings(), sessions) as unknown as {
        beforeModel: Hook;
      }
    ).beforeModel;
  };

  /** 日誌上多一次 `grep`：回覆、呼叫、結果。 */
  function logGrep(log: SessionLog, id: string): void {
    log.append('model/start', {});
    log.append('assistant/message', {
      message: toLoggedMessage(
        new AIMessage({
          content: '',
          tool_calls: [{ id, name: 'grep', args: { pattern: 'x' }, type: 'tool_call' as const }],
        }),
      ),
    });
    log.append('model/end', {});
    log.append('tool/call', { callId: id, name: 'grep', arguments: '{"pattern":"x"}' });
    log.append('tool/result', {
      callId: id,
      isError: false,
      message: toLoggedMessage(new ToolMessage({ content: 'ok', tool_call_id: id, name: 'grep' })),
    });
  }

  /** 把到目前為止的整串都摘掉：切點落在最後，摘要之後只剩新長的。 */
  function summarizeAll(log: SessionLog): void {
    const total = createUnsummarizedHistoryReader()(log).length;
    log.append('compaction/summary', {
      cutoffIndex: total,
      messagesBefore: total,
      filePath: null,
      summary: toLoggedMessage(
        new HumanMessage({ content: '摘要', additional_kwargs: { lc_source: 'summarization' } }),
      ),
      beforeCall: true,
    });
  }

  /** 日誌上跑 n 次 `grep`，每次之後叫一次 `beforeModel`（`state` 給空的，證明沒讀它），收提醒全文。 */
  function runOnLog(
    log: SessionLog,
    hook: Hook,
    from: number,
    to: number,
    afterEach: (turn: number) => void = () => undefined,
    call: { readonly configurable: unknown } = ROOT_CALL,
  ): string[][] {
    const perTurn: string[][] = [];
    for (let n = from; n <= to; n += 1) {
      logGrep(log, `c${n}`);
      perTurn.push((hook({ messages: [] }, call)?.messages ?? []).map((m) => m.text));
      afterEach(n);
    }
    return perTurn;
  }

  const startLog = (): SessionLog => {
    const log = new SessionLog('chain');
    log.append('turn/start', { kind: 'message', text: '開始' });
    return log;
  };

  it('A 摘要之前：門檻 3／5／8 出的提醒跟 state 讀法逐字相同', () => {
    const log = startLog();
    const viaLog = runOnLog(log, loggedHook(log), 1, 8);
    const viaState = conversation(hookOf(), same(8));
    expect(viaLog).toEqual(viaState);
    expect(viaLog.map((texts) => texts.length)).toEqual([0, 0, 1, 0, 1, 0, 0, 1]);
  });

  it('B 摘要之後：鏈在切點之間接續，門檻照原來的次數到', () => {
    const log = startLog();
    const hook = loggedHook(log);
    const before = runOnLog(log, hook, 1, 4);
    summarizeAll(log);
    const after = runOnLog(log, hook, 5, 8);
    expect([...before, ...after]).toEqual(conversation(hookOf(), same(8)));
    expect(after.map((texts) => texts.length)).toEqual([1, 0, 0, 1]);
  });

  it('B 對照：套了摘要的那一串餵給 state 讀法，摘要之後鏈斷，第 5 次不出提醒', () => {
    const log = startLog();
    const hook = loggedHook(log);
    runOnLog(log, hook, 1, 4);
    summarizeAll(log);
    logGrep(log, 'c5');
    const visible = createVisibleHistoryReader()(log);
    expect(visible[0]?.text).toBe('摘要');
    // 沒套摘要的那一串在這一步是第 5 次，套了摘要的那一串只看得到切點之後的 1 次。
    expect(hook({ messages: [] }, ROOT_CALL)?.messages).toHaveLength(1);
    expect(hookOf()({ messages: visible })).toBeUndefined();
  });

  it('C 摘要之後又提醒：摘要前貼過的提醒不歸零鏈、也不重貼', () => {
    const log = startLog();
    const hook = loggedHook(log);
    const before = runOnLog(log, hook, 1, 3);
    expect(before[2]).toHaveLength(1);
    summarizeAll(log);
    const after = runOnLog(log, hook, 4, 8);
    expect([...before, ...after]).toEqual(conversation(hookOf(), same(8)));
    expect(after.map((texts) => texts.length)).toEqual([0, 1, 0, 0, 1]);
  });

  it('同一步再叫一次：這一步的提醒已經在日誌上，不重貼', () => {
    const log = startLog();
    const hook = loggedHook(log);
    runOnLog(log, hook, 1, 3);
    expect(hook({ messages: [] }, ROOT_CALL)).toBeUndefined();
  });

  it('中間有真使用者訊息：鏈清零，跟 state 讀法一樣', () => {
    const log = startLog();
    const hook = loggedHook(log);
    runOnLog(log, hook, 1, 2);
    log.append('turn/end', {});
    log.append('turn/start', { kind: 'message', text: '換個做法' });
    const after = runOnLog(log, hook, 3, 5);
    // 清零後重新從 1 數：全程第 5 次呼叫才是第 3 次。沒清零的話是 [1, 0, 1]，所以 [0, 0, 1] 證得出有清零。
    expect(after.map((texts) => texts.length)).toEqual([0, 0, 1]);
  });

  it('子代理讀它自己的日誌（#2751）：state.messages 給空的也照日誌出提醒', () => {
    const log = startLog();
    const hook = loggedHook(log, 'subagent');
    const viaLog = runOnLog(log, hook, 1, 8, undefined, SUBAGENT_CALL);
    expect(viaLog).toEqual(conversation(hookOf(), same(8)));
    expect(viaLog.map((texts) => texts.length)).toEqual([0, 0, 1, 0, 1, 0, 0, 1]);
  });

  it('日誌推不回歷史：這一步失敗，訊息分 root 與子代理，不退回 state', () => {
    const broken = (): SessionLog => {
      const log = new SessionLog('broken');
      log.append('turn/start', { kind: 'message', text: '甲' });
      log.append('model/start', {});
      log.append('model/end', {});
      log.append('turn/end', {});
      log.append('turn/start', { kind: 'message', text: '乙' });
      log.append('model/start', {});
      return log;
    };
    // state 有重複也不救：讀日誌那一步就拋。
    expect(() =>
      loggedHook(broken(), 'subagent')({ messages: repeated3() }, SUBAGENT_CALL),
    ).toThrow(/這個子代理的日誌推不回它的模型歷史/u);
    expect(() => loggedHook(broken())({ messages: repeated3() }, ROOT_CALL)).toThrow(
      /這條對話的日誌推不回模型歷史/u,
    );
  });

  it('子代理讀日誌：日誌是空的、state 有重複，不出提醒（不退回 state）', () => {
    const log = new SessionLog('sub');
    const hook = loggedHook(log, 'subagent');
    expect(hook({ messages: repeated3() }, SUBAGENT_CALL)).toBeUndefined();
  });

  describe('查日誌的時機', () => {
    const counted = (log: SessionLog, address: 'root' | 'subagent' = 'root') => {
      const forCall = vi.fn((): SessionLookup => ({
        kind: 'ok',
        address: address === 'root' ? { kind: 'root' } : ({ kind: 'subagent' } as never),
        log,
      }));
      return { sessions: { forCall }, forCall };
    };
    const hookOn = (sessions: { forCall(config: unknown): SessionLookup }): Hook =>
      (
        createRepeatReminder(resolveRepeatReminderSettings(), sessions) as unknown as {
          beforeModel: Hook;
        }
      ).beforeModel;
    /** 第 1 次呼叫之後：沒有提醒要出。 */
    const quiet = (): BaseMessage[] => [
      new HumanMessage('開始'),
      ...turn('grep', { pattern: 'x' }, 'c0'),
    ];
    const configurable = ROOT_CALL;

    it('state、沒提醒也沒通知：不查（只有要記提醒時才碰註冊表）', () => {
      const { sessions, forCall } = counted(new SessionLog('t'));
      expect(hookOn(sessions)({ messages: quiet() }, configurable)).toBeUndefined();
      expect(forCall).not.toHaveBeenCalled();
    });

    it('state、有提醒：只在記提醒時查一次', () => {
      const { sessions, forCall } = counted(new SessionLog('t'));
      expect(hookOn(sessions)({ messages: repeated3() }, configurable)?.messages).toHaveLength(1);
      expect(forCall).toHaveBeenCalledTimes(1);
    });

    it('log 的子代理、沒提醒：查一次（讀鏈）', () => {
      const log = startLog();
      const { sessions, forCall } = counted(log, 'subagent');
      markHistoryFromLog(sessions);
      logGrep(log, 'c0');
      expect(hookOn(sessions)({ messages: [] }, SUBAGENT_CALL)).toBeUndefined();
      expect(forCall).toHaveBeenCalledTimes(1);
    });

    it('log 的子代理、有提醒：查一次，讀與記共用，提醒記進它自己的日誌', () => {
      const log = startLog();
      const { sessions, forCall } = counted(log, 'subagent');
      markHistoryFromLog(sessions);
      logGrep(log, 'c0');
      logGrep(log, 'c1');
      logGrep(log, 'c2');
      expect(hookOn(sessions)({ messages: [] }, SUBAGENT_CALL)?.messages).toHaveLength(1);
      expect(forCall).toHaveBeenCalledTimes(1);
      expect(log.events.filter((e) => e.type === 'user/message')).toHaveLength(1);
    });

    it.each(['not-attached', 'unknown-caller', 'ambiguous'] as const)(
      'log 的子代理、查到的不是 ok（%s）：這一步失敗，不退回 state',
      (kind) => {
        const sessions = { forCall: (): SessionLookup => ({ kind }) as SessionLookup };
        markHistoryFromLog(sessions);
        // state 有重複也一樣：有提醒要記，記不進去就拋，不照 state 送。
        expect(() => hookOn(sessions)({ messages: repeated3() }, SUBAGENT_CALL)).toThrow(
          `重複提醒找不到這次呼叫的日誌（${kind}）`,
        );
      },
    );

    it('log 的 root、沒有通知來源：查一次，讀與記共用', () => {
      const log = startLog();
      const { sessions, forCall } = counted(log);
      markHistoryFromLog(sessions);
      logGrep(log, 'c0');
      logGrep(log, 'c1');
      logGrep(log, 'c2');
      expect(hookOn(sessions)({ messages: [] }, configurable)?.messages).toHaveLength(1);
      expect(forCall).toHaveBeenCalledTimes(1);
    });
  });

  const repeated3 = (): BaseMessage[] => [
    new HumanMessage('開始'),
    ...turn('grep', { pattern: 'x' }, 'c0'),
    ...turn('grep', { pattern: 'x' }, 'c1'),
    ...turn('grep', { pattern: 'x' }, 'c2'),
  ];
});
