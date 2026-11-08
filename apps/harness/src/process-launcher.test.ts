import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  childExecArgv,
  isPrintOnly,
  launchProcessModel,
  pdeathsigHazards,
  processModelSetting,
  SERVE_FLAG_TAKES_VALUE,
  resolveProcessModel,
  splitServeArgv,
  supervisorLaunch,
  type PdeathsigProbe,
} from './process-launcher.js';
import { PROCESS_MODEL_ENTRY_NAME } from './settings/process-model.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function patchFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'process-launcher-'));
  dirs.push(dir);
  const path = join(dir, 'patch.yml');
  await writeFile(path, content);
  return path;
}

describe('splitServeArgv', () => {
  it('前台拿 --process-model 以外的全部，對話行程只拿組裝要的', () => {
    const argv = [
      '--port',
      '0',
      '--process-model',
      'per-thread',
      '--live',
      '--patch=/a.yml',
      '--patch',
      '/b.yml',
      '--workspace',
      '/w',
      '--trusted-host',
      'nexus.example',
    ];
    expect(splitServeArgv(argv)).toEqual({
      front: [
        '--port',
        '0',
        '--live',
        '--patch=/a.yml',
        '--patch',
        '/b.yml',
        '--workspace',
        '/w',
        '--trusted-host',
        'nexus.example',
      ],
      conversation: ['--live', '--patch=/a.yml', '--patch', '/b.yml', '--workspace', '/w'],
    });
  });
});

