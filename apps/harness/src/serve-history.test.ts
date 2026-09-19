/**
 * 切回以前的 thread，畫面照日誌重播（[#306](https://github.com/DemianLi/nexus-agent/issues/306) 的畫面那一刀），
 * 對著真的 server 走一次產品路徑：開下行 → 拿歷史 → 折 → 再說一句。
 *
 * **判準是折出來的畫面**，而最要緊的那一條是「之後的即時回覆畫得出來」：歷史帶了耐久 seq 的話，傳輸 seq 從 0 起的
 * 即時 frame 全被折疊器當成重複丟掉——日誌上一切正常，畫面上看不到回覆。所以這裡一律折**同一份**狀態：先歷史、
 * 再即時，跟 web 的 `use-conversation.ts` 同一個順序。
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConversationEntry, ConversationState, WireClient } from '@nexus/wire';
import {
  appendHumanTurn,
  emptyConversation,
  historyPath,
  reduceAll,
  reduceConversation,
} from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import { exchangeServeToken, fetchWithCookie, serveClient } from './fixtures.js';

let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function start(argv: readonly string[]): Promise<RunningServe> {
  running = await runServe({ argv: ['--port', '0', ...argv], log: () => undefined, env: {} });
  return running as RunningServe;
}

async function stop(server: RunningServe): Promise<void> {
  await server.close();
  running = undefined;
}

function line(entry: ConversationEntry): string {
  switch (entry.kind) {
    case 'human':
      return `human:${entry.text}`;
    case 'ai':
      return `ai:${entry.text}`;
    case 'tool':
      return `tool:${entry.name}:${entry.status}`;
    default:
      return entry.kind;
  }
}

/**
 * 開一條 thread 的樣子，照 web：先開下行、再拿歷史折進來，然後說一句話、折到這一輪收掉。
 *
 * @returns 折完的畫面，與拿歷史時回來的那一頁。
 */
async function openAndSay(
  client: WireClient,
  threadId: string,
  prompt: string,
): Promise<{ readonly state: ConversationState; readonly historyCount: number }> {
  const events = await client.openEvents(threadId);
  const page = await client.threadHistory(threadId);
  if (page.kind !== 'ok') throw new Error(`歷史拿不到：${page.message}`);
  let state = reduceAll(emptyConversation(), page.result.events);
  const historyCount = state.entries.length;
  await client.runStart(threadId, prompt);
  state = appendHumanTurn(state, prompt);
  while (state.status === 'running') {
    const next = await events.next();
    if (next.done === true) break;
    state = reduceConversation(state, next.value);
  }
  await events.return?.(undefined);
  return { state, historyCount };
}

describe('切回以前的 thread，畫面照日誌重播', () => {
  it('重開 server 之後：上一次的人話、回覆、工具卡依序回來，之後的即時回覆接在下面', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-serve-history-'));
    const first = await start(['--session-log', root]);
    const before = await openAndSay(await serveClient(first), 'alpha', '記住暗號是藍鯨');
    await stop(first);
    // 前提：上一次那一輪畫得出回覆與工具卡，重播才有東西可比。
    const previous = before.state.entries.map(line);
    expect(previous.filter((entry) => entry.startsWith('tool:')).length).toBeGreaterThan(0);

    const second = await start(['--session-log', root]);
    const after = await openAndSay(await serveClient(second), 'alpha', '暗號是什麼');

    const lines = after.state.entries.map(line);
    expect(lines.slice(0, after.historyCount)).toEqual(previous);
    // **即時的回覆畫得出來**：歷史之後至少還有人話與一則有字的回覆。
    const live = after.state.entries.slice(after.historyCount);
    expect(live.map(line)[0]).toBe('human:暗號是什麼');
    expect(live.some((entry) => entry.kind === 'ai' && entry.text !== '')).toBe(true);
    expect(after.state.status).toBe('idle');
  });

  it('沒開 --session-log、同一個行程裡切回去：歷史照樣在（讀的是記憶體裡那份日誌）', async () => {
    const server = await start([]);
    const client = await serveClient(server);
    const before = await openAndSay(client, 'beta', '第一句');
    await openAndSay(client, 'gamma', '別條');

    const after = await openAndSay(client, 'beta', '第二句');

    expect(after.state.entries.map(line).slice(0, after.historyCount)).toEqual(
      before.state.entries.map(line),
    );
  });

  it('往前翻：真的 client 帶得動三個參數，接起來就是整份', async () => {
    const server = await start([]);
    const client = await serveClient(server);
    await openAndSay(client, 'iota', '第一句');
    await openAndSay(client, 'iota', '第二句');

    const whole = await client.threadHistory('iota');
    const last = await client.threadHistory('iota', { maxMessages: 1 });
    if (whole.kind !== 'ok' || last.kind !== 'ok') throw new Error('歷史拿不到');
    expect(last.result.hasMore).toBe(true);
    const earlier = await client.threadHistory('iota', {
      maxMessages: 100,
      beforeSeq: last.result.firstSeq,
      throughSeq: last.result.throughSeq,
    });
    if (earlier.kind !== 'ok') throw new Error('更早的拿不到');

    expect(earlier.result.hasMore).toBe(false);
    const joined = reduceAll(
      reduceAll(emptyConversation(), earlier.result.events),
      last.result.events,
    );
    expect(joined.entries.map(line)).toEqual(
      reduceAll(emptyConversation(), whole.result.events).entries.map(line),
    );
  });

  it('沒寫過的 thread：歷史是空的', async () => {
    const server = await start([]);
    const page = await (await serveClient(server)).threadHistory('delta');

    expect(page).toEqual({
      kind: 'ok',
      result: { events: [], firstSeq: 0, throughSeq: -1, hasMore: false, legacy: false },
    });
  });
});

