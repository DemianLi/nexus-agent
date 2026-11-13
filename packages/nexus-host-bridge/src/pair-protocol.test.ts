import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  PAIR_ATTACH_METHOD,
  PAIR_ENVELOPE_BYTES,
  PAIR_HELLO_TIMEOUT_MS,
  PAIR_STALL_TIMEOUT_MS,
  PAIR_MAX_CALLS,
  PAIR_MAX_CHUNK_BYTES,
  PAIR_MAX_FRAME,
  PAIR_MAX_ID,
  PAIR_OUTBOX_LIMIT_BYTES,
  PAIR_OUTBOX_PAUSE_BYTES,
  PAIR_PROTOCOL_VERSION,
  PairFrameReader,
  PairProtocolError,
  decodePairMessage,
  encodePairMessage,
  type PairMessage,
} from './pair-protocol.js';
import { HOST_ERROR_CODES, MAX_DEPTH, frame } from './protocol.js';

interface Vectors {
  readonly protocolVersion: number;
  readonly maxFrame: number;
  readonly maxId: number;
  readonly maxDepth: number;
  readonly envelopeBytes: number;
  readonly maxChunkBytes: number;
  readonly maxCalls: number;
  readonly helloTimeoutMs: number;
  readonly stallTimeoutMs: number;
  readonly outboxPauseBytes: number;
  readonly outboxLimitBytes: number;
  readonly attachMethod: string;
  readonly messages: readonly { readonly value: PairMessage; readonly json: string }[];
  readonly duplicateKeys: readonly { readonly value: PairMessage; readonly json: string }[];
  readonly invalidFrames: readonly {
    readonly name: string;
    readonly hex: string;
    readonly expect: 'error' | 'wait';
  }[];
  readonly invalidMessages: readonly {
    readonly name: string;
    readonly json: string;
    readonly error: string;
  }[];
  readonly invalidBytes: readonly { readonly name: string; readonly hex: string }[];
}