describe('SERVE_FLAG_TAKES_VALUE', () => {
  it('跟 serve.ts 的 parseServeArgs 同一張表：旗標一樣多、收不收值一樣', () => {
    const source = readFileSync(join(import.meta.dirname, 'serve.ts'), 'utf8');
    const block = /export function parseServeArgs[\s\S]*?options: \{([\s\S]*?)\n {6}\},/u.exec(
      source,
    )?.[1];
    expect(block).toBeDefined();
    const table: Record<string, boolean> = {};
    for (const match of block!.matchAll(/^\s+'?([\w-]+)'?: \{ type: '(string|boolean)'/gmu)) {
      table[match[1]!] = match[2] === 'string';
    }
    expect(table).toEqual(SERVE_FLAG_TAKES_VALUE);
  });
});

describe('isPrintOnly', () => {
  it('用法、版本、印設定都是只印東西', () => {
    expect(isPrintOnly(['--help'])).toBe(true);
    expect(isPrintOnly(['--version'])).toBe(true);
    expect(isPrintOnly(['--dump-default-config'])).toBe(true);
    expect(isPrintOnly(['--port', '0'])).toBe(false);
  });
});

describe('supervisorLaunch', () => {
  it('前台與對話行程都是 node 帶著 execArgv 起入口，旗標各分各的', () => {
    const launch = supervisorLaunch({
      supervisor: '/opt/nexus/native/nexus-supervisor',
      home: '/home/u/.nexus',
      execPath: '/usr/bin/node',
      execArgv: ['--import', 'tsx'],
      frontEntry: '/opt/nexus/front-process.js',
      conversationEntry: '/opt/nexus/conversation-process.js',
      serveArgv: ['--port', '8080', '--live', '--process-model', 'per-thread'],
      idleMs: 60_000,
    });
    expect(launch).toEqual({
      file: '/opt/nexus/native/nexus-supervisor',
      args: [
        '--run-dir',
        '/home/u/.nexus/run',
        '--audit',
        '/home/u/.nexus/supervisor-audit.jsonl',
        '--idle-ms',
        '60000',
        '--front',
        '/usr/bin/node',
        '--front-arg',
        '--import',
        '--front-arg',
        'tsx',
        '--front-arg',
        '/opt/nexus/front-process.js',
        '--front-arg',
        '--port',
        '--front-arg',
        '8080',
        '--front-arg',
        '--live',
        '--conversation',
        '/usr/bin/node',
        '--conversation-arg',
        '--import',
        '--conversation-arg',
        'tsx',
        '--conversation-arg',
        '/opt/nexus/conversation-process.js',
        '--conversation-arg',
        '--live',
      ],
    });
  });
});

describe('childExecArgv', () => {
  it('supervisorLaunch：前台照原樣帶 inspector 旗標，對話行程不帶', () => {
    const { args } = supervisorLaunch({
      supervisor: '/s',
      home: '/h',
      execPath: '/node',
      execArgv: ['--inspect=9229', '--import', 'tsx'],
      frontEntry: '/front.js',
      conversationEntry: '/conversation.js',
      serveArgv: [],
    });
    const values = (flag: string) => args.filter((_, index) => args[index - 1] === flag);
    expect(values('--front-arg')).toEqual(['--inspect=9229', '--import', 'tsx', '/front.js']);
    expect(values('--conversation-arg')).toEqual(['--import', 'tsx', '/conversation.js']);
  });

  it('拿掉 inspector 的旗標（連分開寫的值），其餘照原樣', () => {
    expect(
      childExecArgv([
        '--import',
        'tsx',
        '--inspect',
        '--inspect-brk=0.0.0.0:9230',
        '--inspect-wait',
        '--inspect-port',
        '9231',
        '--debug-port=9232',
        '--inspect-publish-uid=http',
        '--max-old-space-size=4096',
      ]),
    ).toEqual(['--import', 'tsx', '--max-old-space-size=4096']);
  });
});

describe('pdeathsigHazards', () => {
  const probe = (overrides: Partial<PdeathsigProbe>): PdeathsigProbe => ({
    modeOf: () => 0o100755,
    selfStatus: () => 'CapPrm:\t0000000000000000\n',
    uid: 1000,
    ...overrides,
  });

  it('一般的執行檔、沒有 capability：沒有', () => {
    expect(pdeathsigHazards([{ label: 'node', path: '/usr/bin/node' }], probe({}))).toEqual([]);
  });

  it('setuid、setgid 都報', () => {
    const hazards = pdeathsigHazards(
      [
        { label: 'node', path: '/usr/bin/node' },
        { label: '監督行程', path: '/opt/s' },
      ],
      probe({ modeOf: (path) => (path === '/opt/s' ? 0o106755 : 0o100755) }),
    );
    expect(hazards).toEqual(['監督行程 /opt/s 帶 setuid 位元', '監督行程 /opt/s 帶 setgid 位元']);
  });

  it('非 root 帶著 permitted capability 要報；root 不報', () => {
    const status = () => 'CapPrm:\t0000000000000400\n';
    expect(pdeathsigHazards([], probe({ selfStatus: status }))).toHaveLength(1);
    expect(pdeathsigHazards([], probe({ selfStatus: status, uid: 0 }))).toEqual([]);
  });

  it('讀不到 /proc/self/status 不報', () => {
    expect(pdeathsigHazards([], probe({ selfStatus: () => undefined }))).toEqual([]);
  });
});

describe('processModelSetting', () => {
  it('沒有那一列或關掉了，是 single', () => {
    expect(processModelSetting([])).toEqual({ mode: 'single' });
    expect(
      processModelSetting([
        { name: PROCESS_MODEL_ENTRY_NAME, disabled: true, config: { mode: 'per-thread' } },
      ] as never),
    ).toEqual({ mode: 'single' });
  });

  it('寫壞了就拋', () => {
    expect(() =>
      processModelSetting([
        { name: PROCESS_MODEL_ENTRY_NAME, config: { mode: 'forked' } },
      ] as never),
    ).toThrow(PROCESS_MODEL_ENTRY_NAME);
  });
});

describe('resolveProcessModel', () => {
  const base = { env: { NEXUS_AGENT_HOME: '/nonexistent-home' }, platform: 'linux' as const };

  it('預設 single', () => {
    expect(resolveProcessModel({ ...base, argv: [], flag: undefined })).toEqual({ mode: 'single' });
  });

  it('旗標蓋過設定列', async () => {
    const patch = await patchFile('- id: process-model\n  config:\n    mode: per-thread\n');
    const argv = ['--patch', patch];
    expect(resolveProcessModel({ ...base, argv, flag: undefined }).mode).toBe('per-thread');
    expect(resolveProcessModel({ ...base, argv, flag: 'single' }).mode).toBe('single');
  });

  it('per-thread 把 thread-capacity 的閒置逐出時間交給監督行程', async () => {
    const patch = await patchFile(
      '- id: thread-capacity\n  config:\n    maxThreads: 3\n    idleEvictAfterMs: 60000\n',
    );
    const argv = ['--patch', patch];
    expect(resolveProcessModel({ ...base, argv, flag: 'per-thread' })).toEqual({
      mode: 'per-thread',
      idleMs: 60_000,
    });
    expect(resolveProcessModel({ ...base, argv, flag: undefined })).toEqual({ mode: 'single' });
  });

  it('沒落盤時不照時間收（收掉的行程不留日誌）', async () => {
    const patch = await patchFile(
      '- id: thread-capacity\n  config:\n    idleEvictAfterMs: 60000\n- id: session-persistence\n  disabled: true\n',
    );
    expect(
      resolveProcessModel({ ...base, argv: ['--patch', patch], flag: 'per-thread' }).idleMs,
    ).toBe(0);
  });

  it('旗標明講 per-thread 時，設定寫壞了在啟動器就拋，不換成監督行程', async () => {
    const broken = await patchFile('- id: thread-capacity\n  config:\n    idleEvictAfterMs: -1\n');
    expect(() =>
      resolveProcessModel({ ...base, argv: ['--patch', broken], flag: 'per-thread' }),
    ).toThrow('#settings/thread-capacity');
    expect(resolveProcessModel({ ...base, argv: ['--patch', broken], flag: undefined })).toEqual({
      mode: 'single',
    });
  });

  it('process-model 那一列寫壞了：旗標明講 single 照樣是 single，per-thread 在啟動器就拋，沒給旗標交給 runServe 報', async () => {
    const broken = await patchFile('- id: process-model\n  config:\n    mode: forked\n');
    const argv = ['--patch', broken];
    expect(resolveProcessModel({ ...base, argv, flag: 'single' })).toEqual({ mode: 'single' });
    expect(resolveProcessModel({ ...base, argv, flag: undefined })).toEqual({ mode: 'single' });
    expect(() => resolveProcessModel({ ...base, argv, flag: 'per-thread' })).toThrow(
      PROCESS_MODEL_ENTRY_NAME,
    );
  });

  it('per-thread 不在 Linux 就拋', () => {
    expect(() =>
      resolveProcessModel({ ...base, platform: 'darwin', argv: [], flag: 'per-thread' }),
    ).toThrow('只在 Linux');
  });

  it('只印東西的旗標一律 single', () => {
    expect(
      resolveProcessModel({ ...base, platform: 'darwin', argv: ['--help'], flag: 'per-thread' }),
    ).toEqual({ mode: 'single' });
  });
});

describe('宿主', () => {
  it('supervisorLaunch：給了 host 就帶 --host，放在 --front 之前', () => {
    const { args } = supervisorLaunch({
      supervisor: '/opt/nexus/native/nexus-supervisor',
      host: '/opt/nexus/native/nexus-host',
      home: '/h',
      execPath: '/usr/bin/node',
      execArgv: [],
      frontEntry: '/front.js',
      conversationEntry: '/conversation.js',
      serveArgv: [],
    });
    const at = args.indexOf('--host');
    expect(args.slice(at, at + 2)).toEqual(['--host', '/opt/nexus/native/nexus-host']);
    expect(at).toBeLessThan(args.indexOf('--front'));
  });

  it('launchProcessModel：監督行程旁邊沒有 nexus-host 就拒起，不換成監督行程', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'process-launcher-host-'));
    dirs.push(dir);
    const supervisor = join(dir, 'nexus-supervisor');
    await writeFile(supervisor, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const patch = await patchFile(
      `- id: process-model\n  config:\n    mode: per-thread\n    supervisorBinary: ${supervisor}\n`,
    );
    expect(() =>
      launchProcessModel({
        argv: ['--patch', patch],
        flag: undefined,
        env: { NEXUS_AGENT_HOME: join(dir, 'home') },
        platform: 'linux',
      }),
    ).toThrow(`找不到宿主（監督行程旁邊的 nexus-host，${join(dir, 'nexus-host')}）`);
  });
});
