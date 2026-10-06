/**
 * 摘要的提示詞（[#432](https://github.com/DemianLi/nexus-agent/issues/432)）的驗收：量的是**生摘要那次呼叫真的送進模型的輸入**。
 *
 * 不拿 `SUMMARY_PROMPT` 常數本身比對——常數對、但沒傳到基座，或傳到了 root 卻沒到子代理，常數照樣綠。
 * 這裡的探針是假模型的 `prompts`：摘要那次呼叫只有一則 `HumanMessage`，內含 `{conversation}` 已被換掉的整份模板。
 *
 * 前提都要先立：**摘要真的發生過**（沒有它，一個門檻根本沒碰到的組裝也會讓「沒出現」通過），
 * 且摘要那次呼叫的輸入裡有**對話的字**（`{conversation}` 真的被換）。
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { SUMMARY_PROMPT } from '@nexus/core';
import type { PluginEntry } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

const SECTION = '## Primary Request and Intent';

/** 摘要那次呼叫的輸入：整份只有一則 Human 訊息、且帶著八段結構的第一段。 */
function summaryCalls(model: ScriptedChatModel): { index: number; text: string }[] {
  return model.prompts.flatMap((prompt: readonly BaseMessage[], index) =>
    prompt.length === 1 && prompt[0]?.getType() === 'human' && prompt[0].text.includes(SECTION)
      ? [{ index, text: prompt[0].text }]
      : [],
  );
}

/** 每一輪的回覆都獨一無二：第 n 個呼叫回 `回覆#n#`，摘要那次也一樣，所以摘要文字能在後面的輸入裡被認出來。 */
function numberedTurns(count: number): { content: string }[] {
  return Array.from({ length: count }, (_, index) => ({ content: `回覆#${index}#` }));
}

