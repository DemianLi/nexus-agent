/**
 * **每條新 thread 一個私有可寫根，`--workspace` 退成唯讀共用區**（[#1775](https://github.com/DemianLi/nexus-agent/issues/1775)）。
 *
 * 從 `runServe` 起量（#1427）：真的 serve、真的 HTTP、出貨的組裝、真的 JSONL 日誌；唯一換掉的是模型（腳本）。手搭 `createAgent` 的測試自己把根傳進組裝，
 * 拿掉 `serve.ts` 的接線也不會紅。
 *
 * 每一組驗收的突變（各自單獨做，結果記在 PR 內文）：
 *
 * | 驗收 | 突變 | 會紅的格 |
 * | --- | --- | --- |
 * | 盤點 `:64` 那一對 | `createThreadPlacer` 新 thread 那行改回 `{ root: shared }` | B 讀得到 A 的檔 |
 * | 共用區唯讀 | `agent-factory.ts` 共用路由的 mode 改接控制器的 source | 全開那格寫得進去 |
 * | 共用區唯讀 | 共用路由不掛 | 讀的那格 |
 * | 續接 | 續接改成用 thread id 重算 | header 被改過的那格（分叉） |
 * | 舊 thread | 舊 thread 也配私有根 | 舊 thread 寫的檔不在 `--workspace` |
 * | 衝突 | 放寬「其他」那一條 | 衝突那格 |
 * | 權限 | 拿掉 `mkdir` 的 mode 與 `chmod` | 0700 那格 |
 * | 指示檔 | agent-instructions 改讀 `/` | 子代理的基線含 PRIVATE-RULE |
 *
 * **零憑證、零外部連線**：目錄都在 `/var/tmp`。
 */

import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDeliverableClient } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { bodyLog, exchangeServeToken, fetchWithCookie, foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { scriptedPatchText } from './scripted-serve.js';
import type { ScriptedTurn } from './scripted-model.js';
import { runServe } from './serve.js';
import type { RunningServe, RunServeOptions } from './serve.js';
import { SHARED_WORKSPACE_PREFIX, THREAD_ROOTS_DIR_NAME } from './thread-roots.js';

const PERSISTENCE_OFF_PATCH = fileURLToPath(
  new URL('./settings/persistence-off.patch.yml', import.meta.url),
);

const temporary: string[] = [];
let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join('/var/tmp', prefix));
  temporary.push(dir);
  return dir;
}

interface Fixture {
  readonly home: string;
  /** `--workspace`：唯讀共用區。 */
  readonly shared: string;
}

async function fixture(): Promise<Fixture> {
  const home = await scratch('nexus-private-root-home-');
  const shared = await scratch('nexus-private-root-ws-');
  await writeFile(join(shared, 'ref.md'), 'REF-CONTENT', 'utf8');
  return { home, shared };
}

interface StartOptions {
  readonly argv?: readonly string[];
  readonly extraRows?: string;
  readonly workspaceRootOf?: RunServeOptions['workspaceRootOf'];
  readonly workspace?: boolean;
  readonly log?: (line: string) => void;
}

/** 起一台 serve，模型是這份腳本（每條 thread 從第一輪開始吃）。 */
async function start(
  fx: Fixture,
  turns: readonly ScriptedTurn[],
  options: StartOptions = {},
): Promise<RunningServe> {
  await running?.close();
  running = undefined;
  const patch = join(await scratch('nexus-private-root-patch-'), 'script.patch.yml');
  await writeFile(patch, scriptedPatchText(turns, options.extraRows), 'utf8');
  running = (await runServe({
    argv: [
      '--port',
      '0',
      ...(options.workspace === false ? [] : ['--workspace', fx.shared]),
      '--patch',
      patch,
      ...(options.argv ?? []),
    ],
    log: options.log ?? (() => undefined),
    env: { [HARNESS_HOME_ENV]: fx.home },
    ...(options.workspaceRootOf !== undefined && { workspaceRootOf: options.workspaceRootOf }),
  })) as RunningServe;
  return running;
}

interface ToolEntry {
  readonly kind: 'tool';
  readonly name: string;
  readonly status: string;
  readonly text?: string;
  readonly error?: string;
  readonly errorCode?: string;
}

/** 跑一輪，回這一輪的工具條目。 */
async function turn(server: RunningServe, thread: string, text = '開始。'): Promise<ToolEntry[]> {
  const client = await serveClient(server);
  const events = await client.openEvents(thread);
  await client.runStart(thread, text);
  const state = await foldTurn(events);
  await events.return?.(undefined);
  return (state.entries as unknown as { kind: string }[]).filter(
    (entry): entry is ToolEntry => entry.kind === 'tool',
  );
}

const textsOf = (tools: readonly ToolEntry[]): string =>
  tools.map((tool) => `${tool.text ?? ''}${tool.error ?? ''}`).join('\n');

function thread(tools: readonly ToolEntry[], name: string): ToolEntry {
  const found = tools.find((tool) => tool.name === name);
  if (found === undefined) throw new Error(`這一輪沒有 ${name} 的工具條目`);
  return found;
}

