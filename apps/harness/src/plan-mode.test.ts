/**
 * 計劃模式的**行為**驗收（[#116](https://github.com/DemianLi/nexus-agent/issues/116)）。
 *
 * `packages/nexus-plugin-plan-mode` 那邊的薄測試看的是 registry 的內容；這裡看的是
 * **模型收到的 prompt** 與**跑完之後的日誌**——一個 middleware 有沒有作用，只有在
 * 真的組出一個 agent、真的跑一輪之後才看得見。模式住在會話日誌上
 * （[#251](https://github.com/DemianLi/nexus-agent/issues/251) 的第二刀），所以要看模式的
 * 那幾條都接了 `SessionRegistry`。
 *
 * 四組，各自釘一件不同的事：
 *
 * 1. **指引**：開著才夾、關著一個字都不多、而且不會踩掉別人的 prompt。
 * 2. **`exit_plan_mode` 的結局**：同意、繼續規劃、關掉這一題、沒人可問、不在模式裡——走提問通道
 *    （[#652](https://github.com/DemianLi/nexus-agent/issues/652)），結局要分得開。
 * 3. **模式狀態活得過什麼**：同一條 thread 的下一輪、以及一次真的壓縮。跨重啟那一條在
 *    `session-resume.test.ts`。
 * 4. **`prepend` 的證據**：模式外的呼叫拿到的是「不在計劃模式」，不是核准的措辭（第 2 組最後一條）。
 * 5. **`/plan` 這條路**：人打的那一行到底有沒有讓下一輪的 prompt 變得不一樣
 *    （[#120](https://github.com/DemianLi/nexus-agent/issues/120)）。
 */

