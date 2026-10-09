/**
 * `thread.rename`（[#633](https://github.com/DemianLi/nexus-agent/issues/633) 第二張）：wire 這一層。
 *
 * 照 dsh `SessionController.rename`：標題正規化、追加成這條會話日誌上的一顆 `session/title`（`source: user`，釘住），
 * 回受理後的標題與事件的 `seq`；正規化完是空的 → `title_invalid`；不存在 → `thread_not_found`。
 * 打進線上的字、列表上的字、重啟之後還在的部分在 `serve-thread-rename.test.ts`（真 `runServe`、真落盤）。
 *
 * **零憑證、零外部連線**：沒有 agent，只要這條 thread 活著。
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { SessionRegistry } from '@nexus/core';
import { createWireClient } from '@nexus/wire';
import type { Event } from '@nexus/wire';

import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { WireHandler } from './wire-handler.js';

const opened: WireHandler[] = [];

afterEach(async () => {
  for (const handler of opened.splice(0)) await handler.close();
});

type HandlerOptions = Parameters<typeof createWireHandler>[0];

function rig(options: Partial<Omit<HandlerOptions, 'auth'>> = {}) {
  let sessions: SessionRegistry | undefined;
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async () => ({
      agent: {} as PumpAgent,
      commands: emptyCommandPoint(),
      dispose: async () => {},
      attachSessions: (registry) => {
        sessions = registry;
        return { detach: async () => {} };
      },
    }),
    ...options,
  });
  opened.push(handler);
  const fetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
    handler.handle(loopbackRequest(input as string, init));
  const client = createWireClient({ baseUrl: 'http://rename.test', fetch });
  let nextId = 1;
  const raw = async (thread: string, method: string, params?: unknown) => {
    const response = await fetch(`http://rename.test/threads/${thread}/commands/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: nextId++, method, ...(params !== undefined && { params }) }),
    });
    return (await response.json()) as Record<string, unknown>;
  };
  const titles = () => sessions!.root.events.filter((event) => event.type === 'session/title');
  return { client, raw, titles, sessions: () => sessions! };
}

describe('thread.rename', () => {
  it('活著的 thread：標題正規化、追加成 source:user 的 session/title，回標題與那一顆的 seq；線上推同一個標題', async () => {
    const { client, titles } = rig({ storedThreadKnown: async () => false });
    const events = await client.openEvents('t1');

    const reply = await client.threadRename('t1', '  我的  新\u0007名字 ');
    expect(reply.kind).toBe('ok');
    if (reply.kind !== 'ok') return;
    expect(reply.result.ok).toBe(true);
    if (!reply.result.ok) return;
    expect(reply.result.value.title).toBe('我的 新名字');
    const written = titles();
    expect(written).toHaveLength(1);
    expect(written[0]!.seq).toBe(reply.result.value.seq);
    expect(written[0]!.data).toEqual({
      title: '我的 新名字',
      messageSeqs: [],
      source: { kind: 'user' },
    });
    // 線上也看得到（既有的標題推送，latest-wins）：從下行讀到那一顆為止，讀不到就逾時。
    const titlesSeen: string[] = [];
    const deadline = Date.now() + 5000;
    while (!titlesSeen.includes('我的 新名字') && Date.now() < deadline) {
      const next = await events.next();
      if (next.done === true) break;
      const frame: Event = next.value;
      if (frame.method !== 'custom') continue;
      const data = frame.params.data as { name?: string; payload?: { title?: string } };
      if (data.name === 'title' && data.payload?.title !== undefined) {
        titlesSeen.push(data.payload.title);
      }
    }
    expect(titlesSeen).toEqual(['我的 新名字']);
    await events.return?.(undefined);
  });

  it('只在磁碟上的 thread：重開之後改名；再改一次以最後一顆為準', async () => {
    const { client, titles } = rig({ storedThreadKnown: async (id) => id === 'on-disk' });
    expect(await client.threadRename('on-disk', '甲')).toMatchObject({ result: { ok: true } });
    expect(await client.threadRename('on-disk', '乙')).toMatchObject({
      result: { ok: true, value: { title: '乙' } },
    });
    expect(titles().map((event) => event.data.title)).toEqual(['甲', '乙']);
  });

  it('標題正規化完是空的：title_invalid（成功回應裡的業務失敗），日誌沒有新事件', async () => {
    const { client, titles, raw } = rig({ storedThreadKnown: async () => true });
    expect(await client.threadRename('t1', '   \u0007​ ')).toMatchObject({
      kind: 'ok',
      result: { ok: false, error: { code: 'title_invalid' } },
    });
    expect(await client.threadRename('t1', '')).toMatchObject({
      result: { ok: false, error: { code: 'title_invalid' } },
    });
    expect(titles()).toHaveLength(0);
    // title 不是字串是協定層的錯，不是業務失敗。
    expect(await raw('t1', 'thread.rename', { title: 42 })).toMatchObject({
      type: 'error',
      error: 'invalid_argument',
    });
    expect(await raw('t1', 'thread.rename')).toMatchObject({
      type: 'error',
      error: 'invalid_argument',
    });
  });

  it('沒有這條會話：thread_not_found，也沒有為它建 agent', async () => {
    let created = 0;
    const { client } = rig({
      storedThreadKnown: async () => false,
      createAgent: async () => {
        created += 1;
        return {
          agent: {} as PumpAgent,
          commands: emptyCommandPoint(),
          dispose: async () => {},
          attachSessions: () => ({ detach: async () => {} }),
        };
      },
    });
    expect(await client.threadRename('ghost', '名字')).toEqual({
      kind: 'ok',
      result: { ok: false, error: { code: 'thread_not_found' } },
    });
    expect(created).toBe(0);
  });

  it('標題照 maxTitleBytes 截，不切在字的中間', async () => {
    const { client } = rig({
      storedThreadKnown: async () => true,
      threadTitleLimits: { maxWords: 3, maxBytes: 12, maxTitleBytes: 12 },
    });
    expect(await client.threadRename('t1', '一二三四五六七八')).toMatchObject({
      result: { ok: true, value: { title: '一二三四' } },
    });
  });
});
