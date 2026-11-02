/**
 * 訊息不序列化：`messages` 與工具派工的 `args` 換成記號，活物件留在側表（[#2116](https://github.com/DemianLi/nexus-agent/issues/2116)）。
 *
 * 存檔器自己的行為加一張真的圖。大日誌的記憶體量級不在這裡測（見 #2116），這裡釘語意。
 */

import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { END, MessagesAnnotation, Send, START, StateGraph, interrupt } from '@langchain/langgraph';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';
import { describe, expect, it } from 'vitest';

import {
  CHECKPOINT_DEPTH_EXCEEDED,
  CHECKPOINT_MAX_DEPTH,
  checkpointDepth,
} from './checkpoint-serde.js';
import { CHECKPOINT_MESSAGE_WRAPPER_DEPTH, PrunedMemorySaver } from './pruned-memory-saver.js';

const META: CheckpointMetadata = { source: 'loop', step: 0, parents: {} };
const config = (thread: string) => ({ configurable: { thread_id: thread, checkpoint_ns: '' } });

function checkpointWith(id: string, values: Record<string, unknown>): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date(0).toISOString(),
    channel_values: values,
    channel_versions: {},
    versions_seen: {},
  };
}

/** 真的圖：節點由呼叫端給，用同一顆 saver。 */
function graphOn(saver: PrunedMemorySaver, node: (state: { messages: BaseMessage[] }) => unknown) {
  return new StateGraph(MessagesAnnotation)
    .addNode('n', node as never)
    .addEdge(START, 'n')
    .addEdge('n', END)
    .compile({ checkpointer: saver });
}

const reply = () => ({ messages: [new AIMessage({ content: '回' })] });

/** 這條 thread 落進 `MemorySaver` 的位元組，解成字串。 */
function storedText(saver: PrunedMemorySaver, thread: string): string {
  const chain = saver.storage[thread]?.[''];
  if (chain === undefined) throw new Error(`沒有 ${thread} 這條鏈`);
  return Object.values(chain)
    .map(([checkpoint]) => Buffer.from(checkpoint).toString())
    .join('');
}

/** `additional_kwargs` 底下多包 `layers` 層，湊出指定層數的訊息。 */
function messageNested(layers: number): HumanMessage {
  let value: unknown = 'x';
  for (let layer = 0; layer < layers; layer += 1) value = { v: value };
  return new HumanMessage({ content: '深', id: 'deep', additional_kwargs: { value } });
}

/** 量出來剛好 `target` 層的訊息。 */
function messageAtDepth(target: number): HumanMessage {
  const base = checkpointDepth(messageNested(0));
  return messageNested(target - base);
}

