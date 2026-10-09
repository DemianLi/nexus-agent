/**
 * `thread.pin`／`unpin`／`archive`／`unarchive`（[#633](https://github.com/DemianLi/nexus-agent/issues/633)）：wire 這一層。
 *
 * 兩層：
 *
 * - **沒有 agent 的 thread**：回應形狀、錯誤碼、`GET /threads` 帶的兩個集合、沒接整理檔時的 `not_supported`、
 *   儲存體壞掉走協定層錯誤而不是業務失敗。
 * - **真組裝**：真的 `createNexusAgent`＋背景子代理，看「還在跑」的拒絕、`stopActivity` 真的停掉、
 *   封存的會話**一次模型呼叫都不再發生**、取消封存後恢復。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry, SessionLog, SessionRegistry } from '@nexus/core';
import { createGoalPlugin, GOALS_SERVICE } from '@nexus/plugin-goal';
import { createWireClient, SUBAGENT_CLOSED } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import type { GoalDriverPort } from './goal-driver.js';
import { composeAttachSessions } from './session-attach.js';
import { THREAD_ORGANIZATION_FILE, ThreadOrganization } from './thread-organization.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { WireHandler } from './wire-handler.js';

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** 日誌上每一顆 `turn/end` 的收尾種類（沒帶 reason ＝ `done`）。 */
function endKinds(log: SessionLog): string[] {
  return log.events
    .filter((event) => event.type === 'turn/end')
    .map((event) => (event.data as { reason?: { kind: string } }).reason?.kind ?? 'done');
}

async function settle(ms = 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-thread-org-wire-'));
});
afterEach(async () => {
  for (const handler of opened.splice(0)) await handler.close();
  await rm(dir, { recursive: true, force: true });
});

const opened: WireHandler[] = [];

type HandlerOptions = Parameters<typeof createWireHandler>[0];

