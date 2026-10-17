import { readFileSync } from 'node:fs';

import * as core from '@nexus/core';
import { describe, expect, it } from 'vitest';

import * as session from './index.js';

describe('@nexus/session 是 @nexus/core 的單向轉出', () => {
  it('轉出的五個值與 core 是同一個參照（轉出，不是複製）', () => {
    expect(session.loggedContentBlocks).toBe(core.loggedContentBlocks);
    expect(session.loggedMessageId).toBe(core.loggedMessageId);
    expect(session.toolCallIds).toBe(core.toolCallIds);
    expect(session.REPEAT_REMINDER_MARKER).toBe(core.REPEAT_REMINDER_MARKER);
    // #1463：todo 的狀態集合也是 core 那一份（`TodoItem`／`TodoStatus` 是型別，沒有執行期值）。
    expect(session.TODO_STATUSES).toBe(core.TODO_STATUSES);
    // #1486：goal 的折疊讀 `turn/start` 與 `source` 用的兩個讀法。
    expect(session.currentTurnStart).toBe(core.currentTurnStart);
    expect(session.sourceKwargs).toBe(core.sourceKwargs);
  });

  it('值只有這幾個：七個轉出（#1486 多 `currentTurnStart`、`sourceKwargs`），加會話查找接縫自己的 token 與契約版本（#1463）', () => {
    expect(Object.keys(session).sort()).toEqual([
      'REPEAT_REMINDER_MARKER',
      'SESSION_LOOKUP_CONTRACT_VERSION',
      'TODO_STATUSES',
      'currentTurnStart',
      'loggedContentBlocks',
      'loggedMessageId',
      'sessionLookupToken',
      'sourceKwargs',
      'toolCallIds',
    ]);
    expect(session.sessionLookupToken.name).toBe('sessionLookup');
    expect(session.SESSION_LOOKUP_CONTRACT_VERSION).toBe('1.0.0');
  });

  it('@nexus/core 只放 peerDependencies 與 devDependencies，不進 dependencies（不能讓安裝結果出現第二份 core）', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies ?? {}).toEqual({});
    // `@nexus/cordis` 與 `@nexus/sdk` 是會話查找接縫（`defineToken`、`ContractService`）要的，宿主給（#1463）。
    expect(Object.keys(pkg.peerDependencies).sort()).toEqual([
      '@nexus/cordis',
      '@nexus/core',
      '@nexus/sdk',
    ]);
    expect(pkg.devDependencies['@nexus/core']).toBe('workspace:*');
  });
});
