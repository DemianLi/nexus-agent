/**
 * **條目的時刻在真的線上量**——[#1030](https://github.com/DemianLi/nexus-agent/issues/1030) 的 harness 那一半。
 *
 * 折疊器把 frame 的 `params.timestamp` 填進 entry 的 `startedAt`／`settledAt`。兩條路的時鐘不同：歷史重播的 frame 帶日誌
 * 那一筆的 `time`；即時的是基座 frame 原帶的、或 pump 合成那一刻的 `Date.now()`。這裡走產品組裝（`createCliAgent` 的出貨清單、
 * `createWireHandler`、wire client 的下行與歷史路由），模型是腳本，把同一輪的每一格在兩條路上各折一次，**逐格減去它在 root
 * 日誌上對應那一筆的 `time`**：
 *
 * | 條目 | 對應的日誌那一筆 |
 * | --- | --- |
 * | 人話 | `turn/start` |
 * | 模型回覆 | `startedAt` 比它所屬那一次呼叫的 `model/start`（`assistant/message.modelCall` 指的那顆）、`settledAt` 比同一個訊息 id 的 `assistant/message` |
 * | 工具卡 | `startedAt` 比第一顆 `tool/call`、`settledAt` 比 `tool/result` |
 *
 * **量具先自我校準**：歷史那條的每一格差值必須正好是 0——不是 0 就是量具讀錯了欄位或配錯了對，先修量具。腳本的模型
 * 每吐一個字等一下、工具本體睡一段：沒有這兩段刻意的延遲，「兩條路真的不同」與「兩個值剛好一樣」分不開。
 *
 * 設了 `NEXUS_ENTRY_TIME_REPORT`（一個檔案路徑）就把每一格的差值以一行 JSON 附加進去，PR 的數字從那裡來。
 *
 * **零憑證、零外部連線**：模型是腳本，工作區是暫存目錄。
 */

import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tool } from '@langchain/core/tools';
import type { PluginEntry, SessionEvent, SessionRegistry } from '@nexus/core';
import { loggedMessageId } from '@nexus/core';
import { ASK_USER_QUESTION_TOOL_NAME } from '@nexus/plugin-ask-user';
import type { ConversationEntry, Event } from '@nexus/wire';
import { answerResponse, createWireClient, emptyConversation, reduceAll } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createCliAgent } from './assembly-root.js';
import {
  TEST_BROWSER_AUTH,
  loopbackRequest,
  shippedPlugins,
  withScriptedModel,
} from './fixtures.js';
import type { ScriptedTurn } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const shipped = await shippedPlugins();

const BASE_URL = 'http://entry-time.test';
const THREAD_ID = 'entry-time';
/** 模型每吐一個字等這麼久。 */
const TOKEN_DELAY_MS = 15;
/** 工具本體睡這麼久。 */
const TOOL_MS = 120;
/** 「貼著日誌」的界線，比回覆 `startedAt` 早於日誌的那一段（至少 84 毫秒）還小。 */
const NEAR_MS = 40;
/** 停在問答上之後，等這麼久才回答。 */
const WAIT_MS = 150;
const DAYS = [{ label: '週一' }, { label: '週二' }];
const FIRST = '先慢慢查一下。';
const SECOND = '查好了。';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const SLOW: PluginEntry = {
  plugin: {
    name: 'slow-lookup',
    apply(registry) {
      registry.tools.register(
        tool(
          async () => {
            await new Promise((resolve) => setTimeout(resolve, TOOL_MS));
            return '查到了。';
          },
          { name: 'slow_lookup', description: '慢慢查。', schema: z.object({}) },
        ),
      );
    },
  },
};

interface Outcome {
  readonly live: readonly Event[];
  readonly history: readonly Event[];
  readonly log: readonly SessionEvent[];
}

/**
 * 經 wire 跑一輪：開下行、送一句、抽到 root 收工，再拿歷史。同 `present-tool.test.ts` 的 `run`。
 *
 * @param turns - 模型腳本。
 * @param answer - 給了就是這一輪會停在一顆問答上：停下來（root 那顆 `completed` 到了、中斷還掛著）之後等
 *   {@link WAIT_MS}，再拿它的回傳值回答那一顆。
 */
