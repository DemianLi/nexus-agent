/**
 * 嵌入版 thread 的擁有者（[#2370](https://github.com/DemianLi/nexus-agent/issues/2370)）的兩道檢查，各自量：進路由之前看
 * 記憶體裡或冷讀 header 的擁有者（`embedRequestRefusal`），與建好之後再核一次（`threadOrError`）。
 *
 * 走產品的線那幾條在 `serve-embed-owner.test.ts`；第二道只在並行建同一個新 id 時才走得到，serve 排不出那個順序，所以這一檔用
 * 真的 wire handler，身分、`storedAccess` 與 `createAgent` 換成可控的，同 `embed-profile-race.test.ts`。
 */

import { EMBED_PATH_PREFIX, historyPath, THREAD_NOT_OWNED } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import type { ThreadProfile } from './embed-profile.js';
import { mayOpenEmbedThread } from './embed-thread-owner.js';
import type { EmbedThreadOwner } from './embed-thread-owner.js';
import { emptyCommandPoint, loopbackRequest } from './fixtures.js';
import { PrunedMemorySaver } from './pruned-memory-saver.js';
import { ScriptedChatModel } from './scripted-model.js';
import { composeAttachSessions } from './session-attach.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { ThreadAgent } from './wire-handler.js';
import { OWNER_PRINCIPAL } from './wire-principal.js';
import type { EmbedPrincipal, WirePrincipal } from './wire-principal.js';

const BASE = 'http://embed-owner.test';

function embed(embedder: string, userId: string, session = 's'): EmbedPrincipal {
  return { kind: 'embed', embedder, subject: userId, userId, sessionIdSha256: session };
}

const ALICE = embed('crm', 'u-alice', 'a'.repeat(64));
const BOB = embed('crm', 'u-bob');
const ALICE_FROM_ERP = embed('erp', 'u-alice');
const ALICE_OWNS: EmbedThreadOwner = {
  userId: 'u-alice',
  embedder: 'crm',
  loginSessionSha256: 'a'.repeat(64),
};

/** 請求帶 `x-who` 標頭指名身分：只在這一檔的替身身分驗證裡有意義。 */
const WHO: Readonly<Record<string, WirePrincipal>> = {
  owner: OWNER_PRINCIPAL,
  alice: ALICE,
  bob: BOB,
  'alice-erp': ALICE_FROM_ERP,
};

async function realAgent(
  profile: ThreadProfile | undefined,
  owner: EmbedThreadOwner | undefined,
): Promise<ThreadAgent> {
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
    ...(owner === undefined ? {} : { owner }),
  };
}

type Stored = { readonly profile: ThreadProfile; readonly owner?: EmbedThreadOwner } | undefined;

/**
 * @param stored - 冷讀 header 讀到什麼（`undefined`：磁碟上沒有）。`createAgent` 照 serve 的規則：落盤過的照 header，新的記開它的人。
 */
function rig(stored: (threadId: string) => Promise<Stored>): {
  readonly handler: ReturnType<typeof createWireHandler>;
  /** 每次建 agent 的 id 與記下的擁有者。 */
  readonly built: { readonly threadId: string; readonly owner?: EmbedThreadOwner }[];
} {
  const built: { readonly threadId: string; readonly owner?: EmbedThreadOwner }[] = [];
  const handler = createWireHandler({
    auth: { authenticate: (headers) => WHO[headers.get('x-who') ?? 'owner'] },
    createAgent: async (threadId, _fork, profile, requestedOwner) => {
      const onDisk = await stored(threadId).catch(() => undefined);
      const owner = onDisk === undefined ? requestedOwner : onDisk.owner;
      built.push({ threadId, ...(owner !== undefined && { owner }) });
      return realAgent(onDisk?.profile ?? profile, owner);
    },
    storedAccess: stored,
  });
  return { handler, built };
}