const base = (fx: Fixture): string => join(fx.home, THREAD_ROOTS_DIR_NAME);

async function privateRoots(fx: Fixture): Promise<string[]> {
  try {
    return (await readdir(base(fx))).sort();
  } catch {
    return [];
  }
}

async function headerPath(home: string, threadId: string): Promise<string> {
  const names = await readdir(join(home, 'sessions'), { recursive: true });
  const found = names.find((name) => name.endsWith(`${threadId}.header.json`));
  if (found === undefined) throw new Error(`找不到 ${threadId} 的 header`);
  return join(home, 'sessions', found);
}

async function headerOf(home: string, threadId: string): Promise<{ workspaceRoot?: string }> {
  return JSON.parse(await readFile(await headerPath(home, threadId), 'utf8')) as {
    workspaceRoot?: string;
  };
}

async function rewriteHeader(
  home: string,
  threadId: string,
  change: (header: Record<string, unknown>) => void,
): Promise<void> {
  const path = await headerPath(home, threadId);
  const header = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  change(header);
  await writeFile(path, JSON.stringify(header), 'utf8');
}

const WRITE: ScriptedTurn[] = [
  {
    content: '',
    toolCalls: [{ name: 'write_file', args: { file_path: '/r.csv', content: 'ROW-4242' } }],
  },
  { content: '寫好了。' },
];

const PROBE: ScriptedTurn[] = [
  { content: '', toolCalls: [{ name: 'ls', args: { path: '/' } }] },
  { content: '', toolCalls: [{ name: 'grep', args: { pattern: 'ROW-', path: '/' } }] },
  { content: '', toolCalls: [{ name: 'glob', args: { pattern: '**/*.csv' } }] },
  { content: '', toolCalls: [{ name: 'read_file', args: { file_path: '/r.csv' } }] },
  { content: '看完了。' },
];

describe('盤點 :64 那一對：A 寫的檔，B 看不到；重啟之後 A 還看得到', () => {
  it('B 的 ls／grep／glob／read_file 都找不到；A 重啟接回來讀得到；檔不在 --workspace', async () => {
    const fx = await fixture();
    await turn(await start(fx, WRITE), 'a');
    await turn(await start(fx, PROBE), 'b'); // 這一台重啟了：B 是另一條新 thread。

    const server = running!;
    const b = await turn(server, 'b2');
    const bTexts = textsOf(b);
    // B（這裡是 b2，另一條新 thread）：列不出、搜不到、讀不到。
    expect(thread(b, 'ls').text).not.toContain('r.csv');
    expect(thread(b, 'grep').text).not.toContain('ROW-4242');
    expect(thread(b, 'glob').text).not.toContain('r.csv');
    expect(bTexts).not.toContain('ROW-4242');
    expect(thread(b, 'read_file').status).toBe('failed');

    // A 重啟之後接回來：同一個私有根，之前寫的檔還在。
    const a = await turn(server, 'a');
    expect(thread(a, 'ls').text).toContain('/r.csv');
    expect(thread(a, 'grep').text).toContain('ROW-4242');
    expect(thread(a, 'read_file').text).toContain('ROW-4242');

    // 檔在 A 的私有根，不在 --workspace；header 記著 A 的私有根（續接靠它，不靠重算）。
    expect(await readdir(fx.shared)).toEqual(['ref.md']);
    const headerA = await headerOf(fx.home, 'a');
    expect(headerA.workspaceRoot?.startsWith(`${base(fx)}/thread-`)).toBe(true);
    expect(await readFile(join(headerA.workspaceRoot!, 'r.csv'), 'utf8')).toBe('ROW-4242');
    const headerB = await headerOf(fx.home, 'b2');
    expect(headerB.workspaceRoot).not.toBe(headerA.workspaceRoot);
  }, 120000);

  it('基底與每條 thread 的根都是 0700', async () => {
    const fx = await fixture();
    await turn(await start(fx, WRITE), 'a');
    expect((await stat(base(fx))).mode & 0o777).toBe(0o700);
    const [name] = await privateRoots(fx);
    expect(name).toMatch(/^thread-[0-9a-f]{32}$/u);
    expect((await stat(join(base(fx), name!))).mode & 0o777).toBe(0o700);
  }, 60000);

  it('不自動清：關掉 serve、再起，私有根和裡面的檔都還在', async () => {
    const fx = await fixture();
    await turn(await start(fx, WRITE), 'a');
    const before = await privateRoots(fx);
    await running?.close();
    running = undefined;
    const second = await start(fx, PROBE);
    await turn(second, 'a');
    expect(await privateRoots(fx)).toEqual(before);
    const names = await readdir(join(base(fx), before[0]!));
    expect(names).toContain('r.csv');
  }, 90000);
});

