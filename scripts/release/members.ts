/**
 * 發版的成員與版號（[#1502](https://github.com/DemianLi/nexus-agent/issues/1502) 刀 2）。
 *
 * 照 dsh `scripts/release/families.ts:365-371`：**所有成員共用一個版本**，一個 tag 才叫得出它。成員是根與 `apps/*`、`packages/*`；
 * `vendor/*` 不在內——它們各自跟著上游的版號（`cordis` 是 `4.0.0-rc.11`），不屬於我們的發版線。
 *
 * @module
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '../workspace-packages.js';

/** 一份參與發版的 manifest。 */
export interface ReleaseMember {
  /** manifest 的 `name`。 */
  readonly name: string;
  /** 相對於 repo 根的 manifest 路徑。 */
  readonly manifestPath: string;
  /** manifest 目前的 `version`。 */
  readonly version: string;
}

/**
 * 盤點發版成員：根、`apps/*`、`packages/*` 的 `package.json`。
 *
 * @param root - repo 根，省略即這個 repo。
 * @returns 依路徑排序的成員。
 * @throws manifest 沒有字串的 `version`。
 */
export function releaseMembers(root: string = ROOT): ReleaseMember[] {
  const paths = ['package.json'];
  for (const group of ['apps', 'packages']) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const path = `${group}/${entry.name}/package.json`;
      if (entry.isDirectory() && existsSync(join(root, path))) paths.push(path);
    }
  }
  return paths.sort().map((manifestPath) => {
    const manifest = JSON.parse(readFileSync(join(root, manifestPath), 'utf8')) as {
      name?: string;
      version?: unknown;
    };
    if (typeof manifest.version !== 'string') {
      throw new Error(`${manifestPath} 沒有字串的 version，發版成員都要有`);
    }
    return { name: manifest.name ?? manifestPath, manifestPath, version: manifest.version };
  });
}

/**
 * 要求整條發版線只有一個版本。
 *
 * @param members - {@link releaseMembers} 的結果。
 * @returns 那個共同的版本。
 * @throws 有不同版本；訊息列出每一份。
 */
export function sharedVersion(members: readonly ReleaseMember[]): string {
  const versions = new Set(members.map((member) => member.version));
  const [only] = versions;
  if (versions.size !== 1 || only === undefined) {
    const detail = members.map((member) => `${member.manifestPath}: ${member.version}`).join('\n');
    throw new Error(`發版成員必須共用同一個版本：\n${detail}`);
  }
  return only;
}
