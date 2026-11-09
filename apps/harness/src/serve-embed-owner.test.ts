/**
 * 嵌入版 thread 的擁有者（[#2370](https://github.com/DemianLi/nexus-agent/issues/2370)），走產品的線：真的 `runServe`、模型換成腳本，
 * 嵌入身分走真的換票、兌換、嵌入 cookie。兩道檢查的拆開量測在 `embed-thread-owner.test.ts`。
 */

import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConversationState, Event, WireClient } from '@nexus/wire';
import {
  createWireClient,
  EMBED_PATH_PREFIX,
  emptyConversation,
  reduceConversation,
  THREAD_NOT_OWNED,
} from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { sessionIdDigest } from './embed-audit.js';
import { EMBED_IDENTITIES_FILE } from './embed-identities.js';
import { EMBED_EXCHANGE_PATH } from './embed-login.js';
import { EMBED_SESSION_PATH } from './embed-session.js';
import { exchangeServeToken, fetchWithCookie } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';
import { sessionHeaderOf } from './session-files.fixture.js';

const temps: string[] = [];
let served: ScriptedServe | undefined;

afterEach(async () => {
  await served?.close();
  served = undefined;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const EMBEDDERS = [
  '- id: embed-login',
  '  config:',
  '    embedders:',
  '      - id: crm',
  '      - id: erp',
  '',
].join('\n');

/** alice 從 crm 與 erp 都對到同一個使用者代號；bob 是 crm 底下另一個人。 */
const TABLE = {
  version: 1,
  mappings: [
    { embedder: 'crm', subject: 'alice', userId: 'u-alice' },
    { embedder: 'crm', subject: 'bob', userId: 'u-bob' },
    { embedder: 'erp', subject: 'alice-erp', userId: 'u-alice' },
  ],
};

interface Place {
  readonly home: string;
  readonly logs: string;
}

function place(): Place {
  const base = mkdtempSync(join(tmpdir(), 'nexus-embed-owner-'));
  chmodSync(base, 0o700);
  temps.push(base);
  const home = join(base, 'home');
  const logs = join(base, 'logs');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(logs);
  writeFileSync(join(home, EMBED_IDENTITIES_FILE), JSON.stringify(TABLE), { mode: 0o600 });
  return { home, logs };
}

/** 起一台 serve（同一個 `where` 再起就是重啟）。 */
async function start(where: Place): Promise<ScriptedServe> {
  await served?.close();
  served = await startScriptedServe([{ content: '你好。' }], {
    extraRows: EMBEDDERS,
    env: { [HARNESS_HOME_ENV]: where.home },
    argv: ['--session-log', where.logs],
  });
  return served;
}

/** 嵌入方替 `subject` 換票、兌換，交回嵌入 cookie 的 wire client 與兌換的回應本文。 */
async function embedLogin(
  server: ScriptedServe,
  where: Place,
  embedder: string,
  subject: string,
  sessionId: string,
): Promise<{ readonly client: WireClient; readonly redeemed: Record<string, unknown> }> {
  const origin = server.running.url;
  const credential = (
    await readFile(join(where.home, `embed-credential-${embedder}`), 'utf8')
  ).trim();
  const exchanged = await fetch(`${origin}${EMBED_EXCHANGE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
    body: JSON.stringify({ subject, sessionId }),
  });
  expect(exchanged.status).toBe(200);
  const { ticket } = (await exchanged.json()) as { ticket: string };
  const redeemed = await fetch(`${origin}${EMBED_SESSION_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket }),
  });
  expect(redeemed.status).toBe(200);
  const cookie = redeemed.headers.get('set-cookie')!.split(';', 1)[0]!;
  return {
    client: createWireClient({
      baseUrl: `${origin}${EMBED_PATH_PREFIX}`,
      fetch: fetchWithCookie(cookie),
    }),
    redeemed: (await redeemed.json()) as Record<string, unknown>,
  };
}

/** 擁有者（獨立頁面的 cookie）的兩個 client：獨立頁面與嵌入路由。 */
async function hostClients(
  server: ScriptedServe,
): Promise<{ readonly full: WireClient; readonly embed: WireClient }> {
  const fetch = fetchWithCookie(await exchangeServeToken(server.running.authenticatedUrl));
  const origin = server.running.url;
  return {
    full: createWireClient({ baseUrl: origin, fetch }),
    embed: createWireClient({ baseUrl: `${origin}${EMBED_PATH_PREFIX}`, fetch }),
  };
}

/** 說一句話，等這一輪跑完。 */
async function say(client: WireClient, thread: string): Promise<void> {
  const events: AsyncGenerator<Event, void, undefined> = await client.openEvents(thread);
  expect(await client.runStart(thread, '你好')).not.toHaveProperty('error');
  let state: ConversationState = emptyConversation();
  while (!(state.status === 'idle' && state.entries.some((e) => e.kind === 'ai' && !e.streaming))) {
    const next = await events.next();
    if (next.done === true) throw new Error('下行斷了，還沒跑完');
    state = reduceConversation(state, next.value);
  }
  await events.return(undefined);
}

