/**
 * 這個 harness 是哪一版：`apps/harness/package.json` 的 `version`（#1502）。
 *
 * 照 dsh `packages/boot/app-boot/src/plugin-compatibility.ts:44-49`：版本從套件自己的 `../package.json` 讀，原始碼
 * （`src/`）與打包後（`lib/`）兩邊相對位置相同，所以同一行都對。裝好的產物用 `--version` 回報這個值，隔離安裝驗證拿它跟
 * tarball 的版本比對（`docs/operations.md`）。
 *
 * @module
 */

import { readFileSync } from 'node:fs';

/** `apps/harness/package.json` 裡的 `version`。 */
export const HARNESS_VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
