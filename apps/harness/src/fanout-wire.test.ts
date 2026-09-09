/**
 * 同一輪多顆核准中斷，**經過線**之後剩下什麼。
 *
 * `hitl-wire.test.ts` 也走真的線，但它用 `interruptOn` 建 agent——那條路中斷發生在
 * `afterModel`，**一顆中斷帶著整批 `actionRequests`**，正好是這裡要釘的東西的反面。
 * [#112](https://github.com/DemianLi/nexus-agent/issues/112) 之後的產品路徑是
 * `approvals.gate` 折成 `wrapToolCall` 上的 pre-execute waterfall，**逐次呼叫各自
 * `interrupt()`**，所以同一輪兩個 gated 工具＝兩顆中斷。這一份用產品路徑建 agent。
 *
 * `interrupt.test.ts:227,251` 釘的是基座那一層（裸 resume 值＝一個決定套到兩顆上，
 * 核准與拒絕兩個方向都是）。**這一份釘的是折疊器與上行那一層**，也就是
 * [#232](https://github.com/DemianLi/nexus-agent/issues/232) 的病灶所在。
 *
 * **這兩條原本釘的是壞掉的行為，現在是反過來的驗收句**（[#233](https://github.com/DemianLi/nexus-agent/pull/233)
 * 先立、這張卡落地時翻面）。原本：`reduceInputRequested` 整個換掉 `pending`，第二顆蓋掉
 * 第一顆，畫面只有一張卡；按一次核准，沒出現在卡片上的那顆也跑了。現在：`pendings`
 * 逐 `interruptId` 並存，上行逐 id 認領，**只答第一顆就只有第一顆跑**。
 *
 * **承重的是 resume 的鍵長什麼樣。** `Command({ resume })` 在基座有兩條路——鍵全是
 * 32 個小寫 hex（`isXXH3`）走逐 task 派送，否則整個值廣播給每一顆待決 task
 * （`@langchain/langgraph@1.4.12` 的 `pregel/io.js:48`）。送裸值就是廣播，那正是舊
 * 缺陷的機制本身。所以第二條那句「只有 alpha 跑了」是唯一分得出真修好與假修好的斷言：
 * 「兩顆都答完之後兩個都跑了」在廣播底下**照樣綠**。
 *
 * **最容易假綠的地方是「什麼都沒發生」**：模型沒呼叫工具、閘門沒觸發、線沒接上，
 * 都會讓「只跑了一個」成立。所以每一條都配著計數：中斷真的有兩顆、工具真的跑得起來。
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
import { approvalAt, approvalToolNames, emptyCommandPoint } from './fixtures.js';
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
  it('**線上兩顆 `input.requested`，折疊器兩顆都留著**', async () => {
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

    // **這裡曾經只剩 `['beta']`**：`reduceInputRequested` 整個換掉 `pending`，第二顆
    // 蓋掉第一顆，`alpha` 從頭到尾不會出現在任何一張卡片上。
    expect(approvalToolNames(session.state.pendings)).toEqual(['alpha', 'beta']);
    // 兩顆各自帶各自的 `interruptId`——那是逐 task 派送的鑰匙，混在一起就沒得派。
    expect(new Set(session.state.pendings.map((p) => p.interruptId)).size).toBe(2);
    // 兩顆都還沒被答，所以兩個都還沒跑。
    expect(ran).toEqual([]);

    await session.close();
  });

  it('**只答第一顆，就只有第一顆跑**——另一顆帶著原本那顆 id 再度掛上來', async () => {
    const session = await open('f2', ['alpha', 'beta']);
    await until(session, (s) => interruptFrames(s).length >= 2);

    const first = approvalAt(session.state.pendings, 0);
    const second = approvalAt(session.state.pendings, 1);
    expect(first.actions.map((action) => action.name)).toEqual(['alpha']);

    // **答第一顆，不是最後一顆。** 答最後一顆的話，廣播底下也會看到 `beta` 跑掉，
    // 這一條就分不出真修好與假修好——舊行為正是「答哪一顆都兩顆一起跑」。
    await session.client.inputRespond('f2', {
      namespace: [...first.namespace],
      interrupt_id: first.interruptId,
      response: uniformDecisions(first, 'approve'),
    });
    // 抽到 `beta` 那顆重新掛上來為止：答完第一顆會開一個新 run，那顆 `lifecycle
    // running` 會先把 `pendings` 清空，`beta` 再度中斷才補回來（`conversation.ts`）。
    //
    // **`|| settled` 那半邊是為了讓錯的機制當場說話。** resume 送裸值時基座廣播給每一顆
    // 待決 task，`beta` 不會再中斷、這一輪直接收工——只等第三顆 frame 的話，這條會卡到
    // vitest 逾時才紅，而逾時說不出「兩個工具都跑了」。
    await until(session, (s) => interruptFrames(s).length >= 3 || settled(2)(s));

    // **這就是整刀的驗收句**：`beta` 沒有被同一個決定套到。
    expect(ran).toEqual(['alpha']);
    // 而且它**帶著原本那顆 id** 回來——所以折疊器那邊的覆寫是冪等的，不會長出第二張卡。
    expect(session.state.pendings.map((p) => p.interruptId)).toEqual([second.interruptId]);
    expect(approvalToolNames(session.state.pendings)).toEqual(['beta']);

    // 再答第二顆，兩個都跑完、run 收得掉——少了這一段，「第二顆永遠回答不了」也會綠。
    const left = approvalAt(session.state.pendings, 0);
    await session.client.inputRespond('f2', {
      namespace: [...left.namespace],
      interrupt_id: left.interruptId,
      response: uniformDecisions(left, 'approve'),
    });
    await until(session, settled(2));

    expect(ran).toEqual(['alpha', 'beta']);
    expect(session.state.pendings).toEqual([]);
    expect(
      session.state.entries
        .filter((entry) => entry.kind === 'tool')
        .map((entry) => (entry.kind === 'tool' ? entry.name : ''))
        .sort(),
    ).toEqual(['alpha', 'beta']);

    await session.close();
  });
});