describe('摘要提示詞在產品路徑上', () => {
  it('root：摘要那次呼叫送進模型的是八段模板，對話已換進去，使用者的糾正逐字在裡面', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-sp-'));
    const model = new ScriptedChatModel({ turns: numberedTurns(30) });
    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      checkpointer: new MemorySaver(),
      plugins: [],
      summarization: {
        trigger: [{ type: 'messages', value: 6 }],
        keep: { type: 'messages', value: 2 },
      },
    });
    try {
      await agent.invoke(toAgentInvocation('幫我寫一支抓資料的腳本，用 axios。'), {
        configurable: { thread_id: 'sp-root' },
      });
      await agent.invoke(toAgentInvocation('不對，不要用 axios，改用 fetch，這是硬性規定。'), {
        configurable: { thread_id: 'sp-root' },
      });
      for (let index = 0; index < 4; index += 1) {
        await agent.invoke(toAgentInvocation(`再來第 ${index} 件事。`), {
          configurable: { thread_id: 'sp-root' },
        });
      }
    } finally {
      await dispose();
    }

    const calls = summaryCalls(model);
    // 前提：真的摘要過。
    expect(calls.length).toBeGreaterThan(0);
    const first = calls[0]?.text ?? '';
    // `{conversation}` 被換掉了，沒有殘留的佔位符，也沒有基座預設那句開場。
    expect(first).not.toContain('{conversation}');
    expect(first).not.toContain('You are a conversation summarizer');
    // 對話的字真的在裡面，包括那句糾正（逐字，不是改寫）。
    expect(first).toContain('不對，不要用 axios，改用 fetch，這是硬性規定。');
    // 結構：八段齊全，保護原意與糾正的兩條在。
    for (const heading of [
      '## Primary Request and Intent',
      '## Key Technical Concepts',
      '## Files and Code',
      '## Errors and Fixes',
      '## Pending Jobs',
      '## Current Work',
      '## Next Step',
      '## Critical Context',
    ]) {
      expect(first).toContain(heading);
    }
    expect(first).toContain(
      'Capture user feedback and explicit instructions faithfully, especially corrections.',
    );
    // 順序：對話在前、指令在後，所以指令裡那句 "ABOVE" 指得對。
    expect(first.indexOf('不對，不要用 axios')).toBeLessThan(first.indexOf(SECTION));
  });

  it('第二次壓縮：前一次的摘要在輸入裡，是 `<summary>` 包著的那個形狀', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-sp-'));
    const model = new ScriptedChatModel({ turns: numberedTurns(60) });
    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      checkpointer: new MemorySaver(),
      plugins: [],
      summarization: {
        trigger: [{ type: 'messages', value: 6 }],
        keep: { type: 'messages', value: 2 },
      },
    });
    try {
      for (let index = 0; index < 10; index += 1) {
        await agent.invoke(toAgentInvocation(`第 ${index} 句。`), {
          configurable: { thread_id: 'sp-twice' },
        });
      }
    } finally {
      await dispose();
    }

    const calls = summaryCalls(model);
    // 前提：至少壓縮了兩次。
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const [first, second] = [calls[0], calls[1]];
    // 第一次的摘要文字就是那個呼叫回的 `回覆#<序>#`，之後它被基座包進 `<summary>…</summary>`。
    const firstSummary = `回覆#${first?.index ?? -1}#`;
    expect(second?.text).toContain(`<summary>\n${firstSummary}\n</summary>`);
    // 指令裡說的「前一次摘要」長什麼樣，與基座實際包的那個一致：兩個開頭都有寫到。
    expect(second?.text).toContain(
      'You are in the middle of a conversation that has been summarized',
    );
    expect(second?.text).toContain('Here is a summary of the conversation to date:');
  });

  /**
   * **壓力要長在子代理身上，不能長在 root 身上**（同 `compaction-log.test.ts` 那條的 fixture 理由）：門檻用 token，
   * 子代理每一圈疊一坨大回話，root 只有「一句話＋一次委派」。摘要器自己也吃腳本輪，所以末尾多備幾格。
   */
  it('子代理：自己的摘要器同樣吃到這份模板，要摘的是它自己那一串', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-sp-'));
    const worker: PluginEntry = {
      plugin: {
        name: 'worker-crew',
        apply: (registry) =>
          void registry.subagents.register({ name: 'worker', description: '幹活的。' }),
      },
    };
    const bigBody = '這是一段子代理的大回話。'.repeat(200);
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '委派。',
          toolCalls: [{ name: 'task', args: { description: '幹活', subagent_type: 'worker' } }],
        },
        ...Array.from({ length: 10 }, () => ({
          content: bigBody,
          toolCalls: [{ name: 'ls', args: {} }],
        })),
        ...Array.from({ length: 8 }, () => ({ content: '收工。' })),
      ],
    });
    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      checkpointer: new MemorySaver(),
      plugins: [worker],
      summarization: {
        trigger: [{ type: 'tokens', value: 3_000 }],
        keep: { type: 'messages', value: 2 },
      },
    });
    try {
      await agent.invoke(toAgentInvocation('叫 worker 去做。'), {
        configurable: { thread_id: 'sp-sub' },
      });
    } finally {
      await dispose();
    }

    const calls = summaryCalls(model);
    // 前提：子代理真的摘要過（沒有它，一個壓力沒長在子代理身上的 fixture 也會讓下面通過）。
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.text).not.toContain('{conversation}');
      expect(call.text).not.toContain('You are a conversation summarizer');
      // 要摘的不是 root 那一串（「叫 worker 去做」）。
      expect(call.text).not.toContain('叫 worker 去做');
    }
    // 第一次摘的是子代理那一串：它的第一句是委派的 description「幹活」。
    expect(calls[0]?.text).toContain('Human: 幹活');
  });

  /**
   * 背景子代理走的是另一條編圖路（`compileSubagentGraph` 自己建一份預設的摘要器，再按名字併 fold 交出的 middleware）。
   * 併進去之後贏的要是我們這顆，不是基座那顆——不然這條路上的長任務還在用 `DEFAULT_SUMMARY_PROMPT`。
   */
  it('背景子代理的圖：贏的是我們的摘要器，吃到同一份模板', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-sp-'));
    const worker: PluginEntry = {
      plugin: {
        name: 'worker-bg',
        apply: (registry) =>
          void registry.subagents.register({ name: 'worker', description: '幹活的。' }),
      },
    };
    const bigBody = '這是一段背景子代理的大回話。'.repeat(200);
    const rootModel = new ScriptedChatModel({ turns: [{ content: '根不該被叫' }] });
    const bgModel = new ScriptedChatModel({
      turns: [
        ...Array.from({ length: 10 }, () => ({
          content: bigBody,
          toolCalls: [{ name: 'ls', args: {} }],
        })),
        ...Array.from({ length: 8 }, () => ({ content: '收工。' })),
      ],
    });
    const built = await createNexusAgent({
      model: rootModel,
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      checkpointer: new MemorySaver(),
      plugins: [worker],
      summarization: {
        trigger: [{ type: 'tokens', value: 3_000 }],
        keep: { type: 'messages', value: 2 },
      },
    });
    try {
      const graph = built.compileSubagent('worker', new MemorySaver(), bgModel) as unknown as {
        invoke(input: unknown, config: unknown): Promise<unknown>;
      };
      await graph.invoke(toAgentInvocation('背景任務。'), {
        configurable: { thread_id: 'sp-bg' },
      });
    } finally {
      await built.dispose();
    }

    const calls = summaryCalls(bgModel);
    // 前提：背景那張圖真的摘要過，而 root 那顆一次都沒被叫。
    expect(calls.length).toBeGreaterThan(0);
    expect(rootModel.prompts).toHaveLength(0);
    for (const call of calls) {
      expect(call.text).not.toContain('{conversation}');
      expect(call.text).not.toContain('You are a conversation summarizer');
    }
    expect(calls[0]?.text).toContain('Human: 背景任務。');
  });

  it('模板常數只有一個 {conversation}，而且它在指令之前', () => {
    // 基座只換第一個 `{conversation}`：指令本文裡再出現一個，換不到卻會被模型讀到。
    expect(SUMMARY_PROMPT.split('{conversation}')).toHaveLength(2);
    expect(SUMMARY_PROMPT.indexOf('{conversation}')).toBeLessThan(SUMMARY_PROMPT.indexOf(SECTION));
  });
});
