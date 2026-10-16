/**
 * `todo_write` 這顆工具：**驗證、描述，與它寫進哪一份日誌**（[#1463](https://github.com/DemianLi/nexus-agent/issues/1463) 起掛在
 * Cordis 樹上）。
 *
 * 這一檔只走樹的這一層——真的跑一次 agent、真的委派給 subagent 的那一半在 `apps/harness/src/todo-tool.test.ts`，因為那需要
 * 基座；樹上兩條 thread 同時活著的每一種呼叫形狀在 `apps/harness/src/todo-on-tree.test.ts`。兩邊不重複：這裡問的是「這顆工具
 * 自己說了什麼」，那邊問的是「LangGraph 真的把身分帶到它面前了嗎」。
 *
 * **測試檔不受 SDK lint 管**（`PLUGIN_LINT_IGNORES`），所以這裡可以 import `@nexus/core` 造日誌與挑法；`src/index.ts` 不行。
 */

import { ToolMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { pickSessionForCall, SessionRegistry, TOOL_ERROR_PREFIX, toolErrorOf } from '@nexus/core';
import { Context } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import { checkConformance } from '@nexus/sdk';
import { createSessionLookupProvider } from '@nexus/session/provider';
import type { SessionLookup, TodoItem } from '@nexus/session';
import { createToolsProvider } from '@nexus/tools/provider';
import { afterEach, describe, expect, it } from 'vitest';

import * as todo from './index.js';
import {
  Config,
  TODO_EMPTY_CONTENT_MESSAGE,
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

const opened: Context[] = [];
afterEach(async () => {
  for (const root of opened.splice(0)) await root.fiber.dispose();
});

/** 這一次掛載的會話查找：照 `@nexus/core` 的共用挑法，在 `sessions` 這幾張上挑（沒有就是沒接上）。 */
function pickOver(...sessions: SessionRegistry[]): (config: unknown) => SessionLookup {
  return (config) => pickSessionForCall(sessions, config);
}

/** 掛一棵小樹：工具登記處、會話查找（`lookup` 是宿主的挑法）與 `todo` 那一列；回註冊出來的工具與根。 */
async function mount(
  allowParallelInProgress: boolean,
  lookup: (config: unknown) => SessionLookup,
): Promise<{
  tool: StructuredToolInterface;
  root: Context;
  tools: ReturnType<typeof createToolsProvider>;
}> {
  const tools = createToolsProvider();
  const root = new Context();
  opened.push(root);
  await root.plugin(Loader);
  Object.assign(root.loader.builtins, {
    tools: tools.Provider,
    'session-lookup': createSessionLookupProvider(lookup).Provider,
    todo,
  });
  const create = (options: { id: string; name: string; config?: unknown }) =>
    root.loader.create(options as never, null);
  await create({ id: 'tools', name: 'cordis:tools' });
  await create({ id: 'session-lookup', name: 'cordis:session-lookup' });
  await create({ id: 'todo', name: 'cordis:todo', config: { allowParallelInProgress } });
  await root.loader.await();
  const entry = tools.entries().find((item) => item.tool.name === TODO_TOOL_NAME);
  if (entry === undefined) throw new Error('工具沒註冊上');
  return { tool: entry.tool, root, tools };
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
  tool: StructuredToolInterface,
  todos: readonly { content: string; status: string }[],
  config: unknown,
): Promise<unknown> {
  return tool.invoke({ todos }, config as never);
}

/**
 * 一次拒絕：模型看到的字、它落定的狀態與碼。圍堵讀的是後兩格，所以文字對了不夠。
 *
 * @param result - `call` 回來的東西；不是一則工具訊息就當場失敗。
 */
function refusalOf(result: unknown): { text: string; status: unknown; error: unknown } {
  if (!ToolMessage.isInstance(result)) throw new Error(`回的不是一則工具訊息：${String(result)}`);
  return { text: String(result.content), status: result.status, error: toolErrorOf(result) };
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

  it('掛上去的那顆工具用的就是那份描述', async () => {
    expect((await mount(false, pickOver())).tool.description).toBe(todoToolDescription(false));
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
    const sessions = new SessionRegistry('unit');
    const { tool } = await mount(true, pickOver(sessions));
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
    const sessions = new SessionRegistry('unit');
    const { tool } = await mount(true, pickOver(sessions));
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
    const sessions = new SessionRegistry('unit');
    const { tool } = await mount(true, pickOver(sessions));
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
    const { tool } = await mount(true, pickOver());
    const answer = await call(tool, [{ content: '甲', status: 'pending' }], ROOT_CONFIG);

    expect(refusalOf(answer)).toEqual({
      text: `Error: ${TODO_NOT_ATTACHED_MESSAGE}`,
      status: 'error',
      error: undefined,
    });
  });

  it('認不出呼叫者也說得出原因——**不猜成 root**', async () => {
    const sessions = new SessionRegistry('unit');
    const { tool } = await mount(true, pickOver(sessions));
    const answer = await call(tool, [{ content: '甲', status: 'pending' }], undefined);

    expect(refusalOf(answer)).toEqual({
      text: `Error: ${TODO_UNKNOWN_CALLER_MESSAGE}`,
      status: 'error',
      error: undefined,
    });
    expect(sessions.root.events).toEqual([]);
  });

  it('活著兩條 thread 而呼叫沒帶 thread_id 時挑不出來，說得出有幾份', async () => {
    const a = new SessionRegistry('a');
    const b = new SessionRegistry('b');
    const { tool } = await mount(true, pickOver(a, b));
    const answer = await call(tool, [{ content: '甲', status: 'pending' }], ROOT_CONFIG);
    expect(refusalOf(answer)).toEqual({
      text: `Error: ${todoAmbiguousMessage(2)}`,
      status: 'error',
      error: undefined,
    });
    expect(a.root.events).toEqual([]);
    expect(b.root.events).toEqual([]);
  });

  it('活著兩條 thread 時依 thread_id 認出主人：各寫各的，互不串線', async () => {
    const a = new SessionRegistry('thread-a');
    const b = new SessionRegistry('thread-b');
    const { tool } = await mount(true, pickOver(a, b));
    const as = (thread: string) => ({
      configurable: { thread_id: thread, checkpoint_ns: 'tools:root-call' },
    });
    await call(tool, [{ content: '甲的', status: 'pending' }], as('thread-a'));
    await call(tool, [{ content: '乙的', status: 'pending' }], as('thread-b'));

    expect(a.root.events.map((event) => event.data)).toEqual([
      { todos: [{ content: '甲的', status: 'pending' }] },
    ]);
    expect(b.root.events.map((event) => event.data)).toEqual([
      { todos: [{ content: '乙的', status: 'pending' }] },
    ]);
  });

  /**
   * **驗證發生在找日誌之前。** 反過來的話，一份壞掉的清單在「沒接線」的組裝上會回
   * 「沒接線」——把模型送錯東西誤報成接線問題，而那兩件事要修的地方完全不同。
   *
   * **而且它回錯誤訊息不是拋**（見 `TOOL_ERROR_PREFIX`），端到端的驗收在
   * `apps/harness/src/todo-tool.test.ts`。
   */
  it('清單壞掉時回的是驗證錯誤，不是接線錯誤——而且沒接線也一樣', async () => {
    const { tool } = await mount(true, pickOver());
    expect(
      refusalOf(await call(tool, [{ content: '  ', status: 'pending' }], ROOT_CONFIG)),
    ).toEqual({
      text: TOOL_ERROR_PREFIX + TODO_EMPTY_CONTENT_MESSAGE,
      status: 'error',
      error: undefined,
    });
  });
});

describe('註冊', () => {
  it('只掛一顆工具', async () => {
    const { tools } = await mount(true, pickOver());
    expect(tools.entries().map((entry) => entry.tool.name)).toEqual([TODO_TOOL_NAME]);
  });

  /**
   * **`rootOnly` 的反面絆索。** 宣告成 `rootOnly` 的話 fold 會把每個 subagent 那一份裡的
   * 同名項換成拒絕樁，而那與 dsh 的單一所有者規則相反——todo 是模型自己的草稿，每一次
   * spawn 各一份。這條與 `@nexus/plugin-goal` 走的是**兩條相反的政策**，兩邊各有一條
   * 絆索釘著。
   */
  it('刻意不是 rootOnly——subagent 也要有自己的清單', async () => {
    const { tools } = await mount(true, pickOver());
    const entry = tools.entries().find((item) => item.tool.name === TODO_TOOL_NAME);
    expect(entry?.options?.rootOnly).toBeUndefined();
  });
});

describe('設定（#453）', () => {
  it('**必填、沒有預設**：一格都不給就讓載入失敗（照 dsh）', () => {
    // 工具觀測不到執行期的並行，所以這是部署方要拍的板，猜一個預設值等於替它拍板。
    const result = Config.safeParse({});
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('allowParallelInProgress');
  });

  it('只收字面布林——字串 false 這種寫法會讓載入失敗，不是靜靜當成真', () => {
    expect(Config.safeParse({ allowParallelInProgress: 'false' }).success).toBe(false);
  });

  it('未知欄位讓載入失敗（登記的偏離：dsh 放行）', () => {
    expect(Config.safeParse({ allowParallelInProgress: true, allowParallel: true }).success).toBe(
      false,
    );
  });
});

describe('樹上這一列（#1463）', () => {
  it('一致性套件全格通過：manifest、匯出形式、卸載後登記處回到空的、缺提供者停在 PENDING', async () => {
    let latest = createToolsProvider();
    const failures = await checkConformance({
      row: 'todo',
      module: todo,
      config: { allowParallelInProgress: true },
      providers: {
        tools: () => {
          latest = createToolsProvider();
          return latest.Provider;
        },
        sessionLookup: () => createSessionLookupProvider(() => ({ kind: 'not-attached' })).Provider,
      },
      residue: () => latest.entries().length,
    });
    expect(failures).toEqual([]);
  });

  it('manifest 宣告兩個必要依賴：tools（^1.0.0）與 sessionLookup（^1.0.0）；沒有 default 匯出', () => {
    expect(todo.manifest.consumes).toEqual([
      { token: 'tools', range: '^1.0.0' },
      { token: 'sessionLookup', range: '^1.0.0' },
    ]);
    expect(todo.manifest.provides).toEqual([]);
    expect(todo.inject).toEqual({ tools: { range: '^1.0.0' }, sessionLookup: { range: '^1.0.0' } });
    expect('default' in todo).toBe(false);
  });

  it('列卸載之後，抓進閉包的查找仍可問：已登記的那一份工具照樣寫得進日誌（驗收 D 的單元面）', async () => {
    const sessions = new SessionRegistry('unit');
    const { root, tool } = await mount(true, pickOver(sessions));
    // 把會話查找那一列拿掉：root 上的服務撤了，但工具在 `apply` 當下抓住的那一份還在。
    await root.loader.resolve('session-lookup').fiber?.ctx.fiber.dispose();
    expect(root.get('sessionLookup', false)).toBeUndefined();
    const answer = await call(tool, [{ content: '還寫得進去', status: 'pending' }], ROOT_CONFIG);
    expect(answer).toBe('Updated todo list: 1 pending, 0 in progress, 0 completed.');
    expect(sessions.root.events).toHaveLength(1);
  });
});

/** 型別層：`todo/write` 的酬載是核心的 `TodoItem`（#1463 Q2 (a)），不再靠插件的宣告合併。 */
const _payloadIsCoreTodoItem: readonly TodoItem[] = [];
void _payloadIsCoreTodoItem;