async function run(turns: readonly ScriptedTurn[], answer?: () => unknown): Promise<Outcome> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-entry-time-'));
  roots.push(root);
  const built = await createCliAgent(
    { live: false, workspace: root },
    withScriptedModel([...shipped, SLOW], turns),
    root,
  );
  let sessions: SessionRegistry | undefined;
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: built.commands,
      dispose: built.dispose,
      // **圍堵的日誌要接上**：沒接的話 `tool/call`／`tool/result` 不記，量具就不在產品路徑上。
      attachSessions: (registry, backgroundPort) => {
        sessions = registry;
        return built.attachSessions(registry, backgroundPort);
      },
    }),
  });
  const client = createWireClient({
    baseUrl: BASE_URL,
    fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
  });
  const live: Event[] = [];
  try {
    const events = await client.openEvents(THREAD_ID);
    await client.runStart(THREAD_ID, '查一下。');
    let asked: Event | undefined;
    for (;;) {
      const next = await events.next();
      if (next.done === true) break;
      live.push(next.value);
      if (next.value.method === 'input.requested') asked = next.value;
      const data = next.value.params.data as { event?: string; graph_name?: string };
      if (next.value.method !== 'lifecycle' || data.graph_name !== 'root') continue;
      if (data.event === 'failed') break;
      if (data.event !== 'completed') continue;
      // 停在中斷上時 root 照樣發 `completed`：那一顆不是收工。
      if (asked === undefined || answer === undefined) break;
      const { interrupt_id } = asked.params.data as { interrupt_id: string };
      await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
      await client.inputRespond(THREAD_ID, {
        namespace: [...asked.params.namespace],
        interrupt_id,
        response: answer(),
      });
      asked = undefined;
    }
    await new Promise((resolve) => setImmediate(resolve));
    const page = await client.threadHistory(THREAD_ID);
    if (page.kind !== 'ok') throw new Error(`歷史拿不到：${page.message}`);
    await events.return?.(undefined);
    if (sessions === undefined) throw new Error('attachSessions 沒被叫到');
    return { live, history: page.result.events, log: [...sessions.root.events] };
  } finally {
    await handler.close();
  }
}

/** 一格的差值：entry 的時刻減日誌那一筆的 `time`。 */
interface Row {
  readonly path: 'live' | 'history';
  readonly kind: 'human' | 'ai' | 'tool';
  readonly field: 'startedAt' | 'settledAt';
  readonly anchor: string;
  /** 毫秒；entry 沒有這一格是 `null`。 */
  readonly delta: number | null;
}

/**
 * 把一條路折出來的條目逐格配上日誌，算差值。
 *
 * @param path - 哪一條路。
 * @param entries - 那條路折出來的條目。
 * @param log - root 日誌。
 * @returns 每一格一列。
 */
function measure(
  path: Row['path'],
  entries: readonly ConversationEntry[],
  log: readonly SessionEvent[],
): Row[] {
  const rows: Row[] = [];
  const turnStarts = log.filter((event) => event.type === 'turn/start');
  const humans = entries.filter((entry) => entry.kind === 'human');
  humans.forEach((entry, index) => {
    const anchor = turnStarts[index];
    if (anchor === undefined) throw new Error(`第 ${index} 則人話配不到 turn/start`);
    rows.push({
      path,
      kind: 'human',
      field: 'startedAt',
      anchor: 'turn/start',
      delta: entry.startedAt === undefined ? null : entry.startedAt - anchor.time,
    });
  });
  for (const entry of entries) {
    if (entry.kind === 'ai') {
      const anchor = log.find(
        (event) =>
          event.type === 'assistant/message' &&
          loggedMessageId(event.data.message) === entry.messageId,
      );
      if (anchor === undefined || anchor.type !== 'assistant/message') {
        throw new Error(`回覆 ${entry.id} 配不到 assistant/message`);
      }
      // 開始的那一格對**這則回覆所屬那一次**呼叫的 `model/start`（#1048），不是整輪第一顆。
      const modelStart = log.find(
        (event) => event.type === 'model/start' && event.seq === anchor.data.modelCall,
      );
      if (modelStart === undefined) throw new Error(`回覆 ${entry.id} 配不到 model/start`);
      for (const field of ['startedAt', 'settledAt'] as const) {
        const value = entry[field];
        const base = field === 'startedAt' ? modelStart : anchor;
        rows.push({
          path,
          kind: 'ai',
          field,
          anchor: base.type,
          delta: value === undefined ? null : value - base.time,
        });
      }
    }
    if (entry.kind === 'tool') {
      const call = log.find(
        (event) => event.type === 'tool/call' && event.data.callId === entry.callId,
      );
      const result = log.find(
        (event) => event.type === 'tool/result' && event.data.callId === entry.callId,
      );
      if (call === undefined || result === undefined) {
        throw new Error(`工具卡 ${entry.callId} 配不到 tool/call 或 tool/result`);
      }
      rows.push({
        path,
        kind: 'tool',
        field: 'startedAt',
        anchor: 'tool/call',
        delta: entry.startedAt === undefined ? null : entry.startedAt - call.time,
      });
      rows.push({
        path,
        kind: 'tool',
        field: 'settledAt',
        anchor: 'tool/result',
        delta: entry.settledAt === undefined ? null : entry.settledAt - result.time,
      });
    }
  }
  return rows;
}

