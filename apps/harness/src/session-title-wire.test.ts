/**
 * 退回標題在產品路徑上的樣子（[#647](https://github.com/DemianLi/nexus-agent/issues/647)）：誰在什麼時刻寫、線上送出什麼、
 * 歷史帶什麼、模型看不看得到。規則本身在 `session-title.test.ts`。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`，CLI 走 `--live` 以外的預設（echo）。
 */

import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { MemorySaver } from '@langchain/langgraph';
import { SessionLog } from '@nexus/core';
import type { GoalId, SessionEvent } from '@nexus/core';
import type { Event, TitlePayload } from '@nexus/wire';
import { emptyConversation, historyPath, INBOX, reduceAll, TITLE } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { runCli } from './cli.js';
import { historyPage } from './conversation-history.js';
import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

/** 超過 40 個位元組，所以標題是截過的、跟這句話本身不一樣。 */
const FIRST = '請幫我把登入頁面的錯誤訊息改成中文並補上測試';
const FIRST_TITLE = '請幫我把登入頁面的錯誤訊息';

function titleEvents(events: readonly SessionEvent[]): SessionEvent<'session/title'>[] {
  return events.filter(
    (event): event is SessionEvent<'session/title'> => event.type === 'session/title',
  );
}

function titlePushes(frames: readonly Event[]): TitlePayload[] {
  return frames.flatMap((frame) => {
    const data = frame.params.data as { name?: unknown; payload?: unknown } | null;
    return frame.method === 'custom' && data?.name === TITLE ? [data.payload as TitlePayload] : [];
  });
}

function isInboxClaim(frame: Event): boolean {
  const data = frame.params.data as { name?: unknown; payload?: { claimed?: unknown } } | null;
  return frame.method === 'custom' && data?.name === INBOX && data.payload?.claimed !== undefined;
}

function isTitlePush(frame: Event): boolean {
  return titlePushes([frame]).length > 0;
}

/** 一條真的組裝的 thread，加一條訂了全部 channel 的下行。沒接落盤：日誌只在記憶體裡。 */
async function openReal(replies: readonly string[], seed?: readonly SessionEvent[]) {
  const model = new ScriptedChatModel({ turns: replies.map((content) => ({ content })) });
  const built = await createNexusAgent({ model, checkpointer: new MemorySaver(), plugins: [] });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'title-real', undefined, seed);
  const detach = built.attachSession(pump.sessions);
  const frames: Event[] = [];
  const line = new AbortController();
  const stream = pump.subscribe(['messages', 'tools', 'lifecycle', 'input', 'custom'], line.signal);
  const draining = (async () => {
    for await (const frame of stream) frames.push(frame);
  })();
  return {
    model,
    pump,
    frames,
    close: async () => {
      pump.close();
      line.abort();
      await draining;
      detach();
      await built.dispose();
    },
  };
}

