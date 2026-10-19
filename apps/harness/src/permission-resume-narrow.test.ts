/**
 * **續接時收回超出權限表的沙箱模式**——[#1621](https://github.com/DemianLi/nexus-agent/issues/1621) 第 2 步（Q2 (b)）的驗收 D、E。
 *
 * 出廠表沒有 `danger-full-access`（第 1 步）之後，使用者切不到全開；但**升級前已經切到全開的會話**，日誌最後一顆 `sandbox/mode` 還是全開，
 * 續接時控制器從日誌起算，照舊全開。這一步：會話接上時，若日誌記的沙箱模式**比表裡每一組都寬**，權限組合的會話參與者往 root 日誌切到預設組
 * （`permission/preset` → `sandbox/mode` → `approval/policy`，只寫真的變了的），server 日誌（CLI 是標準錯誤）留一行話。
 *
 * **比的是基準，不是絕對筆數**（卡上驗收 D）：每次接上，沙箱與核准的參與者本來就各釘一顆（`approval/policy`、`sandbox/mode`），所以每一格都先算
 * 「沒有第 2 步時這份日誌接上會多什麼」（兩顆釘子，加上對得上某一組時的 `permission/preset`），再斷言第 2 步**正好**多出哪幾顆。
 *
 * 三層：
 * - **組裝**（`createCliAgent` ＋ `attachSession`）：事件的順序與數量、投影、`permissionNarrowed`。
 * - **serve／CLI**：真的 `runServe` 兩台、真的 `runCli --resume`：warn 那一行、web 看到的投影、下一次寫檔的 fence。
 * - **寬窄序**：插件自己放一份（不 import `@nexus/plugin-sandbox-policy`），對照 `WIDER_MODES` 釘住。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import type { SessionEvent } from '@nexus/core';
import { isSandboxWider } from '@nexus/plugin-permission-presets';
import { isStrictlyWider } from '@nexus/plugin-sandbox-policy';
import { PERMISSIONS_PROJECTION_KEY } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { runCli } from './cli.js';
import {
  foldTurn,
  FULL_ACCESS_PATCH,
  serveClient,
  shippedPlugins,
  shippedPluginsWithConfig,
  shippedPluginsWithFullAccess,
} from './fixtures.js';
import { scriptedPatchText } from './scripted-serve.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const shipped = await shippedPlugins();
const withFullAccess = await shippedPluginsWithFullAccess();
/** 部署方把 `read-only` 從表裡刪掉（`presets` 是整份替換，只留 `workspace-write`）。 */
const withoutReadOnly = await shippedPluginsWithConfig('permission-presets', {
  presets: { 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' } },
});
/** 部署方設了 `defaultPreset: read-only`。 */
const defaultReadOnly = await shippedPluginsWithConfig('permission-presets', {
  defaultPreset: 'read-only',
});

const temporary: string[] = [];
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexus-permission-narrow-'));
  temporary.push(root);
});
afterEach(async () => {
  await running?.close();
  running = undefined;
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let running: RunningServe | undefined;

type Mode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** 用「續接」的形狀接上一份記著 `sandbox`／`approval` 的日誌（兩條產品路徑的續接把 `approvalPolicy` 給滿），回接上之後的事件與投影。 */
async function resume(
  sandbox: Mode,
  approvalPolicy: 'ask' | 'never',
  plugins: typeof shipped,
): Promise<{
  readonly types: readonly string[];
  readonly events: readonly SessionEvent[];
  readonly preset: unknown;
  readonly narrowed: unknown;
}> {
  const built = await createCliAgent(
    { live: false, workspace: root, sandbox, approvalPolicy },
    plugins,
    root,
  );
  const detach = built.attachSession(built.sessions);
  try {
    const events = [...built.sessionLog.events];
    const unit = built.projections
      .list()
      .find((candidate) => candidate.key === PERMISSIONS_PROJECTION_KEY) as unknown as
      | {
          init(): unknown;
          apply(state: unknown, event: SessionEvent): unknown;
          view(state: unknown): { currentValue: string };
        }
      | undefined;
    const preset = unit?.view(
      events.reduce((state, event) => unit.apply(state, event), unit.init()),
    ).currentValue;
    return {
      types: events.map((event) => event.type),
      events,
      preset,
      narrowed: built.permissionNarrowed,
    };
  } finally {
    detach();
    await built.dispose();
  }
}

const dataOf = (events: readonly SessionEvent[], type: string): unknown[] =>
  events.filter((event) => event.type === type).map((event) => event.data);

describe('D：收回（組裝層，事件逐顆釘）', () => {
  it('全開＋不問的舊日誌、出廠表：比「沒有第 2 步」正好多出 permission/preset → sandbox/mode → approval/policy 三顆，推出預設組', async () => {
    // 基準：同一份日誌、部署方把全開加回（不收）→ 只有兩顆釘子，加上對得上全開那一組的 `permission/preset`。
    const baseline = await resume('danger-full-access', 'never', withFullAccess);
    expect(baseline.types).toEqual(['approval/policy', 'sandbox/mode', 'permission/preset']);

    const narrowed = await resume('danger-full-access', 'never', shipped);
    // 出廠表裡全開對不上任何一組，沒有第 2 步時這一輪只有兩顆釘子（`custom` 不釘 `permission/preset`）。
    expect(narrowed.types.slice(0, 2)).toEqual(['approval/policy', 'sandbox/mode']);
    // 第 2 步**正好**多出三顆，順序照 `/permission`。
    expect(narrowed.types.slice(2)).toStrictEqual([
      'permission/preset',
      'sandbox/mode',
      'approval/policy',
    ]);
    expect(narrowed.events.slice(2).map((event) => event.data)).toStrictEqual([
      { preset: 'workspace-write' },
      { mode: 'workspace-write' },
      { policy: 'ask' },
    ]);
    expect(narrowed.preset).toBe('workspace-write');
    expect(narrowed.narrowed).toStrictEqual({
      preset: 'workspace-write',
      fromSandbox: 'danger-full-access',
      fromApproval: 'never',
      toSandbox: 'workspace-write',
      toApproval: 'ask',
    });
  });

  it('#437 以前的日誌（全開配 ask）：核准本來就是 ask，只多 permission/preset 與 sandbox/mode 兩顆，核准不重寫', async () => {
    const result = await resume('danger-full-access', 'ask', shipped);
    expect(result.types).toEqual([
      'approval/policy',
      'sandbox/mode',
      'permission/preset',
      'sandbox/mode',
    ]);
    expect(dataOf(result.events, 'approval/policy')).toStrictEqual([{ policy: 'ask' }]);
    expect(result.preset).toBe('workspace-write');
  });

  it('部署方把全開加回：不比表裡最寬的寬，第 2 步不多任何事件，仍是全開', async () => {
    const result = await resume('danger-full-access', 'never', withFullAccess);
    expect(result.types).toEqual(['approval/policy', 'sandbox/mode', 'permission/preset']);
    expect(result.preset).toBe('danger-full-access');
    expect(result.narrowed).toBeUndefined();
  });

  it('停在 read-only、表裡刪掉 read-only：比 workspace-write 窄，不能被收成 workspace-write——不多任何事件，仍是 custom', async () => {
    const result = await resume('read-only', 'ask', withoutReadOnly);
    // 沒有第 2 步時也是這兩顆釘子；`custom` 不釘 `permission/preset`。
    expect(result.types).toEqual(['approval/policy', 'sandbox/mode']);
    expect(result.preset).toBe('custom');
    expect(result.narrowed).toBeUndefined();
  });

  it('停在 workspace-write 的一般日誌：不多任何事件', async () => {
    const result = await resume('workspace-write', 'ask', shipped);
    expect(result.types).toEqual(['approval/policy', 'sandbox/mode', 'permission/preset']);
    expect(result.preset).toBe('workspace-write');
    expect(result.narrowed).toBeUndefined();
  });

  it('部署方設了 defaultPreset：收到那一組，不是表裡最寬的', async () => {
    const result = await resume('danger-full-access', 'never', defaultReadOnly);
    expect(result.events.slice(2).map((event) => event.data)).toStrictEqual([
      { preset: 'read-only' },
      { mode: 'read-only' },
      { policy: 'ask' },
    ]);
    expect(result.preset).toBe('read-only');
  });

  it('新會話（沒有續接）不受影響：--sandbox 沒給全開，不會有收回', async () => {
    const built = await createCliAgent({ live: false, workspace: root }, shipped, root);
    const detach = built.attachSession(built.sessions);
    try {
      expect(built.permissionNarrowed).toBeUndefined();
      expect(dataOf(built.sessionLog.events, 'permission/preset')).toStrictEqual([
        { preset: 'workspace-write' },
      ]);
    } finally {
      detach();
      await built.dispose();
    }
  });
});

describe('寬窄序：插件自己放一份，對照 sandbox-policy 的 isStrictlyWider（WIDER_MODES）', () => {
  const modes: Mode[] = ['read-only', 'workspace-write', 'danger-full-access'];

  it.each(modes.flatMap((a) => modes.map((b) => [a, b] as const)))(
    '%s 比 %s 寬嗎：與 isStrictlyWider 一致',
    (a, b) => {
      expect(isSandboxWider(a, b)).toBe(isStrictlyWider(b, a));
    },
  );
});

describe('E：serve 兩台、CLI --resume 的 warn 與下一次寫檔的 fence', () => {
  /** 起一台 serve，收伺服器日誌。 */
  async function serve(
    home: string,
    workspace: string,
    extra: readonly string[],
    lines: string[],
  ): Promise<RunningServe> {
    const server = (await runServe({
      argv: ['--port', '0', '--session-log', home, '--workspace', workspace, ...extra],
      log: (line) => void lines.push(line),
      env: {},
    })) as RunningServe;
    running = server;
    return server;
  }

  async function switchedToFullAccess(home: string, workspace: string): Promise<void> {
    const before = await serve(home, workspace, ['--patch', FULL_ACCESS_PATCH], []);
    const client = await serveClient(before);
    expect(await client.slashRun('t', '/permission danger-full-access')).toMatchObject({
      kind: 'success',
    });
    await before.close();
    running = undefined;
  }

  it('升級前切到全開的會話、升級後沒加回：續接收回預設組，server 日誌留一行，下一次權限選單看到預設組', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nexus-narrow-home-'));
    const workspace = mkdtempSync(join(tmpdir(), 'nexus-narrow-ws-'));
    temporary.push(home, workspace);
    await switchedToFullAccess(home, workspace);

    const lines: string[] = [];
    const after = await serve(home, workspace, [], lines);
    const client = await serveClient(after);
    // 要開了這條 thread 才組裝、才接日誌。
    const outcome = await client.threadHistory('t');
    expect(outcome.kind).toBe('ok');
    const warns = lines.filter((line) => line.includes('[權限]'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('thread "t"');
    expect(warns[0]).toContain('danger-full-access');
    expect(warns[0]).toContain('workspace-write');
    // 使用者看到的是權限座回到預設組；切不回全開。
    expect(await client.slashRun('t', '/permission')).toMatchObject({
      kind: 'success',
      text: expect.stringContaining('目前的權限組合：workspace-write'),
    });
    expect(await client.slashRun('t', '/permission danger-full-access')).toMatchObject({
      kind: 'error',
    });
  });

  it('部署方加回全開：續接仍是全開，也沒有那一行', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nexus-narrow-home-'));
    const workspace = mkdtempSync(join(tmpdir(), 'nexus-narrow-ws-'));
    temporary.push(home, workspace);
    await switchedToFullAccess(home, workspace);

    const lines: string[] = [];
    const after = await serve(home, workspace, ['--patch', FULL_ACCESS_PATCH], lines);
    const client = await serveClient(after);
    await client.threadHistory('t');
    expect(lines.filter((line) => line.includes('[權限]'))).toEqual([]);
    expect(await client.slashRun('t', '/permission')).toMatchObject({
      text: expect.stringContaining('目前的權限組合：danger-full-access'),
    });
  });

  it('下一次寫檔照預設組的 fence 判：經符號連結寫到工作區外，收回後被擋；對照組（加回全開）寫得出去', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nexus-narrow-home-'));
    const workspace = mkdtempSync(join(tmpdir(), 'nexus-narrow-ws-'));
    const outside = mkdtempSync(join(tmpdir(), 'nexus-narrow-outside-'));
    temporary.push(home, workspace, outside);
    // 工作區裡本來就有往外指的連結（出廠沒有 shell，模型自己做不出連結）。
    symlinkSync(outside, join(workspace, 'escape'));
    mkdirSync(join(workspace, 'inside'));
    const patch = join(home, 'scripted.patch.yml');
    writeFileSync(
      patch,
      scriptedPatchText([
        {
          content: '',
          toolCalls: [
            { name: 'write_file', args: { file_path: '/escape/note.txt', content: '寫到外面' } },
          ],
        },
        { content: '好。' },
      ]),
    );
    await switchedToFullAccess(home, workspace);
    const target = join(outside, 'note.txt');

    // 對照在前：部署方加回全開，同一份日誌、同一個呼叫寫得出去（不是這個環境本來就寫不了）。
    // 對照要排在前面：收回會把 workspace-write 寫進日誌，之後再加回全開也回不去了。
    const kept = await serve(home, workspace, ['--patch', FULL_ACCESS_PATCH, '--patch', patch], []);
    const keptClient = await serveClient(kept);
    const keptEvents = await keptClient.openEvents('t');
    expect((await keptClient.runStart('t', '再寫一個檔')).type).not.toBe('error');
    await foldTurn(keptEvents);
    await keptEvents.return?.(undefined);
    expect(existsSync(target)).toBe(true);
    await kept.close();
    running = undefined;
    rmSync(target);

    // 沒加回：收回 workspace-write，符號連結寫不出去。
    const narrowed = await serve(home, workspace, ['--patch', patch], []);
    const client = await serveClient(narrowed);
    const events = await client.openEvents('t');
    expect((await client.runStart('t', '寫一個檔')).type).not.toBe('error');
    await foldTurn(events);
    await events.return?.(undefined);
    expect(existsSync(target)).toBe(false);
  }, 120000);

  it('CLI --resume：標準錯誤留一行 [權限]；加回全開時沒有', async () => {
    const logs = await mkdtemp(join(tmpdir(), 'nexus-narrow-cli-logs-'));
    const workspace = mkdtempSync(join(tmpdir(), 'nexus-narrow-cli-ws-'));
    temporary.push(logs, workspace);

    async function cli(argv: readonly string[], lines: string): Promise<string[]> {
      const errors: string[] = [];
      const input = new PassThrough();
      input.end(lines);
      await runCli({
        argv,
        input,
        output: new PassThrough(),
        printer: { log: () => undefined, error: (line) => void errors.push(line) },
      });
      return errors;
    }

    // 第一個行程：加回全開、`--sandbox danger-full-access` 起，日誌最後記著全開。
    await cli(
      [
        '--workspace',
        workspace,
        '--sandbox',
        'danger-full-access',
        '--patch',
        FULL_ACCESS_PATCH,
        '--session-log',
        logs,
      ],
      '嗨\n/exit\n',
    );
    const [entry] = await readdir(logs);
    expect(entry).toBeDefined();
    const file = join(logs, entry!);

    const narrowed = await cli(['--workspace', workspace, '--resume', file], '嗨\n/exit\n');
    const lines = narrowed.filter((line) => line.includes('[權限]'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('danger-full-access');
    expect(lines[0]).toContain('workspace-write');

    const kept = await cli(
      ['--workspace', workspace, '--patch', FULL_ACCESS_PATCH, '--resume', file],
      '嗨\n/exit\n',
    );
    expect(kept.filter((line) => line.includes('[權限]'))).toEqual([]);
  }, 120000);
});
