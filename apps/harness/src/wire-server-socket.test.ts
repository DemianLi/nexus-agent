/**
 * 聽 Unix socket（[#2338](https://github.com/DemianLi/nexus-agent/issues/2338)）：對話行程不綁 port，前台經 socket 連進來。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WireHandler } from './wire-handler.js';
import { startWireServer } from './wire-server.js';
import type { WireServer } from './wire-server.js';

let running: WireServer | undefined;
let directory: string | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

/** 把收到的 `Request` 原樣講回去：網址與 Host。 */
const echo: WireHandler = {
  handle: async (request) => Response.json({ url: request.url, host: request.headers.get('host') }),
  close: async () => undefined,
};

function get(socketPath: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ socketPath, path }, (incoming) => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk: string) => (body += chunk));
      incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, body }));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

describe('startWireServer 的 socketPath', () => {
  it('請求的網址拼在 http://localhost 上，路徑與 query 照收', async () => {
    directory = await mkdtemp(join(tmpdir(), 'wire-socket-'));
    const socketPath = join(directory, 'wire.sock');
    running = await startWireServer({ handler: echo, socketPath });

    const response = await get(socketPath, '/threads/t-1/history?limit=2');

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      url: 'http://localhost/threads/t-1/history?limit=2',
      host: 'localhost',
    });
    expect(running.url).toBe('http://localhost');
  });
});
