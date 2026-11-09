import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  FrameReader,
  HostProtocolError,
  MAX_FRAME,
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
  readonly clientMessages: readonly { readonly value: ClientMessage; readonly json: string }[];
  readonly hostMessages: readonly { readonly value: HostMessage; readonly json: string }[];
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
  });

  it.each(vectors.clientMessages)('客戶端訊息編出來一字不差：$json', ({ value, json }) => {
    expect(encodeClientMessage(value).toString('utf8')).toBe(json);
  });

  it.each(vectors.hostMessages)('解得出宿主的訊息：$json', ({ value, json }) => {
    expect(decodeHostMessage(Buffer.from(json, 'utf8'))).toEqual(value);
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
