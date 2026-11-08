/**
 * 產品組裝裡 `exit_plan_mode`（#2353）的工具定義、模型看到的工具結果、提問中斷的酬載、日誌上的 `tool/result` 與
 * `plan/mode`、這一輪叫了模型幾次（收不收這一輪看這一格），與 `plan-mode-migration.baseline.json` 逐字相同。
 *
 * 走的是出貨清單（`plan-mode` 那一列開 `startActive`）＋腳本模型，要問人的案例先停在中斷上、再用 `Command({ resume })` 接回去。
 * 對照組在 `develop` `334a0e12`（這顆還是 LangChain 工具時）以 `K3C_RECORD=1` 錄的。`K3C_RECORD=1` 會拿當下的輸出覆寫對照組。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { Command } from '@langchain/langgraph';
import { convertMessagesToCompletionsMessageParams } from '@langchain/openai';
import type { NexusPlugin, PluginEntry, QuestionReply } from '@nexus/core';
import {
  EXIT_PLAN_MODE_TOOL_NAME,
  PLAN_APPROVE_LABEL,
  PLAN_KEEP_PLANNING_LABEL,
  PLAN_REVIEW_QUESTION_ID,
} from '@nexus/plugin-plan-mode';
import { expect, it } from 'vitest';

import { HEADLESS_APPROVALS } from './agent-factory.js';
import { createCliAgent, THREAD_ID } from './assembly-root.js';
import {
  shippedPlugins,
  shippedPluginsWithConfig,
  withoutTimeContext,
  withScriptedModel,
} from './fixtures.js';
import { toAgentInvocation } from './messages.js';
import type { ScriptedChatModel } from './scripted-model.js';

const BASELINE = new URL('./plan-mode-migration.baseline.json', import.meta.url);
const PLAN = '# 計劃\n\n先看再改。';

const shipped = withoutTimeContext(await shippedPlugins());
const GUIDANCE = (shipped.find((entry) => entry.id === 'plan-mode')?.config as { guidance: string })
  .guidance;

/** 核准閘門直接 deny `exit_plan_mode`。 */
function denyExit(): PluginEntry {
  return {
    plugin: {
      name: 'probe-deny',
      apply(registry) {
        registry.approvals.gate((exec, next) =>
          exec.name === EXIT_PLAN_MODE_TOOL_NAME ? { kind: 'deny', reason: '不准' } : next(),
        );
      },
    } satisfies NexusPlugin,
  };
}

interface Case {
  readonly args: Record<string, unknown>;
  readonly reply?: QuestionReply;
  readonly startActive?: boolean;
  readonly headless?: boolean;
  readonly attach?: boolean;
  readonly before?: () => PluginEntry;
}

const answer = (selected: string[], custom?: string): QuestionReply => ({
  answers: [{ id: PLAN_REVIEW_QUESTION_ID, selected, ...(custom === undefined ? {} : { custom }) }],
});

const cases: readonly (readonly [string, Case])[] = [
  ['同意', { args: { plan: PLAN }, reply: answer([PLAN_APPROVE_LABEL]) }],
  ['繼續規劃', { args: { plan: PLAN }, reply: answer([PLAN_KEEP_PLANNING_LABEL]) }],
  ['自由作答', { args: { plan: PLAN }, reply: answer([], '先補測試') }],
  ['同意又帶自由作答', { args: { plan: PLAN }, reply: answer([PLAN_APPROVE_LABEL], '順便') }],
  ['關掉審核', { args: { plan: PLAN }, reply: { cancelled: true } }],
  ['看不懂的回覆', { args: { plan: PLAN }, reply: {} }],
  ['不在計劃模式', { args: { plan: PLAN }, startActive: false }],
  ['沒有 # 標題', { args: { plan: '計劃：先看再改。' } }],
  ['沒有人可以回答', { args: { plan: PLAN }, headless: true }],
  ['沒接會話日誌', { args: { plan: PLAN }, attach: false }],
  ['核准閘門擋下', { args: { plan: PLAN }, before: denyExit }],
  ['少參數', { args: {} }],
  ['參數型別不對', { args: { plan: 1 } }],
  ['多一個鍵', { args: { plan: PLAN, extra: 1 }, reply: answer([PLAN_APPROVE_LABEL]) }],
];

