/**
 * 名義型別：**型別層的斷言靠 `@ts-expect-error`，由 `pnpm -r typecheck` 判**（vitest 不做型別檢查）。
 * 把 `BRAND` 標記拿掉，兩個品牌變成同一個型別，下面每一條 `@ts-expect-error` 都變成多餘的指示、typecheck 紅。
 * 執行期的斷言（值不變、序列化不變）由 vitest 判。
 */

import { describe, expect, it } from 'vitest';

import { brandNumber, brandString } from './index.js';
import type { Branded, BrandedNumber } from './index.js';

type SessionId = Branded<'SessionId'>;
type ToolCallId = Branded<'ToolCallId'>;
type EventSeq = BrandedNumber<'EventSeq'>;
type LogOffset = BrandedNumber<'LogOffset'>;

const takesSession = (_id: SessionId): void => undefined;
const takesToolCall = (_id: ToolCallId): void => undefined;
const takesSeq = (_seq: EventSeq): void => undefined;

describe('型別層', () => {
  it('兩個品牌的字串不能互傳；裸字串也不能直接當品牌字串', () => {
    const session = brandString<SessionId>('s1');
    const toolCall = brandString<ToolCallId>('c1');
    takesSession(session);
    takesToolCall(toolCall);
    // @ts-expect-error — 工具呼叫 id 不能傳到要會話 id 的地方
    takesSession(toolCall);
    // @ts-expect-error — 會話 id 不能傳到要工具呼叫 id 的地方
    takesToolCall(session);
    // @ts-expect-error — 裸字串不是品牌字串
    takesSession('s1');
  });

  it('兩個品牌的數字不能互傳；裸數字也不能直接當品牌數字', () => {
    const seq = brandNumber<EventSeq>(3);
    const offset = brandNumber<LogOffset>(3);
    takesSeq(seq);
    // @ts-expect-error — 日誌位移不能當事件序號用
    takesSeq(offset);
    // @ts-expect-error — 裸數字不是品牌數字
    takesSeq(3);
  });

  it('品牌值照樣是字串／數字：可以當 string／number 用', () => {
    const id: string = brandString<SessionId>('s1');
    const n: number = brandNumber<EventSeq>(7);
    expect(id.length).toBe(2);
    expect(n + 1).toBe(8);
  });
});

describe('執行期不變', () => {
  it('值原樣回來（brandString／brandNumber 只做型別斷言）', () => {
    expect(brandString<SessionId>('s1')).toBe('s1');
    expect(brandNumber<EventSeq>(42)).toBe(42);
    expect(brandString<SessionId>('')).toBe('');
  });

  it('比較、序列化和裸原始值一樣', () => {
    const id = brandString<SessionId>('s1');
    expect(id === 's1').toBe(true);
    expect(JSON.stringify({ id, seq: brandNumber<EventSeq>(2) })).toBe('{"id":"s1","seq":2}');
    expect(`${id}`).toBe('s1');
  });

  it('已經帶品牌的值再掛同一個品牌：還是同一個值', () => {
    const id = brandString<SessionId>('s1');
    expect(brandString<SessionId>(id)).toBe(id);
  });
});
