/**
 * **模型回覆講到一半時才接上的下行，要補到進行中那則**——[#953](https://github.com/DemianLi/nexus-agent/issues/953) 第二刀。
 *
 * 照 dsh 的重連 baseline（`packages/api/session-controller/src/client/sessions/assistant-stream.ts` 的 `replace`，
 * `5badb15009a`）：進行中那一次嘗試已吐出的前綴在連上時一次交出，之後的即時片段接在後面。我們的下行與歷史是兩個請求
 * （web 先開下行、再拿歷史），所以多了 dsh 沒有的兩件事，這裡逐個釘：
 *
 * - **回覆要撐到 `assistant/message` 落盤才放掉，不是撐到 `message-finish`**：量過，pump 先看到 `message-finish`、日誌後寫，
 *   中間那段接上的下行，歷史沒有它、線上也沒有，回覆就憑空消失。
 * - **補送與歷史可能重疊**（回覆在開線與拿歷史之間落盤了）：折疊器照訊息 id 擋，畫面上不會是同一則兩次。
 *
 * **零憑證、零外部連線**：假 agent，frame 由測試一顆一顆餵進去，所以「接上的那一刻」是確定的。
 */

import { AIMessage } from '@langchain/core/messages';
import { toLoggedMessage } from '@nexus/core';
import type { ConversationState, Event } from '@nexus/wire';
import { emptyConversation, reduceAll, reduceConversation } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { historyFrames } from './conversation-history.js';
import { DEFAULT_TOOL_TEXT_MAX_BYTES } from './settings/tool-text.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

type AiEntry = Extract<ConversationState['entries'][number], { kind: 'ai' }>;

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const CHANNELS = ['messages', 'tools', 'lifecycle', 'input', 'custom'] as const;

const raw = (method: string, data: unknown, node?: string) => ({
  type: 'event',
  seq: 0,
  method,
  params: {
    namespace: [] as string[],
    timestamp: 0,
    ...(node === undefined ? {} : { node }),
    data,
  },
});

const start = (runId: string, id: string, role = 'ai') =>
  raw('messages', { event: 'message-start', role, run_id: runId, id });
const text = (runId: string, value: string) =>
  raw('messages', {
    event: 'content-block-delta',
    run_id: runId,
    index: 0,
    delta: { type: 'text-delta', text: value },
  });
const reasoning = (runId: string, value: string) =>
  raw('messages', {
    event: 'content-block-delta',
    run_id: runId,
    index: 1,
    delta: { type: 'reasoning-delta', reasoning: value },
  });
const finish = (runId: string) =>
  raw('messages', { event: 'message-finish', run_id: runId, reason: 'stop' });
const COMPLETED = raw('lifecycle', { event: 'completed', graph_name: 'root' });
const INTERRUPT = raw(
  'updates',
  { values: [{ id: 'int-1', value: { actionRequests: [{ name: 'danger', args: {} }] } }] },
  '__interrupt__',
);

/** 一輪裡的 frame 由測試一顆一顆餵：`push` 回來時 pump 已經抽到並廣播出去了。 */
function fedAgent() {
  const pending: unknown[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const agent = {
    streamEvents: async (_input: unknown, config: { configurable: Record<string, unknown> }) => {
      // 按了停止：像被切斷的模型請求那樣拋，pump 認的是中止訊號已經觸發（#276）。
      const signal = Object.values(config.configurable).find(
        (value): value is AbortSignal => value instanceof AbortSignal,
      );
      signal?.addEventListener('abort', () => wake?.(), { once: true });
      return (async function* () {
        for (;;) {
          while (pending.length > 0) yield pending.shift();
          if (signal?.aborted === true) throw new Error('被切斷了');
          if (ended) return;
          await new Promise<void>((resolve) => (wake = resolve));
          wake = undefined;
        }
      })();
    },
    getState: async () => ({ values: {} }),
    updateState: async () => ({}),
  };
  return {
    agent: agent as unknown as PumpAgent,
    feed: (frame: unknown) => {
      pending.push(frame);
      wake?.();
    },
    end: () => {
      ended = true;
      wake?.();
    },
  };
}

const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const item of open.splice(0)) await item.close();
});

