/**
 * 計劃審核**走真的線**（[#652](https://github.com/DemianLi/nexus-agent/issues/652)）：`exit_plan_mode` 發提問中斷 →
 * pump → `input.requested` → 折疊器 → 上行 → 工具拿到答案。
 *
 * `plan-mode.test.ts` 直接呼叫 `agent.invoke` 量得到工具的結局；量不到的是這三件：
 *
 * 1. **`detail` 與 `intent` 在線上活得下來**：酬載要穿過 pump 與折疊器，三層之間掉欄位不會有人報錯。
 * 2. **重新整理之後帶得到**：計劃卡從重播出來的那顆呼叫的參數畫、結果從它的結果文字讀。掛著的面板由 pump 在
 *    下行接上時補送（[#728](https://github.com/DemianLi/nexus-agent/issues/728)），`detail` 與 `intent` 跟著回來。
 * 3. **停止這一輪**：掛著的呼叫由 pump 收回，工具本體不會再跑，中止保留它自己那句。
 */

import { MemorySaver } from '@langchain/langgraph';
import { SessionRegistry, TOOL_ABORTED_BEFORE_DISPATCH_TEXT } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import {
  createPlanModePlugin,
  EXIT_PLAN_MODE_TOOL_NAME,
  PLAN_APPROVE_LABEL,
  PLAN_APPROVED_MESSAGE,
  PLAN_REVIEW_DISMISSED_MESSAGE,
  PLAN_REVIEW_QUESTION_ID,
  recordedPlanMode,
} from '@nexus/plugin-plan-mode';
import type { ConversationState, Event, PendingQuestion, WireClient } from '@nexus/wire';
import {
  answerResponse,
  cancelResponse,
  createWireClient,
  emptyConversation,
  isQuestionPending,
  reduceAll,
  reduceConversation,
} from '@nexus/wire';
import { describe, expect, it, vi } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { historyFrames } from './conversation-history.js';
import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import { DEFAULT_TOOL_TEXT_MAX_BYTES } from './settings/tool-text.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const BASE_URL = 'http://plan-review.test';
const PLAN = '# 計劃\n\n先看再改。';

interface Session {
  readonly threadId: string;
  readonly client: WireClient;
  events: AsyncGenerator<Event, void, undefined>;
  state: ConversationState;
  /** root 那份會話日誌。 */
  log(): readonly SessionEvent[];
  close(): Promise<void>;
}

async function open(threadId: string): Promise<Session> {
  const built = await createNexusAgent({
    model: new ScriptedChatModel({
      turns: [
        {
          content: '我先規劃。',
          toolCalls: [{ name: EXIT_PLAN_MODE_TOOL_NAME, args: { plan: PLAN } }],
        },
        { content: '開始動手。' },
      ],
    }),
    checkpointer: new MemorySaver(),
    plugins: [createPlanModePlugin({ startActive: true })],
  });
  // 日誌接在 pump 自己那一份註冊表上，同 `ask-user-wire.test.ts`：另建一份的話計劃模式折的是別人。
  let sessions: SessionRegistry | undefined;
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: emptyCommandPoint(),
      attachSession: (registry: SessionRegistry) => {
        sessions = registry;
        return built.attachSession(registry);
      },
      dispose: built.dispose,
    }),
  });
  const client = createWireClient({
    baseUrl: BASE_URL,
    fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
  });
  const events = await client.openEvents(threadId);
  await client.runStart(threadId, '幫我改一下');
  return {
    threadId,
    client,
    events,
    state: emptyConversation(),
    log: () =>
      sessions
        ?.list()
        .filter((entry) => entry.address.kind === 'root')
        .map((entry) => entry.log.events)[0] ?? [],
    close: () => handler.close(),
  };
}

async function until(session: Session, done: (session: Session) => boolean): Promise<void> {
  while (!done(session)) {
    const next = await session.events.next();
    if (next.done === true) break;
    session.state = reduceConversation(session.state, next.value);
  }
}

