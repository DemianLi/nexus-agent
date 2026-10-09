/**
 * **產品組裝（#670）**：這一檔的案例都經 `createCliAgent` 跑，清單是 `cordis.yml` 出貨的那一份——`plan-mode` 那一列用
 * config 換 `startActive`／`guidance`、`summarization` 那一列換低門檻、模型用 `withScriptedModel` 換成腳本。以前是手搭的
 * `createNexusAgent` 單獨掛上 `plan-mode`，量到的是「一個 plugin 掛在空清單上」；現在量的是它在出貨清單裡、跟其餘
 * 條目一起 fold 之後的樣子（指引疊在記憶與別的 prompt 貢獻者上、`exit_plan_mode` 走產品算出來的提問通道）。
 *
 * **留在手搭組裝的一處**：「工具目錄不隨模式變動」那條（`createNexusAgent` ＋ `toolOrder`）。產品組裝沒有 `toolOrder`
 * 這個選項（`createCliAgent` 不傳，`assembly-root.ts` 零處提到它），而這條要證明的是「模式關著時 `exit_plan_mode` 仍是
 * 一個排得進呈現順序的已註冊工具」——`agent-factory.test.ts` 守的是用 echo／note 兩顆的泛用排序，不涵蓋這一點。
 * 產品組裝那側另外加了「模式關著時 `exit_plan_mode` 仍綁在模型上」，不替代它。
 *
 *  * 計劃模式的**行為**驗收（[#116](https://github.com/DemianLi/nexus-agent/issues/116)）。
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
 * 4. **拒絕在核准之前的證據**：模式外的呼叫拿到的是「不在計劃模式」，不是核准的措辭（第 2 組最後一條）。
 *    現在翻面了（#1276）：拒絕只在 `exit_plan_mode` 的工具本體裡，同 dsh，所以掛全攔核准閘門時模型先看到核准的措辭。
 *    曾經有一層排在閘門之前的拒絕（#1272 搬上事件匯流排、#1276 拿掉）；兩段行為的差分在
 *    `plan-mode-refusal-differential.test.ts`。
 * 5. **`/plan` 這條路**：人打的那一行到底有沒有讓下一輪的 prompt 變得不一樣
 *    （[#120](https://github.com/DemianLi/nexus-agent/issues/120)）。
 */

