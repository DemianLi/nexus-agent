/**
 * 上傳走真的 socket（[#732](https://github.com/DemianLi/nexus-agent/issues/732) 第二張）：Node 轉接層對上傳路由**串流**、
 * 對先收完整份的 JSON 路由套本文上限（照 dsh `client/connection` 的 `requestBodyMode`）。
 *
 * 這一支量的是只有真的 socket 才量得到的東西：位元組是不是真的一路流進儲存、行程記憶體跟不跟著檔案大小漲、
 * 超過上限的 JSON 本文有沒有被擋在讀進記憶體之前。**零憑證、零外部連線**；附件根放 `/var/tmp`。
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';

import { MemorySaver } from '@langchain/langgraph';
import { uploadPath } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { AttachmentStore, attachmentsRootOf } from './attachment-store.js';
import {
  emptyCommandPoint,
  fetchWithCookie,
  noSessions,
  TEST_BROWSER_AUTH,
  testSessionCookie,
} from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import { startWireServer } from './wire-server.js';
import type { WireServer } from './wire-server.js';

const MIB = 1024 * 1024;

let home: string;
let store: AttachmentStore;
let running: WireServer | undefined;

beforeEach(async () => {
  home = await mkdtemp(join('/var/tmp', 'nexus-wire-upload-'));
  store = new AttachmentStore(attachmentsRootOf(home));
});

afterEach(async () => {
  await running?.close();
  running = undefined;
  await rm(home, { recursive: true, force: true });
});

async function serve(options: { maxRequestBodyBytes?: number } = {}): Promise<WireServer> {
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    attachments: store,
    createAgent: async () => {
      const built = await createNexusAgent({
        model: new ScriptedChatModel({ turns: [{ content: '好。' }] }) as never,
        checkpointer: new MemorySaver(),
        plugins: [],
        summarization: false,
        observationPolicy: false,
        attachments: store,
      });
      return {
        agent: built.agent as unknown as PumpAgent,
        attachSessions: noSessions,
        commands: emptyCommandPoint(),
        dispose: built.dispose,
      };
    },
  });
  running = await startWireServer({ handler, ...options });
  return running;
}

/** 帶著這台 server 的會話 cookie 的 fetch。 */
function authed(server: WireServer): typeof globalThis.fetch {
  return fetchWithCookie(testSessionCookie(new URL(server.url).host));
}

/** 一份由同一塊重複 `count` 次組成的本文，**一塊一塊現產**——測試自己不留整份。 */
function repeated(chunk: Uint8Array, count: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= count) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(chunk);
    },
  });
}

