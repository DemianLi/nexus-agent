/**
 * 核准被拒之後，**線上**留下什麼。
 *
 * 這一份補的是一句放了很久的「沒有量過」。`hitl-wire.test.ts:216` 那條（拒絕 → 線上一顆
 * frame 都沒有）走的是**基座**的機制（`interruptOn`、中斷在 `afterModel`、tools node 從沒
 * 跑），它的行內註解一路寫著「[#112](https://github.com/DemianLi/nexus-agent/pull/112)
 * 之後的產品路徑中斷在 `wrapToolCall` 裡，下行長什麼樣沒有量過」。2026-09-09 量了
 * （[#239](https://github.com/DemianLi/nexus-agent/issues/239) 收尾時順帶）：
 *
 * **產品路徑的結論一樣是零顆 `tools` frame，但成因不同。** 基座是整個 tools node 沒跑；
 * 產品路徑的 tools node 有跑，是 `packages/nexus-core/src/approval.ts` 的 `wrapToolCall`
 * 在 `handler(request)` **之前**就 `interrupt()`／回 `denial()`，所以那一格從頭到尾沒有進入
 * 基座發生命週期事件的那一段。被拒的那則 `status: 'error'` ToolMessage 只到得了
 * `state.messages`（`interrupt.test.ts:140-148` 釘著它真的在那裡），**下行一個字都沒說**。
 *
 * **這跟 `ask_user_question` 的中斷不是同一條線，差在誰拋。** 那顆的 `interrupt()` 在
 * **工具本體裡**，所以 `tool-started` 早就發過了，掛著那段會看到一顆 `tool-error`
 * （#239／[#243](https://github.com/DemianLi/nexus-agent/pull/243) 的測量，
 * `tool-frame-classify.test.ts` 與 `ask-user-wire.test.ts` 釘著）。核准閘門的中斷在
 * **middleware 裡**，連 `tool-started` 都沒有。**兩條路的證據不能互相引用**——這份檔案存在
 * 的理由就是這件事：把「工具自己拋」量到的結果套到「middleware 短路」上會講錯。
 *
 * **核准那一格是承重的對照組。** 少了它，「拒絕之後零顆 frame」在一個根本不轉發 `tools`
 * frame 的組裝底下**照樣綠**——而那正是這條斷言唯一會假綠的方式。
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
import { approvalAt, emptyCommandPoint } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const BASE_URL = 'http://rejection.test';
const GATED = 'alpha';

/** 這一輪工具本體真的被呼叫到了沒有。 */
let ran: string[] = [];

beforeEach(() => {
  ran = [];
});

function spyPlugin(): NexusPlugin {
  return {
    name: 'spy',
    apply(registry) {
      registry.tools.register(
        tool(
          () => {
            ran.push(GATED);
            return `${GATED} 跑過了`;
          },
          { name: GATED, description: `間諜工具 ${GATED}`, schema: z.object({}) },
        ),
      );
    },
  };
}

/** 產品路徑的閘門：`approvals.gate`，fold 成 `wrapToolCall` 上的 pre-execute waterfall。 */
function gatePlugin(): NexusPlugin {
  return {
    name: 'gate',
    apply(registry) {
      registry.approvals.gate((exec, next) =>
        exec.name === GATED ? { kind: 'ask', reason: `${GATED} 要人看過` } : next(),
      );
    },
  };
}

interface Session {
  readonly client: WireClient;
  readonly events: AsyncGenerator<Event, void, undefined>;
  readonly frames: Event[];
  state: ConversationState;
  close(): Promise<void>;
}

/** 產品路徑建 agent，接上真的 handler 與真的 client，零 port。 */
async function open(threadId: string): Promise<Session> {
  const built = await createNexusAgent({
    model: new ScriptedChatModel({
      turns: [
        { content: `動 ${GATED}。`, toolCalls: [{ name: GATED, args: {} }] },
        { content: '收工。' },
        // 被拒的那批會回去再問一次模型，尾巴多備一輪免得腳本用完。
        { content: '再收一次工。' },
      ],
    }),
    checkpointer: new MemorySaver(),
    plugins: [spyPlugin(), gatePlugin()],
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

/** 抽到條件成立為止。用 `next()` 不用 `for await`——`break` 會把下行關掉，這條線要跨兩輪抽。 */
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
 * 在按下決定之後才抽到的話會把狀態翻成 idle——resume 那一輪還沒開始跑，而「線上沒有
 * `tools` frame」與「還沒輪到它發」在那個停止條件下分不出來。所以數模型講完幾輪話。
 */
function settled(turns: number) {
  return (session: Session): boolean =>
    session.state.status === 'idle' &&
    session.state.entries.filter((entry) => entry.kind === 'ai' && !entry.streaming).length >=
      turns;
}

/** 線上的 `tools` frame，攤成 `事件名` 的清單。 */
function toolEvents(session: Session): string[] {
  return session.frames
    .filter((frame) => frame.method === 'tools')
    .map((frame) => String((frame.params as { data?: { event?: unknown } }).data?.event));
}

/** 走完一次「掛上來 → 給一個決定 → 收工」。 */
async function decide(
  session: Session,
  threadId: string,
  type: 'approve' | 'reject',
): Promise<void> {
  await until(session, (s) => s.frames.some((frame) => frame.method === 'input.requested'));
  const pending = approvalAt(session.state.pendings);
  await session.client.inputRespond(threadId, {
    namespace: [...pending.namespace],
    interrupt_id: pending.interruptId,
    response: uniformDecisions(pending, type),
  });
  await until(session, settled(2));
}

describe('核准的兩個方向在下行上長什麼樣', () => {
  it('**拒絕 → 線上零顆 `tools` frame**：中斷在 `handler` 之前，連 `tool-started` 都沒有', async () => {
    const session = await open('r1');
    await decide(session, 'r1', 'reject');

    // 先證中斷真的發生過——沒有這一句，「閘門根本沒觸發」也會讓下面全綠。
    expect(session.frames.filter((frame) => frame.method === 'input.requested')).toHaveLength(1);
    // 工具本體沒跑：`wrapToolCall` 回 `denial()` 時 `handler(request)` 一次都沒被呼叫。
    expect(ran).toEqual([]);

    // **這就是那句「沒有量過」的答案：不會。** 基座是 tools node 沒跑，產品路徑是那一格
    // 沒進到發事件的那一段——結論相同，成因不同。被拒的那則 error ToolMessage 只在
    // `state.messages` 裡（`interrupt.test.ts:140-148`），下行對它一個字都沒說。
    expect(toolEvents(session)).toEqual([]);
    expect(session.state.entries.filter((entry) => entry.kind === 'tool')).toEqual([]);

    await session.close();
  });

  it('**核准 → `tool-started` 與 `tool-finished` 都到**——上一條不是因為線收不到 `tools`', async () => {
    const session = await open('r2');
    await decide(session, 'r2', 'approve');

    // **這一條承重。** 少了它，一個把 `tools` frame 整個丟掉的 pump 也會讓上一條綠。
    expect(toolEvents(session)).toEqual(['tool-started', 'tool-finished']);
    expect(ran).toEqual([GATED]);
    expect(
      session.state.entries
        .filter((entry) => entry.kind === 'tool')
        .map((entry) => (entry.kind === 'tool' ? [entry.name, entry.status] : [])),
    ).toEqual([[GATED, 'done']]);

    await session.close();
  });
});
