/**
 * vitest 的 setupFile：每個測試檔一個暫存的 harness home（#424）。
 *
 * `runServe` 從 `options.env ?? process.env` 讀 `NEXUS_AGENT_HOME`，沒設就退回 `~/.nexus-agent`。
 * **大多數 serve 測試傳 `env: {}`**（隔開開發者 shell 裡的遙測變數），那會繞過 `process.env` 上的
 * 覆寫——所以這裡同時把 `HOME`（Windows 是 `USERPROFILE`）換掉，退回去的那一格也落在暫存目錄裡；
 * 換完當場確認 `homedir()` 真的跟著變了，沒變就讓整個檔紅掉，而不是悄悄寫進使用者的家目錄。
 * 要驗 home 行為的測試照樣自己給暫存目錄。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultTokenAnchorBook } from '@nexus/core';
import { afterAll, beforeEach } from 'vitest';
import { HARNESS_HOME_ENV } from './harness-home.js';

const home = mkdtempSync(join(tmpdir(), 'nexus-agent-home-'));
process.env[HARNESS_HOME_ENV] = join(home, 'harness-home');
process.env.HOME = home;
process.env.USERPROFILE = home;
if (homedir() !== home) {
  throw new Error(`測試的 HOME 沒換成功：homedir() 是 ${homedir()}，不是 ${home}`);
}

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

// 錨定估算的帳是行程共用的（#588）：不清的話，同一個檔裡後一條的第一次會借到前一條的第一次，量到的數隨執行順序變。
beforeEach(() => {
  defaultTokenAnchorBook.clear();
});
