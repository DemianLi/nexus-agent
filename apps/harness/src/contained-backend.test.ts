/**
 * 路徑圍堵的驗收（[#34](https://github.com/DemianLi/nexus-agent/issues/34) 的「圍堵驗收」）。
 *
 * 判準是 [#28](https://github.com/DemianLi/nexus-agent/issues/28) 收下的政策 4「test denial
 * through the executor」——這裡的 executor 是 **backend 的方法**，不是 middleware 也不是規則表。
 * 所以每一條都直接呼叫 `write` / `edit` / `delete`，並且**看磁碟**：擋沒擋住的答案在檔案內容上，
 * 不在回傳值的措辭上。
 *
 * 全部用真實磁碟（`mkdtemp`），不是 `StateBackend`——後者的「檔案」只是 state 裡的一個 map，
 * 擋住它證明不了路徑圍堵。
 */

import { mkdtemp, mkdir, readFile, symlink, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemBackend } from 'deepagents';
import { beforeEach, describe, expect, it } from 'vitest';
import { ContainedFilesystemBackend } from './contained-backend.js';
import type { ContainmentMode } from './contained-backend.js';

/** 一次測試用的地形：一個可寫根、一個根外的目錄，加一條從根指出去的 symlink。 */
interface Terrain {
  readonly root: string;
  readonly outside: string;
  /** 根外那個檔案的虛擬路徑——經由 `escape` 這條 symlink 看過去。 */
  readonly escapePath: string;
  /** 那個檔案在磁碟上的真實位置。 */
  readonly secretFile: string;
}

const SECRET = '這是根外的東西';

async function buildTerrain(): Promise<Terrain> {
  const base = await mkdtemp(join(tmpdir(), 'nexus-fence-'));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  const secretFile = join(outside, 'secret.txt');
  await writeFile(secretFile, SECRET);
  await symlink(outside, join(root, 'escape'));
  return { root, outside, escapePath: '/escape/secret.txt', secretFile };
}

function contained(root: string, mode?: ContainmentMode): ContainedFilesystemBackend {
  return new ContainedFilesystemBackend({ rootDir: root, ...(mode !== undefined && { mode }) });
}

let terrain: Terrain;
beforeEach(async () => {
  terrain = await buildTerrain();
});

/**
 * 基座的 `virtualMode` 擋不住 symlink——**這一組是刻意斷言缺陷的**。
 *
 * 兩個用途。一是它就是這個 class 存在的理由，寫成可執行的證據比寫在註解裡強；二是它是
 * 一條**升版絆索**（[#32](https://github.com/DemianLi/nexus-agent/issues/32) 的升版檢查清單
 * 精神）：哪天 deepagents 自己把 `write` / `edit` 補上 canonicalize，這一組會紅，而那正是
 * 我們該回頭看這個 class 還要不要留的時刻。紅了不是壞消息。
 */
describe('基座的 virtualMode 是純字串比對（升版絆索）', () => {
  it('write 與 edit 經 symlink 寫得出根外，delete 擋得住', async () => {
    const backend = new FilesystemBackend({ rootDir: terrain.root, virtualMode: true });

    await backend.write(terrain.escapePath, '寫穿了');
    expect(await readFile(terrain.secretFile, 'utf8')).toBe('寫穿了');

    await backend.edit(terrain.escapePath, '寫穿了', '又寫穿了');
    expect(await readFile(terrain.secretFile, 'utf8')).toBe('又寫穿了');

    // delete 是基座唯一補過的那個：`resolveDeletePath()` 會逐層 lstat 祖先。
    expect(await backend.delete(terrain.escapePath)).toMatchObject({ error: expect.any(String) });
  });

  it('".." 擋得住——字面上的穿越基座本來就查', async () => {
    const backend = new FilesystemBackend({ rootDir: terrain.root, virtualMode: true });
    expect(await backend.write('/../outside/via-dots.txt', 'x')).toMatchObject({
      error: expect.stringContaining('traversal'),
    });
  });
});