/**
 * 最後一輪停在核准點。**卡的畫法由這條 thread 現在還掛不掛著那顆中斷、停在閘門上的是哪幾個名字決定**，而這兩格
 * 只有 pump 知道——這一條驗的是 handler 真的把它們交進來了（`historyFrames` 的畫法本身驗在
 * `conversation-history.test.ts`）。
 */
describe('停在核准點的 thread', () => {
  const APPROVAL = fileURLToPath(new URL('./approval.fixture.ts', import.meta.url));

  /** 送一句話，折到停在核准點。 */
  async function stopAtApproval(client: WireClient, threadId: string): Promise<ConversationState> {
    const { state } = await openAndSay(client, threadId, '回聲一次');
    expect(state.status).toBe('awaiting-input');
    return state;
  }

  async function replayed(client: WireClient, threadId: string): Promise<ConversationState> {
    const page = await client.threadHistory(threadId);
    if (page.kind !== 'ok') throw new Error(`歷史拿不到：${page.message}`);
    return reduceAll(emptyConversation(), page.result.events);
  }

  /**
   * 停在閘門上的名字也只有 pump 知道（#317）：handler 沒交進來的話，這張卡會是「等你回答」。
   */
  it('同一個行程裡切回去：那張卡跟即時一樣是「執行中」，畫面停在忙著', async () => {
    const server = await start(['--plugins', APPROVAL]);
    const client = await serveClient(server);
    await stopAtApproval(client, 'kappa');

    const state = await replayed(client, 'kappa');

    expect(state.entries.map(line)).toContain('tool:echo:running');
    expect(state.status).toBe('running');
  });

  it('對照：重開 server 之後中斷不在了，那張卡收成失敗', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-serve-history-'));
    const first = await start(['--session-log', root, '--plugins', APPROVAL]);
    await stopAtApproval(await serveClient(first), 'lambda');
    await stop(first);

    const second = await start(['--session-log', root, '--plugins', APPROVAL]);
    const state = await replayed(await serveClient(second), 'lambda');

    expect(state.entries.map(line)).toContain('tool:echo:failed');
    expect(state.status).toBe('idle');
  });

  /**
   * **離線掃描的前提**（`eval/session-scan.ts` 檔頭「鏈的邊界」那段）：中斷只活在 pump 的記憶體裡，所以重開之後
   * 日誌上接不出一顆 `resume` 的頭——接縫之後推得動重複鏈的第一顆呼叫，前面一定是人話或續行的頭。哪天中斷熬得過
   * 重開，這條會紅，那段的論證也要重寫。
   */
  it('重開 server 之後回答那顆舊中斷：拿真的 id 也是 no_such_interrupt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-serve-history-'));
    const first = await start(['--session-log', root, '--plugins', APPROVAL]);
    const before = await stopAtApproval(await serveClient(first), 'mu');
    const pending = before.pendings[0];
    if (pending === undefined) throw new Error('沒有掛著的核准請求');
    await stop(first);

    const second = await start(['--session-log', root, '--plugins', APPROVAL]);
    const client = await serveClient(second);
    const events = await client.openEvents('mu');
    const response = await client.inputRespond('mu', {
      namespace: [...pending.namespace],
      interrupt_id: pending.interruptId,
      response: { decisions: [{ type: 'approve' }] },
    });
    await events.return?.(undefined);

    expect(response).toMatchObject({
      type: 'error',
      error: 'no_such_interrupt',
      message: '這條 thread 上沒有等著回答的中斷',
    });
  });
});

describe('GET /threads/:id/history 的載體與協定層', () => {
  it('參數不是整數：協定層的 invalid_argument', async () => {
    const server = await start([]);
    const authed = fetchWithCookie(await exchangeServeToken(server.authenticatedUrl));
    const response = await authed(`${server.url}${historyPath('epsilon')}?beforeSeq=abc`, {
      headers: { 'content-type': 'application/json' },
    });

    expect(await response.json()).toMatchObject({ type: 'error', error: 'invalid_argument' });
  });

  it('beforeSeq 超出日誌：協定層的 invalid_argument', async () => {
    const server = await start([]);
    const page = await (
      await serveClient(server)
    ).threadHistory('zeta', {
      beforeSeq: 99,
    });

    expect(page.kind).toBe('rejected');
  });

  it('沒帶 application/json：415，同列表', async () => {
    const server = await start([]);
    const authed = fetchWithCookie(await exchangeServeToken(server.authenticatedUrl));
    const response = await authed(`${server.url}${historyPath('eta')}`);

    expect(response.status).toBe(415);
  });

  it('不是 GET：404', async () => {
    const server = await start([]);
    const authed = fetchWithCookie(await exchangeServeToken(server.authenticatedUrl));
    const response = await authed(`${server.url}${historyPath('theta')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(404);
  });
});
