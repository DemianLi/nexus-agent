/**
 * goal 在樹上這一列（[#1486](https://github.com/DemianLi/nexus-agent/issues/1486)）：一致性、lazy 的服務、兩條 thread 同時活著。
 *
 * 這一檔走的是真的 Cordis 樹（`Loader` + 工具／命令／會話查找三個真提供者），不經相容層外殼。和 `index.test.ts`（相容層外殼上的
 * 域語意）分工：那邊問「目標這個域怎麼運作」，這邊問「掛在樹上之後，服務什麼時候出生、跟著誰、兩條 thread 會不會串」。
 *
 * **測試檔不受 SDK lint 管**（`PLUGIN_LINT_IGNORES`），所以這裡可以 import `@nexus/core` 造日誌與挑法；`src/index.ts` 不行。
 */

import type { StructuredToolInterface } from '@langchain/core/tools';
import { createCommandsProvider } from '@nexus/commands/provider';
import { goalId, pickSessionForCall, SessionLog, SessionRegistry } from '@nexus/core';
import { Context } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import { goalsToken } from '@nexus/goal';
import type { GoalServices } from '@nexus/goal';
import { checkConformance, checkSharedAcrossThreads } from '@nexus/sdk';
import type { ThreadStep } from '@nexus/sdk';
import { createSessionLookupProvider } from '@nexus/session/provider';
import { createToolsProvider } from '@nexus/tools/provider';
import { afterEach, describe, expect, it } from 'vitest';

import * as goal from './index.js';
import { GOAL_COMMAND_NAME, GOAL_CREATE_TOOL_NAME, GOAL_NONE_MESSAGE } from './index.js';
import { GoalService } from './service.js';

const opened: Context[] = [];
afterEach(async () => {
  for (const root of opened.splice(0)) await root.fiber.dispose();
});

interface Mounted {
  readonly root: Context;
  readonly sessions: ReadonlyMap<string, SessionRegistry>;
  readonly goals: GoalServices;
  readonly tool: (name: string) => StructuredToolInterface;
  /** 以某條 thread 的身分打 `/goal <input>`：回命令答的字。 */
  readonly command: (thread: string, input: string) => string;
}

/** 掛一次：每條 thread 一張註冊表（root 日誌 id 就是 thread id），共用同一份查找、同一顆核心。 */
async function mountFor(threads: readonly string[], config: unknown = {}): Promise<Mounted> {
  const sessions = new Map(threads.map((thread) => [thread, new SessionRegistry(thread)]));
  const tools = createToolsProvider();
  const commands = createCommandsProvider();
  const root = new Context();
  opened.push(root);
  await root.plugin(Loader);
  Object.assign(root.loader.builtins, {
    tools: tools.Provider,
    commands: commands.Provider,
    'session-lookup': createSessionLookupProvider((callConfig) =>
      pickSessionForCall(sessions.values(), callConfig),
    ).Provider,
    goal,
  });
  const create = (options: { id: string; name: string; config?: unknown }) =>
    root.loader.create(options as never, null);
  await create({ id: 'tools', name: 'cordis:tools' });
  await create({ id: 'commands', name: 'cordis:commands' });
  await create({ id: 'session-lookup', name: 'cordis:session-lookup' });
  await create({ id: 'goal', name: 'cordis:goal', config });
  await root.loader.await();
  const goals = root.get(goalsToken.name) as GoalServices | undefined;
  if (goals === undefined) throw new Error('goals 服務沒有提供上來');
  return {
    root,
    sessions,
    goals,
    tool: (name) => {
      const entry = tools.entries().find((item) => item.tool.name === name);
      if (entry === undefined) throw new Error(`工具 ${name} 沒有註冊上去`);
      return entry.tool;
    },
    command: (thread, input) => {
      const entry = commands.entries().find((item) => item.definition.name === GOAL_COMMAND_NAME);
      const log = sessions.get(thread)?.root;
      if (entry === undefined || log === undefined) throw new Error('命令或 thread 不存在');
      const result = entry.definition.handler({
        commandId: `cmd-${thread}`,
        rawInput: input,
        attachments: [],
        signal: new AbortController().signal,
        sessionLog: log,
        steer: () => undefined,
      }) as { kind: string; text: string };
      return result.text;
    },
  };
}

