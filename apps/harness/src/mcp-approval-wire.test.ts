/**
 * MCP 那一列的核准宣告（[#1622](https://github.com/DemianLi/nexus-agent/issues/1622)），走產品的線：真的 `runServe`、模型換成腳本，
 * patch 插一列 MCP 連 [`mcp-fixture-server.ts`](./mcp-fixture-server.ts)。
 *
 * **量的是 server 那一側有沒有收到 `tools/call`**：夾具的兩支工具每被呼叫一次就往 `FIXTURE_CALL_LOG` 附加一行 raw name。線上的
 * 「status: failed」「沒有結果」都假得出來，server 那邊的檔假不出來。斷言 0 行之前，同一個檔裡有 B、E 證明 1 行寫得到。
 *
 * 子代理那兩格（背景回絕、前景問 root 的人）在 [`mcp-approval-subagent.test.ts`](./mcp-approval-subagent.test.ts)。設定的形狀、
 * 閘門對哪幾支回 `ask`、跟工具同進同退量在插件那一層（`packages/nexus-plugin-mcp/src/approval.test.ts`）。
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APPROVAL_POLICY_NEVER, APPROVAL_REJECTED_BY_USER } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import { publicToolName } from '@nexus/plugin-mcp';
import type { ConversationState, Event, WireClient } from '@nexus/wire';
import {
  appendDecision,
  emptyConversation,
  isApprovalPending,
  reduceConversation,
  uniformDecisions,
} from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { serveClient } from './fixtures.js';
import type { ScriptedTurn } from './scripted-model.js';
import { startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';

const SERVER = fileURLToPath(new URL('./mcp-fixture-server.ts', import.meta.url));
const HARNESS = fileURLToPath(new URL('..', import.meta.url));
const RECORD = publicToolName('crm', 'record_order');
const SEARCH = publicToolName('crm', 'orders.search');
const REASON = 'MCP server crm 的工具 record_order 要先讓人看過（設定 approval）';

const temps: string[] = [];
let served: ScriptedServe | undefined;
afterEach(async () => {
  await served?.close();
  served = undefined;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** 一列 MCP：`exempt` 免問的是 `orders.search`（raw name，public name 被補了指紋）。 */
function mcpRow(callLog: string): string {
  return `- insert:
    - id: mcp-crm
      name: '@nexus/plugin-mcp'
      config:
        serverName: crm
        connection:
          transport: stdio
          command: ${JSON.stringify(process.execPath)}
          args: ['--import', 'tsx', ${JSON.stringify(SERVER)}]
          cwd: ${JSON.stringify(HARNESS)}
          env: { FIXTURE_CALL_LOG: ${JSON.stringify(callLog)} }
        approval:
          exempt: ['orders.search']
`;
}

/** 把出廠的權限組表換成一組核准是 `never` 的，起始就是它（出廠兩組的核准都是 `ask`）。 */
const NEVER_PRESET = `- id: permission-presets
  config:
    presets:
      locked: { sandbox: workspace-write, approval: never }
    defaultPreset: locked
`;

interface Session {
  readonly client: WireClient;
  readonly events: AsyncGenerator<Event, void, undefined>;
  readonly thread: string;
  /** server 收到的 `tools/call`，一行一支 raw name。 */
  calls(): string[];
  /** root 日誌。 */
  log(): SessionEvent[];
  state: ConversationState;
}

async function open(
  turns: readonly ScriptedTurn[],
  extra = '',
  argv: readonly string[] = [],
  thread = 'crm',
): Promise<Session> {
  const callLog = join(temp('nexus-mcp-calls-'), 'calls.log');
  const logs = temp('nexus-mcp-approval-logs-');
  served = await startScriptedServe(turns, {
    extraRows: mcpRow(callLog) + extra,
    argv: ['--session-log', logs, ...argv],
  });
  const client = await serveClient(served.running);
  const events = await client.openEvents(thread);
  await client.runStart(thread, '幫我處理訂單');
  return {
    client,
    events,
    thread,
    state: emptyConversation(),
    calls: () =>
      existsSync(callLog) ? readFileSync(callLog, 'utf8').split('\n').filter(Boolean) : [],
    log: () => {
      const [project] = readdirSync(logs);
      return readFileSync(join(logs, project!, `${thread}.jsonl`), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as SessionEvent);
    },
  };
}

async function until(session: Session, done: (state: ConversationState) => boolean): Promise<void> {
  while (!done(session.state)) {
    const next = await session.events.next();
    if (next.done === true) throw new Error('下行斷了，還沒走到');
    session.state = reduceConversation(session.state, next.value);
  }
}

const awaitingApproval = (state: ConversationState): boolean =>
  state.status === 'awaiting-input' && state.pendings.some(isApprovalPending);

/** 模型講完 n 輪話、閒下來。中斷那一輪也會 idle，所以數輪數，同 `submit-record-wire.test.ts`。 */
const settledAfter =
  (turns: number) =>
  (state: ConversationState): boolean =>
    state.status === 'idle' &&
    state.entries.filter((entry) => entry.kind === 'ai' && !entry.streaming).length >= turns;

/**
 * A、E 等的終點：停在核准卡，**或**跑完兩輪。只等其中一個的話，走錯那條路（該問沒問、該放沒放）時要等到逾時才紅；
 * 兩個都收，錯的那條路走到底就停下來，由後面的斷言當場講出是哪一條。
 */
const askedOrSettled = (state: ConversationState): boolean =>
  awaitingApproval(state) || settledAfter(2)(state);

function toolEntry(state: ConversationState, name: string) {
  const entry = state.entries.find((each) => each.kind === 'tool' && each.name === name);
  if (entry?.kind !== 'tool') throw new Error(`沒有 ${name} 的工具卡`);
  return entry;
}

