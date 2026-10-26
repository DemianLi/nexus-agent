/**
 * 附件回報參照之前逐層 fsync 目錄（[#1528](https://github.com/DemianLi/nexus-agent/issues/1528)，dsh
 * `attachment-local/src/store.ts:126-183`、`:272-302`、`:350-388`）。
 *
 * 照 `attachment-alias-atomic.test.ts` 的做法：包一層 `node:fs/promises`，記下目錄的 fsync、`link`、`rename` 的順序，
 * 在指定的地方注入失敗。斷電本身測不了，這裡只驗呼叫順序與失敗注入。附件根放 `/var/tmp`（見記憶「夾具在 tmpdir 會撞上
 * 暫存目錄規則」）。
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join, parse, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PNG_7X5 } from './image-fixtures.js';

const PNG = Buffer.from(PNG_7X5, 'base64');

/** 記下的呼叫：`sync <目錄>`、`link <目標>`、`rename <目標>`。路徑經 {@link label}。 */
const calls: string[] = [];
/** 要拋錯的呼叫（以記下的那一行比對）→ 錯誤碼；`open <目錄>` 也可以注入。 */
const failOn = new Map<string, string>();
let injected = 0;
let home = '';

/** home 底下換成 `~`，其他照絕對路徑。 */
function label(path: string): string {
  if (path === home) return '~';
  if (path.startsWith(`${home}/`)) return `~/${relative(home, path)}`;
  return path;
}

function maybeFail(call: string): void {
  const code = failOn.get(call);
  if (code === undefined) return;
  injected += 1;
  throw Object.assign(new Error(`${code}（注入：${call}）`), { code });
}

function wrapDirectoryHandle(target: FileHandle, name: string): FileHandle {
  return new Proxy(target, {
    get(real, property) {
      if (property === 'sync') {
        return async () => {
          calls.push(`sync ${name}`);
          maybeFail(`sync ${name}`);
          return real.sync();
        };
      }
      const value: unknown = Reflect.get(real, property, real);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(real)
        : value;
    },
  });
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (path: string, flags?: unknown, mode?: unknown) => {
      const p = String(path);
      const handle = await (async () => {
        // 目錄以 'r' 或數字 O_RDONLY（0）開；兩種都要認。
        if (flags === 'r' || flags === 0) maybeFail(`open ${label(p)}`);
        return actual.open(p, flags as never, mode as never);
      })();
      return flags === 'r' || flags === 0 ? wrapDirectoryHandle(handle, label(p)) : handle;
    },
    link: async (from: string, to: string) => {
      calls.push(`link ${label(String(to))}`);
      return actual.link(from, to);
    },
    rename: async (from: string, to: string) => {
      calls.push(`rename ${label(String(to))}`);
      return actual.rename(from, to);
    },
  };
});

const { AttachmentStore, attachmentsRootOf } = await import('./attachment-store.js');
const { MemorySaver } = await import('@langchain/langgraph');
const { createWireClient } = await import('@nexus/wire');
const { createNexusAgent } = await import('./agent-factory.js');
const { emptyCommandPoint, loopbackRequest, noSessions, TEST_BROWSER_AUTH } =
  await import('./fixtures.js');
const { ScriptedChatModel } = await import('./scripted-model.js');
const { createWireHandler } = await import('./wire-handler.js');

const POSIX = process.platform !== 'win32';
const temporary: string[] = [];

beforeEach(async () => {
  const base = await mkdtemp(join('/var/tmp', 'nexus-attach-durable-'));
  temporary.push(base);
  home = join(base, 'home');
  calls.length = 0;
  failOn.clear();
  injected = 0;
});