const read = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../../native/sandbox-spawner/${name}`, import.meta.url), 'utf8'),
  );

const vectors = read('pair-vectors.json') as Vectors;
const hostVectors = read('host-vectors.json') as { readonly errorCodes: readonly string[] };

const decode = (json: string): PairMessage => decodePairMessage(Buffer.from(json, 'utf8'));

describe('橋的協定，跟 pair_protocol.rs 對同一份向量檔', () => {
  it('版本與上限相同', () => {
    expect(PAIR_PROTOCOL_VERSION).toBe(vectors.protocolVersion);
    expect(PAIR_MAX_FRAME).toBe(vectors.maxFrame);
    expect(PAIR_MAX_ID).toBe(vectors.maxId);
    expect(MAX_DEPTH).toBe(vectors.maxDepth);
    expect(PAIR_ENVELOPE_BYTES).toBe(vectors.envelopeBytes);
    expect(PAIR_MAX_CHUNK_BYTES).toBe(vectors.maxChunkBytes);
    expect(PAIR_MAX_CALLS).toBe(vectors.maxCalls);
    expect(PAIR_HELLO_TIMEOUT_MS).toBe(vectors.helloTimeoutMs);
    expect(PAIR_OUTBOX_PAUSE_BYTES).toBe(vectors.outboxPauseBytes);
    expect(PAIR_OUTBOX_LIMIT_BYTES).toBe(vectors.outboxLimitBytes);
    expect(PAIR_STALL_TIMEOUT_MS).toBe(vectors.stallTimeoutMs);
    expect(PAIR_ATTACH_METHOD).toBe(vectors.attachMethod);
  });

  it.each(hostVectors.errorCodes)('錯誤碼是宿主那條的那一組：%s', (code) => {
    const json = `{"type":"result","side":"l","id":1,"error":{"code":"${code}","message":""}}`;
    const message = decode(json);
    expect(message).toMatchObject({ error: { code } });
    expect(encodePairMessage(message).toString('utf8')).toBe(json);
    expect(HOST_ERROR_CODES).toContain(code);
  });

  it.each(vectors.messages)('編出來一字不差、解回來相同：$json', ({ value, json }) => {
    expect(encodePairMessage(value).toString('utf8')).toBe(json);
    expect(decode(json)).toEqual(value);
  });

  it.each(vectors.duplicateKeys)('重複的鍵跟 Rust 一樣取後者：$json', ({ value, json }) => {
    expect(decode(json)).toEqual(value);
  });

  it.each(vectors.invalidMessages)('不合的框：$name', ({ json, error }) => {
    expect(() => decode(json)).toThrow(new PairProtocolError(error));
  });

  it.each(vectors.invalidBytes)('解不開的位元組：$name', ({ hex }) => {
    expect(() => decodePairMessage(Buffer.from(hex, 'hex'))).toThrow(PairProtocolError);
  });

  it.each(vectors.invalidFrames)('切框：$name', ({ hex, expect: outcome }) => {
    const reader = new PairFrameReader();
    const push = () => reader.push(Buffer.from(hex, 'hex'));
    if (outcome === 'error') expect(push).toThrow(PairProtocolError);
    else expect(push()).toEqual([]);
  });
});

describe('一塊的上限', () => {
  const chunk = (payload: string): PairMessage => ({
    type: 'chunk',
    side: 'l',
    id: PAIR_MAX_ID,
    seq: PAIR_MAX_ID,
    payload,
  });

  it.each(['\u0001', '"', 'x', 'é', '😀'])('上限剛好的一塊放得進一框：%j', (unit) => {
    const count = Math.floor(PAIR_MAX_CHUNK_BYTES / Buffer.byteLength(unit, 'utf8'));
    const message = chunk(unit.repeat(count));
    const bytes = encodePairMessage(message);
    expect(bytes.length).toBeLessThanOrEqual(PAIR_MAX_FRAME);
    expect(decodePairMessage(bytes)).toEqual(message);
  });

  it('信封不超過保留的位元組數，最壞是六倍', () => {
    const envelope = encodePairMessage(chunk('')).length;
    expect(envelope).toBeLessThanOrEqual(PAIR_ENVELOPE_BYTES);
    expect(encodePairMessage(chunk('\u0001'.repeat(PAIR_MAX_CHUNK_BYTES))).length).toBe(
      envelope + 6 * PAIR_MAX_CHUNK_BYTES,
    );
  });

  it('多一個位元組就不編也不解', () => {
    const over = 'x'.repeat(PAIR_MAX_CHUNK_BYTES + 1);
    const error = new PairProtocolError('塊太大');
    expect(() => encodePairMessage(chunk(over))).toThrow(error);
    expect(() => decode(JSON.stringify(chunk(over)))).toThrow(error);
    // 以 UTF-8 的位元組數計，不是字元數。
    const wide = 'é'.repeat(PAIR_MAX_CHUNK_BYTES / 2 + 1);
    expect(() => encodePairMessage(chunk(wide))).toThrow(error);
  });
});

describe('encodePairMessage 只送對方解得開的', () => {
  const call = (payload: unknown, id = 1): PairMessage =>
    ({ type: 'call', side: 'l', id, parent: null, method: 'm', payload }) as PairMessage;

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['落單的代理對', '\ud800'],
    ['鍵有落單的代理對', { '\udc00': 1 }],
    ['undefined', { a: undefined }],
    ['bigint', 1n],
    ['函式', () => 1],
    ['Date', new Date(0)],
    ['Map', new Map()],
  ])('payload 是 %s 丟 PairProtocolError', (_name, payload) => {
    expect(() => encodePairMessage(call(payload))).toThrow(PairProtocolError);
  });

  it.each<[string, PairMessage]>([
    ['reason', { type: 'rejected', reason: 'a\ud800' }],
    ['method', { ...call(null), method: '\udc00' } as PairMessage],
    ['tools', { type: 'register', tools: ['\ud800'], hooks: [] }],
    ['chunk', { type: 'chunk', side: 'm', id: 1, seq: 0, payload: '\ud800' }],
    ['message', { type: 'result', side: 'l', id: 1, error: { code: 'busy', message: '\udc00' } }],
  ])('%s 有落單的代理對丟 PairProtocolError', (_field, message) => {
    expect(() => encodePairMessage(message)).toThrow(PairProtocolError);
  });

  it('result 沒有 ok 也沒有 error 丟 PairProtocolError', () => {
    const message = { type: 'result', side: 'l', id: 1 } as unknown as PairMessage;
    expect(() => encodePairMessage(message)).toThrow(PairProtocolError);
  });

  it('巢狀的上限連框本身算：payload 最多 MAX_DEPTH - 1 層', () => {
    const nest = (n: number): unknown => (n === 0 ? null : [nest(n - 1)]);
    expect(() => encodePairMessage(call(nest(MAX_DEPTH - 1)))).not.toThrow();
    expect(() => encodePairMessage(call(nest(MAX_DEPTH)))).toThrow(
      new PairProtocolError('巢狀太深'),
    );
  });

  it("side 只能是 'l' 或 'm'", () => {
    const error = new PairProtocolError('side 要是 l 或 m');
    expect(() => encodePairMessage({ ...call(null), side: 'c' } as unknown as PairMessage)).toThrow(
      error,
    );
    const parent = { id: 1, side: 'h' };
    expect(() => encodePairMessage({ ...call(null), parent } as unknown as PairMessage)).toThrow(
      error,
    );
  });

  it('id 與 seq 要是 0 到 PAIR_MAX_ID 的整數', () => {
    expect(() => encodePairMessage(call(null, PAIR_MAX_ID))).not.toThrow();
    for (const n of [-1, 1.5, PAIR_MAX_ID + 1]) {
      expect(() => encodePairMessage(call(null, n))).toThrow(
        new PairProtocolError('id 不在範圍內'),
      );
      expect(() =>
        encodePairMessage({ type: 'chunk', side: 'l', id: 1, seq: n, payload: '' }),
      ).toThrow(new PairProtocolError('seq 不在範圍內'));
    }
  });

  it('整框超過 PAIR_MAX_FRAME 丟，剛好等於收', () => {
    const empty = encodePairMessage(call('')).length;
    const fits = call('x'.repeat(PAIR_MAX_FRAME - empty));
    expect(encodePairMessage(fits).length).toBe(PAIR_MAX_FRAME);
    expect(() => encodePairMessage(call('x'.repeat(PAIR_MAX_FRAME - empty + 1)))).toThrow(
      PairProtocolError,
    );
  });
});

describe('PairFrameReader', () => {
  it('一框拆成好幾段送來也湊得齊，一段裡有兩框也都切得出來', () => {
    const one = frame(Buffer.from('{"a":1}'));
    const two = frame(Buffer.from('{"b":2}'));
    const reader = new PairFrameReader();
    expect(reader.push(one.subarray(0, 3))).toEqual([]);
    expect(reader.push(Buffer.concat([one.subarray(3), two])).map(String)).toEqual([
      '{"a":1}',
      '{"b":2}',
    ]);
  });

  it('宿主那條的上限以上、橋的上限以內的框照收', () => {
    const payload = Buffer.alloc(PAIR_MAX_FRAME, 0x20);
    expect(new PairFrameReader().push(frame(payload))).toEqual([payload]);
  });
});
