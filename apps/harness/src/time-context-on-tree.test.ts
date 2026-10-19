/**
 * time-context 在產品路徑上（[#1625](https://github.com/DemianLi/nexus-agent/issues/1625)）：驗收 A–J。
 * 量的是真的 `createCordisRoot`、真的 `loadDefaultPlugins`（帶樹）、真的相容層 `assembly.create`（serve 每條 thread 一次）、
 * 真的 `attachSessions`，以及 `runServe --live` 對著假端點、`runCli --resume`；不手搭 `ctx.plugin`。
 *
 * 文字格式、日誌折疊、節流的細節在 `packages/nexus-plugin-time-context/src/index.test.ts`（用固定時鐘、不進組裝）；
 * 套件的一致性與兩條 thread 在 `src/tree.test.ts`。這一檔問的是：**出貨清單上這一列掛上之後，模型真的讀到什麼、日誌記了什麼、
 * 拿掉那一列會不會紅。**
 *
 * 時間固定：`vi.useFakeTimers({ toFake: ['Date'] })`（只換 `Date`，計時器照走），行程時區設成 `Asia/Taipei`
 * （格式器在 `apply` 當下取行程時區，所以要在 `boot` 之前設）。需要真時間的格子（F 的假端點、E 的 CLI）不固定。
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { SessionRegistry, toLoggedMessage } from '@nexus/core';
import type { PluginEntry, SessionLookup } from '@nexus/core';
import { uniformDecisions } from '@nexus/wire';
import { isAgentInstructionsMessage } from '@nexus/plugin-agent-instructions';
import { TIME_CONTEXT_MARKER, TIME_CONTEXT_MIDDLEWARE_NAME } from '@nexus/plugin-time-context';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createNexusAgent, HEADLESS_APPROVALS } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { runCli } from './cli.js';
import { seenRequests } from './conversation-restore.fixture.js';
import { createCordisRoot, entryApprovalChannel } from './cordis-root.js';
import type { CordisRoot, NexusAssembly } from './cordis-root.js';
import { approvalAt, shippedPlugins, withScriptedModel, withoutTimeContext } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { LoopingChatModel } from './looping-model.js';
import {
  aiDone,
  mainOnly,
  rootLogOf,
  runServeDriver,
  runServePhases,
} from './log-derived-history.fixture.js';
import { toAgentInvocation } from './messages.js';
import { loadDefaultPlugins } from './plugin-config.js';
import type { LoadedPluginConfig } from './plugin-config.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';

const T0 = Date.parse('2026-10-18T01:00:00Z');
const MIN = 60_000;

const temporary: string[] = [];
const roots: CordisRoot[] = [];
const originalTz = process.env['TZ'];

beforeEach(() => {
  process.env['TZ'] = 'Asia/Taipei';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (originalTz === undefined) delete process.env['TZ'];
  else process.env['TZ'] = originalTz;
  for (const root of roots.splice(0)) await root.dispose().catch(() => {});
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix = 'nexus-time-context-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return dir;
}

function workspaceWith(agentsMd: string | undefined): string {
  const dir = scratch('nexus-time-context-ws-');
  if (agentsMd !== undefined) writeFileSync(join(dir, 'AGENTS.md'), agentsMd, 'utf8');
  return dir;
}

/** 一個 home；`patch` 有給就寫成 home 裡的 `cordis.patch.yml`（使用者的 patch 檔；`plugin disable` 這類指令寫的是變更紀錄，不是這個檔）。 */
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

/** 入口的順序：讀清單（帶樹）→ 建根、掛相容層與入口那一列。 */
async function boot(env: NodeJS.ProcessEnv, entry: 'serve' | 'cli' = 'serve'): Promise<Booted> {
  const root = createCordisRoot({
    channel: entryApprovalChannel(entry === 'serve' ? undefined : HEADLESS_APPROVALS),
  });
  roots.push(root);
  const loaded = await loadDefaultPlugins({ env, warn: () => {} }, { tree: root.tree });
  const assembly = await root.boot(entry, { plugins: loaded.plugins });
  return { root, loaded, assembly };
}

interface OpenThread {
  readonly built: Awaited<ReturnType<NexusAssembly['create']>>;
  readonly sessions: SessionRegistry;
  readonly attachment: ReturnType<Awaited<ReturnType<NexusAssembly['create']>>['attachSessions']>;
  readonly threadId: string;
  readonly model: ScriptedChatModel;
}

