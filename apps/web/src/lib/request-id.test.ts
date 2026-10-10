import { REQUEST_ID_MAX_LENGTH } from '@nexus/wire';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { newRequestId, requestIdFor } from '@/lib/request-id';
import type { PendingRequest, Sentence } from '@/lib/request-id';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const sentence = (overrides: Partial<Sentence> = {}): Sentence => ({
  text: '一句話',
  mention: undefined,
  attachmentIds: [],
  ...overrides,
});

const pendingFor = (s: Sentence): PendingRequest => ({ id: 'id-上次', sentence: s });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('newRequestId', () => {
  it('是 UUID v4 的形狀，長度在協定上限內', () => {
    const id = newRequestId();
    expect(id).toMatch(UUID_V4);
    expect(id.length).toBeLessThanOrEqual(REQUEST_ID_MAX_LENGTH);
  });

  it('每次都不一樣', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newRequestId()));
    expect(ids.size).toBe(200);
  });

  it('沒有 crypto.randomUUID（非安全環境的 http:// 頁面）照樣產得出來', () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    expect(newRequestId()).toMatch(UUID_V4);
  });
});

describe('requestIdFor', () => {
  it('沒有上次沒送出去的那一句：新的編號', () => {
    expect(requestIdFor(undefined, sentence())).toMatch(UUID_V4);
  });

  it('跟上次沒送出去的那一句完全相同：沿用', () => {
    expect(requestIdFor(pendingFor(sentence()), sentence())).toBe('id-上次');
  });

  it('頭尾空白不算改', () => {
    expect(requestIdFor(pendingFor(sentence()), sentence({ text: '  一句話\n' }))).toBe('id-上次');
  });

  it.each([
    ['改了字', sentence({ text: '一句話。' })],
    ['中間多了空白', sentence({ text: '一句 話' })],
    ['點了名', sentence({ mention: 'reviewer' })],
    ['多了附件', sentence({ attachmentIds: ['a'] })],
  ])('%s：新的一句、新的編號', (_case, next) => {
    expect(requestIdFor(pendingFor(sentence()), next)).toMatch(UUID_V4);
  });

  it.each([
    ['換了點名的對象', sentence({ mention: 'explorer' }), sentence({ mention: 'reviewer' })],
    ['取消點名', sentence({ mention: 'explorer' }), sentence()],
    ['少了附件', sentence({ attachmentIds: ['a', 'b'] }), sentence({ attachmentIds: ['a'] })],
    ['換了附件', sentence({ attachmentIds: ['a'] }), sentence({ attachmentIds: ['b'] })],
    [
      '附件順序換了',
      sentence({ attachmentIds: ['a', 'b'] }),
      sentence({ attachmentIds: ['b', 'a'] }),
    ],
  ])('%s：新的一句、新的編號', (_case, before, next) => {
    expect(requestIdFor(pendingFor(before), next)).toMatch(UUID_V4);
  });

  it('附件與點名都相同：沿用', () => {
    const same = sentence({ mention: 'explorer', attachmentIds: ['a', 'b'] });
    expect(requestIdFor(pendingFor(same), { ...same, attachmentIds: ['a', 'b'] })).toBe('id-上次');
  });
});
