/**
 * 子代理照 dsh 不停下來問人，也知道自己是被委派的——[#324](https://github.com/DemianLi/nexus-agent/issues/324)
 * 驗收的第 2、3 條。第 1 條（核准）翻面寫在 `interrupt.test.ts`、`waiting-cards.test.ts`、`tool-card-from-log.test.ts`。
 *
 * 產品路徑：真的組裝、真的 pump，同 `tool-card-from-log.test.ts`。碼從子代理自己的會話日誌讀（`tool/result` 的
 * `error`）——dsh 釘的是同一個形狀（`tool-ask-user.spec.ts:270-299`），web 與離線掃描也讀那裡。
 *
 * 子代理的訊息不在 root 的結果裡，模型看到什麼只從 `ScriptedChatModel.prompts` 看得到（`lastPrompt` 永遠是 root
 * 最後那輪）。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { NexusPlugin } from '@nexus/core';
import { SUBAGENT_DELEGATION_CONTEXT, TOOL_ERROR_PREFIX } from '@nexus/core';
import {
  ASK_USER_QUESTION_TOOL_NAME,
  createAskUserPlugin,
  DELEGATED_CALLER_ERROR,
  DELEGATED_CALLER_MESSAGE,
} from '@nexus/plugin-ask-user';
import { createPlanModePlugin } from '@nexus/plugin-plan-mode';
import { createSubmitRecordPlugin } from '@nexus/plugin-submit-record';
import type { Event } from '@nexus/wire';
import { GENERAL_PURPOSE_SUBAGENT } from 'deepagents';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const WORKER_PROMPT = '你是 worker，只做交代給你的事。';

const WORKER: NexusPlugin = {
  name: 'worker-host',
  apply(registry) {
    registry.subagents.register({
      name: 'worker',
      description: '幹活的。',
      systemPrompt: WORKER_PROMPT,
    });
  },
};

/** 什麼都不做的工具：讓子代理多叫一次模型，驗「每次」而不是「第一次」。 */
const NOOP: NexusPlugin = {
  name: 'noop',
  apply(registry) {
    registry.tools.register(
      tool(() => '好', { name: 'noop', description: '什麼都不做。', schema: z.object({}) }),
    );
  },
};

const GP = GENERAL_PURPOSE_SUBAGENT.name;

function delegate(subagentType: string): ScriptedTurn {
  return {
    content: '委派。',
    toolCalls: [{ name: 'task', args: { description: '幹活', subagent_type: subagentType } }],
  };
}

