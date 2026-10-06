import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import {
  createPatchToolCallsMiddleware,
  PATCH_TOOL_CALLS_MIDDLEWARE_NAME,
  patchDanglingToolCalls,
} from '@nexus/core';
import { createPatchToolCallsMiddleware as createBasePatchToolCallsMiddleware } from 'deepagents';
import { createAgent } from 'langchain';
import { describe, expect, it } from 'vitest';

import { ScriptedChatModel } from './scripted-model.js';

/**
 * **自有的補懸空呼叫 middleware 對上基座那顆：行為逐字相同。**
 *
 * 研究文件 §七的接縫 6。只換載體不改行為，所以拿基座那顆當參照答案：同一串訊息丟給兩邊，
 * 各自經 `createAgent` 跑一輪，比對**送進模型的請求**與**跑完之後的狀態**。基座移除之前，這條測試
 * 同時是升版絆索——基座改了補的話或補的規則，會在這裡紅。
 */

const project = (messages: readonly BaseMessage[]) =>
  messages.map((message) => ({
    type: message.getType(),
    content: message.content,
    ...(ToolMessage.isInstance(message) && {
      toolCallId: message.tool_call_id,
      name: message.name,
    }),
    ...(AIMessage.isInstance(message) && {
      toolCalls: (message.tool_calls ?? []).map((call) => ({ id: call.id, name: call.name })),
    }),
  }));

/** 一串有三種狀況的歷史：配得上的呼叫、懸空的呼叫、孤兒結果。 */
function history(): BaseMessage[] {
  return [
    new HumanMessage('先做兩件事。'),
    new AIMessage({
      content: '',
      tool_calls: [
        { id: 'call-answered', name: 'read_file', args: { file_path: '/a.md' } },
        { id: 'call-dangling', name: 'write_file', args: { file_path: '/b.md', content: 'x' } },
      ],
    }),
    new ToolMessage({ content: '檔案內容', tool_call_id: 'call-answered', name: 'read_file' }),
    new ToolMessage({ content: '沒有人呼叫過我', tool_call_id: 'call-orphan', name: 'ls' }),
    new HumanMessage('繼續。'),
  ];
}

async function run(
  middleware: ReturnType<typeof createPatchToolCallsMiddleware>,
  input: BaseMessage[],
) {
  const model = new ScriptedChatModel({ turns: [{ content: '好。' }] });
  const agent = createAgent({
    model: model as never,
    tools: [],
    middleware: [middleware],
    checkpointer: new MemorySaver(),
  });
  const result = await agent.invoke({ messages: input }, { configurable: { thread_id: 't' } });
  return { prompt: project(model.prompts[0] ?? []), state: project(result.messages) };
}

describe('自有補懸空呼叫 middleware', () => {
  it('名字照舊，合併疊與測試才認得', () => {
    expect(PATCH_TOOL_CALLS_MIDDLEWARE_NAME).toBe('patchToolCallsMiddleware');
    expect(createPatchToolCallsMiddleware().name).toBe(createBasePatchToolCallsMiddleware().name);
  });

  it('有懸空與孤兒：送進模型的請求與跑完的狀態都與基座那顆相同', async () => {
    const own = await run(createPatchToolCallsMiddleware(), history());
    const base = await run(createBasePatchToolCallsMiddleware() as never, history());

    // 這條測試真的量到了東西：懸空的補了一則、孤兒丟了一則。
    const toolIds = own.prompt.flatMap((message) =>
      'toolCallId' in message ? [message.toolCallId] : [],
    );
    // 補的那則緊接在帶呼叫的 AI 訊息後面，所以排在原本配得上的那則前面；孤兒 `call-orphan` 不見了。
    expect(toolIds).toEqual(['call-dangling', 'call-answered']);

    expect(own.prompt).toEqual(base.prompt);
    expect(own.state).toEqual(base.state);
  });

  it('補上去的那句話逐字不變（thread-pump 與續行測試引用它）', () => {
    const { patchedMessages, needsPatch } = patchDanglingToolCalls(history());
    expect(needsPatch).toBe(true);
    const patched = patchedMessages.find(
      (message) => ToolMessage.isInstance(message) && message.tool_call_id === 'call-dangling',
    );
    expect(patched?.content).toBe(
      'Tool call write_file with id call-dangling was cancelled - another message came in before it could be completed.',
    );
  });

  it('沒有東西要補時原樣放行，不動狀態', async () => {
    const clean: BaseMessage[] = [
      new HumanMessage('嗨。'),
      new AIMessage({ content: '好。' }),
      new HumanMessage('再見。'),
    ];
    expect(patchDanglingToolCalls(clean).needsPatch).toBe(false);
    expect(patchDanglingToolCalls([]).needsPatch).toBe(false);
    const own = await run(createPatchToolCallsMiddleware(), clean);
    const base = await run(createBasePatchToolCallsMiddleware() as never, clean);
    expect(own).toEqual(base);
  });
});