async function openThread(
  booted: Booted,
  threadId: string,
  turns: readonly ScriptedTurn[],
  options: {
    readonly workspace?: string | undefined;
    readonly extra?: readonly PluginEntry[];
    readonly invocation?: Partial<Parameters<NexusAssembly['create']>[0]>;
  } = {},
): Promise<OpenThread> {
  const workspace = 'workspace' in options ? options.workspace : workspaceWith('規矩。');
  const plugins = withScriptedModel([...booted.loaded.plugins, ...(options.extra ?? [])], turns);
  const built = await booted.assembly.create(
    {
      live: false,
      ...(workspace !== undefined && { workspace, sandbox: 'workspace-write' as const }),
      ...options.invocation,
    },
    { plugins },
  );
  const sessions = new SessionRegistry(threadId);
  const attachment = built.attachSessions(sessions);
  return { built, sessions, attachment, threadId, model: built.model as never };
}

/**
 * 說一句話。**照入口（runner）的樣子**先記 `turn/start`、收尾記 `turn/end`：直接 `agent.invoke` 不經 runner，日誌上不會有這兩顆，
 * 而讀數的輪數與基線都是從它們算的（沒有 `turn/start` 的日誌就是同步子代理那一種，第三行會是 unavailable）。
 */
async function runOn(thread: OpenThread, text = '開工', clientTimeZone?: string): Promise<void> {
  const log = rootLog(thread);
  log.append('turn/start', {
    kind: 'message',
    text,
    ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
  });
  await thread.built.agent.invoke(toAgentInvocation(text), {
    configurable: { thread_id: thread.threadId },
  });
  log.append('turn/end', {});
}

async function closeThread(thread: OpenThread): Promise<void> {
  await thread.attachment.detach();
  await thread.built.dispose();
}

async function until(predicate: () => boolean, ms = 8000): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 一份 prompt 裡的時間讀數（看記號，不看文字）。 */
function readingsOf(prompt: readonly BaseMessage[]): string[] {
  return prompt
    .filter((message) => TIME_CONTEXT_MARKER in message.additional_kwargs)
    .map((message) => message.text);
}

/** 一份日誌裡由這顆 plugin 注入的那幾則。 */
function injectedReadings(events: readonly { type: string; data: unknown }[]) {
  return events.filter(
    (event) =>
      event.type === 'user/message' &&
      (event.data as { source?: { plugin?: string } }).source?.plugin ===
        TIME_CONTEXT_MIDDLEWARE_NAME,
  );
}

function rootLog(thread: OpenThread) {
  const entry = thread.sessions.list().find((item) => item.address.kind === 'root');
  if (entry === undefined) throw new Error('沒有 root 日誌');
  return entry.log;
}

const UNAVAILABLE_ZONE =
  'Browser time zone for this request: unavailable. Ask the user to clarify otherwise-unqualified dates and times.';

describe('A：模型第一次請求裡有一則讀數，文字逐字', () => {
  it('Date 固定在 2026-10-18T01:00:00Z、行程時區 Asia/Taipei：三行都是預期的字', async () => {
    const booted = await boot(home());
    const thread = await openThread(booted, 'a', [{ content: '好。' }]);
    await runOn(thread, '嗨');

    expect(readingsOf(thread.model.prompts[0] ?? [])).toEqual([
      [
        'Time sampled while preparing turn 1, step 1: 2026-10-18T09:00:00+08:00[Asia/Taipei]',
        UNAVAILABLE_ZONE,
        'Elapsed since the preceding model-visible message: unavailable.',
      ].join('\n'),
    ]);
    // 不進系統提示詞：system 那一段沒有任何時間字樣。
    const system = (thread.model.prompts[0] ?? []).filter((m) => m.getType() === 'system');
    expect(system.map((m) => m.text).join('\n')).not.toContain('Time sampled');
    await closeThread(thread);
  }, 60000);

  it('日誌記成 user/message，來源指名這顆 plugin；一次 invoke 只一則', async () => {
    const booted = await boot(home());
    const thread = await openThread(booted, 'a-log', [{ content: '好。' }]);
    await runOn(thread, '嗨');
    expect(injectedReadings(rootLog(thread).events)).toHaveLength(1);
    await closeThread(thread);
  }, 60000);
});

