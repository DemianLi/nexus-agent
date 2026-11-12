/**
 * 監督行程控制面的編解碼（#1947）。向量檔與 Rust 端 `supervisor_protocol.rs` 的測試共用：兩邊各自對它編、解，格式一邊改了另一邊就紅。
 * 四組都雙向測，不只測這一側上線用到的方向：對話行程（#2338）與前台（#2341）各只用其中兩支，另外兩支沒人測就會跟 Rust 漂開。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  DEATH_CAUSES,
  PROTOCOL_VERSION,
  SupervisorProtocolError,
  type ConversationCommand,
  type ConversationReport,
  type FrontEvent,
  type FrontRequest,
  decodeConversationCommand,
  decodeConversationReport,
  decodeFrontEvent,
  decodeFrontRequest,
  encodeConversationCommand,
  encodeConversationReport,
  encodeFrontEvent,
  encodeFrontRequest,
} from './supervisor-protocol.js';

interface Vector<T> {
  readonly value: T;
  readonly hex: string;
}

const VECTORS = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../native/sandbox-spawner/supervisor-vectors.json', import.meta.url),
    ),
    'utf8',
  ),
) as {
  protocolVersion: number;
  conversationCommands: Vector<ConversationCommand>[];
  conversationReports: Vector<ConversationReport>[];
  frontRequests: Vector<FrontRequest>[];
  frontEvents: Vector<FrontEvent>[];
};

interface Codec<T extends { readonly type: string }> {
  readonly vectors: readonly Vector<T>[];
  readonly encode: (value: T) => Buffer;
  readonly decode: (payload: Buffer) => T;
  /** 這一組所有的 `type`。型別是從訊息的 union 推的：新增一則訊息沒加進來就編不過，加進來沒寫向量，下面那條就紅。 */
  readonly types: Readonly<Record<T['type'], true>>;
}

type AnyCodec = Codec<{ readonly type: string }>;

const codec = <T extends { readonly type: string }>(c: Codec<T>): AnyCodec =>
  c as unknown as AnyCodec;

const CODECS: Record<string, AnyCodec> = {
  conversationCommands: codec<ConversationCommand>({
    vectors: VECTORS.conversationCommands,
    encode: encodeConversationCommand,
    decode: decodeConversationCommand,
    types: { hello: true, bind: true, drain: true, leaf: true },
  }),
  conversationReports: codec<ConversationReport>({
    vectors: VECTORS.conversationReports,
    encode: encodeConversationReport,
    decode: decodeConversationReport,
    types: {
      hello: true,
      ready: true,
      bound: true,
      turn: true,
      idle: true,
      busy: true,
      heartbeat: true,
      drained: true,
    },
  }),
  frontRequests: codec<FrontRequest>({
    vectors: VECTORS.frontRequests,
    encode: encodeFrontRequest,
    decode: decodeFrontRequest,
    types: { hello: true, ensure: true, release: true, 'admission-stopped': true },
  }),
  frontEvents: codec<FrontEvent>({
    vectors: VECTORS.frontEvents,
    encode: encodeFrontEvent,
    decode: decodeFrontEvent,
    types: {
      hello: true,
      'stop-admission': true,
      up: true,
      down: true,
      capacity: true,
      stats: true,
    },
  }),
};

const cases = Object.entries(CODECS).flatMap(([group, c]) =>
  c.vectors.map((v, at) => [`${group}[${String(at)}]`, c, v] as const),
);

describe('supervisor-protocol', () => {
  it('協定版本跟向量檔（也就是 Rust 那一側）相同', () => {
    expect(PROTOCOL_VERSION).toBe(VECTORS.protocolVersion);
  });

  it.each(cases)('%s 照向量檔編碼', (_, c, { value, hex }) => {
    expect(c.encode(value).toString('hex')).toBe(hex);
  });

  it.each(cases)('%s 從向量檔解回同一則', (_, c, { value, hex }) => {
    expect(c.decode(Buffer.from(hex, 'hex'))).toEqual(value);
  });

  it('每一組的每一種訊息都有向量，每一類死因也有', () => {
    for (const c of Object.values(CODECS)) {
      expect(new Set(c.vectors.map((v) => v.value.type))).toEqual(new Set(Object.keys(c.types)));
    }
    const downs = VECTORS.frontEvents.flatMap(({ value, hex }) =>
      value.type === 'down' ? [{ cause: value.cause, code: Buffer.from(hex, 'hex').at(-1) }] : [],
    );
    expect(downs).toEqual(DEATH_CAUSES.map((cause, at) => ({ cause, code: at + 1 })));
  });

  it('送錯方向的框：每一組的每一則，其他三支解碼器都丟協定錯誤', () => {
    for (const [group, c] of Object.entries(CODECS)) {
      for (const { hex } of c.vectors) {
        for (const [other, d] of Object.entries(CODECS)) {
          if (other === group) continue;
          expect(() => d.decode(Buffer.from(hex, 'hex')), `${group} → ${other}`).toThrow(
            SupervisorProtocolError,
          );
        }
      }
    }
  });

  it('編碼器不夾值：數字欄位超出 u32 的範圍就丟 RangeError，不繞回', () => {
    for (const idleMs of [-1, 2 ** 32]) {
      expect(() => encodeConversationReport({ type: 'idle', idleMs })).toThrow(RangeError);
    }
  });

  it('截斷、多出來、不認得的種類與列舉碼都丟協定錯誤', () => {
    for (const c of Object.values(CODECS)) {
      for (const { hex } of c.vectors) {
        const bytes = Buffer.from(hex, 'hex');
        for (let cut = 0; cut < bytes.length; cut++) {
          expect(() => c.decode(bytes.subarray(0, cut))).toThrow(SupervisorProtocolError);
        }
        expect(() => c.decode(Buffer.concat([bytes, Buffer.from([0])]))).toThrow(
          SupervisorProtocolError,
        );
      }
      expect(() => c.decode(Buffer.from('Z'))).toThrow('不認得的種類');
    }
    const turn = encodeConversationReport({ type: 'turn', phase: 'end' });
    turn[1] = 2;
    expect(() => decodeConversationReport(turn)).toThrow('不認得的一輪階段');
    const hello = encodeConversationReport({ type: 'hello', version: 4, runsLoop: true });
    hello[hello.length - 1] = 2;
    expect(() => decodeConversationReport(hello)).toThrow('不認得的 loop 宣告');
    const ensure = encodeFrontRequest({ type: 'ensure', threadId: '', open: 'run' });
    ensure[ensure.length - 1] = 2;
    expect(() => decodeFrontRequest(ensure)).toThrow('不認得的打開方式');
    for (const code of [0, DEATH_CAUSES.length + 1, 255]) {
      const down = encodeFrontEvent({ type: 'down', threadId: '', cause: 'heap' });
      down[down.length - 1] = code;
      expect(() => decodeFrontEvent(down)).toThrow('不認得的死因');
    }
  });
});
