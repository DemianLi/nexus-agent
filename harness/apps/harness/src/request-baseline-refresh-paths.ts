/**
 * 請求基準檔放哪裡。獨立成一個沒有副作用的模組：錄製腳本（`request-baseline-refresh.ts`，載入就開始跑）與測試都要讀它。
 *
 * @module
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 基準檔的家。 */
export const BASELINE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'request-baseline',
);
