/**
 * goal 在**設定中途改了**之後的行為（[#1486](https://github.com/DemianLi/nexus-agent/issues/1486)，驗收 D 第 3 條與 G 最後一條）。
 *
 * 做法同 `system-prompt-on-tree.test.ts` 的 D2：真的 `createCordisRoot`、真的 `loadDefaultPlugins`（帶樹）、真的相容層組裝。
 *
 * - **開著的 thread 不動、新的 thread 看新的**：serve 合法地把 `defaultMaxGoalRounds` 改一次（home 層 patch 再讀一次清單），開著的那條
 *   thread 建出來的目標仍是舊上限；新組的 thread 是新上限。
 * - **reload 之後，開著的那條 thread 上工具、`/goal`、宿主的 `goalDriverPort` 打到的是同一個 `GoalService` 實例**。量法是行程內才有的那一格
 *   ——授權（`activation: armed`）。三條路各建一次目標：只要有一條路打到的是另一個實例（例如改成查找時才去問樹上現在那一列），
 *   那個實例是從日誌重放出來的，授權會是 `disarmed`，而且上限會是新設定的值。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionRegistry } from '@nexus/core';
import type { SessionLog } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';

import { goalDriverPort } from './assembly-root.js';
import { createCordisRoot, entryApprovalChannel } from './cordis-root.js';
import type { CordisRoot, NexusAssembly } from './cordis-root.js';
import { withScriptedModel } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { toAgentInvocation } from './messages.js';
import { loadDefaultPlugins } from './plugin-config.js';
import type { LoadedPluginConfig } from './plugin-config.js';
import { seedHomePatch } from './plugin-journal.fixture.js';
import type { ScriptedTurn } from './scripted-model.js';

const temporary: string[] = [];
const roots: CordisRoot[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await root.dispose().catch(() => {});
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): { readonly env: NodeJS.ProcessEnv; readonly dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-goal-reload-'));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return { env: { [HARNESS_HOME_ENV]: dir }, dir };
}

const warnNothing = (): void => {};

interface Booted {
  readonly root: CordisRoot;
  readonly loaded: LoadedPluginConfig;
  readonly assembly: NexusAssembly;
}

async function boot(env: NodeJS.ProcessEnv): Promise<Booted> {
  const root = createCordisRoot({ channel: entryApprovalChannel(undefined) });
  roots.push(root);
  const loaded = await loadDefaultPlugins({ env, warn: warnNothing }, { tree: root.tree });
  const assembly = await root.boot('serve', { plugins: loaded.plugins });
  return { root, loaded, assembly };
}

/** serve 的形狀：這條 thread 自己一次相容層組裝，用呼叫端給的那份載入結果。 */
async function openThread(
  booted: Booted,
  loaded: LoadedPluginConfig,
  threadId: string,
  turns: readonly ScriptedTurn[] = [{ content: '好。' }],
) {
  const plugins = withScriptedModel([...loaded.plugins], turns);
  const built = await booted.assembly.create({ live: false }, { plugins });
  const registry = new SessionRegistry(threadId);
  const attachment = built.attachSessions(registry);
  return {
    built,
    log: registry.root as SessionLog,
    threadId,
    close: async () => {
      await attachment.detach();
      await built.dispose();
    },
  };
}

type Thread = Awaited<ReturnType<typeof openThread>>;

/** `/goal <rawInput>`，經這條 thread 組裝出來的命令（`rawInput` 是命令名後面的那一段）。 */
async function slash(thread: Thread, rawInput: string): Promise<string> {
  const command = thread.built.commands.find('goal');
  if (command === undefined) throw new Error('這條 thread 沒有 /goal');
  const result = await command.handler({
    commandId: rawInput,
    rawInput,
    signal: new AbortController().signal,
    sessionLog: thread.log,
    attachments: [],
    steer: () => undefined,
  });
  if (result.kind !== 'success') throw new Error(`/goal 沒成功：${JSON.stringify(result)}`);
  return result.text ?? '';
}

/** 宿主那條路：`goalDriverPort` 讀這條 thread 的目標。 */
function hostView(thread: Thread) {
  const goals = thread.built.goals;
  if (goals === undefined) throw new Error('這條 thread 沒有 goals 服務');
  const port = goalDriverPort(
    goals,
    () => thread.log,
    () => Promise.resolve(),
    warnNothing,
  );
  return port.goal();
}

/** 模型這一輪呼叫 `create_goal`（人話那一輪先進日誌——工具認的是「這一輪是人直接說的」）。 */
async function createByTool(thread: Thread, objective: string): Promise<void> {
  thread.log.append('turn/start', { kind: 'message', text: objective });
  await thread.built.agent.invoke(toAgentInvocation(objective), {
    configurable: { thread_id: thread.threadId },
  });
}

