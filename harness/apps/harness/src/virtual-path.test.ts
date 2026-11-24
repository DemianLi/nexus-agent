/**
 * **共用的路徑規則跟真 backend 對得上**——[#693](https://github.com/DemianLi/nexus-agent/issues/693) 的絆索。
 *
 * `@nexus/core` 的 `hostPathOf` 是「模型給檔案工具的路徑落在磁碟哪裡」的唯一一份副本；規則的主人是基座
 * `FilesystemBackend` 在 `virtualMode` 下 private 的 `resolvePath`，問不到，所以只能照抄。抄得對不對，
 * 只有拿真的 `ContainedFilesystemBackend` 寫一次才知道。core 不能相依 harness，所以這條放在這裡，不在
 * 共用函式旁邊。
 *
 * 最後一格（`/<根的主機絕對路徑>/a.md`）是**加法式改法**會改到的形狀：sandbox-policy 檔頭「沒選的另一條路」
 * 是讓 backend 也收「主機根＋子路徑」。哪天有人照那條路改了 backend、漏改 `hostPathOf`，模型寫的檔落在
 * `<根>/a.md`，`hostPathOf` 卻算成 `<根>/<根>/a.md`——workspace-changes 的擷取落空，那筆改動從每輪摘要
 * 裡靜靜消失（git 工作區有快照涵蓋，看不出來）。前三格抓的是「改掉 `/x` 的意義」那一種。
 */

import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hostPathOf } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';

import { ContainedFilesystemBackend } from './contained-backend.js';

const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

/**
 * 一個新的工作區根，已經 `realpath` 過：macOS 的暫存目錄經過符號連結，「根的主機絕對路徑」要跟交給
 * backend 的 `rootDir` 是同一個字串。
 * @returns 工作區根。
 */
async function workspace(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nexus-virtual-path-')));
  cleanup.push(root);
  return root;
}

describe('hostPathOf 跟真的 ContainedFilesystemBackend 對得上', () => {
  it.each<[string, (root: string) => string]>([
    ['相對路徑', () => 'a.md'],
    ['虛擬絕對路徑', () => '/a.md'],
    ['子目錄', () => 'd/a.md'],
    ['主機絕對路徑（加法式改法會改到的形狀）', (root) => `${root}/a.md`],
  ])('%s：backend 寫的檔就落在共用函式算出的路徑', async (_label, pathFor) => {
    const root = await workspace();
    const path = pathFor(root);
    const backend = new ContainedFilesystemBackend({ rootDir: root, mode: 'workspace-write' });

    const result = await backend.write(path, `wrote ${path}\n`);

    // 先釘寫入本身成功，紅的時候才不會是「目錄沒建出來」之類的別的原因。
    expect(result.error).toBeUndefined();
    expect(await readFile(hostPathOf(root, path), 'utf8')).toBe(`wrote ${path}\n`);
  });
});
