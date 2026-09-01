import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { ConversationState, Event, WireClient } from '@nexus/wire';
import {
  appendDecision,
  appendHumanTurn,
  createWireClient,
  emptyConversation,
  reduceConversation,
  uniformDecisions,
} from '@nexus/wire';
import { createDeepAgent, StateBackend } from 'deepagents';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { emptyCommandPoint } from './fixtures.js';
import { createWireHandler } from './wire-handler.js';

/**
 * 核准這條路，對著**真的** agent 走**真的**線再折進來。
 *
 * 沿用 `conversation-wire.test.ts` 的規矩，但這裡驗的是暫停之後：按下去的那一刻
 * 送出了什麼、線上回來了什麼、畫面上留下了什麼。
 *
 * **這一組最容易假綠的地方是「什麼都沒發生」**：拒絕之後工具沒跑、下行零顆 `tools`
 * frame ——「模型根本沒呼叫那個工具」「中斷壓根沒觸發」也長這樣。所以每一條「沒跑」
 * 都配著同一份腳本的「跑得起來」（核准那條），兩條一起看才有意義。
 *
 * 三條是**基座行為的絆索**，紅了代表基座改了主意而不是我們寫壞了：
 *
 * 1. 逐筆 `allowedDecisions` 真的分得開（所以折疊器取交集不是多此一舉）。
 * 2. 混合批次在下行上與全拒絕**一模一樣**：被核准的那筆連一顆 frame 都沒有。
 * 3. 停在核准點時再送一句話，基座會把中斷靜靜丟掉（所以上行那側要擋）。
 */

const BASE_URL = 'http://hitl.test';

/** 跑到就記名字的間諜工具——「跑沒跑」的答案在這裡，不在回傳訊息的措辭上。 */
function spy(calls: string[], name: string) {
  return tool(
    () => {
      calls.push(name);
      return `${name} 跑過了`;
    },
    { name, description: `間諜 ${name}`, schema: z.object({}) },
  );
}

interface Built {
  readonly agent: PumpAgent;
  readonly calls: string[];
}

function build(
  turns: readonly ScriptedTurn[],
  interruptOn: Record<string, { allowedDecisions: readonly string[] }>,
): Built {
  const calls: string[] = [];
  const agent = createDeepAgent({
    model: new ScriptedChatModel({ turns }),
    tools: [spy(calls, 'alpha'), spy(calls, 'beta')],
    backend: new StateBackend(),
    checkpointer: new MemorySaver(),
    interruptOn: interruptOn as never,
  });
  return { agent: agent as unknown as PumpAgent, calls };
}

function connect(agent: PumpAgent) {
  const handler = createWireHandler({
    createAgent: async () => ({
      agent,
      commands: emptyCommandPoint(),
      dispose: async () => undefined,
    }),
  });
  return {
    handler,
    client: createWireClient({
      baseUrl: BASE_URL,
      fetch: async (input, init) => handler.handle(new Request(input as string, init)),
    }),
  };
}

/** 開著的一條對話：一條長期下行，加上折到目前為止的狀態。 */
interface Session {
  readonly client: WireClient;
  readonly events: AsyncGenerator<Event, void, undefined>;
  readonly frames: Event[];
  state: ConversationState;
  close(): Promise<void>;
}

async function open(agent: PumpAgent, threadId: string, text: string): Promise<Session> {
  const { client, handler } = connect(agent);
  const events = await client.openEvents(threadId);
  await client.runStart(threadId, text);
  return {
    client,
    events,
    frames: [],
    state: appendHumanTurn(emptyConversation(), text),
    close: () => handler.close(),
  };
}

/**
 * 抽到條件成立為止。
 *
 * **刻意用 `next()` 而不是 `for await` ＋ `break`**：`break` 會呼叫
 * `iterator.return()` 把整條下行關掉，而這條線要跨好幾輪重複抽。
 */
async function until(
  session: Session,
  done: (state: ConversationState) => boolean,
): Promise<ConversationState> {
  while (!done(session.state)) {
    const next = await session.events.next();
    if (next.done === true) {
      break;
    }
    session.frames.push(next.value);
    session.state = reduceConversation(session.state, next.value);
  }
  return session.state;
}

/** 按下一個決定：跟畫面上那顆按鈕做的事完全一樣。 */
async function decide(session: Session, threadId: string, decision: string) {
  const pending = session.state.pending;
  if (pending === undefined) {
    throw new Error('沒有掛著的核准請求');
  }
  session.state = appendDecision(session.state, decision);
  return session.client.inputRespond(threadId, {
    namespace: [...pending.namespace],
    interrupt_id: pending.interruptId,
    response: uniformDecisions(pending, decision),
  });
}

