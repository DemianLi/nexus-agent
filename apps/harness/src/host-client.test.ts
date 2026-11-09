import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FrameReader, PROTOCOL_VERSION, frame } from '@nexus/host-bridge';
import { describe, expect, it } from 'vitest';

import { connectHost, parseHostSocketArg } from './host-client.js';

describe('parseHostSocketArg', () => {
  it('拆出 --host-socket，其餘照原樣', () => {
    expect(parseHostSocketArg(['--a', '1', '--host-socket', '/r/host.sock', '--b'])).toEqual({
      hostSocket: '/r/host.sock',
      rest: ['--a', '1', '--b'],
    });
  });

  it('沒帶就是沒有宿主', () => {
    expect(parseHostSocketArg(['--a'])).toEqual({ hostSocket: undefined, rest: ['--a'] });
  });

  it.each([[['--host-socket']], [['--host-socket', '--a']]])('少了路徑就拋：%j', (argv) => {
    expect(() => parseHostSocketArg(argv)).toThrow('--host-socket 要一個路徑');
  });
});

describe('connectHost', () => {
  it('沒有 --host-socket 就不連', () => {
    expect(
      connectHost({ hostSocket: undefined, token: 't', log: () => undefined }),
    ).toBeUndefined();
  });

  it('有就用 token 連那個路徑', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-client-'));
    const path = join(dir, 'host.sock');
    const hellos: unknown[] = [];
    const server = createServer((socket) => {
      const reader = new FrameReader();
      socket.on('data', (chunk: Buffer) => {
        for (const payload of reader.push(chunk)) {
          hellos.push(JSON.parse(payload.toString('utf8')));
          socket.write(
            frame(Buffer.from(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION }))),
          );
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    const logs: string[] = [];
    const client = connectHost({ hostSocket: path, token: 'tok', log: (line) => logs.push(line) });
    try {
      expect(await client?.waitReady(5_000)).toBe(true);
      expect(hellos).toEqual([{ type: 'hello', version: PROTOCOL_VERSION, token: 'tok' }]);
      expect(logs).toEqual(['[宿主] 連上了']);
    } finally {
      client?.close();
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
