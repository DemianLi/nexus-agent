/**
 * 讀盤用的是執行期配套入口那一支（[#1597](https://github.com/DemianLi/nexus-agent/issues/1597) 驗收 E 的 harness 那一側）：
 * `assertStoredRelationships` 要經 `@nexus/core` 的 `createSessionRelationshipChecker` 判，自己另寫一份狀態機就紅。執行期那一側在
 * `packages/nexus-core/src/invariant-shared-checker.test.ts`。
 */

import { createSessionRelationshipChecker } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import { describe, expect, it, vi } from 'vitest';

import { assertStoredRelationships } from './session-log-validation.js';

vi.mock('@nexus/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@nexus/core')>();
  return {
    ...real,
    createSessionRelationshipChecker: vi.fn(real.createSessionRelationshipChecker),
  };
});

describe('讀盤與執行期共用同一支關係檢查（#1597 E）', () => {
  it('assertStoredRelationships 經 createSessionRelationshipChecker 判，拒開的理由是它回的那一筆', () => {
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { kind: 'message', text: '嗨' } },
      { type: 'turn/start', seq: 1, time: 1, data: { kind: 'message', text: '又一輪' } },
    ] as unknown as SessionEvent[];
    expect(() => assertStoredRelationships('a', events, 0)).toThrow(
      '第 2 行不合事件之間的關係（turn-overlap）：turn/start（seq 1）來的時候上一輪還開著',
    );
    expect(vi.mocked(createSessionRelationshipChecker)).toHaveBeenCalledTimes(1);
  });
});
