/**
 * glob pattern 大括號上限的接線：經 `createNexusAgent` 組裝、基座真的 `glob` 工具、真的工作區 backend。
 * 超過上限的那一次，模型收到錯誤、帶 `SEARCH_INVALID_PATTERN`，backend 的 `glob` 一次都沒被叫。
 * 量法本身的測試在 `packages/nexus-core/src/glob-pattern-limit.test.ts`。
 *
 * 零憑證、零外部連線：模型是 `ScriptedChatModel`。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import {
  GLOB_PATTERN_MAX_EXPANSIONS,
  GLOB_PATTERN_TOO_COMPLEX,
  SEARCH_INVALID_PATTERN,
  toolErrorOf,
} from '@nexus/core';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedToolCall } from './scripted-model.js';

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function textOf(message: ToolMessage | undefined): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  return (content ?? [])
    .map((block) => ((block as { text?: unknown }).text as string | undefined) ?? '')
    .join('');
}

/** 組一個 agent，照順序打完這些工具呼叫，回每顆工具結果與 backend 的 `glob` 被叫的次數。 */
async function run(calls: readonly ScriptedToolCall[]) {
  const root = await mkdtemp(join(tmpdir(), 'glob-pattern-limit-'));
  roots.push(root);
  await writeFile(join(root, 'a.ts'), 'x\n');
  await writeFile(join(root, 'b.md'), 'x\n');
  const backend = new ContainedFilesystemBackend({ rootDir: root, mode: 'workspace-write' });
  const glob = vi.spyOn(backend, 'glob');
  const model = new ScriptedChatModel({
    turns: [...calls.map((call) => ({ content: '', toolCalls: [call] })), { content: '收工。' }],
  });
  const { agent, dispose } = await createNexusAgent({
    model,
    plugins: [],
    backend,
    checkpointer: new MemorySaver(),
  });
  let state: { messages: BaseMessage[] };
  try {
    state = (await agent.invoke(toAgentInvocation('找。'), {
      configurable: { thread_id: 'glob-pattern-limit' },
    })) as { messages: BaseMessage[] };
  } finally {
    await dispose();
  }
  return {
    results: state.messages.filter((message): message is ToolMessage =>
      ToolMessage.isInstance(message),
    ),
    globCalls: glob.mock.calls.length,
  };
}

describe('glob pattern 的大括號上限經組裝接上', { timeout: 30_000 }, () => {
  it('超過上限回錯誤、帶碼，backend 沒被叫', async () => {
    const pattern = `**/{1..${GLOB_PATTERN_MAX_EXPANSIONS + 1}}.ts`;
    const { results, globCalls } = await run([{ name: 'glob', args: { pattern } }]);
    expect(results[0]?.status).toBe('error');
    expect(textOf(results[0])).toBe(`Error finding files: ${GLOB_PATTERN_TOO_COMPLEX}`);
    expect(results[0] && toolErrorOf(results[0])?.code).toBe(SEARCH_INVALID_PATTERN);
    expect(globCalls).toBe(0);
  });

  it('上限之內照常：`**/*.{ts,tsx}` 找得到檔', async () => {
    const { results, globCalls } = await run([
      { name: 'glob', args: { pattern: '**/*.{ts,tsx}' } },
    ]);
    expect(results[0]?.status).not.toBe('error');
    expect(textOf(results[0])).toBe('/a.ts');
    expect(globCalls).toBe(1);
  });
});
