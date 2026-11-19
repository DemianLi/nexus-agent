import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HOST_BRIDGE_SERVICE } from '@nexus/host-bridge';
import { MCP_HOST_BRIDGE_SERVICE, mcpConfigSchema } from '@nexus/plugin-mcp';
import { afterEach, describe, expect, it } from 'vitest';

import { mcpHostRow, resolveOnPath } from './mcp-host-row-service.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function binDir(name: string, mode = 0o755): string {
  const dir = mkdtempSync(join(tmpdir(), 'host-row-bin-'));
  dirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, '#!/bin/sh\n');
  chmodSync(file, mode);
  return dir;
}

describe('外掛與 harness 對門面的名字', () => {
  it('外掛不相依 host-bridge 套件，兩邊的服務名由這一條釘住', () => {
    expect(MCP_HOST_BRIDGE_SERVICE).toBe(HOST_BRIDGE_SERVICE);
  });
});

describe('resolveOnPath', () => {
  it('沒有斜線的沿 PATH 找可執行檔', () => {
    const dir = binDir('my-server');
    expect(resolveOnPath('my-server', `/nonexistent:${dir}`)).toBe(join(dir, 'my-server'));
  });

  it('有斜線的原樣；找不到的原樣（交給宿主列拒絕並指名）；不可執行的跳過', () => {
    expect(resolveOnPath('./rel/server', '/usr/bin')).toBe('./rel/server');
    expect(resolveOnPath('nope-nope-nope', '/usr/bin')).toBe('nope-nope-nope');
    const dir = binDir('plain', 0o644);
    expect(resolveOnPath('plain', dir)).toBe('plain');
  });

  it('PATH 裡的相對項不收', () => {
    expect(resolveOnPath('sh', 'bin:.')).toBe('sh');
  });
});

describe('mcpHostRow', () => {
  it('http：連線欄位走 hostHttpConnection，其餘設定原樣帶，approval 不帶', () => {
    const config = mcpConfigSchema.parse({
      serverName: 'gh',
      connection: {
        transport: 'http',
        url: 'https://mcp.example.test/mcp',
        headers: { Authorization: { credential: 'GH', prefix: 'Bearer ' }, 'X-Plain': 'v' },
      },
      toolCallTimeoutMs: 1234,
      approval: { default: 'allow' },
    });
    const row = mcpHostRow(config, new Map([['GH', ' tokentoken123 ']]));
    expect(row).toEqual({
      serverName: 'gh',
      toolCallTimeoutMs: 1234,
      livenessTimeoutMs: config.livenessTimeoutMs,
      failOnStartupError: false,
      maxInstructionBytes: config.maxInstructionBytes,
      reconnect: config.reconnect,
      elicitation: true,
      connection: {
        transport: 'http',
        url: 'https://mcp.example.test/mcp',
        headers: { Authorization: 'Bearer tokentoken123', 'X-Plain': 'v' },
        credentialHeaders: { Authorization: 'Bearer ' },
      },
    });
    expect(row).not.toHaveProperty('approval');
  });

  it('stdio：command 沿 PATH 解成絕對路徑，env 的憑證引用進 credentialEnv（值修過頭尾）', () => {
    const dir = binDir('srv-bin');
    const config = mcpConfigSchema.parse({
      serverName: 'local',
      connection: {
        transport: 'stdio',
        command: 'srv-bin',
        args: ['--x'],
        cwd: '/work',
        env: { TOKEN: { credential: 'TK' }, MODE: 'fast' },
      },
    });
    const saved = process.env.PATH;
    process.env.PATH = dir;
    try {
      const row = mcpHostRow(config, new Map([['TK', '\nsecretsecret\n']]));
      expect(row.connection).toMatchObject({
        transport: 'stdio',
        command: join(dir, 'srv-bin'),
        args: ['--x'],
        cwd: '/work',
        credentialEnv: ['TOKEN'],
      });
      const env = (row.connection as { env: Record<string, string> }).env;
      expect(env.TOKEN).toBe('secretsecret');
      expect(env.MODE).toBe('fast');
    } finally {
      process.env.PATH = saved;
    }
  });

  it('stdio：設定的 env.PATH 優先於對話行程的 PATH', () => {
    const dir = binDir('only-in-config');
    const config = mcpConfigSchema.parse({
      serverName: 'local',
      connection: { transport: 'stdio', command: 'only-in-config', env: { PATH: dir } },
    });
    const row = mcpHostRow(config, new Map());
    expect(row.connection).toMatchObject({ command: join(dir, 'only-in-config') });
  });

  it('stdio：找不到的 command 以「要絕對路徑」拒絕，訊息指名它', () => {
    const config = mcpConfigSchema.parse({
      serverName: 'local',
      connection: { transport: 'stdio', command: 'definitely-not-installed-xyz' },
    });
    expect(() => mcpHostRow(config, new Map())).toThrow('definitely-not-installed-xyz');
  });

  it('憑證沒解析到值就拋，不含值', () => {
    const config = mcpConfigSchema.parse({
      serverName: 'gh',
      connection: {
        transport: 'http',
        url: 'https://mcp.example.test/mcp',
        headers: { Authorization: { credential: 'GH' } },
      },
    });
    expect(() => mcpHostRow(config, new Map())).toThrow('GH');
  });
});
