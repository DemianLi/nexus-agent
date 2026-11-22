/**
 * 工作區的寫檔與改檔是暫存檔加 `rename` 的原子取代（[#1531](https://github.com/DemianLi/nexus-agent/issues/1531)）。
 *
 * 基座的 `write`／`edit` 是 `O_TRUNC` 就地覆寫。這一份驗：寫到一半失敗原檔不動、硬連結不寫穿、mode 保留、
 * 平行的 `edit` 不丟修改（含不同 backend 實例指同一個根）、錯誤字句跟基座一樣、`danger-full-access` 下 `..` 仍被擋，
 * 以及產品組裝上真的走到這條路。每一條都看磁碟，不只看回傳值。
 */

import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemBackend } from 'deepagents';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { lockCountForTest } from './atomic-workspace-write.js';
import type { AtomicWriteInternals } from './atomic-workspace-write.js';
import { createCliAgent } from './assembly-root.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import type { SandboxMode } from './contained-backend.js';
import { shippedPlugins, withScriptedModel } from './fixtures.js';
import { toAgentInvocation } from './messages.js';

const shipped = await shippedPlugins();

let base: string;
let root: string;
let outside: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'nexus-atomic-'));
  root = join(base, 'root');
  outside = join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** 基座的 errno 句子帶主機路徑，我們的不帶（#2201）：其餘字句相同。 */
const withoutErrnoPath = (error: string | undefined): string | undefined =>
  error?.replace(/, \w+ '[^']*'$/u, '');

function contained(
  mode?: SandboxMode,
  atomicInternals?: AtomicWriteInternals,
  rootDir = root,
): ContainedFilesystemBackend {
  return new ContainedFilesystemBackend({
    rootDir,
    ...(mode !== undefined && { mode }),
    ...(atomicInternals !== undefined && { atomicInternals }),
  });
}

/** 目錄裡有沒有暫存目錄殘留。 */
async function stagingLeft(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith('.tmpdir'));
}

const gate = (): { wait: Promise<void>; open: () => void } => {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
};

describe('硬連結不寫穿到根外', () => {
  const SECRET = '根外的祕密';

  async function hardLinked(): Promise<{ inside: string; secret: string }> {
    const secret = join(outside, 'secret.txt');
    await writeFile(secret, SECRET);
    const inside = join(root, 'inside.txt');
    await link(secret, inside);
    return { inside, secret };
  }

  it('write：根外那份逐位元組不變，根內是新內容，nlink 是 1', async () => {
    const { inside, secret } = await hardLinked();
    expect((await contained().write('/inside.txt', 'agent 寫的')).error).toBeUndefined();
    expect(await readFile(secret, 'utf8')).toBe(SECRET);
    expect(await readFile(inside, 'utf8')).toBe('agent 寫的');
    expect((await stat(inside)).nlink).toBe(1);
  });

  it('edit：同上', async () => {
    const { inside, secret } = await hardLinked();
    const result = await contained().edit('/inside.txt', '祕密', '機密');
    expect(result.error).toBeUndefined();
    expect(result.occurrences).toBe(1);
    expect(await readFile(secret, 'utf8')).toBe(SECRET);
    expect(await readFile(inside, 'utf8')).toBe('根外的機密');
    expect((await stat(inside)).nlink).toBe(1);
  });

  it('對照：裸的 FilesystemBackend 會寫穿（這條是這一張存在的理由）', async () => {
    const { secret } = await hardLinked();
    const bare = new FilesystemBackend({ rootDir: root, virtualMode: true });
    await bare.write('/inside.txt', '寫穿了');
    expect(await readFile(secret, 'utf8')).toBe('寫穿了');
  });
});

