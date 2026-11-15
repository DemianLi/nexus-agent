/**
 * `history-source=log` 時，這次呼叫對不上任何一份日誌：第一個守衛就拋，寫入側靜靜跳過的那些處走不到
 * （[#2842](https://github.com/DemianLi/nexus-agent/issues/2842)）。
 *
 * 寫入側在 `kind !== 'ok'` 時靜靜跳過是 `state` 模式的設計；`log` 模式下它們能成立，靠的是模型呼叫那一層的守衛
 * （`history-shadow.ts` 的 `createHistoryFromLogMiddleware`）先拋。這裡把這個順序釘住：真的 `createNexusAgent`＋`ThreadPump`，
 * 模型是腳本，**零憑證、零外部連線**。
 *
 * 證據是兩條：模型一次都沒被呼叫；`pump` 自己那份日誌上除了 `pump` 自己寫的事件，沒有任何別的種類。
 * 前者擋掉模型呼叫之後的每一處，後者擋掉模型呼叫之前的每一處（pre-step 注入、請求快照、重複提醒、修剪、摘要……），
 * 以後有人加了新的寫入點、在守衛之前寫，種類就會多出來，這條會紅。
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
    // 掛上去的那幾份（別條 thread 的）也沒被寫到。
    expect(
      others.flatMap((other) => other.sessions.root.events.map((event) => event.type)),
    ).toEqual([]);
  });
});
