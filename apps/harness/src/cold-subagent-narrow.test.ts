/**
 * **冷復活的背景子代理把比權限表寬的沙箱收回預設組**——[#1739](https://github.com/DemianLi/nexus-agent/issues/1739) 的驗收，
 * 走真的復活路徑：兩台真的 `runServe`（同一個 home、同一份 `--session-log`），第一台派背景子代理、跑到 idle、收掉；
 * 部署方把全開那一組從表裡拿掉；第二台對舊編號送話 → `BackgroundSubagentHost.#round → #enter → delegateFromLog`。
 *
 * **量的是 fence 的實際行為，不是日誌上的字**：workspace 裡放一條指到工作區外的 symlink，子代理的腳本去寫 `/link/…`——
 * `danger-full-access` 放行 symlink 逃逸、`workspace-write` 不放行（`contained-backend.ts`）；再寫一個工作區內的檔，量 `read-only`。
 *
 * 四格（同一份腳本）：
 * - **收窄（出廠預設）**：表只剩 read-only／workspace-write，無 `defaultPreset` → 收到最寬的那一組 workspace-write。
 * - **收窄（defaultPreset: read-only）**：收到設定的那一組。
 * - **對照（全開還在表裡）**：不收，逃逸寫得進去——沒有這一格，上面兩格的「沒寫進去」分不出是收窄還是別的原因。
 * - **R2（不多寫、不改寫）**：三格的子代理日誌，`sandbox/mode`／`permission/preset`／`approval/policy` 三種事件在叫醒前後逐顆相同。
 *
 * 另外：warn 一個子代理一個行程一行（送兩次話）；叫升級仍被拒（子代理拿不到 root 的 grant）。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SANDBOX_ESCALATION_TOOL_NAME } from '@nexus/plugin-sandbox-policy';
import { afterEach, describe, expect, it } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { changePlugin } from './plugin-change.js';
import type { ScriptedTurn } from './scripted-model.js';
import { scriptedPatchText } from './scripted-serve.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const temporary: string[] = [];
let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const READ_ONLY = { sandbox: 'read-only', approval: 'ask' } as const;
const WORKSPACE_WRITE = { sandbox: 'workspace-write', approval: 'ask' } as const;
const FULL_ACCESS = { sandbox: 'danger-full-access', approval: 'never' } as const;

/** 第一台的表：全開還在。 */
const WITH_FULL_ACCESS = {
  presets: {
    'read-only': READ_ONLY,
    'workspace-write': WORKSPACE_WRITE,
    'danger-full-access': FULL_ACCESS,
  },
};
/** 部署方事後把全開拿掉（出廠的形狀）。 */
const WITHOUT_FULL_ACCESS = {
  presets: { 'read-only': READ_ONLY, 'workspace-write': WORKSPACE_WRITE },
};

/** 第一台：根對話派一個背景子代理，子代理一輪做完。 */
const DISPATCH_TURNS: readonly ScriptedTurn[] = [
  {
    content: '委派。',
    toolCalls: [
      {
        name: 'subagent',
        args: { description: '幹活', subagent_type: 'general-purpose', run_in_background: true },
      },
    ],
  },
  { content: '子代理做完了。' },
  { content: '收到。' },
];

/** 第二台：被叫醒的子代理依序試三件事，然後收尾；第二次送話只回一句。 */
const WAKE_TURNS: readonly ScriptedTurn[] = [
  {
    content: '',
    toolCalls: [{ name: 'write_file', args: { file_path: '/link/escaped.txt', content: '逃' } }],
  },
  {
    content: '',
    toolCalls: [{ name: 'write_file', args: { file_path: '/inside.txt', content: '內' } }],
  },
  {
    content: '',
    toolCalls: [
      {
        name: SANDBOX_ESCALATION_TOOL_NAME,
        args: {
          file_path: '/link/escalated.txt',
          sandbox_permissions: 'danger-full-access',
          justification: '要寫這個檔',
        },
      },
    ],
  },
  { content: '第一輪完成。' },
  { content: '第二輪完成。' },
  { content: '備用。' },
];