/** 停在計劃審核那一題上，回傳那張卡。 */
async function pendingReview(session: Session): Promise<PendingQuestion> {
  await until(session, (s) => s.state.status === 'awaiting-input');
  const pending = session.state.pendings[0];
  if (pending === undefined || !isQuestionPending(pending)) throw new Error('沒有掛著的提問');
  return pending;
}

/**
 * 答了（或停了）之後那一輪的 `turn/end`，還沒收尾是 `undefined`。
 *
 * **不能只找 `turn/end`**：停在提問上的那一輪當下就記了一顆（實測），答完之後的是 resume 那一輪的。
 */
function resumedTurnEnd(session: Session): SessionEvent | undefined {
  const log = session.log();
  const at = log.findLastIndex(
    (event) => event.type === 'turn/start' && event.data.kind === 'resume',
  );
  return at < 0 ? undefined : log.slice(at).find((event) => event.type === 'turn/end');
}

function turnEnded(session: Session): boolean {
  return resumedTurnEnd(session) !== undefined;
}

/** `exit_plan_mode` 最後那顆 `tool/result` 的訊息本文。 */
function exitResultText(session: Session): string {
  const log = session.log();
  const callIds = new Set(
    log.flatMap((event) =>
      event.type === 'tool/call' && event.data.name === EXIT_PLAN_MODE_TOOL_NAME
        ? [event.data.callId]
        : [],
    ),
  );
  const result = log
    .filter((event) => event.type === 'tool/result' && callIds.has(event.data.callId))
    .at(-1);
  if (result?.type !== 'tool/result' || result.data.message === undefined) {
    throw new Error('日誌裡沒有 exit_plan_mode 的結果');
  }
  return String((result.data.message.data as { content?: unknown }).content);
}

