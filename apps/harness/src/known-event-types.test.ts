/**
 * 認得的事件種類表（`@nexus/core` 的 `known-event-types.ts`）是生成的，這裡驗兩件事
 * （[#679](https://github.com/DemianLi/nexus-agent/issues/679) 第 4 步）：
 *
 * 1. **沒過期**：重新掃一遍所有 `SessionEventMap` 宣告，渲染出來的全文要和已提交的檔逐字相同。忘了重新生成的人在這裡
 *    紅，訊息直接印出該跑的指令。
 * 2. **宣告合規**：頂層本體只有一個、成員都是字串字面量、沒有 `extends`、沒有重複。
 *
 * 掃描的根字面寫在這個檔裡（含 `apps/web/src`），是因為 `.github/scripts/plan_ci.py` 靠測試檔的內容判斷「這支一律要跑」：
 * 日後有人把事件宣告搬進任何套件或在 web 補一塊，影響範圍不是 diff 路徑猜得出來的。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isKnownSessionEventType } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import {
  collectSessionEventTypes,
  EVENT_CATALOG_ROOTS,
  KNOWN_EVENT_TYPES_PATH,
  KNOWN_EVENT_TYPES_REGENERATE,
  renderKnownEventTypes,
} from './known-event-types-catalog.js';
import { repositoryRoot } from './package-invariants.js';

const ROOTS = ['packages', 'apps/harness/src', 'apps/web/src'];

describe('認得的事件種類表', () => {
  const root = repositoryRoot();
  const scan = collectSessionEventTypes(root, ROOTS);

  it('生成器掃的根和這支測試掃的根一樣', () => {
    expect([...EVENT_CATALOG_ROOTS]).toEqual(ROOTS);
  });

  it('SessionEventMap 的宣告全部合規', () => {
    expect(scan.violations).toEqual([]);
  });

  it(`已提交的表沒過期（過期了跑：${KNOWN_EVENT_TYPES_REGENERATE}）`, () => {
    const committed = readFileSync(join(root, KNOWN_EVENT_TYPES_PATH), 'utf8');
    const expected = renderKnownEventTypes(scan.events.map((event) => event.name));
    expect(
      committed,
      `${KNOWN_EVENT_TYPES_PATH} 和原始碼裡的 SessionEventMap 宣告不一致。重新生成：${KNOWN_EVENT_TYPES_REGENERATE}`,
    ).toBe(expected);
  });

  it('掃出來的每一種，讀方都認得；沒宣告過的不認得', () => {
    for (const { name } of scan.events) expect(isKnownSessionEventType(name), name).toBe(true);
    expect(isKnownSessionEventType('never/declared')).toBe(false);
  });
});
