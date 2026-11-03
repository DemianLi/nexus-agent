/**
 * 產品組裝裡 `request_sandbox_escalation`（#2353）的工具定義、模型看到的工具結果、核准中斷的酬載、日誌上的
 * `tool/result`、這一輪叫了模型幾次，與 `sandbox-escalation-migration.baseline.json` 逐字相同。
 *
 * 走的是 `createCliAgent` ＋ 出貨清單 ＋ `--workspace`／`--sandbox`，腳本是「寫入被擋 → 升級 → 重試寫入」；要問人的案例先停在中斷上、
 * 再用 `Command({ resume })` 接回去。核准之後重試那一次的檔案在不在也記下來：grant 認領得到才寫得進去。
 * 對照組在 `develop` `334a0e12`（這顆還是 LangChain 工具時）以 `K3C_RECORD=1` 錄的。`K3C_RECORD=1` 會拿當下的輸出覆寫對照組。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { Command } from '@langchain/langgraph';
import { convertMessagesToCompletionsMessageParams } from '@langchain/openai';
import type { SandboxMode } from '@nexus/core';
import { SANDBOX_ESCALATION_TOOL_NAME } from '@nexus/plugin-sandbox-policy';
import { afterEach, expect, it } from 'vitest';

import { HEADLESS_APPROVALS } from './agent-factory.js';
import { createCliAgent } from './assembly-root.js';
import { shippedPlugins, withScriptedModel } from './fixtures.js';
import { toAgentInvocation } from './messages.js';
import type { ScriptedChatModel } from './scripted-model.js';

const BASELINE = new URL('./sandbox-escalation-migration.baseline.json', import.meta.url);
const shipped = await shippedPlugins();

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const ARGS = {
  file_path: '/a.txt',
  sandbox_permissions: 'workspace-write',
  justification: '要寫報告',
};

interface Case {
  readonly args: Record<string, unknown>;
  readonly resume?: unknown;
  readonly mode?: SandboxMode;
  readonly headless?: boolean;
}

const cases: readonly (readonly [string, Case])[] = [
  ['核准', { args: ARGS, resume: { decisions: [{ type: 'approve' }] } }],
  ['拒絕', { args: ARGS, resume: { decisions: [{ type: 'reject' }] } }],
  ['拒絕帶理由', { args: ARGS, resume: { decisions: [{ type: 'reject', message: '不行' }] } }],
  ['看不懂的回覆', { args: ARGS, resume: { decisions: [{ type: 'maybe' }] } }],
  ['不加寬', { args: ARGS, mode: 'workspace-write' }],
  ['沒指名檔案', { args: { ...ARGS, file_path: ' ' } }],
  ['理由空白', { args: { ...ARGS, justification: ' ' } }],
  ['目標詞彙外', { args: { ...ARGS, sandbox_permissions: 'danger-full-access' } }],
  ['少欄位', { args: { file_path: '/a.txt' } }],
  ['多一個鍵', { args: { ...ARGS, extra: 1 }, resume: { decisions: [{ type: 'approve' }] } }],
  ['沒有人可以回答', { args: ARGS, headless: true }],
];

async function runOne(label: string, spec: Case): Promise<unknown> {
  const root = mkdtempSync(join(tmpdir(), 'nexus-escalation-migration-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const write = (id: string) => ({
    content: '',
    toolCalls: [{ name: 'write_file', args: { file_path: '/a.txt', content: '一' }, id }],
  });
  const built = await createCliAgent(
    { live: false, workspace: root, sandbox: spec.mode ?? 'read-only' },
    withScriptedModel(shipped, [
      write('w1'),
      {
        content: '',
        toolCalls: [{ name: SANDBOX_ESCALATION_TOOL_NAME, args: spec.args, id: 'e1' }],
      },
      write('w2'),
      { content: '收工。' },
    ]),
    root,
    spec.headless === true ? { approvals: HEADLESS_APPROVALS } : {},
  );
  const detach = built.attachSession(built.sessions);
  const config = { configurable: { thread_id: `escalation-migration-${label}` } };
  let raised: unknown;
  let messages: readonly BaseMessage[];
  try {
    const first = (await built.agent.invoke(toAgentInvocation('寫一個檔。'), config)) as {
      messages: BaseMessage[];
      __interrupt__?: readonly { value?: unknown }[];
    };
    raised = first.__interrupt__?.map((entry) => entry.value);
    messages = first.messages;
    if (spec.resume !== undefined && raised !== undefined) {
      const after = (await built.agent.invoke(
        new Command({ resume: spec.resume }) as never,
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
  const tool = bound.find((entry) => entry.name === SANDBOX_ESCALATION_TOOL_NAME);
  return {
    wire: tool === undefined ? undefined : JSON.stringify(convertToOpenAITool(tool)),
    raised: JSON.stringify(raised ?? null),
    calls: model.prompts.length,
    // 最後一次請求送給供應商的 tool 訊息（Chat Completions 形狀），前面幾次是它的前綴。
    sent: JSON.stringify(
      convertMessagesToCompletionsMessageParams({
        messages: [...(model.prompts.at(-1) ?? [])],
        model: 'm',
      }).filter((entry) => entry.role === 'tool'),
    ),
    state: messages
      .filter((message) => message.getType() === 'tool')
      .map((message) => ({ name: (message as { name?: string }).name ?? null })),
    logged: built.sessions.root.events.flatMap((event) =>
      event.type === 'tool/result'
        ? [{ callId: event.data.callId, isError: event.data.isError, error: event.data.error }]
        : [],
    ),
    written: existsSync(join(root, 'a.txt')),
  };
}

it(
  'request_sandbox_escalation 的定義、結果、中斷與日誌，與對照組逐字相同',
  { timeout: 180_000 },
  async () => {
    const now: Record<string, unknown> = {};
    for (const [label, spec] of cases) now[label] = await runOne(label, spec);
    if (process.env.K3C_RECORD === '1') {
      writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`);
      return;
    }
    const before = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(now)).toEqual(Object.keys(before));
    for (const key of Object.keys(before)) expect(now[key], key).toEqual(before[key]);
  },
);