import { PassThrough } from 'node:stream';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import { Command, MemorySaver } from '@langchain/langgraph';
import { createHostServicesPlugin, deriveApprovalChannel, SessionRegistry } from '@nexus/core';
import type { PluginEntry, QuestionInterruptItem, QuestionReply, SessionEvent } from '@nexus/core';
import { CANCELLED_MESSAGE } from '@nexus/plugin-ask-user';
import { createEchoPlugin, ECHO_TOOL_NAME } from '@nexus/plugin-echo';
import { createMemoryPlugin } from '@nexus/plugin-memory';
import {
  createPlanModePlugin,
  DEFAULT_PLAN_GUIDANCE,
  EXIT_PLAN_MODE_TOOL_NAME,
  NOT_IN_PLAN_MODE_MESSAGE,
  PLAN_APPROVE_LABEL,
  PLAN_APPROVED_MESSAGE,
  PLAN_ARGS_ERROR_MESSAGE,
  PLAN_ENTERED_MESSAGE,
  PLAN_KEEP_PLANNING_LABEL,
  PLAN_LEFT_MESSAGE,
  PLAN_NO_REVIEWER_MESSAGE,
  PLAN_REVIEW_DISMISSED_MESSAGE,
  PLAN_REVIEW_HEADER,
  PLAN_REVIEW_QUESTION,
  PLAN_REVIEW_QUESTION_ID,
  planFeedbackMessage,
  recordedPlanMode,
} from '@nexus/plugin-plan-mode';
import { createSummarizationMiddleware } from 'deepagents';
import { describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { runRepl } from './cli.js';
import { HEADLESS_APPROVALS } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

/** 一輪 prompt 裡的 system 訊息。指引併進的是 system prompt，不是對話。 */
function systemPrompt(messages: readonly BaseMessage[]): string {
  return messages
    .filter((message) => message.getType() === 'system')
    .map((message) => message.text)
    .join('\n');
}

/**
 * 日誌上的模式：最後一顆 `plan/mode`，一顆都沒有時是組裝的初值。
 *
 * @param sessions - 接在這次組裝上的會話註冊表。
 * @param startActive - 組裝給的 `startActive`。
 */
function planModeOf(sessions: SessionRegistry, startActive: boolean): boolean {
  return recordedPlanMode(sessions.root.events) ?? startActive;
}

/** 訊息裡最後一則工具結果。 */
function lastToolMessage(messages: readonly BaseMessage[]): BaseMessage | undefined {
  return [...messages].reverse().find((message) => message.getType() === 'tool');
}

/** 一份會呼叫 `exit_plan_mode` 再收工的腳本。 */
function planScript(): ScriptedChatModel {
  return new ScriptedChatModel({
    turns: [
      {
        content: '我先規劃。',
        toolCalls: [{ name: EXIT_PLAN_MODE_TOOL_NAME, args: { plan: '# 計劃\n\n先看再改。' } }],
      },
      { content: '開始動手。' },
    ],
  });
}

describe('計劃指引進不進 system prompt', () => {
  it('startActive 開著就夾進去', async () => {
    const model = new ScriptedChatModel({ turns: [{ content: '好。' }] });
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [createPlanModePlugin({ startActive: true })],
    });

    try {
      await agent.invoke(toAgentInvocation('嗨。'));
    } finally {
      await dispose();
    }

    expect(systemPrompt(model.lastPrompt)).toContain(DEFAULT_PLAN_GUIDANCE);
  });

  /**
   * **這一條是「未激活不增加 token」那句話的執行版**（dsh
   * `packages/plan/plan-mode/README.zh.md` 的 Token 影響）。middleware 掛著、工具註冊著、
   * 但 prompt 裡一個字都沒有多——不然「掛了這個 plugin」就變成一筆每輪都在付的稅。
   */
  it('預設是關的，prompt 裡一個字都不多', async () => {
    const model = new ScriptedChatModel({ turns: [{ content: '好。' }] });
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [createPlanModePlugin()],
    });

    try {
      await agent.invoke(toAgentInvocation('嗨。'));
    } finally {
      await dispose();
    }

    expect(systemPrompt(model.lastPrompt)).not.toContain(DEFAULT_PLAN_GUIDANCE);
  });

  it('部署換掉的指引就是原樣那一段', async () => {
    const guidance = '<部署自己寫的那一段>';
    const model = new ScriptedChatModel({ turns: [{ content: '好。' }] });
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [createPlanModePlugin({ startActive: true, guidance })],
    });

    try {
      await agent.invoke(toAgentInvocation('嗨。'));
    } finally {
      await dispose();
    }

    const prompt = systemPrompt(model.lastPrompt);
    expect(prompt).toContain(guidance);
    expect(prompt).not.toContain(DEFAULT_PLAN_GUIDANCE);
  });

  /**
   * **兩段同時到得了模型。**
   *
   * 分開測的話，一個會把另一個吃掉的實作兩條都會綠，所以要同時斷言。
   *
   * **但它抓不到「取代式」的實作，這一點量過了**：計劃模式的 middleware 是
   * `prepend` 的，站在記憶**外面**，所以就算它把 `systemMessage` 整個換掉，記憶也是
   * 之後才接上去的——實測把 `concat` 改成 `new SystemMessage(guidance)`，這一條照樣綠。
   * 真正釘住 `concat` 的是下面那條「更外層的 prompt 不會被吃掉」。
   */
  it('記憶與指引在同一份 prompt 裡同時存在', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-plan-'));
    await writeFile(join(root, 'AGENTS.md'), '使用者的代號是胡桃。');
    const model = new ScriptedChatModel({ turns: [{ content: '好。' }] });

    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      plugins: [createMemoryPlugin(), createPlanModePlugin({ startActive: true })],
    });

    try {
      await agent.invoke(toAgentInvocation('嗨。'));
    } finally {
      await dispose();
    }

    const prompt = systemPrompt(model.lastPrompt);
    expect(prompt).toContain('胡桃');
    expect(prompt).toContain(DEFAULT_PLAN_GUIDANCE);
  });
  /**
   * **這一條才是 `concat` 的絆索。**
   *
   * 計劃模式站在記憶外面，所以吃不掉記憶——要證明「疊加不是取代」有意義，得放一個
   * **比它更外層**的 prompt 貢獻者。`prepend` 的 middleware 之間依註冊順序排，所以
   * 先註冊的 `marker` 更外層：它先在 system prompt 上留記號，計劃模式後跑。
   * 把 `concat` 換成取代，這個記號會靜靜消失——那正是
   * `dynamicSystemPromptMiddleware` 那條路的下場，也是刻意不用它的原因。
   */
  it('更外層的 prompt 不會被吃掉', async () => {
    const marker = '<更外層的那一段>';
    const outer: PluginEntry = {
      plugin: {
        name: 'outer-prompt',
        apply: (registry) =>
          void registry.middleware.use(
            {
              name: 'outerPrompt',
              wrapModelCall: (
                request: { systemMessage?: { concat: (text: string) => unknown } },
                handler: (next: unknown) => unknown,
              ) =>
                handler(
                  request.systemMessage === undefined
                    ? { ...request, systemPrompt: marker }
                    : { ...request, systemMessage: request.systemMessage.concat(`\n${marker}`) },
                ),
            } as never,
            { prepend: true },
          ),
      },
    };

    const model = new ScriptedChatModel({ turns: [{ content: '好。' }] });
    const { agent, dispose } = await createNexusAgent({
      model,
      // 順序有意義：`outer` 先註冊，所以它排在計劃模式**外面**。
      plugins: [outer, createPlanModePlugin({ startActive: true })],
    });

    try {
      await agent.invoke(toAgentInvocation('嗨。'));
    } finally {
      await dispose();
    }

    const prompt = systemPrompt(model.lastPrompt);
    expect(prompt).toContain(marker);
    expect(prompt).toContain(DEFAULT_PLAN_GUIDANCE);
  });
});

