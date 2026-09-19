/**
 * 瀏覽器會話密鑰檔（#424）：隨 dsh credentials 載體來的規則，一條一條釘住。
 */

import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BROWSER_SESSION_SECRET_FILE,
  loadOrCreateBrowserSessionSecret,
} from './browser-session-secret.js';

const POSIX = process.platform !== 'win32';

async function freshHome(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'nexus-secret-')), 'home');
}

async function homeWith(text: string, mode = 0o600): Promise<{ home: string; file: string }> {
  const home = await freshHome();
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = join(home, BROWSER_SESSION_SECRET_FILE);
  await writeFile(file, text, { mode });
  await chmod(file, mode);
  return { home, file };
}

describe('loadOrCreateBrowserSessionSecret', () => {
  it('沒有就建：目錄 0700、檔案 0600、帶版本的 32 bytes 密鑰；再讀一次拿回同一把', async () => {
    const home = await freshHome();
    const secret = await loadOrCreateBrowserSessionSecret(home);
    expect(secret.byteLength).toBe(32);

    const file = join(home, BROWSER_SESSION_SECRET_FILE);
    const record = JSON.parse(await readFile(file, 'utf8')) as { version: number; secret: string };
    expect(record.version).toBe(1);
    expect(Buffer.from(record.secret, 'base64url').equals(secret)).toBe(true);
    if (POSIX) {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(home)).mode & 0o777).toBe(0o700);
    }

    expect((await loadOrCreateBrowserSessionSecret(home)).equals(secret)).toBe(true);
  });

  it('兩個行程同時第一次啟動：拿到同一把，不留暫存檔', async () => {
    const home = await freshHome();
    const secrets = await Promise.all(
      Array.from({ length: 8 }, () => loadOrCreateBrowserSessionSecret(home)),
    );
    for (const secret of secrets) expect(secret.equals(secrets[0]!)).toBe(true);
    expect(await readdir(home)).toEqual([BROWSER_SESSION_SECRET_FILE]);
  });

  it('認不得的記錄明確失敗，而且檔案一個位元組都沒動', async () => {
    const good = Buffer.alloc(32, 5).toString('base64url');
    const cases: readonly [string, RegExp][] = [
      ['不是 JSON', /格式認不得/],
      [JSON.stringify(null), /格式認不得/],
      [JSON.stringify([1]), /格式認不得/],
      [JSON.stringify({ version: 2, secret: good }), /格式認不得/],
      [JSON.stringify({ secret: good }), /格式認不得/],
      [JSON.stringify({ version: 1, secret: 'short' }), /密鑰不合格/],
      [JSON.stringify({ version: 1, secret: 42 }), /密鑰不合格/],
      [
        JSON.stringify({ version: 1, secret: Buffer.alloc(31, 5).toString('base64url') }),
        /密鑰不合格/,
      ],
      [
        JSON.stringify({ version: 1, secret: Buffer.alloc(32, 5).toString('base64') }),
        /密鑰不合格/,
      ],
    ];
    for (const [text, message] of cases) {
      const { home, file } = await homeWith(text);
      await expect(loadOrCreateBrowserSessionSecret(home)).rejects.toThrow(message);
      expect(await readFile(file, 'utf8')).toBe(text);
    }
    // 對照：同一個寫法、合格的記錄讀得回來——上面紅的是內容，不是讀法。
    const { home } = await homeWith(JSON.stringify({ version: 1, secret: good }));
    expect((await loadOrCreateBrowserSessionSecret(home)).equals(Buffer.alloc(32, 5))).toBe(true);
  });

  it.skipIf(!POSIX)('其他使用者讀得到就拒絕啟動，並說出要跑的 chmod', async () => {
    const text = JSON.stringify({ version: 1, secret: Buffer.alloc(32, 6).toString('base64url') });
    for (const mode of [0o644, 0o640, 0o604, 0o660]) {
      const { home, file } = await homeWith(text, mode);
      await expect(loadOrCreateBrowserSessionSecret(home)).rejects.toThrow(`chmod 600 ${file}`);
      expect(await readFile(file, 'utf8')).toBe(text);
      expect((await stat(file)).mode & 0o777).toBe(mode);
    }
  });
});
