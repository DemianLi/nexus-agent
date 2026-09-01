/**
 * **`todo_write` 在真的圖上跑一次**——[#132](https://github.com/DemianLi/nexus-agent/issues/132)
 * 的端到端驗收。
 *
 * `@nexus/plugin-todo` 自己的測試走 registry 那一層，證得了工具說了什麼、寫進哪一格；
 * 證不了的是**LangGraph 真的把身分帶到它面前**。這一檔補那一半，而它問三件事：
 *
 * 1. root 與 subagent 各寫各的清單——dsh 的單一所有者規則，落在真的委派上。
 * 2. **十三個真的配套入口一句話都不說**，包括 subagent 那份沒有輪的日誌。那是這張卡
 *    最容易踩到的靜默失敗的反面：`@nexus/plugin-todo` 的歸屬規則要是照抄 dsh 的無條件
 *    版本，每一次委派都會往使用者的終端機噴一行違規。
 * 3. 落在輪之外的那一顆**照樣報**——上一條不是「把檢查關掉」。
 *
 * **零憑證、零外部連線**：後端是 `StateBackend`，模型是 `ScriptedChatModel`。
 */

import { MemorySaver } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import { SessionRegistry } from '@nexus/core';
import type { InvariantError, SessionEvent, TodoItem } from '@nexus/core';
import { TODO_ERROR_PREFIX, TODO_TOOL_NAME, todoDuplicateMessage } from '@nexus/plugin-todo';
import { createNexusAgent } from './agent-factory.js';
import { DEFAULT_PLUGINS } from './cli.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

const THREAD_ID = 'todo';

/** 一顆給模型腳本用的 `todo_write` 呼叫。 */
function writeCall(content: string, status: TodoItem['status'] = 'in_progress') {
  return { name: TODO_TOOL_NAME, args: { todos: [{ content, status }] } };
}

interface Run {
  readonly sessions: SessionRegistry;
  readonly violations: readonly string[];
}

/**
 * 跑一輪，回**真的十三個配套入口**報了什麼，以及最後的會話註冊表。
 *
 * root 那一輪由這裡包起來，照兩條進入點實際發的順序（`turn/start` → invoke →
 * `turn/end`）——subagent 那份日誌刻意**沒有人替它包**，那正是要驗的東西。
 */
async function run(
  model: ScriptedChatModel,
  extraSubagent = true,
  afterTurn?: (sessions: SessionRegistry) => void,
): Promise<Run> {
  const violations: string[] = [];
  const { agent, attachInvariants, attachSession, dispose } = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    plugins: [
      ...DEFAULT_PLUGINS,
      {
        name: 'worker-source',
        apply(registry) {
          if (extraSubagent)
            registry.subagents.register({ name: 'worker', description: '幹活的。' });
        },
      },
    ],
    onInvariantViolation: (error: InvariantError) => void violations.push(error.message),
  });
  const sessions = new SessionRegistry(THREAD_ID);
  const detachInvariants = attachInvariants(sessions);
  const detachSession = attachSession(sessions);
  try {
    sessions.root.append('turn/start', { kind: 'message', text: '跑。' });
    await agent.invoke(toAgentInvocation('跑。'), { configurable: { thread_id: THREAD_ID } });
    sessions.root.append('turn/end', {});
    // **在拆線之前**：拆掉之後日誌上一個觀察者都沒有，往裡面寫什麼都不會有人吭聲。
    afterTurn?.(sessions);
  } finally {
    detachSession();
    detachInvariants?.();
    await dispose();
  }
  return { sessions, violations };
}

/** 一份日誌裡的 todo 清單們，照寫入順序。 */
function todosIn(events: readonly SessionEvent[]): readonly (readonly TodoItem[])[] {
  return events
    .filter((event) => event.type === 'todo/write')
    .map((event) => (event as SessionEvent<'todo/write'>).data.todos);
}