/** 一顆中斷的酬載，照 `__interrupt__` 的形狀讀。 */
interface RaisedInterrupt {
  readonly value?: {
    readonly kind?: string;
    readonly actionRequests?: unknown;
    readonly questions?: readonly QuestionInterruptItem[];
  };
}

/** 一份會呼叫 `exit_plan_mode`、給了回覆再收工的一輪：先停在提問上，再用 `reply` 接回去。 */
async function reviewPlan(
  threadId: string,
  reply: QuestionReply,
): Promise<{
  readonly raised: readonly RaisedInterrupt[];
  readonly after: { readonly messages: readonly BaseMessage[]; readonly __interrupt__?: unknown };
  readonly events: readonly SessionEvent[];
  readonly model: ScriptedChatModel;
}> {
  const model = planScript();
  const { agent, attachSession, dispose } = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    plugins: [createPlanModePlugin({ startActive: true })],
  });
  const config = { configurable: { thread_id: threadId } };
  const sessions = new SessionRegistry(threadId);
  const detach = attachSession(sessions);
  try {
    const paused = await agent.invoke(toAgentInvocation('幫我改一下。'), config);
    const raised = (paused.__interrupt__ ?? []) as readonly RaisedInterrupt[];
    const after = (await agent.invoke(new Command({ resume: reply }) as never, config)) as {
      messages: BaseMessage[];
      __interrupt__?: unknown;
    };
    return { raised, after, events: sessions.root.events, model };
  } finally {
    detach();
    await dispose();
  }
}

/** 日誌上 `exit_plan_mode` 那顆 `tool/result` 的判定，不含訊息本文。 */
function exitVerdicts(events: readonly SessionEvent[]): unknown[] {
  const exitCalls = new Set(
    events.flatMap((event) =>
      event.type === 'tool/call' && event.data.name === EXIT_PLAN_MODE_TOOL_NAME
        ? [event.data.callId]
        : [],
    ),
  );
  return events.flatMap((event) => {
    if (event.type !== 'tool/result' || !exitCalls.has(event.data.callId)) return [];
    const { message: _message, ...verdict } = event.data;
    return [verdict];
  });
}

/**
 * `exit_plan_mode` 走提問通道（[#652](https://github.com/DemianLi/nexus-agent/issues/652)），照 dsh
 * `packages/plan/plan-mode/src/index.ts:278-350`。
 *
 * **以前這一組叫「三條路」**，走的是核准：plan-mode 掛一位閘門對 `exit_plan_mode` 回 `ask`，計劃變成
 * 核准卡上的工具參數。dsh 明文否決那條路（核准的詞彙封閉，拒絕帶不回意見）。現在的結局有五種：
 * 同意、繼續規劃（帶意見）、關掉這一題、沒有人可以回答、不在模式裡。停止這一輪那條在
 * `plan-review-wire.test.ts`，要真的 pump。
 */
