/**
 * 把版號寫進每一份發版成員的 manifest（[#1502](https://github.com/DemianLi/nexus-agent/issues/1502) 刀 2，Q4 (a)）。
 *
 * 照 dsh `scripts/release/bump.ts:1-15`：版號要「從 repo 讀得到，不是 CI 裡推出來的」。流程是：跑這支 → 開一張版號 PR → 合進
 * `develop` → `develop → main` → 到 Actions 執行 Release。**CI 從不寫 repo。** Release workflow 從 manifest 讀版號，輸入的
 * `vX.Y.Z` 只拿來核對兩者相同（`release-version.ts`）。
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
 * 算出下一個版本。
 *
 * @param current - 目前版本（`x.y.z` 或帶 prerelease 的）。
 * @param spec - `major`、`minor`、`patch`，或明確的 `x.y.z`。
 * @returns 新版本。
 * @throws 目前版本讀不懂、明確版本格式不對、或沒有比目前大。
 */
export function nextVersion(current: string, spec: string): string {
  const match = VERSION.exec(current);
  if (match === null) throw new Error(`讀不懂目前的版本：${current}`);
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  if (spec === 'major') return `${String(major + 1)}.0.0`;
  if (spec === 'minor') return `${String(major)}.${String(minor + 1)}.0`;
  if (spec === 'patch') return `${String(major)}.${String(minor)}.${String(patch + 1)}`;
  const explicit = VERSION.exec(spec);
  if (explicit === null) {
    throw new Error(`版本要是 major、minor、patch 或 x.y.z（可帶 prerelease），收到 ${spec}`);
  }
  const target = [Number(explicit[1]), Number(explicit[2]), Number(explicit[3])] as const;
  const now = [major, minor, patch] as const;
  const order = target.reduce(
    (found, part, index) => (found !== 0 ? found : part - now[index]!),
    0,
  );
  if (order < 0 || spec === current) {
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