const deltaOf = (rows: readonly Row[], kind: Row['kind'], field: Row['field']) =>
  rows.filter((row) => row.kind === kind && row.field === field).map((row) => row.delta);

/** 設了 `NEXUS_ENTRY_TIME_REPORT` 就把這一場的差值附加成一行 JSON。 */
async function report(scenario: string, rows: readonly Row[]): Promise<void> {
  const path = process.env['NEXUS_ENTRY_TIME_REPORT'];
  if (path === undefined || path === '') return;
  await appendFile(path, `${JSON.stringify({ scenario, rows })}\n`);
}

describe('條目時刻在真的線上（#1030）', () => {
  it('歷史那條逐格等於日誌的 time；即時那條的差距量化如下', async () => {
    const outcome = await run([
      {
        content: FIRST,
        tokenDelayMs: TOKEN_DELAY_MS,
        toolCalls: [{ name: 'slow_lookup', args: {} }],
      },
      { content: SECOND, tokenDelayMs: TOKEN_DELAY_MS },
    ]);
    const live = reduceAll(emptyConversation(), outcome.live).entries;
    const history = reduceAll(emptyConversation(), outcome.history).entries;
    const liveRows = measure('live', live, outcome.log);
    const historyRows = measure('history', history, outcome.log);

    await report('tool', [...liveRows, ...historyRows]);

    // 前提：兩條路都折出了一則人話、兩則回覆、一張卡，下面的比較才有東西可比。
    for (const rows of [liveRows, historyRows]) {
      expect(deltaOf(rows, 'human', 'startedAt')).toHaveLength(1);
      expect(deltaOf(rows, 'ai', 'startedAt')).toHaveLength(2);
      expect(deltaOf(rows, 'tool', 'startedAt')).toHaveLength(1);
      // 每一格都有值：沒填的話差值是 `null`，下面的界線比不出東西。
      expect(rows.every((row) => row.delta !== null)).toBe(true);
    }

    // **校準**：歷史那條的 frame 帶的就是日誌的 `time`，差值逐格是 0。
    expect(historyRows.map((row) => row.delta)).toEqual(historyRows.map(() => 0));

    // 即時那條的回覆：`startedAt` 是第一個字到的那一刻（`message-start` 跟它一起到），**晚於**這一次呼叫的 `model/start`
    // 一段首字等待（TTFT）——腳本模型每個字前面都等一下，所以至少一個字的時間；`settledAt` 貼著日誌。計時器可能早一毫秒醒。
    // 這一段就是兩條路 `startedAt` 的差距（歷史那條取 `model/start`，見 `AiEntry.startedAt`）；它遠小於整則回覆的長度。
    const [first, second] = deltaOf(liveRows, 'ai', 'startedAt') as number[];
    for (const [ttft, text] of [
      [first, FIRST],
      [second, SECOND],
    ] as const) {
      expect(ttft).toBeGreaterThanOrEqual(TOKEN_DELAY_MS - 1);
      expect(ttft).toBeLessThan(text.length * (TOKEN_DELAY_MS - 1));
    }
    // 人話、回覆的 `settledAt`、工具卡兩格：即時那條也貼著日誌（pump 在同一個同步段裡從日誌合成，或基座的 frame 與
    // 日誌幾乎同時）。實測多半是 0 或 1 毫秒，界線見 {@link NEAR_MS}。
    for (const delta of [
      ...deltaOf(liveRows, 'human', 'startedAt'),
      ...deltaOf(liveRows, 'ai', 'settledAt'),
      ...deltaOf(liveRows, 'tool', 'startedAt'),
      ...deltaOf(liveRows, 'tool', 'settledAt'),
    ] as number[]) {
      expect(Math.abs(delta)).toBeLessThan(NEAR_MS);
    }
    // 對照：工具卡的起訖真的隔了本體睡的那一段，兩條路都是——差值是 0 不是因為兩個時刻本來就一樣。
    for (const entries of [live, history]) {
      const card = entries.find((entry) => entry.kind === 'tool');
      expect(card?.kind).toBe('tool');
      if (card?.kind !== 'tool') continue;
      expect((card.settledAt ?? 0) - (card.startedAt ?? Infinity)).toBeGreaterThanOrEqual(
        TOOL_MS - 1,
      );
    }
    // 歷史那條的回覆有耗時：`startedAt` 是呼叫開始、`settledAt` 是落盤，隔著整則吐字的時間（#1048；以前兩格是同一個時刻）。
    const texts = [FIRST, SECOND];
    history
      .filter((entry) => entry.kind === 'ai')
      .forEach((entry, index) => {
        const streamMs = ((entry.settledAt ?? 0) - (entry.startedAt ?? Infinity)) as number;
        expect(streamMs).toBeGreaterThanOrEqual(texts[index]!.length * (TOKEN_DELAY_MS - 1));
      });
  }, 30000);

  it('續接：同一顆呼叫的 `tool-started` 在兩條路上都到兩次，startedAt 取第一顆，等人回答的時間算在裡面', async () => {
    const outcome = await run(
      [
        {
          content: '我先問。',
          toolCalls: [
            {
              name: ASK_USER_QUESTION_TOOL_NAME,
              args: { questions: [{ id: 'day', question: '哪一天？', options: DAYS }] },
            },
          ],
        },
        { content: '好。' },
      ],
      () => answerResponse([{ id: 'day', selected: ['週二'] }]),
    );
    const card = (entries: readonly ConversationEntry[]) => {
      const found = entries.find((entry) => entry.kind === 'tool');
      if (found?.kind !== 'tool') throw new Error('沒有工具卡');
      return found;
    };
    const live = reduceAll(emptyConversation(), outcome.live).entries;
    const history = reduceAll(emptyConversation(), outcome.history).entries;
    const { callId } = card(live);
    const startedFrames = (frames: readonly Event[]) =>
      frames.filter((frame) => {
        const data = frame.params.data as { event?: string; tool_call_id?: string };
        return (
          frame.method === 'tools' && data.event === 'tool-started' && data.tool_call_id === callId
        );
      }).length;
    const calls = outcome.log.filter(
      (event) => event.type === 'tool/call' && event.data.callId === callId,
    );
    // 前提：第二顆真的到了——日誌記了兩次 `tool/call`，兩條路的 frame 都不止一顆。沒有第二顆，「取第一顆」量不出東西。
    expect(calls).toHaveLength(2);
    expect(startedFrames(outcome.live)).toBeGreaterThanOrEqual(2);
    expect(startedFrames(outcome.history)).toBe(2);
    const [firstCall, secondCall] = calls as [SessionEvent, SessionEvent];
    expect(secondCall.time - firstCall.time).toBeGreaterThanOrEqual(WAIT_MS - 1);

    const liveRows = measure('live', live, outcome.log);
    const historyRows = measure('history', history, outcome.log);
    await report('resume', [...liveRows, ...historyRows]);
    // `measure` 拿第一顆 `tool/call` 對：取的若是第二顆，差值會是等人回答的那一段（至少 WAIT_MS）。
    expect(deltaOf(historyRows, 'tool', 'startedAt')).toEqual([0]);
    for (const delta of deltaOf(liveRows, 'tool', 'startedAt') as number[]) {
      expect(Math.abs(delta)).toBeLessThan(NEAR_MS);
    }
    for (const entries of [live, history]) {
      const { startedAt, settledAt, status } = card(entries);
      expect(status).toBe('done');
      expect((settledAt ?? 0) - (startedAt ?? Infinity)).toBeGreaterThanOrEqual(WAIT_MS - 1);
    }
  }, 30000);
});