describe('計劃審核在線上', () => {
  it('提問帶著 detail 與 intent 上線；同意之後模式關掉；重新整理後歷史帶得到計劃與結果', async () => {
    const session = await open('review-approve');
    const pending = await pendingReview(session);

    const tool = session.state.entries.find(
      (entry) => entry.kind === 'tool' && entry.name === EXIT_PLAN_MODE_TOOL_NAME,
    );
    if (tool?.kind !== 'tool') throw new Error('線上沒有 exit_plan_mode 的卡');
    expect(pending.questions).toHaveLength(1);
    expect(pending.questions[0]).toMatchObject({
      id: PLAN_REVIEW_QUESTION_ID,
      detail: PLAN,
      intent: { kind: 'plan-review', approve: PLAN_APPROVE_LABEL, callId: tool.callId },
    });

    const answers = [{ id: PLAN_REVIEW_QUESTION_ID, selected: [PLAN_APPROVE_LABEL] }];
    await session.client.inputRespond(session.threadId, {
      namespace: [...pending.namespace],
      interrupt_id: pending.interruptId,
      response: answerResponse(answers),
    });
    await until(session, turnEnded);

    expect(exitResultText(session)).toBe(PLAN_APPROVED_MESSAGE);
    expect(recordedPlanMode(session.log())).toBe(false);

    // **重新整理之後**：同一份日誌重播出來，計劃卡要的兩樣都在——參數裡的計劃全文、結果文字。
    // resume 讓這顆呼叫的 `tool/call` 記了兩顆，重播要把它們折成同一張卡。
    const replayed = historyFrames(session.log(), DEFAULT_TOOL_TEXT_MAX_BYTES)
      .reduce(reduceConversation, emptyConversation())
      .entries.filter((entry) => entry.kind === 'tool' && entry.name === EXIT_PLAN_MODE_TOOL_NAME);
    expect(replayed).toHaveLength(1);
    const card = replayed[0];
    if (card?.kind !== 'tool') throw new Error('重播沒有 exit_plan_mode 的卡');
    expect(card.callId).toBe(tool.callId);
    expect(card.status).toBe('done');
    expect((JSON.parse(card.input) as { plan?: unknown }).plan).toBe(PLAN);
    expect(card.text).toBe(PLAN_APPROVED_MESSAGE);
    await session.close();
  });

  it('關掉這一題：模型收到「等使用者的訊息」，這一輪照常收尾，模式留著', async () => {
    const session = await open('review-dismiss');
    const pending = await pendingReview(session);

    await session.client.inputRespond(session.threadId, {
      namespace: [...pending.namespace],
      interrupt_id: pending.interruptId,
      response: cancelResponse(),
    });
    await until(session, turnEnded);

    expect(exitResultText(session)).toBe(`Error: ${PLAN_REVIEW_DISMISSED_MESSAGE}`);
    // 這一輪沒有被中止：收尾那顆不帶理由，同一般跑完的一輪。
    expect(resumedTurnEnd(session)?.data).toEqual({});
    expect(recordedPlanMode(session.log()) ?? true).toBe(true);
    await session.close();
  });

  /**
   * **停在計劃審核時重新整理**：照網頁的順序接回來（開下行 → 抓歷史 → 從空重折 → 抽下行）。歷史只折得出卡，
   * 那一題是 pump 補送的，`detail` 與 `intent` 要原樣在上面，答了這一輪接著收尾。
   */
  it('停在計劃審核時重新整理：那一題帶著計劃全文回來，同意之後模式關掉', async () => {
    const session = await open('review-refresh');
    const before = await pendingReview(session);

    await session.events.return(undefined);
    session.events = await session.client.openEvents(session.threadId);
    const page = await session.client.threadHistory(session.threadId);
    if (page.kind !== 'ok') throw new Error(page.message);
    session.state = reduceAll(emptyConversation(), page.result.events);
    // 前提：歷史自己折不出這一題。
    expect(session.state.pendings).toEqual([]);

    const after = await pendingReview(session);
    expect(after.interruptId).toBe(before.interruptId);
    expect(after.questions).toEqual(before.questions);
    expect(after.questions[0]).toMatchObject({ detail: PLAN, intent: { kind: 'plan-review' } });

    await session.client.inputRespond(session.threadId, {
      namespace: [...after.namespace],
      interrupt_id: after.interruptId,
      response: answerResponse([{ id: PLAN_REVIEW_QUESTION_ID, selected: [PLAN_APPROVE_LABEL] }]),
    });
    await until(session, turnEnded);

    expect(exitResultText(session)).toBe(PLAN_APPROVED_MESSAGE);
    expect(recordedPlanMode(session.log())).toBe(false);
    await session.close();
  });

  /**
   * **停止這一輪不是關掉這一題**：pump 把掛著的呼叫收回（`ThreadPump.#withdraw`），寫的是收回那句，
   * 工具本體不會再跑，所以沒有「等使用者」那句，也沒有待關。
   */
  it('提問掛著時停止這一輪：收回那句、這一輪收成中止、模式留著', async () => {
    const session = await open('review-stop');
    await pendingReview(session);

    // 卡一上線就按的話，pump 那一輪可能還沒收完，停止會落在「中止正在跑的那一輪」那一格（撞上核准點、
    // 請求作廢）。要量的是停穩之後按：停在提問上的那一輪記下 `turn/end` 時，pump 已經同步放掉它了。
    await vi.waitFor(() => {
      expect(session.log().some((event) => event.type === 'turn/end')).toBe(true);
    });
    await session.client.runCancel(session.threadId);
    await until(session, turnEnded);

    expect(exitResultText(session)).toBe(TOOL_ABORTED_BEFORE_DISPATCH_TEXT);
    expect(resumedTurnEnd(session)?.data).toEqual({
      reason: { kind: 'aborted', cause: { kind: 'user' } },
    });
    expect(recordedPlanMode(session.log()) ?? true).toBe(true);
    await session.close();
  });
});
