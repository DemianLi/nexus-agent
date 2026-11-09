/**
 * 對話行程的控制面（[#2338](https://github.com/DemianLi/nexus-agent/issues/2338)）：假的 handler、PassThrough 當 stdin／stdout，
 * 監督行程那一側用 `supervisor-protocol.ts` 的編解碼。接真 handler 的閒置條件在 `conversation-idle.test.ts`。
 */

import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConversationControl } from './conversation-control.js';
import type { ControlledHandler } from './conversation-control.js';
import {
  decodeConversationReport,
  encodeConversationCommand,
  frame,
  PROTOCOL_VERSION,
  takeFrames,
} from './supervisor-protocol.js';
import type { ConversationCommand, ConversationReport } from './supervisor-protocol.js';

interface Harness {
  readonly control: ConversationControl;
  readonly input: PassThrough;
  /** 到目前為止 stdout 上的每一則回報，不含一起來就送的 `hello`；呼叫一次就清掉。 */
  reports(): ConversationReport[];
  /** 同 `reports`，含 `hello`。 */
  rawReports(): ConversationReport[];
  send(command: ConversationCommand): void;
  readonly state: { idle: boolean; lastActiveAt: number; ready: boolean };
  readonly opened: string[];
  stopped: number;
  ended: number;
  readonly warnings: string[];
  clock: number;
}

let controls: ConversationControl[] = [];

afterEach(() => {
  for (const control of controls) control.close();
  controls = [];
  vi.useRealTimers();
});

const TOKEN = '00112233445566778899aabbccddeeff';

/** `hello`：先替監督行程送一顆版本相等的 `hello`；預設送。 */
function harness(
  open: (threadId: string) => Promise<void> = async () => undefined,
  hello = true,
): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  let pending: Buffer = Buffer.alloc(0);
  output.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
  });
  const h = {
    input,
    state: { idle: false, lastActiveAt: 0, ready: false },
    opened: [] as string[],
    stopped: 0,
    ended: 0,
    warnings: [] as string[],
    clock: 1_000,
  } as Omit<Harness, 'control' | 'reports' | 'rawReports' | 'send'> & Partial<Harness>;
  const handler: ControlledHandler = {
    idleState: () =>
      h.state!.ready ? { idle: h.state!.idle, lastActiveAt: h.state!.lastActiveAt } : undefined,
    open: async (threadId) => {
      h.opened!.push(threadId);
      await open(threadId);
      h.state!.ready = true;
    },
    stopAdmission: () => {
      h.stopped! += 1;
    },
  };
  const control = new ConversationControl({
    input,
    output,
    handler,
    now: () => h.clock!,
    pollMs: 3_600_000,
    heartbeatMs: 1_000,
    onEnd: () => {
      h.ended! += 1;
    },
    warn: (message) => h.warnings!.push(message),
  });
  controls.push(control);
  const rawReports = (): ConversationReport[] => {
    const { frames, rest } = takeFrames(pending);
    pending = rest;
    return frames.map(decodeConversationReport);
  };
  const send = (command: ConversationCommand) =>
    input.write(frame(encodeConversationCommand(command)));
  if (hello) send({ type: 'hello', version: PROTOCOL_VERSION, token: TOKEN });
  return Object.assign(h, {
    control,
    rawReports,
    reports: () => rawReports().filter((report) => report.type !== 'hello'),
    send,
  }) as Harness;
}

