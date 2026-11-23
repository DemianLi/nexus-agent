/**
 * **工具結果記不進日誌：這一步失敗，卡收成 failed＋`TOOL_OUTCOME_UNKNOWN`**（[#1665](https://github.com/DemianLi/nexus-agent/issues/1665)）。
 *
 * `containment.test.ts` 證的是 middleware 那一層會補一顆合成的錯誤結果再拋原錯。這一份走完整條：腳本模型 →
 * `createNexusAgent`（圍堵記工具事件）→ `ThreadPump`（日誌、工具卡）→ `@nexus/wire` 的折疊器，證那個錯真的讓這一輪失敗，
 * 卡也真的收在日誌補的那一顆上，不是停在「執行中」或折疊器自己補的那一格。
 *
 * 拒收是真的：工具的 artifact 比 {@link SESSION_EVENT_MAX_DEPTH} 深，`SessionLog.append` 自己拋，不是 spy 造的。
 * 照 dsh `agent.ts:344-355`：結果記不進去先補一顆 UNKNOWN 的錯誤結果，再拋原錯。
 */

import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { SESSION_EVENT_MAX_DEPTH, TOOL_OUTCOME_UNKNOWN } from '@nexus/core';
import type { PluginEntry, SessionEventMap } from '@nexus/core';
import { emptyConversation, reduceConversation } from '@nexus/wire';
import type { Event, ToolEntry } from '@nexus/wire';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createNexusAgent } from './agent-factory.js';
import { ScriptedChatModel } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const TOOL_NAME = 'deep_probe';
const CALL_ID = 'call-deep';

/** 剛好超過日誌深度上限的值（同 `@nexus/core` 測試夾具的 `pastLogDepthCap`，那一支不出套件）。 */
function pastLogDepthCap(): unknown {
  let value: unknown = 'leaf';
  for (let level = 0; level < SESSION_EVENT_MAX_DEPTH; level++) {
    value = level % 2 ? { next: value } : [value];
  }
  return value;
}

/** 一顆結果帶太深 artifact 的工具：本體成功，記結果時日誌拒收。 */
const deepPlugin: PluginEntry = {
  plugin: {
    name: 'deep-probe',
    apply(registry) {
      registry.tools.register(
        tool(() => ['好了', pastLogDepthCap()] as [string, unknown], {
          name: TOOL_NAME,
          description: '回一個帶很深 artifact 的結果。',
          schema: z.object({}),
          responseFormat: 'content_and_artifact',
        }),
      );
    },
  },
};

describe('工具結果記不進日誌（#1665）', () => {
  it('這一輪失敗並帶原錯；日誌有合成的錯誤結果；卡收成 failed＋TOOL_OUTCOME_UNKNOWN', async () => {
    const model = new ScriptedChatModel({
      turns: [
        { content: '', toolCalls: [{ name: TOOL_NAME, args: {}, id: CALL_ID }] },
        { content: '收尾' },
      ],
    });
    const built = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      plugins: [deepPlugin],
    });
    const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'tool-result-rejected');
    const detach = built.attachSession(pump.sessions);
    const frames: Event[] = [];
    const line = new AbortController();
    const draining = (async () => {
      for await (const frame of pump.subscribe(['messages', 'tools', 'lifecycle'], line.signal))
        frames.push(frame);
    })();
    try {
      await pump.submit({ kind: 'message', text: '跑一下' }).catch((error: unknown) => error);
      await pump.whenIdle();

      const events = pump.sessions.root.events;
      // (1) 這一輪失敗，訊息是日誌那一關的原錯：帶 tool/result 的路徑與層數。
      const failed = events.filter((event) => event.type === 'turn/failed');
      expect(failed).toHaveLength(1);
      expect((failed[0]!.data as SessionEventMap['turn/failed']).message).toMatch(
        new RegExp(
          `會話事件的 tool\\/result 的 data\\.message\\..* 是第 ${String(SESSION_EVENT_MAX_DEPTH + 1)} 層巢狀`,
        ),
      );
      // 模型沒有拿到第二輪：失敗的那一步之後不再請求。
      expect(model.prompts).toHaveLength(1);

      // (2) 日誌上有合成的錯誤結果，接在 tool/call 後面。
      const results = events.filter((event) => event.type === 'tool/result');
      expect(results).toHaveLength(1);
      expect(results[0]!.data).toMatchObject({
        callId: CALL_ID,
        isError: true,
        error: { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN },
      });

      // (3) 卡收在那一顆上：failed、碼是 TOOL_OUTCOME_UNKNOWN（不是折疊器替沒結果的卡補的那一格）。
      let state = emptyConversation();
      for (const frame of frames) state = reduceConversation(state, frame);
      const cards = state.entries.filter((entry): entry is ToolEntry => entry.kind === 'tool');
      expect(cards.map((card) => [card.callId, card.status, card.errorCode])).toEqual([
        [CALL_ID, 'failed', TOOL_OUTCOME_UNKNOWN],
      ]);
    } finally {
      line.abort();
      await draining;
      detach();
      await built.dispose();
    }
  });
});