describe('寫到一半失敗，原檔不動', () => {
  const ORIGINAL = '原本的內容，一個位元組都不能少';

  it('write：在 sync 之前注入失敗，目標逐位元組等於寫前、沒有暫存目錄殘留、回傳 { error }', async () => {
    await writeFile(join(root, 'doc.md'), ORIGINAL);
    const backend = contained('workspace-write', {
      afterWrite: () => {
        throw new Error('磁碟寫滿');
      },
    });
    const result = await backend.write('/doc.md', '新內容'.repeat(1000));
    expect(result.error).toBe("Error writing file '/doc.md': 磁碟寫滿");
    expect(await readFile(join(root, 'doc.md'), 'utf8')).toBe(ORIGINAL);
    expect(await stagingLeft(root)).toEqual([]);
  });

  it('edit：同上', async () => {
    await writeFile(join(root, 'doc.md'), ORIGINAL);
    const backend = contained('workspace-write', {
      afterWrite: () => {
        throw new Error('磁碟寫滿');
      },
    });
    const result = await backend.edit('/doc.md', '原本', '新的');
    expect(result.error).toBe("Error editing file '/doc.md': 磁碟寫滿");
    expect(await readFile(join(root, 'doc.md'), 'utf8')).toBe(ORIGINAL);
    expect(await stagingLeft(root)).toEqual([]);
  });

  it('新檔寫到一半失敗：目標不會出現，也沒有暫存目錄殘留', async () => {
    const backend = contained('workspace-write', {
      afterWrite: () => {
        throw new Error('斷電');
      },
    });
    expect((await backend.write('/new.md', 'x')).error).toContain('斷電');
    await expect(stat(join(root, 'new.md'))).rejects.toThrow();
    expect(await stagingLeft(root)).toEqual([]);
  });

  it('寫成功之後暫存目錄也收乾淨', async () => {
    await contained().write('/ok.md', 'x');
    expect(await stagingLeft(root)).toEqual([]);
    expect(await readdir(root)).toEqual(['ok.md']);
  });

  it('暫存目錄清不掉時，錯誤訊息帶兩個原因', async () => {
    const backend = contained('workspace-write', {
      afterWrite: () => {
        throw new Error('磁碟寫滿');
      },
      removeStagingDir: () => Promise.reject(new Error('清不掉')),
    });
    const result = await backend.write('/a.md', 'x');
    expect(result.error).toContain('磁碟寫滿');
    expect(result.error).toContain('清不掉');
  });
});

describe('mode', () => {
  it('既有檔 0640，write 與 edit 之後仍是 0640', async () => {
    const file = join(root, 'shared.md');
    await writeFile(file, 'v1');
    await chmod(file, 0o640);
    await contained().write('/shared.md', 'v2');
    expect((await stat(file)).mode & 0o777).toBe(0o640);
    await contained().edit('/shared.md', 'v2', 'v3');
    expect((await stat(file)).mode & 0o777).toBe(0o640);
    expect(await readFile(file, 'utf8')).toBe('v3');
  });

  it('新檔是 0600（Q1 (a)），不受 umask 影響', async () => {
    const saved = process.umask(0o022);
    try {
      await contained().write('/fresh.md', 'x');
    } finally {
      process.umask(saved);
    }
    expect((await stat(join(root, 'fresh.md'))).mode & 0o777).toBe(0o600);
  });
});

