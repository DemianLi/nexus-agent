/**
 * 工具結果暫存那一格 —— [#170](https://github.com/DemianLi/nexus-agent/issues/170)。
 *
 * 守的是一件會**丟資料**的事：基座把過大的工具結果搬去 backend，而**那次 write 失敗時
 * 它不保留原文**，只留一句「存不進去」。`ContainedFilesystemBackend` 的 `read-only` mode
 * 對每一次 write 回 `{ error }`，所以那個組裝底下每一則超過 80,000 字元的結果都會中。
 *
 * 修法是在組裝點把 `/large_tool_results` 路由到獨立的 `StateBackend`
 * （{@link ./agent-factory.ts} 的 `withToolResultStash`），於是那次 write 不會失敗。
 *
 * **這裡的判準一律是「暗號讀不讀得回來」，不是「訊息長什麼樣」。** 只看訊息會把
 * 「搬走了而且取得回來」跟「搬走了但取不回來」讀成同一件事 —— 前者第二輪 `read_file`
 * 拿到原文，後者拿到 `ENOENT`，而第一輪的訊息文字差不多。
 */

import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage, ToolMessage } from '@langchain/core/messages';
import type { NexusPlugin } from '@nexus/core';
import type { AnyBackendProtocol } from 'deepagents';
import { tool } from 'langchain';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { createNexusAgent, TOOL_RESULT_STASH_PREFIX } from './agent-factory.js';
import { createMountPlugin } from './fixtures.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

/** 暗號放在**最前面**：截斷與「只拿到預覽」都會讓它消失，`includes` 才分得出來。 */
const MARK = 'MURASAKI-7391';

/** 剛好越過基座那條線（`4 * toolTokenLimitBeforeEvict`，預設 `2e4` → 80,000 字元）。 */
const OVERSIZED = `${MARK}${'X'.repeat(80_001)}`;

/** 遠低於那條線 —— 這一則不該經過暫存那條路。 */
const SMALL = `${MARK}${'X'.repeat(100)}`;

/** 基座搬完之後告訴模型去讀的那個檔名。`call_1_0` 是腳本模型第一輪那次呼叫的 id。 */
const STASHED = `${TOOL_RESULT_STASH_PREFIX}/call_1_0.txt`;

function bulkPlugin(payload: string): NexusPlugin {
  return {
    name: 'bulk',
    apply: (registry) => {
      registry.tools.register(
        tool(() => payload, { name: 'bulk', description: '拿一坨東西。', schema: z.object({}) }),
      );
    },
  };
}

function toolResults(prompt: readonly BaseMessage[]): ToolMessage[] {
  return prompt.filter((message) => message.getType() === 'tool') as ToolMessage[];
}