async function runOne(_label: string, spec: Case): Promise<unknown> {
  const plugins = [
    ...(spec.before === undefined ? [] : [spec.before()]),
    ...withoutTimeContext(
      await shippedPluginsWithConfig('plan-mode', {
        guidance: GUIDANCE,
        startActive: spec.startActive ?? true,
      }),
    ),
  ];
  const built = await createCliAgent(
    { live: false },
    withScriptedModel(plugins, [
      {
        content: '交計劃。',
        toolCalls: [{ name: EXIT_PLAN_MODE_TOOL_NAME, args: spec.args, id: 'c1' }],
      },
      { content: '收工。' },
    ]),
    undefined,
    spec.headless === true ? { approvals: HEADLESS_APPROVALS } : {},
  );
  const detach = spec.attach === false ? () => {} : built.attachSession(built.sessions);
  const config = { configurable: { thread_id: THREAD_ID } };
  let raised: unknown;
  let messages: readonly BaseMessage[];
  try {
    const first = (await built.agent.invoke(toAgentInvocation('規劃一下'), config)) as {
      messages: BaseMessage[];
      __interrupt__?: readonly { value?: unknown }[];
    };
    raised = first.__interrupt__?.map((entry) => entry.value);
    messages = first.messages;
    if (spec.reply !== undefined && raised !== undefined) {
      const after = (await built.agent.invoke(
        new Command({ resume: spec.reply }) as never,
        config,
      )) as {
        messages: BaseMessage[];
      };
      messages = after.messages;
    }
  } finally {
    detach();
    await built.dispose();
  }
  const model = built.model as ScriptedChatModel;
  const bound = (model.boundTools ?? []) as StructuredToolInterface[];
  const tool = bound.find((entry) => entry.name === EXIT_PLAN_MODE_TOOL_NAME);
  const events = built.sessions.root.events;
  return {
    wire: tool === undefined ? undefined : JSON.stringify(convertToOpenAITool(tool)),
    raised: JSON.stringify(raised ?? null),
    calls: model.prompts.length,
    // 第二次起每一次請求送給供應商的 tool 訊息（Chat Completions 形狀）。
    sent: model.prompts
      .slice(1)
      .map((prompt) =>
        JSON.stringify(
          convertMessagesToCompletionsMessageParams({ messages: [...prompt], model: 'm' }).filter(
            (entry) => entry.role === 'tool',
          ),
        ),
      ),
    // state 裡那則工具結果帶不帶 `name`：core 拿掉 `name` 才不收這一輪（`turn-conclusion.ts`）。
    state: messages
      .filter((message) => message.getType() === 'tool')
      .map((message) => ({ name: (message as { name?: string }).name ?? null })),
    logged: events.flatMap((event): unknown[] =>
      event.type === 'tool/result'
        ? [{ isError: event.data.isError, error: event.data.error }]
        : event.type === 'plan/mode'
          ? [{ planMode: event.data.active }]
          : [],
    ),
  };
}

it('exit_plan_mode 的定義、結果、中斷與日誌，與對照組逐字相同', { timeout: 180_000 }, async () => {
  const now: Record<string, unknown> = {};
  for (const [label, spec] of cases) now[label] = await runOne(label, spec);
  if (process.env.K3C_RECORD === '1') {
    writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`);
    return;
  }
  const before = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, unknown>;
  expect(Object.keys(now)).toEqual(Object.keys(before));
  for (const key of Object.keys(before)) expect(now[key], key).toEqual(before[key]);
});
