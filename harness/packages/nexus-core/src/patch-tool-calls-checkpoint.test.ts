/**
 * `stateFix` 開關的行為差：`beforeAgent` 把補的結果**寫回 graph 狀態**（checkpoint 的 `messages`），`wrapModelCall` 只補**這次送出去的請求**。
 *
 * 同一串帶懸空呼叫的訊息、同一個模型，跑一輪：
 *
 * - `stateFix: true`（`state`／`shadow`）：checkpoint 裡懸空呼叫後面有補結，請求裡也有。
 * - `stateFix: false`（`log`）：checkpoint 裡**沒有**補結（`log` 下送出的歷史由推導端換掉，不讀狀態），請求裡仍有——供應商不會收到配不到結果的呼叫。
 *
 * 光看請求分不出這兩種：兩邊的請求相同，所以這裡讀 checkpoint。拿掉 `beforeAgent` 的突變要讓第一組紅，沒傳旗標退回永遠裝要讓第二組紅。
 */

import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { MemorySaver } from '@langchain/langgraph';
import { createAgent, createMiddleware } from 'langchain';
import { describe, expect, it } from 'vitest';

import { createPatchToolCallsMiddleware, patchedToolCallText } from './patch-tool-calls.js';

/** 排在補懸空那顆裡面：它看到的 `request.messages` 就是送給模型的那一串。 */
function recorder(sent: BaseMessage[][]) {
  return createMiddleware({
    name: 'recorder',
    wrapModelCall: (request, handler) => {
      sent.push([...request.messages]);
      return handler(request);
    },
  });
}

/** `createAgent` 的型別對這個最小用法太窄，只取用到的兩個方法。 */
interface Invokable {
  invoke(input: unknown, config: unknown): Promise<unknown>;
  getState(config: unknown): Promise<{ values: { messages: BaseMessage[] } }>;
}

/** 懸空：AI 呼叫了 `lookup`，之後沒有結果，接著使用者又說了一句。 */
const dangling = (): BaseMessage[] => [
  new HumanMessage({ content: '查一下', id: 'h1' }),
  new AIMessage({
    content: '',
    id: 'a1',
    tool_calls: [{ id: 'call-1', name: 'lookup', args: {} }],
  }),
  new HumanMessage({ content: '算了，換個話題', id: 'h2' }),
];

const isPatch = (message: BaseMessage): boolean =>
  ToolMessage.isInstance(message) && message.content === patchedToolCallText('lookup', 'call-1');

async function runOnce(stateFix: boolean | undefined) {
  const sent: BaseMessage[][] = [];
  const model = new FakeListChatModel({ responses: ['好'] });
  const checkpointer = new MemorySaver();
  const agent = createAgent({
    model,
    tools: [],
    middleware: [
      createPatchToolCallsMiddleware(stateFix === undefined ? {} : { stateFix }),
      recorder(sent),
    ] as never,
    checkpointer,
  });
  const config = { configurable: { thread_id: 't' } };
  await (agent as unknown as Invokable).invoke({ messages: dangling() }, config);
  const state = await (agent as unknown as Invokable).getState(config);
  return {
    stored: state.values.messages,
    sent: sent[0] ?? [],
  };
}

describe('patchToolCalls：狀態與請求各補在哪', () => {
  it.each([
    ['省略（預設）', undefined],
    ['true', true],
  ] as const)('stateFix %s：checkpoint 與請求都有補結', async (_label, stateFix) => {
    const { stored, sent } = await runOnce(stateFix);
    expect(stored.some(isPatch)).toBe(true);
    expect(sent.some(isPatch)).toBe(true);
  });

  it('stateFix false：checkpoint 沒有補結，請求有', async () => {
    const { stored, sent } = await runOnce(false);
    expect(stored.some(isPatch)).toBe(false);
    expect(sent.some(isPatch)).toBe(true);
  });
});
