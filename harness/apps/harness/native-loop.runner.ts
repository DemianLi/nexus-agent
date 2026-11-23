/**
 * `vitest.native.config.ts` 的 runner：登記過的已知差異（`src/native-loop-known-differences.ts`）在 native 下照登記的方式跑。
 *
 * - `fails`：照跑，要失敗才算過（同 `it.fails`）。差異收掉、這一條轉綠時它會紅，提醒把登記拿掉。
 * - `skip`：不跑。給懸住之後會漏到同檔下一條的：懸著的 promise 會讓後面的測試跟著壞。懸到逾時、但收得乾淨的照登記 `fails`，
 *   代價是跑滿逾時。
 * - `passes`：照跑、要過。差異在斷言之外（工具事件序列、送給模型的系統訊息），登記是讓它有根因與收掉它的卡。差異收掉時
 *   這一條不會紅，登記要手動拿掉。
 *
 * 登記裡有一條對不到這個檔收集到的測試時整檔失敗：測試改名或刪掉之後，登記不能靜靜失效。
 */

import { relative } from 'node:path';

import { TestRunner } from 'vitest';
import type { RunnerTask, RunnerTestFile } from 'vitest';

import { KNOWN_DIFFERENCES } from './src/native-loop-known-differences.ts';

/** 從檔案以下的完整名字，`describe > … > it`，同 vitest 報告裡那一串。 */
function fullName(task: RunnerTask): string {
  const names: string[] = [];
  for (
    let at: RunnerTask | undefined = task;
    at !== undefined && !('filepath' in at);
    at = at.suite
  ) {
    names.unshift(at.name);
  }
  return names.join(' > ');
}

export default class NativeLoopRunner extends TestRunner {
  override onCollected(files: RunnerTestFile[]): void {
    for (const file of files) {
      const path = relative(this.config.root, file.filepath);
      const entries = KNOWN_DIFFERENCES.filter((entry) => entry.file === path);
      if (entries.length === 0) continue;
      const tests = new Map<string, RunnerTask>();
      const walk = (task: RunnerTask): void => {
        if (task.type === 'test') tests.set(fullName(task), task);
        if ('tasks' in task) for (const child of task.tasks) walk(child);
      };
      walk(file);
      const stale = entries.filter((entry) => !tests.has(entry.test));
      if (stale.length > 0) {
        throw new Error(
          `native 的已知差異登記對不到 ${path} 裡的測試：${stale.map((entry) => entry.test).join('；')}`,
        );
      }
      for (const entry of entries) {
        const test = tests.get(entry.test)!;
        if (entry.run === 'skip') test.mode = 'skip';
        else if (entry.run === 'fails') (test as { fails?: boolean }).fails = true;
      }
    }
  }
}
