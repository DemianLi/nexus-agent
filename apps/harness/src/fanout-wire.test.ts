/**
 * 同一輪多顆核准中斷，**經過線**之後剩下什麼。
 *
 * `hitl-wire.test.ts` 也走真的線，但它用 `interruptOn` 建 agent——那條路中斷發生在
 * `afterModel`，**一顆中斷帶著整批 `actionRequests`**，正好是這裡要釘的東西的反面。
 * [#112](https://github.com/DemianLi/nexus-agent/issues/112) 之後的產品路徑是
 * `approvals.gate` 折成 `wrapToolCall` 上的 pre-execute waterfall，**逐次呼叫各自
 * `interrupt()`**，所以同一輪兩個 gated 工具＝兩顆中斷。這一份用產品路徑建 agent。
 *
 * `interrupt.test.ts:227,251` 已經釘住基座那一層（一個決定套到兩顆上，核准與拒絕
 * 兩個方向都是）。**缺的是折疊器那一層**——而
 * [#232](https://github.com/DemianLi/nexus-agent/issues/232) 的病灶就在那裡：
 * 兩顆中斷各發一顆 `input.requested`，`reduceInputRequested` 整個換掉 `pending`，
 * 第二顆蓋掉第一顆，所以畫面上只有一張卡片。
 *
 * **這一條釘的是今天壞掉的行為，不是想要的行為。** (丙)「一顆中斷一張卡」落地時它會
 * 紅，而紅掉之後把斷言反過來寫就是那張卡的驗收句：`pending` 要持有兩顆、上行要逐
 * `interrupt_id` 送、只答一顆時另一顆還掛著。
 *
 * **最容易假綠的地方是「什麼都沒發生」**：模型沒呼叫工具、閘門沒觸發、線沒接上，
 * 都會讓「卡片只有一張」成立。所以每一條都配著計數：中斷真的有兩顆、工具真的跑得起來。
 */

import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { NexusPlugin } from '@nexus/core';
import type { ConversationState, Event, WireClient } from '@nexus/wire';
import {
  appendHumanTurn,
  createWireClient,
  emptyConversation,
  reduceConversation,
  uniformDecisions,
} from '@nexus/wire';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createNexusAgent } from './agent-factory.js';
import { emptyCommandPoint } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const BASE_URL = 'http://fanout.test';

/** 這一輪真的被呼叫到的工具名，依呼叫順序。 */
let ran: string[] = [];

beforeEach(() => {
  ran = [];
});

function spyPlugin(names: readonly string[]): NexusPlugin {
  return {
    name: 'spy',
    apply(registry) {
      for (const name of names) {
        registry.tools.register(
          tool(
            () => {
              ran.push(name);
              return `${name} 跑過了`;
            },
            { name, description: `間諜工具 ${name}`, schema: z.object({}) },
          ),
        );
      }
    },
  };
}

/** 一位 listener 判所有工具，名字從 `exec` 上讀——換機制之後該有的寫法。 */
function gatePlugin(names: readonly string[]): NexusPlugin {
  return {
    name: 'gate',
    apply(registry) {
      registry.approvals.gate((exec, next) =>
        names.includes(exec.name) ? { kind: 'ask', reason: `${exec.name} 要人看過` } : next(),
      );
    },
  };
}

/** 一輪叫兩個工具，之後每輪只講話。尾巴多備幾輪，被拒的那批會回去再問一次模型。 */
function scripted(toolNames: readonly string[]): ScriptedChatModel {
  return new ScriptedChatModel({
    turns: [
      { content: '兩個都動。', toolCalls: toolNames.map((name) => ({ name, args: {} })) },
      { content: '收工。' },
      { content: '再收一次工。' },
    ],
  });
}

interface Session {
  readonly client: WireClient;
  readonly events: AsyncGenerator<Event, void, undefined>;
  readonly frames: Event[];
  state: ConversationState;
  close(): Promise<void>;
}

