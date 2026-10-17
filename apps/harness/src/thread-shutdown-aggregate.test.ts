/**
 * serve 關機時 thread 的收尾：**每條 thread 都收完、每一步各自接住，最後把錯聚合起來報出來**
 * （[#1511](https://github.com/DemianLi/nexus-agent/issues/1511) 驗收 6）。
 *
 * 真的 wire handler、真的最小 agent（腳本模型）；`attachPersistence`、`attachSessions` 與 agent 的 `dispose` 用可以失敗的替身。
 * 以前 `close()` 對每條 thread 做 `dispose().catch(() => undefined)`，而 `dispose` 又是「第一步拋錯就停」：
 *
 * - 落盤收尾拋錯時 `threadAgent.dispose()`（MCP 子行程在它底下）不跑、錯誤被吞，`close()` 照樣 resolve——關機時最後一次落盤失敗一行都不會印。
 * - 前一步（例如會話接線）拋錯時落盤整步跳過，視窗裡還沒寫的事件靜靜丟失。
 */

import { MemorySaver } from '@langchain/langgraph';
import { historyPath } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import { composeAttachSessions } from './session-attach.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { ThreadAgent } from './wire-handler.js';

const BASE = 'http://shutdown.test';

interface Faults {
  /** 落盤的 `dispose` 拋這個。 */
  readonly persistenceDispose?: Error;
  /** 會話接線的 `detach` 拋這個。 */
  readonly detach?: Error;
  /** agent 的 `dispose` 拋這個。 */
  readonly agentDispose?: Error;
}

function build(faults: ReadonlyMap<string, Faults> = new Map()) {
  /** 每條 thread 各步驟實際跑過的順序。 */
  const steps = new Map<string, string[]>();
  const stepsOf = (threadId: string): string[] => {
    const existing = steps.get(threadId);
    if (existing !== undefined) return existing;
    const created: string[] = [];
    steps.set(threadId, created);
    return created;
  };
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async (threadId): Promise<ThreadAgent> => {
      const fault = faults.get(threadId) ?? {};
      const built = await createNexusAgent({
        model: new ScriptedChatModel({ turns: [{ content: '好' }] }),
        checkpointer: new MemorySaver(),
        plugins: [],
      });
      const compose = composeAttachSessions(built);
      return {
        agent: built.agent as unknown as PumpAgent,
        commands: built.commands,
        attachSessions: (sessions, options) => {
          const attachment = compose(sessions, options);
          const realDetach = attachment.detach.bind(attachment);
          return Object.assign(attachment, {
            detach: async () => {
              stepsOf(threadId).push('detach');
              await realDetach();
              if (fault.detach !== undefined) throw fault.detach;
            },
          });
        },
        attachPersistence: () => ({
          flush: () => Promise.resolve(),
          dispose: () => {
            stepsOf(threadId).push('persistence');
            return fault.persistenceDispose === undefined
              ? Promise.resolve()
              : Promise.reject(fault.persistenceDispose);
          },
        }),
        dispose: async () => {
          stepsOf(threadId).push('agent');
          await built.dispose();
          if (fault.agentDispose !== undefined) throw fault.agentDispose;
        },
      };
    },
  });
  return { handler, stepsOf };
}

/** 讀一條 thread 的歷史：不用跑模型就把 thread 組起來的最短路。 */
async function touch(handler: ReturnType<typeof createWireHandler>, thread: string): Promise<void> {
  const response = await handler.handle(
    loopbackRequest(`${BASE}${historyPath(thread)}`, {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
    }),
  );
  expect(await response.text()).not.toContain('error');
}

async function closeError(handler: ReturnType<typeof createWireHandler>): Promise<AggregateError> {
  const error: unknown = await handler.close().then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AggregateError);
  return error as AggregateError;
}

describe('serve 關機時 thread 收尾一份失敗、其餘照收（#1511）', () => {
  it('落盤收尾拋錯：close() 拒絕成 AggregateError，指名 thread 與原因；agent 的 dispose 照跑；另一條 thread 也收完', async () => {
    const { handler, stepsOf } = build(
      new Map([['bad', { persistenceDispose: new Error('磁碟滿了') }]]),
    );
    await touch(handler, 'bad');
    await touch(handler, 'good');

    const error = await closeError(handler);

    expect(error.errors).toHaveLength(1);
    expect(error.message).toContain('thread "bad"');
    expect(error.message).toContain('磁碟滿了');
    expect(error.message).not.toContain('thread "good"');
    // 落盤失敗不擋 agent：MCP 子行程在它底下。
    expect(stepsOf('bad')).toEqual(['detach', 'persistence', 'agent']);
    expect(stepsOf('good')).toEqual(['detach', 'persistence', 'agent']);
  });

  it('前一步（會話接線）拋錯：落盤照樣有跑，agent 也收了，原因寫進 message', async () => {
    const { handler, stepsOf } = build(new Map([['x', { detach: new Error('接線拆不掉') }]]));
    await touch(handler, 'x');

    const error = await closeError(handler);

    expect(error.message).toContain('thread "x"');
    expect(error.message).toContain('接線拆不掉');
    expect(stepsOf('x')).toEqual(['detach', 'persistence', 'agent']);
  });

  it('同一條 thread 兩步都失敗：兩個原因都在 message 裡；兩條 thread 都失敗：兩個 thread id 都在', async () => {
    const { handler } = build(
      new Map([
        [
          'a',
          { persistenceDispose: new Error('磁碟滿了'), agentDispose: new Error('子行程收不掉') },
        ],
        ['b', { detach: new Error('接線拆不掉') }],
      ]),
    );
    await touch(handler, 'a');
    await touch(handler, 'b');

    const error = await closeError(handler);

    expect(error.errors).toHaveLength(2);
    for (const text of ['thread "a"', 'thread "b"', '磁碟滿了', '子行程收不掉', '接線拆不掉']) {
      expect(error.message).toContain(text);
    }
  });

  it('沒有失敗就照常 resolve', async () => {
    const { handler, stepsOf } = build();
    await touch(handler, 'ok');
    await expect(handler.close()).resolves.toBeUndefined();
    expect(stepsOf('ok')).toEqual(['detach', 'persistence', 'agent']);
  });
});
