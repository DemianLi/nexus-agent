/**
 * 把版號寫進每一份發版成員的 manifest（[#1502](https://github.com/DemianLi/nexus-agent/issues/1502) 刀 2，Q4 (a)）。
 *
 * 照 dsh `scripts/release/bump.ts:1-15`：版號要「從 repo 讀得到，不是 CI 裡推出來的」。流程是：跑這支 → 開一張版號 PR → 合進
 * `develop` → `develop → main` → 到 Actions 執行 Release。**CI 從不寫 repo。** Release workflow 從 manifest 讀版號，輸入的
 * `vX.Y.Z` 只拿來核對兩者相同（`release-version.ts`）。
 *
 * **偏離 dsh，理由 2（產品需求超出 dsh 的射程）——不跑 `pnpm install --lockfile-only`、不自己 commit。** dsh 的 bump 兩件都做
 * （`scripts/release/bump.ts` 寫版號後 `install --lockfile-only`，再 `git add`／`git commit`）。這裡：
 * (1) lockfile：本 repo 的 `pnpm-lock.yaml` 不記 workspace 套件自己的版號（workspace 相依是 `link:`），實測 `release:bump patch`
 * 改了 40 份 manifest 之後 `pnpm install --lockfile-only --offline` 的 lockfile 與改之前逐位元相同，所以沒有東西要跟；
 * (2) commit：`develop` 禁止直接 push、一律走 PR，squash 後的 commit 標題是 PR 標題（`AGENTS.md`「標題格式」），本地 commit
 * 訊息會被丟掉；所以這支只改檔，commit 與 PR 標題（`release: …`）由人下。撤除條件：之後 workspace 版號進了 lockfile 就補 install。
 *
 * 用法：`pnpm run release:bump <major|minor|patch|x.y.z>`；加 `--dry-run` 只印不寫。1.0 之前的規則見 AGENTS.md「發版」。
 *
 * @module
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { ROOT } from '../workspace-packages.js';
import { releaseMembers, sharedVersion } from './members.js';

const VERSION = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/u;

/**
 * 依 semver 優先序比兩個版本。
 *
 * 照 dsh `scripts/release/bump.ts` 的 `compareVersions`：先比 x.y.z，相同再比 prerelease——沒有 prerelease 的大於有的
 * （`1.0.0 > 1.0.0-rc.1`），prerelease 逐欄比，數字欄位按數值（`rc.10 > rc.2`），數字欄位小於文字欄位，欄位少的小。
 *
 * @param left - 一個版本。
 * @param right - 另一個版本。
 * @returns 負數代表 `left` 較小，正數較大，0 相同。
 */
export function compareVersions(left: string, right: string): number {
  const [leftNumbers, leftPre] = splitVersion(left);
  const [rightNumbers, rightPre] = splitVersion(right);
  const numbers = leftNumbers.reduce(
    (found, part, index) => (found !== 0 ? found : part - rightNumbers[index]!),
    0,
  );
  if (numbers !== 0) return numbers;
  if (leftPre === undefined || rightPre === undefined) {
    if (leftPre === rightPre) return 0;
    return leftPre === undefined ? 1 : -1;
  }
  const leftFields = leftPre.split('.');
  const rightFields = rightPre.split('.');
  for (let index = 0; index < Math.max(leftFields.length, rightFields.length); index += 1) {
    const leftField = leftFields[index];
    const rightField = rightFields[index];
    if (leftField === undefined) return -1;
    if (rightField === undefined) return 1;
    if (leftField === rightField) continue;
    const leftNumeric = /^\d+$/u.test(leftField);
    const rightNumeric = /^\d+$/u.test(rightField);
    if (leftNumeric && rightNumeric) return Number(leftField) - Number(rightField);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftField < rightField ? -1 : 1;
  }
  return 0;
}

/** 把版本拆成 [major, minor, patch] 與 prerelease（沒有則 undefined）。 */
function splitVersion(version: string): [[number, number, number], string | undefined] {
  const match = VERSION.exec(version);
  if (match === null) throw new Error(`讀不懂版本：${version}`);
  return [
    [Number(match[1]), Number(match[2]), Number(match[3])],
    match[4] === undefined ? undefined : match[4].slice(1),
  ];
}

/**
 * 算出下一個版本。
 *
 * @param current - 目前版本（`x.y.z` 或帶 prerelease 的）。
 * @param spec - `major`、`minor`、`patch`，或明確的 `x.y.z`（可帶 prerelease）。
 * @returns 新版本。
 * @throws 目前版本讀不懂、明確版本格式不對、或依 semver 優先序沒有比目前大（含 prerelease 降版）。
 */
export function nextVersion(current: string, spec: string): string {
  const [[major, minor, patch]] = splitVersion(current);
  if (spec === 'major') return `${String(major + 1)}.0.0`;
  if (spec === 'minor') return `${String(major)}.${String(minor + 1)}.0`;
  if (spec === 'patch') return `${String(major)}.${String(minor)}.${String(patch + 1)}`;
  if (VERSION.exec(spec) === null) {
    throw new Error(`版本要是 major、minor、patch 或 x.y.z（可帶 prerelease），收到 ${spec}`);
  }
  if (compareVersions(spec, current) <= 0) {
    throw new Error(`新版本 ${spec} 要比目前的 ${current} 大`);
  }
  return spec;
}

/**
 * 把一份 manifest 的 `version` 換掉，**其餘位元組原樣**（不重排、不重新縮排）。
 *
 * @param text - manifest 原文。
 * @param version - 新版本。
 * @returns 新原文。
 * @throws 找不到第一個頂層的 `"version"`。
 */
export function replaceManifestVersion(text: string, version: string): string {
  const pattern = /^(\s*"version":\s*)"[^"]*"/mu;
  if (!pattern.test(text)) throw new Error('manifest 裡找不到 "version"');
  return text.replace(pattern, `$1"${version}"`);
}

/** 命令列入口。 */
function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { 'dry-run': { type: 'boolean', default: false } },
  });
  const [spec] = positionals;
  if (spec === undefined) {
    throw new Error('用法：pnpm run release:bump <major|minor|patch|x.y.z> [--dry-run]');
  }
  const members = releaseMembers();
  const current = sharedVersion(members);
  const to = nextVersion(current, spec);
  for (const member of members) {
    const path = join(ROOT, member.manifestPath);
    if (!values['dry-run']) {
      writeFileSync(path, replaceManifestVersion(readFileSync(path, 'utf8'), to));
    }
  }
  console.log(
    `release:bump：${current} → ${to}，${String(members.length)} 份 manifest${values['dry-run'] ? '（dry-run，沒寫）' : ''}。` +
      '接著：commit、開版號 PR；tag 等合併後由 Release workflow 建。',
  );
}

if (import.meta.main) main();
