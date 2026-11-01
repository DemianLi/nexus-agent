/**
 * `orphan-staging-sweep.ts` 的單元：什麼算孤兒、掃描途中目錄項被換掉、暫放區、排程與上限。
 * 從 `runServe` 起的接線在 `thread-private-root.test.ts`。
 *
 * 目錄都在 `/var/tmp`，真的檔案系統。
 */

import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import type { Context } from '@nexus/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeFileAtomic } from './atomic-workspace-write.js';
import { launchOrphanStagingSweeper, STAGING_QUARANTINE_DIR_NAME } from './orphan-staging-sweep.js';
import type { OrphanStagingInternals, OrphanStagingSweeper } from './orphan-staging-sweep.js';

const fsMoves = vi.hoisted(() => ({ failNext: undefined as string | undefined }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: (from: string, to: string): Promise<void> => {
      const code = fsMoves.failNext;
      if (code === undefined) return actual.rename(from, to);
      fsMoves.failNext = undefined;
      return Promise.reject(Object.assign(new Error(code), { code }));
    },
  };
});

const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const STAGING = `.w.bin.7.${UUID}.tmpdir`;
const STARTED_AT = Date.now();
const LONG_AGO = new Date(STARTED_AT - 3_600_000);

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp('/var/tmp/nexus-orphan-staging-');
  temporary.push(dir);
  return dir;
}

interface Bed {
  readonly base: string;
  readonly root: string;
  /** 根外面、不該被碰到的目錄。 */
  readonly outside: string;
}

async function bed(): Promise<Bed> {
  const top = await scratch();
  const base = join(top, 'thread-roots');
  const root = join(base, 'thread-a');
  const outside = join(top, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside);
  return { base, root, outside };
}

