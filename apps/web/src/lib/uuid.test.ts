import { afterEach, describe, expect, it, vi } from 'vitest';

import { randomUuid } from '@/lib/uuid';
import { stubInsecureCrypto, UUID_V4 } from '@/test/insecure-crypto';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('randomUuid（#1548）', () => {
  it('連產 1,000 個：全是 UUID v4 的形狀，沒有重複', () => {
    // 1,000 個才擋得住拿掉版本或變體那一行：碰巧每一個的那一碼都對上的機率可以忽略（版本那一碼是 16 分之 1 的 1,000 次方）。
    const ids = Array.from({ length: 1_000 }, () => randomUuid());
    for (const id of ids) expect(id).toMatch(UUID_V4);
    expect(new Set(ids).size).toBe(1_000);
  });

  it('沒有 crypto.randomUUID（非安全環境的 http:// 頁面）照樣產得出來', () => {
    stubInsecureCrypto();
    expect('randomUUID' in crypto).toBe(false);
    expect(randomUuid()).toMatch(UUID_V4);
  });
});
