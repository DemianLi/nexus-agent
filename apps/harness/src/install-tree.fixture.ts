/**
 * 安裝樹（`apps/harness`）上「有沒有多出檔」的量具（[#1416](https://github.com/DemianLi/nexus-agent/issues/1416) PR 2）。
 *
 * Loader 的 `createResolve` 上游會在 `baseUrl` 所屬專案根建 `.cordis/{.gitignore,resolve.mjs}`；`vendor/loader`
 * 本地修改第 9 條讓宿主給解析函式、不再建。這裡量頂層的檔名（不含 `node_modules`）與 `.cordis/` 底下的檔，
 * 前後一比就知道動作有沒有往安裝樹寫東西。
 */

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `apps/harness`：這個檔在 `src/` 底下。 */
export const INSTALL_TREE = dirname(dirname(fileURLToPath(import.meta.url)));

/** 排序過的清單：頂層檔名（不含 `node_modules`）加 `.cordis/` 底下的檔。 */
export function installTreeListing(): string[] {
  const top = readdirSync(INSTALL_TREE).filter((name) => name !== 'node_modules');
  const helper = join(INSTALL_TREE, '.cordis');
  const inside = existsSync(helper) ? readdirSync(helper).map((name) => `.cordis/${name}`) : [];
  return [...top, ...inside].sort();
}
