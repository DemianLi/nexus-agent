/**
 * wire handler 交給內容搜尋的活 thread（[#1599](https://github.com/DemianLi/nexus-agent/issues/1599)）：`liveThreads()` 同步、只讀 `ready`。
 *
 * 這一檔用**真的 wire handler＋真的最小 agent**，`createAgent` 換成可控的閘門（同 `thread-capacity.test.ts`），問的是
 * 「還在建的那一條」：它不在 `liveThreads()` 裡，搜尋不等它組裝、改走冷讀。讀記憶體的對帳在 `thread-search.test.ts`，
 * 產品路徑在 `serve-thread-search.test.ts`。
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AIMessage } from '@langchain/core/messages';
import { SESSION_LOG_FORMAT_VERSION, SessionLog, toLoggedMessage } from '@nexus/core';
import { historyPath } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { openJsonlSessionStore } from './jsonl-session-store.js';
import { PrunedMemorySaver } from './pruned-memory-saver.js';
import { ScriptedChatModel } from './scripted-model.js';
import { composeAttachSessions } from './session-attach.js';
import { ThreadSearch } from './thread-search.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { ThreadAgent } from './wire-handler.js';

const BASE = 'http://live-threads.test';
const CWD = '/專案/甲';

async function realAgent(): Promise<ThreadAgent> {
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
  };
}

/** 照 JSONL 後端的檔名寫一份只有一輪的日誌。 */
async function writeThread(directory: string, id: string, said: string): Promise<void> {
  const log = new SessionLog(id);
  log.append('turn/start', { kind: 'message', text: said });
  log.append('assistant/message', { message: toLoggedMessage(new AIMessage('好')) });
  log.append('turn/end', {});
  await writeFile(
    join(directory, `${id}.header.json`),
    JSON.stringify({ version: SESSION_LOG_FORMAT_VERSION, id, createdAt: 1_000, cwd: CWD }),
  );
  await writeFile(
    join(directory, `${id}.jsonl`),
    log.events.map((event) => `${JSON.stringify(event)}\n`).join(''),
  );
}

describe('liveThreads()（#1599）', () => {
  it('還在建的那一條不算：搜尋不等它組裝，照盤上那份冷讀；建好之後才算活的', async () => {
    const calls: string[] = [];
    let open!: () => void;
    const building = new Promise<void>((resolve) => {
      open = resolve;
    });
    const handler = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      createAgent: async (threadId) => {
        calls.push(threadId);
        if (threadId === 'slow') await building;
        return realAgent();
      },
    });
    const touch = (threadId: string) =>
      handler.handle(
        loopbackRequest(`${BASE}${historyPath(threadId)}`, {
          method: 'GET',
          headers: { 'content-type': 'application/json' },
        }),
      );

    expect((await touch('ready')).status).toBe(200);
    const slow = touch('slow');
    for (let i = 0; i < 200 && calls.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(calls).toEqual(['ready', 'slow']);
    expect(handler.liveThreads().map((thread) => thread.threadId)).toEqual(['ready']);

    const directory = await mkdtemp(join(tmpdir(), 'nexus-live-threads-'));
    await writeThread(directory, 'slow', '盤上那份的暗號');
    const engine = new ThreadSearch({
      cwd: CWD,
      openAt: 'first-search',
      store: openJsonlSessionStore({ directory }),
      liveThreads: () => handler.liveThreads(),
    });
    // 組裝還卡著：搜尋照樣回來，而且讀的是盤上那份。
    const result = await engine.search('盤上那份的暗號');
    expect(result.items.map((item) => item.threadId)).toEqual(['slow']);

    open();
    expect((await slow).status).toBe(200);
    expect(
      handler
        .liveThreads()
        .map((thread) => thread.threadId)
        .sort(),
    ).toEqual(['ready', 'slow']);
    // 沒開落盤：交得出日誌，交不出 header。
    expect(handler.liveThreads().every((thread) => thread.header === undefined)).toBe(true);
    await engine.close();
    await handler.close();
  });

  it('只讀不寫：交出落盤接線給的 header；叫它、拿它來搜，都不排空任何一份日誌', async () => {
    const header = {
      version: SESSION_LOG_FORMAT_VERSION,
      id: 'a',
      createdAt: 1_000,
      cwd: CWD,
    } as const;
    let flushes = 0;
    const handler = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      createAgent: async () => ({
        ...(await realAgent()),
        // 假的落盤接線：註冊表上的排空者與顯式 flush 都數一次。
        attachPersistence: (sessions) => {
          const unflush = sessions.onFlush(() => {
            flushes += 1;
            return Promise.resolve();
          });
          return {
            flush: () => {
              flushes += 1;
              return Promise.resolve();
            },
            dispose: () => {
              unflush();
              return Promise.resolve();
            },
            rootHeader: () => header,
          };
        },
      }),
    });
    const response = await handler.handle(
      loopbackRequest(`${BASE}${historyPath('a')}`, {
        method: 'GET',
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(response.status).toBe(200);
    const before = flushes;

    const [live] = handler.liveThreads();
    expect(live?.threadId).toBe('a');
    expect(live?.header).toBe(header);
    const directory = await mkdtemp(join(tmpdir(), 'nexus-live-threads-'));
    await writeThread(directory, 'a', '盤上那份的話');
    const engine = new ThreadSearch({
      cwd: CWD,
      openAt: 'first-search',
      store: openJsonlSessionStore({ directory }),
      liveThreads: () => handler.liveThreads(),
    });
    await engine.search('盤上那份的話');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(flushes).toBe(before);
    await engine.close();
    await handler.close();
  });
});
