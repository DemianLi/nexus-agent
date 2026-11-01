/**
 * **舊 thread 寫不進新 thread 會讀成指示或技能的地方**（[#1960](https://github.com/DemianLi/nexus-agent/issues/1960)）。
 *
 * 舊 thread（header 的根就是 `--workspace`，或沒記根）的可寫根就是新 thread 的唯讀共用區。新 thread 從共用區根目錄讀指示檔、從共用區底下的
 * 技能來源讀技能，所以舊 thread 寫進那幾個地方的東西，會變成之後每條新 thread 的工作區指示或叫得出的技能，不分使用者。
 *
 * 從 `runServe` 起量（#1427）：真的 serve、出貨的組裝、產品的 placer、真的 JSONL 日誌；唯一換掉的是模型（腳本）。
 * 舊 thread 照 `thread-private-root.test.ts` 的做法造：先用固定根的接縫跑一輪，header 就記著 `--workspace`，再換回產品的 placer 續接。
 *
 * **零憑證、零外部連線**：目錄都在 `/var/tmp`。
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { scriptedPatchText } from './scripted-serve.js';
import type { ScriptedTurn } from './scripted-model.js';
import { runServe } from './serve.js';
import type { RunningServe, RunServeOptions } from './serve.js';
import { sessionEventsOf } from './session-files.fixture.js';

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
  /** `--workspace`：舊 thread 的可寫根，新 thread 的唯讀共用區。 */
  readonly shared: string;
}

/** 部署方的 `--workspace`：根目錄一份 `AGENTS.md`，`skills/` 底下一份技能。 */
async function fixture(): Promise<Fixture> {
  const home = await scratch('nexus-legacy-guard-home-');
  const shared = await scratch('nexus-legacy-guard-ws-');
  await writeFile(join(shared, 'AGENTS.md'), 'DEPLOY-RULE', 'utf8');
  await mkdir(join(shared, 'skills', 'normal'), { recursive: true });
  await writeFile(
    join(shared, 'skills', 'normal', 'SKILL.md'),
    '---\nname: normal\ndescription: 部署方的 normal。\n---\n\nnormal 的正文。\n',
    'utf8',
  );
  return { home, shared };
}

interface StartOptions {
  readonly argv?: readonly string[];
  readonly extraRows?: string;
  readonly workspaceRootOf?: RunServeOptions['workspaceRootOf'];
}

