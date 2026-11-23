/**
 * **`serve` 起動時檢查 `memory` 來源讀不讀得到**（[#2271](https://github.com/DemianLi/nexus-agent/issues/2271)）。
 *
 * 基座讀不到來源不拋錯也不警告，模型只看到 `(No memory loaded)`。有 `--workspace` 時新 thread 的 `/` 是私有根，來源寫成 `/MEMORY.md` 就會靜靜落空，
 * 所以起動時講一次。只警告，不擋啟動。
 *
 * @module
 */

import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { SHARED_WORKSPACE_PREFIX } from './thread-roots.js';

/** `path` 是讀得到的一般檔才回 true。會跟隨符號連結，所以指到 `--workspace` 外的連結也算讀得到，這裡不判。 */
async function readableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * 算出這份來源清單要印的警告。
 *
 * @param sources - 這次組裝的 `memory` 來源。
 * @param sharedRoot - `--workspace` 的主機路徑，新 thread 看到的 {@link SHARED_WORKSPACE_PREFIX}。
 * @returns 每個有問題的來源一行；都沒問題時是空的。
 */
export async function memorySourceWarnings(
  sources: readonly string[],
  sharedRoot: string,
): Promise<string[]> {
  const lines: string[] = [];
  for (const source of sources) {
    if (!source.startsWith(`${SHARED_WORKSPACE_PREFIX}/`)) {
      lines.push(
        `[記憶] 來源 "${source}" 不在 ${SHARED_WORKSPACE_PREFIX}/ 底下：新對話的 / 是各自的私有根，讀不到部署方放的檔。` +
          `要讀 --workspace 裡的檔，請把來源改成 ${SHARED_WORKSPACE_PREFIX}${source}。`,
      );
      continue;
    }
    const host = join(sharedRoot, source.slice(SHARED_WORKSPACE_PREFIX.length));
    if (!(await readableFile(host))) {
      lines.push(
        `[記憶] 來源 "${source}" 讀不到：${host} 不存在、不是檔，或沒有讀取權限。請放好這個檔，或修正來源。`,
      );
    }
  }
  return lines;
}
