import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  FrameReader,
  HOST_ERROR_CODES,
  HostProtocolError,
  MAX_DEPTH,
  MAX_FRAME,
  MAX_ID,
  PROTOCOL_VERSION,
  decodeHostMessage,
  encodeClientMessage,
  frame,
  type ClientMessage,
  type HostMessage,
} from './protocol.js';

interface Vectors {
  readonly protocolVersion: number;
  readonly maxFrame: number;
  readonly maxId: number;
  readonly maxDepth: number;
  readonly errorCodes: readonly string[];
  readonly invalidHostMessages: readonly {
    readonly name: string;
    readonly json: string;
    readonly error: string;
  }[];
  readonly clientMessages: readonly { readonly value: ClientMessage; readonly json: string }[];
  readonly hostMessages: readonly { readonly value: HostMessage; readonly json: string }[];
  readonly duplicateKeys: readonly { readonly value: ClientMessage; readonly json: string }[];
  readonly invalidFrames: readonly {
    readonly name: string;
    readonly hex: string;
    readonly expect: 'error' | 'wait';
  }[];
}

const vectors = JSON.parse(
  readFileSync(
    new URL('../../../native/sandbox-spawner/host-vectors.json', import.meta.url),
    'utf8',
  ),
) as Vectors;

describe('宿主協定，跟 host_protocol.rs 對同一份向量檔', () => {
  it('版本與框長上限相同', () => {
    expect(PROTOCOL_VERSION).toBe(vectors.protocolVersion);
    expect(MAX_FRAME).toBe(vectors.maxFrame);
    expect(MAX_ID).toBe(vectors.maxId);
    expect(MAX_DEPTH).toBe(vectors.maxDepth);
    expect(HOST_ERROR_CODES).toEqual(vectors.errorCodes);
  });

  it.each(vectors.invalidHostMessages)('宿主的訊息不合：$name', ({ json, error }) => {
    expect(() => decodeHostMessage(Buffer.from(json, 'utf8'))).toThrow(
      new HostProtocolError(error),
    );
  });

  // `side:'h'` 的向量給宿主那一側驗解碼與逐字重編（宿主收到時才判違規）；客戶端的編碼器在送出前就擋下。
  it.each(vectors.clientMessages)('客戶端訊息編出來一字不差：$json', ({ value, json }) => {
    if ('side' in value && value.side === 'h') {
      expect(() => encodeClientMessage(value)).toThrow(HostProtocolError);
    } else {
      expect(encodeClientMessage(value).toString('utf8')).toBe(json);
    }
  });

  it.each(vectors.hostMessages)('解得出宿主的訊息：$json', ({ value, json }) => {
    expect(decodeHostMessage(Buffer.from(json, 'utf8'))).toEqual(value);
  });

  it.each(vectors.duplicateKeys)('重複的鍵跟宿主一樣取後者：$json', ({ value, json }) => {
    expect(JSON.parse(json)).toEqual(value);
  });

  it.each(vectors.invalidFrames)('切框：$name', ({ hex, expect: outcome }) => {
    const reader = new FrameReader();
    const push = () => reader.push(Buffer.from(hex, 'hex'));
    if (outcome === 'error') expect(push).toThrow(HostProtocolError);
    else expect(push()).toEqual([]);
  });
});

describe('decodeHostMessage', () => {
  it.each([
    ['不是 JSON', '{'],
    ['不是物件', '[1]'],
    ['少了 type', '{"version":3}'],
    ['不認得的種類', '{"type":"grant"}'],
    ['多出欄位', '{"type":"hello","version":3,"x":1}'],
    ['版本是負的', '{"type":"hello","version":-1}'],
    ['版本是小數', '{"type":"hello","version":1.5}'],
    ['reason 不是字串', '{"type":"rejected","reason":1}'],
  ])('%s 丟 HostProtocolError', (_name, json) => {
    expect(() => decodeHostMessage(Buffer.from(json, 'utf8'))).toThrow(HostProtocolError);
  });
});

