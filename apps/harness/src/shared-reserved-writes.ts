/**
 * **舊 thread 寫不得的地方**（[#1960](https://github.com/DemianLi/nexus-agent/issues/1960)）。
 *
 * 舊 thread 的可寫根就是 `--workspace`，也就是新 thread 的唯讀共用區（`thread-roots.ts` 的檔頭表格）。新 thread 從共用區讀三樣東西當成不是資料的內容：
 *
 * - 根目錄的指示檔（`@nexus/plugin-agent-instructions` 的 {@link INSTRUCTION_FILE_CANDIDATES}），以一則持久的使用者訊息送進每條新 thread 當工作區指示；
 * - 技能來源底下的技能（`@nexus/core` 的 `threadSkillSources` 把不在路由底下的來源接到共用區底下），列進清單、`/名字` 叫得出。
 * - `memory` 插件寫在共用區底下的來源，併進每條新 thread 的 system prompt（[#2270](https://github.com/DemianLi/nexus-agent/issues/2270)）。
 *
 * 舊 thread 寫進這三處的東西會變成之後每條新 thread 的指示或技能，不分使用者，所以這三處對舊 thread 一律拒絕變更，不看模式、不吃升級
 * （圍堵 backend 的 `reservedWrites`）。指示檔只擋根目錄那四個名字：子目錄裡的不會被讀。
 *
 * @module
 */

import { isUnderAnyPrefix } from '@nexus/core';
import type { FsService } from '@nexus/core';
import { INSTRUCTION_FILE_CANDIDATES } from '@nexus/plugin-agent-instructions';

import type { ReservedWrite } from './contained-backend.js';
import { SHARED_WORKSPACE_PREFIX } from './thread-roots.js';

const INSTRUCTION_FILE_REASON =
  '這條對話的工作區也是其他新對話的共用區，根目錄的這個檔會變成每條新對話的工作區指示，所以不能改；' +
  '筆記請換個檔名，或放進子目錄';

const SKILL_SOURCE_REASON =
  '這個目錄是技能來源，這條對話的工作區也是其他新對話的共用區，寫進這裡的技能每條新對話都叫得到，所以不能改；' +
  '請寫到技能來源以外的目錄';

const MEMORY_SOURCE_REASON =
  '這條對話的工作區也是其他新對話的共用區，這個檔是記憶來源，內容會進每條新對話，所以不能改；' +
  '筆記請換個檔名，或放進別的目錄';

/**
 * 舊 thread 寫不得的地方，逐次呼叫算。
 *
 * 技能來源跟 `threadSkillSources` 讀同一份：fs 把手的 `skillSources()`（舊 thread 沒有共用區前綴，所以是登記的來源原樣），去掉落在
 * `offWorkspacePrefixes()` 任何一個底下的（工具結果暫存、附件、外掛掛的路由）——剩下的就是新 thread 會接到共用區底下的那幾個。
 *
 * 記憶來源只算寫在 {@link SHARED_WORKSPACE_PREFIX} 底下的：`/shared/x` 就是舊 thread 的 `/x`。其餘的在新 thread 讀自己的私有根，碰不到舊 thread 寫的檔。
 *
 * @param fs - 這次組裝的 fs 把手；fold 之前是 `undefined`，那時只回指示檔。
 * @param memorySources - 這次組裝的 `memory` 來源；fold 之前是空的。
 * @returns 給圍堵 backend 的保留清單。
 */
export function sharedReservedWrites(
  fs: FsService | undefined,
  memorySources: readonly string[] = [],
): readonly ReservedWrite[] {
  const files = INSTRUCTION_FILE_CANDIDATES.map((name) => ({
    path: `/${name}`,
    subtree: false,
    reason: INSTRUCTION_FILE_REASON,
  }));
  const memory = memorySources
    .filter((source) => source.startsWith(`${SHARED_WORKSPACE_PREFIX}/`))
    .map((source) => ({
      path: source.slice(SHARED_WORKSPACE_PREFIX.length),
      subtree: false,
      reason: MEMORY_SOURCE_REASON,
    }));
  if (fs === undefined) return [...files, ...memory];
  const routes = fs.offWorkspacePrefixes();
  const skills = fs
    .skillSources()
    .filter((source) => !isUnderAnyPrefix(source, routes))
    .map((source) => ({ path: source, subtree: true, reason: SKILL_SOURCE_REASON }));
  return [...files, ...memory, ...skills];
}