function upload(server: WireServer, body: ReadableStream<Uint8Array>, name: string) {
  return authed(server)(`${server.url}${uploadPath('big')}?name=${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body,
    duplex: 'half',
  } as RequestInit);
}

describe('上傳路由串流進儲存', () => {
  it('比 JSON 本文上限大的檔收得下，內容逐位元組對；行程記憶體不跟著檔案漲', async () => {
    const server = await serve({ maxRequestBodyBytes: 4 * MIB });
    const chunk = new Uint8Array(MIB).map((_, index) => (index * 31 + 7) % 251);
    const count = 480; // 480 MiB：是 JSON 本文上限的 120 倍
    const expected = createHash('sha256');
    for (let index = 0; index < count; index += 1) expected.update(chunk);

    // 先上傳一小份：第一個請求會建這條 thread 的 agent，那一次性的記憶體不算進上傳。
    expect((await upload(server, repeated(chunk, 1), 'warm.bin')).status).toBe(200);

    // 取樣期間的 RSS 高點。先跑一次垃圾回收取基線，免得前面測試殘留的東西混進來。
    globalThis.gc?.();
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 10);
    let response: Response;
    try {
      response = await upload(server, repeated(chunk, count), 'big.bin');
    } finally {
      clearInterval(timer);
    }
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      type: string;
      result: { receiptId: string; bytes: number };
    };
    expect(result.type).toBe('success');
    expect(result.result.bytes).toBe(count * MIB);

    const digest = expected.digest('hex');
    const stored = join(store.rootDir, 'files', digest.slice(0, 2), digest, 'big.bin');
    expect((await stat(stored)).size).toBe(count * MIB);

    const growth = (peak - baseline) / MIB;
    // 整份緩衝的話至少漲一整個檔案（480 MiB，再加 `Buffer.concat` 的第二份，近 1 GiB）。串流只該漲在飛的那幾塊與
    // 還沒被回收的垃圾：實測 160 MiB 與 480 MiB 的檔都漲約 80 MiB（有界，不跟檔案大小走）。門檻抓檔案的三成，
    // 離「整份緩衝」遠、離有界的 80 MiB 有餘裕。
    expect(growth, `RSS 漲了 ${growth.toFixed(0)} MiB`).toBeLessThan(count * 0.3);
    expect(await readdir(join(store.rootDir, 'staging'))).toEqual([]);
  }, 60_000);

  it('上傳走一半客戶端斷線：沒有物件、暫存收掉，伺服器還活著', async () => {
    const server = await serve();
    const controller = new AbortController();
    const chunk = new Uint8Array(MIB);
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(chunk);
      },
      pull() {
        return new Promise(() => undefined); // 之後什麼都不給：模擬傳到一半卡住
      },
    });
    const pending = authed(server)(`${server.url}${uploadPath('cut')}?name=cut.bin`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body,
      duplex: 'half',
      signal: controller.signal,
    } as RequestInit).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    await pending;
    // 儲存那端要看到斷線並收尾；給它一點時間。
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await readdir(join(store.rootDir, 'staging'))).length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await readdir(join(store.rootDir, 'staging'))).toEqual([]);
    expect(await readdir(join(store.rootDir, 'file-objects'))).toEqual([]);
    const alive = await authed(server)(`${server.url}/threads`, {
      headers: { 'content-type': 'application/json' },
    });
    expect(alive.status).toBe(200);
  });

  it('本文還沒讀完就被拒（錯的 content-type）：回 415 並斷線，不把殘餘當下一個請求', async () => {
    const server = await serve();
    const response = await authed(server)(`${server.url}${uploadPath('bad')}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: repeated(new Uint8Array(MIB), 8),
      duplex: 'half',
    } as RequestInit).catch((error: unknown) => error);
    // 對方可能在我們回完時還在傳（連線被砍），也可能先收到 415：兩者都不該把伺服器弄壞。
    if (response instanceof Response) {
      expect(response.status).toBe(415);
      expect(response.headers.get('connection')).toBe('close');
    }
    const alive = await authed(server)(`${server.url}/threads`, {
      headers: { 'content-type': 'application/json' },
    });
    expect(alive.status).toBe(200);
  });
});

describe('JSON 路由的本文上限（先收完整份）', () => {
  it('宣告的長度就超過上限：413，一個位元組都不讀進來', async () => {
    const server = await serve({ maxRequestBodyBytes: 1024 });
    const response = await authed(server)(`${server.url}/threads/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'x'.repeat(4096) }),
    });
    expect(response.status).toBe(413);
  });

  it('沒宣告長度（chunked）、累計才超過：一樣 413', async () => {
    const server = await serve({ maxRequestBodyBytes: 1024 });
    const url = new URL(server.url);
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          host: url.hostname,
          port: url.port,
          path: '/threads/search',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'transfer-encoding': 'chunked',
            cookie: testSessionCookie(url.host),
          },
        },
        (reply) => {
          resolve(reply.statusCode ?? 0);
          reply.resume();
        },
      );
      request.on('error', reject);
      request.write('{"query":"');
      request.write('x'.repeat(800));
      request.write('x'.repeat(800));
      request.end('"}');
    });
    expect(status).toBe(413);
  });

  it('上限以內照常收', async () => {
    const server = await serve({ maxRequestBodyBytes: 1024 });
    const response = await authed(server)(`${server.url}/threads/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'x' }),
    });
    expect(response.status).not.toBe(413);
  });
});
