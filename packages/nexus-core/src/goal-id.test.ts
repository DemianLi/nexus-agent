/**
 * `GoalId` 換成共用的 `Branded<'GoalId'>`（`@nexus/brand`，[#1569](https://github.com/DemianLi/nexus-agent/issues/1569)）之後，
 * 保護沒有變弱，執行期也沒有變。型別層的斷言靠 `@ts-expect-error`，由 `pnpm -r typecheck` 判（vitest 不做型別檢查）：
 * 品牌被拿掉的話，每一條 `@ts-expect-error` 都變成多餘的指示、typecheck 紅。
 */

import { describe, expect, it } from 'vitest';

import { brandString } from '@nexus/brand';
import type { Branded } from '@nexus/brand';

import { goalId } from './goal.js';
import type { GoalId, GoalRef } from './goal.js';

const refOf = (id: GoalId): GoalRef => ({ id, revision: 1 });

describe('GoalId 的名義型別', () => {
  it('會話 id（另一個品牌）、裸字串都塞不進 GoalId 那一格；只有 goalId() 造得出來', () => {
    const session = brandString<Branded<'SessionId'>>('s1');
    expect(refOf(goalId('g1')).id).toBe('g1');
    // @ts-expect-error — 會話 id 不是 goal id
    refOf(session);
    // @ts-expect-error — 裸字串（例如使用者打的目標文字）不是 goal id
    refOf('把測試修綠');
  });
});

describe('執行期不變', () => {
  it('goalId() 回同一串字；序列化、比較和裸字串一樣', () => {
    expect(goalId('g1')).toBe('g1');
    expect(goalId('g1') === 'g1').toBe(true);
    expect(JSON.stringify(goalId('g1'))).toBe('"g1"');
    expect(JSON.stringify(refOf(goalId('g1')))).toBe('{"id":"g1","revision":1}');
  });
});