interface Layout {
  readonly home: string;
  readonly workspace: string;
  readonly outside: string;
  readonly sessionLog: string;
  readonly env: Record<string, string>;
}

function layout(): Layout {
  const base = mkdtempSync(join(tmpdir(), 'nexus-cold-narrow-'));
  temporary.push(base);
  const home = join(base, 'home');
  const workspace = join(base, 'workspace');
  const outside = join(base, 'outside');
  for (const dir of [home, workspace, outside]) mkdirSync(dir, { mode: 0o700 });
  symlinkSync(outside, join(workspace, 'link'));
  return {
    home,
    workspace,
    outside,
    sessionLog: join(base, 'sessions'),
    env: { [HARNESS_HOME_ENV]: home },
  };
}

async function startServe(
  where: Layout,
  turns: readonly ScriptedTurn[],
  lines: string[],
): Promise<RunningServe> {
  const patch = join(where.home, `scripted-${temporary.length}-${Date.now()}.patch.yml`);
  writeFileSync(patch, scriptedPatchText(turns));
  return (await runServe({
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
    log: (line) => void lines.push(line),
    env: where.env,
  })) as RunningServe;
}

interface LoggedEvent {
  readonly type: string;
  readonly data: unknown;
}

/** 子代理那份日誌：等到至少 `turnEnds` 顆 `turn/end` 才回。 */
async function subagentLog(
  sessionLog: string,
  thread: string,
  turnEnds: number,
): Promise<{ runId: string; events: LoggedEvent[] }> {
  for (let tries = 0; tries < 800; tries += 1) {
    const [project] = readdirSync(sessionLog);
    const directory = join(sessionLog, project ?? '');
    const body = readdirSync(directory).find(
      (name) => name.startsWith(`${thread}%2fbg-`) && name.endsWith('.jsonl'),
    );
    if (body !== undefined) {
      const events = readFileSync(join(directory, body), 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as LoggedEvent);
      if (events.filter((event) => event.type === 'turn/end').length >= turnEnds) {
        return { runId: body.slice(`${thread}%2f`.length, -'.jsonl'.length), events };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('子代理的日誌等太久了');
}

/** 三種「會移動 fence 的」事件，依序（含資料）。 */
const FENCE_EVENTS = new Set(['sandbox/mode', 'permission/preset', 'approval/policy']);
const fenceEvents = (events: readonly LoggedEvent[]): LoggedEvent[] =>
  events.filter((event) => FENCE_EVENTS.has(event.type));

/** 第一台：根切到全開、派一個背景子代理、跑到 idle、收掉。 */
async function firstProcess(where: Layout): Promise<{
  runId: string;
  before: LoggedEvent[];
  lines: string[];
}> {
  const lines: string[] = [];
  await changePlugin(
    { op: 'config-set', id: 'permission-presets', config: WITH_FULL_ACCESS },
    { env: where.env },
  );
  running = await startServe(where, DISPATCH_TURNS, lines);
  const client = await serveClient(running);
  expect(await client.slashRun('a', '/permission danger-full-access')).toMatchObject({
    kind: 'success',
  });
  const events = await client.openEvents('a');
  await client.runStart('a', '請派一個子代理');
  await foldTurn(events);
  await events.return?.(undefined);
  const { runId, events: before } = await subagentLog(where.sessionLog, 'a', 1);
  await running.close();
  running = undefined;
  return { runId, before, lines };
}

/** 第二台起來之後對舊編號送兩次話（兩輪），回第二台的 server 日誌與叫醒之後的子代理日誌。 */
async function secondProcess(
  where: Layout,
  table: Record<string, unknown>,
  runId: string,
): Promise<{ lines: string[]; events: LoggedEvent[] }> {
  const lines: string[] = [];
  await changePlugin(
    { op: 'config-set', id: 'permission-presets', config: table },
    { env: where.env },
  );
  running = await startServe(where, WAKE_TURNS, lines);
  const client = await serveClient(running);
  expect(await client.subagentSend('a', runId, '第一句')).toMatchObject({ type: 'success' });
  await subagentLog(where.sessionLog, 'a', 2);
  expect(await client.subagentSend('a', runId, '第二句')).toMatchObject({ type: 'success' });
  const { events } = await subagentLog(where.sessionLog, 'a', 3);
  await running.close();
  running = undefined;
  // 腳本沒吃光、兩輪都正常收尾（沒有 turn/failed 混進來把「等第三顆 turn/end」騙過去）。
  expect(events.filter((event) => event.type === 'turn/failed')).toEqual([]);
  return { lines, events };
}

const DELEGATION_WARNING = /背景子代理 \S+ 的委派快照/;

describe('冷復活的背景子代理，委派快照比權限表裡每一組都寬（#1739）', () => {
  it('出廠預設：全開被拿掉之後叫醒，收回 workspace-write——逃逸寫不進去、工作區內寫得進去、叫升級仍被拒；warn 一行；日誌不動', async () => {
    const where = layout();
    const first = await firstProcess(where);
    // 派出那一刻子代理的日誌記的是全開（委派快照），而且沒有 warn：表裡有全開，不收。
    expect(first.before.find((event) => event.type === 'sandbox/mode')?.data).toEqual({
      mode: 'danger-full-access',
      source: 'delegation',
    });
    expect(first.lines.filter((line) => DELEGATION_WARNING.test(line))).toEqual([]);

    const second = await secondProcess(where, WITHOUT_FULL_ACCESS, first.runId);

    expect(existsSync(join(where.outside, 'escaped.txt'))).toBe(false);
    expect(existsSync(join(where.workspace, 'inside.txt'))).toBe(true);
    expect(existsSync(join(where.outside, 'escalated.txt'))).toBe(false);
    const escalation = second.events.find(
      (event) =>
        event.type === 'tool/result' && (event.data as { callId?: string }).callId === 'call_3_0',
    );
    expect(escalation?.data).toMatchObject({ isError: true });
    expect(JSON.stringify(escalation?.data)).toContain('子代理拿不到升級的核准');
    // 兩輪、warn 只有一行，講清楚從哪一格收到哪一格。
    const warnings = second.lines.filter((line) => DELEGATION_WARNING.test(line));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('danger-full-access');
    expect(warnings[0]).toContain('workspace-write');
    // R2：fence 相關的三種事件，叫醒前後逐顆相同（既沒多寫、也沒改寫）。
    expect(fenceEvents(second.events)).toEqual(fenceEvents(first.before));
  }, 120000);

  it('defaultPreset: read-only：收到設定的那一組——工作區內也寫不進去', async () => {
    const where = layout();
    const first = await firstProcess(where);
    const second = await secondProcess(
      where,
      { ...WITHOUT_FULL_ACCESS, defaultPreset: 'read-only' },
      first.runId,
    );

    expect(existsSync(join(where.outside, 'escaped.txt'))).toBe(false);
    expect(existsSync(join(where.workspace, 'inside.txt'))).toBe(false);
    const warnings = second.lines.filter((line) => DELEGATION_WARNING.test(line));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('read-only');
    expect(fenceEvents(second.events)).toEqual(fenceEvents(first.before));
  }, 120000);

  it('對照：全開還在表裡就不收——同一份腳本逃逸寫得進去，沒有 warn（上面兩格的「寫不進去」因此是收窄造成的）', async () => {
    const where = layout();
    const first = await firstProcess(where);
    const second = await secondProcess(where, WITH_FULL_ACCESS, first.runId);

    expect(existsSync(join(where.outside, 'escaped.txt'))).toBe(true);
    expect(existsSync(join(where.workspace, 'inside.txt'))).toBe(true);
    expect(second.lines.filter((line) => DELEGATION_WARNING.test(line))).toEqual([]);
    expect(fenceEvents(second.events)).toEqual(fenceEvents(first.before));
  }, 120000);
});