describe('exit_plan_mode 的結局', () => {
  /**
   * **翻過來的絆索**：以前這裡斷言「停在一顆核准中斷上、`actionRequests` 帶著計劃」。現在剛好一顆中斷、
   * 是提問、沒有 `actionRequests`——鏈底要是對它回了 `ask`，這裡會看到兩顆，或看到一顆核准。
   *
   * 計劃全文在 `detail`；`intent.callId` 是日誌上那顆 `tool/call` 的 id，歷史重播時計劃卡從它的參數畫。
   */
  it('停在一顆提問上：計劃全文在 detail，intent 指得到那顆呼叫，沒有核准', async () => {
    const { raised, events } = await reviewPlan('review-shape', { cancelled: true });

    expect(raised).toHaveLength(1);
    expect(raised[0]?.value?.kind).toBe('question');
    expect(raised[0]?.value?.actionRequests).toBeUndefined();
    const callIds = events.flatMap((event) =>
      event.type === 'tool/call' && event.data.name === EXIT_PLAN_MODE_TOOL_NAME
        ? [event.data.callId]
        : [],
    );
    // resume 時本體從頭再跑一次，所以同一個 id 的 `tool/call` 會記兩顆；要的是它們指同一顆呼叫。
    expect(new Set(callIds).size).toBe(1);
    expect(raised[0]?.value?.questions).toEqual([
      {
        id: PLAN_REVIEW_QUESTION_ID,
        header: PLAN_REVIEW_HEADER,
        question: PLAN_REVIEW_QUESTION,
        detail: '# 計劃\n\n先看再改。',
        options: [
          { label: PLAN_APPROVE_LABEL, description: expect.any(String) },
          { label: PLAN_KEEP_PLANNING_LABEL, description: expect.any(String) },
        ],
        intent: { kind: 'plan-review', approve: PLAN_APPROVE_LABEL, callId: callIds[0] },
      },
    ]);
  });

  /**
   * **同意 → 工具成功，模式在下一個模型步驟之前才關**（照 dsh 的 `pendingIntents`）。
   *
   * 日誌上的順序就是證據：那顆 `plan/mode { active: false }` 落在 `exit_plan_mode` 的 `tool/result`
   * **之後**、下一次模型呼叫的 `model/end` 之前。當場寫的實作會把它排在 `tool/result` 前面。
   */
  it('同意 → 工具成功；plan/mode 落在工具結果之後、下一步回覆之前；下一步沒有指引', async () => {
    const { after, events, model } = await reviewPlan('review-approve', {
      answers: [{ id: PLAN_REVIEW_QUESTION_ID, selected: [PLAN_APPROVE_LABEL] }],
    });

    expect(exitVerdicts(events)).toEqual([{ callId: expect.any(String), isError: false }]);
    const tool = lastToolMessage(after.messages);
    expect(tool?.text).toBe(PLAN_APPROVED_MESSAGE);
    expect(recordedPlanMode(events)).toBe(false);
    const order = events
      .map((event) => event.type)
      .filter((type) => type === 'tool/result' || type === 'plan/mode' || type === 'model/end');
    // 第一次模型呼叫 → 工具結果 → 待關交出去 → 第二次模型呼叫。
    expect(order).toEqual(['model/end', 'tool/result', 'plan/mode', 'model/end']);
    expect(systemPrompt(model.lastPrompt)).not.toContain(DEFAULT_PLAN_GUIDANCE);
  });

  /**
   * **繼續規劃 → 意見帶回給模型，模式留著。** 同 dsh：只要不是「剛好選了同意、沒有自由作答」都算繼續規劃，
   * 所以選了同意又寫了字的那一種也是。
   */
  it.each([
    ['選繼續規劃、寫了意見', [PLAN_KEEP_PLANNING_LABEL], '先補測試', '先補測試'],
    ['選繼續規劃、沒寫意見', [PLAN_KEEP_PLANNING_LABEL], undefined, ''],
    ['選了同意但也寫了字', [PLAN_APPROVE_LABEL], '改成兩步', '改成兩步'],
  ] as const)('%s → 拒絕、模式留著', async (_label, selected, custom, feedback) => {
    const { after, events, model } = await reviewPlan(`review-keep-${String(selected)}`, {
      answers: [
        { id: PLAN_REVIEW_QUESTION_ID, selected, ...(custom === undefined ? {} : { custom }) },
      ],
    });

    expect(exitVerdicts(events)).toEqual([{ callId: expect.any(String), isError: true }]);
    expect(lastToolMessage(after.messages)?.text).toBe(`Error: ${planFeedbackMessage(feedback)}`);
    expect(events.some((event) => event.type === 'plan/mode')).toBe(false);
    expect(systemPrompt(model.lastPrompt)).toContain(DEFAULT_PLAN_GUIDANCE);
  });

  /**
   * **關掉這一題 → 停在這裡等使用者，不是放棄、也不是停止這一輪。**
   *
   * 那句不是 `ask_user_question` 的 {@link CANCELLED_MESSAGE}（它叫模型別重問同一組），日誌上也不標
   * `ASK_CANCELLED`：dsh 在這裡拋的是一般 `Error`。這一輪照常走完——模型收到拒絕之後還有下一步。
   */
  it('關掉這一題 → 模型收到「停在這裡等使用者的訊息」，模式留著，這一輪沒有被中止', async () => {
    const { after, events, model } = await reviewPlan('review-dismiss', { cancelled: true });

    const tool = lastToolMessage(after.messages);
    expect(tool?.text).toBe(`Error: ${PLAN_REVIEW_DISMISSED_MESSAGE}`);
    expect(tool?.text).not.toContain(CANCELLED_MESSAGE);
    expect(exitVerdicts(events)).toEqual([{ callId: expect.any(String), isError: true }]);
    expect(events.some((event) => event.type === 'plan/mode')).toBe(false);
    expect(after.__interrupt__).toBeUndefined();
    expect(events.filter((event) => event.type === 'model/end')).toHaveLength(2);
    expect(systemPrompt(model.lastPrompt)).toContain(DEFAULT_PLAN_GUIDANCE);
  });

  /**
   * **沒有人可以回答 → 確定性拒絕，請使用者自己切模式，而且模式還開著。**
   *
   * 照 dsh「沒有提問通道就拋錯」。`channel` 由組裝點明著算（同 `cli.ts`），輸入跟 `HEADLESS_APPROVALS`
   * 同一組；少了這一格的話 plugin 退到「有人在」，這一輪會停下來問一個不會來的答案。
   */
  it('headless → 請使用者自己切模式，沒有中斷，模式還開著', async () => {
    const model = planScript();
    const checkpointer = new MemorySaver();
    const { agent, attachSession, dispose } = await createNexusAgent({
      model,
      checkpointer,
      approvals: HEADLESS_APPROVALS,
      plugins: [
        createHostServicesPlugin({
          channel: deriveApprovalChannel({
            approvalsEnabled: HEADLESS_APPROVALS.enabled,
            hasCheckpointer: true,
          }),
        }),
        createPlanModePlugin({ startActive: true }),
      ],
    });
    const sessions = new SessionRegistry('headless');
    const detach = attachSession(sessions);

    let result;
    try {
      result = await agent.invoke(toAgentInvocation('幫我改一下。'), {
        configurable: { thread_id: 'headless' },
      });
    } finally {
      detach();
      await dispose();
    }

    expect(result.__interrupt__).toBeUndefined();
    expect(lastToolMessage(result.messages as BaseMessage[])?.text).toBe(
      `Error: ${PLAN_NO_REVIEWER_MESSAGE}`,
    );
    expect(planModeOf(sessions, true)).toBe(true);
    expect(sessions.root.events.some((event) => event.type === 'plan/mode')).toBe(false);
  });

  /**
   * **不在模式裡的時候：說的是模式，不是核准。**
   *
   * 這一條是 `prepend: true` 的證據。plan-mode 自己不再掛閘門，所以這裡掛一位**什麼工具都要核准**的探針
   * （`approval.patch.yml` 那一類組裝會長這樣）。少了 `prepend`，`fold` 會把計劃模式的 middleware 排到
   * 核准閘門**之後**，這次呼叫會先撞上探針、在 headless 底下拿到「沒有人被問到」——而真正的原因是
   * 「你不在計劃模式」。
   */
  it('模式外呼叫 → 說的是「不在計劃模式」，不是核准的措辭', async () => {
    const model = planScript();
    const askEverything: PluginEntry = {
      plugin: {
        name: 'probe-ask-everything',
        apply(registry) {
          registry.approvals.gate(() => ({ kind: 'ask', reason: '探針：每個工具都要人看過' }));
        },
      },
    };
    const { agent, attachSession, dispose } = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      approvals: HEADLESS_APPROVALS,
      plugins: [askEverything, createPlanModePlugin()],
    });
    const sessions = new SessionRegistry('not-in-mode');
    const detach = attachSession(sessions);

    let result;
    try {
      result = await agent.invoke(toAgentInvocation('幫我改一下。'), {
        configurable: { thread_id: 'not-in-mode' },
      });
    } finally {
      detach();
      await dispose();
    }

    const refusal = lastToolMessage(result.messages as BaseMessage[]);
    expect(refusal?.text).toContain(NOT_IN_PLAN_MODE_MESSAGE);
    expect(refusal?.text).not.toContain('是沒有人被問到');
    // **日誌上記的是錯誤、不帶碼**（#273）：模式外 dsh 拋的是一般 `Error`。這是 middleware
    // 自己回結果、不往下叫的那條路，所以圍堵讀的是 middleware 那則訊息。
    expect(exitVerdicts(sessions.root.events)).toEqual([
      { callId: expect.any(String), isError: true },
    ]);
  });
});

