/**
 * `compileSubagentGraph`（[#825](https://github.com/DemianLi/nexus-agent/issues/825)）：規格 → 帶存檔點的圖。
 *
 * 走得起 fold 的整疊（圍堵、核准、外溢、全域 deny、跟基座 `task` 那條路的漂移比對）在 `@nexus/harness` 的
 * `subagent-graph.test.ts` 與探針；這裡只驗出口自己的邊界：找不到就拋、不處理的欄位就拋、併法、存檔點。
 */

import { FakeListChatModel } from '@langchain/core/utils/testing';
import { MemorySaver } from '@langchain/langgraph';
import { StateBackend } from 'deepagents';
import type { SubAgent } from 'deepagents';
import { createMiddleware } from 'langchain';
import { describe, expect, it } from 'vitest';

import { compileSubagentGraph, mergeMiddlewareByName } from './subagent-graph.js';
import type { SubagentGraphParams } from './subagent-graph.js';

const named = (name: string) => createMiddleware({ name });

function paramsWith(spec: Partial<SubAgent> & { name?: string } = {}): SubagentGraphParams {
  return {
    subagents: [
      {
        name: 'worker',
        description: '幹活的。',
        systemPrompt: '你是 worker。',
        tools: [],
        ...spec,
      } as SubAgent,
    ],
    model: new FakeListChatModel({ responses: ['一號', '二號'] }),
    backend: new StateBackend(),
  };
}

const options = () => ({ checkpointer: new MemorySaver() });

describe('mergeMiddlewareByName', () => {
  it('預設疊裡同名的原地換成規格自己的，沒撞名的接在後面', () => {
    const merged = mergeMiddlewareByName(
      [named('fs'), named('summary'), named('patch')],
      [named('gate'), named('summary'), named('extra')],
    );
    expect(merged.map((entry) => entry.name)).toEqual(['fs', 'summary', 'patch', 'gate', 'extra']);
    // 換進來的是規格那顆，不是預設那顆。
    const custom = named('summary');
    expect(mergeMiddlewareByName([named('fs'), named('summary')], [custom])[1]).toBe(custom);
  });

  it('規格沒帶東西就是預設疊本身', () => {
    expect(mergeMiddlewareByName([named('fs')], []).map((entry) => entry.name)).toEqual(['fs']);
  });
});

describe('compileSubagentGraph 的邊界', () => {
  it('沒有這個名字：指名，並列出有哪些', () => {
    expect(() => compileSubagentGraph(paramsWith(), 'nope', options())).toThrow(
      /沒有 "nope" 這個子代理.*worker/u,
    );
  });

  it('編好的 runnable 不收', () => {
    const params: SubagentGraphParams = {
      ...paramsWith(),
      subagents: [
        { name: 'compiled', description: 'x', runnable: {} as never } as unknown as SubAgent,
      ],
    };
    expect(() => compileSubagentGraph(params, 'compiled', options())).toThrow(/runnable/u);
  });

  it('interruptOn 與 responseFormat 不處理就拋，不悄悄略過', () => {
    expect(() =>
      compileSubagentGraph(paramsWith({ interruptOn: { write_file: true } }), 'worker', options()),
    ).toThrow(/interruptOn/u);
    expect(() =>
      compileSubagentGraph(paramsWith({ responseFormat: {} as never }), 'worker', options()),
    ).toThrow(/responseFormat/u);
  });

  it('缺模型、缺工具清單、缺 backend 各自指名', () => {
    expect(() =>
      compileSubagentGraph({ ...paramsWith(), model: undefined }, 'worker', options()),
    ).toThrow(/沒有模型/u);
    expect(() =>
      compileSubagentGraph(paramsWith({ tools: undefined }), 'worker', options()),
    ).toThrow(/沒有工具清單/u);
    expect(() =>
      compileSubagentGraph({ ...paramsWith(), backend: undefined }, 'worker', options()),
    ).toThrow(/沒有 backend/u);
  });

  it('規格自己的 model 優先於組裝點的', async () => {
    const own = new FakeListChatModel({ responses: ['規格自己的'] });
    const graph = compileSubagentGraph(paramsWith({ model: own }), 'worker', options());
    const result = await graph.invoke(
      { messages: [{ role: 'user', content: '嗨' }] },
      { configurable: { thread_id: 't' } },
    );
    expect(result.messages.at(-1)?.content).toBe('規格自己的');
  });
});

describe('存檔點：同一個 thread id 的下一輪看得到上一輪', () => {
  it('第二輪的訊息串含第一輪的人話與回覆；換 thread id 就沒有', async () => {
    const graph = compileSubagentGraph(paramsWith(), 'worker', options());
    const say = (text: string, thread: string) =>
      graph.invoke(
        { messages: [{ role: 'user', content: text }] },
        { configurable: { thread_id: thread } },
      );
    await say('第一輪的話', 'a');
    const second = await say('第二輪的話', 'a');
    // 回覆的內容不看（假模型的游標不跟著圖走），看的是第二輪的訊息串裡有第一輪的人話與回覆。
    expect(second.messages).toHaveLength(4);
    expect(
      second.messages.slice(0, 3).map((message: { content: unknown }) => message.content),
    ).toEqual(['第一輪的話', '一號', '第二輪的話']);
    const other = await say('別條', 'b');
    expect(other.messages).toHaveLength(2);
  });
});
