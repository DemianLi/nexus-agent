/**
 * 受管憑證檔的 `stat` 本身失敗（`ENOENT` 以外，例如 `EACCES`）時，跟讀檔、解析失敗一樣處理（#2667）。
 *
 * 用 mock 造錯，不 chmod 父目錄：CI 以 root 跑時 chmod 造不出 `EACCES`。
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

import { CREDENTIALS_FILE, createCredentialService } from './credentials.js';
import { loadLaunchEnv } from './launch-env.js';

const KEY = 'NVIDIA_API_KEY';

let root: string;
let home: string;
let file: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'credentials-stat-'));
  home = join(root, 'home');
  mkdirSync(home);
  mkdirSync(join(root, 'project'));
  file = join(home, CREDENTIALS_FILE);
  writeFileSync(file, `version: 1\nrefs:\n  ${KEY}: good-value\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
});

afterEach(() => {
  vi.mocked(fs.statSync).mockRestore();
  rmSync(root, { recursive: true, force: true });
});

function service(warn: (line: string) => void) {
  const launchEnv = loadLaunchEnv({
    cwd: join(root, 'project'),
    home,
    target: {},
    warn: () => undefined,
  });
  return createCredentialService({ home, launchEnv, store: true, warn });
}

function failStatWith(code: string): void {
  vi.mocked(fs.statSync).mockImplementation(() => {
    throw Object.assign(new Error(`${code}: permission denied, stat '${file}'`), { code });
  });
}

describe('stat 本身失敗（#2667）', () => {
  it('讀好過一次：保留最後一份並警告一次，不拋', () => {
    const warned: string[] = [];
    const credentials = service((line) => warned.push(line));
    expect(credentials.resolve(KEY)?.value).toBe('good-value');

    failStatWith('EACCES');
    expect(credentials.resolve(KEY)?.value).toBe('good-value');
    expect(credentials.resolve(KEY)?.value).toBe('good-value');
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('重載失敗');
    expect(warned[0]).toContain('EACCES');
  });

  it('還沒讀好過：照舊拋', () => {
    failStatWith('EACCES');
    expect(() => service(() => undefined).check()).toThrow('EACCES');
  });
});
