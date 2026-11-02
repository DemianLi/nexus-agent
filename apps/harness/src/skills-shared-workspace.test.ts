/**
 * serve 的新 thread 讀得到部署方放在 `--workspace/skills/` 的技能（[#1928](https://github.com/DemianLi/nexus-agent/issues/1928)）。
 *
 * 新 thread 有私有可寫根，`--workspace` 退成唯讀的 `/shared`（#1775）。技能來源寫的是工作區裡的 `/skills/`，在有共用區的 thread
 * 上換成 `/shared/skills/`（`@nexus/core` 的 `threadSkillSources`）。三條路各一盞：模型的清單（`request/system`）、人打的 `/名字`
 * （`skill-invocation` 那一則）、`skill.list`。都走真的 `runServe` 與產品的 placer（不給 `workspaceRootOf`），模型換成腳本。
 *
 * **零憑證、零外部連線**。
 */

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WireClient } from '@nexus/wire';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import type { ScriptedTurn } from './scripted-model.js';
import { scriptedPatchText } from './scripted-serve.js';
import { closedSessionEvents, sessionsUnder } from './session-files.fixture.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import { THREAD_ROOTS_DIR_NAME } from './thread-roots.js';

const temporary: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return dir;
}

function writeSkill(root: string, name: string, description: string, frontmatter = ''): void {
  mkdirSync(join(root, 'skills', name), { recursive: true });
  writeFileSync(
    join(root, 'skills', name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n${frontmatter}---\n\n${name} 的正文：${description}\n`,
  );
}

/** 部署方的工作區：`normal`（模型與人都叫得到）、`deploy`（只給人叫）。 */
function deployerWorkspace(): string {
  const ws = scratch('nexus-skills-shared-ws-');
  writeSkill(ws, 'normal', '部署方的 normal。');
  writeSkill(ws, 'deploy', '部署方的 deploy。', 'disable-model-invocation: true\n');
  return ws;
}

interface Serving {
  readonly home: string;
  readonly client: WireClient;
  /** serve 的日誌各行（`skill.list` 掃描不完整的 warn 寫在這裡，帶 `[技能]`）。 */
  readonly lines: readonly string[];
  /** 在這條 thread 說一句話，等這一輪收尾。 */
  say(threadId: string, text: string): Promise<void>;
  /** 落盤的事件（root 與子代理的日誌都在內），收掉 serve 之後才讀得齊。 */
  events(): Promise<{ type: string; data: unknown }[]>;
  close(): Promise<void>;
}

/** 起一台 serve：產品的 placer（新 thread 配私有根、`--workspace` 掛成 `/shared`），模型是腳本。 */
async function serveOn(ws: string, turns: readonly ScriptedTurn[]): Promise<Serving> {
  const home = scratch('nexus-skills-shared-home-');
  const patch = join(home, 'scripted.patch.yml');
  writeFileSync(patch, scriptedPatchText(turns), { mode: 0o600 });
  const lines: string[] = [];
  const running = (await runServe({
    argv: ['--port', '0', '--workspace', ws, '--patch', patch],
    log: (line) => void lines.push(line),
    env: { [HARNESS_HOME_ENV]: home },
  })) as RunningServe;
  const client = await serveClient(running);
  let closed = false;
  return {
    home,
    client,
    lines,
    async say(threadId, text) {
      const down = await client.openEvents(threadId);
      await client.runStart(threadId, text);
      await foldTurn(down);
      await down.return?.(undefined);
    },
    async events() {
      const out: { type: string; data: unknown }[] = [];
      for (const session of await sessionsUnder(join(home, 'sessions'))) {
        for (const event of await closedSessionEvents(session))
          out.push({ type: event.type, data: event.data });
      }
      return out;
    },
    async close() {
      if (closed) return;
      closed = true;
      await running.close();
    },
  };
}

const systemPrompts = (events: readonly { type: string; data: unknown }[]): string[] =>
  events
    .filter((event) => event.type === 'request/system')
    .map((event) => JSON.stringify((event.data as { system: unknown }).system));

const invoked = (events: readonly { type: string; data: unknown }[]): unknown[] =>
  events
    .filter(
      (event) =>
        event.type === 'user/message' &&
        (event.data as { source?: { kind?: string } }).source?.kind === 'skill-invocation',
    )
    .map((event) => (event.data as { source: { name: string } }).source.name);

async function skillNames(client: WireClient, threadId: string) {
  const outcome = await client.skillList(threadId);
  if (outcome.kind !== 'ok') throw new Error(`skill.list 沒回清單：${JSON.stringify(outcome)}`);
  return outcome.skills.map((skill) => [skill.name, skill.path, skill.description]);
}

describe('新 thread 讀 --workspace/skills/（經 /shared）', () => {
  it('模型的清單：system prompt 列了 /shared/skills/normal，只給人叫的 deploy 不列', async () => {
    const serving = await serveOn(deployerWorkspace(), [{ content: '好。' }]);
    try {
      await serving.say('t-model', '開工。');
    } finally {
      await serving.close();
    }
    const [system] = systemPrompts(await serving.events());
    expect(system).toContain('/shared/skills/normal/SKILL.md');
    expect(system).toContain('部署方的 normal。');
    expect(system).not.toContain('deploy');
  }, 90000);

  it('人打 /deploy：注入部署方那一份', async () => {
    const serving = await serveOn(deployerWorkspace(), [{ content: '好。' }]);
    try {
      await serving.say('t-invoke', '請 /deploy');
    } finally {
      await serving.close();
    }
    const events = await serving.events();
    expect(invoked(events)).toEqual(['deploy']);
    const injected = events.find(
      (event) =>
        event.type === 'user/message' &&
        (event.data as { source?: { kind?: string } }).source?.kind === 'skill-invocation',
    );
    expect(JSON.stringify(injected?.data)).toContain('部署方的 deploy。');
  }, 90000);

  it('skill.list：一句話都還沒說就列得到 [deploy, normal]，路徑在 /shared/skills/ 底下', async () => {
    const serving = await serveOn(deployerWorkspace(), [{ content: '好。' }]);
    try {
      expect(await skillNames(serving.client, 't-list')).toEqual([
        ['deploy', '/shared/skills/deploy/SKILL.md', '部署方的 deploy。'],
        ['normal', '/shared/skills/normal/SKILL.md', '部署方的 normal。'],
      ]);
    } finally {
      await serving.close();
    }
  }, 90000);
});

describe('私有根裡的技能不生效', () => {
  it('私有根放同名的 normal 與新的 rogue：清單照舊是部署方的，/rogue 叫不出來，模型的清單也沒有', async () => {
    const serving = await serveOn(deployerWorkspace(), [{ content: '好。' }]);
    try {
      // 先打一次 `skill.list` 讓 placer 配出私有根，再往裡面放技能（模型寫檔的效果）。放在第一次呼叫模型之前：這條 thread 的
      // 模型清單在第一次呼叫時就掃定了，之後放的進不了清單，這一盞就量不到模型那一側。
      await serving.client.skillList('t-private');
      const roots = readdirSync(join(serving.home, THREAD_ROOTS_DIR_NAME));
      expect(roots).toHaveLength(1);
      const privateRoot = join(serving.home, THREAD_ROOTS_DIR_NAME, roots[0]!);
      writeSkill(privateRoot, 'normal', '私有根的 normal。');
      writeSkill(privateRoot, 'rogue', '私有根的 rogue。');

      expect(await skillNames(serving.client, 't-private')).toEqual([
        ['deploy', '/shared/skills/deploy/SKILL.md', '部署方的 deploy。'],
        ['normal', '/shared/skills/normal/SKILL.md', '部署方的 normal。'],
      ]);
      await serving.say('t-private', '請 /rogue');
    } finally {
      await serving.close();
    }
    const events = await serving.events();
    expect(invoked(events)).toEqual([]);
    for (const system of systemPrompts(events)) {
      expect(system).not.toContain('rogue');
      expect(system).not.toContain('私有根的 normal。');
    }
  }, 90000);
});

describe('general-purpose 子代理', () => {
  it('跟 root 讀同一份：清單有 /shared/skills/normal，私有根的 rogue 沒有', async () => {
    const serving = await serveOn(deployerWorkspace(), [
      {
        content: '委派。',
        // serve 的 `subagent` 預設派背景：root 這一輪當場收尾，子代理第一次呼叫模型可能落在 close 之後。前景派，這一輪等它跑完。
        toolCalls: [
          {
            name: 'subagent',
            args: {
              description: '幹活',
              subagent_type: 'general-purpose',
              run_in_background: false,
            },
          },
        ],
      },
      { content: '子代理做完了。' },
      { content: '收工。' },
    ]);
    try {
      // 同上一盞：私有根要在第一次呼叫模型之前放好。
      await serving.client.skillList('t-gp');
      const roots = readdirSync(join(serving.home, THREAD_ROOTS_DIR_NAME));
      writeSkill(join(serving.home, THREAD_ROOTS_DIR_NAME, roots[0]!), 'rogue', '私有根的 rogue。');
      await serving.say('t-gp', '開工。');
    } finally {
      await serving.close();
    }
    // root 的會話 id 是 thread id，子代理的是 `<thread>/<runId>`；各自的日誌各記一則 `request/system`。
    const sessions = await sessionsUnder(join(serving.home, 'sessions'));
    const ids = sessions.map((session) => session.id).sort();
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe('t-gp');
    expect(ids[1]).toMatch(/^t-gp\//);
    for (const session of sessions) {
      const systems = systemPrompts(await closedSessionEvents(session));
      expect(systems, session.id).toHaveLength(1);
      expect(systems[0], session.id).toContain('/shared/skills/normal/SKILL.md');
      expect(systems[0], session.id).not.toContain('rogue');
    }
  }, 90000);
});

describe('--workspace 底下沒有 skills/', () => {
  it('三條路都是空的，也不 warn（共用區上的目錄不存在不算掃描不完整）', async () => {
    const warn = vi.spyOn(console, 'warn');
    const serving = await serveOn(scratch('nexus-skills-shared-empty-'), [{ content: '好。' }]);
    try {
      expect(await skillNames(serving.client, 't-empty')).toEqual([]);
      await serving.say('t-empty', '請 /deploy');
    } finally {
      await serving.close();
    }
    const events = await serving.events();
    expect(invoked(events)).toEqual([]);
    expect(systemPrompts(events).join('\n')).not.toContain('/shared/skills/');
    expect(warn.mock.calls.flat().join('\n')).not.toContain('掃描不完整');
    expect(serving.lines.join('\n')).not.toContain('[技能]');
  }, 90000);
});