describe('ContainedFilesystemBackend 的 fence', () => {
  it('經 symlink 出去的 write 被拒，根外的檔案一個字都沒動', async () => {
    const backend = contained(terrain.root);

    const result = await backend.write(terrain.escapePath, '寫穿了');

    expect(result.error).toContain('落在可寫根之外');
    expect(await readFile(terrain.secretFile, 'utf8')).toBe(SECRET);
  });

  it('經 symlink 出去的 edit 與 delete 同樣被拒', async () => {
    const backend = contained(terrain.root);

    expect((await backend.edit(terrain.escapePath, SECRET, '改掉')).error).toContain(
      '落在可寫根之外',
    );
    expect((await backend.delete(terrain.escapePath)).error).toContain('落在可寫根之外');
    expect(await readFile(terrain.secretFile, 'utf8')).toBe(SECRET);
  });

  it('".." 也被拒，而且措辭是我們自己的那一套', async () => {
    const backend = contained(terrain.root);
    const result = await backend.write('/../outside/via-dots.txt', 'x');

    expect(result.error).toContain('[containment]');
    expect(result.error).toContain('".."');
  });

  // 擋得住是一半，另一半是「正常的路照樣走得通」。少了這一條，一個什麼都拒絕的 fence
  // 也會讓上面每一條測試通過。
  it('根裡面的路照樣寫得進去、改得動、刪得掉', async () => {
    const backend = contained(terrain.root);
    await mkdir(join(terrain.root, '筆記'));

    expect((await backend.write('/筆記/a.md', '第一版')).error).toBeUndefined();
    expect(await readFile(join(terrain.root, '筆記/a.md'), 'utf8')).toBe('第一版');

    expect((await backend.edit('/筆記/a.md', '第一版', '第二版')).error).toBeUndefined();
    expect(await readFile(join(terrain.root, '筆記/a.md'), 'utf8')).toBe('第二版');

    expect((await backend.delete('/筆記/a.md')).error).toBeUndefined();
    await expect(stat(join(terrain.root, '筆記/a.md'))).rejects.toThrow();
  });

  // symlink 本身不是罪，跑出根才是。這一條分得開「擋 symlink」與「擋逃逸」。
  it('指向根內的 symlink 走得通', async () => {
    const backend = contained(terrain.root);
    await mkdir(join(terrain.root, '實際位置'));
    await symlink(join(terrain.root, '實際位置'), join(terrain.root, '捷徑'));

    expect((await backend.write('/捷徑/b.md', '經捷徑寫的')).error).toBeUndefined();
    expect(await readFile(join(terrain.root, '實際位置/b.md'), 'utf8')).toBe('經捷徑寫的');
  });

  it('讀不經過 fence——讀的策略歸 permissions，兩層正交', async () => {
    const backend = contained(terrain.root);
    const result = await backend.read(terrain.escapePath);

    // 這是明文的分工，不是漏洞：#34 定案「讀一律通過」。
    expect(result).toMatchObject({ content: SECRET });
  });
});

describe('三個 mode', () => {
  it('read-only 擋掉所有變更', async () => {
    const backend = contained(terrain.root, 'read-only');

    for (const result of [
      await backend.write('/a.md', 'x'),
      await backend.edit('/a.md', 'x', 'y'),
      await backend.delete('/a.md'),
    ]) {
      expect(result.error).toContain('唯讀');
      expect(result.error).toContain('read-only');
    }
  });

  it('danger-full-access 是真的不設防——連 symlink 出去都放行', async () => {
    const backend = contained(terrain.root, 'danger-full-access');

    expect((await backend.write(terrain.escapePath, '逃生口')).error).toBeUndefined();
    expect(await readFile(terrain.secretFile, 'utf8')).toBe('逃生口');
  });

  it('省略即設防的那一個', () => {
    expect(contained(terrain.root).mode).toBe('workspace-write');
  });
});
