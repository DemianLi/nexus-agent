/**
 * vitest 的 setupFile：每條測試一個暫存的 harness home（#424，#444 起改成逐條）。
 *
 * `runServe` 從 `options.env ?? process.env` 讀 `NEXUS_AGENT_HOME`，沒設就退回 `~/.nexus-agent`。
 * **大多數 serve 測試傳 `env: {}`**（隔開開發者 shell 裡的遙測變數），那會繞過 `process.env` 上的
 * 覆寫——所以這裡同時把 `HOME`（Windows 是 `USERPROFILE`）換掉，退回去的那一格也落在暫存目錄裡；
 * 換完當場確認 `homedir()` 真的跟著變了，沒變就讓整個檔紅掉，而不是悄悄寫進使用者的家目錄。
 * 要驗 home 行為的測試照樣自己給暫存目錄。
 *
 * **為什麼逐條而不是逐檔**（#444）：會話日誌預設落在 home 底下之後，同一個檔裡的兩條 serve 測試
 * 共用 cwd，也就共用 `sessions/<projectKey(cwd)>` 那一格——後一條碰到同名的 thread id 會把前一條
 * 寫的**接回來**，前一條沒收乾淨的話還會撞上它的寫租約（背景寫入被拒只是一行 warn，日誌就靜靜沒了）。
 * 兩種都不一定讓測試紅。所以每條測試開始前換一份新的；`beforeAll` 起的東西落在檔層那一份裡。
 * 刪除一律等到 `afterAll`：前一條還在收尾的寫入不該寫進一個已經刪掉的目錄。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultTokenAnchorBook } from '@nexus/core';
import { afterAll, beforeEach } from 'vitest';
import { HARNESS_HOME_ENV } from './harness-home.js';

const root = mkdtempSync(join(tmpdir(), 'nexus-agent-home-'));

/** 把 `HOME` 與 harness home 換到 `home`，當場確認 `homedir()` 跟著變了。 */
function useHome(home: string): void {
  process.env[HARNESS_HOME_ENV] = join(home, 'harness-home');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  if (homedir() !== home) {
    throw new Error(`測試的 HOME 沒換成功：homedir() 是 ${homedir()}，不是 ${home}`);
  }
}

// 檔層那一份：import 期與 `beforeAll` 用的。
useHome(root);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// 錨定估算的帳是行程共用的（#588）：不清的話，同一個檔裡後一條的第一次會借到前一條的第一次，量到的數隨執行順序變。
// home 逐條換，理由見檔頭。
beforeEach(() => {
  defaultTokenAnchorBook.clear();
  useHome(mkdtempSync(join(root, 'test-')));
});