/** 一個 pump、一條一開始就掛著的下行（用來知道 pump 抽到哪了），與開跑的一輪。 */
async function running() {
  const fed = fedAgent();
  const pump = new ThreadPump(fed.agent, 'baseline-root');
  const observer = join(pump);
  open.push({
    close: async () => {
      fed.end();
      pump.close();
      await observer.close();
    },
  });
  pump.submit({ kind: 'message', text: '嗨', id: 'item-1' }).catch(() => undefined);
  await until(() => pump.sessionLog.events.some((event) => event.type === 'turn/start'));
  return {
    pump,
    /** 餵一顆、不等：給會被 pump 丟掉、不上線的那幾顆。 */
    feed: fed.feed,
    /** 餵一顆、等它上線。 */
    async send(frame: ReturnType<typeof raw>) {
      const before = observer.frames.length;
      fed.feed(frame);
      await until(() => observer.frames.length > before);
    },
    finishTurn: async () => {
      fed.feed(COMPLETED);
      fed.end();
      await pump.whenIdle();
    },
  };
}

/** 開一條下行：註冊是同步的，補送的 frame 這一刻就排進佇列了。 */
function join(pump: ThreadPump) {
  const frames: Event[] = [];
  const line = new AbortController();
  const draining = (async () => {
    for await (const frame of pump.subscribe(CHANNELS, line.signal)) frames.push(frame);
  })();
  return {
    frames,
    close: async () => {
      line.abort();
      await draining;
    },
  };
}

/** web 的折法：下行先開、歷史後拿、先折歷史、再折排著的與之後的 frame。 */
function fold(pump: ThreadPump, live: readonly Event[]): ConversationState {
  const history = historyFrames(pump.sessionLog.events, DEFAULT_TOOL_TEXT_MAX_BYTES);
  return live.reduce(reduceConversation, reduceAll(emptyConversation(), history));
}

const aiEntries = (state: ConversationState) =>
  state.entries
    .filter((entry): entry is AiEntry => entry.kind === 'ai')
    .map(({ text: body, reasoning: thought, streaming }) => ({
      text: body,
      reasoning: thought,
      streaming,
    }));

