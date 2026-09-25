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

import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { SessionEvent } from '@nexus/core';
import { toLoggedMessage } from '@nexus/core';

import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import {
  exchangeServeToken,
  fetchWithCookie,
  loopbackRequest,
  serveClient,
  TEST_BROWSER_AUTH,
} from './fixtures.js';
import { HISTORY_PAGE_MAX_BYTES } from '@nexus/wire';

import { DEFAULT_TOOL_TEXT_MAX_BYTES } from './settings/tool-text.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

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
  const APPROVAL = fileURLToPath(new URL('./approval.patch.yml', import.meta.url));

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
    const server = await start(['--patch', APPROVAL]);
    const client = await serveClient(server);
    await stopAtApproval(client, 'kappa');

    const state = await replayed(client, 'kappa');

    expect(state.entries.map(line)).toContain('tool:echo:running');
    expect(state.status).toBe('running');
  });

  it('對照：重開 server 之後中斷不在了，那張卡收成失敗', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-serve-history-'));
    const first = await start(['--session-log', root, '--patch', APPROVAL]);
    await stopAtApproval(await serveClient(first), 'lambda');
    await stop(first);

    const second = await start(['--session-log', root, '--patch', APPROVAL]);
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
    const first = await start(['--session-log', root, '--patch', APPROVAL]);
    const before = await stopAtApproval(await serveClient(first), 'mu');
    const pending = before.pendings[0];
    if (pending === undefined) throw new Error('沒有掛著的核准請求');
    await stop(first);

    const second = await start(['--session-log', root, '--patch', APPROVAL]);
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

/**
 * **軟上限撐破時 server 真的講得出話**（[#479](https://github.com/DemianLi/nexus-agent/issues/479)）。
 *
 * `historyPage` 那一層的判斷由 `conversation-history.test.ts` 釘著；這裡釘的是**接線**：route 有沒有
 * 把回呼接到 `createWireHandler` 的 `warn` 上。兩條線任何一條斷掉，那件事就完全看不見——回應照樣 200、
 * 畫面照樣對。用 `rootSeed` 直接餵一份超標的日誌，不必讓假模型真的讀 170 次檔。
 */
describe('一頁撐破位元組上限時，server 講一聲', () => {
  /**
   * 幾則滿版工具結果才撐得破一頁。170 × 50000 = 8.5 MB > 8 MB。seed 只帶文字、不帶 `meta`，所以要的
   * 則數是頁上限算法（每張卡文字加 meta，#617）的兩倍。
   */
  const OVERSIZED_CALLS = 170;

  function oversizedSeed(): SessionEvent[] {
    const ids = Array.from({ length: OVERSIZED_CALLS }, (_, i) => `c${i}`);
    const body = 'x'.repeat(DEFAULT_TOOL_TEXT_MAX_BYTES);
    const drafts: Pick<SessionEvent, 'type' | 'data'>[] = [
      { type: 'turn/start', data: { kind: 'message', text: '讀一堆檔。' } },
      {
        type: 'assistant/message',
        data: {
          message: toLoggedMessage(
            new AIMessage({
              content: '讀了。',
              tool_calls: ids.map((id) => ({
                id,
                name: 'read_file',
                args: { file_path: `/x/${id}` },
              })),
            }),
          ),
        },
      },
      ...ids.flatMap((id) => [
        { type: 'tool/call' as const, data: { callId: id, name: 'read_file', arguments: '{}' } },
        {
          type: 'tool/result' as const,
          data: {
            callId: id,
            isError: false,
            message: toLoggedMessage(new ToolMessage({ content: body, tool_call_id: id })),
          },
        },
      ]),
      { type: 'turn/end', data: {} },
    ];
    return drafts.map((draft, seq) => ({ ...draft, seq, time: 1000 + seq }) as SessionEvent);
  }

  /** 一顆什麼都不吐的 agent：這條測試不跑任何一輪，只打歷史路由。 */
  const idle: PumpAgent = {
    streamEvents: async () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true as const, value: undefined }),
      }),
    }),
    getState: async () => ({ values: {} }),
    updateState: async () => undefined,
  };

  /**
   * **這條的前提是 schema 的預設值，而 #538 之後那個值改得動。**
   *
   * 每則上限可設定了（`tool-text` 那一列），所以「170 則滿版會超過一頁上限」只在預設值
   * 底下成立——部署把它調小，這個 seed 就不再超標，這條測試會變成一條什麼都沒測的綠燈。
   * 那正是 #538 三選一裡第三條明著接受的代價。
   *
   * 所以前提寫成顯性斷言：**預設值哪天小到讓這個 seed 不再超標，這裡當場紅**，而不是靜靜空轉。
   */
  it('前提：預設上限底下，170 則滿版確實撐得破一頁', () => {
    expect(OVERSIZED_CALLS * DEFAULT_TOOL_TEXT_MAX_BYTES).toBeGreaterThan(HISTORY_PAGE_MAX_BYTES);
  });

  /**
   * **`createWireHandler` 真的把那一格轉給重播那條**（[#538](https://github.com/DemianLi/nexus-agent/issues/538)）。
   *
   * `tool-card-from-log.test.ts` 那條驗的是 `ThreadPump` 與 `historyFrames` 收得到上限，但它
   * **直接建 pump**——handler 忘了把設定往下傳的話，那一條照樣綠。這一條走的是真的 route，
   * 所以釘的是 `createWireHandler` 裡那兩個轉發點。
   *
   * 兩臂：同一份 seed、同一條 route，只差 handler 收到的那一格。
   */
  it('handler 收到的上限真的走到重播那條路上', async () => {
    const long = 'x'.repeat(2_000);
    const seed = oversizedSeed().slice(0, 6);
    // seed 的第六筆是第一則 `tool/result`，把它的內容換成一段夠長的文字。
    const withLong = seed.map((event) =>
      event.type === 'tool/result'
        ? ({
            ...event,
            data: {
              ...event.data,
              message: toLoggedMessage(new ToolMessage({ content: long, tool_call_id: 'c0' })),
            },
          } as SessionEvent)
        : event,
    );

    async function textFor(toolTextLimits?: { maxBytes: number }): Promise<string> {
      const handler = createWireHandler({
        auth: TEST_BROWSER_AUTH,
        ...(toolTextLimits !== undefined && { toolTextLimits }),
        createAgent: async () => ({
          agent: idle,
          commands: { find: () => undefined, list: () => [] },
          dispose: async () => undefined,
          rootSeed: withLong,
        }),
      });
      try {
        const response = await handler.handle(
          loopbackRequest(`http://wire.test${historyPath('big')}`, {
            method: 'GET',
            headers: { 'content-type': 'application/json' },
          }),
        );
        expect(response.status).toBe(200);
        // **判準不挑 frame 的內部欄位**：整頁序列化之後那段文字在不在。第一版挑了
        // `params.data.text`，猜錯欄位名、當場紅；換成這個之後，frame 的形狀哪天變了，
        // 這一條仍然問得出同一件事。
        return JSON.stringify((await response.json()) as unknown);
      } finally {
        await handler.close();
      }
    }

    // 前提：不給那一格時，那段文字整段都在——沒有這一行，下面那句可能只是「它根本沒出現過」。
    const bare = await textFor();
    expect(bare).toContain(long);
    expect(bare).not.toContain('沒有送出來');

    const capped = await textFor({ maxBytes: 300 });
    expect(capped).not.toContain(long);
    expect(capped).toContain('沒有送出來');
  });

  it('超標那一頁走過 route 之後，warn 收到一行；正常的一頁不講', async () => {
    for (const [label, seed, expected] of [
      ['超標', oversizedSeed(), 1],
      ['正常', oversizedSeed().slice(0, 6), 0],
    ] as const) {
      const said: string[] = [];
      const handler = createWireHandler({
        auth: TEST_BROWSER_AUTH,
        warn: (message) => void said.push(message),
        createAgent: async () => ({
          agent: idle,
          commands: { find: () => undefined, list: () => [] },
          dispose: async () => undefined,
          rootSeed: seed,
        }),
      });
      try {
        const response = await handler.handle(
          loopbackRequest(`http://wire.test${historyPath('big')}`, {
            method: 'GET',
            headers: { 'content-type': 'application/json' },
          }),
        );
        expect(response.status, label).toBe(200);
        expect(said, label).toHaveLength(expected);
        if (expected === 1) expect(said[0]).toMatch(/一頁超過上限/u);
      } finally {
        await handler.close();
      }
    }
  });
});