const isRootDone = (frame: Event): boolean =>
  frame.method === 'lifecycle' &&
  frame.params.namespace.length === 0 &&
  (frame.params.data as { graph_name?: unknown }).graph_name === 'root' &&
  ['completed', 'failed'].includes(String((frame.params.data as { event?: unknown }).event));

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** 真的組裝跑一輪到收尾——serve 那條路的形狀。 */
async function runOnce(turns: readonly ScriptedTurn[], plugins: readonly NexusPlugin[]) {
  const root = await mkdtemp(join(tmpdir(), 'nexus-delegated-'));
  const model = new ScriptedChatModel({ turns });
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    plugins: [...plugins],
    backend: new ContainedFilesystemBackend({ rootDir: root, mode: 'workspace-write' }),
  });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'delegated');
  const detach = built.attachSession(pump.sessions);
  const frames: Event[] = [];
  const line = new AbortController();
  const stream = pump.subscribe(['messages', 'tools', 'lifecycle', 'input'], line.signal);
  const draining = (async () => {
    for await (const frame of stream) frames.push(frame);
  })();

  await pump.submit({ kind: 'message', text: '委派' });
  await until(() => frames.some(isRootDone));
  await pump.whenIdle();

  return {
    pump,
    model,
    close: async () => {
      line.abort();
      await draining;
      detach();
      await built.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** 一份 prompt 是誰的：子代理那幾輪的人話是 `task` 的描述，root 的是使用者說的那句。 */
function isSubagentPrompt(prompt: readonly BaseMessage[]): boolean {
  return prompt.some((message) => message.getType() === 'human' && message.text === '幹活');
}

function systemText(prompt: readonly BaseMessage[]): string {
  return prompt.find((message) => message.getType() === 'system')?.text ?? '';
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('子代理叫 `ask_user_question`：拒絕、帶 `DELEGATED_CALLER`、不停下來', () => {
  for (const subagentType of ['worker', GP]) {
    it(
      subagentType === GP ? 'fold 補的 general-purpose' : '登記過的子代理',
      async () => {
        const run = await runOnce(
          [
            delegate(subagentType),
            {
              content: '',
              toolCalls: [
                {
                  name: ASK_USER_QUESTION_TOOL_NAME,
                  args: { questions: [{ id: 'day', question: '哪一天？' }] },
                },
              ],
            },
            { content: '子代理收工。' },
            { content: '根收工。' },
          ],
          [WORKER, createAskUserPlugin()],
        );
        try {
          expect(run.pump.awaitingInput).toBe(false);
          expect(run.pump.pendings).toHaveLength(0);

          const subagents = run.pump.sessions
            .list()
            .filter((session) => session.address.kind === 'subagent');
          expect(subagents).toHaveLength(1);
          const result = subagents[0]?.log.events.find((event) => event.type === 'tool/result');
          expect(result?.data).toMatchObject({ isError: true, error: DELEGATED_CALLER_ERROR });

          // 模型看到的那一句：前綴由 `toolRefusal` 加，後面是 dsh 那句的中文。
          const refusal = run.model.prompts
            .filter(isSubagentPrompt)
            .flat()
            .find((message) => message.getType() === 'tool');
          expect(refusal?.text).toBe(`${TOOL_ERROR_PREFIX}${DELEGATED_CALLER_MESSAGE}`);
        } finally {
          await run.close();
        }
      },
      20000,
    );
  }
});

describe('委派聲明：子代理每次模型請求都有，root 的沒有', () => {
  /**
   * **子代理自己的提示詞也要還在**：只驗「帶著聲明」的話，把整段系統訊息換成那一句也會綠。恰好一次：middleware
   * 疊了兩層會變兩次。
   */
  for (const [subagentType, ownPrompt] of [
    ['worker', WORKER_PROMPT],
    [GP, GENERAL_PURPOSE_SUBAGENT.systemPrompt],
  ] as const) {
    it(
      subagentType === GP ? 'fold 補的 general-purpose' : '登記過的子代理',
      async () => {
        const run = await runOnce(
          [
            delegate(subagentType),
            { content: '', toolCalls: [{ name: 'noop', args: {} }] },
            { content: '子代理收工。' },
            { content: '根收工。' },
          ],
          [WORKER, NOOP],
        );
        try {
          const subagentPrompts = run.model.prompts.filter(isSubagentPrompt);
          const rootPrompts = run.model.prompts.filter((prompt) => !isSubagentPrompt(prompt));
          // 前提：子代理叫了兩次模型，root 兩次（派出去、收尾）。
          expect(subagentPrompts).toHaveLength(2);
          expect(rootPrompts).toHaveLength(2);

          for (const prompt of subagentPrompts) {
            const text = systemText(prompt);
            expect(occurrences(text, SUBAGENT_DELEGATION_CONTEXT)).toBe(1);
            expect(text).toContain(ownPrompt);
          }
          for (const prompt of rootPrompts) {
            expect(systemText(prompt)).not.toContain(SUBAGENT_DELEGATION_CONTEXT);
          }
        } finally {
          await run.close();
        }
      },
      20000,
    );
  }
});

/**
 * **真的會停下來問人的工具**，不只是測試用的 `danger`：閘門不看名字，產品裡掛 `ask` 的每一顆在子代理裡都拿到
 * `policy-never` 那句。`exit_plan_mode` 在 root 上模式外先被 plan-mode 自己那層 middleware 擋下；那層到不了子代理
 * （[#327](https://github.com/DemianLi/nexus-agent/issues/327)），所以子代理裡是閘門先拒——以前是先停下來問人、核准了才被
 * 本體拒。
 */
describe('產品裡掛 `ask` 的工具在子代理裡也不停下來', () => {
  const cases = [
    {
      name: 'exit_plan_mode',
      args: { plan: '計劃' },
      plugin: createPlanModePlugin(),
      reason: '計劃要有人看過才算獲准',
    },
    {
      name: 'submit_record',
      args: { file_path: '/out.csv', record: { 姓名: '阿明' } },
      plugin: createSubmitRecordPlugin(),
      reason: '這一列要寫出去，先讓人看過',
    },
  ];
  for (const { name, args, plugin, reason } of cases) {
    it(
      name,
      async () => {
        const run = await runOnce(
          [
            delegate('worker'),
            { content: '', toolCalls: [{ name, args }] },
            { content: '子代理收工。' },
            { content: '根收工。' },
          ],
          [WORKER, plugin],
        );
        try {
          expect(run.pump.awaitingInput).toBe(false);
          const refusal = run.model.prompts
            .filter(isSubagentPrompt)
            .flat()
            .find((message) => message.getType() === 'tool');
          expect(refusal?.text).toContain(reason);
          expect(refusal?.text).toContain('沒有人被問到');
        } finally {
          await run.close();
        }
      },
      20000,
    );
  }
});
