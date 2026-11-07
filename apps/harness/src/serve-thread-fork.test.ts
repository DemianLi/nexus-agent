/**
 * 產品路徑上的分叉（[#1580](https://github.com/DemianLi/nexus-agent/issues/1580) 刀 2）：真 `runServe`、真落盤、腳本模型。
 *
 * 判斷順序、名額的佔與還、清佇列的 seed 在 [`thread-fork-wire.test.ts`](./thread-fork-wire.test.ts)；這一檔問的是只有產品路徑上量得到的
 * （驗收編號照卡面）：
 *
 * - **2 分出來的長相**：子 thread 的檔＝來源到第二輪 `turn/end` 的前綴（seq 不改）＋ inherited 標記；header 帶來源、`isSeeded`、
 *   `cwd`、`workspaceRoot`；讀歷史看得到第一、二輪，看不到第三輪。
 * - **3 各走各的**、**5 重啟**：分叉一回傳檔就在（不等關機排空）；重啟之後兩條都列得出來、子 thread 帶 `parentThreadId`、各說一句互不影響。
 * - **4 讀活的**：落盤窗口拉長，來源的尾巴還在記憶體時照樣分得出去。
 * - **6 錯誤**：沒開落盤 `not_supported`；名額滿 `thread_at_capacity`，磁碟上沒有多出檔。
 * - **8 不會自己跑**：前綴裡有執行中的 goal、切點上還排著一句。分叉之後子 thread 的續行授權是 `disarmed`、佇列是空的，
 *   再一次往返之後收掉 serve，子 thread 落盤的日誌跟分叉回傳時一樣，沒有多出任何一顆事件。
 *
 * **零憑證、零外部連線**：模型是腳本，工作區與日誌根是暫存目錄。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EMPTY_INBOX, foldInbox, inheritedEventCount, loggedMessageId } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import { emptyConversation, reduceAll, reduceConversation, THREAD_AT_CAPACITY } from '@nexus/wire';
import type { ConversationEntry, WireClient } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
import type { ScriptedTurn } from './scripted-model.js';
import { startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';
import { PROCESS_MODEL_UNDER_TEST } from './serve-under-test.fixture.js';
import { findSession, sessionEvents, sessionsUnder, sessionOf } from './session-files.fixture.js';

const opened: ScriptedServe[] = [];
const temporary: string[] = [];

afterEach(async () => {
  for (const serve of opened.splice(0)) await serve.close();
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

async function start(
  turns: readonly ScriptedTurn[],
  options: Parameters<typeof startScriptedServe>[1] = {},
): Promise<ScriptedServe> {
  const serve = await startScriptedServe(turns, options);
  opened.push(serve);
  return serve;
}

async function stop(serve: ScriptedServe): Promise<void> {
  opened.splice(opened.indexOf(serve), 1);
  await serve.close();
}

/** 每條 thread 各吃一份腳本、從第一輪開始，所以回覆照輪次編號就分得出是第幾輪。 */
const TURNS: readonly ScriptedTurn[] = [
  { content: '回一' },
  { content: '回二' },
  { content: '回三' },
  { content: '回四' },
];

async function say(client: WireClient, threadId: string, text: string): Promise<void> {
  const events = await client.openEvents(threadId);
  expect((await client.runStart(threadId, text)).type).toBe('success');
  await foldTurn(events);
  await events.return?.(undefined);
}

/** 這條 thread 讀歷史折出來的畫面，照 web。 */
async function entries(client: WireClient, threadId: string): Promise<ConversationEntry[]> {
  const page = await client.threadHistory(threadId);
  if (page.kind !== 'ok') throw new Error(`歷史拿不到：${page.message}`);
  return [...reduceAll(emptyConversation(), page.result.events).entries];
}

/** 每一輪收尾那則回覆的 `messageId`，web 的分叉按鈕指名的就是它。 */
async function tailIds(client: WireClient, threadId: string): Promise<string[]> {
  return (await entries(client, threadId)).flatMap((entry) =>
    entry.kind === 'ai' && entry.turnTail === true && entry.messageId !== undefined
      ? [entry.messageId]
      : [],
  );
}

function texts(list: readonly ConversationEntry[]): string[] {
  return list.flatMap((entry) =>
    entry.kind === 'human' || entry.kind === 'ai' ? [`${entry.kind}:${entry.text}`] : [],
  );
}

