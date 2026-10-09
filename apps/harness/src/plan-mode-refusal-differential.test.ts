/**
 * **差分測試**（[#1272](https://github.com/DemianLi/nexus-agent/issues/1272)，S1b）：plan-mode 的模式外拒絕搬載體
 * 前後，模型看到的東西逐字相同。
 *
 * 搬的是 `exit_plan_mode` 在模式外的拒絕：從 `createPlanModeMiddleware` 的 `wrapToolCall` 搬到
 * `tools/pre-execute` 的一位監聽者。**這個檔在搬之前先寫、先在 develop 上跑綠、commit，搬完之後一字不改仍要綠**——
 * 它是「行為等價」的證據本身，不是搬完才補的斷言。所以期望值是寫死的字面值（從搬之前的 develop 量出來，
 * 並且對過 `plan-mode.test.ts` 與 `delegated-subagent.test.ts` 已有的斷言），不從實作裡算。
 *
 * 每個案例都比兩樣東西：模型下一輪收到的 `ToolMessage`（文字與狀態），以及日誌上那顆 `tool/result` 的判定（不含本文）。
 * 案例選的是 `active()` 的每一個分岔——它問的是 `sessions.forCall` 的四種結果：
 *
 * - `ok`：接了一份日誌，模式開或關。
 * - `not-attached`：組裝點沒接 `attachSession`，退回 `startActive`。
 * - `ambiguous`：接了兩份，挑不出來，退回 `startActive`。
 * - 還有「掛一顆什麼都要問的核准閘門」：拒絕要在問人之前，模型看到的是模式、不是核准的措辭。
 *
 * 子代理那一格（root 開著計劃模式、子代理叫 `exit_plan_mode`）已由 `delegated-subagent.test.ts` 逐字釘住
 * （`${TOOL_ERROR_PREFIX}${NOT_IN_PLAN_MODE_MESSAGE}`），這裡不重做一遍真的委派。
 */

import type { BaseMessage } from '@langchain/core/messages';
import { createHostServicesPlugin, SessionRegistry } from '@nexus/core';
import type { PluginEntry, SessionEvent } from '@nexus/core';
import {
  createPlanModePlugin,
  EXIT_PLAN_MODE_TOOL_NAME,
  NOT_IN_PLAN_MODE_MESSAGE,
  PLAN_NO_REVIEWER_MESSAGE,
  PLAN_NOT_ATTACHED_TOOL_MESSAGE,
} from '@nexus/plugin-plan-mode';
import { describe, expect, it } from 'vitest';
import { createNexusAgent, HEADLESS_APPROVALS } from './agent-factory.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

/** 腳本：叫一次 `exit_plan_mode` 再收工。 */
const SCRIPT = [
  {
    content: '我先規劃。',
    toolCalls: [{ name: EXIT_PLAN_MODE_TOOL_NAME, args: { plan: '# 計劃\n\n先看再改。' } }],
  },
  { content: '開始動手。' },
];

/** 一顆什麼工具都要人看過的核准閘門（`approval.patch.yml` 那一類組裝）。 */
const askEverything: PluginEntry = {
  plugin: {
    name: 'probe-ask-everything',
    apply(registry) {
      registry.approvals.gate(() => ({ kind: 'ask', reason: '探針：每個工具都要人看過' }));
    },
  },
};

interface Scenario {
  readonly startActive: boolean;
  /** 接幾份會話註冊表：0 ＝ `not-attached`，1 ＝ `ok`，2 ＝ `ambiguous`。 */
  readonly attached: 0 | 1 | 2;
  /** 有人可以回答計劃審核嗎（`policy-never` ＝ 沒有人）。模式開著的案例靠它走完本體而不卡在 `interrupt()`。 */
  readonly gate?: boolean;
}

interface Fingerprint {
  readonly toolMessages: readonly { readonly text: string; readonly status: string | undefined }[];
  readonly verdicts: readonly unknown[];
}

