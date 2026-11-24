/**
 * native 撞到步數上限時，`AGENT_STEP_LIMIT` 這個碼**不進會話日誌**：`turn/failed` 事件只帶 `classifyTurnFailure` 分出來的
 * `code` 與沒有排錯網址的訊息。`lc_error_code` 只在行程內的錯誤物件上，CLI 的退出碼讀它（`cli.test.ts`）。
 * 這裡量的是日誌上的事件；serve 的 wire 上同一顆 `turn/failed` 沒有另外量。
 *
 * 零憑證、零外部連線。
 */

import { MemorySaver } from '@langchain/langgraph';
import { afterEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { ScriptedChatModel } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('native 步數上限的失敗事件', () => {
  it('turn/failed 的訊息沒有排錯網址，整筆事件裡沒有 lc_error_code 與任何一個步數碼', async () => {
    const built = await createNexusAgent({
      model: new ScriptedChatModel({ turns: [{ content: '好了' }] }),
      checkpointer: new MemorySaver(),
      summarization: false,
      observationPolicy: false,
      plugins: [],
      recursionLimit: 1,
      agentLoop: 'native',
    });
    const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'native-step-limit-wire');
    const detach = built.attachSession(pump.sessions);
    cleanups.push(async () => {
      pump.close();
      detach();
      await built.dispose();
    });

    // pump 把這一輪的失敗記進日誌之後照樣重拋；這裡只看記下來的。
    await pump.submit({ kind: 'message', text: '動手', id: 'm1' }).catch(() => undefined);
    await pump.whenIdle().catch(() => undefined);

    const failed = pump.sessions.root.events.filter((event) => event.type === 'turn/failed');
    expect(failed).toHaveLength(1);
    const text = JSON.stringify(failed[0]);
    expect(text).toContain('Recursion limit of 1 reached');
    expect(text).not.toContain('docs.langchain.com');
    expect(text).not.toContain('lc_error_code');
    expect(text).not.toContain('AGENT_STEP_LIMIT');
    expect(text).not.toContain('GRAPH_RECURSION_LIMIT');
  });
});