/** 工具結果的文字。非文字區塊會被 `JSON.stringify` 攤平，暗號照樣找得到。 */
function resultText(prompt: readonly BaseMessage[] | undefined): string {
  const content = prompt === undefined ? undefined : toolResults(prompt).at(-1)?.content;
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

/**
 * 跑一場「拿一坨 → 用 `read_file` 讀回來」。
 *
 * @returns 模型第一輪看到的工具結果，與第二輪 `read_file` 拿回來的東西。
 */
async function fetchThenRead(
  payload: string,
  backend?: AnyBackendProtocol,
  extra: readonly NexusPlugin[] = [],
): Promise<{ first: string; readBack: string }> {
  const model = new ScriptedChatModel({
    turns: [
      { content: '', toolCalls: [{ name: 'bulk', args: {} }] },
      { content: '', toolCalls: [{ name: 'read_file', args: { file_path: STASHED, limit: 2 } }] },
      { content: '看完了。' },
    ],
  });
  const { agent, dispose } = await createNexusAgent({
    model,
    plugins: [bulkPlugin(payload), ...extra],
    ...(backend === undefined ? {} : { backend }),
  });
  try {
    await agent.invoke(toAgentInvocation('去拿一坨，然後讀回來。'));
  } finally {
    await dispose();
  }
  // 兩輪都要真的發生過。少了這一句，「模型第二輪根本沒被叫到」會讀成綠。
  expect(model.prompts.length).toBeGreaterThanOrEqual(3);
  return { first: resultText(model.prompts[1]), readBack: resultText(model.prompts[2]) };
}

async function containedRoot(mode: 'read-only' | 'workspace-write'): Promise<{
  root: string;
  backend: ContainedFilesystemBackend;
}> {
  const root = await mkdtemp(join(tmpdir(), `stash-${mode}-`));
  return { root, backend: new ContainedFilesystemBackend({ rootDir: root, mode }) };
}

describe('過大的工具結果搬走之後還取得回來', () => {
  it('read-only 組裝 —— 這一條就是 #170', async () => {
    // 修之前：模型收到 166 個字元的「存不進去」，接著 read_file 拿到 ENOENT，
    // 原文 80,014 個字元沒有任何地方還留著。
    const { backend } = await containedRoot('read-only');
    const { first, readBack } = await fetchThenRead(OVERSIZED, backend);

    expect(first).not.toContain('could not be saved');
    expect(readBack).toContain(MARK);
  });

  it('workspace-write 組裝', async () => {
    const { backend } = await containedRoot('workspace-write');
    const { readBack } = await fetchThenRead(OVERSIZED, backend);
    expect(readBack).toContain(MARK);
  });

  it('預設組裝（StateBackend）', async () => {
    const { readBack } = await fetchThenRead(OVERSIZED);
    expect(readBack).toContain(MARK);
  });

  /**
   * **這條是絆索，它釘的是基座那個寫死的路徑。**
   *
   * 我們的路由只蓋得住 `TOOL_RESULT_STASH_PREFIX` 這一個前綴。基座哪天把
   * `/large_tool_results/` 改成別的，路由就落空、`read-only` 那條缺陷會**無聲地回來** ——
   * 上面三條仍然綠（暗號從工作區那一側讀得回來，除了 read-only 那格）。所以這裡直接
   * 斷言基座指路的那個路徑真的在我們的前綴底下。
   */
  it('基座指去的路徑落在我們路由的前綴底下', async () => {
    const { backend } = await containedRoot('workspace-write');
    const { first } = await fetchThenRead(OVERSIZED, backend);
    const advertised = /at this path: (\S+)/.exec(first)?.[1];
    expect(advertised).toBeDefined();
    expect(advertised?.startsWith(`${TOOL_RESULT_STASH_PREFIX}/`)).toBe(true);
  });

  it('暫存不再落在使用者的工作區裡 —— 它是 harness 的暫存，不是模型在做的事', async () => {
    // 這是這張卡刻意改掉的行為：修之前 workspace-write 會在使用者的專案目錄下留一個
    // 永遠沒人清的 large_tool_results/。dsh 的 spill 同樣不寫工作區（它有自己的私有根）。
    const { root, backend } = await containedRoot('workspace-write');
    await fetchThenRead(OVERSIZED, backend);
    expect(await readdir(root)).not.toContain('large_tool_results');
  });

  /**
   * **有 plugin 掛路由時，暫存那一格是包在包裡面的，這條驗它還通。**
   *
   * `foldBackend` 看到有人 `backend.mount()` 就把組裝點給的那個再包一層 `CompositeBackend`，
   * 而組裝點給的已經是一個 `CompositeBackend` 了。外層先比它自己的前綴、沒中就把**完整
   * 路徑**交給 default，內層才比暫存那個前綴 —— 兩層剝前綴不能互相吃掉對方。
   */
  it('plugin 也掛了路由時，兩層 composite 疊起來仍然取得回來', async () => {
    const { backend } = await containedRoot('read-only');
    const { readBack } = await fetchThenRead(OVERSIZED, backend, [createMountPlugin('/memories/')]);
    expect(readBack).toContain(MARK);
  });

  it('沒過門檻的結果原樣通過 —— 這條路根本不該碰它', async () => {
    const { backend } = await containedRoot('read-only');
    const { first } = await fetchThenRead(SMALL, backend);
    expect(first).toContain(SMALL);
    expect(first).not.toContain('Tool result too large');
  });
});

describe('路由開的是暫存那一格，不是把 fence 打開', () => {
  it('read-only 底下模型自己的 write_file 照樣被擋，措辭一字不動', async () => {
    // 少了這一條，「把 read-only 整個路由掉」會跟「只路由暫存那一格」一樣綠。
    const { backend } = await containedRoot('read-only');
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '',
          toolCalls: [{ name: 'write_file', args: { file_path: '/notes.txt', content: '嗨' } }],
        },
        { content: '好。' },
      ],
    });
    const { agent, dispose } = await createNexusAgent({ model, plugins: [], backend });
    try {
      await agent.invoke(toAgentInvocation('寫個檔。'));
    } finally {
      await dispose();
    }
    expect(resultText(model.prompts[1])).toContain('這個 backend 是唯讀的');
  });
});
