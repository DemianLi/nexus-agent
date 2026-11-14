/**
 * 停在核准點時再送一句話（[#629](https://github.com/DemianLi/nexus-agent/issues/629)），在 `history-source=log` 下
 * 與 `state` 逐字相同，**真的組裝、兩種 loop 各跑一次**。
 *
 * 情境：模型叫一顆要核准的工具，pump 停在核准點；再送第二句話，pump 自己停住它（不靠補懸空呼叫）；核准之後第一輪收尾，才跑第二句。
 * 對 `state` 與 `log` 各跑一次，比三次模型呼叫收到的 prompt（型別、內容、tool_calls）、日誌上的事件型別序列，並斷言：
 * 危險工具只跑一次、第三次的 prompt 看得到真結果、補懸空呼叫的那句（`another message came in`）不在任何一次 prompt 裡。
 *
 * 明給 `historySource` 並斷言組裝回報的值（`send-queue.test.ts` 同一個情境走測試 setup 補的預設 `state`）。
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import type { BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { HistorySource, PluginEntry } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import type { CreateNexusAgentOptions } from './agent-factory.js';
import { ScriptedChatModel } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

type Loop = NonNullable<CreateNexusAgentOptions['agentLoop']>;

function dangerPlugin(probe: { danger: number }): PluginEntry {
  return {
    plugin: {
      name: 'resend-tools',
      apply(registry) {
        registry.tools.register(
          tool(
            () => {
              probe.danger += 1;
              return '危險的事做完了';
            },
            { name: 'danger', description: '要核准。', schema: z.object({}) },
          ),
        );
        registry.approvals.gate((exec, next) =>
          exec.name === 'danger' ? { kind: 'ask', reason: '危險' } : next(),
        );
      },
    },
  };
}

/** 只比型別、內容與 tool_calls。 */
const project = (message: BaseMessage): unknown => ({
  type: message.getType(),
  content: message.content,
  toolCalls: 'tool_calls' in message ? message.tool_calls : undefined,
});

async function run(loop: Loop, historySource: HistorySource) {
  const probe = { danger: 0 };
  const model = new ScriptedChatModel({
    turns: [
      { content: '做危險的。', toolCalls: [{ name: 'danger', args: {} }] },
      { content: '第一輪收尾。' },
      { content: '第二句的回覆。' },
    ],
  });
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    plugins: [dangerPlugin(probe)],
    agentLoop: loop,
    historySource,
  });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'resend-log');
  const detach = built.attachSession(pump.sessions);
  try {
    await pump.submit({ kind: 'message', text: '第一句' });
    expect(pump.awaitingInput).toBe(true);
    const second = pump.submit({ kind: 'message', text: '第二句' });
    await pump.whenIdle();
    // 停在核准點時收下、停住：模型只被叫過一次。
    expect(model.prompts).toHaveLength(1);
    const [pending] = pump.pendings;
    await pump.submit({
      kind: 'resume',
      interruptId: pending!.interruptId,
      response: { decisions: [{ type: 'approve' }] },
    } as never);
    await second;
    await pump.whenIdle();
    return {
      built: built.historySource,
      danger: probe.danger,
      prompts: model.prompts.map((prompt) => prompt.map(project)),
      events: pump.sessionLog.events.map((event) => event.type),
    };
  } finally {
    pump.close();
    detach();
    await built.dispose();
  }
}

describe.each(['langgraph', 'native'] as const)('停在核准點再送一句話：%s', (loop) => {
  it('log 與 state 逐字相同：危險工具只跑一次、真結果進了第三次 prompt、補懸空呼叫那句沒出現', async () => {
    const viaState = await run(loop, 'state');
    const viaLog = await run(loop, 'log');

    expect(viaState.built).toBe('state');
    expect(viaLog.built).toBe('log');
    expect(viaLog.danger).toBe(1);
    expect(viaLog.prompts).toHaveLength(3);
    expect(JSON.stringify(viaLog.prompts[2])).toContain('危險的事做完了');
    expect(JSON.stringify(viaLog.prompts)).not.toContain('another message came in');
    expect(viaLog.prompts).toEqual(viaState.prompts);
    expect(viaLog.events).toEqual(viaState.events);
  }, 20000);
});
