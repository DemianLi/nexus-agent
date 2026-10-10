/**
 * 附件儲存（[#732](https://github.com/DemianLi/nexus-agent/issues/732)）：內容定址、原樣存、權限位元、去重、取消、
 * 模型讀得到。測試用的目錄放 `/var/tmp`（見記憶「夾具在 tmpdir 會撞上暫存目錄規則」），不碰真的 `~/.nexus-agent`。
 */

import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AttachmentError,
  AttachmentStore,
  ATTACHMENTS_PREFIX,
  attachmentsRootOf,
  fileLeafName,
} from './attachment-store.js';

let home: string;
let store: AttachmentStore;

beforeEach(async () => {
  home = await mkdtemp(join('/var/tmp', 'nexus-attachments-'));
  store = new AttachmentStore(attachmentsRootOf(home));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield Buffer.from(part);
}

const mode = async (path: string) => (await stat(path)).mode & 0o777;

describe('存一份檔案', () => {
  it('參照是內容定址的：雜湊、清過的檔名、確切位元組數；位元組原樣', async () => {
    const ref = await store.save({ data: chunks('你好，', 'world'), name: 'notes.txt' });
    const bytes = Buffer.from('你好，world');
    expect(ref).toEqual({
      attachmentId: `sha256:${sha(bytes)}`,
      name: 'notes.txt',
      bytes: bytes.byteLength,
    });
    expect(await readFile(store.pathOf(ref))).toEqual(bytes);
    expect(store.modelPathOf(ref)).toBe(
      `${ATTACHMENTS_PREFIX}/${sha(bytes).slice(0, 2)}/${sha(bytes)}/notes.txt`,
    );
  });

  it('權限位元：目錄 0700、物件與檔名都是唯讀 0400，沒有任何 group／other 位元', async () => {
    const ref = await store.save({ data: Buffer.from('x'), name: 'a.txt' });
    const digest = sha('x');
    for (const dir of [
      store.rootDir,
      join(store.rootDir, 'files'),
      join(store.rootDir, 'files', digest.slice(0, 2)),
      join(store.rootDir, 'files', digest.slice(0, 2), digest),
      join(store.rootDir, 'file-objects'),
      join(store.rootDir, 'file-objects', digest.slice(0, 2)),
      join(store.rootDir, 'staging'),
    ]) {
      expect(await mode(dir), dir).toBe(0o700);
    }
    expect(await mode(store.pathOf(ref))).toBe(0o400);
    expect(await mode(join(store.rootDir, 'file-objects', digest.slice(0, 2), digest))).toBe(0o400);
  });

  it('存完暫存目錄是空的（成功與失敗都不留）', async () => {
    await store.save({ data: Buffer.from('x'), name: 'a.txt' });
    expect(await readdir(join(store.rootDir, 'staging'))).toEqual([]);
  });

  it('同樣的內容只存一份物件；不同檔名各有自己的名字，都讀得到', async () => {
    const first = await store.save({ data: Buffer.from('same'), name: 'one.txt' });
    const second = await store.save({ data: chunks('sa', 'me'), name: 'two.txt' });
    expect(second.attachmentId).toBe(first.attachmentId);
    const objects = await readdir(join(store.rootDir, 'file-objects', sha('same').slice(0, 2)));
    expect(objects).toEqual([sha('same')]);
    expect((await stat(store.pathOf(first))).ino).toBe((await stat(store.pathOf(second))).ino);
    expect(await readFile(store.pathOf(second), 'utf8')).toBe('same');
  });

  it('同名同內容再存一次不拋（去重）', async () => {
    await store.save({ data: Buffer.from('same'), name: 'one.txt' });
    await expect(store.save({ data: Buffer.from('same'), name: 'one.txt' })).resolves.toMatchObject(
      { bytes: 4 },
    );
  });

  it('空檔案也存得下', async () => {
    const ref = await store.save({ data: chunks(), name: 'empty' });
    expect(ref.bytes).toBe(0);
    expect(ref.attachmentId).toBe(`sha256:${sha('')}`);
    expect(await readFile(store.pathOf(ref))).toEqual(Buffer.alloc(0));
  });

  it('超過上限：拋 ATTACHMENT_TOO_LARGE，什麼都沒留下', async () => {
    const error = await store
      .save({ data: chunks('1234', '5678'), name: 'big', maxBytes: 6 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AttachmentError);
    expect((error as AttachmentError).code).toBe('ATTACHMENT_TOO_LARGE');
    expect(await readdir(join(store.rootDir, 'staging'))).toEqual([]);
    expect(await readdir(join(store.rootDir, 'file-objects'))).toEqual([]);
  });

  it('取消：原樣拋出取消的原因（不是存不下），暫存檔收掉、沒有物件', async () => {
    const controller = new AbortController();
    async function* body(): AsyncGenerator<Uint8Array> {
      yield Buffer.from('first');
      controller.abort(new Error('停'));
      yield Buffer.from('second');
    }
    await expect(
      store.save({ data: body(), name: 'x', signal: controller.signal }),
    ).rejects.toThrow('停');
    expect(await readdir(join(store.rootDir, 'staging'))).toEqual([]);
    expect(await readdir(join(store.rootDir, 'file-objects'))).toEqual([]);
  });

  it('並行存同一份內容：都成功、只有一份物件', async () => {
    const refs = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.save({ data: chunks('par', 'allel'), name: `f${String(index)}.txt` }),
      ),
    );
    expect(new Set(refs.map((ref) => ref.attachmentId)).size).toBe(1);
    expect(await readdir(join(store.rootDir, 'file-objects', sha('parallel').slice(0, 2)))).toEqual(
      [sha('parallel')],
    );
  });

  it('根的祖先別人寫得動（0777 且沒有 sticky）：拒絕，並且下一次呼叫重試而不是快取失敗', async () => {
    // 先讓它成功一次建好目錄，再把上層改成人人可寫。
    const bad = new AttachmentStore(attachmentsRootOf(join(home, 'sub')));
    await bad.save({ data: Buffer.from('x') });
    const { chmod } = await import('node:fs/promises');
    await chmod(home, 0o777);
    const fresh = new AttachmentStore(attachmentsRootOf(join(home, 'sub')));
    const error = await fresh.save({ data: Buffer.from('y') }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AttachmentError);
    expect(String((error as Error).message)).toContain('附件目錄');
    await chmod(home, 0o700);
    await expect(fresh.save({ data: Buffer.from('y') })).resolves.toMatchObject({ bytes: 1 });
  });
});

