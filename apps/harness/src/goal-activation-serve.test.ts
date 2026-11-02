/**
 * 目標會不會自己續行，**走真的 serve 與下行**（[#1575](https://github.com/DemianLi/nexus-agent/issues/1575) N0376，dsh `goal/activation-changed`）。
 *
 * 事件是 wire 的 `custom` frame（`goal/activation`）：**行程內的狀態、不是日誌事件**，所以不落盤、不進歷史頁。這一檔量：
 * 授權變了才送（建立、暫停、恢復、按停止）、新接上的下行補送「現在」、重啟之後有目標的 thread 拿到 `disarmed`、沒有目標的 thread 一顆都沒有。
 *
 * 模型是腳本：先由模型建目標（`create_goal`），之後的續行輪是一段故意拖長的回覆，測試在中間動手。**零憑證、零外部連線**。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Event, WireClient } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import type { ScriptedTurn } from './scripted-model.js';
import { scriptedPatchText } from './scripted-serve.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const temporary: string[] = [];
const servers: RunningServe[] = [];
let errors: MockInstance<typeof console.error>;
beforeEach(() => {
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
  errors.mockRestore();
});

/** 一輪故意拖長的回覆。被中止時不會跑完。 */
const SLOW: ScriptedTurn = { content: '這一輪故意拖得很長。'.repeat(12), tokenDelayMs: 20 };
const CREATE_THEN_SLOW: readonly ScriptedTurn[] = [
  {
    content: '',
    toolCalls: [{ name: 'create_goal', args: { objective: '把藍鯨計畫做完', max_goal_rounds: 5 } }],
  },
  { content: '建好了。' },
  SLOW,
  SLOW,
  SLOW,
];

interface Layout {
  readonly home: string;
  readonly sessionLog: string;
  readonly workspace: string;
}

function layout(): Layout {
  const base = mkdtempSync(join(tmpdir(), 'nexus-goal-activation-'));
  temporary.push(base);
  const home = join(base, 'home');
  const workspace = join(base, 'workspace');
  for (const dir of [home, workspace]) mkdirSync(dir, { mode: 0o700 });
  return { home, workspace, sessionLog: join(base, 'sessions') };
}

async function start(where: Layout, turns: readonly ScriptedTurn[]): Promise<RunningServe> {
  const patch = join(where.home, `scripted-${temporary.length}-${Date.now()}.patch.yml`);
  writeFileSync(patch, scriptedPatchText(turns));
  const server = (await runServe({
    argv: [
      '--port',
      '0',
      '--workspace',
      where.workspace,
      '--session-log',
      where.sessionLog,
      '--patch',
      patch,
    ],
    log: () => undefined,
    env: { [HARNESS_HOME_ENV]: where.home },
    workspaceRootOf: () => where.workspace,
  })) as RunningServe;
  servers.push(server);
  return server;
}

/** 開一條下行，在背景一直抽、全部記下。 */
async function tap(client: WireClient, thread: string) {
  const events = await client.openEvents(thread);
  const seen: Event[] = [];
  void (async () => {
    for (;;) {
      const next = await events.next().catch(() => ({ done: true as const, value: undefined }));
      if (next.done === true) return;
      seen.push(next.value);
    }
  })();
  return { seen, stop: () => void events.return?.(undefined) };
}

interface ActivationFrame {
  readonly goal?: { readonly id: string; readonly revision: number; readonly activation: string };
}

/** 這條下行收過的 `goal/activation` frame 的酬載，依序。 */
function activations(seen: readonly Event[]): ActivationFrame[] {
  return seen
    .filter(
      (event) =>
        event.method === 'custom' &&
        (event.params.data as { name?: unknown } | null)?.name === 'goal/activation',
    )
    .map((event) => (event.params.data as unknown as { payload: ActivationFrame }).payload);
}

const states = (seen: readonly Event[]) =>
  activations(seen).map((p) => p.goal?.activation ?? '無目標');