describe('B：順序是 [人話, AGENTS.md 基線, 讀數]；第二輪的第三行是上一則訊息到現在的時長', () => {
  it('有工作區也有 AGENTS.md：三則依序；第一輪 elapsed 是 unavailable', async () => {
    const booted = await boot(home());
    const thread = await openThread(booted, 'b', [{ content: '好。' }], {
      workspace: workspaceWith('規矩。'),
    });
    await runOn(thread, '嗨');
    const humans = (thread.model.prompts[0] ?? []).filter((m) => m.getType() === 'human');
    expect(humans).toHaveLength(3);
    expect(humans[0]?.text).toBe('嗨');
    expect(isAgentInstructionsMessage(humans[1] as BaseMessage)).toBe(true);
    expect(TIME_CONTEXT_MARKER in (humans[2]?.additional_kwargs ?? {})).toBe(true);
    expect(humans[2]?.text).toContain(
      'Elapsed since the preceding model-visible message: unavailable.',
    );
    await closeThread(thread);
  }, 60000);

  it('隔 15 分鐘再說一句：新讀數的第三行是 15m 0s；舊讀數的位元組不變', async () => {
    const booted = await boot(home());
    const thread = await openThread(booted, 'b2', [{ content: '一。' }, { content: '二。' }]);
    await runOn(thread, '嗨');
    const [first] = readingsOf(thread.model.prompts[0] ?? []);
    at(15 * MIN);
    await runOn(thread, '再問');

    const readings = readingsOf(thread.model.prompts[1] ?? []);
    expect(readings).toHaveLength(2);
    expect(readings[0]).toBe(first);
    expect(readings[1]).toBe(
      [
        'Time sampled while preparing turn 2, step 1: 2026-10-18T09:15:00+08:00[Asia/Taipei]',
        UNAVAILABLE_ZONE,
        'Elapsed since the preceding model-visible message: 15m 0s.',
      ].join('\n'),
    );
    await closeThread(thread);
  }, 60000);
});

/** 把假時鐘推到 `T0 + offset`。 */
function at(offsetMs: number): void {
  vi.setSystemTime(T0 + offsetMs);
}

describe('C：節流——同一條 thread 10 分鐘內不重複，兩條 thread 各算各的', () => {
  it('第二輪差 1 毫秒不到 10 分鐘：沒有新讀數；剛好 10 分鐘：有', async () => {
    const booted = await boot(home());
    const thread = await openThread(booted, 'c', [
      { content: '一。' },
      { content: '二。' },
      { content: '三。' },
    ]);
    await runOn(thread, '一');
    at(10 * MIN - 1);
    await runOn(thread, '二');
    expect(readingsOf(thread.model.prompts[1] ?? [])).toHaveLength(1);
    at(10 * MIN);
    await runOn(thread, '三');
    expect(readingsOf(thread.model.prompts[2] ?? [])).toHaveLength(2);
    expect(injectedReadings(rootLog(thread).events)).toHaveLength(2);
    await closeThread(thread);
  }, 60000);

  it('兩條 thread：a 先說，5 分鐘後 b 第一次說——b 照樣有自己的讀數；之後各自按自己的 10 分鐘', async () => {
    const booted = await boot(home());
    const a = await openThread(booted, 'c-a', [{ content: '甲一。' }, { content: '甲二。' }]);
    const b = await openThread(booted, 'c-b', [{ content: '乙一。' }, { content: '乙二。' }]);
    await runOn(a);
    at(5 * MIN);
    await runOn(b);
    expect(readingsOf(b.model.prompts[0] ?? [])).toHaveLength(1);
    // a 距離上次 11 分鐘、b 才 6 分鐘：a 有新的、b 沒有。
    at(11 * MIN);
    await runOn(a, '再來');
    await runOn(b, '再來');
    expect(readingsOf(a.model.prompts[1] ?? [])).toHaveLength(2);
    expect(readingsOf(b.model.prompts[1] ?? [])).toHaveLength(1);
    await closeThread(a);
    await closeThread(b);
  }, 60000);
});

/**
 * 把樹上 `sessionLookup` 服務的每一次回答錄下來（#1625 審查要求）：子代理那幾格光看「第三行是 unavailable」分不出
 * 「查到了子代理自己那份日誌、只是沒有基線」與「查找掉到 not-attached 的退路」——兩條路輸出同一行字。
 */
async function recordLookups(booted: Booted): Promise<SessionLookup[]> {
  const service = (await booted.root.tree.context()).get('sessionLookup') as
    { forCall(config: unknown): SessionLookup } | undefined;
  if (service === undefined) throw new Error('樹上沒有 sessionLookup 服務');
  const seen: SessionLookup[] = [];
  const original = service.forCall.bind(service);
  vi.spyOn(service, 'forCall').mockImplementation((config) => {
    const answer = original(config);
    seen.push(answer);
    return answer;
  });
  return seen;
}

