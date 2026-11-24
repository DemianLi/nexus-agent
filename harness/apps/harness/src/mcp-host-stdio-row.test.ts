/** 交給宿主的 stdio `connection`（#2570 D2b-2）：環境怎麼合、哪些名字標成憑證、憑證值怎麼檢查。 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { InvalidCredentialError } from './api-key.js';
import type { ResolvedCredential } from './credentials.js';
import { hostStdioConnection } from './mcp-host-stdio-row.js';

const SECRET = 'FAKE-secret-value-0001';

function fromFile(value: string): ResolvedCredential {
  return { value, source: 'file', path: '/home/FAKE/.credentials.yaml' };
}

const PARENT = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/FAKE',
  LANG: 'C.UTF-8',
  GITHUB_TOKEN: 'FAKE-parent-token',
  NEXUS_HOME: '/FAKE/nexus',
} as const;

const BASE = {
  command: '/usr/bin/server',
  args: ['--stdio'],
  baseCwd: '/work',
  parentEnv: PARENT,
} as const;

describe('環境', () => {
  it('清過的父環境在前、設定的在後；名字像憑證的父變數與 NEXUS_ 開頭的不帶', () => {
    const row = hostStdioConnection({
      ...BASE,
      env: { LANG: 'zh_TW.UTF-8', EXTRA: 'literal' },
      credentialEnv: {},
    });
    expect(row.env).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/home/FAKE',
      LANG: 'zh_TW.UTF-8',
      EXTRA: 'literal',
    });
    expect(row.credentialEnv).toEqual([]);
  });

  it('command、args 原樣交出；cwd 一律是絕對路徑：省略用對話行程的、相對的照它解', () => {
    const row = hostStdioConnection({ ...BASE, env: {}, credentialEnv: {} });
    expect(row).toMatchObject({
      transport: 'stdio',
      command: '/usr/bin/server',
      args: ['--stdio'],
      cwd: '/work',
    });
    expect(hostStdioConnection({ ...BASE, cwd: 'sub', env: {}, credentialEnv: {} }).cwd).toBe(
      '/work/sub',
    );
    expect(hostStdioConnection({ ...BASE, cwd: '/srv', env: {}, credentialEnv: {} }).cwd).toBe(
      '/srv',
    );
  });

  it('command 不是絕對路徑就拒絕', () => {
    expect(() =>
      hostStdioConnection({ ...BASE, command: 'npx', env: {}, credentialEnv: {} }),
    ).toThrow('絕對路徑');
  });
});

describe('credentialEnv', () => {
  it('只標憑證代入的名字，字面值與父環境的不標', () => {
    const row = hostStdioConnection({
      ...BASE,
      env: { DB_PASSWORD: SECRET, EXTRA: 'literal' },
      credentialEnv: { DB_PASSWORD: { credential: 'db', hit: fromFile(SECRET) } },
    });
    expect(row.credentialEnv).toEqual(['DB_PASSWORD']);
    expect(row.env['DB_PASSWORD']).toBe(SECRET);
  });

  it('env 放的是修剪過的值（外掛代入的就是），憑證服務給的原值帶換行也收', () => {
    const row = hostStdioConnection({
      ...BASE,
      env: { DB_PASSWORD: SECRET },
      credentialEnv: { DB_PASSWORD: { credential: 'db', hit: fromFile(`${SECRET}\n`) } },
    });
    expect(row.env['DB_PASSWORD']).toBe(SECRET);
  });

  it('env 放的是沒修剪的值就拒絕：宿主只收修剪過的', () => {
    expect(() =>
      hostStdioConnection({
        ...BASE,
        env: { DB_PASSWORD: `${SECRET}\n` },
        credentialEnv: { DB_PASSWORD: { credential: 'db', hit: fromFile(`${SECRET}\n`) } },
      }),
    ).toThrow('修剪後的值不同');
  });

  it('名字不在 env 裡就拒絕', () => {
    expect(() =>
      hostStdioConnection({
        ...BASE,
        env: {},
        credentialEnv: { DB_PASSWORD: { credential: 'db', hit: fromFile(SECRET) } },
      }),
    ).toThrow('credentialEnv 的 DB_PASSWORD 不在 env 裡');
  });

  it('名字只出現在父環境裡也算不在 env 裡', () => {
    expect(() =>
      hostStdioConnection({
        ...BASE,
        parentEnv: { ...PARENT, SHARED: SECRET },
        env: {},
        credentialEnv: { SHARED: { credential: 'db', hit: fromFile(SECRET) } },
      }),
    ).toThrow('不在 env 裡');
  });

  it('env 的值與憑證修剪後的值不同就拒絕，訊息不含任何一個值', () => {
    const other = 'FAKE-other-value-0002';
    let message = '';
    try {
      hostStdioConnection({
        ...BASE,
        env: { DB_PASSWORD: other },
        credentialEnv: { DB_PASSWORD: { credential: 'db', hit: fromFile(SECRET) } },
      });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('env.DB_PASSWORD');
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain(other);
  });

  it('憑證值不到 8 個字元拒絕，訊息指名憑證與來源層、不含值', () => {
    let error: unknown;
    try {
      hostStdioConnection({
        ...BASE,
        env: { DB_PASSWORD: 'short' },
        credentialEnv: { DB_PASSWORD: { credential: 'db', hit: fromFile('short') } },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InvalidCredentialError);
    const message = (error as Error).message;
    expect(message).toContain('db（來自受管憑證檔 /home/FAKE/.credentials.yaml）');
    expect(message).toContain('不到 8 個字元');
    expect(message).not.toContain('short');
  });

  it('沒標成憑證的短值照收', () => {
    expect(
      hostStdioConnection({ ...BASE, env: { LANG: 'C' }, credentialEnv: {} }).env['LANG'],
    ).toBe('C');
  });
});

interface RowVector {
  readonly name: string;
  readonly input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd?: string;
    readonly baseCwd: string;
    readonly parentEnv: Readonly<Record<string, string>>;
    readonly env: Readonly<Record<string, string>>;
    readonly credentialEnv: Readonly<
      Record<string, { readonly credential: string; readonly value: string }>
    >;
  };
  readonly ts: { readonly row: unknown } | { readonly error: string };
}

const ROW_VECTORS = (
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL('../../../native/sandbox-spawner/credentials-vectors.json', import.meta.url),
      ),
      'utf8',
    ),
  ) as { stdioRow: RowVector[] }
).stdioRow;

describe('共用樣本 stdioRow（Rust 的 mcp_stdio.rs 跑同一份，把 TS 的輸出交給 Server::parse）', () => {
  it.each(ROW_VECTORS.map((v) => [v.name, v] as const))('%s', (_name, vector) => {
    const { input } = vector;
    const credentialEnv = Object.fromEntries(
      Object.entries(input.credentialEnv).map(([name, { credential, value }]) => [
        name,
        { credential, hit: fromFile(value) },
      ]),
    );
    const run = () =>
      hostStdioConnection({
        command: input.command,
        args: input.args,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        baseCwd: input.baseCwd,
        parentEnv: input.parentEnv,
        env: input.env,
        credentialEnv,
      });
    if ('error' in vector.ts) expect(run).toThrow(vector.ts.error);
    else expect(run()).toEqual(vector.ts.row);
  });
});
