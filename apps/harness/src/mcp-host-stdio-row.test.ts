/** 交給宿主的 stdio `connection`（#2570 D2b-2）：環境怎麼合、哪些名字標成憑證、憑證值怎麼檢查。 */

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

const BASE = { command: '/usr/bin/server', args: ['--stdio'], parentEnv: PARENT } as const;

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

  it('command、args、cwd 原樣交出；沒給 cwd 就不帶那一欄', () => {
    const row = hostStdioConnection({ ...BASE, env: {}, credentialEnv: {} });
    expect(row).toMatchObject({
      transport: 'stdio',
      command: '/usr/bin/server',
      args: ['--stdio'],
    });
    expect('cwd' in row).toBe(false);
    expect(hostStdioConnection({ ...BASE, cwd: '/work', env: {}, credentialEnv: {} }).cwd).toBe(
      '/work',
    );
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

  it('交出去的值是修過頭尾空白的', () => {
    const row = hostStdioConnection({
      ...BASE,
      env: { DB_PASSWORD: `${SECRET}\n` },
      credentialEnv: { DB_PASSWORD: { credential: 'db', hit: fromFile(`${SECRET}\n`) } },
    });
    expect(row.env['DB_PASSWORD']).toBe(SECRET);
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

  it('env 的值與憑證解析到的不同就拒絕，訊息不含任何一個值', () => {
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