describe('一致性套件：真的提供者、真的 Loader', () => {
  it('goal 全格通過：manifest、匯出形式、卸載後工具與命令都撤掉、缺提供者停在 PENDING', async () => {
    let latestTools = createToolsProvider();
    let latestCommands = createCommandsProvider();
    const failures = await checkConformance({
      row: 'goal',
      module: goal,
      config: {},
      providers: {
        tools: () => {
          latestTools = createToolsProvider();
          return latestTools.Provider;
        },
        commands: () => {
          latestCommands = createCommandsProvider();
          return latestCommands.Provider;
        },
        sessionLookup: () => createSessionLookupProvider(() => ({ kind: 'not-attached' })).Provider,
      },
      residue: () => latestTools.entries().length + latestCommands.registrations(),
    });
    expect(failures).toEqual([]);
  });

  it('manifest：提供 goals（1.0.0），消費 tools／commands／sessionLookup；沒有 default 匯出', () => {
    expect(goal.manifest.provides).toEqual([{ token: 'goals', version: '1.0.0' }]);
    expect(goal.manifest.consumes).toEqual([
      { token: 'tools', range: '^1.1.0' },
      { token: 'commands', range: '^1.0.0' },
      { token: 'sessionLookup', range: '^1.0.0' },
    ]);
    expect('default' in goal).toBe(false);
  });
});

describe('套一次、服務兩條 thread', () => {
  const STEPS: ThreadStep<string>[] = [
    { thread: 'thread-a', input: '甲的目標' },
    { thread: 'thread-b', input: '乙的目標' },
  ];

  /** 打一次 `/goal`，再看那條 thread 的日誌上現在寫了什麼。 */
  function runAs(mounted: Mounted, thread: string, input: string): unknown {
    const answer = mounted.command(thread, input);
    const log = mounted.sessions.get(thread)?.root;
    return {
      answer: answer.replace(/goal-[0-9a-f-]+/gu, '<id>'),
      written: (log?.events ?? []).map((event) => event.type),
    };
  }

  it('共用一份與各自一份相同：每條 thread 的日誌只有自己寫的，沒有「分不出來」', async () => {
    const failures = await checkSharedAcrossThreads({
      name: 'goal',
      steps: STEPS,
      mount: (threads) => mountFor(threads),
      call: (mounted, thread, input) => Promise.resolve(runAs(mounted, thread, input)),
    });
    expect(failures).toEqual([]);
  });

  it('兩條 thread 同時活著：各建各的目標，互不看見', async () => {
    const mounted = await mountFor(['thread-a', 'thread-b']);
    expect(mounted.command('thread-a', '甲的目標')).toContain('目標建好了');
    expect(mounted.command('thread-b', '')).toBe(GOAL_NONE_MESSAGE);
    expect(mounted.command('thread-b', '乙的目標')).toContain('目標建好了');
    expect(mounted.command('thread-a', '')).toContain('甲的目標');
    expect(mounted.command('thread-b', '')).toContain('乙的目標');
    const a = mounted.sessions.get('thread-a')!.root;
    const b = mounted.sessions.get('thread-b')!.root;
    expect(a.events.filter((event) => event.type === 'goal/change')).toHaveLength(1);
    expect(b.events.filter((event) => event.type === 'goal/change')).toHaveLength(1);
    expect(mounted.goals.serviceFor(a)).not.toBe(mounted.goals.serviceFor(b));
  });
});

