/**
 * `ask_user_question` **走真的線**：模型呼叫 → 中斷 → 折疊器 → 上行 → 工具拿到答案。
 *
 * 為什麼要有這一份，而不是靠 `@nexus/plugin-ask-user` 的單元測試：那一份把 `interrupt()`
 * 換成了替身，證得了「我們交給它什麼」，證不了**這顆中斷在線上活得下來**——
 * 判別式要穿過 pump、`input.requested` 的 payload、折疊器三層，而
 * [#232](https://github.com/DemianLi/nexus-agent/issues/232) 那次的教訓正是「三層之間掉東西
 * 不會有人報錯」。
 *
 * **這裡也是判別式那兩個字串唯一對得起來的地方**：`@nexus/wire` 不相依 `@nexus/core`
 * （它要在瀏覽器裡跑），所以 `question` 這個值在兩邊各寫了一份。
 */

import { MemorySaver } from '@langchain/langgraph';
import { QUESTION_INTERRUPT_KIND, APPROVAL_INTERRUPT_KIND } from '@nexus/core';
import { createAskUserPlugin, ASK_USER_QUESTION_TOOL_NAME } from '@nexus/plugin-ask-user';
import type { ConversationState, Event, WireClient } from '@nexus/wire';
import {
  APPROVAL_PENDING_KIND,
  QUESTION_PENDING_KIND,
  answerResponse,
  appendAnswers,
  appendHumanTurn,
  appendQuestionCancel,
  cancelResponse,
  createWireClient,
  emptyConversation,
  isQuestionPending,
  reduceConversation,
} from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { emptyCommandPoint } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const BASE_URL = 'http://ask.test';

const QUESTIONS = [
  { id: 'name', question: '訪客姓名？', header: '姓名' },
  { id: 'day', question: '哪一天？', options: [{ label: '週一' }, { label: '週二' }] },
];

interface Session {
  readonly client: WireClient;
  readonly events: AsyncGenerator<Event, void, undefined>;
  readonly frames: Event[];
  state: ConversationState;
  close(): Promise<void>;
}

async function open(threadId: string): Promise<Session> {
  const built = await createNexusAgent({
    model: new ScriptedChatModel({
      turns: [
        {
          content: '我先問一下。',
          toolCalls: [{ name: ASK_USER_QUESTION_TOOL_NAME, args: { questions: QUESTIONS } }],
        },
        { content: '收工。' },
        { content: '再收一次工。' },
      ],
    }),
    checkpointer: new MemorySaver(),
    plugins: [createAskUserPlugin()],
  });
  const handler = createWireHandler({
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: emptyCommandPoint(),
      dispose: built.dispose,
    }),
  });
  const client = createWireClient({
    baseUrl: BASE_URL,
    fetch: async (input, init) => handler.handle(new Request(input as string, init)),
  });
  const events = await client.openEvents(threadId);
  await client.runStart(threadId, '幫我登記一位訪客');
  return {
    client,
    events,
    frames: [],
    state: appendHumanTurn(emptyConversation(), '幫我登記一位訪客'),
    close: () => handler.close(),
  };
}

async function until(session: Session, done: (session: Session) => boolean): Promise<void> {
  while (!done(session)) {
    const next = await session.events.next();
    if (next.done === true) break;
    session.frames.push(next.value);
    session.state = reduceConversation(session.state, next.value);
  }
}

/**
 * 這一輪真的收完了。
 *
 * **不能只看 `status === 'idle'`，也不能只看「有沒有 tool entry」**：中斷本身在線上就是
 * 一則 `status: 'failed'` 的 tool entry（實測，`error` 欄位裝的是那顆 `GraphInterrupt`），
 * 而中斷那一輪的 `lifecycle completed / root` 照樣會發。兩個判準都會在**還沒 resume**
 * 的時候就成立。所以數模型講完幾輪話。
 */
function settled(session: Session): boolean {
  return (
    session.state.status === 'idle' &&
    session.state.entries.filter((entry) => entry.kind === 'ai' && !entry.streaming).length >= 2
  );
}

/**
 * 模型**實際收到的那則 ToolMessage**（`status` 與 `content`）。
 *
 * **不要拿 `ToolEntry.status` 當「這次工具成功了嗎」用**：實測它對一則
 * `status: 'error'` 的 ToolMessage 照樣是 `'done'`——那一格說的是「這次呼叫收尾了」，
 * 不是「它成功了」。核准閘門的 `denial()` 早就是同一個形狀，所以這是既有的形狀不是這一刀
 * 帶進來的；畫面上因此會把一則失敗畫成「完成」，那是另一張卡的事。
 */