describe('web 那條：開跑時寫一次、推一顆', () => {
  it('第一句開跑：領走之後、模型之前寫一顆，線上推一顆，折出來就是它；第二句不再寫', async () => {
    const thread = await openReal(['第一個回覆。', '第二個回覆。']);
    try {
      await thread.pump.submit({ kind: 'message', text: FIRST });
      await thread.pump.submit({ kind: 'message', text: '再改一下按鈕' });
      await thread.pump.whenIdle();

      const events = thread.pump.sessionLog.events;
      const titles = titleEvents(events);
      const firstStart = events.find((event) => event.type === 'turn/start')!;
      expect(titles.map((event) => event.data)).toEqual([
        { title: FIRST_TITLE, messageSeqs: [firstStart.seq], source: { kind: 'fallback' } },
      ]);
      // 日誌上的先後：`turn/start` → 領走 → 標題 → 這一輪的第一次模型呼叫。
      const order = events
        .filter((event) => event.seq > firstStart.seq)
        .map((event) => event.type)
        .filter((type) => ['inbox/spliced', 'session/title', 'model/start'].includes(type));
      expect(order.slice(0, 3)).toEqual(['inbox/spliced', 'session/title', 'model/start']);

      // 線上：一顆，落在領走那顆推送之後、這一輪第一顆 `messages` 之前。
      expect(titlePushes(thread.frames)).toEqual([{ title: FIRST_TITLE }]);
      const at = thread.frames.findIndex(isTitlePush);
      expect(thread.frames.findIndex(isInboxClaim)).toBeLessThan(at);
      expect(thread.frames.findIndex((frame) => frame.method === 'messages')).toBeGreaterThan(at);
      expect(reduceAll(emptyConversation(), thread.frames).title).toBe(FIRST_TITLE);
    } finally {
      await thread.close();
    }
  }, 20000);

  it('只進日誌：第二輪模型讀到的對話裡沒有標題那一則', async () => {
    const thread = await openReal(['第一個回覆。', '第二個回覆。']);
    try {
      await thread.pump.submit({ kind: 'message', text: FIRST });
      await thread.pump.submit({ kind: 'message', text: '再改一下按鈕' });
      await thread.pump.whenIdle();
      expect(titleEvents(thread.pump.sessionLog.events)).toHaveLength(1);
      const second = thread.model.prompts[1] ?? [];
      // 模型那一側：系統提示、兩句人話、一則回覆，**沒有多一則**，也沒有一則是標題本身。
      expect(second.map((message) => message.getType())).toEqual([
        'system',
        'human',
        'ai',
        'human',
      ]);
      expect(second.map((message) => message.text)).not.toContain(FIRST_TITLE);
    } finally {
      await thread.close();
    }
  }, 20000);

  it('18 以前的日誌接回來：目標排的一輪不寫；下一句人話開跑時補寫，推的是整份日誌裡第一則', async () => {
    const old = new SessionLog('title-real');
    old.append('turn/start', { kind: 'message', text: '上一個行程的第一句' });
    old.append('turn/end', {});
    const thread = await openReal(['續行的回覆。', '這一句的回覆。'], old.events);
    try {
      await thread.pump.submit({
        kind: 'goal',
        text: '繼續做',
        goalId: 'g1' as GoalId,
        revision: 1,
        round: 1,
      });
      expect(titleEvents(thread.pump.sessionLog.events)).toEqual([]);
      await thread.pump.submit({ kind: 'message', text: '接回來之後的一句' });
      await thread.pump.whenIdle();
      expect(titleEvents(thread.pump.sessionLog.events).map((event) => event.data)).toEqual([
        { title: '上一個行程的第一句', messageSeqs: [0], source: { kind: 'fallback' } },
      ]);
      expect(titlePushes(thread.frames)).toEqual([{ title: '上一個行程的第一句' }]);
    } finally {
      await thread.close();
    }
  }, 20000);
});

describe('歷史：只在最新一頁帶目前的標題', () => {
  function pushesOf(page: ReturnType<typeof historyPage>): TitlePayload[] {
    return titlePushes(page.events as Event[]);
  }

  it('最新一頁帶、往前翻的那頁不帶', () => {
    const log = new SessionLog('t');
    for (const text of [FIRST, '第二句', '第三句']) {
      log.append('turn/start', { kind: 'message', text });
      if (text === FIRST) {
        log.append('session/title', {
          title: '記下的標題',
          messageSeqs: [0],
          source: { kind: 'fallback' },
        });
      }
      log.append('turn/end', {});
    }
    const latest = historyPage(log.events, { maxMessages: 1 });
    expect(pushesOf(latest)).toEqual([{ title: '記下的標題' }]);
    expect(reduceAll(emptyConversation(), latest.events as Event[]).title).toBe('記下的標題');
    const earlier = historyPage(log.events, { maxMessages: 1, beforeSeq: latest.firstSeq });
    expect(pushesOf(earlier)).toEqual([]);
  });

  it('18 以前的日誌：照同一條規則當場推；一則人話都沒有就不送', () => {
    const old = new SessionLog('t');
    old.append('turn/start', { kind: 'message', text: FIRST });
    old.append('turn/end', {});
    expect(pushesOf(historyPage(old.events))).toEqual([{ title: FIRST_TITLE }]);
    // 上限照傳進來的那一份，不是預設：9 個位元組是三個中文字。
    expect(
      pushesOf(
        historyPage(old.events, {}, undefined, undefined, undefined, { maxWords: 5, maxBytes: 9 }),
      ),
    ).toEqual([{ title: '請幫我' }]);
    expect(pushesOf(historyPage(new SessionLog('空').events))).toEqual([]);
  });
});

