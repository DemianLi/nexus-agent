/**
 * 請求基準檔錄製的收尾：每個測試案例結束時把假端點收到的請求寫成檔。沒設 `NEXUS_REQUEST_BASELINE_OUT` 時什麼都不做。
 * 見 `request-baseline.ts`。
 */
import { basename } from 'node:path';

import { afterEach } from 'vitest';

import { flushBaseline, isRecordingBaseline } from './request-baseline.js';

afterEach(({ task }) => {
  if (!isRecordingBaseline()) return;
  // 案例名字是 describe 路徑加案例名，用 ` > ` 串起來（與 vitest 的 `currentTestName` 同形）。
  const path = [task.name];
  for (let suite = task.suite; suite?.name; suite = suite.suite) path.unshift(suite.name);
  flushBaseline(basename(task.file.filepath), path.join(' > '));
});
