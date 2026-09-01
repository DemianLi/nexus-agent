/**
 * `todo_write` 這顆工具：**驗證、描述，與它寫進哪一份日誌**。
 *
 * 這一檔只走 registry 這一層——真的跑一次 agent、真的委派給 subagent 的那一半在
 * `apps/harness/src/todo-tool.test.ts`，因為那需要基座。兩邊不重複：這裡問的是「這顆
 * 工具自己說了什麼」，那邊問的是「LangGraph 真的把身分帶到它面前了嗎」。
 */

import { describe, expect, it } from 'vitest';

import type { StructuredTool } from '@langchain/core/tools';
import { createRegistry, SessionRegistry } from '@nexus/core';
import type { TodoItem } from '@nexus/core';

import {
  createTodoPlugin,
  TODO_EMPTY_CONTENT_MESSAGE,
  TODO_ERROR_PREFIX,
  TODO_NOT_ATTACHED_MESSAGE,
  TODO_TOOL_NAME,
  TODO_UNKNOWN_CALLER_MESSAGE,
  toTodoList,
  todoAmbiguousMessage,
  todoCountsMessage,
  todoDuplicateMessage,
  todoParallelMessage,
  todoToolDescription,
} from './index.js';

/** 掛一次，把註冊出來的工具拿出來。 */
function mount(allowParallelInProgress: boolean): {
  tool: StructuredTool;
  sessions: SessionRegistry;
  bind: () => () => void;
} {
  const registry = createRegistry();
  const plugin = createTodoPlugin({ allowParallelInProgress });
  const exit = registry.enter({ id: 'todo#0', name: plugin.name });
  plugin.apply(registry);
  exit();
  const entry = registry.tools.resolve(TODO_TOOL_NAME);
  if (entry === undefined) throw new Error('工具沒註冊上');
  const sessions = new SessionRegistry('unit');
  return { tool: entry.value, sessions, bind: () => registry.sessions.bind(sessions) };
}

/** root 的一次呼叫長什麼樣——單段 `checkpoint_ns`，見 `@nexus/core` 的 session-address。 */
const ROOT_CONFIG = { configurable: { checkpoint_ns: 'tools:root-call' } };

/** subagent 的一次呼叫：兩段。 */
const SUBAGENT_CONFIG = { configurable: { checkpoint_ns: 'tools:spawn-1|tools:its-call' } };

/**
 * 叫那顆工具一次。
 *
 * 走 `.invoke(input, config)`——**這一步本身也在驗東西**：`configurable` 要原樣到得了
 * handler 的第二個參數，不然身分那一層在真流量上根本沒有輸入。
 */
async function call(
  tool: StructuredTool,
  todos: readonly { content: string; status: string }[],
  config: unknown,
): Promise<string> {
  return (await tool.invoke({ todos }, config as never)) as string;
}

describe('驗證', () => {
  it('去空白後留下的才是 content', () => {
    expect(toTodoList([{ content: '  兩邊有空白  ', status: 'pending' }], true)).toEqual([
      { content: '兩邊有空白', status: 'pending' },
    ]);
  });

  it('content 空掉就拋，訊息逐字照 dsh', () => {
    expect(() => toTodoList([{ content: '   ', status: 'pending' }], true)).toThrow(
      TODO_EMPTY_CONTENT_MESSAGE,
    );
  });

  /** 去空白**之後**才比重複——不然 `'甲'` 與 `'甲 '` 會落成兩條一模一樣的條目。 */
  it('重複是去空白之後才比的', () => {
    expect(() =>
      toTodoList(
        [
          { content: '甲', status: 'pending' },
          { content: ' 甲 ', status: 'completed' },
        ],
        true,
      ),
    ).toThrow(todoDuplicateMessage('甲'));
  });

  it('允許並行時，三條 in_progress 過得去', () => {
    const todos = toTodoList(
      [
        { content: '甲', status: 'in_progress' },
        { content: '乙', status: 'in_progress' },
        { content: '丙', status: 'in_progress' },
      ],
      true,
    );
    expect(todos).toHaveLength(3);
  });

  it('禁止並行時，第二條就拒絕，而且說得出有幾條', () => {
    expect(() =>
      toTodoList(
        [
          { content: '甲', status: 'in_progress' },
          { content: '乙', status: 'in_progress' },
        ],
        false,
      ),
    ).toThrow(todoParallelMessage(2));
  });

  it('禁止並行時，剛好一條照樣過', () => {
    expect(
      toTodoList(
        [
          { content: '甲', status: 'in_progress' },
          { content: '乙', status: 'pending' },
        ],
        false,
      ),
    ).toHaveLength(2);
  });
});