describe('G：子代理各有一則讀數，查找都找得到自己那份日誌', () => {
  function workerSource(model?: ScriptedChatModel): PluginEntry {
    return {
      plugin: {
        name: 'worker-source',
        apply(registry) {
          registry.subagents.register({
            name: 'worker',
            description: '幹活的。',
            systemPrompt: '你是 worker。',
            ...(model === undefined ? {} : { model: model as never }),
          });
        },
      },
    };
  }

  it('同步子代理：它那幾輪的 prompt 有一則讀數，日誌記在子代理自己那份；root 那份仍只有一則', async () => {
    const booted = await boot(home());
    const lookups = await recordLookups(booted);
    const thread = await openThread(
      booted,
      'g-sync',
      [
        {
          content: '委派。',
          toolCalls: [{ name: 'task', args: { description: '幹活', subagent_type: 'worker' } }],
        },
        { content: '子代理收工。' },
        { content: '根收工。' },
      ],
      { extra: [workerSource()] },
    );
    await runOn(thread);

    const subagentPrompts = thread.model.prompts.filter((prompt) =>
      prompt.some((message) => message.getType() === 'human' && message.text === '幹活'),
    );
    expect(subagentPrompts.length).toBeGreaterThan(0);
    for (const prompt of subagentPrompts) expect(readingsOf(prompt)).toHaveLength(1);
    const subagent = thread.sessions.list().find((entry) => entry.address.kind === 'subagent');
    expect(injectedReadings(subagent?.log.events ?? [])).toHaveLength(1);
    expect(injectedReadings(rootLog(thread).events)).toHaveLength(1);
    // 子代理那則讀數是「查到了它自己那份日誌」得出來的，不是掉到 not-attached 的退路：
    // 查找回過 ok、位址是 subagent、日誌就是會話表上那一份；而且這條 thread 全程沒有一次 not-attached。
    const answers = lookups.filter((answer) => answer.kind === 'ok');
    expect(answers.some((a) => a.address.kind === 'subagent' && a.log === subagent?.log)).toBe(
      true,
    );
    expect(lookups.filter((answer) => answer.kind !== 'ok')).toEqual([]);
    await closeThread(thread);
  }, 60000);

  it('背景子代理：同上，日誌記在背景那一份', async () => {
    const booted = await boot(home());
    const lookups = await recordLookups(booted);
    const worker = new ScriptedChatModel({ turns: [{ content: '背景收工。' }] });
    const thread = await openThread(
      booted,
      'g-bg',
      [
        {
          content: '委派。',
          toolCalls: [
            {
              name: 'subagent',
              id: 'root-call',
              args: { description: '幹活', subagent_type: 'worker', run_in_background: true },
            },
          ],
        },
        { content: '根收尾。' },
      ],
      { extra: [workerSource(worker)], invocation: { backgroundSubagents: { maxActive: 8 } } },
    );
    await runOn(thread);
    await until(() =>
      thread.sessions
        .list()
        .some(
          (entry) =>
            entry.address.kind === 'subagent' &&
            entry.log.events.some((event) => event.type === 'turn/end'),
        ),
    );
    expect(readingsOf(worker.prompts[0] ?? [])).toHaveLength(1);
    const background = thread.sessions.list().find((entry) => entry.address.kind === 'subagent');
    expect(injectedReadings(background?.log.events ?? [])).toHaveLength(1);
    // 同上：背景那份讀數也是查到自己那份日誌得出來的，不是退路。
    expect(
      lookups.some(
        (answer) =>
          answer.kind === 'ok' &&
          answer.address.kind === 'subagent' &&
          answer.log === background?.log,
      ),
    ).toBe(true);
    expect(lookups.filter((answer) => answer.kind !== 'ok')).toEqual([]);
    await closeThread(thread);
  }, 60000);
});

