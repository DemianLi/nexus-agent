import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { SupervisorClient, SupervisorGoneError } from './supervisor-client.js';
import {
  decodeFrontRequest,
  encodeFrontEvent,
  frame,
  PROTOCOL_VERSION,
  takeFrames,
  type DeathCause,
  type FrontEvent,
  type FrontRequest,
} from './supervisor-protocol.js';

const TOKEN = '00112233445566778899aabbccddeeff';

interface HarnessOptions {
  readonly onStopAdmission?: () => void;
  /** 先替監督行程送一顆版本相等的 `hello`；預設送。 */
  readonly hello?: boolean;
}

/** `sent` 不含前台一起來就送的那顆 `hello`，`raw` 含。 */
function harness(
  onDown?: (threadId: string, cause: DeathCause, socket?: string) => void,
  options: HarnessOptions = {},
) {
  const input = new PassThrough();
  const output = new PassThrough();
  let pending = Buffer.alloc(0);
  const raw: FrontRequest[] = [];
  const sent: FrontRequest[] = [];
  const warnings: string[] = [];
  output.on('data', (chunk: Buffer) => {
    const taken = takeFrames(Buffer.concat([pending, chunk]));
    pending = Buffer.from(taken.rest);
    for (const payload of taken.frames) {
      const request = decodeFrontRequest(payload);
      raw.push(request);
      if (request.type !== 'hello') sent.push(request);
    }
  });
  const client = new SupervisorClient({
    input,
    output,
    ...(onDown && { onDown }),
    ...(options.onStopAdmission && { onStopAdmission: options.onStopAdmission }),
    warn: (message) => warnings.push(message),
  });
  if (options.hello !== false) {
    input.write(
      frame(encodeFrontEvent({ type: 'hello', version: PROTOCOL_VERSION, token: TOKEN })),
    );
  }
  return {
    client,
    raw,
    sent,
    warnings,
    emit(event: FrontEvent) {
      input.write(frame(encodeFrontEvent(event)));
    },
    emitRaw(bytes: Buffer) {
      input.write(bytes);
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
    const bytes = Buffer.concat([
      frame(encodeFrontEvent({ type: 'hello', version: PROTOCOL_VERSION, token: TOKEN })),
      frame(encodeFrontEvent({ type: 'up', threadId: 't1', socket: '/run/c1.sock' })),
    ]);
    for (const byte of bytes) input.write(Buffer.from([byte]));
    await tick();
    expect(client.hostToken).toBe(TOKEN);
    expect(client.socketOf('t1')).toBe('/run/c1.sock');
  });
});

describe('hello', () => {
  it('一建構就先送自己的 hello；監督行程的 hello 帶來 token', async () => {
    const h = harness(undefined, { hello: false });
    await tick();
    expect(h.raw).toEqual([{ type: 'hello', version: PROTOCOL_VERSION }]);
    expect(h.client.hostToken).toBeUndefined();
    h.emit({ type: 'hello', version: PROTOCOL_VERSION, token: TOKEN });
    await tick();
    expect(h.client.hostToken).toBe(TOKEN);
  });

  it.each<[string, FrontEvent]>([
    ['不是 hello', { type: 'up', threadId: 't1', socket: '/run/c1.sock' }],
    ['版本不對', { type: 'hello', version: PROTOCOL_VERSION + 1, token: TOKEN }],
  ])('第一框%s：控制通道當成斷了', async (_name, first) => {
    const h = harness(undefined, { hello: false });
    const ensured = h.client.ensure('t1', 'run');
    h.emit(first);
    await expect(ensured).rejects.toBeInstanceOf(SupervisorGoneError);
    expect(h.client.socketOf('t1')).toBeUndefined();
    expect(h.client.hostToken).toBeUndefined();
    expect(h.warnings).toEqual([expect.stringContaining('第一框不是')]);
  });

  it('第一框解不開：控制通道當成斷了', async () => {
    const h = harness(undefined, { hello: false });
    const ensured = h.client.ensure('t1', 'run');
    h.emitRaw(frame(Buffer.from([0x7f])));
    await expect(ensured).rejects.toBeInstanceOf(SupervisorGoneError);
    expect(h.warnings).toEqual([expect.stringContaining('第一框解不開')]);
  });

  it('之後又來的 hello 不換 token、記一行', async () => {
    const h = harness();
    h.emit({ type: 'hello', version: PROTOCOL_VERSION, token: 'ffeeddccbbaa99887766554433221100' });
    await tick();
    expect(h.client.hostToken).toBe(TOKEN);
    expect(h.warnings).toEqual([expect.stringContaining('又收到一次 hello')]);
  });
});

describe('stop-admission', () => {
  it('先停收，再回 admission-stopped', async () => {
    const order: string[] = [];
    const h = harness(undefined, { onStopAdmission: () => order.push('stopped') });
    h.emit({ type: 'stop-admission' });
    await tick();
    expect(order).toEqual(['stopped']);
    expect(h.sent).toEqual([{ type: 'admission-stopped' }]);
  });

  it('沒給 onStopAdmission 也照回', async () => {
    const h = harness();
    h.emit({ type: 'stop-admission' });
    await tick();
    expect(h.sent).toEqual([{ type: 'admission-stopped' }]);
  });
});
