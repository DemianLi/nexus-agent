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

const call = (id: string | undefined) => ({ id, name: 'ls', args: {} });

const edgeCases: Record<string, () => BaseMessage[]> = {
  同一個呼叫多則結果: () => [
    new AIMessage({ content: '', tool_calls: [call('a')] }),
    new ToolMessage({ content: '一', tool_call_id: 'a', name: 'ls' }),
    new HumanMessage('中間'),
    new ToolMessage({ content: '二', tool_call_id: 'a', name: 'ls' }),
  ],
  重複的呼叫_id: () => [
    new AIMessage({ content: '', tool_calls: [call('a')] }),
    new ToolMessage({ content: '一', tool_call_id: 'a', name: 'ls' }),
    new AIMessage({ content: '', tool_calls: [call('a')] }),
  ],
  結果只在呼叫之前: () => [
    new ToolMessage({ content: '早到', tool_call_id: 'a', name: 'ls' }),
    new AIMessage({ content: '', tool_calls: [call('a')] }),
  ],
  結果前後都有: () => [
    new ToolMessage({ content: '早到', tool_call_id: 'a', name: 'ls' }),
    new AIMessage({ content: '', tool_calls: [call('a')] }),
    new ToolMessage({ content: '晚到', tool_call_id: 'a', name: 'ls' }),
  ],
  沒有結果的呼叫: () => [
    new AIMessage({ content: '', tool_calls: [call('a'), call('b')] }),
    new HumanMessage('繼續'),
  ],
  呼叫沒有_id: () => [new AIMessage({ content: '', tool_calls: [call(undefined)] })],
};

/** 用固定種子產生一串訊息：id 池很小，重複、早到、懸空、孤兒都會撞到。 */
function randomHistory(seed: number): BaseMessage[] {
  let state = seed;
  const next = (limit: number) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return Math.floor((state / 2 ** 32) * limit);
  };
  const id = () => (next(8) === 0 ? undefined : `id-${next(6)}`);
  const messages: BaseMessage[] = [new HumanMessage('開始')];
  for (let count = next(16); count >= 0; count -= 1) {
    const kind = next(3);
    if (kind === 0) messages.push(new HumanMessage('繼續'));
    else if (kind === 1) {
      const calls = Array.from({ length: next(3) + 1 }, () => call(id()));
      messages.push(new AIMessage({ content: '', tool_calls: calls }));
    } else {
      messages.push(
        new ToolMessage({ content: '結果', tool_call_id: `id-${next(6)}`, name: 'ls' }),
      );
    }
  }
  return messages;
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

  it.each(Object.entries(edgeCases))('%s：與基座那顆相同', async (_name, build) => {
    expect(await run(createPatchToolCallsMiddleware(), build())).toEqual(
      await run(createBasePatchToolCallsMiddleware() as never, build()),
    );
  });

  it('隨機訊息串：與基座那顆相同', async () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const own = await run(createPatchToolCallsMiddleware(), randomHistory(seed));
      const base = await run(createBasePatchToolCallsMiddleware() as never, randomHistory(seed));
      expect(own, `seed ${seed}`).toEqual(base);
    }
  });

  it('十萬次工具呼叫的歷史不是平方複雜度', () => {
    const messages: BaseMessage[] = [];
    for (let index = 0; index < 100_000; index += 1) {
      messages.push(
        new AIMessage({ content: '', tool_calls: [call(`call-${index}`)] }),
        new ToolMessage({ content: 'ok', tool_call_id: `call-${index}`, name: 'ls' }),
      );
    }
    expect(patchDanglingToolCalls(messages).needsPatch).toBe(false);
  });
});
