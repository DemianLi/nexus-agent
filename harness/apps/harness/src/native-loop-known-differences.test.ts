import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { KNOWN_DIFFERENCES } from './native-loop-known-differences.js';

const ROOT = join(import.meta.dirname, '..');

/**
 * `native-loop.runner.ts` 只認得收集到的檔：整個檔刪掉或搬走的話，那幾條登記在 runner 那裡永遠不會被對到。這裡補上那一格。
 */
describe('native 的已知差異登記', () => {
  it('登記到的檔都還在', () => {
    const missing = [...new Set(KNOWN_DIFFERENCES.map((entry) => entry.file))].filter(
      (file) => !existsSync(join(ROOT, file)),
    );
    expect(missing).toEqual([]);
  });

  it('同一條不登記兩次', () => {
    const keys = KNOWN_DIFFERENCES.map((entry) => `${entry.file} > ${entry.test}`);
    expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([]);
  });
});