/** 這個 client 打不開 `thread`：送話與讀歷史都回 `thread_not_owned`。 */
async function expectNotOwned(client: WireClient, thread: string): Promise<void> {
  expect(await client.runStart(thread, '接手')).toMatchObject({ error: THREAD_NOT_OWNED });
  expect(await client.threadHistory(thread)).toMatchObject({
    kind: 'rejected',
    code: THREAD_NOT_OWNED,
  });
}

describe('嵌入版 thread 誰開就歸誰（#2370）', () => {
  it('header 記開它的人；同嵌入方的別人、同使用者代號換嵌入方都打不開，在記憶體裡與重啟之後都一樣', async () => {
    const where = place();
    const first = await start(where);
    const alice = await embedLogin(first, where, 'crm', 'alice', 's-alice');
    await say(alice.client, 'e1');

    const { header } = await sessionHeaderOf(where.logs, 'e1');
    expect(header.owner).toEqual({ userId: 'u-alice' });
    expect(header.embedOrigin).toEqual({
      embedder: 'crm',
      loginSessionSha256: sessionIdDigest('s-alice'),
    });

    const bob = await embedLogin(first, where, 'crm', 'bob', 's-bob');
    const aliceFromErp = await embedLogin(first, where, 'erp', 'alice-erp', 's-erp');
    await expectNotOwned(bob.client, 'e1');
    await expectNotOwned(aliceFromErp.client, 'e1');
    // 另一次登入的同一個人打得開。
    const aliceAgain = await embedLogin(first, where, 'crm', 'alice', 's-alice-2');
    expect(await aliceAgain.client.threadHistory('e1')).toMatchObject({ kind: 'ok' });
    // 擁有者打得開任何一條。
    expect(await (await hostClients(first)).full.threadHistory('e1')).toMatchObject({
      kind: 'ok',
    });

    const again = await start(where);
    await expectNotOwned((await embedLogin(again, where, 'crm', 'bob', 's-bob')).client, 'e1');
    await expectNotOwned(
      (await embedLogin(again, where, 'erp', 'alice-erp', 's-erp')).client,
      'e1',
    );
    const aliceAfter = await embedLogin(again, where, 'crm', 'alice', 's-alice');
    expect(await aliceAfter.client.threadHistory('e1')).toMatchObject({ kind: 'ok' });
    // 續接不改 header 的擁有者。
    await say(aliceAfter.client, 'e1');
    expect((await sessionHeaderOf(where.logs, 'e1')).header.owner).toEqual({ userId: 'u-alice' });
  }, 60_000);

  it('擁有者從嵌入路由開的不記擁有者：嵌入身分打不開，擁有者打得開', async () => {
    const where = place();
    const server = await start(where);
    const host = await hostClients(server);
    await say(host.embed, 'h1');
    const { header } = await sessionHeaderOf(where.logs, 'h1');
    expect(header.profile).toBe('embed');
    expect(header).not.toHaveProperty('owner');
    expect(header).not.toHaveProperty('embedOrigin');
    await expectNotOwned((await embedLogin(server, where, 'crm', 'alice', 's-a')).client, 'h1');
    expect(await host.embed.threadHistory('h1')).toMatchObject({ kind: 'ok' });
  }, 60_000);

  it('兌換帶回這一次登入最新開的那一條；換一次登入、換一個人都不帶', async () => {
    const where = place();
    const server = await start(where);
    const first = await embedLogin(server, where, 'crm', 'alice', 's-a');
    expect(first.redeemed).not.toHaveProperty('threadId');
    await say(first.client, 'e1');
    await say(first.client, 'e2');

    expect((await embedLogin(server, where, 'crm', 'alice', 's-a')).redeemed).toMatchObject({
      threadId: 'e2',
    });
    expect((await embedLogin(server, where, 'crm', 'alice', 's-b')).redeemed).not.toHaveProperty(
      'threadId',
    );
    expect((await embedLogin(server, where, 'crm', 'bob', 's-a')).redeemed).not.toHaveProperty(
      'threadId',
    );
  }, 60_000);

  it('身分指紋：同一個人換一次登入、重啟之後都一樣；換人、同使用者代號換嵌入方都不一樣；不露出代號', async () => {
    const where = place();
    const first = await start(where);
    const fingerprint = async (
      server: ScriptedServe,
      embedder: string,
      subject: string,
      sessionId: string,
      at: Place = where,
    ): Promise<unknown> =>
      (await embedLogin(server, at, embedder, subject, sessionId)).redeemed.identityFingerprint;

    const alice = await fingerprint(first, 'crm', 'alice', 's-a');
    expect(alice).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(await fingerprint(first, 'crm', 'alice', 's-b')).toBe(alice);
    expect(await fingerprint(first, 'crm', 'bob', 's-a')).not.toBe(alice);
    expect(await fingerprint(first, 'erp', 'alice-erp', 's-a')).not.toBe(alice);
    for (const exposed of [
      'alice',
      'u-alice',
      createHash('sha256').update('u-alice').digest('base64url'),
    ]) {
      expect(alice).not.toContain(exposed);
    }

    const again = await start(where);
    expect(await fingerprint(again, 'crm', 'alice', 's-c')).toBe(alice);
    // 另一台 serve（另一個 home、另一把密鑰）算出來不一樣。
    const elsewhere = place();
    expect(await fingerprint(await start(elsewhere), 'crm', 'alice', 's-a', elsewhere)).not.toBe(
      alice,
    );
  }, 60_000);
});
