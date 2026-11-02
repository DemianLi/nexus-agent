/**
 * 附件儲存（[#732](https://github.com/DemianLi/nexus-agent/issues/732)）：內容定址、原樣存、權限位元、去重、取消、
 * 模型讀得到。測試用的目錄放 `/var/tmp`（見記憶「夾具在 tmpdir 會撞上暫存目錄規則」），不碰真的 `~/.nexus-agent`。
 */

import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { SessionEvent } from '@nexus/core';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scopeOfEvents } from './attachment-route.js';
import {
  AttachmentError,
  AttachmentStore,
  ATTACHMENTS_PREFIX,
  attachmentsRootOf,
  fileLeafName,
} from './attachment-store.js';
import {
  DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  REQUEST_IMAGE_POLICY,
  requestImagesRootOf,
  requestImageVariantId,
} from './request-image.js';

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

/** 日誌只有一則 turn/start，引用給定的檔案參照：路由的 scope 用（#1773）。 */
const scopeReferencing = (...refs: { attachmentId: string; name: string; bytes: number }[]) =>
  scopeOfEvents([
    {
      type: 'turn/start',
      seq: 0,
      time: 0,
      data: {
        kind: 'message',
        text: 't',
        attachments: refs.map((ref) => ({ type: 'file', ...ref })),
      },
    } as unknown as SessionEvent,
  ]);

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
    const route = await store.readOnlyRoute(scopeReferencing(ref));
    const relative = store.modelPathOf(ref).slice(ATTACHMENTS_PREFIX.length);
    const read = await route.read(relative);
    expect(read.error).toBeUndefined();
    expect(JSON.stringify(read)).toContain('第二行');
    const wrote = await route.write(relative, 'x');
    expect(wrote.error).toBeDefined();
    expect(await readFile(store.pathOf(ref), 'utf8')).toBe('第一行\n第二行\n');
  });

  it('路由根在還沒有任何上傳時也存在（第一次 ls 不會說根不存在）', async () => {
    const route = await store.readOnlyRoute(scopeReferencing());
    const listed = await route.ls('/');
    expect(listed.error).toBeUndefined();
  });

  it('路由只暴露 files：物件與暫存目錄讀不到', async () => {
    const ref = await store.save({ data: Buffer.from('x'), name: 'a.txt' });
    const route = await store.readOnlyRoute(scopeReferencing(ref));
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

  it('位元組沒動、參照的寬高或媒體類型被改過：拋 ATTACHMENT_CORRUPT（雜湊抓不到這一種，#1566）', async () => {
    const ref = await store.saveImage({ data: PNG, ...facts });
    for (const tampered of [
      { ...ref, width: 8 },
      { ...ref, height: 4 },
      { ...ref, mediaType: 'image/jpeg' as const },
    ]) {
      await expect(store.readImage(tampered), JSON.stringify(tampered)).rejects.toMatchObject({
        code: 'ATTACHMENT_CORRUPT',
        message: expect.stringMatching(/檔頭對不上/) as unknown,
      });
    }
    expect(Buffer.from(await store.readImage(ref))).toEqual(PNG);
  });

  it('物件根本不是圖（同一份內容以檔案存進來、參照被造成圖）：讀的時候拋 ATTACHMENT_CORRUPT', async () => {
    const text = Buffer.from('not an image at all');
    const file = await store.save({ data: text, name: 'x.txt' });
    const ref = { attachmentId: file.attachmentId, bytes: file.bytes, ...facts };
    await expect(store.readImage(ref)).rejects.toMatchObject({
      code: 'ATTACHMENT_CORRUPT',
      message: expect.stringMatching(/檔頭對不上/) as unknown,
    });
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

describe('檔名別名跟著物件（#1352）', () => {
  const body = Buffer.from('hello world, original');
  const objectOf = (ref: { attachmentId: string }) => {
    const digest = ref.attachmentId.slice('sha256:'.length);
    return join(attachmentsRootOfStore(), 'file-objects', digest.slice(0, 2), digest);
  };
  const attachmentsRootOfStore = () => store.rootDir;

  /** 把物件刪掉（模擬人工修復的第一步）；別名還在、指著舊的 inode。 */
  const removeObject = async (ref: { attachmentId: string }) => {
    await rm(objectOf(ref));
  };

  it('物件被刪掉重建、別名還指著舊 inode：重傳同名檔案後別名換成新物件的內容', async () => {
    const ref = await store.save({ data: body, name: 'a.txt' });
    const object = objectOf(ref);
    // 先把物件原地寫壞，別名與物件是同一個 inode，所以別名也讀到壞內容。
    await chmod(object, 0o600);
    await writeFile(object, Buffer.from('HELLO WORLD, DAMAGED!'));
    await chmod(object, 0o400);
    expect((await readFile(store.pathOf(ref))).toString()).toBe('HELLO WORLD, DAMAGED!');
    await removeObject(ref);

    await store.save({ data: body, name: 'a.txt' });

    expect(await readFile(store.pathOf(ref))).toEqual(body);
    expect((await stat(store.pathOf(ref))).ino).toBe((await stat(object)).ino);
    expect(await mode(store.pathOf(ref))).toBe(0o400);
    expect(await readdir(join(store.rootDir, 'staging'))).toEqual([]);
  });

  it('別名本來就跟物件同一個 inode：不動它（inode 與 mtime 都不變）', async () => {
    const ref = await store.save({ data: body, name: 'a.txt' });
    const before = await stat(store.pathOf(ref));
    await store.save({ data: body, name: 'a.txt' });
    const after = await stat(store.pathOf(ref));
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await readdir(join(store.rootDir, 'staging'))).toEqual([]);
  });

  it('只有不同名的別名會被換；同一份內容下別的檔名各自照舊', async () => {
    const a = await store.save({ data: body, name: 'a.txt' });
    const b = await store.save({ data: body, name: 'b.txt' });
    await removeObject(a);
    await store.save({ data: body, name: 'a.txt' });
    const object = objectOf(a);
    expect((await stat(store.pathOf(a))).ino).toBe((await stat(object)).ino);
    // b.txt 還指著舊 inode 而且內容還是對的：這次沒重傳它，不動。
    expect((await stat(store.pathOf(b))).ino).not.toBe((await stat(object)).ino);
    await store.save({ data: body, name: 'b.txt' });
    expect((await stat(store.pathOf(b))).ino).toBe((await stat(object)).ino);
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

describe('存圖之前規範化（#2033）', () => {
  const big = (background: string) =>
    sharp({ create: { width: 3000, height: 2000, channels: 3, background } })
      .png()
      .toBuffer();

  async function objectNames(): Promise<string[]> {
    const objects = join(store.rootDir, 'file-objects');
    const dirs = await readdir(objects).catch(() => [] as string[]);
    return (await Promise.all(dirs.map((dir) => readdir(join(objects, dir))))).flat();
  }

  it('縮過的圖：參照記規範化那一份的寬高與雜湊，另記 originalDimensions；讀得回同一份，原圖不留', async () => {
    const source = await big('#246');
    const ref = await store.saveImage({ data: source, mediaType: 'image/png', name: 'b.png' });
    expect(ref).toMatchObject({
      mediaType: 'image/jpeg',
      width: 2508,
      height: 1672,
      name: 'b.png',
      originalDimensions: { width: 3000, height: 2000 },
    });
    const stored = await store.readImage(ref);
    expect(ref.attachmentId).toBe(`sha256:${sha(stored)}`);
    expect(ref.bytes).toBe(stored.byteLength);
    expect(await objectNames()).toEqual([sha(stored)]);
  });

  it('一句話的圖整批先預備：有一張解不開，整批不寫', async () => {
    const good = await big('#462');
    const broken = good.subarray(0, 200);
    await expect(
      store.saveImages([
        { bytes: good, mediaType: 'image/png', label: '第 1 張圖' },
        { bytes: broken, mediaType: 'image/png', label: '第 2 張圖' },
      ]),
    ).rejects.toMatchObject({ name: 'ImageIntakeError', code: 'INVALID_IMAGE' });
    expect(await objectNames()).toEqual([]);
  });

  it('轉碼限流：同時湧入超過上限的圖時排隊，同時在跑的不超過上限', async () => {
    const limited = new AttachmentStore(attachmentsRootOf(home), {
      imageCompressionConcurrency: 2,
    });
    const sources = await Promise.all(['#111', '#222', '#333', '#444', '#555', '#666'].map(big));
    let peak = 0;
    const sampler = setInterval(() => {
      peak = Math.max(peak, limited.compression.active);
    }, 1);
    try {
      await Promise.all(sources.map((data) => limited.saveImage({ data, mediaType: 'image/png' })));
    } finally {
      clearInterval(sampler);
    }
    expect(peak).toBe(2);
    expect(limited.compression.active).toBe(0);
  });

  it('併發上限不在 1 到 8 的整數就建不起來', () => {
    for (const bad of [0, 9, 1.5, Number.NaN]) {
      expect(
        () => new AttachmentStore(attachmentsRootOf(home), { imageCompressionConcurrency: bad }),
        String(bad),
      ).toThrow(/imageCompressionConcurrency/);
    }
    expect(
      () => new AttachmentStore(attachmentsRootOf(home), { imageCompressionConcurrency: 8 }),
    ).not.toThrow();
  });

  it('規範化之前落盤的原圖（帶 EXIF 6、參照記檔頭的軸）照樣讀得回', async () => {
    const raw = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#a26' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    // 規範化之前落盤的圖就是位元組原樣進 `file-objects/`，寬高記檔頭的軸；同一份物件以檔案存進來即可。
    const file = await store.save({ data: raw, name: 'old.jpg' });
    const legacy = {
      attachmentId: file.attachmentId,
      mediaType: 'image/jpeg',
      bytes: file.bytes,
      width: 40,
      height: 20,
    } as const;
    expect(Buffer.from(await store.readImage(legacy))).toEqual(raw);
  });
});

describe('送模型的那一份（#2033）', () => {
  /** 規範化之前落盤的圖：位元組原樣進 `file-objects/`，參照記檔頭的軸（同上面「照樣讀得回」那一條的造法）。 */
  async function legacyImage(
    raw: Buffer,
    mediaType: 'image/jpeg' | 'image/png',
    width: number,
    height: number,
  ) {
    const file = await store.save({ data: raw, name: 'old' });
    return {
      attachmentId: file.attachmentId,
      mediaType,
      bytes: file.bytes,
      width,
      height,
    } as const;
  }
  const turnedBig = () =>
    sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#a26' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
  const cachePath = (ref: { attachmentId: string }) => {
    const id = requestImageVariantId(ref, REQUEST_IMAGE_POLICY);
    return join(requestImagesRootOf(home), id.slice(0, 2), id);
  };
  /** 數限流器跑了幾件（只有轉碼走它）。 */
  function countTransforms(target: AttachmentStore): () => number {
    let runs = 0;
    const limiter = target.compression;
    const run = limiter.run.bind(limiter);
    limiter.run = (task) => {
      runs += 1;
      return run(task);
    };
    return () => runs;
  }

  it('規範化之前落盤的大圖（EXIF 6）：轉正、縮到 2048² 以內；快取在 cache/attachments/request-images，0600', async () => {
    const legacy = await legacyImage(await turnedBig(), 'image/jpeg', 3000, 2000);
    const version = await store.readRequestImage(legacy);
    expect(version).toMatchObject({ mediaType: 'image/jpeg', width: 1672, height: 2508 });
    const meta = await sharp(version.data).metadata();
    expect(meta).toMatchObject({ width: 1672, height: 2508, space: 'srgb' });
    expect(meta.orientation).toBeUndefined();
    expect(await readFile(cachePath(legacy))).toEqual(Buffer.from(version.data));
    expect(await mode(cachePath(legacy))).toBe(0o600);
    // 落盤那一份不動。
    expect(Buffer.from(await store.readImage(legacy)).byteLength).toBe(legacy.bytes);
  });

  it('新收、規範化過但超過 1 MiB 的圖：落盤那一份不動，送模型的再壓到 1 MiB 以內', async () => {
    const noisy = await sharp({
      create: {
        width: 2048,
        height: 2048,
        channels: 3,
        background: '#888',
        noise: { type: 'gaussian', mean: 128, sigma: 15 },
      },
    })
      .png()
      .toBuffer();
    const ref = await store.saveImage({ data: noisy, mediaType: 'image/png' });
    expect(ref.bytes).toBeGreaterThan(DEFAULT_REQUEST_IMAGE_MAX_BYTES);
    const version = await store.readRequestImage(ref);
    expect(version.data.byteLength).toBeLessThanOrEqual(DEFAULT_REQUEST_IMAGE_MAX_BYTES);
    expect(version).toMatchObject({ mediaType: 'image/jpeg', width: 2048, height: 2048 });
  });

  it('第二次讀快取，不再轉碼；快取裡那一份就是送出的那一份', async () => {
    const legacy = await legacyImage(await turnedBig(), 'image/jpeg', 3000, 2000);
    const transforms = countTransforms(store);
    await store.readRequestImage(legacy);
    expect(transforms()).toBe(1);
    const planted = await sharp({
      create: { width: 10, height: 15, channels: 3, background: '#000' },
    })
      .jpeg()
      .toBuffer();
    await writeFile(cachePath(legacy), planted);
    const again = await store.readRequestImage(legacy);
    expect(transforms()).toBe(1);
    expect(Buffer.from(again.data)).toEqual(planted);
    expect(again).toMatchObject({ width: 10, height: 15 });
  });

  it('同一張圖同時要兩次：只轉一次，兩邊拿到同一份', async () => {
    const legacy = await legacyImage(await turnedBig(), 'image/jpeg', 3000, 2000);
    const transforms = countTransforms(store);
    const [a, b] = await Promise.all([
      store.readRequestImage(legacy),
      store.readRequestImage(legacy),
    ]);
    expect(transforms()).toBe(1);
    expect(a).toBe(b);
  });

  it('轉碼走限流：同時要好幾張不同的圖，同時在跑的不超過上限', async () => {
    const limited = new AttachmentStore(attachmentsRootOf(home), {
      imageCompressionConcurrency: 2,
    });
    const refs = await Promise.all(
      ['#111', '#222', '#333', '#444', '#555'].map(async (background) => {
        const raw = await sharp({ create: { width: 3000, height: 2000, channels: 3, background } })
          .png()
          .toBuffer();
        const file = await limited.save({ data: raw, name: 'old.png' });
        return {
          attachmentId: file.attachmentId,
          mediaType: 'image/png',
          bytes: file.bytes,
          width: 3000,
          height: 2000,
        } as const;
      }),
    );
    let peak = 0;
    const sampler = setInterval(() => {
      peak = Math.max(peak, limited.compression.active);
    }, 1);
    try {
      await Promise.all(refs.map((ref) => limited.readRequestImage(ref)));
    } finally {
      clearInterval(sampler);
    }
    expect(peak).toBe(2);
  });

  it('落盤那一份不見了：就算快取還在也拋（attachments/ 被清掉的舊訊息照舊換成佔位字）', async () => {
    const legacy = await legacyImage(await turnedBig(), 'image/jpeg', 3000, 2000);
    await store.readRequestImage(legacy);
    const digest = legacy.attachmentId.slice('sha256:'.length);
    await rm(join(store.rootDir, 'file-objects', digest.slice(0, 2), digest), { force: true });
    await expect(store.readRequestImage(legacy)).rejects.toBeInstanceOf(AttachmentError);
  });

  it('快取寫不進去：這一次照樣回那一份，伺服器日誌講一次', async () => {
    const warnings: string[] = [];
    const warned = new AttachmentStore(attachmentsRootOf(home), {
      warn: (line) => warnings.push(line),
    });
    const raw = await turnedBig();
    const file = await warned.save({ data: raw, name: 'old.jpg' });
    const legacy = {
      attachmentId: file.attachmentId,
      mediaType: 'image/jpeg',
      bytes: file.bytes,
      width: 3000,
      height: 2000,
    } as const;
    await writeFile(join(home, 'cache'), 'not a directory');
    const version = await warned.readRequestImage(legacy);
    expect(version).toMatchObject({ width: 1672, height: 2508 });
    expect(warnings).toEqual([expect.stringContaining('送模型的圖寫不進快取') as unknown]);
  });
});