/**
 * 這一輪真的收完了。
 *
 * **不能只看 `status === 'idle'`**：中斷那一輪自己也會發一顆 `lifecycle completed / root`，
 * 而那顆在按下決定之後才被抽到的話會把狀態翻成 idle——resume 那一輪還沒開始跑。
 * 拿它當停止條件的話，「工具沒跑」與「還沒輪到工具跑」在測試裡分不出來，整組會靜靜
 * 地假綠。所以數模型講完幾輪話：核准或拒絕之後模型一定會再講一輪。
 */
function settled(turns: number) {
  return (state: ConversationState): boolean =>
    state.status === 'idle' &&
    state.entries.filter((entry) => entry.kind === 'ai' && !entry.streaming).length >= turns;
}

function toolFrames(session: Session): Event[] {
  return session.frames.filter((frame) => frame.method === 'tools');
}

function decisions(state: ConversationState): string[] {
  return state.entries
    .filter((entry) => entry.kind === 'decision')
    .map((entry) =>
      entry.kind === 'decision' ? `${entry.decision}:${entry.actions.join('+')}` : '',
    );
}

const ONE: readonly ScriptedTurn[] = [
  { content: '動手。', toolCalls: [{ name: 'alpha', args: {} }] },
  { content: '收工。' },
  { content: '再收一次工。' },
];

const TWO: readonly ScriptedTurn[] = [
  {
    content: '兩個都動。',
    toolCalls: [
      { name: 'alpha', args: {} },
      { name: 'beta', args: {} },
    ],
  },
  { content: '收工。' },
  { content: '再收一次工。' },
];

const BOTH_FULL = {
  alpha: { allowedDecisions: ['approve', 'reject'] as const },
  beta: { allowedDecisions: ['approve', 'reject'] as const },
};

describe('核准之後，經過線', () => {
  it('核准 → 工具真的跑了，而且畫面上留下「已核准」', async () => {
    const { agent, calls } = build(ONE, { alpha: BOTH_FULL.alpha });
    const session = await open(agent, 'h1', '動手');

    await until(session, (state) => state.status === 'awaiting-input');
    expect(session.state.pending?.actions.map((action) => action.name)).toEqual(['alpha']);
    expect(calls).toEqual([]);

    await decide(session, 'h1', 'approve');
    await until(session, settled(2));

    expect(calls).toEqual(['alpha']);
    expect(decisions(session.state)).toEqual(['approve:alpha']);
    // 核准之後工具的生命週期才上線——這是下一條「拒絕零顆」的對照組。
    expect(
      session.state.entries
        .filter((entry) => entry.kind === 'tool')
        .map((entry) => (entry.kind === 'tool' ? [entry.name, entry.status] : [])),
    ).toEqual([['alpha', 'done']]);
    await session.close();
  });

  it('拒絕 → 工具沒跑，而且線上一顆 frame 都沒有：本地那則是唯一的紀錄', async () => {
    const { agent, calls } = build(ONE, { alpha: BOTH_FULL.alpha });
    const session = await open(agent, 'h2', '動手');

    await until(session, (state) => state.status === 'awaiting-input');
    await decide(session, 'h2', 'reject');
    await until(session, settled(2));

    expect(calls).toEqual([]);
    // 中斷發生在 `afterModel`，tools node 從沒跑；那則人造的 error ToolMessage 走
    // `updates`（白名單外）。所以下行對「被拒絕」這件事一個字都沒說。
    expect(toolFrames(session)).toEqual([]);
    expect(session.state.entries.filter((entry) => entry.kind === 'tool')).toEqual([]);
    expect(decisions(session.state)).toEqual(['reject:alpha']);
    await session.close();
  });

  it('絆索：逐筆 allowedDecisions 真的分得開，折疊器取交集', async () => {
    const { agent } = build(TWO, {
      alpha: { allowedDecisions: ['approve', 'reject'] },
      beta: { allowedDecisions: ['approve'] },
    });
    const session = await open(agent, 'h3', '動手');
    await until(session, (state) => state.status === 'awaiting-input');

    expect(session.state.pending?.actions.map((action) => action.name)).toEqual(['alpha', 'beta']);
    // 讀 `[0]` 的話這裡是 `['approve','reject']`，畫面上就會多一顆按下去讓整場 run 死
    // 的「全部拒絕」——基座對不在那一筆清單裡的決定是當場拋。
    expect(session.state.pending?.allowedDecisions).toEqual(['approve']);
    await session.close();
  });

  it('絆索：混合批次在下行上與全拒絕一模一樣，被核准的那筆連一顆 frame 都沒有', async () => {
    const mixed = build(TWO, BOTH_FULL);
    const mixedSession = await open(mixed.agent, 'h4', '動手');
    await until(mixedSession, (state) => state.status === 'awaiting-input');
    const pending = mixedSession.state.pending;
    if (pending === undefined) throw new Error('沒有掛著的核准請求');
    // **繞過介面直接送**：畫面上做不出這個組合（全有全無），這裡驗的是「為什麼不能做」。
    await mixedSession.client.inputRespond('h4', {
      namespace: [...pending.namespace],
      interrupt_id: pending.interruptId,
      response: { decisions: [{ type: 'approve' }, { type: 'reject' }] },
    });
    mixedSession.state = appendDecision(mixedSession.state, 'mixed');
    await until(mixedSession, settled(2));

    const rejected = build(TWO, BOTH_FULL);
    const rejectedSession = await open(rejected.agent, 'h5', '動手');
    await until(rejectedSession, (state) => state.status === 'awaiting-input');
    await decide(rejectedSession, 'h5', 'reject');
    await until(rejectedSession, settled(2));

    // 被核准的 alpha 沒跑，而且下行上沒有任何東西說得出這件事——兩種情況的
    // `tools` frame 都是零顆。逐筆按的介面因此會生出一個畫面上分不出來的狀態。
    expect(mixed.calls).toEqual([]);
    expect(rejected.calls).toEqual([]);
    expect(toolFrames(mixedSession)).toEqual([]);
    expect(toolFrames(rejectedSession)).toEqual([]);
    await mixedSession.close();
    await rejectedSession.close();
  });
});