describe('H：設定寫錯，那一列掉下來並在啟動時說得出原因', () => {
  it.each([
    ['時區不是 IANA 名', "timeZone: 'Asia/Taipe'", 'invalid IANA timeZone "Asia/Taipe"'],
    ['間隔是負的', 'refreshIntervalMs: -1', 'must be a non-negative safe integer, got -1'],
    ['間隔不是整數', 'refreshIntervalMs: 1.5', 'must be a non-negative safe integer, got 1.5'],
    ['多一個不認得的欄位', 'refreshInterval: 1000', 'Unrecognized key: "refreshInterval"'],
  ] as const)(
    '%s：這條 thread 沒有讀數',
    async (_label, line, reason) => {
      const booted = await boot(home(`- id: time-context\n  config:\n    ${line}\n`));
      const drop = booted.loaded.dropped.find((candidate) => candidate.id === 'time-context');
      expect(drop?.message, '掉的原因要指名是哪一列').toContain('time-context');
      expect(drop?.message, '而且說得出是哪裡寫錯').toContain(reason);
      const thread = await openThread(booted, 'h', [{ content: '好。' }]);
      await runOn(thread, '嗨');
      expect(readingsOf(thread.model.prompts[0] ?? [])).toEqual([]);
      expect(injectedReadings(rootLog(thread).events)).toEqual([]);
      await closeThread(thread);
    },
    60000,
  );

  it('對照：合法的設定（時區 UTC、間隔 0）掛得上，讀數用那個時區', async () => {
    const booted = await boot(
      home("- id: time-context\n  config:\n    timeZone: 'UTC'\n    refreshIntervalMs: 0\n"),
    );
    const thread = await openThread(booted, 'h-ok', [{ content: '一。' }, { content: '二。' }]);
    await runOn(thread, '一');
    await runOn(thread, '二');
    expect(readingsOf(thread.model.prompts[0] ?? [])[0]).toContain(
      '2026-10-18T01:00:00+00:00[UTC]',
    );
    // 間隔 0：第二輪（同一毫秒）照樣有新讀數。
    expect(readingsOf(thread.model.prompts[1] ?? [])).toHaveLength(2);
    await closeThread(thread);
  }, 60000);
});

describe('I：接線紅燈——patch 掉這一列，A 的斷言就紅（serve 與 CLI 兩條入口都量）', () => {
  it.each(['serve', 'cli'] as const)(
    '%s：有這一列有讀數，關掉就沒有',
    async (entry) => {
      const on = await boot(home(), entry);
      const withRow = await openThread(on, `i-on-${entry}`, [{ content: '好。' }]);
      await runOn(withRow);
      expect(readingsOf(withRow.model.prompts[0] ?? [])).toHaveLength(1);
      await closeThread(withRow);

      const off = await boot(home('- id: time-context\n  disabled: true\n'), entry);
      const withoutRow = await openThread(off, `i-off-${entry}`, [{ content: '好。' }]);
      await runOn(withoutRow);
      expect(readingsOf(withoutRow.model.prompts[0] ?? [])).toEqual([]);
      expect(injectedReadings(rootLog(withoutRow).events)).toEqual([]);
      await closeThread(withoutRow);
    },
    60000,
  );
});

describe('K：瀏覽器時區（#1629）——人話帶的時區到了模型手上', () => {
  it('resolved：第一行時鐘換成使用者的時區，第二行請模型照這個時區解讀；日誌記的就是模型看到的', async () => {
    const booted = await boot(home());
    const thread = await openThread(booted, 'k-resolved', [{ content: '好。' }]);
    await runOn(thread, '嗨', 'America/New_York');
    const [reading] = readingsOf(thread.model.prompts[0] ?? []);
    expect(reading).toBe(
      [
        'Time sampled while preparing turn 1, step 1: 2026-10-17T21:00:00-04:00[America/New_York]',
        'Browser time zone for this request: America/New_York. Interpret otherwise-unqualified dates and times in this zone.',
        'Elapsed since the preceding model-visible message: unavailable.',
      ].join('\n'),
    );
    expect(JSON.stringify(injectedReadings(rootLog(thread).events))).toContain('America/New_York');
    await closeThread(thread);
  }, 60000);

  it('mixed：這一輪有兩種時區的人話，第一行退回行程時區，第二行列出兩個並請模型確認', async () => {
    const booted = await boot(home());
    const thread = await openThread(booted, 'k-mixed', [{ content: '好。' }]);
    const log = rootLog(thread);
    // 一輪開頭那句在 turn/start；輪中插話在 user/message 的 source（領走時記）。這裡手排好，等於插話在第一次叫模型之前就到了。
    log.append('turn/start', { kind: 'message', text: '嗨', clientTimeZone: 'America/New_York' });
    log.append('user/message', {
      message: toLoggedMessage(new HumanMessage({ content: '補一句' })),
      source: { kind: 'user', clientTimeZone: 'Asia/Tokyo' },
    });
    await thread.built.agent.invoke(toAgentInvocation('嗨'), {
      configurable: { thread_id: thread.threadId },
    });
    const [reading] = readingsOf(thread.model.prompts[0] ?? []);
    expect(reading?.split('\n').slice(0, 2)).toEqual([
      'Time sampled while preparing turn 1, step 1: 2026-10-18T09:00:00+08:00[Asia/Taipei]',
      'Browser time zone for this request: mixed ["America/New_York","Asia/Tokyo"]. Ask the user to clarify otherwise-unqualified dates and times.',
    ]);
    await closeThread(thread);
  }, 60000);

  it('missing：沒帶時區（舊客戶端、CLI）——和 #1625 的讀數逐字相同', async () => {
    const booted = await boot(home());
    const thread = await openThread(booted, 'k-missing', [{ content: '好。' }]);
    await runOn(thread, '嗨');
    expect(readingsOf(thread.model.prompts[0] ?? [])[0]?.split('\n')[1]).toBe(UNAVAILABLE_ZONE);
    await closeThread(thread);
  }, 60000);

  it('下一輪不帶時區就回到 missing：上一輪的時區不外溢（讀數只看這一輪）', async () => {
    const booted = await boot(home());
    const thread = await openThread(booted, 'k-next', [{ content: '一。' }, { content: '二。' }]);
    await runOn(thread, '嗨', 'America/New_York');
    at(15 * MIN);
    await runOn(thread, '再問');
    const readings = readingsOf(thread.model.prompts[1] ?? []);
    expect(readings).toHaveLength(2);
    expect(readings[0]).toContain('Browser time zone for this request: America/New_York.');
    expect(readings[1]?.split('\n')[1]).toBe(UNAVAILABLE_ZONE);
    await closeThread(thread);
  }, 60000);
});

