/**
 * core 的 `TodoStatus` 與 wire 的 `WireTodoItem['status']` 是兩份各自宣告的聯集（wire 要在瀏覽器裡跑，
 * 不相依 core，所以沿用「wire 重新宣告、harness 鏡像」的慣例，見 `conversation.ts` 的說明）。
 * harness 是唯一同時看得到兩邊的地方，所以雙向相等由這裡釘住（[#666](https://github.com/DemianLi/nexus-agent/issues/666)）。
 *
 * **要在型別層比，而且要兩個方向**：wire 沒有執行期清單。單向可指派只擋得住其中一邊多一格
 * （`todosData` 把 core 的值塞進 wire 的欄位，core 多一格會在那裡編不過），擋不住 core 少一格、
 * wire 留著一個沒人會產生的狀態；反過來也一樣。`Equal` 用的是「兩個泛型函式簽章可互換」那個寫法，
 * 不是 `A extends B`——後者對聯集是單向的。
 *
 * 型別斷言由 `tsc` 檢查（harness 的 `tsc` 涵蓋 `src` 底下的測試檔），vitest 本身不會因為型別紅。
 * 所以底下的 `it` 只是讓檔案在 vitest 裡有東西可跑，真正的斷言是那幾行 `const … = true`。
 */

import { describe, expect, it } from 'vitest';

import { TODO_STATUSES } from '@nexus/core';
import type { TodoStatus } from '@nexus/core';
import type { WireTodoItem } from '@nexus/wire';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** 量具自檢：分得出「多一格」與「少一格」，否則下面那條綠的什麼都不代表。 */
const detectsExtra: Equal<'a' | 'b', 'a'> = false;
const detectsMissing: Equal<'a', 'a' | 'b'> = false;
const detectsSame: Equal<'a' | 'b', 'b' | 'a'> = true;

/** 真正的斷言：兩個方向都要相等。任何一邊多或少一格，這一行在 `tsc` 就紅。 */
const statusesMatch: Equal<TodoStatus, WireTodoItem['status']> = true;

describe('待辦狀態：core 與 wire 的聯集相等', () => {
  it('型別層的斷言由 tsc 檢查；執行期只確認 core 的清單非空', () => {
    expect([detectsExtra, detectsMissing, detectsSame, statusesMatch]).toEqual([
      false,
      false,
      true,
      true,
    ]);
    expect(TODO_STATUSES.length).toBeGreaterThan(0);
  });
});