async function forkOk(client: WireClient, threadId: string, messageId: string): Promise<string> {
  const outcome = await client.threadFork(threadId, messageId);
  if (outcome.kind !== 'ok' || !outcome.result.ok) {
    throw new Error(`分叉失敗：${JSON.stringify(outcome)}`);
  }
  return outcome.result.value.threadId;
}

async function eventsOnDisk(root: string, threadId: string): Promise<SessionEvent[]> {
  return (await sessionEvents(await sessionOf(root, threadId))).events;
}

/**
 * {@link until} 等多久就放棄：比 vitest 預設的 5 秒短，在測試開頭起跑的等待卡住時報得出等的是哪一步；起跑得晚就可能先撞上
 * vitest 的逾時，那時看 {@link stepTimer} 印的各步耗時。
 */
const UNTIL_DEADLINE_MS = 4_000;

/** 輪詢落盤的那一份，直到 `pick` 挑得到東西；逾時就拋，講等的是什麼、等了多久。 */
async function until<T>(
  root: string,
  threadId: string,
  what: string,
  pick: (events: readonly SessionEvent[]) => T | undefined | Promise<T | undefined>,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const session = await findSession(root, threadId);
    const found =
      session === undefined ? undefined : await pick((await sessionEvents(session)).events);
    if (found !== undefined) return found;
    if (Date.now() - started > UNTIL_DEADLINE_MS) {
      throw new Error(
        `等不到 ${threadId} 的日誌出現「${what}」（等了 ${String(Date.now() - started)} ms）`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * 記這一支走到哪一步，失敗（含逾時）時把每一步的耗時印到 stderr（#2458）：逾時的錯誤只說超過幾毫秒，看不出停在哪一步。
 *
 * @returns 進入下一步時呼叫，帶這一步的名字。
 */
function stepTimer(onTestFailed: (handler: () => void) => void): (step: string) => void {
  const started = performance.now();
  const steps: { readonly step: string; readonly at: number }[] = [];
  onTestFailed(() => {
    const now = performance.now();
    const lines = steps.map(({ step, at }, index) => {
      const end = steps[index + 1]?.at ?? now;
      return `  ${step}：${String(Math.round(at - started))} ms 開始，花了 ${String(Math.round(end - at))} ms`;
    });
    console.error(`各步耗時（最後一步就是停住的地方）：\n${lines.join('\n')}`);
  });
  return (step) => steps.push({ step, at: performance.now() });
}

function seqOfTurnEnd(events: readonly SessionEvent[], nth: number): number {
  const ends = events.filter((event) => event.type === 'turn/end');
  const end = ends[nth];
  if (end === undefined) throw new Error(`沒有第 ${String(nth + 1)} 顆 turn/end`);
  return end.seq;
}

const PER_THREAD = PROCESS_MODEL_UNDER_TEST === 'per-thread';
/**
 * 要分得出去的幾支。per-thread 的對話行程不在自己這裡分叉（新 thread 要另起一個行程，#2341 的已知缺口），
 * 這幾支在 per-thread 底下跳過，缺口現在的行為由下面 `runIf(PER_THREAD)` 那一支釘住。
 */
const itForks = it.skipIf(PER_THREAD);

describe('serve 上的 thread.fork', () => {
  itForks('分出來的長相、各走各的、回傳之後馬上重啟（驗收 2、3、5）', async () => {
    const root = await tempDir('nexus-fork-log-');
    const workspace = await tempDir('nexus-fork-ws-');
    const argv = ['--session-log', root];
    const first = await start(TURNS, { workspace, argv });
    const client = await serveClient(first.running);
    await say(client, 'src', '一');
    await say(client, 'src', '二');
    await say(client, 'src', '三');
    const tails = await tailIds(client, 'src');
    expect(tails).toHaveLength(3);

    const childId = await forkOk(client, 'src', tails[1]!);
    expect(childId).not.toBe('src');
    // 回傳的時候檔就在：seed 在回應之前排空，不靠關機那次排空。
    expect(await findSession(root, childId)).toBeDefined();
    await stop(first);

    // 驗收 2：前綴照抄、seq 不改，接 inherited 標記；之後沒有新的一輪。
    const source = await eventsOnDisk(root, 'src');
    const child = await eventsOnDisk(root, childId);
    const boundary = seqOfTurnEnd(source, 1);
    expect(child.slice(0, boundary + 1)).toEqual(source.slice(0, boundary + 1));
    expect(child[boundary + 1]).toMatchObject({
      type: 'session/end-seed',
      seq: boundary + 1,
      data: { inherited: true },
    });
    expect(inheritedEventCount(child)).toBe(boundary + 1);
    expect(child.slice(boundary + 1).some((event) => event.type === 'turn/start')).toBe(false);
    const sourceHeader = (await sessionOf(root, 'src')).header;
    const childHeader = (await sessionOf(root, childId)).header;
    expect(childHeader).toMatchObject({ id: childId, parentSession: 'src', isSeeded: true });
    expect(childHeader.cwd).toBe(sourceHeader.cwd);
    expect(sourceHeader.workspaceRoot).toBeDefined();
    expect(childHeader.workspaceRoot).toBe(sourceHeader.workspaceRoot);
    expect(sourceHeader.parentSession).toBeUndefined();

    // 驗收 5：重啟之後兩條都列得出來，子 thread 帶來源。
    const second = await start(TURNS, { workspace, argv });
    const again = await serveClient(second.running);
    const listed = await again.listThreads();
    if (listed.kind !== 'ok') throw new Error(`列表失敗：${listed.message}`);
    const rows = new Map(listed.result.items.map((item) => [item.threadId, item]));
    expect(rows.get(childId)?.parentThreadId).toBe('src');
    expect(rows.get('src')).toBeDefined();
    expect(rows.get('src')?.parentThreadId).toBeUndefined();

    // 驗收 2 的畫面：子 thread 讀歷史，第一、二輪在，第三輪不在。
    expect(texts(await entries(again, childId))).toEqual([
      'human:一',
      'ai:回一',
      'human:二',
      'ai:回二',
    ]);

    // 驗收 3、5：續接得了，兩邊各說一句、互不影響。
    await say(again, childId, '子的一句');
    await say(again, 'src', '來源的一句');
    const childAfter = texts(await entries(again, childId));
    const sourceAfter = texts(await entries(again, 'src'));
    expect(childAfter.slice(0, 5)).toEqual([
      'human:一',
      'ai:回一',
      'human:二',
      'ai:回二',
      'human:子的一句',
    ]);
    expect(childAfter).not.toContain('human:三');
    expect(childAfter).not.toContain('human:來源的一句');
    expect(sourceAfter).toContain('human:三');
    expect(sourceAfter).toContain('human:來源的一句');
    expect(sourceAfter).not.toContain('human:子的一句');

    // 續接之後再讀檔（#1908 審查第 1 項）：前綴與標記原封不動，新的一輪接在後面，讀盤驗證照樣過。
    await stop(second);
    const reread = await eventsOnDisk(root, childId);
    expect(reread.slice(0, boundary + 2)).toEqual(child.slice(0, boundary + 2));
    expect(inheritedEventCount(reread)).toBe(boundary + 1);
    expect(
      reread
        .slice(boundary + 2)
        .some(
          (event) =>
            event.type === 'turn/start' && (event.data as { text?: unknown }).text === '子的一句',
        ),
    ).toBe(true);
    expect((await sessionOf(root, childId)).header).toMatchObject({
      parentSession: 'src',
      isSeeded: true,
    });
  });

  itForks('讀活的：落盤窗口拉長、來源的尾巴還在記憶體，照樣分得出去（驗收 4）', async () => {
    const root = await tempDir('nexus-fork-live-');
    const serve = await start(TURNS, {
      argv: ['--session-log', root],
      extraRows: '- id: session-persistence\n  config:\n    windowMs: 600000\n',
    });
    const client = await serveClient(serve.running);
    await say(client, 'src', '一');
    // 第一次分叉：來源還沒實體化，讀的時候先排空它（之後的尾巴照窗口留在記憶體）。
    await forkOk(client, 'src', (await tailIds(client, 'src'))[0]!);
    await say(client, 'src', '二');
    const tails = await tailIds(client, 'src');
    expect(tails).toHaveLength(2);
    // 前提：磁碟上那一份還沒有第二輪——一律冷讀的話，這一刀分不出去。
    const cold = await eventsOnDisk(root, 'src');
    expect(cold.filter((event) => event.type === 'turn/end')).toHaveLength(1);

    const childId = await forkOk(client, 'src', tails[1]!);
    const child = await eventsOnDisk(root, childId);
    expect(child.filter((event) => event.type === 'turn/end')).toHaveLength(2);
    expect(texts(await entries(client, childId))).toEqual([
      'human:一',
      'ai:回一',
      'human:二',
      'ai:回二',
    ]);
  });

  it.runIf(PER_THREAD)(
    'per-thread：分叉回 not_supported（已知缺口），來源 thread 照常',
    async () => {
      const root = await tempDir('nexus-fork-log-');
      const serve = await start(TURNS, { argv: ['--session-log', root] });
      const client = await serveClient(serve.running);
      await say(client, 'src', '一');
      const [tail] = await tailIds(client, 'src');
      expect(await client.threadFork('src', tail!)).toMatchObject({
        kind: 'rejected',
        code: 'not_supported',
      });
      await say(client, 'src', '二');
      expect(await tailIds(client, 'src')).toHaveLength(2);
    },
  );

  it('沒開落盤：not_supported', async () => {
    const serve = await start(TURNS, {
      extraRows: '- id: session-persistence\n  disabled: true\n',
    });
    const client = await serveClient(serve.running);
    await say(client, 'src', '一');
    expect(await client.threadFork('src', 'whatever')).toMatchObject({
      kind: 'rejected',
      code: 'not_supported',
    });
  });

  itForks('名額滿：thread_at_capacity，磁碟上沒有多出檔（驗收 6）', async () => {
    const root = await tempDir('nexus-fork-cap-');
    const serve = await start(TURNS, {
      argv: ['--session-log', root],
      extraRows: '- id: thread-capacity\n  config:\n    maxThreads: 1\n',
    });
    const client = await serveClient(serve.running);
    await say(client, 'src', '一');
    const [tail] = await tailIds(client, 'src');
    expect(await client.threadFork('src', tail!)).toMatchObject({
      kind: 'rejected',
      code: THREAD_AT_CAPACITY,
    });
    expect(await client.threadFork('ghost', tail!)).toEqual({
      kind: 'ok',
      result: { ok: false, error: { code: 'thread_not_found' } },
    });
    expect((await sessionsUnder(root)).map((session) => session.header.id)).toEqual(['src']);
  });

  itForks(
    '指名子代理的回覆：fork_unavailable；拿子代理的會話當來源：thread_not_found（驗收 6）',
    async () => {
      const root = await tempDir('nexus-fork-subagent-');
      // 根對話派一個背景子代理（子代理與根對話共用同一顆腳本模型，輪到誰誰吃），同 `serve-subagent-ownership.test.ts`。
      const turns: ScriptedTurn[] = [
        {
          content: '委派。',
          toolCalls: [
            {
              name: 'subagent',
              args: {
                description: '幹活',
                subagent_type: 'general-purpose',
                run_in_background: true,
              },
            },
          ],
        },
        ...Array.from({ length: 6 }, () => ({ content: '好。' })),
      ];
      const serve = await start(turns, { argv: ['--session-log', root] });
      const client = await serveClient(serve.running);
      await say(client, 'src', '請派一個子代理');
      const subagent = await until(root, 'src', '背景子代理跑完第一輪', async () => {
        const found = (await sessionsUnder(root)).find((session) =>
          session.id.startsWith('src/bg-'),
        );
        if (found === undefined) return undefined;
        const { events } = await sessionEvents(found);
        return events.some((event) => event.type === 'turn/end') ? { found, events } : undefined;
      });
      const replyId = subagent.events.flatMap((event) =>
        event.type === 'assistant/message' ? [loggedMessageId(event.data.message)] : [],
      )[0];
      expect(replyId).toBeDefined();
      // 前提：根對話那一份裡沒有這個 id（子代理的回覆只在它自己那一份）。
      const rootEvents = await eventsOnDisk(root, 'src');
      expect(
        rootEvents.some(
          (event) =>
            event.type === 'assistant/message' && loggedMessageId(event.data.message) === replyId,
        ),
      ).toBe(false);
      expect(await client.threadFork('src', replyId!)).toEqual({
        kind: 'ok',
        result: { ok: false, error: { code: 'fork_unavailable' } },
      });
      expect(await client.threadFork(subagent.found.id, replyId!)).toEqual({
        kind: 'ok',
        result: { ok: false, error: { code: 'thread_not_found' } },
      });
    },
  );

  itForks(
    '不會自己跑：前綴有執行中的 goal、切點上還排著一句，分叉之後子 thread 不開新的一輪、佇列是空的（驗收 8）',
    async ({ onTestFailed }) => {
      const step = stepTimer(onTestFailed);
      step('起 serve');
      const root = await tempDir('nexus-fork-idle-');
      // 來源：建目標，續行排程器開的第一輪慢慢吐字；那一輪跑著的時候送一句，排進佇列。之後佇列那句與續行的輪次各吃一份腳本，給足。
      const turns: ScriptedTurn[] = [
        { content: '慢慢說的一輪', tokenDelayMs: 150 },
        ...Array.from({ length: 30 }, () => ({ content: '好' })),
      ];
      const serve = await start(turns, { argv: ['--session-log', root] });
      const client = await serveClient(serve.running);
      step('開來源的下行');
      const events = await client.openEvents('src');
      step('建目標');
      expect(await client.slashRun('src', '/goal 把藍鯨計畫做完')).toMatchObject({
        kind: 'success',
      });
      step('等目標那一輪開始落盤');
      const goalTurn = await until(root, 'src', '目標那一輪的 turn/start', (list) =>
        list.find(
          (event) =>
            event.type === 'turn/start' && (event.data as { kind?: unknown }).kind === 'goal',
        ),
      );
      step('送排著的一句');
      expect((await client.runStart('src', '排著的一句')).type).toBe('success');
      step('等目標那一輪結束落盤');
      await until(root, 'src', '目標那一輪的 turn/end', (list) =>
        list.find((event) => event.type === 'turn/end' && event.seq > goalTurn.seq),
      );
      step('關來源的下行、暫停目標');
      await events.return?.(undefined);
      // 收掉來源的目標，免得它在背景一直跑。
      expect(await client.slashRun('src', '/goal pause')).toMatchObject({ kind: 'success' });

      step('讀來源的歷史');
      const goalTail = (await entries(client, 'src')).find(
        (entry) => entry.kind === 'ai' && entry.text === '慢慢說的一輪',
      );
      if (goalTail?.kind !== 'ai' || goalTail.messageId === undefined) {
        throw new Error('找不到慢的那一輪的回覆');
      }
      step('分叉');
      const childId = await forkOk(client, 'src', goalTail.messageId);

      step('讀子 thread 的 seed');
      const seeded = await eventsOnDisk(root, childId);
      const inherited = seeded.slice(0, inheritedEventCount(seeded));
      // 前提：切點上真的有排著的一句，前綴裡真的有執行中的目標（不是兩個「本來就沒有」相等）。
      expect(foldInbox(inherited)['next-turn'].map((item) => item.text)).toEqual(['排著的一句']);
      const goals = inherited.filter((event) => event.type === 'goal/change');
      expect((goals.at(-1)?.data as { operation?: unknown } | undefined)?.operation).toBe('create');

      expect(foldInbox(seeded)).toEqual(EMPTY_INBOX);

      // 能讓子 thread 跑出不是人送的那一輪的有兩條：續行（排程器只在授權是 armed 時排）與繼承來的佇列（折回來會停住，
      // 但下一次送出時會先跑它；上面已驗是空的）。開子 thread 的下行，拿補送的授權。
      step('開子 thread 的下行、等續行授權');
      const childEvents = await client.openEvents(childId);
      let child = emptyConversation();
      while (child.goalActivation === null) {
        const next = await childEvents.next();
        if (next.done === true) throw new Error('子 thread 的下行斷了，還沒收到續行授權');
        child = reduceConversation(child, next.value);
      }
      expect(child.goalActivation).toBe('disarmed');
      await childEvents.return(undefined);

      // 多一次往返，讓延後一個 tick 的排程（例如續行的 setImmediate）有機會先跑；收掉 serve 會把日誌全部落盤，之後再比。
      step('往返、收掉 serve');
      expect(await client.threadHistory(childId)).toMatchObject({ kind: 'ok' });
      await stop(serve);
      step('比對落盤');
      // 沒有新的一輪、沒有新的模型呼叫：子 thread 的日誌跟分叉回傳時一樣，一顆都沒多。
      expect(await eventsOnDisk(root, childId)).toEqual(seeded);
    },
  );
});