/** 崩潰留下的暫存目錄。`entries` 是裡面的檔；mtime 早於起動。 */
async function plant(
  parent: string,
  name = STAGING,
  entries: readonly string[] = ['w.bin.tmp'],
): Promise<string> {
  const path = join(parent, name);
  await mkdir(path, { recursive: true, mode: 0o700 });
  for (const entry of entries) await writeFile(join(path, entry), 'HALF', 'utf8');
  await utimes(path, LONG_AGO, LONG_AGO);
  return path;
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

interface Launched {
  readonly sweeper: OrphanStagingSweeper;
  readonly warnings: string[];
  readonly dispose: () => Promise<void>;
}

function launch(
  base: string,
  internals: OrphanStagingInternals = {},
  startedAtMs = STARTED_AT,
): Launched {
  const warnings: string[] = [];
  let dispose: () => Promise<void> = () => Promise.resolve();
  const ctx = {
    effect(generator: () => Generator<() => Promise<void>>) {
      dispose = generator().next().value as () => Promise<void>;
    },
  } as unknown as Context;
  const sweeper = launchOrphanStagingSweeper(ctx, {
    base,
    startedAtMs,
    warn: (message) => warnings.push(message),
    internals,
  });
  return { sweeper, warnings, dispose: () => dispose() };
}

async function sweepOnce(
  bedding: Bed,
  internals?: OrphanStagingInternals,
  startedAtMs?: number,
): Promise<string[]> {
  const { sweeper, warnings } = launch(bedding.base, internals, startedAtMs);
  sweeper.sweep(bedding.root, 'thread-1');
  await sweeper.settled();
  return warnings;
}

describe('什麼算孤兒', () => {
  it('任何深度的孤兒都清掉，暫放區不留東西，使用者的檔不動', async () => {
    const b = await bed();
    await writeFile(join(b.root, 'keep.txt'), 'KEEP', 'utf8');
    const top = await plant(b.root);
    const deep = await plant(join(b.root, 'a', 'b'), `.x.y.z.12.${UUID}.tmpdir`, ['x.y.z.tmp']);
    expect(await sweepOnce(b)).toEqual([]);
    expect(await exists(top)).toBe(false);
    expect(await exists(deep)).toBe(false);
    expect(await readFile(join(b.root, 'keep.txt'), 'utf8')).toBe('KEEP');
    expect(await readdir(join(b.base, STAGING_QUARANTINE_DIR_NAME))).toEqual([]);
  });

  it('空的暫存目錄也算（崩在建檔之前）', async () => {
    const b = await bed();
    const path = await plant(b.root, STAGING, []);
    await sweepOnce(b);
    expect(await exists(path)).toBe(false);
  });

  it('mtime 不早於起動的不動：寫入中的那一份照常發佈', async () => {
    const b = await bed();
    const target = join(b.root, 'live.txt');
    let inspected = false;
    await writeFileAtomic(target, 'DONE', undefined, {
      afterWrite: async ({ stagingDir }) => {
        await sweepOnce(b, {}, Date.now() - 60_000);
        inspected = await exists(stagingDir);
      },
    });
    expect(inspected).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('DONE');
  });

  it.each([
    ['uuid 形狀不對', `.w.bin.7.not-a-uuid.tmpdir`, ['w.bin.tmp']],
    ['pid 不是數字', `.w.bin.x.${UUID}.tmpdir`, ['w.bin.tmp']],
    ['沒有開頭的點', `w.bin.7.${UUID}.tmpdir`, ['w.bin.tmp']],
    ['裡面多一個檔', STAGING, ['w.bin.tmp', 'mine.txt']],
    ['.tmp 名字跟目錄名對不上', STAGING, ['other.tmp']],
  ])('%s：不動', async (_label, name, entries) => {
    const b = await bed();
    const path = await plant(b.root, name, entries);
    await sweepOnce(b);
    expect(await exists(path)).toBe(true);
  });

  it('<basename>.tmp 是目錄或連結：不動', async () => {
    const b = await bed();
    const asDir = await plant(b.root, STAGING, []);
    await mkdir(join(asDir, 'w.bin.tmp'));
    await utimes(asDir, LONG_AGO, LONG_AGO);
    const asLink = await plant(b.root, `.y.7.${UUID}.tmpdir`, []);
    await writeFile(join(b.outside, 'secret'), 'S', 'utf8');
    await symlink(join(b.outside, 'secret'), join(asLink, 'y.tmp'));
    await utimes(asLink, LONG_AGO, LONG_AGO);
    await sweepOnce(b);
    expect(await exists(asDir)).toBe(true);
    expect(await exists(asLink)).toBe(true);
  });

  it('同名的一般檔不動；同名的連結不跟', async () => {
    const b = await bed();
    await writeFile(join(b.root, STAGING), 'FILE', 'utf8');
    await plant(b.outside);
    await symlink(join(b.outside, STAGING), join(b.root, `.w.bin.8.${UUID}.tmpdir`));
    await sweepOnce(b);
    expect(await readFile(join(b.root, STAGING), 'utf8')).toBe('FILE');
    expect(await exists(join(b.outside, STAGING, 'w.bin.tmp'))).toBe(true);
  });

  it('擁有者不是這個行程：不動', async () => {
    const b = await bed();
    const path = await plant(b.root);
    const real = process.geteuid?.() ?? 0;
    vi.spyOn(process, 'geteuid').mockReturnValue(real + 1);
    await sweepOnce(b);
    expect(await exists(path)).toBe(true);
  });

  it('連到根外的目錄不走進去', async () => {
    const b = await bed();
    const path = await plant(b.outside);
    await symlink(b.outside, join(b.root, 'away'));
    await sweepOnce(b);
    expect(await exists(path)).toBe(true);
  });
});

describe('掃描途中目錄項被換掉', () => {
  it('判斷之後換成連結：連結外的檔不受影響，連結本身移走', async () => {
    const b = await bed();
    await writeFile(join(b.outside, 'w.bin.tmp'), 'VICTIM', 'utf8');
    await plant(b.root);
    await sweepOnce(b, {
      beforeMove: async (path) => {
        await rm(path, { recursive: true });
        await symlink(b.outside, path);
      },
    });
    expect(await readFile(join(b.outside, 'w.bin.tmp'), 'utf8')).toBe('VICTIM');
    expect(await readdir(b.root)).toEqual([]);
    expect(await readdir(join(b.base, STAGING_QUARANTINE_DIR_NAME))).toEqual([]);
  });

  it('上一層換成連到根外的連結：根外同形的目錄不動', async () => {
    const b = await bed();
    const nested = join(b.root, 'a');
    await plant(nested);
    const victim = await plant(b.outside);
    let swapped = false;
    await sweepOnce(b, {
      beforeMove: async (path) => {
        if (swapped || !path.startsWith(nested)) return;
        swapped = true;
        await rename(nested, join(b.root, 'a-moved'));
        await symlink(b.outside, nested);
      },
    });
    expect(swapped).toBe(true);
    expect(await exists(victim)).toBe(true);
  });

  it('搬不進暫放區：留著不動，退回路徑式刪除的話這格會紅；warn 不帶路徑', async () => {
    const b = await bed();
    const path = await plant(b.root);
    const { sweeper, warnings } = launch(b.base);
    await sweeper.settled();
    await writeFile(join(b.base, STAGING_QUARANTINE_DIR_NAME), 'NOT-A-DIR', 'utf8');
    sweeper.sweep(b.root, 'thread-1');
    await sweeper.settled();
    expect(await exists(join(path, 'w.bin.tmp'))).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('thread-1');
    expect(warnings[0]).not.toContain(b.root);
  });

  it('判斷之後目錄項消失：沒有東西要清，不 warn', async () => {
    const b = await bed();
    await plant(b.root);
    const warnings = await sweepOnce(b, {
      beforeMove: (path) => rm(path, { recursive: true }),
    });
    expect(warnings).toEqual([]);
  });

  it('rename 回 EXDEV：留著不動，不退回路徑式刪除', async () => {
    const b = await bed();
    const path = await plant(b.root);
    fsMoves.failNext = 'EXDEV';
    const warnings = await sweepOnce(b);
    expect(await exists(join(path, 'w.bin.tmp'))).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('EXDEV');
    expect(warnings[0]).not.toContain(b.root);
  });
});

describe('暫放區與排程', () => {
  it('上一次崩潰留在暫放區的，起動時清掉', async () => {
    const b = await bed();
    await plant(join(b.base, STAGING_QUARANTINE_DIR_NAME), 'left-behind');
    const { sweeper } = launch(b.base);
    await sweeper.settled();
    expect(await exists(join(b.base, STAGING_QUARANTINE_DIR_NAME))).toBe(false);
  });

  it('同一個根一個行程只掃一次', async () => {
    const b = await bed();
    const { sweeper } = launch(b.base);
    sweeper.sweep(b.root, 'thread-1');
    await sweeper.settled();
    const later = await plant(b.root);
    sweeper.sweep(b.root, 'thread-1');
    await sweeper.settled();
    expect(await exists(later)).toBe(true);
  });

  it('撞到目錄項上限就停，warn 只帶 thread id', async () => {
    const b = await bed();
    for (const name of ['1', '2', '3']) await writeFile(join(b.root, name), 'x', 'utf8');
    const warnings = await sweepOnce(b, { maxEntries: 2 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('thread-1');
    expect(warnings[0]).not.toContain(b.root);
  });

  it('卸載等手上的掃描收斂，還沒輪到的不做', async () => {
    const b = await bed();
    const otherRoot = join(b.base, 'thread-b');
    await mkdir(otherRoot);
    const skipped = await plant(otherRoot);
    await plant(b.root);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { sweeper, dispose } = launch(b.base, {
      beforeMove: () => {
        entered();
        return held;
      },
    });
    sweeper.sweep(b.root, 'thread-1');
    sweeper.sweep(otherRoot, 'thread-2');
    await reached;
    let disposed = false;
    const disposing = dispose().then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(disposed).toBe(false);
    release();
    await disposing;
    expect(await exists(skipped)).toBe(true);
  });
});