/** 日誌上 `exit_plan_mode` 那幾顆 `tool/result` 的判定，不含訊息本文。 */
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
    const { message: _message, callId: _callId, ...verdict } = event.data;
    return [verdict];
  });
}

async function run(scenario: Scenario): Promise<Fingerprint> {
  const model = new ScriptedChatModel({ turns: SCRIPT });
  const { agent, attachSession, dispose } = await createNexusAgent({
    model,
    plugins: [
      createHostServicesPlugin({ channel: { kind: 'policy-never' } }),
      ...(scenario.gate === true ? [askEverything] : []),
      createPlanModePlugin({ startActive: scenario.startActive }),
    ],
    approvals: HEADLESS_APPROVALS,
  });
  const sessions = new SessionRegistry('plan');
  const second = new SessionRegistry('plan-2');
  const detaches: (() => void)[] = [];
  if (scenario.attached >= 1) detaches.push(attachSession(sessions));
  if (scenario.attached >= 2) detaches.push(attachSession(second));

  try {
    const result = await agent.invoke(toAgentInvocation('幫我改一下。'), {
      configurable: { thread_id: 'differential' },
    });
    const toolMessages = (result.messages as BaseMessage[])
      .filter((message) => message.getType() === 'tool')
      .map((message) => ({
        text: message.text,
        status: (message as { status?: string }).status,
      }));
    return { toolMessages, verdicts: exitVerdicts(sessions.root.events) };
  } finally {
    for (const detach of detaches.reverse()) detach();
    await dispose();
  }
}

const REFUSED = {
  text: `Error: ${NOT_IN_PLAN_MODE_MESSAGE}`,
  status: 'error',
};

describe('plan-mode 模式外拒絕：搬載體前後，模型看到的逐字相同', () => {
  it('接了一份日誌、模式關著 → 拒絕，日誌記錯誤、不帶碼', async () => {
    const seen = await run({ startActive: false, attached: 1 });
    expect(seen.toolMessages).toEqual([REFUSED]);
    expect(seen.verdicts).toEqual([{ isError: true }]);
  });

  it('接了一份日誌、模式開著 → 放行，走到工具本體（沒有人可以回答）', async () => {
    const seen = await run({ startActive: true, attached: 1 });
    expect(seen.toolMessages).toEqual([
      { text: `Error: ${PLAN_NO_REVIEWER_MESSAGE}`, status: 'error' },
    ]);
    expect(seen.verdicts).toEqual([{ isError: true }]);
  });

  it('掛一顆什麼都要問的閘門、模式關著 → 說的仍是「不在計劃模式」，不是核准的措辭', async () => {
    const seen = await run({ startActive: false, attached: 1, gate: true });
    expect(seen.toolMessages).toEqual([REFUSED]);
    expect(seen.verdicts).toEqual([{ isError: true }]);
  });

  it('沒接日誌（not-attached）：退回 startActive——關 → 拒絕', async () => {
    const seen = await run({ startActive: false, attached: 0 });
    expect(seen.toolMessages).toEqual([REFUSED]);
  });

  it('沒接日誌（not-attached）：退回 startActive——開 → 放行，本體回「還沒接上」', async () => {
    const seen = await run({ startActive: true, attached: 0 });
    expect(seen.toolMessages).toEqual([
      { text: `Error: ${PLAN_NOT_ATTACHED_TOOL_MESSAGE}`, status: 'error' },
    ]);
  });

  it('接了兩份（ambiguous）：不猜，退回 startActive——關 → 拒絕', async () => {
    const seen = await run({ startActive: false, attached: 2 });
    expect(seen.toolMessages).toEqual([REFUSED]);
  });

  it('接了兩份（ambiguous）：不猜，退回 startActive——開 → 放行，本體回 not-root（同一句「不在計劃模式」）', async () => {
    const seen = await run({ startActive: true, attached: 2 });
    expect(seen.toolMessages).toEqual([REFUSED]);
  });
});
