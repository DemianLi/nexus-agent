/**
 * 在工具本體裡問人的生產者，走 serve（帶 thread 的 `streamEvents`）時兩個 loop 一樣：停在問題上、答了接回、拒絕照拒絕收
 * （[#2358](https://github.com/DemianLi/nexus-agent/issues/2358)）。沙箱升級的核准與拒絕、plan-mode 的「繼續規劃」。
 *
 * **零憑證、零外部連線**：模型是腳本。
 */

import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SessionEvent } from '@nexus/core';
import {
  EXIT_PLAN_MODE_TOOL_NAME,
  PLAN_KEEP_PLANNING_LABEL,
  PLAN_KEEP_PLANNING_MESSAGE,
  PLAN_REVIEW_QUESTION_ID,
} from '@nexus/plugin-plan-mode';
import { rejectedRefusal, SANDBOX_ESCALATION_TOOL_NAME } from '@nexus/plugin-sandbox-policy';
import type { ConversationState, Event } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
import { startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';
import type { ScriptedTurn } from './scripted-model.js';
import { sessionEventsOf } from './session-files.fixture.js';

const LOOPS = ['langgraph', 'native'] as const;

let serve: ScriptedServe | undefined;

afterEach(async () => {
  await serve?.close();
  serve = undefined;
});

interface Outcome {
  readonly parked: ConversationState;
  readonly done: ConversationState;
  readonly log: SessionEvent[];
}

/**
 * 起一台 serve，`before` 之後送一句、停在問題上、用 `respond` 答，跑到收完，回兩段的線上狀態與落盤的日誌。
 * @param loop - `--agent-loop`。
 * @param turns - 腳本。
 * @param respond - 答覆的 `response`。
 * @param options - `argv` 接在後面的旗標；`workspace` 是 `--workspace` 也是每條 thread 的可寫根；`before` 在送那一句之前做。
 */
async function parkAndRespond(
  loop: (typeof LOOPS)[number],
  turns: readonly ScriptedTurn[],
  respond: unknown,
  options: {
    readonly argv?: readonly string[];
    readonly workspace?: string;
    readonly before?: (client: Awaited<ReturnType<typeof serveClient>>, thread: string) => Promise<void>;
  } = {},
): Promise<Outcome> {
  const logs = await mkdtemp(join(tmpdir(), 'nexus-producer-wire-logs-'));
  const thread = `producer-${loop}`;
  const workspace = options.workspace;
  serve = await startScriptedServe(turns, {
    ...(workspace !== undefined && { workspace, workspaceRootOf: () => workspace }),
    argv: ['--agent-loop', loop, '--session-log', logs, ...(options.argv ?? [])],
  });
  try {
    const client = await serveClient(serve.running);
    const events: AsyncIterator<Event> = await client.openEvents(thread);
    await options.before?.(client, thread);
    await client.runStart(thread, '動手。');
    const parked = await foldTurn(events);
    const question = parked.pendings[0];
    if (question === undefined) throw new Error(`${loop}：沒有停在問題上`);
    await client.inputRespond(thread, {
      namespace: [...question.namespace],
      interrupt_id: question.interruptId,
      response: respond as never,
    });
    const done = await foldTurn(events, parked);
    await events.return?.(undefined);
    await serve.close();
    serve = undefined;
    const [project] = readdirSync(logs);
    return { parked, done, log: await sessionEventsOf(join(logs, project!), thread) };
  } finally {
    await rm(logs, { recursive: true, force: true });
  }
}

/** 日誌裡 `name` 那顆工具每一顆 `tool/result` 的本文與是否失敗，照順序。 */
function resultsOf(log: readonly SessionEvent[], name: string): { text: string; isError: boolean }[] {
  const callIds = new Set(
    log.flatMap((event) =>
      event.type === 'tool/call' && event.data.name === name ? [event.data.callId] : [],
    ),
  );
  return log.flatMap((event) =>
    event.type === 'tool/result' && callIds.has(event.data.callId)
      ? [
          {
            text: String((event.data.message?.data as { content?: unknown } | undefined)?.content),
            isError: event.data.isError,
          },
        ]
      : [],
  );
}

/** 寫一次被擋 → 升級 → 原樣重試。grant 綁的是最近被擋下的那一次，所以先要有一次被擋。 */
const WRITE = { name: 'write_file', args: { file_path: '/note.txt', content: '寫了' } };
const ESCALATE: readonly ScriptedTurn[] = [
  { content: '', toolCalls: [WRITE] },
  {
    content: '',
    toolCalls: [
      {
        name: SANDBOX_ESCALATION_TOOL_NAME,
        args: {
          file_path: '/note.txt',
          sandbox_permissions: 'workspace-write',
          justification: '使用者要這個檔',
        },
      },
    ],
  },
  { content: '', toolCalls: [WRITE] },
  { content: '收工。' },
];

describe.each(LOOPS)('%s：沙箱升級在 serve 上', (loop) => {
  it.each([
    ['approve', true],
    ['reject', false],
  ] as const)(
    '%s：寫被擋、停在升級的核准上；答了接回，核准了原樣重試才寫得進去',
    async (type, written) => {
      const workspace = await mkdtemp(join('/var/tmp', 'nexus-producer-escalation-'));
      try {
        const run = await parkAndRespond(
          loop,
          ESCALATE,
          { decisions: [{ type }] },
          { workspace, argv: ['--sandbox', 'read-only'] },
        );
        expect(run.parked.pendings).toHaveLength(1);
        expect(run.done.pendings).toEqual([]);
        expect(JSON.stringify(run.done)).toContain('收工。');

        const escalation = resultsOf(run.log, SANDBOX_ESCALATION_TOOL_NAME);
        expect(escalation.at(-1)?.isError).toBe(!written);
        expect(escalation.at(-1)?.text).toContain(
          written ? '核准了' : rejectedRefusal('/note.txt', 'workspace-write'),
        );
        expect(run.log.filter((event) => event.type === 'interrupt/raised')).toHaveLength(1);

        const file = join(workspace, 'note.txt');
        expect(existsSync(file)).toBe(written);
        if (written) expect(await readFile(file, 'utf8')).toBe('寫了');
        const writes = resultsOf(run.log, 'write_file');
        expect(writes).toHaveLength(2);
        expect(writes[0]?.isError).toBe(true);
        expect(writes[1]?.isError).toBe(!written);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
    120000,
  );
});

describe.each(LOOPS)('%s：plan-mode 在 serve 上', (loop) => {
  it('繼續規劃：停在計劃審核上；答了接回，工具回拒絕，模式留著', async () => {
    const run = await parkAndRespond(
      loop,
      [
        {
          content: '我先規劃。',
          toolCalls: [{ name: EXIT_PLAN_MODE_TOOL_NAME, args: { plan: '# 計劃\n\n先看再改。' } }],
        },
        { content: '再改一版。' },
      ],
      { answers: [{ id: PLAN_REVIEW_QUESTION_ID, selected: [PLAN_KEEP_PLANNING_LABEL] }] },
      { before: async (client, thread) => void (await client.slashRun(thread, '/plan')) },
    );
    expect(run.parked.pendings).toHaveLength(1);
    expect(run.done.pendings).toEqual([]);
    expect(JSON.stringify(run.done)).toContain('再改一版。');
    expect(run.done.planMode).toEqual({ active: true });

    const review = resultsOf(run.log, EXIT_PLAN_MODE_TOOL_NAME).at(-1);
    expect(review?.isError).toBe(true);
    expect(review?.text).toContain(PLAN_KEEP_PLANNING_MESSAGE);
    expect(run.log.filter((event) => event.type === 'interrupt/raised')).toHaveLength(1);
  }, 120000);
});
