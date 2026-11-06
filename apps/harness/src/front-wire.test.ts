/**
 * 前台的轉送與嵌入版的兩道檢查（#2341）。對話行程換成 Unix socket 上的假 HTTP 伺服器、監督行程換成記憶體裡的控制通道，
 * 轉送器與 `createFrontWireHandler` 是真的：`per-thread.integration.test.ts` 在沒有監督行程執行檔的機器上跳過，這一支照樣跑。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import type { AccessRecord, StreamRecord } from './embed-audit.js';
import type { EmbedCookieVerdict } from './embed-session.js';
import {
  EMBED_REFUSED_HEADER,
  forwardedPrincipal,
  PRINCIPAL_HEADER,
} from './forwarded-principal.js';
import { FrontForwarder } from './front-forward.js';
import { createFrontWireHandler } from './front-wire.js';
import { SupervisorClient } from './supervisor-client.js';
import { decodeFrontRequest, encodeFrontEvent, frame, takeFrames } from './supervisor-protocol.js';
import type { IdleSweepingWireHandler } from './wire-handler.js';
import type { EmbedPrincipal } from './wire-principal.js';

const ALICE: EmbedPrincipal = {
  kind: 'embed',
  embedder: 'crm',
  subject: 'alice',
  userId: 'u-alice',
  sessionIdSha256: 'a'.repeat(64),
};

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 假的對話行程：`handle` 決定怎麼回；每個請求的標頭與連線關掉的時刻都記下來。 */
async function conversation(handle: (request: IncomingMessage, response: ServerResponse) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'front-wire-'));
  const socket = join(dir, 'c.sock');
  const seen: IncomingMessage[] = [];
  const closed: string[] = [];
  const server = createServer((request, response) => {
    seen.push(request);
    request.socket.once('close', () => closed.push(request.url ?? ''));
    handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return { socket, seen, closed };
}

/** 監督行程那一端：每個 `ensure` 都回同一個 socket 的 `up`。 */
function supervisorAnswering(socket: string): SupervisorClient {
  const input = new PassThrough();
  const output = new PassThrough();
  let pending = Buffer.alloc(0);
  output.on('data', (chunk: Buffer) => {
    const taken = takeFrames(Buffer.concat([pending, chunk]));
    pending = Buffer.from(taken.rest);
    for (const payload of taken.frames) {
      const request = decodeFrontRequest(payload);
      if (request.type === 'ensure') {
        input.write(frame(encodeFrontEvent({ type: 'up', threadId: request.threadId, socket })));
      }
    }
  });
  const client = new SupervisorClient({ input, output });
  cleanups.push(() => {
    input.end();
  });
  return client;
}

function front(socket: string, verdict: () => EmbedCookieVerdict) {
  const streams: StreamRecord[] = [];
  const access: AccessRecord[] = [];
  const forwarder = new FrontForwarder();
  cleanups.push(() => forwarder.close());
  const local = {
    admit: () => undefined,
    embedRefusal: async () => undefined,
    handle: async () => new Response('local', { status: 418 }),
    close: async () => {},
  } as unknown as IdleSweepingWireHandler;
  const handler = createFrontWireHandler({
    local,
    supervisor: supervisorAnswering(socket),
    forwarder,
    auth: { authenticate: () => ALICE },
    embedStreams: {
      recheck: verdict,
      intervalMs: 20,
      audit: () => ({
        recordStream: async (record) => {
          streams.push(record);
        },
        recordAccess: async (record) => {
          access.push(record);
        },
      }),
    },
  });
  return { handler, streams, access };
}

describe('createFrontWireHandler 的嵌入版', () => {
  it('身分放進內部標頭往下傳；對話行程拒絕帶回的原因記成 access，轉給客戶端前刪掉', async () => {
    const upstream = await conversation((_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        [EMBED_REFUSED_HEADER]: 'thread_not_owned',
      });
      response.end('{"type":"error"}');
    });
    const { handler, access } = front(upstream.socket, () => ({ ok: true, principal: ALICE }));
    const response = await handler.handle(
      new Request('http://nexus.test/embed/threads/t1/history', {
        headers: { cookie: 'nexus_embed=x', [PRINCIPAL_HEADER]: 'forged' },
      }),
    );
    expect(response.headers.get(EMBED_REFUSED_HEADER)).toBeNull();
    expect(upstream.seen[0]?.headers.cookie).toBeUndefined();
    const forwarded = new Headers(upstream.seen[0]?.headers as Record<string, string>);
    expect(forwarded.get(PRINCIPAL_HEADER)).not.toBe('forged');
    expect(forwardedPrincipal(forwarded)).toEqual(ALICE);
    expect(access).toEqual([
      expect.objectContaining({
        outcome: 'refused',
        subject: 'alice',
        threadId: 't1',
        route: 'history',
        reason: 'thread_not_owned',
      }),
    ]);
  });

  it('轉送中的下行重驗沒過：2 秒內切掉、往對話行程的連線一起斷，稽核記 opened 與 cut', async () => {
    const upstream = await conversation((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': connected\n\n');
    });
    let verdict: EmbedCookieVerdict = { ok: true, principal: ALICE };
    const { handler, streams } = front(upstream.socket, () => verdict);
    const response = await handler.handle(
      new Request('http://nexus.test/embed/threads/t1/stream', {
        method: 'POST',
        headers: { cookie: 'nexus_embed=x', 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(': connected\n\n');
    expect(streams.map(({ outcome }) => outcome)).toEqual(['opened']);

    verdict = { ok: false, reason: 'not_mapped' };
    const revokedAt = Date.now();
    await expect(reader.read()).rejects.toThrow('not_mapped');
    expect(Date.now() - revokedAt).toBeLessThan(2000);
    expect(streams.map(({ outcome }) => outcome)).toEqual(['opened', 'cut']);
    expect(streams[1]).toMatchObject({ reason: 'not_mapped', threadId: 't1' });
    await expect.poll(() => upstream.closed).toEqual(['/embed/threads/t1/stream']);
  });
});
