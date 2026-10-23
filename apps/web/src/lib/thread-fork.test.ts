import type { AiEntry } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { forkUnavailable, hasForkButton, increasedForkTitle } from '@/lib/thread-fork';

/** 分支鈕的判法與子 thread 的標題（#1581 刀 2）。 */

describe('increasedForkTitle（照 dsh sessions-service.client.spec.ts:978-1000）', () => {
  it.each([
    ['Roadmap', 'Roadmap (1)'],
    ['Roadmap (1)', 'Roadmap (2)'],
    ['计划（1）', '计划（2）'],
    ['计划 （9）', '计划 （10）'],
  ])('%j → %j', (source, child) => {
    expect(increasedForkTitle(source)).toBe(child);
  });

  // dsh 的表沒有這一列（本專案補的）：超過 Number 能精確表示的範圍，用 Number 算會差一。
  it('數字用 BigInt 算：9007199254740993 加一是 …994', () => {
    expect(increasedForkTitle('計劃 (9007199254740993)')).toBe('計劃 (9007199254740994)');
    expect(increasedForkTitle('計劃（9007199254740993）')).toBe('計劃（9007199254740994）');
  });

  it('括號不在結尾、括號裡不是數字：當成沒編號，接 (1)', () => {
    expect(increasedForkTitle('(1) 開場')).toBe('(1) 開場 (1)');
    expect(increasedForkTitle('計劃 (草稿)')).toBe('計劃 (草稿) (1)');
  });
});

function tail(extra: Partial<AiEntry> = {}): AiEntry {
  return {
    kind: 'ai',
    id: 'r1',
    text: '收工。',
    streaming: false,
    attribution: { kind: 'root' },
    messageId: 'm-1',
    turnTail: true,
    ...extra,
  } as AiEntry;
}

const idle = { forking: false, failed: false };

describe('分支鈕能不能按（判法同 server 的 fork_unavailable）', () => {
  it('只畫在收尾那一則', () => {
    expect(hasForkButton(tail())).toBe(true);
    const { turnTail: _omit, ...notTail } = tail();
    expect(hasForkButton(notTail as AiEntry)).toBe(false);
  });

  it('收了的一輪、有 messageId：按得了；人按停止收尾的也按得了（server 照樣收）', () => {
    expect(forkUnavailable(tail(), idle)).toBeUndefined();
    expect(forkUnavailable(tail({ stopped: true }), idle)).toBeUndefined();
  });

  it.each([
    ['這則還在吐字', tail({ streaming: true }), idle, 'running'],
    ['送出之後、回應之前', tail(), { ...idle, forking: true }, 'forking'],
    ['失敗收尾的那一輪', tail(), { ...idle, failed: true }, 'failed'],
    ['沒有 messageId', tail({ messageId: undefined }), idle, 'no-message'],
  ] as const)('%s：按不了，原因是 %s', (_label, entry, state, reason) => {
    expect(forkUnavailable(entry, state)).toBe(reason);
  });
});
