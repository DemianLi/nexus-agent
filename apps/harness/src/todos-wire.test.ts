/**
 * **模型的待辦清單即時看得到，重新整理之後也還在**——[#575](https://github.com/DemianLi/nexus-agent/issues/575) 的
 * harness 那一半。
 *
 * 真的圖、真的 pump、真的 `todo_write`（`@nexus/plugin-todo`），模型是腳本。每一個檢查點都比兩條路：即時的 frame
 * 與歷史路由各折一次，`todos` 要相等。規則照 dsh 的 `todos` 投影：
 *
 * 1. 寫一次換一次，一輪結束時保留。
 * 2. **停在核准點、人批准之後不清**：那是同一輪接著跑（`turn/start {kind:'resume'}`），不是新的一輪。
 * 3. 新的一輪一開始就清成 `null`；**子代理寫的不進來**，它寫在自己那一份。
 * 4. goal 續行的輪也清（`turn/start {kind:'goal'}`），用日誌折疊驗，同一條判準 pump 也在用。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`，測試不碰真的 `~/.nexus-agent`。
 */

import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry, SessionEvent } from '@nexus/core';
import { createTodoPlugin, TODO_TOOL_NAME } from '@nexus/plugin-todo';
import type { Event, WireTodoItem } from '@nexus/wire';
import { emptyConversation, reduceAll, TODOS } from '@nexus/wire';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { historyFrames, historyPage } from './conversation-history.js';
import { ScriptedChatModel } from './scripted-model.js';
import { DEFAULT_TOOL_TEXT_MAX_BYTES } from './settings/tool-text.js';
import type { PumpAgent } from './thread-pump.js';
import { ThreadPump } from './thread-pump.js';

/** 一顆要人核准的工具，用來把一輪停在核准點。 */
const GATED: PluginEntry = {
  plugin: {
    name: 'todos-wire-fixture',
    apply(registry) {
      registry.tools.register(
        tool(({ text }: { text: string }) => `已記下：${text}`, {
          name: 'take_note',
          description: '把一段文字記下來。',
          schema: z.object({ text: z.string() }),
        }),
      );
      registry.approvals.gate((execution, next) =>
        execution.name === 'take_note' ? { kind: 'ask', reason: '看一下' } : next(),
      );
      registry.subagents.register({ name: 'worker', description: '幹活的。' });
    },
  },
};

const FIRST: WireTodoItem[] = [
  { content: '讀設定', status: 'pending' },
  { content: '改程式', status: 'pending' },
];
const SECOND: WireTodoItem[] = [
  { content: '讀設定', status: 'completed' },
  { content: '改程式', status: 'in_progress' },
];
const SUBAGENT: WireTodoItem[] = [{ content: '子代理自己的事', status: 'in_progress' }];

const write = (todos: WireTodoItem[]) => ({ name: TODO_TOOL_NAME, args: { todos } });

const todosOf = (frames: readonly Event[]) => reduceAll(emptyConversation(), frames).todos;

/** 重新整理拿到的：整份一頁，與只收最後一輪的那一頁。兩種都要跟即時一樣。 */
function refreshed(events: readonly SessionEvent[]) {
  return [historyPage(events), historyPage(events, { maxMessages: 1 })].map((page) =>
    todosOf(page.events),
  );
}

