import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hostPluginRows, writeHostPluginsFile } from './host-plugins-file.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'host-plugins-'));
  dirs.push(dir);
  return dir;
}

describe('hostPluginRows', () => {
  it('NODE_EXTRA_CA_CERTS 沒設或只有空白：沒有 mcp 那一列', () => {
    expect(hostPluginRows({})).toEqual([]);
    expect(hostPluginRows({ NODE_EXTRA_CA_CERTS: '   ' })).toEqual([]);
  });

  it('只設代理、沒設根：不產生那一列（宿主只信 NODE_EXTRA_CA_CERTS 指的檔）', () => {
    expect(hostPluginRows({ HTTPS_PROXY: 'http://proxy.example:3128' })).toEqual([]);
  });

  it('有根沒代理：只有 roots，相對路徑照 cwd 解成絕對路徑', () => {
    expect(hostPluginRows({ NODE_EXTRA_CA_CERTS: 'certs/ca.pem' }, '/srv/nexus')).toEqual([
      { name: 'mcp', config: { roots: '/srv/nexus/certs/ca.pem' } },
    ]);
  });

  it('有根有代理：proxy 整個物件照 TS 同一份解法，noProxy 是使用者寫的加上本機項目，不帶 source', () => {
    const [row] = hostPluginRows({
      NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
      HTTPS_PROXY: 'http://proxy.example:3128',
      NO_PROXY: 'intranet.example',
    });
    expect(row?.config).toEqual({
      roots: '/etc/ca.pem',
      proxy: {
        httpsProxy: 'http://proxy.example:3128',
        noProxy: 'intranet.example,localhost,127.0.0.1,::1,[::1]',
      },
    });
  });

  it('只設 ALL_PROXY：兩個協定都用它，跟 TS 的解法一致', () => {
    const [row] = hostPluginRows({
      NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
      ALL_PROXY: 'http://all.example:8080',
    });
    expect(row?.config.proxy).toMatchObject({
      httpProxy: 'http://all.example:8080',
      httpsProxy: 'http://all.example:8080',
    });
  });

  it('SOCKS 代理不被接受：不寫 proxy（宿主收不了 SOCKS，TS 那邊會在啟動警告）', () => {
    const [row] = hostPluginRows({
      NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
      HTTPS_PROXY: 'socks5://proxy.example:1080',
    });
    expect(row?.config).toEqual({ roots: '/etc/ca.pem' });
  });
});

interface PluginVectors {
  readonly cwd: string;
  readonly cases: readonly {
    readonly name: string;
    readonly env: Record<string, string>;
    readonly file: readonly unknown[];
  }[];
}

describe('共用樣本 host-plugins-vectors.json（宿主的 plugins::parse 讀同一份）', () => {
  const vectors = JSON.parse(
    readFileSync(
      new URL('../../../native/sandbox-spawner/host-plugins-vectors.json', import.meta.url),
      'utf8',
    ),
  ) as PluginVectors;

  it('每個案例的產出等於樣本，寫成檔再讀回也一樣', async () => {
    expect(vectors.cases.length).toBeGreaterThan(0);
    const dir = await tempDir();
    for (const { name, env, file } of vectors.cases) {
      const rows = hostPluginRows(env, vectors.cwd);
      expect(rows, name).toEqual(file);
      const path = join(dir, 'host-plugins.json');
      writeHostPluginsFile(path, rows);
      expect(JSON.parse(await readFile(path, 'utf8')), name).toEqual(file);
    }
  });
});

describe('writeHostPluginsFile', () => {
  it('寫成宿主收的 JSON 陣列，權限 0600，不留暫存檔', async () => {
    const dir = await tempDir();
    const path = join(dir, 'host-plugins.json');
    writeHostPluginsFile(path, hostPluginRows({ NODE_EXTRA_CA_CERTS: '/etc/ca.pem' }));
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([
      { name: 'mcp', config: { roots: '/etc/ca.pem' } },
    ]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['host-plugins.json']);
  });

  it('整份取代：舊檔裡的列（含手寫的）不保留；環境沒設就寫成空陣列', async () => {
    const dir = await tempDir();
    const path = join(dir, 'host-plugins.json');
    await writeFile(path, JSON.stringify([{ name: 'mcp', config: { roots: '/old.pem' } }]));
    writeHostPluginsFile(path, hostPluginRows({}));
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([]);
  });

  it('寫不進去就丟錯，不留暫存檔', async () => {
    const dir = await tempDir();
    // 目標是一個目錄：rename 會失敗。
    const path = join(dir, 'host-plugins.json');
    await mkdir(path);
    expect(() => {
      writeHostPluginsFile(path, []);
    }).toThrow(`寫不了宿主的插件清單 ${path}`);
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