/** 讓 stream 的 'data' 與 `open` 的 promise 都跑完。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function bound(h: Harness, threadId = 't1'): Promise<void> {
  h.control.ready();
  h.send({ type: 'bind', threadId });
  await settle();
  expect(h.reports()).toEqual([{ type: 'ready' }, { type: 'bound', threadId }]);
}

describe('bind', () => {
  it('建起那一條再回 bound；boundThread 從送出 bind 那一刻就是它', async () => {
    let release: () => void = () => undefined;
    const h = harness(() => new Promise((resolve) => (release = resolve)));
    h.control.ready();
    h.send({ type: 'bind', threadId: 't1' });
    await settle();
    expect(h.control.boundThread).toBe('t1');
    expect(h.opened).toEqual(['t1']);
    expect(h.reports()).toEqual([{ type: 'ready' }]);
    release();
    await settle();
    expect(h.reports()).toEqual([{ type: 'bound', threadId: 't1' }]);
  });

  it('建不起來也回 bound、記一行；閒置從失敗那一刻算', async () => {
    const h = harness(async () => {
      throw new Error('日誌太大');
    });
    h.control.ready();
    h.send({ type: 'bind', threadId: 't1' });
    await settle();
    expect(h.reports()).toEqual([{ type: 'ready' }, { type: 'bound', threadId: 't1' }]);
    expect(h.warnings).toEqual([expect.stringContaining('日誌太大')]);
    h.clock += 500;
    h.control.checkIdle();
    expect(h.reports()).toEqual([{ type: 'idle', idleMs: 500 }]);
  });

  it('已綁了：同一條再回一次 bound，別條不改綁、記一行', async () => {
    const h = harness();
    await bound(h);
    h.send({ type: 'bind', threadId: 't1' });
    h.send({ type: 'bind', threadId: 't2' });
    await settle();
    expect(h.reports()).toEqual([{ type: 'bound', threadId: 't1' }]);
    expect(h.control.boundThread).toBe('t1');
    expect(h.opened).toEqual(['t1']);
    expect(h.warnings).toEqual([expect.stringContaining('不改綁 "t2"')]);
  });
});

describe('閒置回報', () => {
  it('沒綁、還在建：不回報', async () => {
    let release: () => void = () => undefined;
    const h = harness(() => new Promise((resolve) => (release = resolve)));
    h.control.ready();
    h.control.checkIdle();
    h.send({ type: 'bind', threadId: 't1' });
    await settle();
    h.control.checkIdle();
    expect(h.reports()).toEqual([{ type: 'ready' }]);
    release();
  });

  it('變成閒置送 idle（帶已經閒了多久），一直閒著不重送；不閒了送 busy', async () => {
    const h = harness();
    await bound(h);
    h.state.idle = true;
    h.state.lastActiveAt = 400;
    h.control.checkIdle();
    h.clock += 5_000;
    h.control.checkIdle();
    expect(h.reports()).toEqual([{ type: 'idle', idleMs: 600 }]);
    h.state.idle = false;
    h.control.checkIdle();
    h.control.checkIdle();
    expect(h.reports()).toEqual([{ type: 'busy' }]);
  });

  it('閒著的期間最後活動時間往前推了：再送一次 idle，從新的時間點算', async () => {
    const h = harness();
    await bound(h);
    h.state.idle = true;
    h.state.lastActiveAt = 1_000;
    h.control.checkIdle();
    h.clock = 9_000;
    h.state.lastActiveAt = 8_000;
    h.control.checkIdle();
    expect(h.reports()).toEqual([
      { type: 'idle', idleMs: 0 },
      { type: 'idle', idleMs: 1_000 },
    ]);
  });

  it('不閒時不推最後活動時間的條件：閒置從最後一次問到不閒的時間算（同 sweepIdle 的重新計時）', async () => {
    const h = harness();
    await bound(h);
    h.state.lastActiveAt = 1_000;
    h.clock = 5_000;
    h.control.checkIdle();
    h.state.idle = true;
    h.clock = 6_000;
    h.control.checkIdle();
    expect(h.reports()).toEqual([{ type: 'idle', idleMs: 1_000 }]);
  });
});

describe('drain', () => {
  it('仍閒置：停收新的一輪、回 drained', async () => {
    const h = harness();
    await bound(h);
    h.state.idle = true;
    h.send({ type: 'drain' });
    await settle();
    expect(h.reports()).toEqual([{ type: 'drained' }]);
    expect(h.stopped).toBe(1);
  });

  it('不閒了：回 busy、照收', async () => {
    const h = harness();
    await bound(h);
    h.state.idle = true;
    h.control.checkIdle();
    h.state.idle = false;
    h.send({ type: 'drain' });
    await settle();
    expect(h.reports()).toEqual([{ type: 'idle', idleMs: 1_000 }, { type: 'busy' }]);
    expect(h.stopped).toBe(0);
  });
});

describe('一輪', () => {
  it('收到 bind 起每 heartbeatMs 一次心跳，open 還沒完成也送，跨過一輪照送，close 才停', async () => {
    vi.useFakeTimers();
    let finishOpen = (): void => undefined;
    const h = harness(() => new Promise<void>((resolve) => (finishOpen = resolve)));
    h.control.ready();
    h.reports();
    h.send({ type: 'bind', threadId: 't1' });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(h.reports()).toEqual([{ type: 'heartbeat' }]);
    finishOpen();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reports()).toEqual([{ type: 'bound', threadId: 't1' }]);
    h.control.turn('t1', 'begin');
    await vi.advanceTimersByTimeAsync(1_000);
    h.control.turn('t1', 'end');
    await vi.advanceTimersByTimeAsync(1_000);
    h.control.close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(
      h.reports().filter((report) => report.type !== 'idle' && report.type !== 'busy'),
    ).toEqual([
      { type: 'turn', phase: 'begin' },
      { type: 'heartbeat' },
      { type: 'turn', phase: 'end' },
      { type: 'heartbeat' },
    ]);
  });

  it('綁定之前不送心跳', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.control.ready();
    h.reports();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.reports().filter((report) => report.type === 'heartbeat')).toEqual([]);
  });

  it('沒看到開始的結束、別條 thread 的邊緣：不送', async () => {
    const h = harness();
    await bound(h);
    h.control.turn('t1', 'end');
    h.control.turn('t2', 'begin');
    expect(h.reports()).toEqual([]);
  });
});

describe('stdin', () => {
  it('EOF 叫 onEnd 一次', async () => {
    const h = harness();
    h.input.end();
    await settle();
    expect(h.ended).toBe(1);
  });

  it('解不開的框當成 EOF、記一行，之後的框不理', async () => {
    const h = harness();
    h.control.ready();
    h.input.write(frame(Buffer.from([0x7f])));
    h.send({ type: 'bind', threadId: 't1' });
    await settle();
    expect(h.ended).toBe(1);
    expect(h.warnings).toEqual([expect.stringContaining('讀不懂')]);
    expect(h.reports()).toEqual([{ type: 'ready' }]);
  });

  it('一個框拆成兩段送到也收得齊', async () => {
    const h = harness();
    h.control.ready();
    const bytes = frame(encodeConversationCommand({ type: 'bind', threadId: '長一點的-thread' }));
    h.input.write(bytes.subarray(0, 3));
    await settle();
    h.input.write(bytes.subarray(3));
    await settle();
    expect(h.reports()).toEqual([
      { type: 'ready' },
      { type: 'bound', threadId: '長一點的-thread' },
    ]);
  });
});

describe('hello', () => {
  it('一建構就先送自己的 hello；監督行程的 hello 帶來 token，之後照常 bind', async () => {
    const h = harness(undefined, false);
    await settle();
    expect(h.rawReports()).toEqual([{ type: 'hello', version: PROTOCOL_VERSION }]);
    expect(h.control.hostToken).toBeUndefined();
    h.send({ type: 'hello', version: PROTOCOL_VERSION, token: TOKEN });
    await settle();
    expect(h.control.hostToken).toBe(TOKEN);
    await bound(h);
  });

  it.each<[string, ConversationCommand]>([
    ['不是 hello', { type: 'bind', threadId: 't1' }],
    ['版本不對', { type: 'hello', version: PROTOCOL_VERSION + 1, token: TOKEN }],
  ])('第一框%s：當成解不開的框，結束、記一行，之後的框不理', async (_name, first) => {
    const h = harness(undefined, false);
    h.control.ready();
    h.send(first);
    h.send({ type: 'hello', version: PROTOCOL_VERSION, token: TOKEN });
    h.send({ type: 'bind', threadId: 't1' });
    await settle();
    expect(h.ended).toBe(1);
    expect(h.opened).toEqual([]);
    expect(h.control.hostToken).toBeUndefined();
    expect(h.warnings).toEqual([expect.stringContaining('第一框要是版本')]);
  });

  it('之後又來的 hello 不換 token、記一行', async () => {
    const h = harness();
    h.send({ type: 'hello', version: PROTOCOL_VERSION, token: 'ffeeddccbbaa99887766554433221100' });
    await settle();
    expect(h.control.hostToken).toBe(TOKEN);
    expect(h.warnings).toEqual([expect.stringContaining('又送了一次 hello')]);
  });
});