describe('唯讀共用區', () => {
  const READ_THEN_WRITE: ScriptedTurn[] = [
    {
      content: '',
      toolCalls: [{ name: 'read_file', args: { file_path: `${SHARED_WORKSPACE_PREFIX}/ref.md` } }],
    },
    {
      content: '',
      toolCalls: [
        {
          name: 'write_file',
          args: { file_path: `${SHARED_WORKSPACE_PREFIX}/x.txt`, content: 'no' },
        },
      ],
    },
    { content: '', toolCalls: [{ name: 'ls', args: { path: '/' } }] },
    { content: '完。' },
  ];

  /** 部署方把全開那一組加回權限表（出廠表沒有，#1621）。 */
  const FULL_ACCESS_ROWS = `- id: permission-presets
  config:
    presets:
      read-only: { sandbox: read-only, approval: ask }
      workspace-write: { sandbox: workspace-write, approval: ask }
      danger-full-access: { sandbox: danger-full-access, approval: never }
`;

  it.each([
    ['預設的檔案政策', {}],
    [
      'danger-full-access（部署方加回的那一組）',
      { argv: ['--sandbox', 'danger-full-access'], extraRows: FULL_ACCESS_ROWS },
    ],
  ] as const)(
    '%s：讀得到、寫入被拒，--workspace 一個檔都沒多',
    async (_label, options) => {
      const fx = await fixture();
      const tools = await turn(await start(fx, READ_THEN_WRITE, options), 'a');
      expect(thread(tools, 'read_file').text).toContain('REF-CONTENT');
      const write = thread(tools, 'write_file');
      expect(write.status).toBe('failed');
      expect(write.errorCode).toBe('FS_SANDBOX_DENIED');
      expect(thread(tools, 'ls').text).toContain(`${SHARED_WORKSPACE_PREFIX}/`);
      expect(await readdir(fx.shared)).toEqual(['ref.md']);
    },
    60000,
  );

  it('共用區的檔交付不了（併進 offWorkspacePrefixes）', async () => {
    const fx = await fixture();
    const tools = await turn(
      await start(fx, [
        {
          content: '交付。',
          toolCalls: [
            { name: 'present', args: { files: [{ path: `${SHARED_WORKSPACE_PREFIX}/ref.md` }] } },
          ],
        },
        { content: '完。' },
      ]),
      'a',
    );
    const present = thread(tools, 'present');
    expect(`${present.text ?? ''}${present.error ?? ''}`).not.toContain('REF-CONTENT');
    expect(present.status === 'failed' || /不在|拒絕|不能|沒有|not/u.test(present.text ?? '')).toBe(
      true,
    );
  }, 60000);
});

