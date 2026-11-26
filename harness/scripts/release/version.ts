/**
 * Release workflow 讀版號並核對輸入（[#1502](https://github.com/DemianLi/nexus-agent/issues/1502) 刀 2，Q4 (a)）。
 *
 * - 無參數：印出所有發版成員共用的那個版本（不同就失敗）。
 * - `--expect vX.Y.Z`：輸入值只拿來核對，要等於 manifest 的版本（`v` 前綴去掉再比），不等就失敗並兩邊都講。
 *
 * @module
 */

import { parseArgs } from 'node:util';

import { releaseMembers, sharedVersion } from './members.js';

/**
 * 核對輸入的版號等於 manifest 的版本。
 *
 * @param input - Release 輸入，例如 `v0.1.0`。
 * @param version - manifest 的共同版本。
 * @throws 格式不對或不相等。
 */
export function assertInputMatches(input: string, version: string): void {
  if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/u.test(input)) {
    throw new Error(`版號格式錯誤：${input}（應為 vX.Y.Z）`);
  }
  if (input.slice(1) !== version) {
    throw new Error(
      `輸入的版號 ${input} 與 manifest 的 ${version} 不同。版號先用 pnpm run release:bump 寫進 manifest、走 PR 合進去，再發版。`,
    );
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { expect: { type: 'string' } } });
  const version = sharedVersion(releaseMembers());
  if (values.expect !== undefined) assertInputMatches(values.expect, version);
  console.log(version);
}
