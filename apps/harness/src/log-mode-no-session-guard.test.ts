/**
 * `history-source=log` 時，這次呼叫對不上任何一份日誌：第一個守衛就拋，模型一次都沒被叫
 * （[#2842](https://github.com/DemianLi/nexus-agent/issues/2842)）。
 *
 * 寫入側在 `kind !== 'ok'` 時靜靜跳過是 `state` 模式的設計；`log` 模式下它們能成立，靠的是模型呼叫那一層的守衛
 * （`@nexus/core` 的 `history-shadow.ts`，`createHistoryFromLogMiddleware`）先拋。這裡把這個順序釘住：真的 `createNexusAgent`＋`ThreadPump`，
 * 模型是腳本，**零憑證、零外部連線**。
 *
 * 證據：模型一次都沒被呼叫（`model.prompts` 為 0，沒有任何東西進到模型，「模型所見多於日誌」的分家不可能發生），
 * 而且這一輪是以守衛訊息失敗，不是靜靜成功。
 *
 * 模型呼叫**之後**的寫入點（`model/start`、`user/message`、工具結果、approval、`image/offload`、`compaction/summary`……）在這個情境下走不到。
 * 模型呼叫**之前**的寫入點（pre-step 注入、請求快照、重複提醒、修剪……）可能走到，但它們都是先 `forCall`、
 * `kind !== 'ok'` 就跳過，所以走到也沒寫；這裡**分不出**「沒走到」與「走到了但跳過」，也不需要分：守衛接著就拋、模型沒被叫，
 * 沒有東西可分家。`pump` 日誌上的種類檢查只擋得住不經 `forCall`、直接寫 `pump` 那份日誌的寫法。
 *
 * 模型呼叫成功之後才卸載日誌（工具動手時）的那一條，證明下一次模型呼叫同樣在守衛就拋。
 */

import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 這一輪 `ThreadPump` 自己會寫的種類：收進來的輸入、輪頭、標題、失敗收尾。 */
const PUMP_OWN_EVENT_TYPES = new Set([
  'inbox/spliced',
  'turn/start',
  'session/title',
  'turn/failed',
]);

const PINGS: PluginEntry = {
  plugin: {
    name: 'pings',
    apply(registry) {
      registry.tools.register(
        tool(() => 'pong', { name: 'ping', description: '一次。', schema: z.object({}) }),
      );
    },
  },
};

const GUARD_MESSAGE = '找不到這次模型呼叫的日誌';

async function runWithoutMatchingLog(
  agentLoop: 'langgraph' | 'native',
  turns: readonly ScriptedTurn[],
  attachedOthers: number,
) {
  const model = new ScriptedChatModel({ turns: [...turns] });
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    summarization: false,
    observationPolicy: false,
    plugins: [PINGS],
    historySource: 'log',
    agentLoop,
  });
  const agent = built.agent as unknown as PumpAgent;
  const pump = new ThreadPump(agent, 'no-session-guard');
  // 別條 thread 的日誌掛上去、這條的不掛：註冊表裡有幾份，但沒有一份是這次呼叫的。
  // 只掛一份時，註冊表不核對 thread（單條 thread 的相容層），呼叫會寫進那一份，所以這裡至少掛兩份。
  const others = Array.from(
    { length: attachedOthers },
    (_, index) => new ThreadPump(agent, `someone-else-${String(index)}`),
  );
  const detaches = others.map((other) => built.attachSession(other.sessions));
  cleanups.push(async () => {
    pump.close();
    for (const other of others) other.close();
    for (const detach of detaches) detach();
    await built.dispose();
  });
  await pump.submit({ kind: 'message', text: '嗨' }).catch(() => undefined);
  await pump.whenIdle();
  return { model, pump, others };
}

describe.each(['langgraph', 'native'] as const)('log 模式、對不上日誌（%s）', (agentLoop) => {
  it.each([
    ['一份日誌都沒掛', 0],
    ['掛的是兩份別條 thread 的日誌', 2],
  ] as const)('%s：第一個守衛拋，模型沒被叫，日誌上只有 pump 自己寫的', async (_, attached) => {
    const { model, pump, others } = await runWithoutMatchingLog(
      agentLoop,
      [{ content: '', toolCalls: [{ name: 'ping', args: {}, id: 'call-a' }] }, { content: '好。' }],
      attached,
    );

    const failed = pump.sessions.root.events.filter((event) => event.type === 'turn/failed');
    expect(failed).toHaveLength(1);
    expect((failed[0]?.data as { message: string }).message).toContain(GUARD_MESSAGE);
    expect((failed[0]?.data as { message: string }).message).toContain(
      'history-source=log 不退回 state',
    );
    expect(model.prompts).toHaveLength(0);
    const extra = pump.sessions.root.events
      .map((event) => event.type)
      .filter((type) => !PUMP_OWN_EVENT_TYPES.has(type));
    expect(extra).toEqual([]);
    expect(
      others.flatMap((other) => other.sessions.root.events.map((event) => event.type)),
    ).toEqual([]);
  });
});

describe.each(['langgraph', 'native'] as const)('log 模式、中途卸載（%s）', (agentLoop) => {
  it('第一次模型呼叫成功、工具動手時日誌被卸載：下一次模型呼叫在守衛就拋，這一輪失敗', async () => {
    const detached: (() => void)[] = [];
    const model = new ScriptedChatModel({
      turns: [
        { content: '', toolCalls: [{ name: 'detach', args: {}, id: 'call-a' }] },
        { content: '好。' },
      ],
    });
    const plugin: PluginEntry = {
      plugin: {
        name: 'detacher',
        apply(registry) {
          registry.tools.register(
            tool(
              () => {
                for (const detach of detached) detach();
                return 'done';
              },
              { name: 'detach', description: '卸載日誌。', schema: z.object({}) },
            ),
          );
        },
      },
    };
    const built = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      summarization: false,
      observationPolicy: false,
      plugins: [plugin],
      historySource: 'log',
      agentLoop,
    });
    const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'mid-detach');
    detached.push(built.attachSession(pump.sessions));
    cleanups.push(async () => {
      pump.close();
      await built.dispose();
    });
    await pump.submit({ kind: 'message', text: '嗨' }).catch(() => undefined);
    await pump.whenIdle();

    const failed = pump.sessions.root.events.filter((event) => event.type === 'turn/failed');
    expect(failed).toHaveLength(1);
    expect((failed[0]?.data as { message: string }).message).toContain(GUARD_MESSAGE);
    expect(model.prompts).toHaveLength(1);
  });
});
