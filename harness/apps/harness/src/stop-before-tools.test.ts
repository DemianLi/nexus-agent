/**
 * 回覆帶了工具呼叫、還有工具沒開跑時按停止：每顆呼叫照樣恰好一筆結果（[#2043](https://github.com/DemianLi/nexus-agent/issues/2043)）。
 *
 * 真的 `createNexusAgent`＋真的 `ThreadPump`，掛上不變量配套入口。兩個窗口：第一條在日誌記下 `model/end` 的那一刻同步按停
 * （模型那一步已經落定、工具那一步還沒開始）；第二條在獨佔的第一顆跑著、第二顆排在屏障後面時按停。訊號在 `configurable` 裡、
 * 不交給 LangGraph，所以圖照樣走進工具節點。
 *
 * 預設組裝下，沒開跑的那幾顆有兩層會擋，都回 `ABORTED_BEFORE_DISPATCH`：圍堵裡面的 turn-cancel 外層 guard
 * （`@nexus/core` 的 `createTurnCancelGuard`）在動手前問一次中止；它內側的耐久檢查點（`createSessionCheckpointMiddleware`）
 * 在排空之後再問一次。這裡量的是兩層組裝出來的結果，拿掉其中一層不會紅；單層的行為由 `@nexus/core` 的
 * `turn-cancel.test.ts` 與 `session-checkpoint-policy.test.ts` 各自釘住。
 *
 * pump 中止一輪的那一支只寫 `turn/end`，不補 `tool/result`；每顆的結果由圍堵記。兩層都不擋的話，結果照樣每顆一筆，但 `ping`
 * 的本體被叫到、結果是成功的 `pong`，所以兩條除了斷言結果的碼，也直接斷言 `ping` 的本體一次都沒被叫。
 *
 * 量的是：日誌在 `turn/end` 之前每顆一筆結果、存檔點每顆一則 ToolMessage、同一個行程的下一輪模型看到的就是這幾句、不變量不報違規。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import {
  TOOL_ABORTED,
  TOOL_ABORTED_BEFORE_DISPATCH,
  TOOL_ABORTED_BEFORE_DISPATCH_TEXT,
} from '@nexus/core';
import type { InvariantError, PluginEntry, SessionEvent } from '@nexus/core';
import { createCoreInvariantPlugin } from '@nexus/core/invariant';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { composeAttachSessions } from './session-attach.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const THREAD = 'stop-before-tools';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** `slow` 開跑時把 `started` 設起來，要等 `release()` 才回；`ping` 立刻回，`pings` 數它的本體被叫了幾次。兩支都是獨佔的。 */
function probeTools() {
  const gate = { started: false, release: () => {}, pings: 0 };
  const plugin: PluginEntry = {
    plugin: {
      name: 'stop-probes',
      apply(registry) {
        registry.tools.register(
          tool(
            () => {
              gate.pings += 1;
              return 'pong';
            },
            {
              name: 'ping',
              description: '一次。',
              schema: z.object({}),
              metadata: { concurrencySafe: false },
            },
          ),
        );
        registry.tools.register(
          tool(
            async () => {
              gate.started = true;
              await new Promise<void>((resolve) => {
                gate.release = resolve;
              });
              return '慢的跑完了';
            },
            {
              name: 'slow',
              description: '慢。',
              schema: z.object({}),
              metadata: { concurrencySafe: false },
            },
          ),
        );
      },
    },
  };
  return { gate, plugin };
}

async function assemble(turns: readonly ScriptedTurn[], plugin: PluginEntry) {
  const violations: InvariantError[] = [];
  const model = new ScriptedChatModel({ turns });
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    plugins: [plugin, createCoreInvariantPlugin()],
    onInvariantViolation: (error) => violations.push(error),
  });
  const agent = built.agent as unknown as PumpAgent;
  const pump = new ThreadPump(agent, THREAD);
  // 走產品的接線（`composeAttachSessions`）：不變量由 `attachInvariants` 掛，`built.attachSession` 只接參與者。
  const attachment = composeAttachSessions(built)(pump.sessions);
  cleanups.push(async () => {
    await attachment.detach();
    await built.dispose();
  });
  return { model, pump, agent, violations };
}

const resultsOf = (events: readonly SessionEvent[], callId: string) =>
  events.filter(
    (event) => event.type === 'tool/result' && (event.data as { callId: string }).callId === callId,
  );

