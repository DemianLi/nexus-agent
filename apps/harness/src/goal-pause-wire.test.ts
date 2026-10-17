/**
 * 目標在跑的時候暫停，**走真的 serve 與 wire**（[#1516](https://github.com/DemianLi/nexus-agent/issues/1516) 的 B、C、E 與 `slash.list` 那一格）。
 *
 * `goal-pause-running.test.ts` 量 pump 這一段（服務寫出暫停 → 中止在跑的那一輪）；這一份量入口接線：
 * `goal.pause` 與 `/goal pause` 兩條路在一輪跑著時被收下、當場中止那一輪，其餘斜線命令照舊被擋，descriptor 把「忙的時候放行」的宣告帶到 web。
 *
 * 模型是腳本：先由模型建目標（`create_goal`），之後的續行輪是一段故意拖長的回覆，測試在中間動手。**零憑證、零外部連線**。
 */

import type { Event, WireClient } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
import type { ScriptedTurn } from './scripted-model.js';
import { startScriptedServe } from './scripted-serve.js';
import { ASK_USER_QUESTION_TOOL_NAME } from '@nexus/plugin-ask-user';
import type { ScriptedServe } from './scripted-serve.js';

let served: ScriptedServe | undefined;
/**
 * 不變量違規的去處是 `console.error`（runner 的預設）。`/goal pause` 在一輪中間執行，日誌上多一對 `command/run`＋`command/done` 落在開著的 turn 裡，
 * 配套入口（配對、turn 結構）不能因此報違規——這個斜線入口以前從沒在 turn 中間跑過。
 */
let errors: MockInstance<typeof console.error>;
beforeEach(() => {
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  await served?.close();
  served = undefined;
  const logged = errors.mock.calls.map((call) => call.map(String).join(' '));
  errors.mockRestore();
  expect(logged).toEqual([]);
});

/** 一輪故意拖長的回覆。被中止時不會跑完。 */
const SLOW: ScriptedTurn = { content: '這一輪故意拖得很長。'.repeat(12), tokenDelayMs: 20 };

/** 人說一句 → 模型建目標 → 收尾 →（排程器接著開）第一個續行輪是 SLOW，再備一個給後面。 */
const CREATE_THEN_SLOW: readonly ScriptedTurn[] = [
  {
    content: '',
    toolCalls: [{ name: 'create_goal', args: { objective: '把藍鯨計畫做完', max_goal_rounds: 5 } }],
  },
  { content: '建好了。' },
  SLOW,
  SLOW,
];

const BUSY_REJECTION = '這條 thread 正在跑';

async function until(predicate: () => Promise<boolean>, what: string): Promise<void> {
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
  return probe.kind === 'rejected' && probe.message.includes(BUSY_REJECTION);
}

/** 讀下行，直到 root 以 `aborted` 收尾；等不到就拋。 */
async function untilAborted(events: AsyncIterator<Event>): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const next = await events.next();
    if (next.done === true) throw new Error('下行在中止之前就斷了');
    const data = next.value.params.data as { event?: unknown; aborted?: unknown } | null;
    if (
      next.value.method === 'lifecycle' &&
      next.value.params.namespace.length === 0 &&
      data?.event === 'failed' &&
      data.aborted === true
    ) {
      return;
    }
  }
  throw new Error('等不到 aborted 的收尾');
}

async function goalText(client: WireClient, thread: string): Promise<string> {
  const shown = await client.slashRun(thread, '/goal');
  if (shown.kind !== 'success') throw new Error(`/goal 讀不到：${JSON.stringify(shown)}`);
  return shown.text ?? '';
}

/** 開下行、說第一句、折完人打的那一輪。回來時（排程器開的）第一個續行輪正在跑或馬上就跑。 */
async function startGoalRound(
  thread: string,
  turns: readonly ScriptedTurn[] = CREATE_THEN_SLOW,
  argv: readonly string[] = [],
) {
  served = await startScriptedServe(turns, { argv });
  const client = await serveClient(served.running);
  const events = await client.openEvents(thread);
  expect((await client.runStart(thread, '開個頭')).type).toBe('success');
  await foldTurn(events);
  await until(() => isBusy(client, thread), '續行輪開跑');
  return { client, events };
}

/** 用 `goal.pause` 拿目前的目標 ref：帶一個必定過期的 ref，回應的 `current` 就是現在的樣子。 */
async function currentGoalRef(client: WireClient, thread: string) {
  const stale = await client.goalPause(thread, { goalId: 'goal-nope', revision: 1 });
  if (stale.kind !== 'ok' || stale.result.ok || stale.result.error.code !== 'goal-stale') {
    throw new Error(`拿不到目前的目標：${JSON.stringify(stale)}`);
  }
  return stale.result.error.current;
}