describe('描述', () => {
  /**
   * **這一條釘的是「政策真的到得了模型」。** 兩個設定的描述只差活躍狀態那一段——差別
   * 沒了的話，`allowParallelInProgress: false` 就變成一個只會拒絕、卻沒告訴模型規則的
   * 組裝。
   */
  it('兩個設定的描述不一樣，而且各自講對規則', () => {
    expect(todoToolDescription(true)).toContain('several at once');
    expect(todoToolDescription(false)).toContain('AT MOST ONE');
    expect(todoToolDescription(true)).not.toBe(todoToolDescription(false));
  });

  it('掛上去的那顆工具用的就是那份描述', () => {
    expect(mount(false).tool.description).toBe(todoToolDescription(false));
  });
});

describe('計數', () => {
  it('三個計數各數各的，句子逐字照 dsh', () => {
    const todos: TodoItem[] = [
      { content: '甲', status: 'completed' },
      { content: '乙', status: 'in_progress' },
      { content: '丙', status: 'pending' },
      { content: '丁', status: 'pending' },
    ];
    expect(todoCountsMessage(todos)).toBe(
      'Updated todo list: 2 pending, 1 in progress, 1 completed.',
    );
  });
});

describe('寫進哪一份', () => {
  it('root 的呼叫寫進 root 那一份，回的是計數', async () => {
    const { tool, sessions, bind } = mount(true);
    bind();
    const answer = await call(tool, [{ content: '把它做完', status: 'in_progress' }], ROOT_CONFIG);

    expect(answer).toBe('Updated todo list: 0 pending, 1 in progress, 0 completed.');
    expect(sessions.root.events.map((event) => event.type)).toEqual(['todo/write']);
    expect(sessions.root.events[0]?.data).toEqual({
      todos: [{ content: '把它做完', status: 'in_progress' }],
    });
  });

  /**
   * **這一條是 dsh 單一所有者規則的單元版**，而它同時是 `rootOnly` 的反面絆索：
   * 這顆工具要是被宣告成 `rootOnly`，subagent 那次呼叫會撞上拒絕樁而不是開出第二份。
   */
  it('subagent 的呼叫開出自己那一份，root 那份不動', async () => {
    const { tool, sessions, bind } = mount(true);
    bind();
    await call(tool, [{ content: '根的', status: 'pending' }], ROOT_CONFIG);
    await call(tool, [{ content: '子代理的', status: 'pending' }], SUBAGENT_CONFIG);

    const entries = sessions.list();
    expect(entries.map((entry) => entry.address.kind)).toEqual(['root', 'subagent']);
    expect(entries[0]?.log.events).toHaveLength(1);
    expect(entries[1]?.log.events).toHaveLength(1);
    expect(entries[1]?.log.events[0]?.data).toEqual({
      todos: [{ content: '子代理的', status: 'pending' }],
    });
  });

  it('整表替換：第二次寫的是完整的新清單，不是差異', async () => {
    const { tool, sessions, bind } = mount(true);
    bind();
    await call(
      tool,
      [
        { content: '甲', status: 'pending' },
        { content: '乙', status: 'pending' },
      ],
      ROOT_CONFIG,
    );
    await call(tool, [{ content: '甲', status: 'completed' }], ROOT_CONFIG);

    expect(sessions.root.events).toHaveLength(2);
    expect(sessions.root.events[1]?.data).toEqual({
      todos: [{ content: '甲', status: 'completed' }],
    });
  });

  it('沒接線就說得出原因，而且什麼都沒寫', async () => {
    const { tool, sessions } = mount(true);
    const answer = await call(tool, [{ content: '甲', status: 'pending' }], ROOT_CONFIG);

    expect(answer).toBe(TODO_NOT_ATTACHED_MESSAGE);
    expect(sessions.root.events).toEqual([]);
  });

  it('認不出呼叫者也說得出原因——**不猜成 root**', async () => {
    const { tool, sessions, bind } = mount(true);
    bind();
    const answer = await call(tool, [{ content: '甲', status: 'pending' }], undefined);

    expect(answer).toBe(TODO_UNKNOWN_CALLER_MESSAGE);
    expect(sessions.root.events).toEqual([]);
  });

  it('綁著兩份會話時挑不出來，說得出有幾份', async () => {
    const registry = createRegistry();
    const plugin = createTodoPlugin({ allowParallelInProgress: true });
    const exit = registry.enter({ id: 'todo#0', name: plugin.name });
    plugin.apply(registry);
    exit();
    registry.sessions.bind(new SessionRegistry('a'));
    registry.sessions.bind(new SessionRegistry('b'));

    const entry = registry.tools.resolve(TODO_TOOL_NAME);
    const answer = await call(entry!.value, [{ content: '甲', status: 'pending' }], ROOT_CONFIG);
    expect(answer).toBe(todoAmbiguousMessage(2));
  });

  /**
   * **驗證發生在找日誌之前。** 反過來的話，一份壞掉的清單在「沒接線」的組裝上會回
   * 「沒接線」——把模型送錯東西誤報成接線問題，而那兩件事要修的地方完全不同。
   *
   * **而且它回字串不是拋**：LangGraph 的 ToolNode 不接拋出來的東西，端到端的驗收在
   * `apps/harness/src/todo-tool.test.ts`。
   */
  it('清單壞掉時回的是驗證錯誤，不是接線錯誤——而且沒接線也一樣', async () => {
    const { tool, sessions } = mount(true);
    expect(await call(tool, [{ content: '  ', status: 'pending' }], ROOT_CONFIG)).toBe(
      TODO_ERROR_PREFIX + TODO_EMPTY_CONTENT_MESSAGE,
    );
    expect(sessions.root.events).toEqual([]);
  });
});