describe('檔名清成葉名', () => {
  it.each([
    ['a.txt', 'a.txt'],
    ['/etc/passwd', 'passwd'],
    ['C:\\Users\\me\\secret.docx', 'secret.docx'],
    ['..', 'file'],
    ['.', 'file'],
    ['', 'file'],
    ['a/b/..', 'file'],
    ['bad<name>?.txt', 'bad_name__.txt'],
    ['trailing. . ', 'trailing'],
    ['con.txt', '_con.txt'],
    ['line\nbreak\u0000.txt', 'linebreak.txt'],
  ])('%j → %j', (input, expected) => {
    expect(fileLeafName(input)).toBe(expected);
  });

  it('沒給名字叫 file；過長的名字照位元組截在字元邊界', () => {
    expect(fileLeafName(undefined)).toBe('file');
    const long = fileLeafName('你'.repeat(200));
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(255);
    expect(long).toBe('你'.repeat(85));
  });

  it('存的時候清：路徑樣的名字不會逃出目錄', async () => {
    const ref = await store.save({ data: Buffer.from('x'), name: '../../evil.txt' });
    expect(ref.name).toBe('evil.txt');
    expect(store.pathOf(ref).startsWith(store.filesDir)).toBe(true);
  });
});

describe('參照的驗證', () => {
  it('雜湊不合格式、或檔名沒清過：pathOf 拋 INVALID_ATTACHMENT_REF', () => {
    for (const ref of [
      { attachmentId: 'sha256:zz', name: 'a', bytes: 1 },
      { attachmentId: `sha256:${sha('x')}`, name: '../a', bytes: 1 },
      { attachmentId: sha('x'), name: 'a', bytes: 1 },
    ]) {
      expect(() => store.pathOf(ref)).toThrow(AttachmentError);
    }
  });
});