describe('J：代價——有沒有這一列，預設上限 100 下的輪數', () => {
  async function rounds(plugins: readonly PluginEntry[], recursionLimit?: number): Promise<number> {
    const model = new LoopingChatModel();
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins,
      summarization: false,
      backend: new ContainedFilesystemBackend({
        rootDir: workspaceWith('規矩。'),
        mode: 'workspace-write',
      }),
    });
    try {
      await expect(
        agent.invoke(
          toAgentInvocation('一直跑'),
          recursionLimit === undefined ? undefined : { recursionLimit },
        ),
      ).rejects.toThrow(/Recursion limit/);
    } finally {
      await dispose();
    }
    return model.calls;
  }

  it('出貨清單 32 輪；拿掉 time-context 還是 32；兩顆 pre-step 消費者都拿掉也是 32（floor 吃掉）', async () => {
    const shipped = await shippedPlugins();
    expect(await rounds(shipped)).toBe(32);
    expect(await rounds(withoutTimeContext(shipped))).toBe(32);
    // 對照：連 agent-instructions 也拿掉（清單上沒有任何 pre-step 消費者）還是 32——`beforeAgent` 的那一格在這個上限下被 floor 吃掉，
    // 不是這一列「免費」：節點確實多了一個（`TimeContextMiddleware.before_agent`，見 `agent-instructions-on-tree.test.ts` 的 D 組鏈）。
    expect(
      await rounds(
        withoutTimeContext(shipped).filter((entry) => entry.id !== 'agent-instructions'),
      ),
    ).toBe(32);
  }, 120000);

  it('正好站在邊界上：上限 99 時這一列多吃一輪（32→31），上限 100、101 不影響，102 又吃一輪（33→32）', async () => {
    // 預設上限 100 剛好落在 floor 的臺階上（4 + 96 = 100），所以上面三個 32 看不出這一列的成本；
    // 上限往下 1 或往上 2，臺階就不在了：每多一顆 `beforeAgent` 節點，就少一輪。
    // 上限壓得很低的部署（或將來有人調預設）會直接看到這一格——這就是 PR 內文要寫的「代價」。
    const shipped = await shippedPlugins();
    const without = withoutTimeContext(shipped);
    expect(await rounds(shipped, 99)).toBe(31);
    expect(await rounds(without, 99)).toBe(32);
    expect(await rounds(shipped, 100)).toBe(32);
    expect(await rounds(without, 100)).toBe(32);
    expect(await rounds(shipped, 102)).toBe(32);
    expect(await rounds(without, 102)).toBe(33);
  }, 240000);
});