describe('註冊', () => {
  it('只掛一顆工具，命令與 middleware 一個都不碰', () => {
    const registry = createRegistry();
    const plugin = createTodoPlugin({ allowParallelInProgress: true });
    const exit = registry.enter({ id: 'todo#0', name: plugin.name });
    plugin.apply(registry);
    exit();

    expect([...registry.tools.effective().keys()]).toEqual([TODO_TOOL_NAME]);
    expect(registry.commands.list()).toEqual([]);
    expect(registry.middleware.list()).toEqual([]);
  });

  /**
   * **`rootOnly` 的反面絆索。** 宣告成 `rootOnly` 的話 fold 會把每個 subagent 那一份裡的
   * 同名項換成拒絕樁，而那與 dsh 的單一所有者規則相反——todo 是模型自己的草稿，每一次
   * spawn 各一份。這條與 `@nexus/plugin-goal` 走的是**兩條相反的政策**，兩邊各有一條
   * 絆索釘著。
   */
  it('刻意不是 rootOnly——subagent 也要有自己的清單', () => {
    const registry = createRegistry();
    const plugin = createTodoPlugin({ allowParallelInProgress: true });
    const exit = registry.enter({ id: 'todo#0', name: plugin.name });
    plugin.apply(registry);
    exit();

    expect(registry.tools.isRootOnly(TODO_TOOL_NAME)).toBe(false);
  });
});