describe('模式狀態活得過什麼', () => {
  it('同一條 thread 的下一輪還在', async () => {
    const model = new ScriptedChatModel({
      turns: [{ content: '第一輪。' }, { content: '第二輪。' }],
    });
    const { agent, dispose } = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      plugins: [createPlanModePlugin({ startActive: true })],
    });
    const config = { configurable: { thread_id: 'across-turns' } };

    try {
      await agent.invoke(toAgentInvocation('第一句。'), config);
      await agent.invoke(toAgentInvocation('第二句。'), config);
    } finally {
      await dispose();
    }

    // 狀態還在，所以第二輪的 prompt 也還夾著指引。
    expect(systemPrompt(model.lastPrompt)).toContain(DEFAULT_PLAN_GUIDANCE);
  });

  /**
   * **壓縮會重寫 `messages`，這一條問的是「它會不會順手把模式也一起吃掉」。**
   *
   * 模式住在 graph state 裡的時候，這一條擋的是「摘要器只改 `messages`」這個沒人承諾過的
   * 實作細節。模式搬進日誌之後它**在構造上就成立了**——摘要器碰不到日誌——但照樣留著：
   * 它釘的是一句宣稱，不是一個機制，哪天模式又搬回 state，這一條就回到有牙齒的樣子。
   * 低門檻的摘要器是照 `summarization.test.ts` 的做法換掉內建那個。
   */
  it('一次真的壓縮之後還在', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-plan-sum-'));
    const backend = new ContainedFilesystemBackend({ rootDir: root });
    const model = new ScriptedChatModel({
      turns: Array.from({ length: 12 }, (_, index) => ({ content: `第 ${index + 1} 次回話。` })),
    });

    const tuned: PluginEntry = {
      plugin: {
        name: 'tuned-summarization',
        apply: (registry) =>
          void registry.middleware.use(
            createSummarizationMiddleware({
              backend,
              trigger: { type: 'messages', value: 3 },
              keep: { type: 'messages', value: 1 },
            }) as never,
          ),
      },
    };

    const { agent, dispose } = await createNexusAgent({
      model,
      backend,
      checkpointer: new MemorySaver(),
      plugins: [createPlanModePlugin({ startActive: true }), tuned],
    });
    const config = { configurable: { thread_id: 'summarize' } };

    let last;
    try {
      for (const line of ['第一句。', '第二句。', '第三句。', '第四句。']) {
        last = await agent.invoke(toAgentInvocation(line), config);
      }
    } finally {
      await dispose();
    }

    // **先證明壓縮真的發生了。** 少了這一句，一個根本沒觸發摘要的組裝也會讓下面兩條
    // 通過——那時綠的是「什麼都沒發生」，不是「熬過了壓縮」。摘要器把歷史 offload 到
    // `/conversation_history`，那個目錄非空就是它跑過的外顯（照 `summarization.test.ts`）。
    expect(await readdir(join(root, 'conversation_history'))).not.toHaveLength(0);

    expect(last).toBeDefined();
    expect(systemPrompt(model.lastPrompt)).toContain(DEFAULT_PLAN_GUIDANCE);
  });
});

