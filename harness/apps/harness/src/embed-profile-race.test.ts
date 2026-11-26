/**
 * 嵌入連線碰到不是嵌入版開的 thread（[#2367](https://github.com/DemianLi/nexus-agent/issues/2367)）的兩道防線，各自量：
 * 進路由之前看設定檔（`embedRequestRefusal`），與建好之後再核一次（`threadOrError`）。header 讀不了（#2385）也在第一道就拒。
 *
 * 走產品的線那幾條在 `embed-profile.test.ts`；第二道只在並行建同一個新 id 時才走得到，serve 排不出那個順序，所以這一檔用
 * 真的 wire handler、`storedAccess` 與 `createAgent` 換成可控的閘，同 `thread-capacity.test.ts`。
 */

import { EMBED_PATH_PREFIX, historyPath, THREAD_NOT_EMBEDDED } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import type { ThreadProfile } from './embed-profile.js';
import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { PrunedMemorySaver } from './pruned-memory-saver.js';
import { ScriptedChatModel } from './scripted-model.js';
import { composeAttachSessions } from './session-attach.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { ThreadAgent } from './wire-handler.js';

const BASE = 'http://embed-race.test';

async function realAgent(profile: ThreadProfile | undefined): Promise<ThreadAgent> {
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns: [{ content: '好' }] }),
    checkpointer: new PrunedMemorySaver(),
    plugins: [],
  });
  return {
    agent: built.agent as unknown as PumpAgent,
    commands: emptyCommandPoint(),
    attachSessions: composeAttachSessions(built),
    dispose: built.dispose,
    ...(profile === undefined ? {} : { profile }),
  };
}

function rig(storedProfile: (threadId: string) => Promise<ThreadProfile | undefined>): {
  readonly handler: ReturnType<typeof createWireHandler>;
  readonly built: string[];
} {
  const built: string[] = [];
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async (threadId, _fork, profile) => {
      built.push(threadId);
      return realAgent(profile);
    },
    storedAccess: async (threadId) => {
      const profile = await storedProfile(threadId);
      return profile === undefined ? undefined : { profile };
    },
  });
  return { handler, built };
}

/** 讀歷史：會經 `threadOrError`，不必跑模型。 */
async function history(
  handler: ReturnType<typeof createWireHandler>,
  thread: string,
  prefix = '',
): Promise<{ readonly type: string; readonly error?: string }> {
  const response = await handler.handle(
    loopbackRequest(`${BASE}${prefix}${historyPath(thread)}`, {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
    }),
  );
  return (await response.json()) as { readonly type: string; readonly error?: string };
}

describe('嵌入連線碰非嵌入版的 thread（#2367）', () => {
  it('磁碟上是獨立頁面開的：進路由前就拒，不為它建 agent', async () => {
    const { handler, built } = rig(async () => 'full');
    expect(await history(handler, 'f1', EMBED_PATH_PREFIX)).toMatchObject({
      type: 'error',
      error: THREAD_NOT_EMBEDDED,
    });
    expect(built).toEqual([]);
  });

  it('header 讀不了：進路由前就拒，回建不起來的碼，不為它建 agent（#2385）', async () => {
    const { handler, built } = rig(async () => {
      throw new Error('header 壞了');
    });
    expect(await history(handler, 'b1', EMBED_PATH_PREFIX)).toMatchObject({
      type: 'error',
      error: 'unknown_error',
    });
    expect(built).toEqual([]);
  });

  it('同一個新 id 被獨立頁面搶先建起來：建好之後再核一次，照樣拒', async () => {
    let release: (profile: ThreadProfile | undefined) => void = () => undefined;
    let asked: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      asked = resolve;
    });
    const { handler, built } = rig(
      () =>
        new Promise((resolve) => {
          release = resolve;
          asked();
        }),
    );
    // 嵌入連線先到，停在冷讀 header（磁碟上還沒有這條）。
    const embedded = history(handler, 'x', EMBED_PATH_PREFIX);
    await reached;
    // 這時獨立頁面把同一個 id 建成 full。
    expect((await history(handler, 'x')).type).toBe('success');
    release(undefined);
    expect(await embedded).toMatchObject({ type: 'error', error: THREAD_NOT_EMBEDDED });
    expect(built).toEqual(['x']);
  });
});