describe('F：前綴快取——第二輪請求的前面逐位元組等於第一輪', () => {
  it('serve --live 對著假端點說兩句：第二個 body 的 system 與前面的訊息和第一個一模一樣，只在尾端多東西', async () => {
    vi.useRealTimers();
    // `--live` 要有金鑰才肯組模型；端點是本機假的，這顆不會送到任何地方。
    vi.stubEnv('NVIDIA_API_KEY', 'nvapi-fake-for-time-context');
    const run = await runServePhases(
      [['第一句', '第二句']],
      mainOnly(() => ({})),
      '',
      { timeContext: true },
    );
    const [first, second] = run.mainBodies;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const firstSystem = first!.messages.filter((m) => m.role === 'system');
    const secondSystem = second!.messages.filter((m) => m.role === 'system');
    expect(JSON.stringify(secondSystem)).toBe(JSON.stringify(firstSystem));
    expect(JSON.stringify(firstSystem)).not.toContain('Time sampled');
    // 第一個 body 裡有一則讀數，第二個 body 的前綴就是第一個 body 的全部（讀數的位元組沒變）。
    const firstRest = first!.messages.filter((m) => m.role !== 'system');
    const secondRest = second!.messages.filter((m) => m.role !== 'system');
    expect(JSON.stringify(firstRest)).toContain('Time sampled');
    expect(JSON.stringify(secondRest.slice(0, firstRest.length))).toBe(JSON.stringify(firstRest));
    // 10 分鐘內，第二輪沒有第二則讀數。
    expect(JSON.stringify(secondRest).match(/Time sampled/gu)).toHaveLength(1);
  }, 90_000);

  it('serve 重啟後接著說（真的 runServe 兩台、同一個日誌目錄）：舊讀數位元組不變；隔 11 分鐘的新讀數第三行是 11m 0s，不是 0s', async () => {
    // 這一格固定的是 `Date`（只換 Date，計時器與 HTTP 照走）：要在兩台 serve 之間「推 11 分鐘」，沒固定就沒辦法推。
    // 上一格 F 用真時鐘，因為它量的是真 HTTP body 的位元組，只要兩句話沒跨 10 分鐘就成立；固定時鐘在那一格反而讓
    // 「10 分鐘內不重複」的斷言變成空話（時鐘根本不動）。這一格的重點正相反：時鐘一定要動，而且動過頭。
    vi.stubEnv('NVIDIA_API_KEY', 'nvapi-fake-for-time-context');
    const run = await runServePhases(
      [['第一句'], ['第二句']],
      mainOnly(() => ({})),
      '',
      { timeContext: true, beforePhase: () => vi.setSystemTime(T0 + 11 * MIN) },
    );
    const readingsIn = (body: { messages: readonly unknown[] }): string[] =>
      body.messages.map((m) => JSON.stringify(m)).filter((m) => m.includes('Time sampled'));
    const [first, second] = run.mainBodies;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const old = readingsIn(first!);
    expect(old).toHaveLength(1);
    const after = readingsIn(second!);
    // 第二台 serve 的第一個請求：舊讀數（第一台寫進日誌、重啟後從日誌讀回）逐位元組相同，後面多一則新的。
    expect(after).toHaveLength(2);
    expect(after[0]).toBe(old[0]);
    expect(after[1]).toContain('turn 2, step 1');
    expect(after[1]).toContain('Elapsed since the preceding model-visible message: 11m 0s.');
    expect(after[1]).not.toContain('message: 0s.');
  }, 90_000);

  it('serve 重啟後 9 分鐘內接著說（兩台 runServe、同一個日誌目錄）：沒有新讀數，只有第一台那一則，位元組相同（#1625 審查要求的常駐格）', async () => {
    // 上一格推 11 分鐘看「超過間隔會補一則」；這一格推 9 分鐘看另一半——**節流狀態從日誌讀回，不在行程記憶體裡**：
    // 如果節流是行程內的 Map，重啟之後它是空的，第二台就會在 9 分鐘內補一則（這一格會紅）。
    vi.stubEnv('NVIDIA_API_KEY', 'nvapi-fake-for-time-context');
    const run = await runServePhases(
      [['第一句'], ['第二句']],
      mainOnly(() => ({})),
      '',
      { timeContext: true, beforePhase: () => vi.setSystemTime(T0 + 9 * MIN) },
    );
    const readingsIn = (body: { messages: readonly unknown[] }): string[] =>
      body.messages.map((m) => JSON.stringify(m)).filter((m) => m.includes('Time sampled'));
    const [first, second] = run.mainBodies;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const old = readingsIn(first!);
    expect(old).toHaveLength(1);
    expect(readingsIn(second!)).toEqual(old);
  }, 90_000);
});