describe('平行的 edit 不丟修改', () => {
  /** 排出交錯：第一個 edit 讀完就停住，第二個趕上來，再放第一個。 */
  async function race(
    first: ContainedFilesystemBackend,
    second: ContainedFilesystemBackend,
    g: ReturnType<typeof gate>,
  ): Promise<void> {
    const a = first.edit('/f.txt', 'AAA', 'aaa');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const b = second.edit('/f.txt', 'BBB', 'bbb');
    await new Promise((resolve) => setTimeout(resolve, 100));
    g.open();
    expect((await a).error).toBeUndefined();
    expect((await b).error).toBeUndefined();
  }

  it('同一個 backend：兩筆修改都留下來', async () => {
    await writeFile(join(root, 'f.txt'), 'AAA BBB');
    const g = gate();
    let held = false;
    const backend = contained('workspace-write', {
      afterEditRead: async () => {
        if (held) return;
        held = true;
        await g.wait;
      },
    });
    await race(backend, backend, g);
    expect(await readFile(join(root, 'f.txt'), 'utf8')).toBe('aaa bbb');
  });

  it('兩個不同的 backend 實例指同一個根（多條 thread 共用工作區）：兩筆修改都留下來', async () => {
    await writeFile(join(root, 'f.txt'), 'AAA BBB');
    const g = gate();
    let held = false;
    const first = contained('workspace-write', {
      afterEditRead: async () => {
        if (held) return;
        held = true;
        await g.wait;
      },
    });
    await race(first, contained(), g);
    expect(await readFile(join(root, 'f.txt'), 'utf8')).toBe('aaa bbb');
  });

  it('經不同別名（symlink 目錄）走到同一個檔也在同一把鎖裡（鎖鍵是 canonical 路徑）', async () => {
    await mkdir(join(root, 'real'));
    await symlink(join(root, 'real'), join(root, 'alias'));
    await writeFile(join(root, 'real/f.txt'), 'AAA BBB');
    const g = gate();
    let held = false;
    // danger-full-access：fence 不 canonicalize，交進來的路徑原樣，別名要靠鎖鍵自己 canonicalize 才對得上。
    const backend = contained('danger-full-access', {
      afterEditRead: async () => {
        if (held) return;
        held = true;
        await g.wait;
      },
    });
    const a = backend.edit('/real/f.txt', 'AAA', 'aaa');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const b = backend.edit('/alias/f.txt', 'BBB', 'bbb');
    await new Promise((resolve) => setTimeout(resolve, 100));
    g.open();
    await Promise.all([a, b]);
    expect(await readFile(join(root, 'real/f.txt'), 'utf8')).toBe('aaa bbb');
  });

  it('前一個失敗，下一個照樣跑；鎖表跑完是空的', async () => {
    await writeFile(join(root, 'f.txt'), 'AAA');
    const backend = contained();
    const [bad, good] = await Promise.all([
      backend.edit('/f.txt', '不存在', 'x'),
      backend.edit('/f.txt', 'AAA', 'aaa'),
    ]);
    expect(bad.error).toContain('String not found');
    expect(good.error).toBeUndefined();
    expect(await readFile(join(root, 'f.txt'), 'utf8')).toBe('aaa');
    expect(lockCountForTest()).toBe(0);
  });
});