describe('lazy：服務在第一次被問到才出生，跟著日誌而不是跟著列', () => {
  it('沒被問過的日誌沒有服務；`existingFor` 看了不建；問過之後永遠是同一個', async () => {
    const mounted = await mountFor(['t']);
    const log = mounted.sessions.get('t')!.root;
    expect(mounted.goals.existingFor(log)).toBeUndefined();
    expect(mounted.goals.existingFor(log)).toBeUndefined();
    const service = mounted.goals.serviceFor(log);
    expect(mounted.goals.serviceFor(log)).toBe(service);
    expect(mounted.goals.existingFor(log)).toBe(service);
  });

  it('命令、工具與宿主問到的是同一個實例（拿快照，不另外建）', async () => {
    const mounted = await mountFor(['t']);
    const log = mounted.sessions.get('t')!.root;
    // 命令先建：宿主之後問到的就是命令建的那個。
    mounted.command('t', '命令建的目標');
    // 命令建的那一個就是宿主查得到的那一個：宿主還沒問過，`existingFor` 已經有了（兩邊若各一個核心，這裡是 undefined）。
    expect(mounted.goals.existingFor(log)).toBeDefined();
    const viaHost = mounted.goals.serviceFor(log);
    expect(viaHost.get()?.objective).toBe('命令建的目標');
    // 工具接著動同一個目標的相鄰操作：`get_goal` 讀到的是同一份折疊。
    log.append('turn/start', { kind: 'message', text: '請繼續' });
    const answer = await mounted
      .tool('get_goal')
      .invoke({}, { configurable: { thread_id: 't', checkpoint_ns: 'tools:call' } } as never);
    expect(String((answer as { content?: unknown }).content ?? answer)).toContain('命令建的目標');
    expect(mounted.goals.existingFor(log)).toBe(viaHost);
  });

  it('日誌上本來就有 goal/change：第一次問到時重放出來（不漏歷史）', async () => {
    const mounted = await mountFor(['t']);
    const earlier = new SessionLog('earlier');
    new GoalService(earlier, { now: () => 5, newGoalId: () => 'goal-歷史' }).create({
      objective: '上個行程的目標',
    });
    const resumed = new SessionLog('t-resumed', { seed: earlier.events });
    const service = mounted.goals.serviceFor(resumed);
    expect(service.get()).toMatchObject({ id: goalId('goal-歷史'), objective: '上個行程的目標' });
    // 授權不持久：重放回來是 disarmed，要人重新授權。
    expect(service.get()?.activation).toBe('disarmed');
  });

  it('建了之後別處追加的 goal/change 同步看得到（訂閱在建構當下就掛上了）', async () => {
    const mounted = await mountFor(['t']);
    const log = mounted.sessions.get('t')!.root;
    const service = mounted.goals.serviceFor(log);
    expect(service.get()).toBeUndefined();
    // 另一個寫入者（例如被取代的舊服務）在同一份日誌上寫了一顆。
    new GoalService(log, { now: () => 9, newGoalId: () => 'goal-別人寫的' }).create({
      objective: '別人寫的',
    });
    expect(service.get()?.objective).toBe('別人寫的');
  });

  it('列卸載之後已經建好的服務照常運作、之後才被問到的日誌也建得出來（狀態不繫在列的 effect 上）', async () => {
    const mounted = await mountFor(['t']);
    const log = mounted.sessions.get('t')!.root;
    const service = mounted.goals.serviceFor(log) as GoalService;
    const later = new SessionLog('later');
    await mounted.root.fiber.dispose();
    service.create({ objective: '卸載之後還能建' });
    expect(service.get()?.objective).toBe('卸載之後還能建');
    // 手上抓著的核心（thread 組裝時取的快照）卸載後再被問到新日誌：不碰 ctx，所以不拋。
    expect(() => mounted.goals.serviceFor(later)).not.toThrow();
  });
});

describe('工具與命令在 subagent 日誌上不建服務', () => {
  it('create_goal 以 subagent 的身分呼叫：拒絕，而且那一份日誌上沒有服務', async () => {
    const mounted = await mountFor(['t']);
    const registry = mounted.sessions.get('t')!;
    const sub = registry.open({ kind: 'subagent', runId: 'tools:spawn-1' });
    sub.append('turn/start', { kind: 'message', text: '偷偷來' });
    const answer = await mounted.tool(GOAL_CREATE_TOOL_NAME).invoke({ objective: '偷偷來' }, {
      configurable: { thread_id: 't', checkpoint_ns: 'tools:spawn-1|tools:call-1' },
    } as never);
    expect(String((answer as { content?: unknown }).content ?? answer)).toContain(
      goal.GOAL_TOOL_NOT_ROOT_MESSAGE,
    );
    expect(mounted.goals.existingFor(registry.root)).toBeUndefined();
    expect(sub.events.filter((event) => event.type === 'goal/change')).toEqual([]);
  });
});
