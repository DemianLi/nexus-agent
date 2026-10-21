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

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
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
      const result = await (await serveClient(server)).slashRun('a', '/permission read-only');
      expect(JSON.stringify(result)).toContain('不適用');
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