function rig(options: Omit<HandlerOptions, 'auth'>) {
  const handler = createWireHandler({ auth: TEST_BROWSER_AUTH, ...options });
  opened.push(handler);
  const fetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
    handler.handle(loopbackRequest(input as string, init));
  const client = createWireClient({ baseUrl: 'http://org.test', fetch });
  let nextId = 1;
  const raw = async (thread: string, method: string, params?: unknown) => {
    const response = await fetch(`http://org.test/threads/${thread}/commands/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: nextId++, method, ...(params !== undefined && { params }) }),
    });
    return (await response.json()) as Record<string, unknown>;
  };
  return { client, raw };
}

const stubAgent: HandlerOptions['createAgent'] = async () => ({
  agent: {} as PumpAgent,
  commands: emptyCommandPoint(),
  dispose: async () => {},
  attachSessions: () => ({ detach: async () => {} }),
});

const noStored = { items: [], unreadable: 0 };

describe('沒有 agent 的 thread：形狀與錯誤碼', () => {
  it('釘選：回完整集合，最近釘的在前；取消冪等（沒釘過、甚至沒這條會話也是 ok）', async () => {
    const threadOrganization = await ThreadOrganization.open(dir);
    const { client } = rig({
      createAgent: stubAgent,
      threadOrganization,
      storedThreadKnown: async () => true,
    });
    expect(await client.threadPin('a')).toEqual({
      kind: 'ok',
      result: { ok: true, value: { pinnedThreadIds: ['a'] } },
    });
    expect(await client.threadPin('b')).toMatchObject({
      result: { ok: true, value: { pinnedThreadIds: ['b', 'a'] } },
    });
    // 已釘的再釘：不重排。
    expect(await client.threadPin('a')).toMatchObject({
      result: { value: { pinnedThreadIds: ['b', 'a'] } },
    });
    expect(await client.threadUnpin('a')).toMatchObject({
      result: { ok: true, value: { pinnedThreadIds: ['b'] } },
    });
    expect(await client.threadUnpin('a')).toMatchObject({
      result: { ok: true, value: { pinnedThreadIds: ['b'] } },
    });
    expect(await client.threadUnpin('從沒出現過')).toMatchObject({ result: { ok: true } });
  });

  it('沒有這條會話：釘選、封存都是 thread_not_found（業務失敗，不是協定錯誤），而且集合不動', async () => {
    const threadOrganization = await ThreadOrganization.open(dir);
    const { client } = rig({
      createAgent: stubAgent,
      threadOrganization,
      storedThreadKnown: async (id) => id === 'real',
    });
    expect(await client.threadPin('ghost')).toEqual({
      kind: 'ok',
      result: { ok: false, error: { code: 'thread_not_found' } },
    });
    expect(await client.threadArchive('ghost')).toEqual({
      kind: 'ok',
      result: { ok: false, error: { code: 'thread_not_found' } },
    });
    expect(threadOrganization.pinnedThreadIds).toEqual([]);
    expect(threadOrganization.archivedThreadIds).toEqual([]);
    expect(await client.threadPin('real')).toMatchObject({ result: { ok: true } });
  });

  it('這個行程裡開過的 thread 就算存在，不必問磁碟', async () => {
    const threadOrganization = await ThreadOrganization.open(dir);
    const { client } = rig({
      createAgent: stubAgent,
      threadOrganization,
      storedThreadKnown: async () => {
        throw new Error('不該問到磁碟');
      },
    });
    await client.slashList('live'); // 建出 thread
    expect(await client.threadPin('live')).toMatchObject({ result: { ok: true } });
  });

  it('封存：回完整封存集合；封存同時把它的釘選拿掉；封存的不能釘（thread_archived）；取消封存冪等', async () => {
    const threadOrganization = await ThreadOrganization.open(dir);
    const { client } = rig({
      createAgent: stubAgent,
      threadOrganization,
      storedThreadKnown: async () => true,
    });
    await client.threadPin('a');
    await client.threadPin('b');
    expect(await client.threadArchive('a')).toEqual({
      kind: 'ok',
      result: { ok: true, value: { archivedThreadIds: ['a'] } },
    });
    expect(threadOrganization.pinnedThreadIds).toEqual(['b']);
    expect(await client.threadPin('a')).toEqual({
      kind: 'ok',
      result: { ok: false, error: { code: 'thread_archived' } },
    });
    // 已封存再封存：no-op。
    expect(await client.threadArchive('a')).toMatchObject({
      result: { ok: true, value: { archivedThreadIds: ['a'] } },
    });
    expect(await client.threadUnarchive('a')).toEqual({
      kind: 'ok',
      result: { ok: true, value: { archivedThreadIds: [] } },
    });
    expect(await client.threadUnarchive('a')).toMatchObject({
      result: { ok: true, value: { archivedThreadIds: [] } },
    });
    // 取消封存之後釘選不會自己回來，但現在能釘了。
    expect(threadOrganization.pinnedThreadIds).toEqual(['b']);
    expect(await client.threadPin('a')).toMatchObject({ result: { ok: true } });
  });

  it('stopActivity 不是布林：invalid_argument，而且沒有封存', async () => {
    const threadOrganization = await ThreadOrganization.open(dir);
    const { raw } = rig({
      createAgent: stubAgent,
      threadOrganization,
      storedThreadKnown: async () => true,
    });
    expect(await raw('a', 'thread.archive', { stopActivity: 'yes' })).toMatchObject({
      type: 'error',
      error: 'invalid_argument',
    });
    expect(threadOrganization.archivedThreadIds).toEqual([]);
    // 沒帶 params 照常封存。
    expect(await raw('a', 'thread.archive')).toMatchObject({ type: 'success' });
    expect(threadOrganization.archivedThreadIds).toEqual(['a']);
  });

  it('GET /threads 帶著兩個集合（順序原樣）；沒接整理檔的 server 不送這兩欄', async () => {
    const threadOrganization = await ThreadOrganization.open(dir);
    const { client } = rig({
      createAgent: stubAgent,
      threadOrganization,
      storedThreadKnown: async () => true,
      listThreads: async () => noStored,
    });
    await client.threadPin('a');
    await client.threadPin('b');
    await client.threadArchive('c');
    const listed = await client.listThreads();
    expect(listed.kind).toBe('ok');
    if (listed.kind !== 'ok') return;
    expect(listed.result.pinnedThreadIds).toEqual(['b', 'a']);
    expect(listed.result.archivedThreadIds).toEqual(['c']);

    const bare = rig({ createAgent: stubAgent, listThreads: async () => noStored });
    const bareListed = await bare.client.listThreads();
    expect(bareListed.kind).toBe('ok');
    if (bareListed.kind !== 'ok') return;
    expect(bareListed.result.pinnedThreadIds).toBeUndefined();
    expect(bareListed.result.archivedThreadIds).toBeUndefined();
  });

  it('沒接整理檔：四個命令都是 not_supported；thread.rename 在這張 PR 還是 not_supported', async () => {
    const { raw } = rig({ createAgent: stubAgent });
    for (const method of ['thread.pin', 'thread.unpin', 'thread.archive', 'thread.unarchive']) {
      expect(await raw('a', method)).toMatchObject({ type: 'error', error: 'not_supported' });
    }
    expect(await raw('a', 'thread.rename', { title: '新名字' })).toMatchObject({
      type: 'error',
      error: 'not_supported',
    });
    // 就算接了整理檔，rename 也還沒做。
    const withOrg = rig({
      createAgent: stubAgent,
      threadOrganization: await ThreadOrganization.open(dir),
    });
    expect(await withOrg.raw('a', 'thread.rename', { title: '新名字' })).toMatchObject({
      error: 'not_supported',
    });
  });

  it('儲存體讀不動、或寫不進去：協定層錯誤（unknown_error），不是 thread_not_found', async () => {
    const threadOrganization = await ThreadOrganization.open(dir);
    const broken = rig({
      createAgent: stubAgent,
      threadOrganization,
      storedThreadKnown: async () => {
        throw new Error('磁碟壞了');
      },
    });
    for (const method of ['thread.pin', 'thread.archive']) {
      const reply = await broken.raw('a', method);
      expect(reply).toMatchObject({ type: 'error', error: 'unknown_error' });
      expect(JSON.stringify(reply)).toContain('磁碟壞了');
    }
    expect(threadOrganization.pinnedThreadIds).toEqual([]);
    expect(threadOrganization.archivedThreadIds).toEqual([]);

    // 寫不進去：目標檔被換成目錄。
    const home2 = join(dir, 'home2');
    const org2 = await ThreadOrganization.open(home2);
    await mkdir(join(home2, THREAD_ORGANIZATION_FILE), { recursive: true });
    const unwritable = rig({
      createAgent: stubAgent,
      threadOrganization: org2,
      storedThreadKnown: async () => true,
    });
    expect(await unwritable.raw('a', 'thread.pin')).toMatchObject({
      type: 'error',
      error: 'unknown_error',
    });
    expect(org2.pinnedThreadIds).toEqual([]);
  });
});

// ───────────────────────────── 真組裝 ───────────────────────

describe('真組裝：還在跑的拒絕、stopActivity、封存之後不再發生模型呼叫', () => {
  const delegate: ScriptedTurn = {
    content: '委派。',
    toolCalls: [
      {
        name: 'subagent',
        id: 'root-call',
        args: { description: '幹活', subagent_type: 'worker', run_in_background: true },
      },
    ],
  };

  /**
   * @param rootTurns - 根模型的腳本。
   * @param workerTurns - 背景子代理的腳本；沒給就不掛子代理。
   */
  async function assemble(
    rootTurns: readonly ScriptedTurn[],
    workerTurns?: readonly ScriptedTurn[],
    options: { readonly withGoal?: boolean } = {},
  ) {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = { gate: 0 };
    const workerModel = new ScriptedChatModel({ turns: workerTurns ?? [{ content: '無事。' }] });
    const plugin: PluginEntry = {
      plugin: {
        name: 'org-host',
        apply(registry) {
          if (workerTurns !== undefined) {
            registry.subagents.register({
              name: 'worker',
              description: '幹活的。',
              systemPrompt: '你是 worker。',
              model: workerModel as never,
            });
          }
          registry.tools.register(
            tool(
              async () => {
                entered.gate += 1;
                await gate;
                return '放行了';
              },
              { name: 'gate', description: '等放行。', schema: z.object({}) },
            ),
          );
        },
      },
    };
    const rootModel = new ScriptedChatModel({ turns: rootTurns });
    const built = await createNexusAgent({
      model: rootModel,
      checkpointer: new MemorySaver(),
      plugins: [
        plugin,
        ...(options.withGoal === true
          ? [createGoalPlugin({ now: () => 100, newGoalId: () => 'goal-1' })]
          : []),
      ],
      backend: new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' }),
      backgroundSubagents: {},
    });
    const goals = options.withGoal === true ? built.services.use(GOALS_SERVICE) : undefined;
    const threadOrganization = await ThreadOrganization.open(join(dir, 'home'));
    let sessions: SessionRegistry | undefined;
    const { client, raw } = rig({
      threadOrganization,
      storedThreadKnown: async () => false,
      createAgent: async () => ({
        agent: built.agent as unknown as PumpAgent,
        commands: emptyCommandPoint(),
        dispose: () => built.dispose(),
        attachSessions: (registry, backgroundPort) => {
          sessions = registry;
          return composeAttachSessions(built)(registry, backgroundPort);
        },
        ...(goals !== undefined && {
          goalDriver: (log: () => SessionLog): GoalDriverPort => ({
            goal: () => goals.serviceFor(log())?.get(),
            block: (ref, reason) => goals.serviceFor(log())?.block(ref, reason),
            disarm: () => void goals.serviceFor(log())?.disarm(),
            pause: (ref) => void goals.serviceFor(log())?.pause(ref),
            flush: () => Promise.resolve(),
            warn: () => undefined,
          }),
        }),
      }),
    });
    return {
      client,
      raw,
      goals,
      release,
      entered,
      rootModel,
      workerModel,
      threadOrganization,
      sessions: () => sessions!,
    };
  }

  const gateCall = (id: string): ScriptedTurn => ({
    content: '',
    toolCalls: [{ name: 'gate', id, args: {} }],
  });

  it('一輪在跑、沒帶 stopActivity：thread_active＋activity:[turn]，什麼都沒封存；帶了就封存、並停掉這一輪', async () => {
    const rigged = await assemble([gateCall('g1'), { content: '不會走到。' }]);
    await rigged.client.runStart('t1', '開始');
    await until(() => rigged.entered.gate === 1);

    expect(await rigged.client.threadArchive('t1')).toEqual({
      kind: 'ok',
      result: { ok: false, error: { code: 'thread_active', activity: ['turn'] } },
    });
    expect(rigged.threadOrganization.archivedThreadIds).toEqual([]);

    expect(await rigged.client.threadArchive('t1', { stopActivity: true })).toMatchObject({
      result: { ok: true, value: { archivedThreadIds: ['t1'] } },
    });
    expect(rigged.threadOrganization.isArchived('t1')).toBe(true);
    rigged.release();
    // 這一輪合作式中止：根模型沒有再被叫第二次（「不會走到」那一步沒發生）。
    await settle(150);
    expect(rigged.rootModel.prompts).toHaveLength(1);
  }, 20000);

  it('只有背景子代理還在跑（根這一輪已收尾）：activity 只有 subagent；stopActivity 把它中斷', async () => {
    const rigged = await assemble(
      [delegate, { content: '派出去了，等通知。' }],
      [gateCall('w-gate'), { content: '不會走到。' }],
    );
    await rigged.client.runStart('t1', '委派');
    await until(
      () =>
        rigged
          .sessions()
          ?.list()
          .some((entry) => entry.address.kind === 'subagent') ?? false,
    );
    await until(() => rigged.entered.gate === 1);
    // 等根這一輪收尾（只剩子代理還在跑）。
    await until(() => rigged.rootModel.prompts.length >= 2);
    await settle(100);

    expect(await rigged.client.threadArchive('t1')).toEqual({
      kind: 'ok',
      result: { ok: false, error: { code: 'thread_active', activity: ['subagent'] } },
    });
    expect(rigged.threadOrganization.archivedThreadIds).toEqual([]);

    expect(await rigged.client.threadArchive('t1', { stopActivity: true })).toMatchObject({
      result: { ok: true },
    });
    const child = rigged
      .sessions()
      .list()
      .find((entry) => entry.address.kind === 'subagent')!;
    rigged.release();
    await until(() => child.log.events.some((event) => event.type === 'turn/end'));
    expect(child.log.events.find((event) => event.type === 'turn/end')!.data).toEqual({
      reason: { kind: 'aborted', cause: { kind: 'parent' } },
    });
    expect(rigged.workerModel.prompts).toHaveLength(1);
    // 子代理收尾會通知主對話（結算喚醒）：喚醒開出來的那一輪被閘門擋下（blocked），根模型仍只被叫過兩次。
    await until(() => endKinds(rigged.sessions().root).includes('blocked'));
    expect(rigged.rootModel.prompts).toHaveLength(2);
  }, 20000);

  it('背景子代理的每一步也過閘門（血統）：封存落在它兩步之間，下一步不叫模型，那一輪以 blocked 收、結算原因是 refusal', async () => {
    const rigged = await assemble(
      [delegate, { content: '派出去了，等通知。' }],
      [gateCall('w-gate'), { content: '不該被讀到。' }],
    );
    await rigged.client.runStart('t1', '委派');
    await until(() => rigged.entered.gate === 1);
    await until(() => rigged.rootModel.prompts.length >= 2);
    const child = rigged
      .sessions()
      .list()
      .find((entry) => entry.address.kind === 'subagent')!;
    // 直接動集合（不經 wire 的活動檢查）：模擬封存剛好落在子代理兩次模型呼叫之間。
    await rigged.threadOrganization.archive('t1', {
      known: () => Promise.resolve(true),
      activity: () => [],
      stop: () => Promise.resolve(),
    });
    rigged.release();
    await until(() => endKinds(child.log).length === 1);
    expect(endKinds(child.log)).toEqual(['blocked']);
    expect(child.log.events.some((event) => event.type === 'turn/failed')).toBe(false);
    expect(rigged.workerModel.prompts).toHaveLength(1);
    // 結算通知照送，原因是 refusal；根這邊喚醒的那一輪同樣被擋下。
    await until(() => endKinds(rigged.sessions().root).includes('blocked'));
    expect(rigged.rootModel.prompts).toHaveLength(2);
    const settled = rigged
      .sessions()
      .root.events.find(
        (event) =>
          event.type === 'turn/start' &&
          (event.data as { kind: string }).kind === 'subagent-settled',
      );
    expect((settled?.data as { reason?: string } | undefined)?.reason).toBe('refusal');
  }, 20000);

  it('閒著的 thread 直接封存；封存之後送話：開一輪以 blocked 收、模型一次都不再被叫；取消封存之後恢復', async () => {
    const rigged = await assemble([{ content: '第一輪。' }, { content: '恢復了。' }]);
    await rigged.client.runStart('t1', '第一句');
    await until(() => rigged.rootModel.prompts.length === 1);
    await settle(100);

    expect(await rigged.client.threadArchive('t1')).toMatchObject({ result: { ok: true } });
    await rigged.client.runStart('t1', '封存之後的話');
    await until(() => endKinds(rigged.sessions().root).includes('blocked'));
    expect(rigged.rootModel.prompts).toHaveLength(1);
    expect(
      rigged
        .sessions()
        .root.events.filter((event) => event.type === 'turn/start')
        .map((event) => (event.data as { text?: string }).text),
    ).toEqual(['第一句', '封存之後的話']);

    expect(await rigged.client.threadUnarchive('t1')).toMatchObject({ result: { ok: true } });
    await rigged.client.runStart('t1', '恢復之後的話');
    await until(() => rigged.rootModel.prompts.length === 2);
    const lastPrompt = (rigged.rootModel.prompts[1] ?? [])
      .map((message) => message.text)
      .join('\n');
    expect(lastPrompt).toContain('恢復之後的話');
    // 封存期間那句話被擋下、沒進對話（照 dsh）：模型看不到它。
    expect(lastPrompt).not.toContain('封存之後的話');
  }, 20000);

  it('subagent.send 對封存的會話：subagent_closed，不收新的話', async () => {
    const rigged = await assemble(
      [delegate, { content: '派出去了，等通知。' }],
      [gateCall('w-gate'), { content: '做完。' }],
    );
    await rigged.client.runStart('t1', '委派');
    await until(() => rigged.entered.gate === 1);
    await until(() => rigged.rootModel.prompts.length >= 2);
    const child = rigged
      .sessions()
      .list()
      .find((entry) => entry.address.kind === 'subagent')!;
    const runId = (child.address as { runId: string }).runId;
    await rigged.client.threadArchive('t1', { stopActivity: true });
    expect(await rigged.client.subagentSend('t1', runId, '還聽得到嗎')).toMatchObject({
      type: 'error',
      error: SUBAGENT_CLOSED,
    });
    rigged.release();
  }, 20000);

  it('目標續行：封存期間輪被擋下，目標轉 blocked；取消封存不會自己續行（要 /goal resume）', async () => {
    const rigged = await assemble([{ content: '續行一輪。' }], undefined, { withGoal: true });
    await rigged.client.slashList('t1'); // 建出 thread
    await until(() => rigged.sessions() !== undefined);
    expect(await rigged.client.threadArchive('t1')).toMatchObject({ result: { ok: true } });
    const root = rigged.sessions().root;
    rigged.goals!.serviceFor(root)?.create({ objective: '把 CI 修綠', maxGoalRounds: 1 });
    await until(() => endKinds(root).includes('blocked'));
    expect(rigged.rootModel.prompts).toHaveLength(0);
    expect(rigged.goals!.serviceFor(root)?.get()).toMatchObject({
      phase: 'blocked',
      blockedReason: { code: 'prompt-rejected' },
    });

    expect(await rigged.client.threadUnarchive('t1')).toMatchObject({ result: { ok: true } });
    await settle(250);
    expect(rigged.rootModel.prompts).toHaveLength(0);
    expect(rigged.goals!.serviceFor(root)?.get()).toMatchObject({
      phase: 'blocked',
      blockedReason: { code: 'prompt-rejected' },
    });
  }, 20000);
});