describe('回覆串流到一半才接上的下行', () => {
  it('剛開頭、還沒有字：補到一則空的、正在吐字的回覆，之後的字接得上', async () => {
    const run = await running();
    await run.send(start('r1', 'run-r1'));

    const joined = join(run.pump);
    open.push(joined);
    await until(() => joined.frames.length >= 1);
    expect(joined.frames.map((frame) => (frame.params.data as { event: string }).event)).toEqual([
      'message-start',
    ]);
    expect(aiEntries(fold(run.pump, joined.frames))).toEqual([
      { text: '', reasoning: undefined, streaming: true },
    ]);

    await run.send(text('r1', '你好'));
    await run.send(finish('r1'));
    await until(() => joined.frames.length >= 3);
    expect(aiEntries(fold(run.pump, joined.frames))).toEqual([
      { text: '你好', reasoning: undefined, streaming: false },
    ]);
  });

  it('串流到一半：已吐出的字一次補齊，之後的字接在後面，整則與原文完全相等', async () => {
    const run = await running();
    await run.send(start('r1', 'run-r1'));
    await run.send(text('r1', '這是一段'));
    await run.send(text('r1', '慢慢吐'));

    const joined = join(run.pump);
    open.push(joined);
    await until(() => joined.frames.length >= 2);
    expect(aiEntries(fold(run.pump, joined.frames))).toEqual([
      { text: '這是一段慢慢吐', reasoning: undefined, streaming: true },
    ]);

    await run.send(text('r1', '出來的回覆。'));
    await run.send(finish('r1'));
    await until(() => joined.frames.length >= 4);
    expect(aiEntries(fold(run.pump, joined.frames))).toEqual([
      { text: '這是一段慢慢吐出來的回覆。', reasoning: undefined, streaming: false },
    ]);
  });

  it('有推理的那一則：推理與正文各補一塊，之後的接得上', async () => {
    const run = await running();
    await run.send(start('r1', 'run-r1'));
    await run.send(reasoning('r1', '先想'));
    await run.send(reasoning('r1', '一下'));
    await run.send(text('r1', '好'));

    const joined = join(run.pump);
    open.push(joined);
    await until(() => joined.frames.length >= 3);
    await run.send(reasoning('r1', '，再想'));
    await run.send(text('r1', '了。'));
    await until(() => joined.frames.length >= 5);
    expect(aiEntries(fold(run.pump, joined.frames))).toEqual([
      { text: '好了。', reasoning: '先想一下，再想', streaming: true },
    ]);
  });

  it('已收尾但還沒落進日誌：照樣補送整則（含收尾），落盤之後接上的就不再補', async () => {
    const run = await running();
    await run.send(start('r1', 'run-r1'));
    await run.send(text('r1', '講完了'));
    await run.send(finish('r1'));

    const during = join(run.pump);
    open.push(during);
    await until(() => during.frames.length >= 3);
    expect(aiEntries(fold(run.pump, during.frames))).toEqual([
      { text: '講完了', reasoning: undefined, streaming: false },
    ]);

    run.pump.sessionLog.append('assistant/message', {
      message: toLoggedMessage(new AIMessage({ content: '講完了', id: 'run-r1' })),
    });
    const after = join(run.pump);
    open.push(after);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(after.frames).toEqual([]);
  });

  it('補送之後、拿歷史之前回覆落盤了：歷史與補送各有一份，畫面上只有一則', async () => {
    const run = await running();
    await run.send(start('r1', 'run-r1'));
    await run.send(text('r1', '講完了'));
    await run.send(finish('r1'));

    // web 的順序：先開下行（補送這時就排進佇列）……
    const joined = join(run.pump);
    open.push(joined);
    await until(() => joined.frames.length >= 3);
    // ……回覆在開線與拿歷史之間落盤……
    run.pump.sessionLog.append('assistant/message', {
      message: toLoggedMessage(new AIMessage({ content: '講完了', id: 'run-r1' })),
    });
    // ……然後才拿歷史、折，再折排著的補送。
    const state = fold(run.pump, joined.frames);
    expect(aiEntries(state)).toEqual([{ text: '講完了', reasoning: undefined, streaming: false }]);
  });

  it('補送在號上排在已經排著的中斷之後：兩樣都留得下來', async () => {
    const run = await running();
    await run.send(start('r1', 'run-r1'));
    await run.send(text('r1', '等你核准'));
    await run.send(INTERRUPT);

    const joined = join(run.pump);
    open.push(joined);
    await until(() => joined.frames.length >= 3);
    const seqs = joined.frames.map((frame) => frame.seq ?? -1);
    expect(joined.frames.map((frame) => frame.method)).toEqual([
      'input.requested',
      'messages',
      'messages',
    ]);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const state = fold(run.pump, joined.frames);
    expect(state.pendings).toHaveLength(1);
    expect(aiEntries(state)).toEqual([{ text: '等你核准', reasoning: undefined, streaming: true }]);
  });

  it('圖裡注進來的人話不補送：那一則線上從沒出現過', async () => {
    const run = await running();
    run.feed(start('h1', 'h1', 'human'));
    run.feed(text('h1', '注進來的話'));
    run.feed(finish('h1'));
    // 這三顆都被 pump 丟掉、不上線，沒有「上線了」可以等：讓它抽一輪。
    await new Promise((resolve) => setTimeout(resolve, 20));

    const joined = join(run.pump);
    open.push(joined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(joined.frames).toEqual([]);
  });

  it('下一則回覆開頭取代上一則：補送的是最新那一則', async () => {
    const run = await running();
    await run.send(start('r1', 'run-r1'));
    await run.send(text('r1', '第一則'));
    await run.send(finish('r1'));
    run.pump.sessionLog.append('assistant/message', {
      message: toLoggedMessage(new AIMessage({ content: '第一則', id: 'run-r1' })),
    });
    await run.send(start('r2', 'run-r2'));
    await run.send(text('r2', '第二'));

    const joined = join(run.pump);
    open.push(joined);
    await until(() => joined.frames.length >= 2);
    expect(aiEntries(fold(run.pump, joined.frames))).toEqual([
      { text: '第一則', reasoning: undefined, streaming: false },
      { text: '第二', reasoning: undefined, streaming: true },
    ]);
  });

  it('停止與重新整理撞在一起（#1044）：補送排著、回覆才被記成中斷的半段，畫面上仍只有一則', async () => {
    const run = await running();
    await run.send(start('r1', 'run-r1'));
    await run.send(text('r1', '講到一半'));

    // web 的順序：先開下行（補送這時排進佇列，歷史那時還沒有這一則）……
    const joined = join(run.pump);
    open.push(joined);
    await until(() => joined.frames.length >= 2);
    // ……停止，pump 把使用者看到的半段記進日誌……
    run.pump.cancel();
    await until(() =>
      run.pump.sessionLog.events.some(
        (event) => event.type === 'assistant/message' && event.data.interrupted === true,
      ),
    );
    // ……然後才拿歷史、折，再折排著的補送。
    const state = fold(run.pump, joined.frames);
    expect(aiEntries(state)).toEqual([
      { text: '講到一半', reasoning: undefined, streaming: false },
    ]);
  });

  it('這一輪收完之後接上的下行：什麼都不補', async () => {
    const run = await running();
    await run.send(start('r1', 'run-r1'));
    await run.send(text('r1', '結束'));
    await run.send(finish('r1'));
    run.pump.sessionLog.append('assistant/message', {
      message: toLoggedMessage(new AIMessage({ content: '結束', id: 'run-r1' })),
    });
    await run.finishTurn();

    const joined = join(run.pump);
    open.push(joined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(joined.frames).toEqual([]);
  });
});