/** 存檔點上每顆呼叫配到的 ToolMessage 內容，照呼叫 id；沒配到的呼叫是空陣列，所以 `toEqual` 抓得到漏配。 */
async function checkpointAnswers(agent: PumpAgent): Promise<Record<string, unknown[]>> {
  const { values } = (await agent.getState({ configurable: { thread_id: THREAD } })) as {
    values: { messages: BaseMessage[] };
  };
  const answers: Record<string, unknown[]> = {};
  for (const message of values.messages) {
    if (AIMessage.isInstance(message))
      for (const call of message.tool_calls ?? []) answers[call.id ?? ''] ??= [];
    if (ToolMessage.isInstance(message))
      (answers[message.tool_call_id] ??= []).push(message.content);
  }
  return answers;
}

describe('回覆帶了呼叫、工具還沒開跑時按停止（#2043）', () => {
  it('模型那一步落定的那一刻按停：兩顆都是「還沒開始就中止」、本體沒被叫到，turn/end 收尾，存檔點與下一輪每顆一則', async () => {
    const { gate, plugin } = probeTools();
    const { model, pump, agent, violations } = await assemble(
      [
        {
          content: '',
          toolCalls: [
            { name: 'ping', args: {}, id: 'call-a' },
            { name: 'ping', args: {}, id: 'call-b' },
          ],
        },
        { content: '不該輪到這一句。' },
      ],
      plugin,
    );
    let stopped: string | undefined;
    const off = pump.sessions.root.subscribe((event) => {
      if (stopped === undefined && event.type === 'model/end') stopped = pump.cancel();
    });
    await pump.submit({ kind: 'message', text: '跑' });
    await pump.whenIdle();
    off();
    expect(stopped).toBe('run');
    expect(gate.pings).toBe(0);

    const events = pump.sessions.root.events;
    expect(events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'aborted', cause: { kind: 'user' } } },
    });
    for (const callId of ['call-a', 'call-b']) {
      const results = resultsOf(events, callId);
      expect(results).toHaveLength(1);
      expect(results[0]?.data).toMatchObject({
        callId,
        isError: true,
        error: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
      });
    }
    expect(await checkpointAnswers(agent)).toEqual({
      'call-a': [TOOL_ABORTED_BEFORE_DISPATCH_TEXT],
      'call-b': [TOOL_ABORTED_BEFORE_DISPATCH_TEXT],
    });

    await pump.submit({ kind: 'message', text: '再來' });
    const answers = (model.prompts.at(-1) ?? []).filter((message): message is ToolMessage =>
      ToolMessage.isInstance(message),
    );
    expect(answers.map((message) => [message.tool_call_id, message.content])).toEqual([
      ['call-a', TOOL_ABORTED_BEFORE_DISPATCH_TEXT],
      ['call-b', TOOL_ABORTED_BEFORE_DISPATCH_TEXT],
    ]);
    expect(violations).toEqual([]);
  });

  it('獨佔：第一顆在跑、第二顆還排著時按停：排著的那顆「還沒開始就中止」，跑著的那顆等它落定記成中止', async () => {
    const { gate, plugin } = probeTools();
    const { pump, agent, violations } = await assemble(
      [
        {
          content: '',
          toolCalls: [
            { name: 'slow', args: {}, id: 'call-running' },
            { name: 'ping', args: {}, id: 'call-queued' },
          ],
        },
        { content: '不該輪到這一句。' },
      ],
      plugin,
    );
    const turn = pump.submit({ kind: 'message', text: '跑' });
    while (!gate.started) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pump.cancel()).toBe('run');
    gate.release();
    await turn;
    await pump.whenIdle();

    const events = pump.sessions.root.events;
    expect(events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'aborted', cause: { kind: 'user' } } },
    });
    const [running] = resultsOf(events, 'call-running');
    const [queued] = resultsOf(events, 'call-queued');
    expect(resultsOf(events, 'call-running')).toHaveLength(1);
    expect(resultsOf(events, 'call-queued')).toHaveLength(1);
    expect(running?.data).toMatchObject({ isError: true, error: { code: TOOL_ABORTED } });
    expect(queued?.data).toMatchObject({
      isError: true,
      error: { code: TOOL_ABORTED_BEFORE_DISPATCH },
    });
    const answers = await checkpointAnswers(agent);
    expect(answers['call-running']).toHaveLength(1);
    expect(answers['call-queued']).toEqual([TOOL_ABORTED_BEFORE_DISPATCH_TEXT]);
    expect(gate.pings).toBe(0);
    expect(violations).toEqual([]);
  });
});