describe('工具目錄不隨模式變動', () => {
  /**
   * 照 dsh：模式沒啟用時 `exit_plan_mode` 仍然留在面向模型的 schema 裡，
   * 「這樣狀態轉換不會在規劃策略變更之外額外造成工具目錄變動」。
   * 代價是 `startActive: false` 的組裝裡它是活的 schema、死的執行路徑——上面那條
   * 「模式外呼叫」測的就是那條死路徑說了什麼。
   */
  it('模式關著的時候工具也在，而且排得進 toolOrder', async () => {
    const model = new ScriptedChatModel({ turns: [{ content: '好。' }] });
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [createEchoPlugin(), createPlanModePlugin()],
      toolOrder: [EXIT_PLAN_MODE_TOOL_NAME, ECHO_TOOL_NAME, '<unlisted-tools>'],
    });

    try {
      await agent.invoke(toAgentInvocation('嗨。'));
    } finally {
      await dispose();
    }

    expect(model.boundToolNames.slice(0, 2)).toEqual([EXIT_PLAN_MODE_TOOL_NAME, ECHO_TOOL_NAME]);
  });
});

/**
 * `/plan` 走完整條線：**真的執行器 → 真的 REPL → 真的 agent 迴圈**。
 *
 * 為什麼要走 `runRepl` 而不是直接呼叫 handler：這一條要證明的不是 handler 回了什麼
 * 字串（那歸 `packages/nexus-plugin-plan-mode` 的單元測試），而是**人打的那一行真的
 * 讓下一輪的 prompt 變得不一樣**。中間隔著 `parseCommand` 的 lookahead、執行器的
 * 配對日誌、會話日誌上那顆 `plan/mode` 與 plugin 對它的折疊——少了任何一段，指引都到不了
 * 模型，而每一段都只有在真的接起來的時候才驗得到。
 *
 * **會話日誌不是佈景，而且要是接線的那一份。** `runRepl` 把 `command/*` 寫進它收到的那份
 * 日誌，plugin 則把 `plan/mode` 寫進 `attachSession` 接上的 root 那一份——CLI 裡兩者是同一份
 * （`sessions.root`），這裡也照做。給一份沒接線的日誌的話，`/plan` 回的是「還沒接上」。
 */