describe('E：續接——舊的讀數原樣回到模型手上，10 分鐘內不補新的', () => {
  const PATCH = fileURLToPath(new URL('./time-context-restore.patch.yml', import.meta.url));

  async function cli(argv: readonly string[], lines: string): Promise<string> {
    const out: string[] = [];
    const input = new PassThrough();
    input.end(lines);
    await runCli({
      argv: [...argv, '--patch', PATCH],
      input,
      output: new PassThrough(),
      printer: { log: (line) => void out.push(line), error: (line) => void out.push(line) },
    });
    return out.join('\n');
  }

  it('CLI --resume：第二個行程第一次請求裡有第一個行程的那則讀數，位元組不變，也沒有新的', async () => {
    vi.useRealTimers();
    seenRequests.length = 0;
    const logs = await mkdtemp(join(tmpdir(), 'nexus-time-context-logs-'));
    temporary.push(logs);

    await cli(['--session-log', logs], '記住暗號是藍鯨\n/exit\n');
    const original = readingsOf(seenRequests[0] ?? []);
    expect(original).toHaveLength(1);
    seenRequests.length = 0;

    const [entry] = await readdir(logs);
    await cli(['--resume', join(logs, entry!)], '暗號是什麼\n/exit\n');
    const resumed = readingsOf(seenRequests[0] ?? []);
    expect(resumed).toEqual(original);
  }, 90_000);
});

describe('核准續接：續接不經過 beforeAgent，不補讀數；後面的一輪照常往上數（serve 真跑一輪核准）', () => {
  const APPROVAL_PATCH = [
    '- insert:',
    '    - id: approval-demo',
    `      name: '${join(process.cwd(), 'src', 'approval.fixture.ts')}'`,
  ].join('\n');
  const EVERY_INVOKE = '\n- id: time-context\n  config:\n    refreshIntervalMs: 0';

  /** 說「叫 echo」→ 停在核准 → 准 → 收尾；`followUp` 有給就再說一句。 */
  async function approveOnce(patchExtra: string, followUp?: string) {
    vi.useRealTimers();
    vi.stubEnv('NVIDIA_API_KEY', 'nvapi-fake-for-time-context');
    return runServeDriver(
      async (ctx) => {
        await ctx.client.runStart('alpha', '叫 echo');
        await ctx.fold((s) => s.pendings.length > 0);
        const pending = approvalAt(ctx.state().pendings, 0);
        await ctx.client.inputRespond('alpha', {
          namespace: [...pending.namespace],
          interrupt_id: pending.interruptId,
          response: uniformDecisions(pending, 'approve'),
        });
        await ctx.fold(aiDone(1));
        if (followUp !== undefined) {
          await ctx.client.runStart('alpha', followUp);
          await ctx.fold(aiDone(2));
        }
      },
      mainOnly((k) =>
        k === 0 ? { tools: [{ id: 'call_e1', name: 'echo', args: { message: '核准我' } }] } : {},
      ),
      patchExtra,
      { timeContext: true },
    );
  }

  const sampledLines = (messages: readonly { content?: unknown }[]): string[] =>
    messages
      .flatMap((m) => String(m.content ?? '').split('\n'))
      .filter((line) => line.startsWith('Time sampled'));

  it('預設間隔：整輪只有一則讀數，續接後的那次請求帶的就是它', async () => {
    const run = await approveOnce(APPROVAL_PATCH);
    const root = rootLogOf(run).events;
    expect(
      root.filter((e) => e.type === 'turn/start').map((e) => (e.data as { kind: string }).kind),
    ).toEqual(['message', 'resume']);
    expect(injectedReadings(root)).toHaveLength(1);
    const [before, after] = run.mainBodies.map((b) => sampledLines(b.messages as never));
    expect(before).toHaveLength(1);
    expect(after).toEqual(before);
  }, 90_000);

  it('間隔 0 也一樣：核准續接是接著跑中斷的那張圖，不重進 beforeAgent，所以不補讀數；下一輪才是 turn 2, step 1', async () => {
    // 實跑的結果（#1625 審查要求）：即使每次 invoke 都注入，核准前後仍是同一則讀數（LangGraph 從被中斷的節點接著跑，
    // `TimeContextMiddleware.before_agent` 在這一次 invoke 裡已經走過）。所以「resume 的 turn/start 不開新的一輪、step 往上數」
    // 那條折疊規則（套件單元量過）在今天的路徑上沒有東西可以讀數；它是防禦，不是現役。
    const run = await approveOnce(`${APPROVAL_PATCH}${EVERY_INVOKE}`, '再說一句');
    const root = rootLogOf(run).events;
    expect(injectedReadings(root)).toHaveLength(2);
    const bodies = run.mainBodies.map((b) => sampledLines(b.messages as never));
    // 核准前、核准後各一個請求：同一則讀數；第三個請求（下一輪）多出第二則，輪數往上數。
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toHaveLength(2);
    expect(bodies[2]?.[0]).toBe(bodies[0]?.[0]);
    expect(bodies[2]?.[1]).toContain('turn 2, step 1');
  }, 90_000);
});
