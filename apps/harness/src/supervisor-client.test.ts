import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { SupervisorClient, SupervisorGoneError } from './supervisor-client.js';
import {
  decodeFrontRequest,
  encodeFrontEvent,
  frame,
  takeFrames,
  type DeathCause,
  type FrontEvent,
  type FrontRequest,
} from './supervisor-protocol.js';

function harness(onDown?: (threadId: string, cause: DeathCause, socket?: string) => void) {
  const input = new PassThrough();
  const output = new PassThrough();
  let pending = Buffer.alloc(0);
  const sent: FrontRequest[] = [];
  output.on('data', (chunk: Buffer) => {
    const taken = takeFrames(Buffer.concat([pending, chunk]));
    pending = Buffer.from(taken.rest);
    for (const payload of taken.frames) sent.push(decodeFrontRequest(payload));
  });
  const client = new SupervisorClient({ input, output, ...(onDown && { onDown }) });
  return {
    client,
    sent,
    emit(event: FrontEvent) {
      input.write(frame(encodeFrontEvent(event)));
    },
    end() {
      input.end();
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('SupervisorClient', () => {
  it('ensure 送出要求，up 回來就了結並記進行程表', async () => {
    const h = harness();
    const ensured = h.client.ensure('t1', 'run');
    await tick();
    expect(h.sent).toEqual([{ type: 'ensure', threadId: 't1', open: 'run' }]);
    h.emit({ type: 'up', threadId: 't1', socket: '/run/c1.sock' });
    await expect(ensured).resolves.toEqual({ type: 'up', socket: '/run/c1.sock' });
    expect(h.client.socketOf('t1')).toBe('/run/c1.sock');
  });

  it('同一條 thread 同時等的，一則回答全部了結；run 升級只多送一次', async () => {
    const h = harness();
    const a = h.client.ensure('t1', 'read-only');
    const b = h.client.ensure('t1', 'read-only');
    const c = h.client.ensure('t1', 'run');
    const d = h.client.ensure('t1', 'run');
    await tick();
    expect(h.sent).toEqual([
      { type: 'ensure', threadId: 't1', open: 'read-only' },
      { type: 'ensure', threadId: 't1', open: 'run' },
    ]);
    h.emit({ type: 'capacity', threadId: 't1', current: 4, limit: 4 });
    const outcome = { type: 'capacity', current: 4, limit: 4 };
    await expect(Promise.all([a, b, c, d])).resolves.toEqual([outcome, outcome, outcome, outcome]);
  });

  it('down(evicted) 不了結在等的：接著的 up 才是回答', async () => {
    const downs: [string, DeathCause, string | undefined][] = [];
    const h = harness((threadId, cause, socket) => downs.push([threadId, cause, socket]));
    h.emit({ type: 'up', threadId: 't1', socket: '/run/c1.sock' });
    await tick();
    let settled = false;
    const ensured = h.client.ensure('t1', 'run').finally(() => {
      settled = true;
    });
    h.emit({ type: 'down', threadId: 't1', cause: 'evicted' });
    await tick();
    expect(settled).toBe(false);
    expect(h.client.socketOf('t1')).toBeUndefined();
    expect(downs).toEqual([['t1', 'evicted', '/run/c1.sock']]);
    h.emit({ type: 'up', threadId: 't1', socket: '/run/c2.sock' });
    await expect(ensured).resolves.toEqual({ type: 'up', socket: '/run/c2.sock' });
  });

  it('其他死因的 down 了結在等的', async () => {
    const h = harness();
    const ensured = h.client.ensure('t1', 'run');
    h.emit({ type: 'down', threadId: 't1', cause: 'crash' });
    await expect(ensured).resolves.toEqual({ type: 'down', cause: 'crash' });
  });

  it('沒人要的 up（前台重啟後的重建）也進行程表', async () => {
    const h = harness();
    h.emit({ type: 'up', threadId: 'a', socket: '/run/c1.sock' });
    h.emit({ type: 'up', threadId: 'b', socket: '/run/c2.sock' });
    await tick();
    expect(h.client.liveThreads()).toEqual(['a', 'b']);
  });

  it('請求斷了就不等；回答照樣更新行程表', async () => {
    const h = harness();
    const controller = new AbortController();
    const ensured = h.client.ensure('t1', 'run', controller.signal);
    controller.abort(new Error('client gone'));
    await expect(ensured).rejects.toThrow('client gone');
    h.emit({ type: 'up', threadId: 't1', socket: '/run/c1.sock' });
    await tick();
    expect(h.client.socketOf('t1')).toBe('/run/c1.sock');
  });

  it('控制通道斷了：在等的與之後的都丟 SupervisorGoneError', async () => {
    const h = harness();
    const ensured = h.client.ensure('t1', 'run');
    h.end();
    await expect(ensured).rejects.toBeInstanceOf(SupervisorGoneError);
    await expect(h.client.ensure('t2', 'run')).rejects.toBeInstanceOf(SupervisorGoneError);
  });

  it('一框拆成好幾段送來也解得開', async () => {
    const input = new PassThrough();
    const client = new SupervisorClient({ input, output: new PassThrough() });
    const bytes = frame(encodeFrontEvent({ type: 'up', threadId: 't1', socket: '/run/c1.sock' }));
    for (const byte of bytes) input.write(Buffer.from([byte]));
    await tick();
    expect(client.socketOf('t1')).toBe('/run/c1.sock');
  });
});