describe('上行擋下三種會靜靜壞掉的送法', () => {
  it('停在核准點時送新話：明著回錯，中斷還掛著', async () => {
    const { agent, calls } = build(ONE, { alpha: BOTH_FULL.alpha });
    const session = await open(agent, 'h6', '動手');
    await until(session, (state) => state.status === 'awaiting-input');

    // 基座這時不會擋：它會照跑一輪、把中斷丟掉，那個工具既沒執行也沒被拒絕，
    // 而且不會再問第二次。所以擋在上行。
    const response = await session.client.runStart('h6', '不管它，我再說一句');
    expect(response.type).toBe('error');

    // 擋下來之後那顆中斷還在，核准照樣跑得動——不是把 thread 弄死換來的安全。
    await decide(session, 'h6', 'approve');
    await until(session, settled(2));
    expect(calls).toEqual(['alpha']);
    await session.close();
  });

  it('過期的 interrupt_id：不會拿去回答現在掛著的那顆', async () => {
    const { agent, calls } = build(ONE, { alpha: BOTH_FULL.alpha });
    const session = await open(agent, 'h7', '動手');
    await until(session, (state) => state.status === 'awaiting-input');
    const pending = session.state.pending;
    if (pending === undefined) throw new Error('沒有掛著的核准請求');

    const response = await session.client.inputRespond('h7', {
      namespace: [...pending.namespace],
      interrupt_id: '上一顆中斷的 id',
      response: { decisions: [{ type: 'approve' }] },
    });
    expect(response.type).toBe('error');
    if (response.type === 'error') {
      expect(response.error).toBe('no_such_interrupt');
    }
    // **這道圍欄擋的是一件實測會發生的事**：拿掉 id 比對之後，一個完全不存在的
    // interrupt_id 照樣把現在掛著的那顆核准掉、工具真的跑了。基座只認「有沒有中斷
    // 掛著」——所以過期的那一端按下核准，落點是另一顆中斷。
    expect(calls).toEqual([]);
    await session.close();
  });

  it('決定筆數不符：擋在上行，不是讓整條 thread 死在 lifecycle failed', async () => {
    const { agent, calls } = build(TWO, BOTH_FULL);
    const session = await open(agent, 'h8', '動手');
    await until(session, (state) => state.status === 'awaiting-input');
    const pending = session.state.pending;
    if (pending === undefined) throw new Error('沒有掛著的核准請求');

    // 基座逐 index 配對，長度不符當場拋——線上是一顆 `lifecycle failed / root`。
    const response = await session.client.inputRespond('h8', {
      namespace: [...pending.namespace],
      interrupt_id: pending.interruptId,
      response: { decisions: [{ type: 'approve' }] },
    });
    expect(response.type).toBe('error');

    await decide(session, 'h8', 'approve');
    const state = await until(session, settled(2));
    // thread 沒死：補送正確的筆數之後照樣跑完。
    expect(state.status).toBe('idle');
    expect(calls).toEqual(['alpha', 'beta']);
    await session.close();
  });
});
