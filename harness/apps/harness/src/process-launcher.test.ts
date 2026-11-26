import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  childExecArgv,
  findSupervisorBinary,
  HOST_PLUGINS_FILE,
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
  it('跟 serve-run.ts 的 parseServeArgs 同一張表：旗標一樣多、收不收值一樣', () => {
    const source = readFileSync(join(import.meta.dirname, 'serve-run.ts'), 'utf8');
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

describe('supervisorLaunch 的 startTimeoutMs', () => {
  const input = {
    supervisor: '/s',
    home: '/h',
    execPath: '/node',
    execArgv: [],
    frontEntry: '/f.js',
    conversationEntry: '/c.js',
    serveArgv: [],
  };

  it('沒給就不傳旗標，給了（含 0）原樣傳', () => {
    expect(supervisorLaunch(input).args).not.toContain('--start-timeout-ms');
    expect(supervisorLaunch({ ...input, startTimeoutMs: 45_000 }).args).toEqual(
      expect.arrayContaining(['--start-timeout-ms', '45000']),
    );
    const args = supervisorLaunch({ ...input, startTimeoutMs: 0 }).args;
    expect(
      args.slice(args.indexOf('--start-timeout-ms'), args.indexOf('--start-timeout-ms') + 2),
    ).toEqual(['--start-timeout-ms', '0']);
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

  it('process-model 的 startTimeoutMs 只在 per-thread 交給監督行程，沒設就沒有', async () => {
    const set = await patchFile(
      '- id: process-model\n  config:\n    mode: per-thread\n    startTimeoutMs: 45000\n',
    );
    const argv = ['--patch', set];
    expect(resolveProcessModel({ ...base, argv, flag: undefined }).startTimeoutMs).toBe(45_000);
    expect(resolveProcessModel({ ...base, argv, flag: 'single' })).toEqual({ mode: 'single' });
    const off = await patchFile(
      '- id: process-model\n  config:\n    mode: per-thread\n    startTimeoutMs: 0\n',
    );
    expect(
      resolveProcessModel({ ...base, argv: ['--patch', off], flag: undefined }).startTimeoutMs,
    ).toBe(0);
    const unset = await patchFile('- id: process-model\n  config:\n    mode: per-thread\n');
    expect(
      resolveProcessModel({ ...base, argv: ['--patch', unset], flag: undefined }),
    ).not.toHaveProperty('startTimeoutMs');
  });

  it('startTimeoutMs 要是非負整數', async () => {
    for (const bad of ['-1', '1.5', "'30000'"]) {
      const patch = await patchFile(
        `- id: process-model\n  config:\n    mode: per-thread\n    startTimeoutMs: ${bad}\n`,
      );
      expect(() =>
        resolveProcessModel({ ...base, argv: ['--patch', patch], flag: 'per-thread' }),
      ).toThrow(PROCESS_MODEL_ENTRY_NAME);
    }
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
    expect(args.slice(at, at + 6)).toEqual([
      '--host',
      '/opt/nexus/native/nexus-host',
      '--host-arg',
      '--plugins',
      '--host-arg',
      `/h/${HOST_PLUGINS_FILE}`,
    ]);
    expect(at).toBeLessThan(args.indexOf('--front'));
  });

  it('supervisorLaunch：不帶 --eof-grace-ms（拆除梯度用監督行程自己的預設，宿主等橋的 5.5 秒排在它裡面）', () => {
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
    expect(args).not.toContain('--eof-grace-ms');
    expect(args.join(' ')).not.toContain('eof-grace');
  });

  it('supervisorLaunch：沒給 host 就不帶 --host，也不帶任何 --host-arg', () => {
    const { args } = supervisorLaunch({
      supervisor: '/opt/nexus/native/nexus-supervisor',
      home: '/h',
      execPath: '/usr/bin/node',
      execArgv: [],
      frontEntry: '/front.js',
      conversationEntry: '/conversation.js',
      serveArgv: [],
    });
    expect(args).not.toContain('--host');
    expect(args).not.toContain('--host-arg');
    expect(args.join(' ')).not.toContain(HOST_PLUGINS_FILE);
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

  /** 照 per-thread 啟動一次（`execve` 被攔下）：回 home 與傳進去的環境物件，檔在 `<home>/host-plugins.json`。 */
  async function launchOnce(options: {
    readonly argv?: readonly string[];
    readonly env?: NodeJS.ProcessEnv;
    readonly homeFiles?: Readonly<Record<string, string>>;
    /** 目前資料夾（專案那層）底下的檔。 */
    readonly projectFiles?: Readonly<Record<string, string>>;
    /** home 底下要建成目錄的名字。 */
    readonly homeDirs?: readonly string[];
  }): Promise<{ home: string; env: NodeJS.ProcessEnv; thrown: unknown }> {
    const dir = await mkdtemp(join(tmpdir(), 'process-launcher-plugins-'));
    dirs.push(dir);
    // 專案那層 .env 所在的目錄：指到臨時目錄，不吃跑測試的資料夾，免得本機有 .env 莫名紅。
    const cwd = join(dir, 'project');
    await mkdir(cwd);
    for (const [name, content] of Object.entries(options.projectFiles ?? {})) {
      await writeFile(join(cwd, name), content);
    }
    const supervisor = join(dir, 'nexus-supervisor');
    await writeFile(supervisor, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(join(dir, 'nexus-host'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const patch = await patchFile(
      `- id: process-model\n  config:\n    mode: per-thread\n    supervisorBinary: ${supervisor}\n`,
    );
    const home = join(dir, 'home');
    await mkdir(home);
    for (const name of options.homeDirs ?? []) await mkdir(join(home, name));
    for (const [name, content] of Object.entries(options.homeFiles ?? {})) {
      await writeFile(join(home, name), content);
    }
    const env: NodeJS.ProcessEnv = { NEXUS_AGENT_HOME: home, ...options.env };
    const stop = new Error('execve 被攔下');
    const real = (process as { execve?: unknown }).execve;
    (process as { execve?: unknown }).execve = () => {
      throw stop;
    };
    let thrown: unknown;
    try {
      launchProcessModel({
        argv: ['--patch', patch, ...(options.argv ?? [])],
        flag: undefined,
        env,
        platform: 'linux',
        cwd,
      });
    } catch (error) {
      thrown = error;
      if (error !== stop) return { home, env, thrown };
    } finally {
      (process as { execve?: unknown }).execve = real;
    }
    return { home, env, thrown: undefined };
  }

  const pluginsOf = (home: string): unknown =>
    JSON.parse(readFileSync(join(home, HOST_PLUGINS_FILE), 'utf8'));

  it('launchProcessModel：換成監督行程之前，照啟動環境重寫 host-plugins.json（舊內容不留）', async () => {
    const { home, thrown } = await launchOnce({
      env: { NODE_EXTRA_CA_CERTS: '/etc/ca.pem' },
      homeFiles: { [HOST_PLUGINS_FILE]: '[{"name":"mcp","config":{"roots":"/old.pem"}}]' },
    });
    expect(thrown).toBeUndefined();
    expect(pluginsOf(home)).toEqual([{ name: 'mcp', config: { roots: '/etc/ca.pem' } }]);
  });

  it('launchProcessModel：帶 --live 時宿主代理也看 home 的 .env（D364），行程環境不被 .env 污染', async () => {
    const { home, env } = await launchOnce({
      argv: ['--live'],
      env: { NODE_EXTRA_CA_CERTS: '/etc/ca.pem' },
      homeFiles: {
        '.env': 'HTTPS_PROXY=http://envfile.corp.test:3128\nOTHER_VALUE=from-env-file\n',
      },
    });
    expect(pluginsOf(home)).toEqual([
      {
        name: 'mcp',
        config: {
          roots: '/etc/ca.pem',
          proxy: {
            httpsProxy: 'http://envfile.corp.test:3128',
            noProxy: 'localhost,127.0.0.1,::1,[::1]',
          },
        },
      },
    ]);
    // 傳給 `execve` 的環境不能多出 `.env` 的任何值，不然監督行程與每個子行程都會繼承。
    expect(env).not.toHaveProperty('HTTPS_PROXY');
    expect(env).not.toHaveProperty('OTHER_VALUE');
  });

  it('launchProcessModel：行程環境的代理勝過 home 的 .env', async () => {
    const { home } = await launchOnce({
      argv: ['--live'],
      env: { NODE_EXTRA_CA_CERTS: '/etc/ca.pem', HTTPS_PROXY: 'http://real.corp.test:3128' },
      homeFiles: { '.env': 'HTTPS_PROXY=http://envfile.corp.test:3128\n' },
    });
    expect(pluginsOf(home)).toMatchObject([
      { config: { proxy: { httpsProxy: 'http://real.corp.test:3128' } } },
    ]);
  });

  it('launchProcessModel：沒帶 --live 不讀 .env（跟 serve 為模型請求裝代理一致）', async () => {
    const { home } = await launchOnce({
      env: { NODE_EXTRA_CA_CERTS: '/etc/ca.pem' },
      homeFiles: { '.env': 'HTTPS_PROXY=http://envfile.corp.test:3128\n' },
    });
    expect(pluginsOf(home)).toEqual([{ name: 'mcp', config: { roots: '/etc/ca.pem' } }]);
  });

  it('launchProcessModel：帶 --live 且 home 的 .env 設了只有啟動環境能設的名字：啟動器就丟，清單不動', async () => {
    const old = '[{"name":"mcp","config":{"roots":"/old.pem"}}]';
    const { home, thrown } = await launchOnce({
      argv: ['--live'],
      env: { NODE_EXTRA_CA_CERTS: '/etc/ca.pem' },
      homeFiles: { '.env': 'NODE_OPTIONS=--inspect\n', [HOST_PLUGINS_FILE]: old },
    });
    expect(String(thrown)).toContain('NODE_OPTIONS');
    expect(readFileSync(join(home, HOST_PLUGINS_FILE), 'utf8')).toBe(old);
  });

  it('launchProcessModel：帶 --live 且目前資料夾的 .env 設了代理（專案那層不准設）：啟動器就丟，跟前台同一句', async () => {
    const { thrown } = await launchOnce({
      argv: ['--live'],
      env: { NODE_EXTRA_CA_CERTS: '/etc/ca.pem' },
      projectFiles: { '.env': 'HTTPS_PROXY=http://project.corp.test:3128\n' },
    });
    expect(String(thrown)).toContain('HTTPS_PROXY');
  });

  it('launchProcessModel：.env 讀不了的警告啟動器不印（前台載同一份時印一次）', async () => {
    const written: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let thrown: unknown;
    try {
      // home 的 .env 是個目錄：`readFileSync` 以 EISDIR 失敗，走 launch-env 的「讀不了」警告。
      ({ thrown } = await launchOnce({
        argv: ['--live'],
        env: { NODE_EXTRA_CA_CERTS: '/etc/ca.pem' },
        homeDirs: ['.env'],
      }));
    } finally {
      process.stderr.write = realWrite;
    }
    expect(thrown).toBeUndefined();
    expect(written.join('')).not.toContain('launch-env:');
  });
});

describe('findSupervisorBinary', () => {
  const BIN = 'native/nexus-supervisor';
  const from = (root: string): string => join(root, 'harness/apps/harness/src/a.js');
  const place = (root: string, ...segments: string[]): void => {
    const file = join(root, ...segments);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '');
  };
  const inTmp = (body: (root: string) => void): void => {
    const root = mkdtempSync(join(tmpdir(), 'nexus-find-supervisor-'));
    try {
      body(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const inRepo = (body: (root: string) => void): void =>
    inTmp((root) => {
      place(root, 'pnpm-workspace.yaml');
      body(root);
    });

  it('發版包：往上找到 native/，沒有就找不到', () => {
    inTmp((root) => {
      expect(findSupervisorBinary(join(root, 'harness/apps/harness/dist/a.js'))).toBeUndefined();
      place(root, BIN);
      expect(findSupervisorBinary(join(root, 'harness/apps/harness/dist/a.js'))).toBe(
        join(root, BIN),
      );
    });
  });

  it('原始碼樹只在舊位置放一支：拋錯，指名舊路徑與新位置，不回傳它', () => {
    inRepo((root) => {
      place(root, BIN);
      expect(() => findSupervisorBinary(from(root))).toThrow(join(root, BIN));
      expect(() => findSupervisorBinary(from(root))).toThrow(join(root, 'harness', BIN));
    });
  });

  it('新位置有就用新位置，舊位置還在也不報錯', () => {
    inRepo((root) => {
      place(root, BIN);
      place(root, 'harness', BIN);
      expect(findSupervisorBinary(from(root))).toBe(join(root, 'harness', BIN));
    });
  });

  it('舊檔在 repo 根之上（本地 git 在外層）：拋錯，指名舊路徑與 repo 根底下的新位置', () => {
    inTmp((outer) => {
      const root = join(outer, 'nexus');
      place(root, 'pnpm-workspace.yaml');
      place(outer, BIN);
      expect(() => findSupervisorBinary(from(root))).toThrow(join(outer, BIN));
      expect(() => findSupervisorBinary(from(root))).toThrow(join(root, 'harness', BIN));
    });
  });

  it('新位置有就用新位置，repo 根之上的舊檔也不報錯', () => {
    inTmp((outer) => {
      const root = join(outer, 'nexus');
      place(root, 'pnpm-workspace.yaml');
      place(root, 'harness', BIN);
      place(outer, BIN);
      expect(findSupervisorBinary(from(root))).toBe(join(root, 'harness', BIN));
    });
  });

  it('舊檔在 repo 根的上兩層以上：超出找的範圍，找不到也不報錯', () => {
    inTmp((top) => {
      const root = join(top, 'a', 'nexus');
      place(root, 'pnpm-workspace.yaml');
      place(top, BIN);
      expect(findSupervisorBinary(from(root))).toBeUndefined();
    });
  });

  it('兩處都沒有：找不到', () => {
    inRepo((root) => {
      expect(findSupervisorBinary(from(root))).toBeUndefined();
    });
  });
});