/** 讀歷史：會經 `threadOrError`，不必跑模型。 */
async function history(
  handler: ReturnType<typeof createWireHandler>,
  who: string,
  thread: string,
  prefix = EMBED_PATH_PREFIX,
): Promise<{ readonly type: string; readonly error?: string }> {
  const response = await handler.handle(
    loopbackRequest(`${BASE}${prefix}${historyPath(thread)}`, {
      method: 'GET',
      headers: { 'content-type': 'application/json', 'x-who': who },
    }),
  );
  return (await response.json()) as { readonly type: string; readonly error?: string };
}

const notOwned = { type: 'error', error: THREAD_NOT_OWNED };

describe('冷讀 header 那一道（進路由之前）', () => {
  it('磁碟上是別人的：拒，不為它建 agent；同使用者代號換嵌入方也拒', async () => {
    const { handler, built } = rig(async () => ({ profile: 'embed', owner: ALICE_OWNS }));
    expect(await history(handler, 'bob', 'e1')).toMatchObject(notOwned);
    expect(await history(handler, 'alice-erp', 'e1')).toMatchObject(notOwned);
    expect(built).toEqual([]);
    expect((await history(handler, 'alice', 'e1')).type).toBe('success');
    expect(built).toEqual([{ threadId: 'e1', owner: ALICE_OWNS }]);
  });

  it('磁碟上是嵌入版但沒有擁有者：嵌入身分一律拒，擁有者打得開', async () => {
    const { handler, built } = rig(async () => ({ profile: 'embed' }));
    expect(await history(handler, 'alice', 'h1')).toMatchObject(notOwned);
    expect(built).toEqual([]);
    expect((await history(handler, 'owner', 'h1')).type).toBe('success');
  });

  it('在記憶體裡的別人的：拒', async () => {
    const { handler } = rig(async () => undefined);
    expect((await history(handler, 'alice', 'e1')).type).toBe('success');
    expect(await history(handler, 'bob', 'e1')).toMatchObject(notOwned);
    expect((await history(handler, 'alice', 'e1')).type).toBe('success');
  });

  it('新開的記開它的嵌入身分；擁有者開的不記', async () => {
    const { handler, built } = rig(async () => undefined);
    expect((await history(handler, 'alice', 'e1')).type).toBe('success');
    expect((await history(handler, 'owner', 'h1')).type).toBe('success');
    expect(built).toEqual([{ threadId: 'e1', owner: ALICE_OWNS }, { threadId: 'h1' }]);
  });
});

describe('建好之後再核那一道', () => {
  it('同一個新 id 被別的嵌入身分搶先建起來：先建的那位擁有它，晚到的拒', async () => {
    let release: () => void = () => undefined;
    let asked: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      asked = resolve;
    });
    let first = true;
    const { handler, built } = rig(() => {
      if (!first) return Promise.resolve(undefined);
      first = false;
      return new Promise((resolve) => {
        release = () => resolve(undefined);
        asked();
      });
    });
    // bob 先到，停在冷讀 header（磁碟上還沒有這條）。
    const late = history(handler, 'bob', 'x');
    await reached;
    expect((await history(handler, 'alice', 'x')).type).toBe('success');
    release();
    expect(await late).toMatchObject(notOwned);
    expect(built).toEqual([{ threadId: 'x', owner: ALICE_OWNS }]);
  });
});

describe('mayOpenEmbedThread', () => {
  it('使用者代號與嵌入方都要對上；登入不同不影響', () => {
    expect(mayOpenEmbedThread(ALICE, ALICE_OWNS)).toBe(true);
    expect(mayOpenEmbedThread(embed('crm', 'u-alice', 'other'), ALICE_OWNS)).toBe(true);
    expect(mayOpenEmbedThread(BOB, ALICE_OWNS)).toBe(false);
    expect(mayOpenEmbedThread(ALICE_FROM_ERP, ALICE_OWNS)).toBe(false);
    expect(mayOpenEmbedThread(ALICE, undefined)).toBe(false);
    expect(mayOpenEmbedThread(OWNER_PRINCIPAL, undefined)).toBe(true);
  });
});