describe('待辦清單在即時與重新整理之後都一樣', () => {
  it('寫兩次換兩次；批准之後不清；新的一輪清空；子代理的不進來', async () => {
    const model = new ScriptedChatModel({
      turns: [
        // 第一輪：寫兩次，再叫一顆要核准的工具，停在核准點。
        { content: '', toolCalls: [write(FIRST)] },
        { content: '', toolCalls: [write(SECOND)] },
        { content: '', toolCalls: [{ name: 'take_note', args: { text: '記一筆' } }] },
        // 批准之後同一輪接著跑完。
        { content: '好了。' },
        // 第二輪：委派，子代理寫自己的清單。
        {
          content: '',
          toolCalls: [{ name: 'task', args: { description: '做事', subagent_type: 'worker' } }],
        },
        { content: '', toolCalls: [write(SUBAGENT)] },
        { content: '子代理收工。' },
        { content: '根收工。' },
      ],
    });
    const built = await createNexusAgent({
      model: model as never,
      checkpointer: new MemorySaver(),
      plugins: [createTodoPlugin({ allowParallelInProgress: false }), GATED],
    });
    const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'todos');
    const detach = built.attachSession(pump.sessions);
    const frames: Event[] = [];
    const line = new AbortController();
    const stream = pump.subscribe(['messages', 'tools', 'lifecycle', 'custom'], line.signal);
    const draining = (async () => {
      for await (const frame of stream) frames.push(frame);
    })();
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    try {
      await pump.submit({ kind: 'message', text: '做兩件事' });
      await settle();
      // 前提：真的停在核准點，兩次寫入都落了盤。
      expect(pump.pendings).toHaveLength(1);
      expect(pump.sessionLog.events.filter((event) => event.type === 'todo/write')).toHaveLength(2);
      expect(todosOf(frames)).toEqual(SECOND);

      await pump.submit({
        kind: 'resume',
        interruptId: pump.pendings[0]?.interruptId ?? '',
        response: { decisions: [{ type: 'approve' }] },
      });
      await settle();
      // 前提：批准之後寫的是 `resume`，不是新的一輪。
      expect(
        pump.sessionLog.events
          .filter((event) => event.type === 'turn/start')
          .map((event) => event.data.kind),
      ).toEqual(['message', 'resume']);
      expect(todosOf(frames)).toEqual(SECOND);
      expect(refreshed(pump.sessionLog.events)).toEqual([SECOND, SECOND]);

      await pump.submit({ kind: 'message', text: '派出去' });
      await settle();
      // 前提：子代理那一份真的有它自己的清單，root 那一份這一輪沒有寫。
      const subagentWrites = pump.sessions
        .list()
        .filter((entry) => entry.address.kind === 'subagent')
        .flatMap((entry) => entry.log.events.filter((event) => event.type === 'todo/write'));
      expect(subagentWrites.map((event) => event.data)).toEqual([{ todos: SUBAGENT }]);
      expect(pump.sessionLog.events.filter((event) => event.type === 'todo/write')).toHaveLength(2);

      expect(todosOf(frames)).toBeNull();
      expect(refreshed(pump.sessionLog.events)).toEqual([null, null]);
      // 即時送出去的 `todos` frame：兩次寫入、第二輪開頭一次清空（批准那一次沒有），子代理的一顆都沒有。
      expect(
        frames
          .filter((frame) => frame.method === 'custom')
          .map((frame) => frame.params.data as { name: string; payload: unknown })
          .filter((data) => data.name === TODOS)
          .map((data) => data.payload),
      ).toEqual([{ todos: null }, { todos: FIRST }, { todos: SECOND }, { todos: null }]);
    } finally {
      line.abort();
      await draining;
      detach();
      await built.dispose();
    }
  }, 30000);
});

describe('歷史那一側的折疊', () => {
  let seq = 0;
  const at = <T extends SessionEvent['type']>(
    type: T,
    data: Extract<SessionEvent, { type: T }>['data'],
  ): SessionEvent => ({ type, data, seq: seq++, time: seq }) as SessionEvent;
  const fold = (events: SessionEvent[]) =>
    todosOf(historyFrames(events, DEFAULT_TOOL_TEXT_MAX_BYTES));

  it('goal 續行的輪也清；resume 不清；結束與失敗保留', () => {
    const opened = [
      at('turn/start', { kind: 'message', text: '做事' }),
      at('todo/write', { todos: FIRST }),
    ];
    expect(fold([...opened, at('turn/end', {})])).toEqual(FIRST);
    expect(fold([...opened, at('turn/failed', { message: '壞了' })])).toEqual(FIRST);
    expect(fold([...opened, at('turn/end', {}), at('turn/start', { kind: 'resume' })])).toEqual(
      FIRST,
    );
    expect(
      fold([
        ...opened,
        at('turn/end', {}),
        at('turn/start', { kind: 'goal', text: '續', goalId: 'g' as never, revision: 1, round: 1 }),
      ]),
    ).toBeNull();
    expect(
      fold([...opened, at('turn/end', {}), at('turn/start', { kind: 'message', text: '再來' })]),
    ).toBeNull();
  });
});
