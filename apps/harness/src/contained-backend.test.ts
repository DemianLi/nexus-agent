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
import type { SandboxMode } from './contained-backend.js';

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

function contained(root: string, mode?: SandboxMode): ContainedFilesystemBackend {
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

  it('read 經目錄 symlink 讀得出根外', async () => {
    const backend = new FilesystemBackend({ rootDir: terrain.root, virtualMode: true });

    expect(await backend.read(terrain.escapePath)).toMatchObject({
      content: expect.stringContaining(SECRET),
    });
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
});

/** 讀取面圍堵的拒絕字句：跟寫入同一個 `[containment]` 形狀，不印出根外的實際位置。 */
const readDenied = (
  operation: string,
  path: string,
  mode: SandboxMode = 'workspace-write',
): string =>
  `[containment] 拒絕 ${operation} "${path}"：經符號連結解析之後落在根之外（mode: ${mode}）`;

/**
 * 讀取面的圍堵（[#1982](https://github.com/DemianLi/nexus-agent/issues/1982)）：經往外指的符號連結讀到根外的一律拒。
 *
 * 讀得到內容的入口有六個：`read`、`readRaw`、`ls`、`grep`、`glob`、`downloadFiles`。每一個入口至少有一條
 * 只靠它自己那道檢查的斷言。
 */
describe('讀取面的圍堵', () => {
  it('read：經往外指的目錄連結被拒', async () => {
    const result = await contained(terrain.root).read(terrain.escapePath);

    expect(result).toEqual({ error: readDenied('read', terrain.escapePath) });
  });

  it('readRaw：經往外指的目錄連結被拒', async () => {
    const result = await contained(terrain.root).readRaw(terrain.escapePath);

    expect(result).toEqual({ error: readDenied('readRaw', terrain.escapePath) });
  });

  it('ls：往外指的目錄連結本身列不出來', async () => {
    const result = await contained(terrain.root).ls('/escape');

    expect(result).toEqual({ error: readDenied('ls', '/escape') });
  });

  it('grep：起點經往外指的目錄連結被拒', async () => {
    const result = await contained(terrain.root).grep('根外', '/escape');

    expect(result).toEqual({ error: readDenied('grep', '/escape') });
  });

  it('glob：起點經往外指的目錄連結被拒', async () => {
    const result = await contained(terrain.root).glob('*.txt', '/escape');

    expect(result).toEqual({ error: readDenied('glob', '/escape') });
  });

  it('downloadFiles：根外那一筆 permission_denied，根內那一筆照常', async () => {
    await writeFile(join(terrain.root, 'inside.txt'), '根內');
    const result = await contained(terrain.root).downloadFiles([terrain.escapePath, '/inside.txt']);

    expect(result[0]).toEqual({
      path: terrain.escapePath,
      content: null,
      error: 'permission_denied',
    });
    expect(Buffer.from(result[1]?.content ?? []).toString('utf8')).toBe('根內');
  });

  it('從根搜尋不會經連結走到根外（rg 不跟樹內的連結）', async () => {
    const backend = contained(terrain.root);

    expect(await backend.grep('根外', '/')).toEqual({ matches: [] });
    expect(await backend.glob('**/*.txt', '/')).toEqual({ files: [] });
  });

  it('連結底下還不存在的路徑也是拒，不是 ENOENT', async () => {
    const result = await contained(terrain.root).read('/escape/nope.txt');

    expect(result).toEqual({ error: readDenied('read', '/escape/nope.txt') });
  });

  it('最後一段是往外指的檔案連結：拒', async () => {
    await symlink(terrain.secretFile, join(terrain.root, 'filelink.txt'));
    const result = await contained(terrain.root).read('/filelink.txt');

    expect(result).toEqual({ error: readDenied('read', '/filelink.txt') });
  });

  it('指向 harness home 的 .env：目錄連結與檔案連結都拒', async () => {
    const home = join(terrain.outside, 'home');
    await mkdir(home);
    await writeFile(join(home, '.env'), 'NEXUS_API_KEY=sk-假的');
    await symlink(home, join(terrain.root, 'homelink'));
    await symlink(join(home, '.env'), join(terrain.root, 'envlink'));
    const backend = contained(terrain.root);

    for (const path of ['/homelink/.env', '/envlink']) {
      const read = await backend.read(path);
      expect(read).toEqual({ error: readDenied('read', path) });
      expect(JSON.stringify(await backend.readRaw(path))).not.toContain('sk-假的');
    }
  });

  it('指向根內的目錄連結與檔案連結都照常讀', async () => {
    await mkdir(join(terrain.root, '實際位置'));
    await writeFile(join(terrain.root, '實際位置/a.md'), '根內的內容');
    await symlink(join(terrain.root, '實際位置'), join(terrain.root, '捷徑'));
    await symlink(join(terrain.root, '實際位置/a.md'), join(terrain.root, 'a-link.md'));
    const backend = contained(terrain.root);

    expect(await backend.read('/捷徑/a.md')).toMatchObject({ content: '根內的內容' });
    expect((await backend.ls('/捷徑')).files?.map((f) => f.path)).toEqual(['/捷徑/a.md']);
    expect(await backend.read('/a-link.md')).toMatchObject({ content: '根內的內容' });
  });

  it('根本身經連結進來的照常讀：比的是兩邊的實際位置', async () => {
    const alias = join(terrain.outside, 'root-alias');
    await symlink(terrain.root, alias);
    await writeFile(join(terrain.root, 'here.txt'), '在根裡');

    expect(await contained(alias).read('/here.txt')).toMatchObject({ content: '在根裡' });
  });

  it('read-only 也拒：那一格擋的是變更，不是讀', async () => {
    const result = await contained(terrain.root, 'read-only').read(terrain.escapePath);

    expect(result).toEqual({ error: readDenied('read', terrain.escapePath, 'read-only') });
  });

  it('danger-full-access 放行，跟寫入一致', async () => {
    const backend = contained(terrain.root, 'danger-full-access');

    expect(await backend.read(terrain.escapePath)).toMatchObject({ content: SECRET });
  });

  it('".."：基座回「Path traversal not allowed」，連根外的檔案都沒去碰', async () => {
    const backend = contained(terrain.root);

    for (const path of ['/../outside/secret.txt', '/escape/../../outside/secret.txt']) {
      const result = await backend.read(path);
      expect(result.error).toContain('Path traversal not allowed');
      expect(result.content).toBeUndefined();
    }
  });

  it('主機絕對路徑：被當成根底下的子路徑，ENOENT——讀不到真的那個檔', async () => {
    // `secretFile` 是主機上的真實絕對路徑。虛擬模式把它接在根底下，不是當成主機位置。
    const result = await contained(terrain.root).read(terrain.secretFile);

    expect(result.error).toContain('ENOENT');
    expect(result.content).toBeUndefined();
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

  // 標題刻意不寫「真的不設防」：基座的 lexical `..` 檢查仍在（`virtualMode` 不給關），
  // 所以這個 mode 放行的是 symlink 逃逸，不是 dsh 那種全開。
  it('danger-full-access 放行 symlink 逃逸', async () => {
    const backend = contained(terrain.root, 'danger-full-access');

    expect((await backend.write(terrain.escapePath, '逃生口')).error).toBeUndefined();
    expect(await readFile(terrain.secretFile, 'utf8')).toBe('逃生口');
  });

  it('省略即設防的那一個', () => {
    expect(contained(terrain.root).mode).toBe('workspace-write');
  });
});

/**
 * fence 的協議與覆蓋面——三條都是 [PR #62](https://github.com/DemianLi/nexus-agent/pull/62)
 * 的 review 實測出來的，不是想像的邊界。
 *
 * 前兩條講的是**同一件事的兩面**：fence 只有在「每一條進得來的路都經過它」而且「它報錯的
 * 方式模型看得懂」時才算數。第三條講的是覆蓋面——`write`/`edit`/`delete` 不是 backend 上
 * 僅有的變更方法。
 */
describe('fence 的協議與覆蓋面', () => {
  // `canonicalize()` 只把 ENOENT/ENOTDIR 當「還不存在」，其餘 rethrow。但變更方法**約定用
  // 回傳值報錯**，拋出去模型就看不到拒絕訊息了，agent loop 收到的是 exception。
  it('canonicalize 撞上 ELOOP 時回錯誤結果，不是拋錯', async () => {
    const backend = contained(terrain.root);
    await symlink(join(terrain.root, 'loop'), join(terrain.root, 'loop'));

    // 三個變更方法共用 `checkedPath`，所以三個都要守。
    expect((await backend.write('/loop/a.txt', 'x')).error).toContain('[containment]');
    expect((await backend.edit('/loop/a.txt', 'x', 'y')).error).toContain('[containment]');
    expect((await backend.delete('/loop/a.txt')).error).toContain('[containment]');
  });

  // 這一條不是圍堵漏洞（`~/../x` 仍會撞上 ".." 那條，`/~/x` 落在根內），是**死掉的防線**：
  // 補前置斜線那一步跑在檢查之前，`startsWith('~')` 因此永遠是 false。
  it('"~" 開頭的路徑被擋——補前置斜線不能把這條檢查吃掉', async () => {
    const backend = contained(terrain.root);
    expect((await backend.write('~/a.txt', 'x')).error).toContain('"~"');
  });

  // `uploadFiles` 是 `BackendProtocolV2` 上第四個會改檔案的方法。基座自己的
  // summarization middleware 就是走它做 history offload（用的是設定路徑，模型碰不到），
  // 但 fence 的覆蓋面不該取決於「目前剛好沒有工具把模型的路徑餵進來」。
  it('uploadFiles 一樣過 fence——經 symlink 出去被拒', async () => {
    const backend = contained(terrain.root);

    const [result] = await backend.uploadFiles([
      [terrain.escapePath, new TextEncoder().encode('繞過 fence')],
    ]);

    // 這裡斷言的是**錯誤碼**而不是那句拒絕訊息：`uploadFiles` 的協議只收四個
    // `FileOperationError`，`denial()` 那句話塞不進去。fence 唯一一處措辭不統一的地方，
    // 是被協議逼的，不是漏寫。
    expect(result?.error).toBe('permission_denied');
    expect(await readFile(terrain.secretFile, 'utf8')).toBe(SECRET);
  });

  it('根裡面的 uploadFiles 照樣寫得進去', async () => {
    const backend = contained(terrain.root);

    const [result] = await backend.uploadFiles([
      ['/上傳.md', new TextEncoder().encode('上傳的內容')],
    ]);

    expect(result?.error).toBeFalsy();
    expect(await readFile(join(terrain.root, '上傳.md'), 'utf8')).toBe('上傳的內容');
  });
});

// `--workspace /` 時可寫根是 `/`：包含判斷若用 `realRoot + sep` 前綴，`/` 加分隔符是 `//`，什麼都比不中，
// 根底下的每一筆寫入都會被誤判成「落在可寫根之外」（#1647）。
describe('可寫根是檔案系統根 `/`', () => {
  it('寫、改、刪根底下的檔都放行', async () => {
    const backend = contained('/');
    const virtual = join(terrain.root, 'x.txt');

    expect((await backend.write(virtual, '第一版')).error).toBeUndefined();
    expect(await readFile(virtual, 'utf8')).toBe('第一版');

    expect((await backend.edit(virtual, '第一版', '第二版')).error).toBeUndefined();
    expect(await readFile(virtual, 'utf8')).toBe('第二版');

    expect((await backend.delete(virtual)).error).toBeUndefined();
    await expect(stat(virtual)).rejects.toThrow();
  });

  it('uploadFiles 也放行', async () => {
    const [result] = await contained('/').uploadFiles([
      [join(terrain.root, '上傳.md'), new TextEncoder().encode('上傳的內容')],
    ]);

    expect(result?.error).toBeFalsy();
    expect(await readFile(join(terrain.root, '上傳.md'), 'utf8')).toBe('上傳的內容');
  });

  it('根就是 `/` 時，經 symlink 指到哪裡都還在根裡面：不是 fence 擋的範圍', async () => {
    const virtual = join(terrain.root, 'escape', 'again.txt');

    expect((await contained('/').write(virtual, '寫進去')).error).toBeUndefined();
    expect(await readFile(join(terrain.outside, 'again.txt'), 'utf8')).toBe('寫進去');
  });
});
