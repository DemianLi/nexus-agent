import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recallThread, REMEMBERED_THREAD_KEY } from '@/lib/remembered-thread';
import { stubInsecureCrypto, UUID_V4 } from '@/test/insecure-crypto';

beforeEach(() => {
  const entries = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('recallThread 在非安全環境（#1548）', () => {
  /**
   * 它是首次載入時 `useState` 的初始化器：這裡拋錯就是整頁起不來。只看「沒拋錯」不夠，id 的形狀也要對——
   * 換回 `crypto.randomUUID()` 的話這一則直接拋 TypeError。
   */
  it('沒有記住的 thread：生一條新的，id 是 UUID v4', () => {
    stubInsecureCrypto();
    const choice = recallThread();
    expect(choice.origin).toBe('fresh');
    expect(choice.threadId).toMatch(UUID_V4);
  });

  it('記住的那條照舊接回來', () => {
    stubInsecureCrypto();
    localStorage.setItem(REMEMBERED_THREAD_KEY, JSON.stringify({ threadId: '上一條' }));
    expect(recallThread()).toEqual({ threadId: '上一條', origin: 'recalled' });
  });
});
