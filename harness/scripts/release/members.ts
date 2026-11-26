/**
 * 發版的成員與版號（[#1502](https://github.com/DemianLi/nexus-agent/issues/1502) 刀 2）。
 *
 * 照 dsh `scripts/release/families.ts:365-371`：**所有成員共用一個版本**，一個 tag 才叫得出它。成員是根與 workspace 的每個套件（含 `web`），扣掉 {@link EXCLUDED_GROUPS}；
 * `harness/vendor/*` 不在內——它們各自跟著上游的版號（`cordis` 是 `4.0.0-rc.12`），不屬於我們的發版線。
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

/** 不參與發版的 workspace 群組：照 `pnpm-workspace.yaml` 的寫法。 */
export const EXCLUDED_GROUPS: readonly string[] = ['harness/vendor/*'];

/** `pnpm-workspace.yaml` 的 `packages:` 清單。 */
function workspaceGroups(root: string): string[] {
  const text = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  const groups: string[] = [];
  let inPackages = false;
  for (const line of text.split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s+-\s+['"]?([^'"#\s]+)['"]?\s*(#.*)?$/.exec(line);
    if (item !== null) groups.push(item[1]!);
    else if (/^\S/.test(line)) break;
  }
  return groups;
}

/**
 * 盤點發版成員：根與 workspace 每個套件（扣掉 {@link EXCLUDED_GROUPS}）的 `package.json`。
 *
 * @param root - repo 根，省略即這個 repo。
 * @returns 依路徑排序的成員。
 * @throws manifest 沒有字串的 `version`。
 */
export function releaseMembers(root: string = ROOT): ReleaseMember[] {
  const paths = ['package.json'];
  for (const group of workspaceGroups(root)) {
    if (EXCLUDED_GROUPS.includes(group)) continue;
    if (!group.endsWith('/*')) {
      if (existsSync(join(root, group, 'package.json'))) paths.push(`${group}/package.json`);
      continue;
    }
    const parent = group.slice(0, -2);
    const base = join(root, parent);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const path = `${parent}/${entry.name}/package.json`;
      if (entry.isDirectory() && existsSync(join(root, path))) paths.push(path);
    }
  }
  if (paths.length < 2) {
    throw new Error(
      `releaseMembers 在 ${root} 底下只掃到根：pnpm-workspace.yaml 列的群組掃到 0 個成員，目錄搬了，路徑沒跟著搬`,
    );
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