describe('訊息留在側表', () => {
  it('存檔點裡只有記號，getTuple 與 list 換回同一串，訊息被深凍結', async () => {
    const saver = new PrunedMemorySaver();
    const graph = graphOn(saver, reply);
    await graph.invoke(
      { messages: [new HumanMessage({ content: '只在側表的句子' })] },
      config('t'),
    );

    expect(storedText(saver, 't')).not.toContain('只在側表的句子');
    const tuple = await saver.getTuple(config('t'));
    const messages = tuple?.checkpoint.channel_values['messages'] as HumanMessage[];
    expect(messages.map((message) => message.content)).toEqual(['只在側表的句子', '回']);
    expect(Object.isFrozen(messages[0])).toBe(true);
    for await (const row of saver.list(config('t'))) {
      expect(JSON.stringify(row.checkpoint.channel_values)).not.toContain('__nexusLiveState');
    }
  });

  it('最後一則 AI 讀回來是可寫的副本，側表裡那一份不動', async () => {
    const saver = new PrunedMemorySaver();
    await graphOn(saver, reply).invoke({ messages: [new HumanMessage('問')] }, config('t'));

    const first = await saver.getTuple(config('t'));
    const last = (first?.checkpoint.channel_values['messages'] as AIMessage[]).at(-1);
    last!.tool_calls = [{ name: 'x', args: {}, id: 'c' }];
    const second = await saver.getTuple(config('t'));
    expect(
      (second?.checkpoint.channel_values['messages'] as AIMessage[]).at(-1)?.tool_calls,
    ).toEqual([]);
  });

  it('工具派工的 args 也換記號：整串訊息與 files 都不落下來，讀回是原樣的 Send', async () => {
    const saver = new PrunedMemorySaver();
    const history = [new HumanMessage({ content: '派工帶的句子', id: 'h' })];
    const send = new Send('tools', { messages: history, files: { '/a': '派工帶的檔案' } });
    await saver.put(
      config('t'),
      checkpointWith('1', { messages: history, __pregel_tasks: [send] }),
      META,
    );

    const stored = storedText(saver, 't');
    expect(stored).not.toContain('派工帶的句子');
    expect(stored).not.toContain('派工帶的檔案');
    const tuple = await saver.getTuple(config('t'));
    const [task] = tuple?.checkpoint.channel_values['__pregel_tasks'] as Send[];
    expect(task?.node).toBe('tools');
    expect(task?.args).toMatchObject({ files: { '/a': '派工帶的檔案' } });
    expect((task?.args as { messages: unknown[] }).messages).toHaveLength(1);
  });

  it('真的圖停在核准點：派工帶的整串訊息不落進存檔點（基座改 TASKS 的名字會紅）', async () => {
    const saver = new PrunedMemorySaver();
    const graph = new StateGraph(MessagesAnnotation)
      .addNode('call', () => ({ messages: [new AIMessage({ content: '派' })] }))
      .addNode('tool', () => {
        interrupt('等人');
        return {};
      })
      .addEdge(START, 'call')
      .addConditionalEdges('call', (state) => new Send('tool', { messages: state.messages }), [
        'tool',
      ])
      .addEdge('tool', END)
      .compile({ checkpointer: saver });

    const input = { messages: [new HumanMessage({ content: '只在側表的句子' })] };
    await graph.invoke(input, config('t'));

    expect(storedText(saver, 't')).toContain('__nexusLiveState');
    expect(storedText(saver, 't')).not.toContain('只在側表的句子');
    const state = await graph.getState(config('t'));
    expect(state.tasks[0]?.interrupts).toHaveLength(1);
  });

  it('不帶 messages 的派工照舊序列化', async () => {
    const saver = new PrunedMemorySaver();
    const send = new Send('other', { note: '留在存檔點' });
    await saver.put(config('t'), checkpointWith('1', { __pregel_tasks: [send] }), META);

    expect(storedText(saver, 't')).toContain('留在存檔點');
    expect(saver.liveCheckpoints).toBe(0);
  });

  it('側表缺項就拋：訊息與工具派工都不會變成空的', async () => {
    const source = new PrunedMemorySaver();
    const send = new Send('tools', { messages: [new HumanMessage('問')] });
    await source.put(
      config('t'),
      checkpointWith('1', { messages: [new HumanMessage('問')], __pregel_tasks: [send] }),
      META,
    );
    const orphan = new PrunedMemorySaver();
    orphan.storage = source.storage;
    await expect(orphan.getTuple(config('t'))).rejects.toThrow('工具派工不在側表');

    const plain = new PrunedMemorySaver();
    await plain.put(config('p'), checkpointWith('1', { messages: [new HumanMessage('問')] }), META);
    const noMessages = new PrunedMemorySaver();
    noMessages.storage = plain.storage;
    await expect(noMessages.getTuple(config('p'))).rejects.toThrow('存檔點的訊息不在側表');
    const rows = noMessages.list(config('p'));
    await expect(rows.next()).rejects.toThrow('存檔點的訊息不在側表');
  });

  it('修剪與刪 thread 放掉側表', async () => {
    const saver = new PrunedMemorySaver();
    const graph = graphOn(saver, reply);
    for (const text of ['一', '二', '三']) {
      await graph.invoke({ messages: [new HumanMessage(text)] }, config('t'));
    }
    expect(saver.liveCheckpoints).toBe(1);
    await saver.deleteThread('t');
    expect(saver.liveCheckpoints).toBe(0);
  });

  it('就地改被擋下；失敗輪的 human 留在 state，舊訊息沒被改到', async () => {
    const saver = new PrunedMemorySaver();
    let mode: 'ok' | 'mutate' | 'throw' = 'ok';
    const graph = graphOn(saver, (state) => {
      if (mode === 'mutate') state.messages[0]!.additional_kwargs['dirty'] = true;
      if (mode === 'throw') throw new Error('中途失敗');
      return { messages: [new AIMessage({ content: '回' })] };
    });
    await graph.invoke({ messages: [new HumanMessage({ content: '問', id: 'h' })] }, config('t'));
    mode = 'mutate';
    await expect(graph.invoke({ messages: [new HumanMessage('二')] }, config('t'))).rejects.toThrow(
      TypeError,
    );
    mode = 'throw';
    await expect(graph.invoke({ messages: [new HumanMessage('三')] }, config('t'))).rejects.toThrow(
      '中途失敗',
    );
    mode = 'ok';
    const { messages } = await graph.invoke({ messages: [new HumanMessage('四')] }, config('t'));
    expect(messages[0]?.additional_kwargs).toEqual({});
    expect(messages.map((message) => message.content)).toEqual([
      '問',
      '回',
      '二',
      '三',
      '四',
      '回',
    ]);
  });

  it('寫不進去就不進側表，存檔點留在上一顆', async () => {
    const saver = new PrunedMemorySaver();
    const good = [new HumanMessage({ content: '好', id: 'g' })];
    await saver.put(config('t'), checkpointWith('1', { messages: good }), META);
    const deep = [...good, messageAtDepth(CHECKPOINT_MAX_DEPTH)];
    await expect(
      saver.put(config('t'), checkpointWith('2', { messages: deep }), META),
    ).rejects.toMatchObject({ code: CHECKPOINT_DEPTH_EXCEEDED });
    expect(saver.liveCheckpoints).toBe(1);
    const tuple = await saver.getTuple(config('t'));
    expect(tuple?.checkpoint.id).toBe('1');
  });
});

describe('層數上限（#1658）跟序列化時同一條邊界', () => {
  it('外面包的層數就是存檔點那幾層', () => {
    const message = messageNested(5);
    const checkpoint = { channel_values: { messages: [message] } };
    expect(checkpointDepth(checkpoint)).toBe(
      checkpointDepth(message) + CHECKPOINT_MESSAGE_WRAPPER_DEPTH,
    );
  });

  it('剛好在上限上收，多一層拋 checkpoint_depth_exceeded', async () => {
    const inner = CHECKPOINT_MAX_DEPTH - CHECKPOINT_MESSAGE_WRAPPER_DEPTH;
    const saver = new PrunedMemorySaver();
    await saver.put(config('t'), checkpointWith('1', { messages: [messageAtDepth(inner)] }), META);
    await expect(
      saver.put(config('t'), checkpointWith('2', { messages: [messageAtDepth(inner + 1)] }), META),
    ).rejects.toMatchObject({ code: CHECKPOINT_DEPTH_EXCEEDED, limit: CHECKPOINT_MAX_DEPTH });
  });
});
