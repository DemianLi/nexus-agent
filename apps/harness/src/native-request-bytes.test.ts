/**
 * 兩個 loop 送給模型的請求，投影後逐位元組相同（#2416）：同一份組裝、同一份腳本，`agentLoop` 明給 `langgraph` 與 `native` 各跑一次，
 * 比每一次模型呼叫收到的訊息串（含 system 訊息與工具結果；欄位見 {@link project}）與綁定的工具清單（`convertToOpenAITool` 的整份輸出）。
 *
 * 腳本走過先讀後改的拒絕與放行、一般工具、`task` 委派，所以 root 與子代理的請求都在裡面。外溢不在這裡：預覽切在哪跟著存檔名的
 * 隨機段變，每次跑都不同。外溢跨 loop 的位元組在 `spill-search-overflow-bytes.test.ts`（存檔釘雜湊、模型看到的那則逐位元組拼回來）
 * 與 `assembly-parity.test.ts` 的基座搬檔那一條。
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { MemorySaver } from '@langchain/langgraph';
import { FOREGROUND_SUBAGENT_DELEGATION_CONTEXT } from '@nexus/core';
import type { AgentLoopKind, PluginEntry } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';

/** 每次模型呼叫都記下訊息串與綁定的工具。 */
class RecordingModel extends ScriptedChatModel {
  readonly bindings: string[] = [];

  override bindTools(tools: readonly unknown[]): ScriptedChatModel {
    this.bindings.push(
      JSON.stringify(
        tools.map((candidate) =>
          convertToOpenAITool(candidate as Parameters<typeof convertToOpenAITool>[0]),
        ),
      ),
    );
    return super.bindTools(tools);
  }
}

const HOST: PluginEntry = {
  plugin: {
    name: 'request-bytes-host',
    apply(registry) {
      registry.tools.register(
        tool(() => 'pong', { name: 'ping', description: '回 pong。', schema: z.object({}) }),
      );
      registry.subagents.register({
        name: 'worker',
        description: '幹活的。',
        systemPrompt: '你是 worker，只做交代給你的事。',
      });
    },
  },
};

const SCRIPT: readonly ScriptedTurn[] = [
  {
    content: '',
    toolCalls: [{ name: 'write_file', args: { file_path: '/notes.md', content: '沒讀就蓋' } }],
  },
  { content: '', toolCalls: [{ name: 'read_file', args: { file_path: '/notes.md' } }] },
  {
    content: '',
    toolCalls: [
      { name: 'write_file', args: { file_path: '/notes.md', content: '讀過再蓋' } },
      { name: 'ping', args: {} },
    ],
  },
  {
    content: '',
    toolCalls: [{ name: 'task', args: { description: '把事情做完', subagent_type: 'worker' } }],
  },
  { content: '子代理做完了。' },
  { content: '全部完成。' },
];

/** 訊息串的投影：型別、內容、名字、工具呼叫（id、名字、參數）、`tool_call_id`、`status`。`additional_kwargs`、`response_metadata` 與訊息 id 不比。 */
function project(messages: readonly BaseMessage[]): unknown[] {
  return messages.map((message) => ({
    type: message.getType(),
    content: message.content,
    ...('name' in message && typeof message.name === 'string' && { name: message.name }),
    ...(AIMessage.isInstance(message) &&
      message.tool_calls !== undefined &&
      message.tool_calls.length > 0 && {
        toolCalls: message.tool_calls.map((call) => ({
          id: call.id,
          name: call.name,
          args: call.args,
        })),
      }),
    ...('tool_call_id' in message && { toolCallId: message.tool_call_id }),
    ...('status' in message && message.status !== undefined && { status: message.status }),
  }));
}

async function requestsOf(loop: AgentLoopKind): Promise<{ requests: string; bindings: string[] }> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-request-bytes-'));
  await writeFile(join(root, 'notes.md'), '原本的內容');
  const model = new RecordingModel({ turns: [...SCRIPT] });
  const { agent, dispose } = await createNexusAgent({
    agentLoop: loop,
    model,
    checkpointer: new MemorySaver(),
    plugins: [HOST],
    systemPrompt: '你是對照測試用的 agent。',
    backend: new ContainedFilesystemBackend({ rootDir: root, mode: 'workspace-write' }),
  });
  try {
    await agent.invoke(toAgentInvocation('開工。'), {
      configurable: { thread_id: 'request-bytes' },
    });
  } finally {
    await dispose();
  }
  return {
    requests: JSON.stringify(model.prompts.map(project), null, 1),
    bindings: model.bindings,
  };
}

describe('兩個 loop 送給模型的請求', () => {
  it('同一份腳本：每一次的訊息串與綁定的工具逐位元組相同', async () => {
    const langgraph = await requestsOf('langgraph');
    const native = await requestsOf('native');

    // 先確認腳本整份跑完：root 五次、子代理一次。
    expect(JSON.parse(langgraph.requests)).toHaveLength(SCRIPT.length);
    expect(langgraph.requests).toContain('覆蓋它之前要先讀過');
    expect(langgraph.requests).toContain('你是 worker');

    const inJson = (text: string) => JSON.stringify(text).slice(1, -1);
    // 子代理的委派聲明兩個 loop 都跟著同一個核准管道選句。
    expect(langgraph.requests).toContain(inJson(FOREGROUND_SUBAGENT_DELEGATION_CONTEXT));
    expect(native.requests).toBe(langgraph.requests);
    expect(native.bindings).toEqual(langgraph.bindings);
  });
});