const CREATE_BY_TOOL = (objective: string): ScriptedTurn[] => [
  { content: '', toolCalls: [{ name: 'create_goal', args: { objective } }] },
  { content: '建好了。' },
];

describe('D：設定中途改了，開著的 thread 不動、新的 thread 看新的；三條路打到同一個服務實例', () => {
  it('defaultMaxGoalRounds 合法地改一次：舊 thread 的命令與工具仍用舊上限，新 thread 用新上限；宿主、命令、工具是同一個實例', async () => {
    const h = home();
    const booted = await boot(h.env);

    // 開著的那條 thread：出貨值。工具那一條先備好腳本（改設定之後才會用到）。
    const old = await openThread(booted, booted.loaded, 'old', CREATE_BY_TOOL('工具建的目標'));

    // 設定在中間改了：同一棵樹再讀一次（home 層 patch 生效，樹上 goal 那一列換成新的一列）。
    seedHomePatch(h.dir, ['- id: goal', '  config:', '    defaultMaxGoalRounds: 3', ''].join('\n'));
    const reloaded = await loadDefaultPlugins(
      { env: h.env, warn: warnNothing },
      { tree: booted.root.tree },
    );
    expect(reloaded.dropped).toEqual([]);

    // 命令那條路：舊 thread 建目標，上限是舊的（出貨預設 256），而且宿主讀到的授權是 armed——
    // 命令與宿主若是兩個實例，宿主那個是重放出來的 disarmed。
    const shown = await slash(old, '命令建的目標');
    expect(shown).toContain('輪次：0/256');
    expect(hostView(old)).toMatchObject({
      objective: '命令建的目標',
      maxGoalRounds: 256,
      activation: 'armed',
    });
    await slash(old, 'clear');
    expect(hostView(old)).toBeUndefined();

    // 工具那條路：同一條舊 thread，模型呼叫 create_goal。
    await createByTool(old, '工具建的目標');
    expect(hostView(old)).toMatchObject({
      objective: '工具建的目標',
      maxGoalRounds: 256,
      activation: 'armed',
    });

    // 新 thread：用新讀的那份清單組裝，看到新上限。
    const fresh = await openThread(booted, reloaded, 'new');
    const freshShown = await slash(fresh, '新 thread 的目標');
    expect(freshShown).toContain('輪次：0/3');
    expect(hostView(fresh)).toMatchObject({ maxGoalRounds: 3, activation: 'armed' });

    // 兩條 thread 各自的服務，不是同一個。
    expect(old.built.goals?.serviceFor(old.log)).not.toBe(fresh.built.goals?.serviceFor(fresh.log));

    await old.close();
    await fresh.close();
  }, 60000);
});

describe('N0376：goal 列重載之後，續行授權的通知仍到得了訂閱的人', () => {
  /** 宿主那條路訂「授權變了」：`goalDriverPort.onActivationChanged`，就是 wire handler 訂的那一格（它再轉給 pump 送 `goal/activation`）。 */
  function listen(thread: Thread): string[] {
    const goals = thread.built.goals;
    if (goals === undefined) throw new Error('這條 thread 沒有 goals 服務');
    const port = goalDriverPort(
      goals,
      () => thread.log,
      () => Promise.resolve(),
      warnNothing,
    );
    const seen: string[] = [];
    port.onActivationChanged?.((change) => seen.push(change.goal?.activation ?? '無目標'));
    return seen;
  }

  it('重載前就訂了的 thread 照樣收到 armed／disarmed；重載後才開的 thread 也收到，兩邊互不串', async () => {
    const h = home();
    const booted = await boot(h.env);
    const old = await openThread(booted, booted.loaded, 'old');
    // 先訂、後重載：訂閱掛在舊那一列的核心上。
    const oldSeen = listen(old);

    seedHomePatch(h.dir, ['- id: goal', '  config:', '    defaultMaxGoalRounds: 3', ''].join('\n'));
    const reloaded = await loadDefaultPlugins(
      { env: h.env, warn: warnNothing },
      { tree: booted.root.tree },
    );
    expect(reloaded.dropped).toEqual([]);

    // 重載之後，舊 thread 的命令（舊閉包）改授權：訂在舊核心上的人要聽得到。
    await slash(old, '命令建的目標');
    await slash(old, 'pause');
    await slash(old, 'resume');
    expect(oldSeen).toEqual(['armed', 'disarmed', 'armed']);

    // 重載之後才開的 thread：訂在新那一列的核心上，同樣聽得到；舊 thread 的人聽不到它的變化。
    const fresh = await openThread(booted, reloaded, 'new');
    const freshSeen = listen(fresh);
    await slash(fresh, '新 thread 的目標');
    await slash(fresh, 'pause');
    expect(freshSeen).toEqual(['armed', 'disarmed']);
    expect(oldSeen).toEqual(['armed', 'disarmed', 'armed']);

    await old.close();
    await fresh.close();
  }, 60000);
});
