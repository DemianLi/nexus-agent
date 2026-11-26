/**
 * 沙箱 spawner 控制通道的編解碼（#1946）。向量檔與 Rust 端的 `protocol.rs` 測試共用：兩邊各自對它測，格式一邊改了另一邊就紅。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  MAX_FRAME,
  SpawnerProtocolError,
  type SpawnerEvent,
  type SpawnerRequest,
  decodeEvent,
  encodeRequest,
  frame,
  stdioHeader,
  takeFrames,
} from './sandbox-protocol.js';

const VECTORS = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../native/sandbox-spawner/protocol-vectors.json', import.meta.url),
    ),
    'utf8',
  ),
) as {
  requests: { value: SpawnerRequest; hex: string }[];
  events: { value: SpawnerEvent; hex: string }[];
};

describe('sandbox-protocol', () => {
  it.each(VECTORS.requests.map((v) => [v.value.type, v] as const))(
    '要求照向量檔編碼（%s）',
    (_, { value, hex }) => {
      expect(encodeRequest(value).toString('hex')).toBe(hex);
    },
  );

  it.each(VECTORS.events.map((v) => [v.value.type, v] as const))(
    '事件照向量檔解碼（%s）',
    (_, { value, hex }) => {
      expect(decodeEvent(Buffer.from(hex, 'hex'))).toEqual(value);
    },
  );

  it('截斷、多出來、不認得的事件都丟協定錯誤', () => {
    for (const { hex } of VECTORS.events) {
      const bytes = Buffer.from(hex, 'hex');
      for (let cut = 0; cut < bytes.length; cut++) {
        expect(() => decodeEvent(bytes.subarray(0, cut))).toThrow(SpawnerProtocolError);
      }
      expect(() => decodeEvent(Buffer.concat([bytes, Buffer.from([0])]))).toThrow(
        SpawnerProtocolError,
      );
    }
    expect(() => decodeEvent(Buffer.from('Z'))).toThrow('不認得的事件');
    const failed = Buffer.from(
      VECTORS.events.find((v) => v.value.type === 'failed')?.hex ?? '',
      'hex',
    );
    failed[5] = 6;
    expect(() => decodeEvent(failed)).toThrow('不認得的失敗種類');
  });

  it('從位元組流切出完整的框，剩下的留著', () => {
    const stream = Buffer.concat([frame(Buffer.from('one')), frame(Buffer.from('two!'))]);
    const first = takeFrames(stream.subarray(0, 10));
    expect(first.frames.map(String)).toEqual(['one']);
    const second = takeFrames(Buffer.concat([first.rest, stream.subarray(10)]));
    expect(second.frames.map(String)).toEqual(['two!']);
    expect(second.rest.length).toBe(0);
    const huge = Buffer.alloc(4);
    huge.writeUInt32LE(MAX_FRAME + 1);
    expect(() => takeFrames(huge)).toThrow('框太大');
  });

  it('stdio 標頭是 id 與 fd 兩個 u32 LE', () => {
    expect(stdioHeader(258, 2).toString('hex')).toBe('0201000002000000');
  });
});