describe('跟基座同一套字句與位元組', () => {
  /** 兩個各自獨立的根，內容一模一樣，一個給裸基座、一個給 contained。 */
  async function twin(
    mode: SandboxMode = 'danger-full-access',
  ): Promise<{ bare: FilesystemBackend; ours: ContainedFilesystemBackend; bareRoot: string }> {
    const bareRoot = join(base, 'bare-root');
    await mkdir(bareRoot);
    return {
      bare: new FilesystemBackend({ rootDir: bareRoot, virtualMode: true }),
      ours: contained(mode),
      bareRoot,
    };
  }

  /** 把兩個根裡的路徑換成佔位，字句才比得起來。 */

  it('edit 的 String not found 與 multiple occurrences 逐字相同', async () => {
    const { bare, ours, bareRoot } = await twin();
    for (const dir of [root, bareRoot]) await writeFile(join(dir, 'f.txt'), 'x x');
    expect((await ours.edit('/f.txt', 'zzz', 'y')).error).toBe(
      (await bare.edit('/f.txt', 'zzz', 'y')).error,
    );
    expect((await ours.edit('/f.txt', 'x', 'y')).error).toBe(
      (await bare.edit('/f.txt', 'x', 'y')).error,
    );
    expect((await ours.edit('/f.txt', '', 'y')).error).toBe(
      (await bare.edit('/f.txt', '', 'y')).error,
    );
    // replaceAll 成功：次數與內容一致。
    const a = await ours.edit('/f.txt', 'x', 'y', true);
    const b = await bare.edit('/f.txt', 'x', 'y', true);
    expect(a).toEqual(b);
    expect(await readFile(join(root, 'f.txt'), 'utf8')).toBe(
      await readFile(join(bareRoot, 'f.txt'), 'utf8'),
    );
  });

  it('edit 一個不存在的檔、改一個目錄：字句相同', async () => {
    const { bare, ours, bareRoot } = await twin();
    for (const dir of [root, bareRoot]) await mkdir(join(dir, 'd'));
    expect((await ours.edit('/nope.txt', 'a', 'b')).error).toBe(
      withoutErrnoPath((await bare.edit('/nope.txt', 'a', 'b')).error),
    );
    expect((await ours.edit('/d', 'a', 'b')).error).toBe((await bare.edit('/d', 'a', 'b')).error);
  });

  it('葉子是 symlink：write 的原句相同；edit 兩邊都不跟著 symlink（ELOOP）', async () => {
    const { bare, ours, bareRoot } = await twin();
    for (const dir of [root, bareRoot]) {
      await writeFile(join(dir, 'real.txt'), 'x');
      await symlink(join(dir, 'real.txt'), join(dir, 'ln.txt'));
    }
    expect((await ours.write('/ln.txt', 'y')).error).toBe((await bare.write('/ln.txt', 'y')).error);
    expect((await ours.edit('/ln.txt', 'x', 'y')).error).toBe(
      withoutErrnoPath((await bare.edit('/ln.txt', 'x', 'y')).error),
    );
    expect(await readFile(join(root, 'real.txt'), 'utf8')).toBe('x');
  });

  it('寫到目錄上：不動目錄，回 not a regular file', async () => {
    await mkdir(join(root, 'd'));
    const result = await contained().write('/d', 'x');
    expect(result.error).toBe("Error writing file '/d': not a regular file");
    expect((await stat(join(root, 'd'))).isDirectory()).toBe(true);
  });

  // #1813：照 dsh（`write.ts:75/:82/:124`，沒有依副檔名的分支）一律寫 UTF-8 文字。基座的 `write` 對非文字副檔名把內容當 base64
  // 解碼，那是已撤銷的偏離（`contained-backend.ts` 的 `write` 註解）：這裡同時釘住「我們寫文字」與「基座仍在解碼」——
  // 後一半翻了（基座升版改了語意），這條紅，提醒回頭看這個偏離還需不需要。
  it('一律寫 UTF-8 文字，不看副檔名；基座對非文字副檔名仍把內容當 base64（偏離的證據）', async () => {
    const { bare, ours, bareRoot } = await twin();
    const bytes = Buffer.from([0, 1, 2, 250, 251, 255, 0x89, 0x50]);
    const b64 = bytes.toString('base64');
    const textual = ['.md', '.svg', '.json', '.txt'];
    const nonText = ['.png', '.jpg', '.pdf', '.mp4', '.pptx', '.ogg', '.PNG'];
    for (const ext of [...textual, ...nonText]) {
      await ours.write(`/f${ext}`, b64);
      await bare.write(`/f${ext}`, b64);
      // 我們：寫進去的就是給的那段字。
      expect(await readFile(join(root, `f${ext}`), 'utf8')).toBe(b64);
      const theirs = await readFile(join(bareRoot, `f${ext}`));
      // 基座：文字副檔名同我們，非文字副檔名是解碼後的位元組。
      if (textual.includes(ext)) expect(theirs.toString('utf8')).toBe(b64);
      else expect(theirs).toEqual(bytes);
    }
  });

  it('純文字（不是 base64）寫到 .png：落盤就是那段文字，回成功', async () => {
    const result = await contained().write('/notes.png', '你好\n世界🙂\n');
    expect(result).toEqual({ path: '/notes.png', filesUpdate: null });
    expect(await readFile(join(root, 'notes.png'), 'utf8')).toBe('你好\n世界🙂\n');
  });

  it('覆蓋既有的 .png 純文字檔也是文字，保留 mode', async () => {
    await writeFile(join(root, 'p1.png'), 'just text\n', { mode: 0o640 });
    await chmod(join(root, 'p1.png'), 0o640);
    const result = await contained().write('/p1.png', 'hello world\n');
    expect(result.error).toBeUndefined();
    expect(await readFile(join(root, 'p1.png'), 'utf8')).toBe('hello world\n');
    expect((await stat(join(root, 'p1.png'))).mode & 0o777).toBe(0o640);
  });

  it('write 缺的父目錄會建（跟基座一樣）', async () => {
    await contained().write('/a/b/c.md', 'x');
    expect(await readFile(join(root, 'a/b/c.md'), 'utf8')).toBe('x');
  });
});

