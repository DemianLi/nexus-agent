/**
 * 人寫 `/名字` 叫用技能（[#1574](https://github.com/DemianLi/nexus-agent/issues/1574) 刀 2，驗收 4–8）。
 *
 * 兩層：listener 本身（真的訊息、真的 `ContainedFilesystemBackend`，fs 查找是替身，才量得到 root／子代理、不完整這幾格），
 * 與樹上（真的 `createCordisRoot`、真的 `loadDefaultPlugins`、真的 `root.boot`，日誌接真的 `SessionRegistry`）。
 * 樹上那一層量的是產品路徑：出貨清單上 `skill-invocation` 這一列、宿主的 `agent/pre-step` middleware、`skills` 列登記的來源。
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { PreStepInjection, PreStepListener } from '@nexus/agent-loop';
import {
  MESSAGE_SOURCE_KWARG,
  replayConversation,
  SESSION_LOG_FORMAT_VERSION,
  SessionRegistry,
  sourceKwargs,
} from '@nexus/core';
import type { MessageSource, PluginEntry, SessionAddress } from '@nexus/core';
import type { FsLookup } from '@nexus/fs';
import { isAgentInstructionsMessage } from '@nexus/plugin-agent-instructions';
import {
  createSkillInvocationListener,
  SKILL_INVOCATION_MARKER,
} from '@nexus/plugin-skills/invocation';
import { TIME_CONTEXT_MARKER } from '@nexus/plugin-time-context';
import type { FileDownloadResponse } from 'deepagents';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContainedFilesystemBackend } from './contained-backend.js';
import { historyFrames } from './conversation-history.js';
import { createCordisRoot, entryApprovalChannel } from './cordis-root.js';
import type { CordisRoot, NexusAssembly } from './cordis-root.js';
import { withScriptedModel } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { openJsonlSessionStore, sessionPathsIn } from './jsonl-session-store.js';
import { toAgentInvocation } from './messages.js';
import { loadDefaultPlugins } from './plugin-config.js';
import type { LoadedPluginConfig } from './plugin-config.js';
import type { ScriptedChatModel, ScriptedTurn } from './scripted-model.js';
import { DEFAULT_TOOL_TEXT_MAX_BYTES } from './settings/tool-text.js';

const temporary: string[] = [];
const roots: CordisRoot[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await root.dispose().catch(() => {});
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix = 'nexus-skill-invocation-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return dir;
}

interface SkillFile {
  readonly body: string;
  readonly frontmatter?: string;
}

/** 工作區：`{ '<來源目錄>': { '<名字>': { body, frontmatter? } } }`，外加一份 AGENTS.md。 */
function workspace(layout: Record<string, Record<string, SkillFile>>, agentsMd = '規矩。'): string {
  const root = scratch('nexus-skill-invocation-ws-');
  writeFileSync(join(root, 'AGENTS.md'), agentsMd, 'utf8');
  for (const [dir, skills] of Object.entries(layout)) {
    for (const [name, { body, frontmatter }] of Object.entries(skills)) {
      mkdirSync(join(root, dir, name), { recursive: true });
      writeFileSync(
        join(root, dir, name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${name} 的說明。\n${frontmatter ?? ''}---\n\n${body}\n`,
      );
    }
  }
  return root;
}

/** 出廠來源 `/skills/` 底下的三份：一般、只給人叫、只給模型叫。 */
const STANDARD = {
  skills: {
    deploy: { body: '部署的步驟。' },
    'release-notes': { body: '寫發版說明。', frontmatter: 'disable-model-invocation: true\n' },
    'model-only': { body: '只給模型。', frontmatter: 'user-invocable: false\n' },
  },
};

// ---------------------------------------------------------------------------------------------
// listener 本身
// ---------------------------------------------------------------------------------------------

function lookupOf(
  backend: ContainedFilesystemBackend | undefined,
  address: SessionAddress = { kind: 'root' },
): () => FsLookup {
  return () => ({ kind: 'ok', fs: { backend: () => backend } as never, address });
}

function listenerOn(
  backend: ContainedFilesystemBackend | undefined,
  options: { address?: SessionAddress; sources?: readonly string[] } = {},
): PreStepListener {
  return createSkillInvocationListener({
    fs: lookupOf(backend, options.address),
    sources: () => options.sources ?? ['/skills/'],
  });
}

function backendOf(root: string): ContainedFilesystemBackend {
  return new ContainedFilesystemBackend({ rootDir: root, mode: 'workspace-write' });
}

function human(text: string, id = `h-${text}`, source?: MessageSource): HumanMessage {
  return new HumanMessage({
    content: text,
    id,
    ...(source !== undefined && { additional_kwargs: sourceKwargs(source) }),
  });
}

async function run(
  listener: PreStepListener,
  visible: readonly BaseMessage[],
  signal?: AbortSignal,
): Promise<readonly PreStepInjection[] | undefined> {
  return listener(visible, { configurable: {}, ...(signal !== undefined && { signal }) });
}

const namesOf = (injections: readonly PreStepInjection[] | undefined) =>
  injections?.map((injection) => injection.source?.['name']);

describe('listener：注入什麼', () => {
  it('人話裡的 /deploy：一則 <skill_content>，來源是 skill-invocation，記號指回那句人話', async () => {
    const ws = workspace(STANDARD);
    const injections = await run(listenerOn(backendOf(ws)), [human('請 /deploy 一下', 'h1')]);
    expect(injections).toHaveLength(1);
    const [injection] = injections!;
    expect(injection!.content).toBe(
      [
        '<skill_content name="deploy">',
        '<skill_resources>',
        'Base directory for this skill: /skills/deploy',
        'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
        '</skill_resources>',
        '',
        '<skill_instructions>',
        '部署的步驟。',
        '</skill_instructions>',
        '</skill_content>',
      ].join('\n'),
    );
    expect(injection!.source).toEqual({
      kind: 'skill-invocation',
      name: 'deploy',
      form: 'instructions',
    });
    expect(injection!.additionalKwargs).toEqual({
      [SKILL_INVOCATION_MARKER]: { name: 'deploy', forMessageId: 'h1' },
    });
  });

  it('只給人叫的技能叫得出來；多個名字依第一次出現的順序、重複的只算一次', async () => {
    const ws = workspace(STANDARD);
    const injections = await run(listenerOn(backendOf(ws)), [
      human('/release-notes 然後 /deploy', 'h1'),
      human('再一次 /release-notes', 'h2'),
    ]);
    expect(namesOf(injections)).toEqual(['release-notes', 'deploy']);
  });
});

describe('驗收 5：不是手勢、叫不出來的，當一般文字', () => {
  it.each([['/usr/bin/env 是什麼'], ['5/8 開會'], ['看 /deploy/x'], ['沒有手勢']])(
    '%s：不掃、不注入',
    async (text) => {
      const ws = workspace(STANDARD);
      const backend = backendOf(ws);
      const ls = vi.spyOn(backend, 'ls');
      expect(await run(listenerOn(backend), [human(text)])).toBeUndefined();
      expect(ls).not.toHaveBeenCalled();
    },
  );

  it('/nope（找不到）與 /model-only（user-invocable: false）：不注入、不報錯；同一句裡叫得出的照常', async () => {
    const ws = workspace(STANDARD);
    expect(await run(listenerOn(backendOf(ws)), [human('/nope /model-only')])).toEqual([]);
    expect(namesOf(await run(listenerOn(backendOf(ws)), [human('/nope /deploy')]))).toEqual([
      'deploy',
    ]);
  });
});

describe('驗收 6：只認 root 的人話', () => {
  it('子代理（task 的描述是父模型寫的）：不注入', async () => {
    const ws = workspace(STANDARD);
    const listener = listenerOn(backendOf(ws), {
      address: { kind: 'subagent', runId: 'tools:w-1' },
    });
    expect(await run(listener, [human('/release-notes')])).toBeUndefined();
  });

  it.each<[string, MessageSource]>([
    ['goal 的續行輪', { kind: 'goal', goalId: 'g', revision: 1, round: 2 } as MessageSource],
    ['引用別的會話的快照', { kind: 'session-reference' } as MessageSource],
    ['背景子代理的回報', { kind: 'subagent-settled', senderSessionId: 's' } as MessageSource],
    ['外掛注入', { kind: 'plugin', plugin: 'Other' }],
  ])('%s 裡的 /deploy：不注入', async (_label, source) => {
    const ws = workspace(STANDARD);
    expect(await run(listenerOn(backendOf(ws)), [human('/deploy', 'x', source)])).toBeUndefined();
  });

  it('來源是 user 的人話（插話記的那一種）照認', async () => {
    const ws = workspace(STANDARD);
    const injections = await run(listenerOn(backendOf(ws)), [
      human('/deploy', 'x', { kind: 'user' } as MessageSource),
    ]);
    expect(namesOf(injections)).toEqual(['deploy']);
  });
});

describe('驗收 7：不重複', () => {
  it('最後一則模型回覆之前的人話不看', async () => {
    const ws = workspace(STANDARD);
    expect(
      await run(listenerOn(backendOf(ws)), [
        human('/deploy', 'h1'),
        new AIMessage('好。'),
        human('再來', 'h2'),
      ]),
    ).toBeUndefined();
  });

  it('中途停掉（沒有模型回覆）：那句人話已有同名注入就不再注入；別的名字照注入', async () => {
    const ws = workspace(STANDARD);
    const listener = listenerOn(backendOf(ws));
    const first = await run(listener, [human('/deploy /release-notes', 'h1')]);
    const injected = first!.map(
      (injection) =>
        new HumanMessage({
          content: injection.content,
          additional_kwargs: injection.additionalKwargs ?? {},
        }),
    );
    // 只留下 deploy 那一則（release-notes 那則當作沒進到 state）。
    const again = await run(listener, [human('/deploy /release-notes', 'h1'), injected[0]!]);
    expect(namesOf(again)).toEqual(['release-notes']);
    // 同一個名字、另一句人話（另一個 id）：照注入。
    const other = await run(listener, [
      human('/deploy /release-notes', 'h1'),
      ...injected,
      human('/deploy', 'h2'),
    ]);
    expect(namesOf(other)).toEqual(['deploy']);
  });
});

describe('掃描不完整：一份都不注入（照 dsh 的提供者語意，PM 裁決 issuecomment-6358917124 第 1 題）', () => {
  class FlakyBackend extends ContainedFilesystemBackend {
    constructor(
      root: string,
      private readonly deny: string,
    ) {
      super({ rootDir: root, mode: 'workspace-write' });
    }

    override async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
      const responses = await super.downloadFiles(paths);
      return responses.map((response) =>
        response.path === this.deny
          ? { path: response.path, content: null, error: 'permission_denied' }
          : response,
      );
    }
  }

  it('讀不到別的技能（不是被叫的那一份）也不注入，記一行 warn', async () => {
    const ws = workspace(STANDARD);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const listener = createSkillInvocationListener({
      fs: () => ({
        kind: 'ok',
        fs: { backend: () => new FlakyBackend(ws, '/skills/model-only/SKILL.md') } as never,
        address: { kind: 'root' },
      }),
      sources: () => ['/skills/'],
    });
    expect(await run(listener, [human('/deploy')])).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('技能叫用這一次不注入：掃描不完整（/deploy）');
    // 對照：同一份工作區、掃描完整就注入。
    expect(namesOf(await run(listenerOn(backendOf(ws)), [human('/deploy')]))).toEqual(['deploy']);
  });
});

describe('其他守衛', () => {
  it('沒有 backend、fs 沒接上：不注入', async () => {
    expect(await run(listenerOn(undefined), [human('/deploy')])).toBeUndefined();
    const notAttached = createSkillInvocationListener({
      fs: () => ({ kind: 'not-attached' }),
      sources: () => ['/skills/'],
    });
    expect(await run(notAttached, [human('/deploy')])).toBeUndefined();
  });

  it('這一輪已經停下：拋中止，不讀檔', async () => {
    const ws = workspace(STANDARD);
    const backend = backendOf(ws);
    const ls = vi.spyOn(backend, 'ls');
    const controller = new AbortController();
    controller.abort(new Error('停'));
    await expect(run(listenerOn(backend), [human('/deploy')], controller.signal)).rejects.toThrow(
      '停',
    );
    expect(ls).not.toHaveBeenCalled();
  });

  it('來源在呼叫當下讀（登記處是活的）', async () => {
    const ws = workspace({ a: { deploy: { body: 'A 版。' } }, b: { deploy: { body: 'B 版。' } } });
    let sources = ['/a/'];
    const listener = createSkillInvocationListener({
      fs: lookupOf(backendOf(ws)),
      sources: () => sources,
    });
    expect((await run(listener, [human('/deploy')]))![0]!.content).toContain('A 版。');
    sources = ['/a/', '/b/'];
    expect((await run(listener, [human('/deploy')]))![0]!.content).toContain('B 版。');
  });
});

// ---------------------------------------------------------------------------------------------
// 樹上
// ---------------------------------------------------------------------------------------------

function home(patch?: string): NodeJS.ProcessEnv {
  const dir = scratch();
  if (patch !== undefined) writeFileSync(join(dir, 'cordis.patch.yml'), patch, { mode: 0o600 });
  return { [HARNESS_HOME_ENV]: dir };
}

interface Booted {
  readonly root: CordisRoot;
  readonly loaded: LoadedPluginConfig;
  readonly assembly: NexusAssembly;
}

async function boot(env: NodeJS.ProcessEnv): Promise<Booted> {
  const root = createCordisRoot({ channel: entryApprovalChannel(undefined), contained: true });
  roots.push(root);
  const loaded = await loadDefaultPlugins({ env, warn: () => {} }, { tree: root.tree });
  const assembly = await root.boot('serve', { plugins: loaded.plugins });
  return { root, loaded, assembly };
}

async function openThread(
  booted: Booted,
  threadId: string,
  turns: readonly ScriptedTurn[],
  ws: string,
  extra: readonly PluginEntry[] = [],
) {
  const plugins = withScriptedModel([...booted.loaded.plugins, ...extra], turns);
  const built = await booted.assembly.create(
    { live: false, workspace: ws, sandbox: 'workspace-write' as const },
    { plugins },
  );
  const sessions = new SessionRegistry(threadId);
  const attachment = built.attachSessions(sessions);
  const model = built.model as ScriptedChatModel;
  const rootLog = () => {
    const entry = sessions.list().find((item) => item.address.kind === 'root');
    if (entry === undefined) throw new Error('沒有 root 日誌');
    return entry.log;
  };
  return {
    built,
    sessions,
    model,
    rootLog,
    /** 照入口的樣子說一句話（`turn/start`、invoke、`turn/end`）。 */
    async say(text: string): Promise<void> {
      rootLog().append('turn/start', { kind: 'message', text });
      await built.agent.invoke(toAgentInvocation(text), { configurable: { thread_id: threadId } });
      rootLog().append('turn/end', {});
    },
    async close(): Promise<void> {
      await attachment.detach();
      await built.dispose();
    },
  };
}

const isSkillContent = (message: BaseMessage) =>
  SKILL_INVOCATION_MARKER in message.additional_kwargs;

function invocationEvents(events: readonly { type: string; data: unknown }[]) {
  return events.filter(
    (event) =>
      event.type === 'user/message' &&
      (event.data as { source: { kind: string } }).source.kind === 'skill-invocation',
  );
}

describe('驗收 4、8：樹上叫得出來，落點在基線之後、讀數之前，日誌記 skill-invocation', () => {
  it('serve 的樹：四則依序是人話、AGENTS.md 基線、技能正文、時間讀數', async () => {
    const booted = await boot(home());
    const thread = await openThread(booted, 't-order', [{ content: '好。' }], workspace(STANDARD));
    await thread.say('請 /release-notes');

    const humans = (thread.model.prompts[0] ?? []).filter((m) => m.getType() === 'human');
    expect(humans).toHaveLength(4);
    expect(humans[0]?.text).toBe('請 /release-notes');
    expect(isAgentInstructionsMessage(humans[1] as BaseMessage)).toBe(true);
    expect(humans[2]?.text).toContain('<skill_content name="release-notes">');
    expect(humans[2]?.text).toContain('寫發版說明。');
    expect(TIME_CONTEXT_MARKER in (humans[3]?.additional_kwargs ?? {})).toBe(true);

    const events = thread.rootLog().events;
    const logged = invocationEvents(events);
    expect(logged).toHaveLength(1);
    expect((logged[0]!.data as { source: unknown }).source).toEqual({
      kind: 'skill-invocation',
      name: 'release-notes',
      form: 'instructions',
    });
    // 記號指回那句人話：人話在 state 裡有 id（基座的 reducer 補的）。
    expect(humans[0]?.id).toEqual(expect.any(String));
    expect(humans[2]?.additional_kwargs[SKILL_INVOCATION_MARKER]).toEqual({
      name: 'release-notes',
      forMessageId: humans[0]?.id,
    });

    // 歷史畫面不把它畫成人話；重放（續接）時回到模型手上、來源照舊。
    expect(JSON.stringify(historyFrames(events, DEFAULT_TOOL_TEXT_MAX_BYTES))).not.toContain(
      'skill_content',
    );
    const replay = replayConversation(events);
    expect(replay.kind).toBe('replayed');
    const replayed = replay.kind === 'replayed' ? replay.messages.filter(isSkillContent) : [];
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.additional_kwargs[MESSAGE_SOURCE_KWARG]).toEqual({
      kind: 'skill-invocation',
      name: 'release-notes',
      form: 'instructions',
    });

    // 落盤再讀回（同版登記的實讀證據）：這份事件原樣寫成 JSONL，讀盤驗證（#1549）不擋這個來源，唯讀打開與續接都照常，
    // 讀回的那一則與記下的相同。
    const directory = scratch('nexus-skill-invocation-store-');
    const paths = sessionPathsIn(directory, 'a');
    await writeFile(
      paths.header,
      JSON.stringify({ version: SESSION_LOG_FORMAT_VERSION, id: 'a', createdAt: 1 }),
    );
    await writeFile(paths.log, events.map((event) => `${JSON.stringify(event)}\n`).join(''));
    const store = openJsonlSessionStore({ directory });
    const read = await (await store.open('a', 'read')).read();
    expect(invocationEvents(read)).toEqual(logged);
    const resumed = await store.resume('a');
    await resumed.stored.close();
    await thread.close();
  }, 60000);

  it('拿掉 skill-invocation 那一列：同一句話不注入（模型清單上也沒有只給人叫的那份）', async () => {
    const booted = await boot(home('- id: skill-invocation\n  disabled: true\n'));
    const thread = await openThread(booted, 't-off', [{ content: '好。' }], workspace(STANDARD));
    await thread.say('請 /release-notes');
    expect((thread.model.prompts[0] ?? []).filter(isSkillContent)).toEqual([]);
    expect(invocationEvents(thread.rootLog().events)).toEqual([]);
    await thread.close();
  }, 60000);
});

describe('驗收 7（樹上）：第二輪不重複', () => {
  it('第一輪叫了 /deploy，第二輪沒有手勢：第二輪的請求裡仍只有一份（第一輪落在 state 的那一則），記號的 id 沒變', async () => {
    const booted = await boot(home());
    const thread = await openThread(
      booted,
      't-twice',
      [{ content: '一。' }, { content: '二。' }],
      workspace(STANDARD),
    );
    await thread.say('/deploy');
    await thread.say('再來');
    const first = (thread.model.prompts[0] ?? []).filter(isSkillContent);
    const second = (thread.model.prompts[1] ?? []).filter(isSkillContent);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]?.additional_kwargs[SKILL_INVOCATION_MARKER]).toEqual(
      first[0]?.additional_kwargs[SKILL_INVOCATION_MARKER],
    );
    expect(invocationEvents(thread.rootLog().events)).toHaveLength(1);
    await thread.close();
  }, 60000);
});

describe('驗收 6（樹上）：task 子代理的描述裡寫 /release-notes 叫不出來', () => {
  it('general-purpose 子代理那幾輪沒有技能正文，子代理的日誌也沒有', async () => {
    const booted = await boot(home());
    const thread = await openThread(
      booted,
      't-task',
      [
        {
          content: '委派。',
          toolCalls: [
            {
              name: 'task',
              args: { description: '/release-notes', subagent_type: 'general-purpose' },
            },
          ],
        },
        { content: '子代理收工。' },
        { content: '根收工。' },
      ],
      workspace(STANDARD),
    );
    await thread.say('幫我委派');
    const subagentPrompts = thread.model.prompts.filter((prompt) =>
      prompt.some((message) => message.getType() === 'human' && message.text === '/release-notes'),
    );
    expect(subagentPrompts.length).toBeGreaterThan(0);
    for (const prompt of subagentPrompts) expect(prompt.filter(isSkillContent)).toEqual([]);
    for (const entry of thread.sessions.list())
      expect(invocationEvents(entry.log.events)).toEqual([]);
    await thread.close();
  }, 60000);
});

describe('兩列 skills 有同名技能：清單上靠後的那一列贏（比照 skills-on-tree 的 G）', () => {
  const twin =
    `- insert:\n    - id: late-skills\n      name: '@nexus/plugin-skills'\n` +
    `      config:\n        sources:\n          - '/late/'\n`;
  const layout = {
    skills: { deploy: { body: '前面那一列。' } },
    late: { deploy: { body: '後面那一列。' } },
  };

  it('兩列都在：注入的是後面那一列的；停掉後面那一列，換回前面的', async () => {
    const both = await boot(home(twin));
    expect(both.loaded.dropped).toEqual([]);
    const thread = await openThread(both, 't-both', [{ content: '好。' }], workspace(layout));
    await thread.say('/deploy');
    const [injected] = (thread.model.prompts[0] ?? []).filter(isSkillContent);
    expect(injected?.text).toContain('後面那一列。');
    expect(injected?.text).not.toContain('前面那一列。');
    await thread.close();

    const off = await boot(home(`${twin}- id: late-skills\n  disabled: true\n`));
    const second = await openThread(off, 't-off', [{ content: '好。' }], workspace(layout));
    await second.say('/deploy');
    const [fallback] = (second.model.prompts[0] ?? []).filter(isSkillContent);
    expect(fallback?.text).toContain('前面那一列。');
    await second.close();
  }, 90000);
});