/** 產品路徑建 agent（`approvals.gate`），接上真的 handler 與真的 client，零 port。 */
async function open(threadId: string, tools: readonly string[]): Promise<Session> {
  const built = await createNexusAgent({
    model: scripted(tools),
    checkpointer: new MemorySaver(),
    plugins: [spyPlugin(tools), gatePlugin(tools)],
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
  await client.runStart(threadId, '動手');
  return {
    client,
    events,
    frames: [],
    state: appendHumanTurn(emptyConversation(), '動手'),
    close: () => handler.close(),
  };
}

/**
 * 抽到條件成立為止。
 *
 * 用 `next()` 不用 `for await` ＋ `break`：`break` 會 `iterator.return()` 把下行關掉，
 * 而這條線要跨兩輪重複抽。
 */
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
 * 不能只看 `status === 'idle'`：中斷那一輪自己也會發一顆 `lifecycle completed / root`，
 * 在按下決定之後才抽到的話會把狀態翻成 idle——resume 那一輪還沒開始跑，而「工具沒跑」
 * 與「還沒輪到工具跑」在那個停止條件下分不出來。所以數模型講完幾輪話。
 */
function settled(turns: number) {
  return (session: Session): boolean =>
    session.state.status === 'idle' &&
    session.state.entries.filter((entry) => entry.kind === 'ai' && !entry.streaming).length >=
      turns;
}

function interruptFrames(session: Session): Event[] {
  return session.frames.filter((frame) => frame.method === 'input.requested');
}

describe('同一輪兩顆核准中斷，走真的線', () => {
  it('**線上兩顆 `input.requested`，折疊器只剩最後一顆**——今天的行為，(丙) 落地時這條會紅', async () => {
    const session = await open('f1', ['alpha', 'beta']);
    await until(session, (s) => interruptFrames(s).length >= 2);

    // 先證「真的有兩顆」——沒有這一句，「只有一顆中斷」也會讓下面的斷言綠。
    expect(interruptFrames(session)).toHaveLength(2);
    // 兩顆各自帶一筆：`wrapToolCall` 是逐次問的，`actionRequests` 恆長度 1。
    expect(
      interruptFrames(session).map(
        (frame) =>
          (frame.params as { data?: { payload?: { actionRequests?: unknown[] } } }).data?.payload
            ?.actionRequests?.length,
      ),
    ).toEqual([1, 1]);

    // **這就是缺陷**：`reduceInputRequested` 整個換掉 `pending`，第二顆蓋掉第一顆。
    const pending = session.state.pending;
    expect(pending?.actions.map((action) => action.name)).toEqual(['beta']);
    // 而畫面就是照著 `pending` 渲染的——`alpha` 從頭到尾不會出現在任何一張卡片上。
    expect(pending?.actions).toHaveLength(1);
    // 兩顆都還沒被答，所以兩個都還沒跑。
    expect(ran).toEqual([]);

    await session.close();
  });

  it('**按一次「全部核准」，沒出現在卡片上的那個也跑了**——一個決定廣播到兩顆上', async () => {
    const session = await open('f2', ['alpha', 'beta']);
    await until(session, (s) => interruptFrames(s).length >= 2);

    const pending = session.state.pending;
    if (pending === undefined) throw new Error('沒有掛著的核准請求');
    // 跟畫面上那顆按鈕做的事完全一樣：`uniformDecisions` 按 `pending.actions.length`
    // （＝1）組一筆決定，`wire-handler` 的長度校驗因此也是對 1 檢查，通得過。
    await session.client.inputRespond('f2', {
      namespace: [...pending.namespace],
      interrupt_id: pending.interruptId,
      response: uniformDecisions(pending, 'approve'),
    });
    await until(session, settled(2));

    // 人只看過也只答過 `beta`，`alpha` 照樣跑了。**成因在基座**：resume 的鍵不是
    // 32-hex，`mapCommand()` 走 `NULL_TASK_ID` 廣播給每一個待決 task
    // （見 `.docs/approval-fanout-survey.md` §2.2）。
    expect(ran.slice().sort()).toEqual(['alpha', 'beta']);
    // **畫面上看得見的落差**：卡片只列了 `beta`，transcript 卻冒出兩個工具都跑完了。
    expect(
      session.state.entries
        .filter((entry) => entry.kind === 'tool')
        .map((entry) => (entry.kind === 'tool' ? entry.name : ''))
        .sort(),
    ).toEqual(['alpha', 'beta']);

    await session.close();
  });
});