describe('續接一律讀 header，不用 thread id 重算', () => {
  /** 用固定根的接縫先造一條「舊 thread」：header 記著 `--workspace` 的根，寫的檔落在 `--workspace`。 */
  async function makeOldThread(fx: Fixture, id: string): Promise<void> {
    await turn(await start(fx, WRITE, { workspaceRootOf: () => fx.shared }), id);
    await running?.close();
    running = undefined;
  }

  it('舊 thread（header 記著共用區根）：照舊以共用區為可寫根；新 thread 經共用前綴讀得到那個檔（Q6 (a) 的代價）', async () => {
    const fx = await fixture();
    await makeOldThread(fx, 'old');
    expect(await readFile(join(fx.shared, 'r.csv'), 'utf8')).toBe('ROW-4242');

    const server = await start(fx, PROBE);
    const old = await turn(server, 'old');
    // 舊 thread 的 `/` 就是共用區：看得到自己寫的檔，也沒有另掛唯讀共用前綴。
    expect(thread(old, 'ls').text).toContain('/r.csv');
    expect(thread(old, 'ls').text).not.toContain(`${SHARED_WORKSPACE_PREFIX}/`);
    expect(await privateRoots(fx)).toEqual([]);

    const fresh = await turn(server, 'fresh');
    expect(thread(fresh, 'ls').text).not.toContain('/r.csv');
    // 新 thread 經共用前綴讀得到舊 thread 寫進共用區的檔。
    const viaShared = await turn(
      await start(fx, [
        {
          content: '',
          toolCalls: [
            { name: 'read_file', args: { file_path: `${SHARED_WORKSPACE_PREFIX}/r.csv` } },
          ],
        },
        { content: '完。' },
      ]),
      'fresh',
    );
    expect(thread(viaShared, 'read_file').text).toContain('ROW-4242');
  }, 120000);

  it('header 沒記根的舊日誌（格式 13 以前）：接得回來，以共用區為可寫根', async () => {
    const fx = await fixture();
    await makeOldThread(fx, 'old');
    await rewriteHeader(fx.home, 'old', (header) => {
      delete header.workspaceRoot;
    });
    const old = await turn(await start(fx, PROBE), 'old');
    expect(thread(old, 'ls').text).toContain('/r.csv');
    expect(await privateRoots(fx)).toEqual([]);
  }, 90000);

  it('header 的根既不是共用區、也不在基底底下：接不回來，訊息指名兩個根', async () => {
    const fx = await fixture();
    await makeOldThread(fx, 'old');
    const elsewhere = await scratch('nexus-private-root-elsewhere-');
    await rewriteHeader(fx.home, 'old', (header) => {
      header.workspaceRoot = elsewhere;
    });
    const client = await serveClient(await start(fx, PROBE));
    const refused = await client.slashRun('old', '/permission');
    expect(refused).toMatchObject({ kind: 'rejected' });
    expect(JSON.stringify(refused)).toContain(elsewhere);
    expect(JSON.stringify(refused)).toContain(fx.shared);
  }, 90000);

  it.each([
    ['基底本身', (fx: Fixture) => base(fx)],
    ['基底底下名字形狀不對的目錄', (fx: Fixture) => join(base(fx), 'someone-else')],
    ['基底的孫目錄', (fx: Fixture) => join(base(fx), `thread-${'0'.repeat(32)}`, 'nested')],
  ])(
    'header 的根是%s：也擋下（不是基底的直接子目錄）',
    async (_label, rootOf) => {
      const fx = await fixture();
      await makeOldThread(fx, 'old');
      await rewriteHeader(fx.home, 'old', (header) => {
        header.workspaceRoot = rootOf(fx);
      });
      const refused = await (
        await serveClient(await start(fx, PROBE))
      ).slashRun('old', '/permission');
      expect(refused).toMatchObject({ kind: 'rejected' });
    },
    90000,
  );

  it('分叉的子 thread：header 記著 A 的私有根、id 不同，接回來之後寫進 A 的根，不另配', async () => {
    const fx = await fixture();
    const first = await start(fx, WRITE);
    await turn(first, 'a');
    await turn(first, 'forked');
    const rootA = (await headerOf(fx.home, 'a')).workspaceRoot!;
    const rootForkedBefore = (await headerOf(fx.home, 'forked')).workspaceRoot!;
    expect(rootForkedBefore).not.toBe(rootA);
    const rootsBefore = await privateRoots(fx);
    expect(rootsBefore).toHaveLength(2);
    await running?.close();
    running = undefined;

    // 手造：子 thread 的 header 抄來源 A 的根（照 dsh 分叉照抄 cwd；#1580）。
    await rewriteHeader(fx.home, 'forked', (header) => {
      header.workspaceRoot = rootA;
    });
    const server = await start(fx, [
      {
        content: '',
        toolCalls: [{ name: 'write_file', args: { file_path: '/from-fork.txt', content: 'F' } }],
      },
      { content: '完。' },
    ]);
    await turn(server, 'forked');
    expect(await readFile(join(rootA, 'from-fork.txt'), 'utf8')).toBe('F');
    // 沒有另配第三個根，原本那個也沒被寫。
    expect(await privateRoots(fx)).toEqual(rootsBefore);
    await expect(stat(join(rootForkedBefore, 'from-fork.txt'))).rejects.toThrow();
  }, 120000);
});