describe('danger-full-access 下 ".." 仍被基座的字面檢查擋住', () => {
  it('write 與 edit 都回 { error }，根外沒有出現檔案', async () => {
    const backend = contained('danger-full-access');
    await writeFile(join(base, 'x'), '不該被動');
    expect((await backend.write('/../x', '被改了')).error).toContain('traversal');
    expect((await backend.edit('/../x', '不該', '被')).error).toContain('traversal');
    expect(await readFile(join(base, 'x'), 'utf8')).toBe('不該被動');
    expect((await backend.write('/../new', 'x')).error).toContain('traversal');
    await expect(stat(join(base, 'new'))).rejects.toThrow();
  });
});

describe('產品組裝上真的走到原子寫入', () => {
  it('經 write_file 工具寫硬連結的檔：根外不被寫穿（拿掉覆寫就紅）', async () => {
    const secret = join(outside, 'secret.txt');
    await writeFile(secret, '根外的祕密');
    await link(secret, join(root, 'inside.txt'));
    const built = await createCliAgent(
      { live: false, workspace: root },
      withScriptedModel(shipped, [
        // 先讀後改：沒讀過的既有檔，write_file 會被 observation 擋下（FS_NOT_OBSERVED）。
        { content: '', toolCalls: [{ name: 'read_file', args: { file_path: '/inside.txt' } }] },
        {
          content: '',
          toolCalls: [
            { name: 'write_file', args: { file_path: '/inside.txt', content: '模型寫的' } },
          ],
        },
        { content: '寫好了。' },
      ]),
      root,
    );
    const detach = built.attachSession(built.sessions);
    try {
      await built.agent.invoke(toAgentInvocation('寫檔'), {
        configurable: { thread_id: 'atomic-wiring' },
      });
      expect(await readFile(secret, 'utf8')).toBe('根外的祕密');
      expect(await readFile(join(root, 'inside.txt'), 'utf8')).toBe('模型寫的');
    } finally {
      detach();
      await built.dispose();
    }
  }, 60_000);

  it('同一條 thread：read_file → write_file → edit_file → edit_file，每一步都不被判成過期', async () => {
    await writeFile(join(root, 'doc.md'), '第一版');
    const built = await createCliAgent(
      { live: false, workspace: root },
      withScriptedModel(shipped, [
        { content: '', toolCalls: [{ name: 'read_file', args: { file_path: '/doc.md' } }] },
        {
          content: '',
          toolCalls: [
            { name: 'write_file', args: { file_path: '/doc.md', content: '第二版 甲 乙' } },
          ],
        },
        {
          content: '',
          toolCalls: [
            {
              name: 'edit_file',
              args: { file_path: '/doc.md', old_string: '甲', new_string: 'A' },
            },
          ],
        },
        {
          content: '',
          toolCalls: [
            {
              name: 'edit_file',
              args: { file_path: '/doc.md', old_string: '乙', new_string: 'B' },
            },
          ],
        },
        { content: '做完了。' },
      ]),
      root,
    );
    const detach = built.attachSession(built.sessions);
    try {
      const result = await built.agent.invoke(toAgentInvocation('改檔'), {
        configurable: { thread_id: 'atomic-observation' },
      });
      const tools = result.messages.filter((message) => message.getType() === 'tool');
      expect(tools).toHaveLength(4);
      for (const message of tools) expect(message.text).not.toContain('FS_STALE_VERSION');
      expect(await readFile(join(root, 'doc.md'), 'utf8')).toBe('第二版 A B');
    } finally {
      detach();
      await built.dispose();
    }
  }, 60_000);
});
