/**
 * 產生器讀 run 目錄的那幾支（[#1857](https://github.com/DemianLi/nexus-agent/issues/1857)）：哪幾份會話、凍哪幾個檔、
 * 事件與 header 怎麼讀。檔名照 `@nexus/core` 的 `session-filename.ts`，不自己拼（#1872）。兩種佈局都認：各 tag 與混版前半
 * （`MIXED_FIRST.rev`）的 CLI 寫的是**舊兩檔**；今天的工作樹寫的是**每會話目錄的世代檔**（#1594 ③），`mixed-v44-v49` 的後半
 * （`--resume` 續寫）就是這一種：續接把舊兩檔遷成世代檔，舊路徑的 header 換成墓碑，舊日誌原樣留著。同一個 id 兩種都在時，
 * 讀世代檔（同後端的挑法，墓碑不算一份會話）。
 *
 * **不走後端的 `readSessionEntry`**：夾具要凍的是寫入器寫出來的原樣位元組與它記的版號，那支會把 header 的 `version`
 * 轉譯成這一版（#1856），產生器要的不是那個。產生器整支是同步的，也是原因之一。
 *
 * 獨立成一個模組，是為了不跑產生器（它會開 git worktree）也驗得到這幾支：`generate.ts` 頂層讀 `process.argv` 就開跑，
 * 不能 import。
 *
 * @module
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { SessionEvent } from '../../packages/nexus-core/src/index.ts';
import {
  legacyTwoFileSessionFilenames,
  parseGenerationLogFilename,
  parseLegacyTwoFileHeaderFilename,
  sessionDirectoryName,
} from '../../packages/nexus-core/src/session-filename.ts';

/** 會話目錄裡版本最大的世代檔，相對 run 目錄的路徑；沒有會話目錄或裡面沒有世代檔是 `undefined`。 */
function generationFileOf(directory: string, id: string): string | undefined {
  const name = sessionDirectoryName(id);
  const sessionDirectory = join(directory, name);
  if (!existsSync(sessionDirectory) || !statSync(sessionDirectory).isDirectory()) return undefined;
  let best: { readonly version: number; readonly file: string } | undefined;
  for (const file of readdirSync(sessionDirectory)) {
    const version = parseGenerationLogFilename(file);
    if (version !== undefined && (best === undefined || version > best.version)) {
      best = { version, file };
    }
  }
  return best === undefined ? undefined : join(name, best.file);
}

/** 世代檔的 header 行與本文。 */
function splitGeneration(directory: string, file: string): { header: string; body: string } {
  const text = readFileSync(join(directory, file), 'utf8');
  const newline = text.indexOf('\n');
  return { header: text.slice(0, newline), body: text.slice(newline + 1) };
}

/**
 * run 目錄裡的會話，照 id 排：舊兩檔是 header 與日誌兩個檔都在的（檔名基底），世代檔是會話目錄裡有世代檔的（id 讀它的
 * header 行）。
 */
export function sessionsIn(directory: string): string[] {
  const ids = new Set<string>();
  for (const name of readdirSync(directory)) {
    const base = parseLegacyTwoFileHeaderFilename(name);
    if (
      base !== undefined &&
      existsSync(join(directory, legacyTwoFileSessionFilenames(base).log))
    ) {
      ids.add(base);
      continue;
    }
    if (!statSync(join(directory, name)).isDirectory()) continue;
    for (const file of readdirSync(join(directory, name))) {
      if (parseGenerationLogFilename(file) === undefined) continue;
      const { id } = JSON.parse(splitGeneration(directory, join(name, file)).header) as {
        id: string;
      };
      ids.add(id);
      break;
    }
  }
  return [...ids].sort();
}

/**
 * 一份會話凍進夾具的檔，相對 run 目錄：舊兩檔是 header、日誌；世代檔是挑中的那一個，加上舊路徑還在的檔（墓碑、遷移的來源），
 * 夾具才是續接當下磁碟上的原樣。
 */
export function frozenFilesOf(directory: string, id: string): readonly string[] {
  const { header, log } = legacyTwoFileSessionFilenames(id);
  const generation = generationFileOf(directory, id);
  if (generation === undefined) return [header, log];
  return [...[header, log].filter((file) => existsSync(join(directory, file))), generation];
}

/** 日誌本文逐行解開，不驗。世代檔跳過第一行的 header 行。 */
export function readEvents(directory: string, id: string): SessionEvent[] {
  const generation = generationFileOf(directory, id);
  const body =
    generation === undefined
      ? readFileSync(join(directory, legacyTwoFileSessionFilenames(id).log), 'utf8')
      : splitGeneration(directory, generation).body;
  return body
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
}

/**
 * 磁碟上那份 header 原樣解開，**不轉譯版號**：夾具記的是寫入器寫的那一版。世代檔讀 header 行，拿掉只在行上的 `type` 與
 * `migratedFrom`。
 */
export function readRawHeader<T>(directory: string, id: string): T {
  const generation = generationFileOf(directory, id);
  if (generation === undefined) {
    return JSON.parse(
      readFileSync(join(directory, legacyTwoFileSessionFilenames(id).header), 'utf8'),
    ) as T;
  }
  const {
    type: _type,
    migratedFrom: _migratedFrom,
    ...header
  } = JSON.parse(splitGeneration(directory, generation).header) as Record<string, unknown>;
  return header as T;
}