describe('子代理與 --workspace 的指示檔', () => {
  it('A 的背景子代理寫的檔落在 A 的私有根，B 讀不到', async () => {
    const fx = await fixture();
    const server = await start(fx, [
      {
        content: '委派。',
        toolCalls: [
          {
            name: 'subagent',
            args: {
              description: '幹活',
              subagent_type: 'general-purpose',
              run_in_background: true,
            },
          },
        ],
      },
      {
        content: '',
        toolCalls: [{ name: 'write_file', args: { file_path: '/by-subagent.txt', content: 'S' } }],
      },
      { content: '子代理做完了。' },
      { content: '收到。' },
      { content: '好。' },
    ]);
    await turn(server, 'a');
    const rootA = (await headerOf(fx.home, 'a')).workspaceRoot!;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        expect(await readFile(join(rootA, 'by-subagent.txt'), 'utf8')).toBe('S');
        break;
      } catch (error) {
        if (Date.now() + 100 >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(await readdir(fx.shared)).toEqual(['ref.md']);
    const b = await turn(await start(fx, PROBE), 'b');
    expect(thread(b, 'ls').text).not.toContain('by-subagent.txt');
  }, 120000);

  it('部署方放在 --workspace 的 AGENTS.md 進系統指示；模型寫進私有根的 /AGENTS.md 不會', async () => {
    const fx = await fixture();
    await writeFile(join(fx.shared, 'AGENTS.md'), 'DEPLOY-RULE', 'utf8');
    const server = await start(fx, [
      {
        content: '',
        toolCalls: [
          { name: 'write_file', args: { file_path: '/AGENTS.md', content: 'PRIVATE-RULE' } },
        ],
      },
      {
        content: '委派。',
        toolCalls: [
          {
            name: 'subagent',
            args: {
              description: '幹活',
              subagent_type: 'general-purpose',
              run_in_background: true,
            },
          },
        ],
      },
      { content: '子代理做完了。' },
      { content: '收到。' },
      { content: '好。' },
    ]);
    await turn(server, 'a');
    // 等子代理的日誌寫出來：子代理的基線是在模型寫了 /AGENTS.md **之後**讀的。
    const deadline = Date.now() + 15000;
    let injected: string[] = [];
    while (Date.now() < deadline) {
      injected = await instructionMessages(fx.home);
      if (injected.length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(injected.length).toBeGreaterThanOrEqual(2);
    for (const text of injected) {
      expect(text).toContain('DEPLOY-RULE');
      expect(text).not.toContain('PRIVATE-RULE');
    }
  }, 120000);
});

/** 日誌裡 agent-instructions 注入的那些 user/message 的內容。 */
async function instructionMessages(home: string): Promise<string[]> {
  const directory = join(home, 'sessions');
  let names: string[];
  try {
    names = await readdir(directory, { recursive: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of names.filter((entry) => entry.endsWith('.jsonl'))) {
    for (const line of (await readFile(join(directory, name), 'utf8')).split('\n')) {
      if (line.length === 0) continue;
      const event = JSON.parse(line) as { type: string; data: unknown };
      if (
        event.type === 'user/message' &&
        (event.data as { source?: { plugin?: string } }).source?.plugin ===
          'AgentInstructionsMiddleware'
      ) {
        found.push(JSON.stringify(event.data));
      }
    }
  }
  return found;
}

describe('其餘組合', () => {
  it('沒給 --workspace：不配私有根、不建基底，照舊虛擬檔案系統', async () => {
    const fx = await fixture();
    const tools = await turn(await start(fx, PROBE, { workspace: false }), 'a');
    expect(thread(tools, 'ls').text).not.toContain(`${SHARED_WORKSPACE_PREFIX}/`);
    expect(await privateRoots(fx)).toEqual([]);
  }, 60000);

  it('「thread → 根」明著回 undefined：這條 thread 沒有圍堵，不退回 --workspace', async () => {
    const fx = await fixture();
    const tools = await turn(await start(fx, WRITE, { workspaceRootOf: () => undefined }), 'a');
    expect(thread(tools, 'write_file').status).toBe('done');
    // 寫進虛擬檔案系統，沒有落在 --workspace。
    expect(await readdir(fx.shared)).toEqual(['ref.md']);
  }, 60000);

  describe('落盤關掉（PM 裁決 (f)）：可寫根是記憶體，--workspace 照樣唯讀掛上', () => {
    it('A 寫的檔 B 看不到、共用區讀得到寫不了、home 底下沒有私有根、啟動時有披露那一行', async () => {
      const fx = await fixture();
      const lines: string[] = [];
      const server = await start(
        fx,
        [
          // 第一個 `ls` 在自己寫檔**之前**：B 在 A 寫完之後才跑，共用的話 B 的第一個 `ls` 就列得到 A 的檔。
          { content: '', toolCalls: [{ name: 'ls', args: { path: '/' } }] },
          {
            content: '',
            toolCalls: [{ name: 'write_file', args: { file_path: '/r.csv', content: 'ROW-4242' } }],
          },
          { content: '', toolCalls: [{ name: 'ls', args: { path: '/' } }] },
          {
            content: '',
            toolCalls: [
              { name: 'read_file', args: { file_path: `${SHARED_WORKSPACE_PREFIX}/ref.md` } },
            ],
          },
          {
            content: '',
            toolCalls: [
              {
                name: 'write_file',
                args: { file_path: `${SHARED_WORKSPACE_PREFIX}/x.txt`, content: 'n' },
              },
            ],
          },
          { content: '完。' },
        ],
        { argv: ['--patch', PERSISTENCE_OFF_PATCH], log: (line) => lines.push(line) },
      );
      const a = await turn(server, 'a');
      const [aBefore, aAfter] = a.filter((tool) => tool.name === 'ls');
      expect(aBefore?.text).not.toContain('r.csv');
      expect(aAfter?.text).toContain('/r.csv');
      expect(thread(a, 'read_file').text).toContain('REF-CONTENT');
      expect(a.filter((tool) => tool.name === 'write_file').map((tool) => tool.status)).toEqual([
        'done',
        'failed',
      ]);
      // B：看不到 A 的檔（B 的第一個 `ls` 在自己寫檔之前）。
      const b = await turn(server, 'b');
      expect(b.find((tool) => tool.name === 'ls')?.text).not.toContain('r.csv');
      // 檔沒落磁碟：--workspace 不變，home 底下的項目跟基線一樣（不抄 CLI 那條「home 不存在」）。
      expect(await readdir(fx.shared)).toEqual(['ref.md']);
      // 基線：同一個組合、沒給 --workspace、同樣兩條 thread（home 底下本來就會有 serve.lock、瀏覽器密鑰、附件根這些）。
      const control = await fixture();
      const controlServer = await start(control, [{ content: '好。' }], {
        argv: ['--patch', PERSISTENCE_OFF_PATCH],
        workspace: false,
      });
      await turn(controlServer, 'a');
      await turn(controlServer, 'b');
      await controlServer.close();
      running = undefined;
      expect((await readdir(fx.home)).sort()).toEqual((await readdir(control.home)).sort());
      expect(await privateRoots(fx)).toEqual([]);
      expect(lines.join('\n')).toMatch(/落盤關掉.*記憶體.*唯讀共用區/su);
    }, 120000);

    it('--sandbox 在這個組合下起不來（沒有磁碟上的 fence 可以套）', async () => {
      const fx = await fixture();
      await expect(
        start(fx, WRITE, { argv: ['--patch', PERSISTENCE_OFF_PATCH, '--sandbox', 'read-only'] }),
      ).rejects.toThrow(/--sandbox 要配落盤/u);
    }, 60000);

    it('/permission 在沒有圍堵的 thread 上不適用，不寫事件', async () => {
      const fx = await fixture();
      const server = await start(fx, [{ content: '好。' }], {
        argv: ['--patch', PERSISTENCE_OFF_PATCH],
      });
      const client = await serveClient(server);
      // 先讓 thread 出生（說一輪），再量事件數：`/permission` 前後，這條 thread 日誌上的事件一顆都不能多。
      await turn(server, 'a');
      const eventCount = async (): Promise<number> => {
        const page = await client.threadHistory('a');
        if (page.kind !== 'ok') throw new Error(`歷史拿不到：${page.message}`);
        return page.result.events.length;
      };
      const before = await eventCount();
      expect(before).toBeGreaterThan(0);
      for (const input of ['/permission', '/permission read-only', '/permission workspace-write']) {
        const result = await client.slashRun('a', input);
        expect(JSON.stringify(result)).toContain('不適用');
      }
      expect(await eventCount()).toBe(before);
    }, 60000);
  });

  it('基底跟工具結果暫存根重疊：serve 起不來，點名是哪一對', async () => {
    const fx = await fixture();
    const overlapping = join(fx.home, THREAD_ROOTS_DIR_NAME, 'stash');
    await mkdir(overlapping, { recursive: true, mode: 0o700 });
    await expect(
      start(fx, WRITE, {
        extraRows: `- id: tool-result-stash
  config:
    root: ${overlapping}
`,
      }),
    ).rejects.toThrow(/工具結果暫存根/u);
  }, 60000);

  it('基底包住會話日誌目錄（--session-log 指進基底）：serve 起不來，點名是哪一對', async () => {
    const fx = await fixture();
    const overlapping = join(fx.home, THREAD_ROOTS_DIR_NAME, 'logs');
    await mkdir(overlapping, { recursive: true, mode: 0o700 });
    await expect(start(fx, WRITE, { argv: ['--session-log', overlapping] })).rejects.toThrow(
      /會話日誌目錄/u,
    );
  }, 60000);
});

/** 這條 thread 的 root 日誌（落盤的那一份）裡每一顆事件。 */
async function logEvents(
  home: string,
  threadId: string,
): Promise<{ type: string; seq: number; data: unknown }[]> {
  const directory = join(home, 'sessions');
  const names = await readdir(directory, { recursive: true });
  const found = names.find((name) => name.endsWith(`${threadId}.jsonl`) && !name.includes('%2f'));
  if (found === undefined) throw new Error(`找不到 ${threadId} 的日誌`);
  return (await readFile(join(directory, found), 'utf8'))
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { type: string; seq: number; data: unknown });
}

describe('#1620 例外的前提：私有根在 home 底下，模型的位址空間碰不到 home', () => {
  it('../../<home 的檔> 回 Path traversal；寫 /../x 被拒；.credentials.yaml、sessions/、attachments/ 到不了', async () => {
    const fx = await fixture();
    await writeFile(join(fx.home, '.credentials.yaml'), 'HOME-SECRET', { mode: 0o600 });
    for (const dir of ['sessions', 'attachments']) {
      await mkdir(join(fx.home, dir), { recursive: true, mode: 0o700 });
      await writeFile(join(fx.home, dir, 'leak.txt'), 'HOME-LEAK', { mode: 0o600 });
    }
    const tools = await turn(
      await start(fx, [
        {
          content: '',
          toolCalls: [{ name: 'read_file', args: { file_path: '../../.credentials.yaml' } }],
        },
        {
          content: '',
          toolCalls: [{ name: 'write_file', args: { file_path: '/../x', content: 'no' } }],
        },
        {
          content: '',
          toolCalls: [{ name: 'read_file', args: { file_path: '/.credentials.yaml' } }],
        },
        { content: '', toolCalls: [{ name: 'ls', args: { path: '/sessions' } }] },
        { content: '', toolCalls: [{ name: 'ls', args: { path: '/attachments' } }] },
        {
          content: '',
          toolCalls: [{ name: 'read_file', args: { file_path: '/attachments/leak.txt' } }],
        },
        {
          content: '',
          toolCalls: [{ name: 'read_file', args: { file_path: '/../../sessions/leak.txt' } }],
        },
        { content: '完。' },
      ]),
      'a',
    );
    const [traversal, absolute, attachmentRead, upSessions] = tools.filter(
      (tool) => tool.name === 'read_file',
    );
    expect(traversal?.status).toBe('failed');
    expect(`${traversal?.text ?? ''}${traversal?.error ?? ''}`).toContain(
      'Path traversal not allowed',
    );
    expect(thread(tools, 'write_file').status).toBe('failed');
    // 寫 `/../x`：圍堵那一道就拒（路徑裡有 `..`），不是剛好落在哪裡。
    expect(
      `${thread(tools, 'write_file').error ?? ''}${thread(tools, 'write_file').text ?? ''}`,
    ).toContain('路徑裡有 ".."');
    // 絕對路徑映到 A 的根底下，那裡沒有這個檔。
    expect(absolute?.status).toBe('failed');
    expect(attachmentRead?.status).toBe('failed');
    expect(upSessions?.status).toBe('failed');
    for (const listing of tools.filter((tool) => tool.name === 'ls')) {
      expect(listing.text ?? '').not.toContain('leak.txt');
    }
    // 整輪模型看到的任何一段文字都沒有 home 裡的內容。
    expect(textsOf(tools)).not.toContain('HOME-SECRET');
    expect(textsOf(tools)).not.toContain('HOME-LEAK');
    // 寫 `/../x` 沒有在任何地方落檔：基底、home、私有根旁邊都沒有。
    for (const where of [join(base(fx), 'x'), join(fx.home, 'x'), join(fx.shared, 'x')]) {
      await expect(stat(where)).rejects.toThrow();
    }
  }, 60000);
});

describe('啟動時基底的重疊與權限（符號連結造出來的重疊也要擋）', () => {
  it('基底是指向 --workspace 的符號連結：home 本身沒有重疊所以 #1620 不響，這一道要擋，點名 --workspace', async () => {
    const fx = await fixture();
    await symlink(fx.shared, join(fx.home, THREAD_ROOTS_DIR_NAME));
    await expect(start(fx, WRITE)).rejects.toThrow(/- --workspace：/u);
    expect(await readdir(fx.shared)).toEqual(['ref.md']);
  }, 60000);

  it('附件根是指進基底的符號連結（<home>/attachments → <home>/thread-roots）：點名附件根', async () => {
    const fx = await fixture();
    await mkdir(base(fx), { recursive: true, mode: 0o700 });
    await symlink(base(fx), join(fx.home, 'attachments'));
    await expect(start(fx, WRITE)).rejects.toThrow(/- 附件根：/u);
  }, 60000);

  it('基底已經在、卻群組可寫：啟動就拒（不等第一條新 thread 才拋），訊息不是「這條對話」', async () => {
    const fx = await fixture();
    await mkdir(base(fx), { recursive: true, mode: 0o700 });
    await chmod(base(fx), 0o770);
    const error = await start(fx, WRITE).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toContain('私有可寫根');
    expect(error?.message).toContain('拒絕啟動');
  }, 60000);
});

describe('交付與重啟', () => {
  const WRITE_THEN_PRESENT: ScriptedTurn[] = [
    {
      content: '',
      toolCalls: [{ name: 'write_file', args: { file_path: '/r.csv', content: 'ROW-4242' } }],
    },
    { content: '交付。', toolCalls: [{ name: 'present', args: { files: [{ path: '/r.csv' }] } }] },
    { content: '完。' },
  ];

  it('B 的 present 讀不到 A 根裡的檔', async () => {
    const fx = await fixture();
    await turn(await start(fx, WRITE_THEN_PRESENT), 'a');
    const b = await turn(
      await start(fx, [
        {
          content: '交付。',
          toolCalls: [{ name: 'present', args: { files: [{ path: '/r.csv' }] } }],
        },
        { content: '完。' },
      ]),
      'b',
    );
    expect(thread(b, 'present').status).toBe('failed');
    expect(
      (await logEvents(fx.home, 'b')).some((event) => event.type === 'deliverables/presented'),
    ).toBe(false);
  }, 90000);

  it('重啟之後，A 之前 present 的交付讀得到（從 header 記的私有根讀）', async () => {
    const fx = await fixture();
    await turn(await start(fx, WRITE_THEN_PRESENT), 'a');
    const presented = (await logEvents(fx.home, 'a')).find(
      (event) => event.type === 'deliverables/presented',
    );
    expect(presented).toBeDefined();
    await running?.close();
    running = undefined;

    const server = await start(fx, [{ content: '好。' }]);
    const cookie = await exchangeServeToken(server.authenticatedUrl);
    const withCookie = fetchWithCookie(cookie);
    // 拿歷史就把 thread 建起來了，路由才問得到錨。
    const page = await (await serveClient(server)).threadHistory('a');
    expect(page.kind).toBe('ok');
    const read = await createDeliverableClient({ baseUrl: server.url, fetch: withCookie }).read(
      'a',
      {
        seq: presented!.seq,
        index: 0,
      },
    );
    expect(read.kind).toBe('ok');
    expect(JSON.stringify(read)).toContain('ROW-4242');
  }, 120000);
});

describe('不自動清：閒置逐出與封存之後，私有根和裡面的檔都還在', () => {
  const EVICT_ROWS = '- id: thread-capacity\n  config:\n    idleEvictAfterMs: 50\n';

  it('閒置逐出', async () => {
    const fx = await fixture();
    const lines: string[] = [];
    const server = await start(fx, WRITE, { extraRows: EVICT_ROWS, log: bodyLog(lines) });
    // 逐出要這條 thread 沒有任何下行握著：turn() 只收迭代器、不斷連線，這裡自己中止。
    const client = await serveClient(server);
    const controller = new AbortController();
    const events = await client.openEvents('a', { signal: controller.signal });
    await client.runStart('a', '開始。');
    await foldTurn(events);
    controller.abort();
    await events.return?.(undefined).catch(() => undefined);
    const rootA = (await headerOf(fx.home, 'a')).workspaceRoot!;
    const deadline = Date.now() + 15000;
    while (
      !lines.some((line) => line.startsWith('[閒置逐出] thread "a"')) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // 前提：真的逐出了，不然「還在」什麼都沒證明。
    expect(lines.some((line) => line.startsWith('[閒置逐出] thread "a"'))).toBe(true);
    expect(await readFile(join(rootA, 'r.csv'), 'utf8')).toBe('ROW-4242');
    expect(await privateRoots(fx)).toHaveLength(1);
  }, 90000);

  it('封存與取消封存', async () => {
    const fx = await fixture();
    const server = await start(fx, WRITE);
    await turn(server, 'a');
    const rootA = (await headerOf(fx.home, 'a')).workspaceRoot!;
    const client = await serveClient(server);
    expect((await client.threadArchive('a')).kind).toBe('ok');
    expect(await readFile(join(rootA, 'r.csv'), 'utf8')).toBe('ROW-4242');
    await client.threadUnarchive('a');
    expect(await readFile(join(rootA, 'r.csv'), 'utf8')).toBe('ROW-4242');
    expect(await privateRoots(fx)).toHaveLength(1);
  }, 90000);
});

describe('子代理拿的是那條 thread 的根', () => {
  it('前景子代理寫的檔落在 A 的私有根，--workspace 與 B 都沒有', async () => {
    const fx = await fixture();
    const server = await start(fx, [
      {
        content: '委派。',
        toolCalls: [
          { name: 'subagent', args: { description: '幹活', subagent_type: 'general-purpose' } },
        ],
      },
      {
        content: '',
        toolCalls: [
          { name: 'write_file', args: { file_path: '/by-foreground.txt', content: 'F' } },
        ],
      },
      { content: '子代理做完了。' },
      { content: '收到。' },
    ]);
    await turn(server, 'a');
    const rootA = (await headerOf(fx.home, 'a')).workspaceRoot!;
    expect(await readFile(join(rootA, 'by-foreground.txt'), 'utf8')).toBe('F');
    expect(await readdir(fx.shared)).toEqual(['ref.md']);
    const b = await turn(await start(fx, PROBE), 'b');
    expect(thread(b, 'ls').text).not.toContain('by-foreground.txt');
  }, 120000);

  it('冷復活的背景子代理（重啟後叫醒）寫的檔落在 A 的私有根，--workspace 沒有', async () => {
    const fx = await fixture();
    const first = await start(fx, [
      {
        content: '委派。',
        toolCalls: [
          {
            name: 'subagent',
            args: {
              description: '幹活',
              subagent_type: 'general-purpose',
              run_in_background: true,
            },
          },
        ],
      },
      { content: '子代理做完了。' },
      { content: '收到。' },
    ]);
    await turn(first, 'a');
    const rootA = (await headerOf(fx.home, 'a')).workspaceRoot!;
    // 等背景子代理的日誌出現並收尾（第一輪做完），取它的 run id。
    const sessions = join(fx.home, 'sessions');
    let runId: string | undefined;
    const deadline = Date.now() + 15000;
    while (runId === undefined && Date.now() < deadline) {
      const names = await readdir(sessions, { recursive: true });
      const body = names.find((name) => name.includes('a%2fbg-') && name.endsWith('.jsonl'));
      if (body !== undefined) {
        const text = await readFile(join(sessions, body), 'utf8');
        if (text.includes('"turn/end"'))
          runId = body.slice(body.indexOf('a%2f') + 4, -'.jsonl'.length);
      }
      if (runId === undefined) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(runId).toBeDefined();
    await running?.close();
    running = undefined;

    const second = await start(fx, [
      {
        content: '',
        toolCalls: [{ name: 'write_file', args: { file_path: '/woke.txt', content: 'W' } }],
      },
      { content: '完成。' },
    ]);
    expect(await (await serveClient(second)).subagentSend('a', runId!, '起來')).toMatchObject({
      type: 'success',
    });
    const wake = Date.now() + 15000;
    for (;;) {
      try {
        expect(await readFile(join(rootA, 'woke.txt'), 'utf8')).toBe('W');
        break;
      } catch (error) {
        if (Date.now() >= wake) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    expect(await readdir(fx.shared)).toEqual(['ref.md']);
  }, 120000);
});