/** CLI 那一次 run 目錄裡的日誌。 */
async function cliEvents(root: string): Promise<SessionEvent[]> {
  const [runDir] = await readdir(root);
  return (await readFile(join(root, runDir!, 'cli.jsonl'), 'utf8'))
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
}

describe('CLI 那條', () => {
  it('跑一輪，那份日誌也有這一顆；上限是清單上那一列的值，不是預設', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-title-log-'));
    const patchDir = await mkdtemp(join(tmpdir(), 'nexus-title-patch-'));
    const patch = join(patchDir, 'title.patch.yml');
    await writeFile(patch, '- id: thread-title\n  config:\n    maxWords: 5\n    maxBytes: 9\n');
    await runCli({
      argv: ['--session-log', root, '--patch', patch, FIRST],
      input: new PassThrough(),
      output: new PassThrough(),
      printer: { log: () => undefined, error: () => undefined },
    });
    const events = await cliEvents(root);
    const start = events.find((event) => event.type === 'turn/start')!;
    expect(titleEvents(events).map((event) => event.data)).toEqual([
      { title: '請幫我', messageSeqs: [start.seq], source: { kind: 'fallback' } },
    ]);
  }, 20000);
});

describe('上限從組裝一路傳到用的那一刻', () => {
  it('pump 建構時就驗：上限壞了當場拋，不等到第一句開跑', () => {
    const idle = {} as PumpAgent;
    expect(
      () =>
        new ThreadPump(idle, 't', undefined, undefined, undefined, { maxWords: 0, maxBytes: 40 }),
    ).toThrow(/maxWords/);
  });

  it('serve 的歷史路由：舊日誌當場推的標題照 createWireHandler 拿到的上限截', async () => {
    const old = new SessionLog('old');
    old.append('turn/start', { kind: 'message', text: FIRST });
    old.append('turn/end', {});
    const idle = {} as PumpAgent;

    async function historyTitle(limits?: { maxWords: number; maxBytes: number }) {
      const handler = createWireHandler({
        auth: TEST_BROWSER_AUTH,
        ...(limits !== undefined && { threadTitleLimits: limits }),
        createAgent: async () => ({
          agent: idle,
          commands: emptyCommandPoint(),
          dispose: async () => undefined,
          rootSeed: old.events,
        }),
      });
      try {
        const response = await handler.handle(
          loopbackRequest(`http://wire.test${historyPath('old')}`, {
            method: 'GET',
            headers: { 'content-type': 'application/json' },
          }),
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as { result: { events: Event[] } };
        return titlePushes(body.result.events);
      } finally {
        await handler.close();
      }
    }

    expect(await historyTitle()).toEqual([{ title: FIRST_TITLE }]);
    expect(await historyTitle({ maxWords: 5, maxBytes: 9 })).toEqual([{ title: '請幫我' }]);
  });

  it('CLI 的 REPL 那條也吃清單上的值', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-title-repl-'));
    const patchDir = await mkdtemp(join(tmpdir(), 'nexus-title-patch-'));
    const patch = join(patchDir, 'title.patch.yml');
    await writeFile(patch, '- id: thread-title\n  config:\n    maxWords: 5\n    maxBytes: 9\n');
    const input = new PassThrough();
    const running = runCli({
      argv: ['--session-log', root, '--patch', patch],
      input,
      output: new PassThrough(),
      printer: { log: () => undefined, error: () => undefined },
    });
    input.end(`${FIRST}\n`);
    await running;
    expect(titleEvents(await cliEvents(root)).map((event) => event.data.title)).toEqual(['請幫我']);
  }, 20000);
});