import { PassThrough } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { APPROVAL_POLICY_NEVER, SessionRegistry } from '@nexus/core';
import type { PluginEntry, QuestionInterruptItem, QuestionReply, SessionEvent } from '@nexus/core';
import { CANCELLED_MESSAGE } from '@nexus/plugin-ask-user';
import {
  createPlanModePlugin,
  DEFAULT_PLAN_GUIDANCE,
  EXIT_PLAN_MODE_TOOL_NAME,
  NOT_IN_PLAN_MODE_MESSAGE,
  PLAN_ALREADY_INACTIVE_MESSAGE,
  PLAN_APPROVE_LABEL,
  PLAN_APPROVED_MESSAGE,
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
import { createEchoPlugin, ECHO_TOOL_NAME } from '@nexus/plugin-echo';
import { createMemoryPlugin } from '@nexus/plugin-memory';
import { afterEach, describe, expect, it } from 'vitest';
import { createNexusAgent, HEADLESS_APPROVALS } from './agent-factory.js';
import { createCliAgent } from './assembly-root.js';
import { runRepl } from './cli.js';
import { shippedPlugins, withScriptedModel } from './fixtures.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';

const shipped = await shippedPlugins();

/** 出貨清單上 `plan-mode` 那一列換 config，其餘不動。不給就是出貨的樣子（`startActive` 關）。 */
function withPlanMode(config?: { startActive?: boolean; guidance?: string }): PluginEntry[] {
  return shipped.map((entry) =>
    entry.id === 'plan-mode' && config ? { ...entry, config } : entry,
  );
}

/** 暫存的 workspace，測完收掉。 */
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tmpRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

interface AssembleOptions {
  /** `plan-mode` 那一列的 config。省略就是出貨的樣子。 */
  readonly plan?: { startActive?: boolean; guidance?: string };
  /** 放在清單**最前面**的條目：註冊順序在計劃模式之前，所以更外層。 */
  readonly before?: readonly PluginEntry[];
  /** 對整份清單再做一次改動（例如換 `summarization` 那一列）。 */
  readonly patch?: (plugins: PluginEntry[]) => PluginEntry[];
  readonly workspace?: string;
  readonly headless?: boolean;
}

/** 在產品組裝上跑：出貨清單＋這一檔要的改動＋腳本模型。 */
async function assemble(turns: readonly ScriptedTurn[], options: AssembleOptions = {}) {
  const base = [...(options.before ?? []), ...withPlanMode(options.plan)];
  const plugins = withScriptedModel(options.patch ? options.patch(base) : base, turns);
  const built = await createCliAgent(
    { live: false, ...(options.workspace === undefined ? {} : { workspace: options.workspace }) },
    plugins,
    options.workspace,
    options.headless === true ? { approvals: HEADLESS_APPROVALS } : {},
  );
  return { ...built, model: built.model as ScriptedChatModel };
}

const quiet = (text = '好。'): ScriptedTurn[] => [{ content: text }];

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
const PLAN_SCRIPT: readonly ScriptedTurn[] = [
  {
    content: '我先規劃。',
    toolCalls: [{ name: EXIT_PLAN_MODE_TOOL_NAME, args: { plan: '# 計劃\n\n先看再改。' } }],
  },
  { content: '開始動手。' },
];

describe('計劃指引進不進 system prompt', () => {
  it('startActive 開著就夾進去', async () => {
    const { agent, model, dispose } = await assemble(quiet(), { plan: { startActive: true } });

    try {
      await agent.invoke(toAgentInvocation('嗨。'), { configurable: { thread_id: 'guidance-on' } });
    } finally {
      await dispose();
    }

    expect(systemPrompt(model.lastPrompt)).toContain(DEFAULT_PLAN_GUIDANCE);
  });

  /**
   * **這一條是「未激活不增加 token」那句話的執行版**（dsh
   * `packages/plan/plan-mode/README.zh.md` 的 Token 影響）。middleware 掛著、工具註冊著、
   * 但 prompt 裡一個字都沒有多——不然「掛了這個 plugin」就變成一筆每輪都在付的稅。
   *
   * 這一條走**出貨的 `plan-mode` 那一列、不加任何 config**：出貨預設是關的才算數。
   */
  it('出貨預設是關的，prompt 裡一個字都不多', async () => {
    const { agent, model, dispose } = await assemble(quiet());

    try {
      await agent.invoke(toAgentInvocation('嗨。'), {
        configurable: { thread_id: 'guidance-off' },
      });
    } finally {
      await dispose();
    }

    expect(systemPrompt(model.lastPrompt)).not.toContain(DEFAULT_PLAN_GUIDANCE);
  });

  it('部署換掉的指引就是原樣那一段', async () => {
    const guidance = '<部署自己寫的那一段>';
    const { agent, model, dispose } = await assemble(quiet(), {
      plan: { startActive: true, guidance },
    });

    try {
      await agent.invoke(toAgentInvocation('嗨。'), {
        configurable: { thread_id: 'guidance-own' },
      });
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
   *
   * 記憶 plugin 是**選配、不在出貨清單上**（出貨的 `agent-instructions` 把 `AGENTS.md` 當使用者訊息送，不進 system prompt），
   * 所以這一條在出貨清單前面加一顆 `createMemoryPlugin()`，仍然跑在產品組裝上。
   */
  it('記憶與指引在同一份 prompt 裡同時存在', async () => {
    const root = await tmpRoot('nexus-plan-');
    await writeFile(join(root, 'AGENTS.md'), '使用者的代號是胡桃。');
    const { agent, model, dispose } = await assemble(quiet(), {
      plan: { startActive: true },
      before: [createMemoryPlugin()],
      workspace: root,
    });

    try {
      await agent.invoke(toAgentInvocation('嗨。'), { configurable: { thread_id: 'memory' } });
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
   *
   * 這裡 `outer` 放在**整份出貨清單的最前面**，所以它在計劃模式之前註冊。
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

    const { agent, model, dispose } = await assemble(quiet(), {
      plan: { startActive: true },
      before: [outer],
    });

    try {
      await agent.invoke(toAgentInvocation('嗨。'), { configurable: { thread_id: 'outer' } });
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
  const { agent, model, sessions, attachSession, dispose } = await assemble(PLAN_SCRIPT, {
    plan: { startActive: true },
  });
  const config = { configurable: { thread_id: threadId } };
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
    ['同意與繼續規劃都選了', [PLAN_APPROVE_LABEL, PLAN_KEEP_PLANNING_LABEL], undefined, ''],
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
   * 照 dsh「沒有提問通道就拋錯」。`channel` 由產品組裝點自己算（`createCliAgent` 收 `approvals: HEADLESS_APPROVALS`，同
   * `cli.ts`）；少了這一格的話 plugin 退到「有人在」，這一輪會停下來問一個不會來的答案。以前這裡手交一顆
   * `createHostServicesPlugin({ channel })`，現在是產品算出來的那一顆。
   */
  it('headless → 請使用者自己切模式，沒有中斷，模式還開著', async () => {
    const { agent, sessions, attachSession, dispose } = await assemble(PLAN_SCRIPT, {
      plan: { startActive: true },
      headless: true,
    });
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
   * **不在模式裡、又掛著全攔的核准閘門：模型先看到核准的措辭**（[#1276](https://github.com/DemianLi/nexus-agent/issues/1276) 翻面）。
   *
   * 以前這一條釘的是相反的事：「說的是不在計劃模式，不是核准的措辭」，靠一層排在核准閘門之前的拒絕（先是 middleware 的
   * `prepend`，#1272 之後是 `tools/pre-execute` 的監聽者）。dsh 沒有那一層——它只在 `exit_plan_mode` 的工具本體裡檢查，
   * 而核准 listener 先於本體——demian 2026-10-09 決定照 dsh 拿掉。所以這裡掛一位**什麼工具都要核准**的探針
   * （`approval.patch.yml` 那一類組裝會長這樣），headless 底下呼叫先撞上探針，拿到「沒有人被問到」；本體的
   * 「不在計劃模式」要等核准放行才會走到。**絆索翻面不是刪**：以後有人再把拒絕排回閘門之前，這一條會紅。
   */
  it('模式外呼叫 + 全攔核准閘門 → 先看到核准的措辭，不是「不在計劃模式」', async () => {
    const askEverything: PluginEntry = {
      plugin: {
        name: 'probe-ask-everything',
        apply(registry) {
          registry.approvals.gate(() => ({ kind: 'ask', reason: '探針：每個工具都要人看過' }));
        },
      },
    };
    const { agent, sessions, attachSession, dispose } = await assemble(PLAN_SCRIPT, {
      before: [askEverything],
      headless: true,
    });
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
    expect(refusal?.text).toContain('是沒有人被問到');
    expect(refusal?.text).not.toContain(NOT_IN_PLAN_MODE_MESSAGE);
    // 日誌上記的是錯誤：核准閘門的拒絕帶碼（`APPROVAL_POLICY_NEVER`），不是模式外那種不帶碼的一般 `Error`。
    expect(exitVerdicts(sessions.root.events)).toEqual([
      {
        callId: expect.any(String),
        isError: true,
        error: expect.objectContaining({ code: APPROVAL_POLICY_NEVER }),
      },
    ]);
  });
});

describe('模式狀態活得過什麼', () => {
  it('同一條 thread 的下一輪還在', async () => {
    const { agent, model, dispose } = await assemble(
      [{ content: '第一輪。' }, { content: '第二輪。' }],
      { plan: { startActive: true } },
    );
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
   * 低門檻是把出貨清單上 `summarization` 那一列的 config 換掉（整份替換，所以其餘格照抄），
   * 不再另掛一顆摘要器。
   */
  it('一次真的壓縮之後還在', async () => {
    const root = await tmpRoot('nexus-plan-sum-');
    const lowThreshold = (plugins: PluginEntry[]): PluginEntry[] =>
      plugins.map((entry) =>
        entry.id === 'summarization'
          ? {
              ...entry,
              config: {
                ...(entry.config as Record<string, unknown>),
                trigger: [{ type: 'messages', value: 3 }],
                keep: { type: 'messages', value: 1 },
              },
            }
          : entry,
      );
    const { agent, model, sessions, attachSession, dispose } = await assemble(
      Array.from({ length: 12 }, (_, index) => ({ content: `第 ${index + 1} 次回話。` })),
      { plan: { startActive: true }, workspace: root, patch: lowThreshold },
    );
    const config = { configurable: { thread_id: 'summarize' } };
    const detach = attachSession(sessions);

    let last;
    try {
      for (const line of ['第一句。', '第二句。', '第三句。', '第四句。']) {
        last = await agent.invoke(toAgentInvocation(line), config);
      }
    } finally {
      detach();
      await dispose();
    }

    // **先證明壓縮真的發生了。** 少了這一句，一個根本沒觸發摘要的組裝也會讓下面兩條
    // 通過——那時綠的是「什麼都沒發生」，不是「熬過了壓縮」。外顯是會話日誌上的 `compaction/summary`
    // （#143；產品的摘要列把歷史放在 graph state、不寫工作區，所以不再看 `conversation_history` 目錄）。
    expect(sessions.root.events.some((event) => event.type === 'compaction/summary')).toBe(true);

    expect(last).toBeDefined();
    expect(systemPrompt(model.lastPrompt)).toContain(DEFAULT_PLAN_GUIDANCE);
  });
});

describe('工具目錄不隨模式變動', () => {
  /**
   * 照 dsh：模式沒啟用時 `exit_plan_mode` 仍然留在面向模型的 schema 裡，
   * 「這樣狀態轉換不會在規劃策略變更之外額外造成工具目錄變動」。
   * 代價是模式關著的組裝裡它是活的 schema、死的執行路徑——上面那條
   * 「模式外呼叫」測的就是那條死路徑說了什麼。
   */
  it('產品組裝：模式關著的時候 exit_plan_mode 也綁在模型上', async () => {
    const { agent, model, dispose } = await assemble(quiet());

    try {
      await agent.invoke(toAgentInvocation('嗨。'), { configurable: { thread_id: 'catalog' } });
    } finally {
      await dispose();
    }

    expect(model.boundToolNames).toContain(EXIT_PLAN_MODE_TOOL_NAME);
  });

  /**
   * **這一條留在手搭組裝**（理由見檔頭）：產品組裝不傳 `toolOrder`，而這一條要證明的是模式關著時
   * `exit_plan_mode` 仍是「排得進呈現順序的已註冊工具」——名字要是沒註冊，`toolOrder` 會指向不存在的工具。
   */
  it('手搭組裝：模式關著的時候工具也在，而且排得進 toolOrder', async () => {
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
    lines: string,
    turns: number,
  ): Promise<{
    model: ScriptedChatModel;
    stdout: string;
    stderr: string;
    events: readonly SessionEvent[];
  }> {
    const { agent, model, commands, sessions, sessionLog, attachSession, dispose } = await assemble(
      Array.from({ length: turns }, () => ({ content: '好。' })),
    );
    const detach = attachSession(sessions);
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
    const { model, stdout } = await repl('/plan\n先想想\n/plan off\n動手吧\n/exit\n', 2);

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
    const { events } = await repl('/plan\n先想想\n/plan off\n動手吧\n/exit\n', 2);

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
    const { stdout } = await repl('/plan\n先想想\n/exit\n', 1);

    expect(stdout).toContain(PLAN_ENTERED_MESSAGE);
    expect(stdout).not.toContain('先想想');
    expect(stdout).not.toContain('before_agent');
  });

  /**
   * **`/plan <message>` 的產品路徑**（[#776](https://github.com/DemianLi/nexus-agent/issues/776)）：
   * 日誌順序是命令那一對先收完、才有那一輪；第一次模型請求同時帶計劃指引與那句話。
   *
   * 只斷言「有一輪」的話，一個把話在 `command/done` 之前就送出去的實作照樣綠——順序才是這張卡的承諾。
   */
  it('/plan 幫我規劃：命令落定之後才開那一輪，第一個請求有指引也有那句話', async () => {
    const { model, events, stdout } = await repl('/plan 幫我規劃\n/exit\n', 1);

    expect(stdout).toContain(PLAN_ENTERED_MESSAGE);
    expect(
      events
        .map((event) => event.type)
        .filter((type) =>
          ['command/run', 'plan/mode', 'command/done', 'turn/start'].includes(type),
        ),
    ).toEqual(['command/run', 'plan/mode', 'command/done', 'turn/start']);
    expect(events.find((event) => event.type === 'turn/start')?.data).toMatchObject({
      text: '幫我規劃',
    });
    expect(model.prompts).toHaveLength(1);
    const first = model.prompts[0] ?? [];
    expect(systemPrompt(first)).toContain(DEFAULT_PLAN_GUIDANCE);
    expect(first.filter((message) => message.getType() === 'human').map((m) => m.text)).toEqual([
      '幫我規劃',
    ]);
  });

  /**
   * **`off` 以外都是訊息，同 dsh。** `/plan of` 是打錯的 `/plan off`，現在進計劃模式並把 `of` 送給模型
   * ——以前它回 error。翻面登記在 `index.ts` 的偏離說明，這條是它的絆索。
   */
  it('/plan of 是進入並把 of 送給模型，不是離開也不是錯誤', async () => {
    const { model, stderr } = await repl('/plan of\n/exit\n', 1);

    expect(stderr).toBe('');
    expect(model.prompts).toHaveLength(1);
    expect(systemPrompt(model.prompts[0] ?? [])).toContain(DEFAULT_PLAN_GUIDANCE);
  });

  it('/plan off 之後不開輪', async () => {
    const { model, stdout } = await repl('/plan off\n/exit\n', 1);

    expect(stdout).toContain(PLAN_ALREADY_INACTIVE_MESSAGE);
    expect(model.prompts).toHaveLength(0);
  });
});