describe('續行輪在跑：兩條入口都收，都當場中止那一輪（#1516 A、B）', () => {
  it('B：goal.pause——ref 過期回錯、不假裝成功也不中止；對的 ref 暫停並中止；再暫停回 goal-not-active', async () => {
    const { client, events } = await startGoalRound('wire-pause-b');

    const current = await currentGoalRef(client, 'wire-pause-b');
    expect(current.phase).toBe('active');
    // 過期那一下什麼都沒動：那一輪還在跑。
    expect(await isBusy(client, 'wire-pause-b')).toBe(true);

    const paused = await client.goalPause('wire-pause-b', {
      goalId: current.id,
      revision: current.revision,
    });
    expect(paused).toMatchObject({
      kind: 'ok',
      result: { ok: true, value: { goal: { id: current.id, phase: 'paused' } } },
    });
    await untilAborted(events);
    expect(await isBusy(client, 'wire-pause-b')).toBe(false);
    expect(await goalText(client, 'wire-pause-b')).toContain('狀態：暫停');

    const again = await client.goalPause('wire-pause-b', {
      goalId: current.id,
      revision: current.revision + 1,
    });
    expect(again).toMatchObject({
      kind: 'ok',
      result: { ok: false, error: { code: 'goal-not-active', phase: 'paused' } },
    });
  });

  it('A：/goal pause——跑著時被收下，那一輪以 aborted 收，目標是暫停', async () => {
    const { client, events } = await startGoalRound('wire-pause-a');

    expect(await client.slashRun('wire-pause-a', '/goal pause')).toMatchObject({
      kind: 'success',
    });
    await untilAborted(events);
    expect(await isBusy(client, 'wire-pause-a')).toBe(false);
    expect(await goalText(client, 'wire-pause-a')).toContain('狀態：暫停');
  });
});

describe('人打的那一輪在跑（目標 active 但已收回授權）：兩條入口同樣中止（#1516 C）', () => {
  it.each(['goal.pause', '/goal pause'] as const)('%s', async (entry) => {
    const thread = `wire-pause-c-${entry === 'goal.pause' ? 'method' : 'slash'}`;
    const { client, events } = await startGoalRound(thread, [...CREATE_THEN_SLOW, SLOW]);
    // 按停止：續行輪以 aborted 收，授權收回，目標仍是 active——接著人再說一句，跑的是人打的那一輪。
    await client.runCancel(thread);
    await untilAborted(events);
    await until(async () => !(await isBusy(client, thread)), '停止之後閒下來');
    const current = await currentGoalRef(client, thread);
    expect(current.phase).toBe('active');

    expect((await client.runStart(thread, '先做這件小事')).type).toBe('success');
    await until(() => isBusy(client, thread), '人打的那一輪開跑');

    if (entry === 'goal.pause') {
      expect(
        await client.goalPause(thread, { goalId: current.id, revision: current.revision }),
      ).toMatchObject({ kind: 'ok', result: { ok: true, value: { goal: { phase: 'paused' } } } });
    } else {
      expect(await client.slashRun(thread, '/goal pause')).toMatchObject({ kind: 'success' });
    }
    await untilAborted(events);
    expect(await isBusy(client, thread)).toBe(false);
    expect(await goalText(client, thread)).toContain('狀態：暫停');
  });
});

describe('一輪跑著時，其餘斜線命令照舊被擋（#1516 E）', () => {
  it('/plan、/goal <目標>、/goal edit、/goal resume、/goal clear、/goal（顯示）、大小寫不同的 PAUSE 都回原本那句，一輪沒被動到', async () => {
    const { client } = await startGoalRound('wire-pause-e');
    for (const line of [
      '/plan 先想一想',
      '/goal 另一個目標',
      '/goal edit 改一下',
      '/goal resume',
      '/goal clear',
      '/goal',
      // 放行名單是逐字的完整字面值，不是文法：文法上 `PAUSE` 也是暫停，但沒有宣告就照舊擋。
      '/goal PAUSE',
    ]) {
      const result = await client.slashRun('wire-pause-e', line);
      expect(result, line).toMatchObject({
        kind: 'rejected',
        message: '這條 thread 正在跑：等這一輪跑完再打斜線命令',
      });
    }
    // 一個都沒被執行：那一輪還在跑、目標沒動。
    expect(await isBusy(client, 'wire-pause-e')).toBe(true);
    const current = await currentGoalRef(client, 'wire-pause-e');
    expect(current.phase).toBe('active');
    await client.runCancel('wire-pause-e');
  });

  it('slash.list 的 descriptor 帶著宣告：只有 /goal 的 pause；其餘命令沒有這一格', async () => {
    served = await startScriptedServe([{ content: '好。' }]);
    const client = await serveClient(served.running);
    const listed = await client.slashList('wire-pause-list');
    if (listed.kind !== 'ok') throw new Error(`slash.list 失敗：${JSON.stringify(listed)}`);
    const byName = new Map(listed.commands.map((command) => [command.name, command]));
    expect(byName.get('goal')?.runWhileBusy).toEqual(['pause']);
    expect(byName.size).toBeGreaterThan(1);
    for (const [name, command] of byName) {
      if (name !== 'goal') expect(command.runWhileBusy, name).toBeUndefined();
    }
  });
});