/** 起一台 serve，模型是這份腳本（每條 thread 從第一輪開始吃）。 */
async function start(
  fx: Fixture,
  turns: readonly ScriptedTurn[],
  options: StartOptions = {},
): Promise<RunningServe> {
  await running?.close();
  running = undefined;
  const patch = join(await scratch('nexus-legacy-guard-patch-'), 'script.patch.yml');
  await writeFile(patch, scriptedPatchText(turns, options.extraRows), 'utf8');
  running = (await runServe({
    argv: ['--port', '0', '--workspace', fx.shared, '--patch', patch, ...(options.argv ?? [])],
    log: () => undefined,
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
  readonly args?: unknown;
}

/** 跑一輪，回這一輪的工具條目。 */
async function turn(server: RunningServe, thread: string): Promise<ToolEntry[]> {
  const client = await serveClient(server);
  const events = await client.openEvents(thread);
  await client.runStart(thread, '開始。');
  const state = await foldTurn(events);
  await events.return?.(undefined);
  return (state.entries as unknown as { kind: string }[]).filter(
    (entry): entry is ToolEntry => entry.kind === 'tool',
  );
}

/** 先用固定根的接縫跑一輪：header 記著 `--workspace` 的根，這就是一條舊 thread。 */
async function makeOldThread(fx: Fixture, id: string, options: StartOptions = {}): Promise<void> {
  await turn(
    await start(fx, [{ content: '好。' }], { ...options, workspaceRootOf: () => fx.shared }),
    id,
  );
  await running?.close();
  running = undefined;
}

/** 部署方在權限表加上全開那一組（出廠表沒有，#1621）。 */
const FULL_ACCESS_ROWS = `- id: permission-presets
  config:
    presets:
      read-only: { sandbox: read-only, approval: ask }
      workspace-write: { sandbox: workspace-write, approval: ask }
      danger-full-access: { sandbox: danger-full-access, approval: never }
`;

const write = (file_path: string, content: string) => ({
  name: 'write_file',
  args: { file_path, content },
});
const edit = (file_path: string, old_string: string, new_string: string) => ({
  name: 'edit_file',
  args: { file_path, old_string, new_string },
});

/** 一輪裡叫一次工具：一次一個，結果的順序就是呼叫的順序。 */
function oneByOne(calls: readonly { name: string; args: unknown }[]): ScriptedTurn[] {
  return [
    ...calls.map((call) => ({ content: '', toolCalls: [call] }) as ScriptedTurn),
    { content: '完。' },
  ];
}

/** 這條 thread 的日誌裡，agent-instructions 注入的那幾則。 */
async function instructionsOf(home: string, threadId: string): Promise<string[]> {
  return (await sessionEventsOf(join(home, 'sessions'), threadId))
    .filter(
      (event) =>
        event.type === 'user/message' &&
        (event.data as { source?: { plugin?: string } }).source?.plugin ===
          'AgentInstructionsMiddleware',
    )
    .map((event) => JSON.stringify(event.data));
}

async function skillNames(server: RunningServe, threadId: string): Promise<string[]> {
  const outcome = await (await serveClient(server)).skillList(threadId);
  if (outcome.kind !== 'ok') throw new Error(`skill.list 沒回清單：${JSON.stringify(outcome)}`);
  return outcome.skills.map((skill) => skill.name).sort();
}

const exists = async (path: string): Promise<boolean> =>
  (await stat(path).catch(() => undefined)) !== undefined;

describe('舊 thread 寫的指示檔不會變成新 thread 的工作區指示', () => {
  it('舊 thread 寫 /CLAUDE.md 被拒；新 thread 第一輪的指示只有部署方那份', async () => {
    const fx = await fixture();
    await makeOldThread(fx, 'old');

    const old = await turn(await start(fx, oneByOne([write('/CLAUDE.md', 'LEGACY-RULE')])), 'old');
    expect(old[0]?.error).toContain('[containment]');
    expect(await readFile(join(fx.shared, 'AGENTS.md'), 'utf8')).toBe('DEPLOY-RULE');

    await turn(await start(fx, [{ content: '好。' }]), 'fresh');
    const injected = await instructionsOf(fx.home, 'fresh');
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain('DEPLOY-RULE');
    expect(injected[0]).not.toContain('LEGACY-RULE');
  }, 120000);
});

describe('舊 thread 寫的技能不會出現在新 thread 的技能清單', () => {
  it('舊 thread 寫 /skills/rogue/SKILL.md 被拒；新 thread 的清單只有部署方的 normal', async () => {
    const fx = await fixture();
    await makeOldThread(fx, 'old');

    const old = await turn(
      await start(
        fx,
        oneByOne([
          write(
            '/skills/rogue/SKILL.md',
            '---\nname: rogue\ndescription: 舊 thread 寫的。\n---\n\nrogue。\n',
          ),
        ]),
      ),
      'old',
    );
    expect(old[0]?.error).toContain('[containment]');
    expect(await exists(join(fx.shared, 'skills', 'rogue'))).toBe(false);

    expect(await skillNames(await start(fx, [{ content: '好。' }]), 'fresh')).toEqual(['normal']);
  }, 120000);
});

describe('同一個舊 thread：其他地方照常，四個指示檔名、技能目錄與 edit 都擋', () => {
  it('擋與不擋的逐格結果', async () => {
    const fx = await fixture();
    await makeOldThread(fx, 'old');
    const calls = [
      { name: 'read_file', args: { file_path: '/AGENTS.md' } },
      { name: 'read_file', args: { file_path: '/skills/normal/SKILL.md' } },
      write('/AGENTS.md', 'LEGACY-RULE'),
      edit('/AGENTS.md', 'DEPLOY-RULE', 'LEGACY-RULE'),
      write('/CLAUDE.md', 'LEGACY-RULE'),
      write('/AGENTS.local.md', 'LEGACY-RULE'),
      write('/CLAUDE.local.md', 'LEGACY-RULE'),
      write('/skills/deep/a/b.md', 'x'),
      edit('/skills/normal/SKILL.md', '正文', 'ROGUE'),
      write('/notes.md', 'NOTE'),
      write('/sub/AGENTS.md', 'SUB'),
      write('/skillsx/a.md', 'NEAR'),
    ];
    const tools = await turn(await start(fx, oneByOne(calls)), 'old');
    const outcome = tools.slice(2).map((tool) => tool.error?.includes('[containment]') === true);
    expect(outcome).toEqual([true, true, true, true, true, true, true, false, false, false]);

    expect(await readFile(join(fx.shared, 'AGENTS.md'), 'utf8')).toBe('DEPLOY-RULE');
    for (const name of ['CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']) {
      expect(await exists(join(fx.shared, name))).toBe(false);
    }
    expect(await exists(join(fx.shared, 'skills', 'deep'))).toBe(false);
    expect(await readFile(join(fx.shared, 'skills', 'normal', 'SKILL.md'), 'utf8')).toContain(
      'normal 的正文',
    );
    expect(await readFile(join(fx.shared, 'notes.md'), 'utf8')).toBe('NOTE');
    expect(await readFile(join(fx.shared, 'sub', 'AGENTS.md'), 'utf8')).toBe('SUB');
    expect(await readFile(join(fx.shared, 'skillsx', 'a.md'), 'utf8')).toBe('NEAR');
  }, 120000);

  it('舊 thread 跑在 danger-full-access：照樣擋', async () => {
    const fx = await fixture();
    const fullAccess = { argv: ['--sandbox', 'danger-full-access'], extraRows: FULL_ACCESS_ROWS };
    await makeOldThread(fx, 'old', fullAccess);
    const tools = await turn(
      await start(
        fx,
        oneByOne([write('/CLAUDE.md', 'LEGACY-RULE'), write('/skills/x/SKILL.md', 'x')]),
        fullAccess,
      ),
      'old',
    );
    expect(tools.map((tool) => tool.error ?? '')).toEqual([
      expect.stringContaining('mode: danger-full-access'),
      expect.stringContaining('mode: danger-full-access'),
    ]);
    expect(await exists(join(fx.shared, 'CLAUDE.md'))).toBe(false);
    expect(await exists(join(fx.shared, 'skills', 'x'))).toBe(false);
  }, 120000);
});

/** 部署方掛上 `memory` 插件：一份來源在共用區，一份在每條新 thread 自己的私有根。 */
const MEMORY_ROWS = `- insert:
    - id: memory
      name: '@nexus/plugin-memory'
      config:
        sources: ['/shared/MEMORY.md', '/NOTES.md']
`;

describe('舊 thread 改不到新 thread 的記憶來源（#2270）', () => {
  it('edit 與 write 都被拒，新 thread 讀到部署方那份；私有根的來源不擋', async () => {
    const fx = await fixture();
    await writeFile(join(fx.shared, 'MEMORY.md'), 'DEPLOY-MEMORY', 'utf8');
    const memory = { extraRows: MEMORY_ROWS };
    await makeOldThread(fx, 'old', memory);

    const old = await turn(
      await start(
        fx,
        oneByOne([
          { name: 'read_file', args: { file_path: '/MEMORY.md' } },
          { name: 'read_file', args: { file_path: '/memory.md' } },
          edit('/MEMORY.md', 'DEPLOY-MEMORY', 'LEGACY-MEMORY'),
          write('/MEMORY.md', 'LEGACY-MEMORY'),
          write('/memory.md', 'LEGACY-MEMORY'),
          write('/NOTES.md', 'NOTE'),
        ]),
        memory,
      ),
      'old',
    );
    expect(old.slice(2).map((tool) => tool.error?.includes('記憶來源') === true)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(await readFile(join(fx.shared, 'MEMORY.md'), 'utf8')).toBe('DEPLOY-MEMORY');
    expect(await readFile(join(fx.shared, 'NOTES.md'), 'utf8')).toBe('NOTE');

    const fresh = await turn(
      await start(
        fx,
        oneByOne([{ name: 'read_file', args: { file_path: '/shared/MEMORY.md' } }]),
        memory,
      ),
      'fresh',
    );
    expect(fresh[0]?.text).toContain('DEPLOY-MEMORY');
  }, 120000);

  it('反例：沒掛 memory 插件，同一個檔照常能改', async () => {
    const fx = await fixture();
    await writeFile(join(fx.shared, 'MEMORY.md'), 'DEPLOY-MEMORY', 'utf8');
    await makeOldThread(fx, 'old');

    const old = await turn(
      await start(
        fx,
        oneByOne([
          { name: 'read_file', args: { file_path: '/MEMORY.md' } },
          write('/MEMORY.md', 'NOTE'),
        ]),
      ),
      'old',
    );
    expect(old[1]?.error).toBeUndefined();
    expect(await readFile(join(fx.shared, 'MEMORY.md'), 'utf8')).toBe('NOTE');
  }, 120000);
});

describe('新 thread 不受這道守衛影響', () => {
  it('寫自己私有根的 /CLAUDE.md 與 /skills/x/SKILL.md 照常，不會被注入', async () => {
    const fx = await fixture();
    const tools = await turn(
      await start(
        fx,
        oneByOne([write('/CLAUDE.md', 'PRIVATE-RULE'), write('/skills/x/SKILL.md', 'x')]),
      ),
      'fresh',
    );
    expect(tools.map((tool) => tool.error)).toEqual([undefined, undefined]);
    expect(await exists(join(fx.shared, 'CLAUDE.md'))).toBe(false);
    const injected = await instructionsOf(fx.home, 'fresh');
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain('DEPLOY-RULE');
    expect(injected[0]).not.toContain('PRIVATE-RULE');
  }, 120000);
});