function toolMessageOf(entry: { output?: unknown }): { status?: string; content?: string } {
  const output = entry.output as { kwargs?: { status?: string; content?: string } } | undefined;
  const kwargs = output?.kwargs;
  if (kwargs === undefined)
    throw new Error(`這則工具紀錄沒有 ToolMessage：${JSON.stringify(output)}`);
  return kwargs;
}

/** 這一次呼叫**最後**的樣子。線上同一個 `callId` 會出現兩次（中斷一次、收工一次）。 */
function lastToolEntry(
  session: Session,
): Extract<(typeof session.state.entries)[number], { kind: 'tool' }> {
  const tools = session.state.entries.filter((entry) => entry.kind === 'tool');
  const last = tools[tools.length - 1];
  if (last === undefined || last.kind !== 'tool') throw new Error('一則工具紀錄都沒有');
  return last;
}

describe('判別式的兩個字串', () => {
  it('**`@nexus/core` 與 `@nexus/wire` 各寫一份，這裡是唯一對得起來的地方**', () => {
    // wire 不相依 core（它跑在瀏覽器裡），所以型別擋不到抄錯一個字母。抄錯的樣子是
    // 每一顆問答中斷都變成「認不得的 kind」——整條對話 `failed`，而單元測試兩邊各自綠。
    expect(QUESTION_PENDING_KIND).toBe(QUESTION_INTERRUPT_KIND);
    expect(APPROVAL_PENDING_KIND).toBe(APPROVAL_INTERRUPT_KIND);
  });
});

describe('ask_user_question 走真的線', () => {
  it('中斷帶著 `kind` 與整批問題上線，折疊器折成一顆問答', async () => {
    const session = await open('a1');
    await until(session, (s) => s.state.status === 'awaiting-input');

    const frame = session.frames.find((candidate) => candidate.method === 'input.requested');
    const payload = (frame?.params as { data: { payload?: { kind?: string } } }).data.payload;
    // 先證線上那一顆真的帶了判別式——少了它，下面折出問答就只是折疊器的預設值在說話。
    expect(payload?.kind).toBe(QUESTION_INTERRUPT_KIND);

    const pending = session.state.pendings[0];
    if (pending === undefined || !isQuestionPending(pending)) {
      throw new Error(`掛著的不是問答：${JSON.stringify(pending)}`);
    }
    expect(pending.questions).toEqual(QUESTIONS);
    await session.close();
  });

  it('**答案原封不動走到工具手上**——空的 `selected` 是跳過，不會在路上被補成別的', async () => {
    const session = await open('a2');
    await until(session, (s) => s.state.status === 'awaiting-input');
    const pending = session.state.pendings[0];
    if (pending === undefined) throw new Error('沒有掛著的問答');

    const answers = [
      { id: 'name', selected: [], custom: '阿明' },
      { id: 'day', selected: ['週二'] },
    ];
    session.state = appendAnswers(session.state, pending.interruptId, answers);
    await session.client.inputRespond('a2', {
      namespace: [...pending.namespace],
      interrupt_id: pending.interruptId,
      response: answerResponse(answers),
    });
    await until(session, settled);

    const message = toolMessageOf(lastToolEntry(session));
    expect(message.status).toBe('success');
    expect(JSON.parse(String(message.content))).toEqual({
      answers: [
        { id: 'name', selected: [], custom: '阿明' },
        { id: 'day', selected: ['週二'] },
      ],
    });
    // 沒有殘留——答完了就不該還掛著一張卡。
    expect(session.state.pendings).toEqual([]);
    await session.close();
  });

  it('**放棄整組讓工具收到錯誤**，而不是一份「每題都跳過」的答案', async () => {
    const session = await open('a3');
    await until(session, (s) => s.state.status === 'awaiting-input');
    const pending = session.state.pendings[0];
    if (pending === undefined) throw new Error('沒有掛著的問答');

    session.state = appendQuestionCancel(session.state, pending.interruptId);
    await session.client.inputRespond('a3', {
      namespace: [...pending.namespace],
      interrupt_id: pending.interruptId,
      response: cancelResponse(),
    });
    await until(session, settled);

    const message = toolMessageOf(lastToolEntry(session));
    // **承重的是 `status`**：只看內容的話，一則普通的工具結果也可能夾著這串字，
    // 而模型分不分得出「這次失敗了」靠的正是這一格。
    expect(message.status).toBe('error');
    expect(String(message.content)).toContain('放棄');
    await session.close();
  });
});