describe('todo_write 在真的圖上', () => {
  it('root 與 subagent 各自一份清單——照 dsh 的單一所有者規則', async () => {
    const model = new ScriptedChatModel({
      turns: [
        { content: '先規劃。', toolCalls: [writeCall('根的計畫')] },
        {
          content: '委派。',
          toolCalls: [{ name: 'task', args: { description: '幹活', subagent_type: 'worker' } }],
        },
        { content: '子代理也規劃。', toolCalls: [writeCall('子代理的計畫')] },
        { content: '子代理收工。' },
        { content: '根收工。' },
        { content: '根再收一次。' },
      ],
    });
    const { sessions } = await run(model);

    const entries = sessions.list();
    expect(entries.map((entry) => entry.address.kind)).toEqual(['root', 'subagent']);
    expect(todosIn(entries[0]!.log.events)).toEqual([
      [{ content: '根的計畫', status: 'in_progress' }],
    ]);
    expect(todosIn(entries[1]!.log.events)).toEqual([
      [{ content: '子代理的計畫', status: 'in_progress' }],
    ]);
  });

  /**
   * **這一條是這張卡最重要的絆索。**
   *
   * subagent 的日誌上永遠沒有 `turn/start`（[#137](https://github.com/DemianLi/nexus-agent/issues/137)
   * 釘下來的約定：發 turn 事件的是進入點，subagent 不經過進入點）。dsh 的 todo 不變量
   * 寫的是「不在開著的輪裡就報」，**無條件**——照抄過來的話，這裡會出現一行
   * `todo/write（seq 0）落在任何開著的輪之外`，而它的去處是使用者的終端機。
   *
   * 規則因此改寫成看**這份日誌自己有沒有輪**，理由與另一條路的比較見
   * `packages/nexus-plugin-todo/src/invariant.ts` 檔頭。
   */
  it('subagent 那份沒有輪的日誌，十三個配套入口一句話都不說', async () => {
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '委派。',
          toolCalls: [{ name: 'task', args: { description: '幹活', subagent_type: 'worker' } }],
        },
        { content: '子代理規劃。', toolCalls: [writeCall('子代理的計畫')] },
        { content: '子代理收工。' },
        { content: '根收工。' },
        { content: '再收一次。' },
      ],
    });
    const { sessions, violations } = await run(model);

    // 子代理那份真的開出來、真的寫進去了，這一條才問得出東西。
    const subagent = sessions.list().find((entry) => entry.address.kind === 'subagent');
    expect(todosIn(subagent!.log.events)).toHaveLength(1);
    expect(violations).toEqual([]);
  });

  /**
   * **上一條不是把檢查關掉。** 同一顆事件落在一份**有輪**的日誌的輪之外，照樣報——
   * 而這也是「哪天 subagent 長出輪，這條檢查會自己跟上」的證據。
   */
  it('root 收工之後再寫一顆，照樣報得出來', async () => {
    const model = new ScriptedChatModel({ turns: [{ content: '什麼都不做。' }] });
    const { violations } = await run(model, false, (sessions) => {
      // 這一輪已經 `turn/end` 收工了，所以下面這一顆落在輪之外。
      sessions.root.append('todo/write', { todos: [{ content: '遲到的', status: 'pending' }] });
    });

    expect(violations).toEqual([
      'invariant violated by "@nexus/plugin-todo": todo/write（seq 2）落在任何開著的輪之外',
    ]);
  });

  /**
   * **模型送壞清單時，那句話要回得到模型手上。**
   *
   * dsh 的 README 把那幾句列成**穩定的失敗文本**——它們是給模型看的、看完再送一次的。
   * 我們的 `toTodoList` 是**拋**的，所以這一條真正在問的是：LangGraph 的 ToolNode 把拋
   * 出來的錯收成一則 `ToolMessage` 交回去，還是讓它往上炸掉整輪？
   *
   * 兩者的差別是「模型打錯字之後改一次」與「模型打錯字之後這一輪死掉」。
   */
  it('清單壞掉時，錯誤回到模型手上，而且這一輪跑得完', async () => {
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '規劃。',
          toolCalls: [
            {
              name: TODO_TOOL_NAME,
              args: {
                todos: [
                  { content: '同一句', status: 'pending' },
                  { content: '同一句', status: 'completed' },
                ],
              },
            },
          ],
        },
        { content: '收工。' },
      ],
    });
    const { agent, attachSession, dispose } = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      plugins: [...DEFAULT_PLUGINS],
    });
    const sessions = new SessionRegistry('bad-input');
    const detach = attachSession(sessions);

    try {
      const result = await agent.invoke(toAgentInvocation('跑。'), {
        configurable: { thread_id: 'bad-input' },
      });
      const messages = result.messages as { getType(): string; text: string }[];
      const toolMessage = messages.filter((message) => message.getType() === 'tool').at(-1);

      expect(toolMessage?.text).toBe(TODO_ERROR_PREFIX + todoDuplicateMessage('同一句'));
    } finally {
      detach();
      await dispose();
    }

    // **壞掉的那一次一顆事件都沒留下**：驗證在找日誌之前。
    expect(sessions.root.events).toEqual([]);
  });

  it('工具進得了預設清單面向模型的那一面', async () => {
    const model = new ScriptedChatModel({ turns: [{ content: '什麼都不做。' }] });
    const { agent, dispose } = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      plugins: [...DEFAULT_PLUGINS],
    });
    try {
      await agent.invoke(toAgentInvocation('跑。'), { configurable: { thread_id: 'listing' } });
      expect(model.boundToolNames).toContain(TODO_TOOL_NAME);
    } finally {
      await dispose();
    }
  });
});