describe('忙的時候放行的名單，閘門與 descriptor 是同一份（#1516）', () => {
  it('slash.list 宣告的每個字面值，跑著時真的被收下（不是寫死 /goal pause）', async () => {
    const { client } = await startGoalRound('wire-pause-single-source');
    const listed = await client.slashList('wire-pause-single-source');
    if (listed.kind !== 'ok') throw new Error(`slash.list 失敗：${JSON.stringify(listed)}`);
    const declared = listed.commands.flatMap((command) =>
      (command.runWhileBusy ?? []).map((literal) => `/${command.name} ${literal}`),
    );
    expect(declared.length).toBeGreaterThan(0);
    for (const line of declared) {
      const result = await client.slashRun('wire-pause-single-source', line);
      expect(result, line).toMatchObject({ kind: 'success' });
    }
  });
});

describe('停在核准點（等人回答）：/goal pause 與 goal.pause 收，其餘照舊被擋（#1516）', () => {
  const ASK_TURNS: readonly ScriptedTurn[] = [
    {
      content: '',
      toolCalls: [
        { name: 'create_goal', args: { objective: '把藍鯨計畫做完', max_goal_rounds: 5 } },
      ],
    },
    {
      content: '我先問。',
      toolCalls: [
        {
          name: ASK_USER_QUESTION_TOOL_NAME,
          args: {
            questions: [
              { id: 'day', question: '哪一天？', options: [{ label: '週一' }, { label: '週二' }] },
            ],
          },
        },
      ],
    },
    { content: '收工。' },
    SLOW,
  ];

  it.each(['goal.pause', '/goal pause'] as const)('%s', async (entry) => {
    const thread = `wire-pause-approval-${entry === 'goal.pause' ? 'method' : 'slash'}`;
    served = await startScriptedServe(ASK_TURNS);
    const client = await serveClient(served.running);
    const events = await client.openEvents(thread);
    expect((await client.runStart(thread, '開個頭')).type).toBe('success');
    await foldTurn(events);

    // 停在問答中斷：一般斜線命令被擋，原本那句話不變。
    expect(await client.slashRun(thread, '/plan')).toMatchObject({
      kind: 'rejected',
      message: '這條 thread 停在核准點：先用 input.respond 回答它，再打斜線命令',
    });
    expect(await client.slashRun(thread, '/goal resume')).toMatchObject({
      kind: 'rejected',
      message: '這條 thread 停在核准點：先用 input.respond 回答它，再打斜線命令',
    });

    const current = await currentGoalRef(client, thread);
    if (entry === 'goal.pause') {
      expect(
        await client.goalPause(thread, { goalId: current.id, revision: current.revision }),
      ).toMatchObject({ kind: 'ok', result: { ok: true, value: { goal: { phase: 'paused' } } } });
    } else {
      expect(await client.slashRun(thread, '/goal pause')).toMatchObject({ kind: 'success' });
    }
    // 待答的問題被收回：不再停在核准點，一般斜線命令又收得下。
    await until(
      async () => (await client.slashRun(thread, '/goal')).kind === 'success',
      '收回之後閒下來',
    );
    expect(await goalText(client, thread)).toContain('狀態：暫停');
  });
});

describe('--no-goal-driver：兩條入口的差異（#1516）', () => {
  it('/goal pause 照樣收下並中止人打的那一輪；goal.pause 回 not_supported（它經續行排程器的 port）', async () => {
    const thread = 'wire-pause-no-driver';
    // 沒有排程器：模型建完目標之後那一輪（SLOW）就是人打的那一輪。
    served = await startScriptedServe(
      [
        {
          content: '',
          toolCalls: [
            { name: 'create_goal', args: { objective: '把藍鯨計畫做完', max_goal_rounds: 5 } },
          ],
        },
        SLOW,
      ],
      { argv: ['--no-goal-driver'] },
    );
    const client = await serveClient(served.running);
    const events = await client.openEvents(thread);
    expect((await client.runStart(thread, '開個頭')).type).toBe('success');
    await until(() => isBusy(client, thread), '這一輪開跑');
    expect(await client.goalPause(thread, { goalId: 'x', revision: 1 })).toMatchObject({
      kind: 'rejected',
      code: 'not_supported',
    });
    // 目標是這一輪裡由模型建的：建好之前 `/goal pause` 回 error，建好之後被收下。
    await until(
      async () => (await client.slashRun(thread, '/goal pause')).kind === 'success',
      '目標建好、暫停被收下',
    );
    await untilAborted(events);
    expect(await isBusy(client, thread)).toBe(false);
    expect(await goalText(client, thread)).toContain('狀態：暫停');
  });
});