afterEach(async () => {
  failOn.clear();
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

function storeAt(at: string, warn: (line: string) => void = () => {}) {
  return new AttachmentStore(attachmentsRootOf(at), { warn });
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** home 往上每一層的父目錄，到檔案系統根（含根）。 */
function homeChain(at: string): string[] {
  const out: string[] = [];
  for (let level = at; level !== parse(at).root; level = dirname(level)) {
    out.push(`sync ${dirname(level)}`);
  }
  return out;
}

const syncs = () => calls.filter((call) => call.startsWith('sync '));

describe.runIf(POSIX)('A 新物件：回報之前每一層都 fsync 了', () => {
  it('home 到根、暫存目錄到 home、物件父目錄到 home、link 之後到根、別名同一組，依序', async () => {
    const store = storeAt(home);
    const digest = sha('hello');
    const ab = digest.slice(0, 2);

    await store.save({ data: new TextEncoder().encode('hello'), name: 'a.txt' });

    const v1 = '~/attachments/v1';
    expect(calls).toEqual([
      ...homeChain(home),
      // 暫存目錄 → home
      `sync ${v1}`,
      'sync ~/attachments',
      'sync ~',
      // 物件父目錄 → home
      `sync ${v1}/file-objects`,
      `sync ${v1}`,
      'sync ~/attachments',
      'sync ~',
      `link ${v1}/file-objects/${ab}/${digest}`,
      // link 之後 → 附件根（不含）
      `sync ${v1}/file-objects/${ab}`,
      `sync ${v1}/file-objects`,
      // 別名父目錄 → home
      `sync ${v1}/files/${ab}`,
      `sync ${v1}/files`,
      `sync ${v1}`,
      'sync ~/attachments',
      'sync ~',
      `link ${v1}/files/${ab}/${digest}/a.txt`,
      // 別名 link 之後 → 附件根（不含）
      `sync ${v1}/files/${ab}/${digest}`,
      `sync ${v1}/files/${ab}`,
      `sync ${v1}/files`,
    ]);
  });

  it('圖片也一樣：物件 link 之後逐層 fsync 到根（圖不建別名）', async () => {
    const store = storeAt(home);
    // 已經合格的 PNG 原樣通過規範化，落盤的就是這份位元組。
    const digest = createHash('sha256').update(PNG).digest('hex');
    const ab = digest.slice(0, 2);

    await store.saveImage({ data: PNG, mediaType: 'image/png' });

    const after = calls.slice(calls.indexOf(`link ~/attachments/v1/file-objects/${ab}/${digest}`));
    expect(after).toEqual([
      `link ~/attachments/v1/file-objects/${ab}/${digest}`,
      `sync ~/attachments/v1/file-objects/${ab}`,
      'sync ~/attachments/v1/file-objects',
    ]);
  });
});

describe.runIf(POSIX)('B「已存在」不等於「已落盤」', () => {
  it('別的行程剛建好 file-objects/<ab>：link 之前它在 file-objects 裡那一層照樣 fsync', async () => {
    const store = storeAt(home);
    const digest = sha('raced');
    const ab = digest.slice(0, 2);
    await mkdir(join(attachmentsRootOf(home), 'file-objects', ab), {
      recursive: true,
      mode: 0o700,
    });

    await store.save({ data: new TextEncoder().encode('raced'), name: 'r.txt' });

    const linkAt = calls.indexOf(`link ~/attachments/v1/file-objects/${ab}/${digest}`);
    const before = calls.slice(0, linkAt);
    expect(linkAt).toBeGreaterThan(0);
    expect(before).toContain('sync ~/attachments/v1/file-objects');
  });
});

describe.runIf(POSIX)('C 去重也 fsync', () => {
  it('同一份內容存兩次：第二次走 EEXIST，物件鏈與別名鏈照樣逐層 fsync', async () => {
    const store = storeAt(home);
    const digest = sha('twice');
    const ab = digest.slice(0, 2);
    await store.save({ data: new TextEncoder().encode('twice'), name: 't.txt' });
    calls.length = 0;

    await store.save({ data: new TextEncoder().encode('twice'), name: 't.txt' });

    const objectLink = calls.indexOf(`link ~/attachments/v1/file-objects/${ab}/${digest}`);
    expect(calls.slice(objectLink + 1, objectLink + 3)).toEqual([
      `sync ~/attachments/v1/file-objects/${ab}`,
      'sync ~/attachments/v1/file-objects',
    ]);
    // 別名同一個 inode、直接回的那一格也 fsync。
    const aliasLink = calls.indexOf(`link ~/attachments/v1/files/${ab}/${digest}/t.txt`);
    expect(calls.slice(aliasLink + 1)).toEqual([
      `sync ~/attachments/v1/files/${ab}/${digest}`,
      `sync ~/attachments/v1/files/${ab}`,
      'sync ~/attachments/v1/files',
    ]);
    expect(calls).not.toContain(`rename ~/attachments/v1/files/${ab}/${digest}/t.txt`);
  });
});

describe.runIf(POSIX)('D home 每個行程證明一次', () => {
  it('同一個 home 存兩次：home 以上每一層各 fsync 一次；另一個 home 的鏈再 fsync 一次', async () => {
    const store = storeAt(home);
    await store.save({ data: new TextEncoder().encode('one'), name: 'a.txt' });
    await store.save({ data: new TextEncoder().encode('two'), name: 'b.txt' });

    const parentOfHome = `sync ${dirname(home)}`;
    expect(syncs().filter((call) => call === parentOfHome)).toHaveLength(1);

    const otherHome = join(dirname(home), 'other');
    calls.length = 0;
    await storeAt(otherHome).save({ data: new TextEncoder().encode('one'), name: 'a.txt' });
    expect(syncs().filter((call) => call === parentOfHome)).toHaveLength(1);
    expect(calls.slice(0, homeChain(otherHome).length)).toEqual(homeChain(otherHome));
  });
});

describe.runIf(POSIX)('E 目錄 fsync 失敗不吞', () => {
  it('file-objects/<ab> 的 fsync 拋 EIO：save 拒絕 ATTACHMENT_STORE_FAILED、staging 沒殘留；撤掉注入再存成功', async () => {
    const store = storeAt(home);
    const digest = sha('eio');
    const ab = digest.slice(0, 2);
    failOn.set(`sync ~/attachments/v1/file-objects/${ab}`, 'EIO');

    const error = await store
      .save({ data: new TextEncoder().encode('eio'), name: 'e.txt' })
      .catch((e: unknown) => e);

    expect(injected).toBe(1);
    expect(error).toMatchObject({ name: 'AttachmentError', code: 'ATTACHMENT_STORE_FAILED' });
    expect(await readdir(join(attachmentsRootOf(home), 'staging'))).toEqual([]);

    failOn.clear();
    await expect(
      store.save({ data: new TextEncoder().encode('eio'), name: 'e.txt' }),
    ).resolves.toMatchObject({ attachmentId: `sha256:${digest}` });
  });

  it('圖片：附件根以下的 fsync 拋 EIO 一樣拒絕', async () => {
    const store = storeAt(home);
    const digest = createHash('sha256').update(PNG).digest('hex');
    failOn.set(`sync ~/attachments/v1/file-objects/${digest.slice(0, 2)}`, 'EIO');

    await expect(store.saveImage({ data: PNG, mediaType: 'image/png' })).rejects.toMatchObject({
      code: 'ATTACHMENT_STORE_FAILED',
    });
    expect(injected).toBe(1);
  });
});

describe.runIf(POSIX)('F 別名換掉的那一格也 fsync', () => {
  it('物件被刪掉重建、別名指著舊 inode：rename 之後別名鏈逐層 fsync', async () => {
    const store = storeAt(home);
    const digest = sha('swap');
    const ab = digest.slice(0, 2);
    await store.save({ data: new TextEncoder().encode('swap'), name: 's.txt' });
    await rm(join(attachmentsRootOf(home), 'file-objects', ab, digest));
    calls.length = 0;

    await store.save({ data: new TextEncoder().encode('swap'), name: 's.txt' });

    const renameAt = calls.indexOf(`rename ~/attachments/v1/files/${ab}/${digest}/s.txt`);
    expect(renameAt).toBeGreaterThan(0);
    expect(calls.slice(renameAt + 1)).toEqual([
      `sync ~/attachments/v1/files/${ab}/${digest}`,
      `sync ~/attachments/v1/files/${ab}`,
      'sync ~/attachments/v1/files',
    ]);
  });
});

describe.runIf(POSIX)('G home 以上的祖先開不了（#1528，偏離 3）', () => {
  it('開目錄時 EACCES：略過那一層、存成功、日誌講一次；同一層再遇到不重講', async () => {
    const warnings: string[] = [];
    const above = dirname(home);
    failOn.set(`open ${above}`, 'EACCES');

    await storeAt(home, (line) => warnings.push(line)).save({
      data: new TextEncoder().encode('ok'),
      name: 'o.txt',
    });
    expect(injected).toBe(1);
    expect(calls).not.toContain(`sync ${above}`);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(above);
    expect(warnings[0]).toContain('EACCES');

    // 另一個 home 也在同一層底下：再略過一次，不再講。
    await storeAt(join(above, 'other'), (line) => warnings.push(line)).save({
      data: new TextEncoder().encode('ok'),
      name: 'o.txt',
    });
    expect(injected).toBe(2);
    expect(warnings).toHaveLength(1);
  });

  it('EPERM 同上', async () => {
    failOn.set(`open ${dirname(home)}`, 'EPERM');
    await expect(
      storeAt(home).save({ data: new TextEncoder().encode('ok'), name: 'o.txt' }),
    ).resolves.toBeDefined();
    expect(injected).toBe(1);
  });

  it('home 以上的 fsync 本身拋 EIO：照 dsh 拒絕；證明沒做完不算數，撤掉注入再存會重新證明', async () => {
    const store = storeAt(home);
    failOn.set(`sync ${dirname(home)}`, 'EIO');
    await expect(
      store.save({ data: new TextEncoder().encode('ok'), name: 'o.txt' }),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_STORE_FAILED' });
    expect(injected).toBe(1);

    failOn.clear();
    calls.length = 0;
    await expect(
      store.save({ data: new TextEncoder().encode('ok'), name: 'o.txt' }),
    ).resolves.toBeDefined();
    expect(calls.slice(0, homeChain(home).length)).toEqual(homeChain(home));
  });

  it('home 以上開目錄拋別的錯（EIO）：照 dsh 拒絕', async () => {
    failOn.set(`open ${dirname(home)}`, 'EIO');
    await expect(
      storeAt(home).save({ data: new TextEncoder().encode('ok'), name: 'o.txt' }),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_STORE_FAILED' });
    expect(injected).toBe(1);
  });

  it('home 本身開不了（EACCES）：不是 home 以上，照 dsh 拒絕', async () => {
    failOn.set('open ~', 'EACCES');
    await expect(
      storeAt(home).save({ data: new TextEncoder().encode('ok'), name: 'o.txt' }),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_STORE_FAILED' });
    expect(injected).toBe(1);
  });
});

describe.runIf(POSIX)('H 接線：經 wire 的上傳路由', () => {
  it('上傳回收據之前，file-objects/<ab> 與別名目錄都已 fsync', async () => {
    const store = storeAt(home);
    const handler = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      attachments: store,
      createAgent: async () => {
        const built = await createNexusAgent({
          model: new ScriptedChatModel({ turns: [{ content: '好。' }] }) as never,
          checkpointer: new MemorySaver(),
          plugins: [],
          summarization: false,
          observationPolicy: false,
          attachments: store,
        });
        return {
          agent: built.agent as never,
          attachSessions: noSessions,
          commands: emptyCommandPoint(),
          dispose: built.dispose,
        };
      },
    });
    const client = createWireClient({
      baseUrl: 'http://wire.test',
      fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
    });
    try {
      const text = '上傳的內容\n';
      const digest = sha(text);
      const ab = digest.slice(0, 2);
      const outcome = await client.uploadFile('t1', new TextEncoder().encode(text), 'u.txt');
      expect(outcome.kind).toBe('ok');
      expect(calls).toContain(`sync ~/attachments/v1/file-objects/${ab}`);
      expect(calls).toContain(`sync ~/attachments/v1/files/${ab}/${digest}`);
    } finally {
      await handler.close();
    }
  });
});
