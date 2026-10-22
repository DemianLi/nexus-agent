/**
 * 產生器讀 run 目錄的那幾支（[#1857](https://github.com/DemianLi/nexus-agent/issues/1857)）：哪幾份會話、兩個檔叫什麼、
 * 事件與 header 怎麼讀。檔名照 `@nexus/core` 的 `session-filename.ts`，不自己拼。
 *
 * **不走後端的 `readSessionEntry`**：夾具要凍的是寫入器寫出來的原樣位元組與它記的版號，那支會把 header 的 `version`
 * 轉譯成這一版（#1856），產生器要的不是那個。產生器整支是同步的，也是原因之一。
 *
 * 獨立成一個模組，是為了不跑產生器（它會開 git worktree）也驗得到這幾支：`generate.ts` 頂層讀 `process.argv` 就開跑，
 * 不能 import。
 *
 * @module
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { SessionEvent } from '../../packages/nexus-core/src/index.ts';
import {
  parseSessionHeaderFilename,
  sessionFilenames,
} from '../../packages/nexus-core/src/session-filename.ts';

/** run 目錄裡的會話（檔名基底）：header 與日誌兩個檔都在的，照名字排。 */
export function sessionsIn(directory: string): string[] {
  return readdirSync(directory)
    .map((name) => parseSessionHeaderFilename(name))
    .filter((base): base is string => base !== undefined)
    .filter((base) => existsSync(join(directory, sessionFilenames(base).log)))
    .sort();
}

/** 一份會話凍進夾具的兩個檔名：header、日誌。 */
export function frozenFilesOf(base: string): readonly [string, string] {
  const { header, log } = sessionFilenames(base);
  return [header, log];
}

/** 日誌本文逐行解開，不驗。 */
export function readEvents(directory: string, base: string): SessionEvent[] {
  return readFileSync(join(directory, sessionFilenames(base).log), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
}

/** 磁碟上那份 header 原樣解開，**不轉譯版號**：夾具記的是寫入器寫的那一版。 */
export function readRawHeader<T>(directory: string, base: string): T {
  return JSON.parse(readFileSync(join(directory, sessionFilenames(base).header), 'utf8')) as T;
}