describe('模型讀得到（唯讀路由）', () => {
  it('路由的根底下讀得到存的檔；寫、改都被擋', async () => {
    const ref = await store.save({ data: Buffer.from('第一行\n第二行\n'), name: '說明.txt' });
    const route = await store.readOnlyRoute();
    const relative = store.modelPathOf(ref).slice(ATTACHMENTS_PREFIX.length);
    const read = await route.read(relative);
    expect(read.error).toBeUndefined();
    expect(JSON.stringify(read)).toContain('第二行');
    const wrote = await route.write(relative, 'x');
    expect(wrote.error).toBeDefined();
    expect(await readFile(store.pathOf(ref), 'utf8')).toBe('第一行\n第二行\n');
  });

  it('路由根在還沒有任何上傳時也存在（第一次 ls 不會說根不存在）', async () => {
    const route = await store.readOnlyRoute();
    const listed = await route.ls('/');
    expect(listed.error).toBeUndefined();
  });

  it('路由只暴露 files：物件與暫存目錄讀不到', async () => {
    const ref = await store.save({ data: Buffer.from('x'), name: 'a.txt' });
    const route = await store.readOnlyRoute();
    const digest = ref.attachmentId.slice('sha256:'.length);
    const escaped = await route.read(`/../file-objects/${digest.slice(0, 2)}/${digest}`);
    expect(escaped.error).toBeDefined();
    await writeFile(join(store.rootDir, 'staging', 'leftover'), 'x');
    expect((await route.read('/../staging/leftover')).error).toBeDefined();
  });
});