describe('encodeClientMessage 只送宿主解得開的', () => {
  const call = (payload: unknown, id = 1): ClientMessage =>
    ({ type: 'call', side: 'c', id, service: 's', method: 'm', payload }) as ClientMessage;

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
  ])('payload 是 %s 丟 HostProtocolError', (_name, payload) => {
    expect(() => encodeClientMessage(call(payload))).toThrow(HostProtocolError);
  });

  it('小數與超過安全整數的數字照 JSON.stringify 送出', () => {
    const payload = { big: 2 ** 60, half: -0.5, huge: 1e21 };
    expect(encodeClientMessage(call(payload)).toString('utf8')).toBe(
      '{"type":"call","side":"c","id":1,"service":"s","method":"m","payload":{"big":1152921504606847000,"half":-0.5,"huge":1e+21}}',
    );
  });

  it('巢狀的上限連框本身算：payload 最多 MAX_DEPTH - 1 層', () => {
    const nest = (n: number): unknown => (n === 0 ? null : [nest(n - 1)]);
    expect(() => encodeClientMessage(call(nest(MAX_DEPTH - 1)))).not.toThrow();
    expect(() => encodeClientMessage(call(nest(MAX_DEPTH)))).toThrow(
      new HostProtocolError('巢狀太深'),
    );
  });

  it.each<[string, ClientMessage]>([
    ['token', { type: 'hello', version: 4, token: 'a\ud800' }],
    ['service', { type: 'call', side: 'c', id: 1, service: '\udc00', method: 'm', payload: null }],
    ['method', { type: 'call', side: 'c', id: 1, service: 's', method: '\ud800', payload: null }],
  ])('%s 有落單的代理對丟 HostProtocolError', (field, message) => {
    expect(() => encodeClientMessage(message)).toThrow(
      new HostProtocolError(`${field} 有落單的代理對`),
    );
  });

  it("call 與 cancel 的 side 是 'h' 丟 HostProtocolError", () => {
    const error = new HostProtocolError('客戶端送的 side 只能是 c');
    expect(() => encodeClientMessage({ ...call(null), side: 'h' } as ClientMessage)).toThrow(error);
    expect(() => encodeClientMessage({ type: 'cancel', side: 'h', id: 1 })).toThrow(error);
  });

  it('id 要是 0 到 MAX_ID 的整數', () => {
    expect(() => encodeClientMessage(call(null, MAX_ID))).not.toThrow();
    for (const id of [-1, 1.5, MAX_ID + 1]) {
      expect(() => encodeClientMessage(call(null, id))).toThrow(HostProtocolError);
      expect(() => encodeClientMessage({ type: 'cancel', side: 'c', id })).toThrow(
        HostProtocolError,
      );
    }
  });

  it('整框超過 MAX_FRAME 丟，剛好等於收', () => {
    const empty = encodeClientMessage(call('')).length;
    expect(encodeClientMessage(call('x'.repeat(MAX_FRAME - empty))).length).toBe(MAX_FRAME);
    expect(() => encodeClientMessage(call('x'.repeat(MAX_FRAME - empty + 1)))).toThrow(
      HostProtocolError,
    );
  });

  it('成對的代理對照收', () => {
    expect(encodeClientMessage(call('😀')).toString('utf8')).toContain('😀');
  });
});

describe('FrameReader', () => {
  it('一框拆成好幾段送來也湊得齊，一段裡有兩框也都切得出來', () => {
    const one = frame(Buffer.from('{"a":1}'));
    const two = frame(Buffer.from('{"b":2}'));
    const reader = new FrameReader();
    expect(reader.push(one.subarray(0, 3))).toEqual([]);
    expect(reader.push(Buffer.concat([one.subarray(3), two])).map(String)).toEqual([
      '{"a":1}',
      '{"b":2}',
    ]);
  });
});