async function until(predicate: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等不到：${what}`);
}

/** 這條 thread 現在是不是有一輪在跑：用「跑著斜線命令會被擋」這條既有的閘門當探針（`/goal` 不在放行名單上）。 */
async function isBusy(client: WireClient, thread: string): Promise<boolean> {
  const probe = await client.slashRun(thread, '/goal');
  return probe.kind === 'rejected' && probe.message.includes('這條 thread 正在跑');
}

/** 起一台、說第一句讓模型建目標；回來時下行上已經看得到 `armed`。 */
async function armed(thread: string, where = layout()) {
  const server = await start(where, CREATE_THEN_SLOW);
  const client = await serveClient(server);
  const tapped = await tap(client, thread);
  expect((await client.runStart(thread, '開個頭')).type).toBe('success');
  await until(() => states(tapped.seen).includes('armed'), '建立目標之後收到 armed');
  return { server, client, tapped, where };
}

describe('授權變了才送', () => {
  it('建立 → armed；/goal pause → disarmed；/goal resume → armed（id 不變、修訂往前）', async () => {
    const { client, tapped } = await armed('activation-edges');
    expect(await client.slashRun('activation-edges', '/goal pause')).toMatchObject({
      kind: 'success',
    });
    await until(() => states(tapped.seen).includes('disarmed'), '暫停之後收到 disarmed');
    // `disarmed` 在暫停寫下去時就送，被暫停的續行輪這時可能還沒收尾；還在跑的時候 `/goal resume` 會被擋。
    await until(async () => !(await isBusy(client, 'activation-edges')), '暫停之後閒下來');
    expect(await client.slashRun('activation-edges', '/goal resume')).toMatchObject({
      kind: 'success',
    });
    await until(() => states(tapped.seen).length >= 3, '恢復之後收到 armed');
    expect(states(tapped.seen)).toEqual(['armed', 'disarmed', 'armed']);
    const frames = activations(tapped.seen);
    expect(new Set(frames.map((frame) => frame.goal?.id)).size).toBe(1);
    const revisions = frames.map((frame) => frame.goal?.revision ?? 0);
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
    expect(revisions[2]).toBeGreaterThan(revisions[0] ?? 0);
  });

  it('按停止（收回續行授權）→ disarmed，而且目標仍是 active', async () => {
    const { client, tapped } = await armed('activation-cancel');
    await client.runCancel('activation-cancel');
    await until(() => states(tapped.seen).includes('disarmed'), '按停止之後收到 disarmed');
    expect(states(tapped.seen)).toEqual(['armed', 'disarmed']);
  });
});

describe('新接上的下行補送「現在」', () => {
  it('armed 之後才開的下行，第一顆 activation 就是 armed；暫停之後才開的就是 disarmed', async () => {
    const { client, tapped } = await armed('activation-late');
    const late = await tap(client, 'activation-late');
    await until(() => states(late.seen).length >= 1, '晚到的下行收到補送');
    expect(states(late.seen)[0]).toBe('armed');
    expect(activations(late.seen)[0]?.goal?.id).toBe(activations(tapped.seen)[0]?.goal?.id);

    await client.slashRun('activation-late', '/goal pause');
    await until(() => states(tapped.seen).includes('disarmed'), '暫停之後收到 disarmed');
    const later = await tap(client, 'activation-late');
    await until(() => states(later.seen).length >= 1, '暫停之後才開的下行收到補送');
    expect(states(later.seen)[0]).toBe('disarmed');
  });
});

describe('沒有目標就一顆都沒有', () => {
  it('從沒碰過 goal 的 thread：說一輪話，下行上沒有 goal/activation', async () => {
    const server = await start(layout(), [{ content: '你好。' }]);
    const client = await serveClient(server);
    const tapped = await tap(client, 'activation-none');
    expect((await client.runStart('activation-none', '打個招呼')).type).toBe('success');
    await until(() => tapped.seen.some((event) => event.method === 'lifecycle'), '這一輪收尾');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(activations(tapped.seen)).toEqual([]);
  });
});

describe('重啟之後（授權不持久）', () => {
  it('有目標的 thread 接回來，下行第一顆 activation 是 disarmed，id 是落盤的那個目標', async () => {
    const where = layout();
    const first = await armed('activation-restart', where);
    const goalId = activations(first.tapped.seen)[0]?.goal?.id;
    expect(goalId).toBeDefined();
    first.tapped.stop();
    await first.server.close();
    servers.splice(servers.indexOf(first.server), 1);

    const second = await start(where, CREATE_THEN_SLOW);
    const client = await serveClient(second);
    const tapped = await tap(client, 'activation-restart');
    await until(() => states(tapped.seen).length >= 1, '接回來之後收到補送');
    expect(states(tapped.seen)[0]).toBe('disarmed');
    expect(activations(tapped.seen)[0]?.goal?.id).toBe(goalId);
    // 還沒有人授權過：不會有 armed。
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(states(tapped.seen)).not.toContain('armed');
  });
});