describe('存一張圖（#732）', () => {
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAcAAAAFCAIAAAAG+GGPAAAAEklEQVR4nGP4z8CAibAIUUUUAKEvIt57lX2fAAAAAElFTkSuQmCC',
    'base64',
  );
  const facts = { mediaType: 'image/png', width: 7, height: 5 } as const;

  it('參照帶雜湊、位元組數、媒體類型與寬高；名字清成葉名，沒給就不記', async () => {
    const ref = await store.saveImage({ data: PNG, ...facts, name: '../shot.png' });
    expect(ref).toEqual({
      attachmentId: `sha256:${sha(PNG)}`,
      bytes: PNG.byteLength,
      name: 'shot.png',
      ...facts,
    });
    const unnamed = await store.saveImage({ data: PNG, ...facts });
    expect('name' in unnamed).toBe(false);
  });

  it('位元組原樣讀得回；物件 0400、目錄 0700；不建檔名的硬連結（files/ 底下沒有它）', async () => {
    const ref = await store.saveImage({ data: PNG, ...facts, name: 'shot.png' });
    expect(Buffer.from(await store.readImage(ref))).toEqual(PNG);
    const digest = sha(PNG);
    const object = join(store.rootDir, 'file-objects', digest.slice(0, 2), digest);
    expect(await mode(object)).toBe(0o400);
    expect(await mode(join(store.rootDir, 'file-objects', digest.slice(0, 2)))).toBe(0o700);
    expect(await readdir(store.filesDir)).toEqual([]);
    expect(await readdir(join(store.rootDir, 'staging'))).toEqual([]);
  });

  it('同樣的位元組存兩次、或先當檔案再當圖：只有一份物件', async () => {
    await store.save({ data: PNG, name: 'as-file.png' });
    await store.saveImage({ data: PNG, ...facts });
    await store.saveImage({ data: PNG, ...facts });
    const digest = sha(PNG);
    expect(await readdir(join(store.rootDir, 'file-objects', digest.slice(0, 2)))).toEqual([
      digest,
    ]);
  });

  /** 把物件換成別的位元組（物件是 0400，先放寬再寫）。 */
  const overwriteObject = async (original: Uint8Array, replacement: Uint8Array) => {
    const digest = sha(original);
    const object = join(store.rootDir, 'file-objects', digest.slice(0, 2), digest);
    await chmod(object, 0o600);
    await writeFile(object, replacement);
    return object;
  };

  it('讀的時候大小對不上參照（物件被截斷）：拋 ATTACHMENT_CORRUPT，不把來路不明的位元組交出去', async () => {
    const ref = await store.saveImage({ data: PNG, ...facts });
    await overwriteObject(PNG, PNG.subarray(0, 10));
    await expect(store.readImage(ref)).rejects.toMatchObject({
      code: 'ATTACHMENT_CORRUPT',
      message: expect.stringMatching(/大小對不上/) as unknown,
    });
  });

  it('同樣大小、內容被換掉：拋 ATTACHMENT_CORRUPT（只比長度抓不到這一種）', async () => {
    const ref = await store.saveImage({ data: PNG, ...facts });
    const swapped = Buffer.alloc(PNG.byteLength, 0x41);
    expect(swapped.byteLength).toBe(ref.bytes);
    await overwriteObject(PNG, swapped);
    await expect(store.readImage(ref)).rejects.toMatchObject({
      code: 'ATTACHMENT_CORRUPT',
      message: expect.stringMatching(/雜湊/) as unknown,
    });
  });

  it('只壞一個位元組：拋 ATTACHMENT_CORRUPT', async () => {
    const ref = await store.saveImage({ data: PNG, ...facts });
    const damaged = Buffer.from(PNG);
    damaged[damaged.byteLength - 1] = (damaged[damaged.byteLength - 1] ?? 0) ^ 0xff;
    await overwriteObject(PNG, damaged);
    await expect(store.readImage(ref)).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' });
  });

  describe('去重碰到既有物件也要驗', () => {
    it('壞圖物件在、同樣的圖再存一次：拋 ATTACHMENT_CORRUPT，不當成去重成功，物件不被動、暫存收乾淨', async () => {
      await store.saveImage({ data: PNG, ...facts });
      const damaged = Buffer.alloc(PNG.byteLength, 0x42);
      const object = await overwriteObject(PNG, damaged);
      await expect(store.saveImage({ data: PNG, ...facts })).rejects.toMatchObject({
        code: 'ATTACHMENT_CORRUPT',
      });
      expect(await readFile(object)).toEqual(damaged);
      expect(await readdir(join(store.rootDir, 'staging'))).toEqual([]);
    });

    it('壞物件在、當檔案再存一次：同樣拋 ATTACHMENT_CORRUPT，也不建檔名連結', async () => {
      const first = await store.save({ data: Buffer.from('hello world'), name: 'a.txt' });
      await overwriteObject(Buffer.from('hello world'), Buffer.from('HELLO WORLD'));
      await expect(
        store.save({ data: Buffer.from('hello world'), name: 'b.txt' }),
      ).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' });
      const aliasDir = join(store.filesDir, sha('hello world').slice(0, 2), sha('hello world'));
      expect(await readdir(aliasDir)).toEqual([first.name]);
    });

    it('好物件：去重照舊成功（圖與檔案各一次）', async () => {
      const a = await store.saveImage({ data: PNG, ...facts });
      const b = await store.saveImage({ data: PNG, ...facts });
      expect(b).toEqual(a);
      const one = await store.save({ data: Buffer.from('same'), name: 'one.txt' });
      const two = await store.save({ data: Buffer.from('same'), name: 'two.txt' });
      expect(two.attachmentId).toBe(one.attachmentId);
    });
  });

  it('物件不在、參照不合格式：AttachmentError', async () => {
    const ref = await store.saveImage({ data: PNG, ...facts });
    await expect(
      store.readImage({ ...ref, attachmentId: `sha256:${'0'.repeat(64)}` }),
    ).rejects.toThrow(AttachmentError);
    await expect(store.readImage({ ...ref, attachmentId: 'nope' })).rejects.toMatchObject({
      code: 'INVALID_ATTACHMENT_REF',
    });
  });
});

describe('檔案現在還在不在（#732）', () => {
  it('存完是 true；被清掉是 false；參照壞掉也是 false', async () => {
    const ref = await store.save({ data: Buffer.from('x'), name: 'a.txt' });
    expect(await store.hasFile(ref)).toBe(true);
    expect(await store.hasFile({ ...ref, attachmentId: 'nope' })).toBe(false);
    await rm(store.pathOf(ref));
    expect(await store.hasFile(ref)).toBe(false);
  });
});
