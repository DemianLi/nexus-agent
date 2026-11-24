/**
 * fold 什麼時候讓補懸空呼叫那顆 middleware 不掛改狀態的 `beforeAgent`：歷史從日誌推（`log`）時給 `patchToolCallsStateFix: false`，
 * `state`、`shadow` 與沒給 `history` 的組裝一律不給（會掛）。這一格隨 fold 的產物交給 `assembleAgent` 與背景圖，各處怎麼用見 `patch-tool-calls-mount.test.ts`。
 */

import { describe, expect, it } from 'vitest';

import { foldRegistry } from './fold.js';
import type { FoldOptions } from './fold.js';
import { loadPlugins } from './load.js';

async function foldWith(history: FoldOptions['history']) {
  const { registry } = await loadPlugins([]);
  return foldRegistry(registry, {
    summarization: false,
    repeatReminder: false,
    observationPolicy: false,
    ...(history !== undefined && { history }),
  });
}

describe('fold 的 patchToolCallsStateFix', () => {
  it('log：false', async () => {
    expect((await foldWith({ source: 'log' })).patchToolCallsStateFix).toBe(false);
  });

  it.each([
    ['state', { source: 'state' }],
    ['沒給 history', undefined],
  ] as const)('%s：不給（會掛）', async (_label, history) => {
    const folded = await foldWith(history);
    expect('patchToolCallsStateFix' in folded).toBe(false);
  });
});
