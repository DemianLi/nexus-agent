/**
 * 兩條進入點寫進同一種日誌——**這是 [#89](https://github.com/DemianLi/nexus-agent/issues/89)
 * 選 (B) 而不是 (A) 的全部價值所在**。
 *
 * (A) 是接 `thread-pump.ts` 那個為瀏覽器排序去重而生的 `seq`，而 CLI 那條路
 * （`cli.ts` 直接 `agent.stream()`）根本不經過 pump —— 接了等於遙測只看得到瀏覽器
 * 來的 run。所以這一檔要證的不是「日誌會動」，是**兩條路各自都真的在寫**、
 * 而且寫出來的號在自己的 session 內連續。
 *
 * 訊息內容不在這一版的日誌裡，理由見 `@nexus/core` 的 `session-log.ts` 檔頭：
 * 兩條路拿得到的顆粒度不一樣（分片 vs 完整訊息），硬記會變成合成資料。
 */

import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { SessionLog } from '@nexus/core';
import { createDeepAgent, StateBackend } from 'deepagents';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createCliAgent, DEFAULT_PLUGINS, runTurn } from './cli.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { ThreadPump } from './thread-pump.js';

function noteTool() {
  return tool(({ text }: { text: string }) => `已記下：${text}`, {
    name: 'take_note',
    description: '把一段文字記下來。',
    schema: z.object({ text: z.string().describe('要記下的內容') }),
  });
}

function buildPumpAgent(turns: readonly ScriptedTurn[], gated = false): PumpAgent {
  return createDeepAgent({
    model: new ScriptedChatModel({ turns }),
    tools: [noteTool()],
    backend: new StateBackend(),
    ...(gated
      ? {
          checkpointer: new MemorySaver(),
          interruptOn: { take_note: { allowedDecisions: ['approve', 'reject'] as const } },
        }
      : {}),
  }) as unknown as PumpAgent;
}

const PLAIN_TURNS: readonly ScriptedTurn[] = [{ content: '好的。' }];

const GATED_TURNS: readonly ScriptedTurn[] = [
  { content: '', toolCalls: [{ name: 'take_note', args: { text: '一筆' } }] },
  { content: '記完了。' },
];

/** `seq` 必須是 0,1,2,… ——這是耐久序號唯一的硬要求。 */
function seqsOf(log: SessionLog): number[] {
  return log.events.map((event) => event.seq);
}

describe('會話事件日誌：web 那條路', () => {
  it('一輪跑完寫下 turn/start 與 turn/end，seq 連續', async () => {
    const pump = new ThreadPump(buildPumpAgent(PLAIN_TURNS), 'web-1');

    await pump.submit({ kind: 'message', text: '嗨' });

    expect(pump.sessionLog.events.map((event) => event.type)).toEqual(['turn/start', 'turn/end']);
    expect(seqsOf(pump.sessionLog)).toEqual([0, 1]);
    expect(pump.sessionLog.events[0]?.data).toEqual({ kind: 'message', text: '嗨' });
    expect(pump.sessionLog.sessionId).toBe('web-1');
  });

  it('停在核准點會記下 interrupt/raised，而且那一輪照樣有 turn/end', async () => {
    const pump = new ThreadPump(buildPumpAgent(GATED_TURNS, true), 'web-2');

    await pump.submit({ kind: 'message', text: '記一筆' });

    const types = pump.sessionLog.events.map((event) => event.type);
    expect(types).toEqual(['turn/start', 'interrupt/raised', 'turn/end']);
    expect(seqsOf(pump.sessionLog)).toEqual([0, 1, 2]);
    const raised = pump.sessionLog.events[1]?.data as { interruptId: string };
    expect(raised.interruptId).toBe(pump.pending?.interruptId ?? '(沒有掛著的中斷)');
  });

  it('核准之後那一輪記成 resume，號接在前一輪後面', async () => {
    const pump = new ThreadPump(buildPumpAgent(GATED_TURNS, true), 'web-3');

    await pump.submit({ kind: 'message', text: '記一筆' });
    await pump.submit({ kind: 'resume', response: { decisions: [{ type: 'approve' }] } });

    expect(pump.sessionLog.events.map((event) => event.type)).toEqual([
      'turn/start',
      'interrupt/raised',
      'turn/end',
      'turn/start',
      'turn/end',
    ]);
    expect(seqsOf(pump.sessionLog)).toEqual([0, 1, 2, 3, 4]);
    expect(pump.sessionLog.events[3]?.data).toEqual({ kind: 'resume' });
  });

  it('跑壞了記 turn/failed，而且錯誤照樣往外拋', async () => {
    const failing: PumpAgent = {
      streamEvents: () => Promise.reject(new Error('模型不見了')),
    };
    const pump = new ThreadPump(failing, 'web-4');

    await expect(pump.submit({ kind: 'message', text: '嗨' })).rejects.toThrow('模型不見了');

    expect(pump.sessionLog.events.map((event) => event.type)).toEqual([
      'turn/start',
      'turn/failed',
    ]);
    expect(pump.sessionLog.events[1]?.data).toEqual({ message: '模型不見了' });
  });
});

describe('會話事件日誌：CLI 那條路', () => {
  const silent = { log: () => undefined, error: () => undefined };

  it('CLI 也在寫，而且 seq 跨輪連續——同一份日誌活得比一輪久', async () => {
    const { agent, dispose, sessionLog } = await createCliAgent({ live: false }, DEFAULT_PLUGINS);

    try {
      await runTurn(agent, '第一句', silent, sessionLog);
      await runTurn(agent, '第二句', silent, sessionLog);
    } finally {
      await dispose();
    }

    expect(sessionLog.events.map((event) => event.type)).toEqual([
      'turn/start',
      'turn/end',
      'turn/start',
      'turn/end',
    ]);
    expect(seqsOf(sessionLog)).toEqual([0, 1, 2, 3]);
    expect(sessionLog.events[2]?.data).toEqual({ kind: 'message', text: '第二句' });
    expect(sessionLog.sessionId).toBe('cli');
  });

  it('一輪拋錯時記 turn/failed，錯誤照樣往外拋', async () => {
    const exploding = {
      stream: () => Promise.reject(new Error('串流開不起來')),
    } as unknown as Parameters<typeof runTurn>[0];
    const log = new SessionLog('cli');

    await expect(runTurn(exploding, '嗨', silent, log)).rejects.toThrow('串流開不起來');

    expect(log.events.map((event) => event.type)).toEqual(['turn/start', 'turn/failed']);
  });
});