async function decide(session: Session, type: 'approve' | 'reject'): Promise<void> {
  const approval = session.state.pendings.find(isApprovalPending)!;
  session.state = appendDecision(session.state, approval.interruptId, type);
  await session.client.inputRespond(session.thread, {
    namespace: [...approval.namespace],
    interrupt_id: approval.interruptId,
    response: uniformDecisions(approval, type),
  });
}

const callRecord: ScriptedTurn = {
  content: '登記。',
  toolCalls: [{ name: RECORD, args: { item: '螺絲' } }],
};
const callSearch: ScriptedTurn = {
  content: '先查。',
  toolCalls: [{ name: SEARCH, args: { query: '螺絲' } }],
};
const done: ScriptedTurn = { content: '收工。' };

describe('宣告要問的工具', () => {
  it('A：核准前停在核准卡，理由帶 server 名與 raw name；server 一次都沒收到', async () => {
    const session = await open([callRecord, done]);
    await until(session, askedOrSettled);

    expect(session.calls()).toEqual([]);
    const approval = session.state.pendings.find(isApprovalPending)!;
    expect(approval.actions).toEqual([
      { name: RECORD, args: { item: '螺絲' }, description: REASON, callId: expect.any(String) },
    ]);
    // 線上先看到核准卡，日誌稍後才落盤：等到那一筆寫進去再比。
    await expect
      .poll(() => session.log().map((event) => event.type), { timeout: 10_000 })
      .toContain('approval/asked');
    expect(session.log().map((event) => event.type)).toContain('interrupt/raised');
    expect(session.log().find((event) => event.type === 'approval/asked')?.data).toMatchObject({
      toolName: RECORD,
      reason: REASON,
    });
  }, 30_000);

  it('B：按允許，server 收到一次，工具成功', async () => {
    const session = await open([callRecord, done]);
    await until(session, awaitingApproval);
    await decide(session, 'approve');
    await until(session, settledAfter(2));

    expect(session.calls()).toEqual(['record_order']);
    const entry = toolEntry(session.state, RECORD);
    expect(entry.status).toBe('done');
    expect(entry.errorCode).toBeUndefined();
    expect(entry.text).toContain('已登記：螺絲');
  }, 30_000);

  it('C：按不允許，server 一次都沒收到，碼是 APPROVAL_REJECTED_BY_USER', async () => {
    const session = await open([callRecord, done]);
    await until(session, awaitingApproval);
    await decide(session, 'reject');
    await until(session, settledAfter(2));

    expect(session.calls()).toEqual([]);
    expect(toolEntry(session.state, RECORD).errorCode).toBe(APPROVAL_REJECTED_BY_USER);
  }, 30_000);

  it('D：不答、再送一句話——只排進下一輪，那一筆沒有被放行', async () => {
    const session = await open([callRecord, done]);
    await until(session, awaitingApproval);
    await session.client.runStart(session.thread, '先等一下');

    const spliced = (): SessionEvent | undefined =>
      session
        .log()
        .find(
          (event) =>
            event.type === 'inbox/spliced' &&
            event.data.inserted.some((item) => item.text === '先等一下'),
        );
    await expect.poll(spliced, { timeout: 10_000 }).toBeDefined();
    expect(spliced()?.data).toMatchObject({ target: 'next-turn' });
    // 那一筆沒有被放行：核准之後沒有結果，也沒有開新的一輪。
    const log = session.log();
    const asked = log.findIndex((event) => event.type === 'approval/asked');
    expect(log.slice(asked).map((event) => event.type)).not.toContain('tool/result');
    expect(log.slice(asked).map((event) => event.type)).not.toContain('turn/start');
    expect(session.calls()).toEqual([]);
    expect(session.state.pendings.some(isApprovalPending)).toBe(true);
  }, 30_000);
});

describe('對照組與政策', () => {
  it('E：exempt 裡的那一支（raw name，public name 被補了指紋）不問、直接跑，server 收到一次', async () => {
    expect(SEARCH).not.toBe('mcp__crm__orders.search');
    const session = await open([callSearch, done]);
    await until(session, askedOrSettled);

    expect(session.state.pendings).toEqual([]);
    expect(session.calls()).toEqual(['orders.search']);
    expect(toolEntry(session.state, SEARCH).status).toBe('done');
    expect(session.log().some((event) => event.type === 'approval/asked')).toBe(false);
  }, 30_000);

  it('F：核准政策是 never：不發中斷、碼 APPROVAL_POLICY_NEVER，server 一次都沒收到', async () => {
    // 權限組只在有圍堵時生效（`--workspace`），沒有就不釘政策。
    const session = await open([callRecord, done], NEVER_PRESET, [
      '--workspace',
      temp('nexus-mcp-workspace-'),
    ]);
    await until(session, settledAfter(2));

    expect(session.state.pendings).toEqual([]);
    expect(session.calls()).toEqual([]);
    expect(toolEntry(session.state, RECORD).errorCode).toBe(APPROVAL_POLICY_NEVER);
    // 量的確實是 never 那一格：起始政策記在日誌上（日誌稍後才落盤，等到收尾那一筆再比）。
    await expect
      .poll(() => session.log().map((event) => event.type), { timeout: 10_000 })
      .toContain('turn/end');
    expect(
      session
        .log()
        .filter((event) => event.type === 'approval/policy')
        .map((event) => event.data),
    ).toEqual([{ policy: 'never' }]);
    expect(session.log().some((event) => event.type === 'interrupt/raised')).toBe(false);
  }, 30_000);
});