describe('/plan 這條路', () => {
  /** 餵幾行進 REPL，把印出來的東西與日誌一起收回來。 */
  async function repl(
    plugins: readonly PluginEntry[],
    lines: string,
    turns: number,
  ): Promise<{
    model: ScriptedChatModel;
    stdout: string;
    stderr: string;
    events: readonly SessionEvent[];
  }> {
    const model = new ScriptedChatModel({
      turns: Array.from({ length: turns }, () => ({ content: '好。' })),
    });
    const { agent, commands, attachSession, dispose } = await createNexusAgent({
      model,
      plugins,
      checkpointer: new MemorySaver(),
    });
    const sessions = new SessionRegistry('plan-repl');
    const detach = attachSession(sessions);
    const sessionLog = sessions.root;
    const events: SessionEvent[] = [];
    sessionLog.subscribe((event) => events.push(event));

    const out: string[] = [];
    const err: string[] = [];
    const input = new PassThrough();
    input.end(lines);

    try {
      await runRepl(
        agent,
        { input, output: new PassThrough() },
        { log: (line) => void out.push(line), error: (line) => void err.push(line) },
        sessionLog,
        commands,
      );
    } finally {
      detach();
      await dispose();
    }
    return { model, stdout: out.join('\n'), stderr: err.join('\n'), events };
  }

  /**
   * **一進一出，兩輪的 prompt 要不一樣。**
   *
   * 只斷言「開了之後有」的話，一個永遠都夾指引的實作照樣綠；只斷言「關了之後沒有」
   * 的話，一個從來不夾的實作也綠。兩輪一起比才擋得住。
   */
  it('/plan 之後那一輪夾指引，/plan off 之後那一輪不夾', async () => {
    const { model, stdout } = await repl(
      [createEchoPlugin(), createPlanModePlugin()],
      '/plan\n先想想\n/plan off\n動手吧\n/exit\n',
      2,
    );

    expect(model.prompts).toHaveLength(2);
    expect(systemPrompt(model.prompts[0] ?? [])).toContain(DEFAULT_PLAN_GUIDANCE);
    expect(systemPrompt(model.prompts[1] ?? [])).not.toContain(DEFAULT_PLAN_GUIDANCE);
    // 兩句話都印給人看了——命令的結果不進模型，只進終端機。
    expect(stdout).toContain(PLAN_ENTERED_MESSAGE);
    expect(stdout).toContain(PLAN_LEFT_MESSAGE);
  });

  /**
   * **命令那兩行不能變成模型的一輪。** 這是 `@nexus/plugin-commands` 那條「認得的就
   * 不掉回模型」在計劃模式上的驗收：模型只該看到兩句人話，日誌裡則是兩對命令事件。
   */
  it('命令走命令的路，模型只收到那兩句人話', async () => {
    const { events } = await repl(
      [createEchoPlugin(), createPlanModePlugin()],
      '/plan\n先想想\n/plan off\n動手吧\n/exit\n',
      2,
    );

    expect(events.filter((event) => event.type === 'command/run')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'command/done')).toHaveLength(2);
    // 兩次選擇都當場落在同一份日誌上，夾在各自那對命令事件之間。
    expect(
      events.flatMap((event) => (event.type === 'plan/mode' ? [event.data.active] : [])),
    ).toEqual([true, false]);
    expect(
      events
        .filter((event) => event.type === 'turn/start')
        .map((event) => (event.data as { text?: string }).text),
    ).toEqual(['先想想', '動手吧']);
  });

  /**
   * **人自己打的那一句不會被某個節點再印一次。**
   *
   * 基座把這一輪的輸入訊息掛在**第一個真的寫了東西的節點**的 update 上，而在
   * [#120](https://github.com/DemianLi/nexus-agent/issues/120) 之前沒有任何 plugin 的
   * `beforeAgent` 回傳非空更新——所以這個形狀是那張卡第一次讓它現形的：畫面上會出現
   * `[nexusPlanMode.before_agent] 先想想`，看起來像那個 plugin 在說話。`runTurn` 因此
   * 濾掉 human message，這一條釘著它。計劃模式搬進日誌之後它沒有 `beforeAgent` 了，這一條
   * 照舊留著：那個形狀歸基座，下一個回非空更新的節點照樣會帶著它。
   */
  it('進了計劃模式之後，使用者那句話不會在畫面上出現兩次', async () => {
    const { stdout } = await repl(
      [createEchoPlugin(), createPlanModePlugin()],
      '/plan\n先想想\n/exit\n',
      1,
    );

    expect(stdout).toContain(PLAN_ENTERED_MESSAGE);
    expect(stdout).not.toContain('先想想');
    expect(stdout).not.toContain('before_agent');
  });

  /**
   * **收不下的參數走 `printer.error`，而且不驚動模型。**
   *
   * `/plan of` 是打錯的 `/plan off`，而它在語法上是一個合法的命令行——`parseCommand`
   * 收得下、註冊表也找得到，所以它**會**進 handler。分辨對錯的是 handler 自己的文法，
   * 而它回 `error`。掉回模型的話，模型會收到一行沒頭沒尾的 `/plan of`。
   */
  it('/plan of 回報錯誤，模式沒動，模型沒被驚動', async () => {
    const { model, stderr, stdout } = await repl(
      [createEchoPlugin(), createPlanModePlugin()],
      '/plan of\n說點什麼\n/exit\n',
      1,
    );

    expect(stderr).toContain(PLAN_ARGS_ERROR_MESSAGE);
    expect(model.prompts).toHaveLength(1);
    expect(systemPrompt(model.prompts[0] ?? [])).not.toContain(DEFAULT_PLAN_GUIDANCE);
    expect(stdout).not.toContain(PLAN_ENTERED_MESSAGE);
  });
});
