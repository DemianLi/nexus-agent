import { AIMessage, AIMessageChunk, HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { createDeepAgent, StateBackend } from 'deepagents';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';

/**
 * 假模型的雙路徑對照——`invoke` 與 v3 typed stream 必須跑出同一件事。
 *
 * 這組測試存在的理由是一次真的失誤：`ScriptedChatModel` 原本在最後一顆 chunk 上給
 * `tool_calls`，而走 v3 的 `convertChunksToEvents` **只讀 `tool_call_chunks`**。
 * 結果是 v3 那條路上工具呼叫整個消失、agent 迴圈只跑一輪就乾淨地結束、**什麼都不拋**。
 * 任何走 v3 的測試都會是綠的而且什麼都沒驗到。
 *
 * 開發計劃第 7 節決策 1 原本寫「假模型與基座的分歧在結構上斷言不出來」。這裡就是反例：
 * **同一份腳本走兩條基座路徑再比對**，不需要任何 API key 就斷言得出分歧。
 */

/** 記下每次被呼叫時收到的文字，讓「工具真的跑了」可被斷言。 */
function recordingTool(calls: string[]) {
  return tool(
    ({ text }: { text: string }) => {
      calls.push(text);
      return `已記下：${text}`;
    },
    {
      name: 'take_note',
      description: '把一段文字記下來。',
      schema: z.object({ text: z.string().describe('要記下的內容') }),
    },
  );
}

/** 一次跑完的觀測結果，兩條路徑都收斂成這個形狀才比得下去。 */
interface Observed {
  /** 工具實際收到的參數，依發生順序。 */
  readonly calls: readonly string[];
  /** 模型每一輪的文字，依發生順序。 */
  readonly texts: readonly string[];
  /** 工具呼叫的 id 與名稱，依發生順序。 */
  readonly toolCalls: readonly { id: string; name: string }[];
}

function buildAgent(turns: readonly ScriptedTurn[], calls: string[]) {
  return createDeepAgent({
    model: new ScriptedChatModel({ turns }),
    tools: [recordingTool(calls)],
    backend: new StateBackend(),
  });
}

/** 走 `invoke`——基座不會裝 stream 的 callback handler，模型走 `_generate`。 */
async function observeInvoke(turns: readonly ScriptedTurn[]): Promise<Observed> {
  const calls: string[] = [];
  const result = await buildAgent(turns, calls).invoke({
    messages: [new HumanMessage('記一筆。')],
  });

  const ai = (result.messages ?? []).filter((message) => AIMessage.isInstance(message));
  return {
    calls,
    texts: ai.map((message) => message.text),
    toolCalls: ai.flatMap((message) =>
      (message.tool_calls ?? []).map((call) => ({ id: call.id ?? '', name: call.name })),
    ),
  };
}

/** 走 v3 typed stream——基座會裝 callback handler，模型改走 `_streamResponseChunks`。 */
async function observeV3(turns: readonly ScriptedTurn[]): Promise<Observed> {
  const calls: string[] = [];
  const run = await buildAgent(turns, calls).streamEvents(
    { messages: [new HumanMessage('記一筆。')] },
    { version: 'v3' },
  );

  const texts: string[] = [];
  for await (const message of run.messages) {
    texts.push(await message.text);
  }

  const toolCalls: { id: string; name: string }[] = [];
  for await (const call of run.toolCalls) {
    toolCalls.push({ id: call.callId, name: call.name });
  }

  return { calls, texts, toolCalls };
}

const ONE_CALL: readonly ScriptedTurn[] = [
  { content: '我來記。', toolCalls: [{ name: 'take_note', args: { text: '第一筆' } }] },
  { content: '記好了。' },
];

const TWO_CALLS: readonly ScriptedTurn[] = [
  {
    content: '一次記兩筆。',
    toolCalls: [
      { name: 'take_note', args: { text: '甲' } },
      { name: 'take_note', args: { text: '乙' } },
    ],
  },
  { content: '兩筆都記好了。' },
];

describe('ScriptedChatModel 在 invoke 與 v3 串流下的一致性', () => {
  it('同一份腳本走兩條路徑，工具都跑到而且參數一樣', async () => {
    const [byInvoke, byStream] = await Promise.all([observeInvoke(ONE_CALL), observeV3(ONE_CALL)]);

    // 先各自釘住絕對值：兩邊都空的話「相等」也會成立，那就什麼都沒驗到。
    expect(byInvoke.calls).toEqual(['第一筆']);
    expect(byStream.calls).toEqual(['第一筆']);
    expect(byStream).toEqual(byInvoke);
  });

  it('工具呼叫的 chunk 不會把同一輪的文字寫壞', async () => {
    const byStream = await observeV3(ONE_CALL);

    // tool_call_chunk 的 index 與文字的 content block 共用編號空間。從 0 起跳的話
    // 工具照樣跑得到，但這一句會被覆寫——所以「工具跑了」單獨一條擋不住那個 bug。
    expect(byStream.texts).toEqual(['我來記。', '記好了。']);
  });

  it('一輪兩個工具呼叫，兩條路徑的順序與 id 都對得上', async () => {
    const [byInvoke, byStream] = await Promise.all([
      observeInvoke(TWO_CALLS),
      observeV3(TWO_CALLS),
    ]);

    expect(byStream.calls).toEqual(['甲', '乙']);
    expect(byStream.toolCalls).toEqual([
      { id: 'call_1_0', name: 'take_note' },
      { id: 'call_1_1', name: 'take_note' },
    ]);
    // id 取自同一個 `toMessage()`，所以兩條路徑相等是構造出來的，不是碰巧。
    expect(byStream).toEqual(byInvoke);
    expect(byStream.texts).toEqual(['一次記兩筆。', '兩筆都記好了。']);
  });

  it('那一輪沒有文字時工具照樣跑得到', async () => {
    // 沒有文字就沒有 content block 0，index 從 1 起跳的偏移量在這裡是空跑的。
    // 這一條確認偏移量不需要看有沒有文字而變成條件式。
    const turns: readonly ScriptedTurn[] = [
      { content: '', toolCalls: [{ name: 'take_note', args: { text: '無聲那筆' } }] },
      { content: '記好了。' },
    ];
    const [byInvoke, byStream] = await Promise.all([observeInvoke(turns), observeV3(turns)]);

    expect(byStream.calls).toEqual(['無聲那筆']);
    expect(byStream.calls).toEqual(byInvoke.calls);
    expect(byStream.toolCalls).toEqual(byInvoke.toolCalls);
  });
});

describe('假模型吐出來的 chunk 本身', () => {
  it('工具呼叫掛在 tool_call_chunks 上，不是 tool_calls', async () => {
    const model = new ScriptedChatModel({ turns: ONE_CALL });
    const chunks = [];
    for await (const chunk of model._streamResponseChunks(
      [new HumanMessage('記一筆。')],
      {} as ScriptedChatModel['ParsedCallOptions'],
    )) {
      chunks.push(chunk);
    }

    const last = chunks.at(-1)?.message;
    if (!AIMessageChunk.isInstance(last)) {
      throw new Error('最後一顆 chunk 不是 AIMessageChunk');
    }
    expect(last.tool_call_chunks).toEqual([
      {
        id: 'call_1_0',
        name: 'take_note',
        args: '{"text":"第一筆"}',
        // 0 是上面那段文字的 content block，工具呼叫要從 1 起跳。
        index: 1,
        type: 'tool_call_chunk',
      },
    ]);
    // `tool_calls` 這一份是 `AIMessageChunk` 自己從 chunks 推導出來的，不是我們掛上去的
    // ——原本的寫法反過來，只掛 `tool_calls` 而沒有 chunks，v3 那條路上就什麼都看不到。
    // 它推得出來，順帶證明了上面那串 args 是完整且可解析的 JSON。
    expect(last.tool_calls).toEqual([
      { id: 'call_1_0', name: 'take_note', args: { text: '第一筆' }, type: 'tool_call' },
    ]);
  });

  it('沒有工具呼叫的那一輪不會多吐一顆空 chunk', async () => {
    const model = new ScriptedChatModel({ turns: [{ content: '好。' }] });
    const chunks = [];
    for await (const chunk of model._streamResponseChunks(
      [new HumanMessage('嗨。')],
      {} as ScriptedChatModel['ParsedCallOptions'],
    )) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.text)).toEqual(['好', '。']);
  });
});

/**
 * `usage_metadata` 的雙路徑對照。
 *
 * 假模型是在 `feat/eval-suite` 才開始回報用量的——成本那個指標在 CI 需要一個對照組
 * （見 [`eval/scorers.ts`](./eval/scorers.ts) 的 `readCost`）。兩條路徑掛法不同：
 * `_generate` 掛在 `AIMessage` 上，串流掛在**最後一顆** chunk 上（`AIMessageChunk` 相加
 * 時 `usage_metadata` 會累加，每顆文字 chunk 都掛的話數字會被乘上字數）。所以它跟工具
 * 呼叫一樣需要對照，而且理由一樣：分歧發生時沒有東西會拋錯。
 */
const WITH_USAGE: readonly ScriptedTurn[] = [
  {
    content: '我來記。',
    toolCalls: [{ name: 'take_note', args: { text: '第一筆' } }],
    usage: { inputTokens: 11, outputTokens: 5 },
  },
  { content: '記好了。', usage: { inputTokens: 20, outputTokens: 3 } },
];

/** 最終狀態裡每一則 AI 訊息的用量，依順序。 */
type Usages = (Record<string, number> | undefined)[];

async function usageByInvoke(turns: readonly ScriptedTurn[]): Promise<Usages> {
  const result = await buildAgent(turns, []).invoke({ messages: [new HumanMessage('記一筆。')] });
  return (result.messages ?? [])
    .filter((message) => AIMessage.isInstance(message))
    .map((message) => message.usage_metadata as Record<string, number> | undefined);
}

async function usageByV3(turns: readonly ScriptedTurn[]): Promise<Usages> {
  const run = await buildAgent(turns, []).streamEvents(
    { messages: [new HumanMessage('記一筆。')] },
    { version: 'v3' },
  );
  for await (const _ of run) void _;
  const output = (await run.output) as { messages?: unknown[] };
  return (output.messages ?? [])
    .filter((message) => AIMessage.isInstance(message))
    .map((message) => message.usage_metadata as Record<string, number> | undefined);
}

describe('usage_metadata 的雙路徑一致性', () => {
  it('腳本給了用量，兩條路徑帶出來的數字一樣，而且基座沒有動它', async () => {
    const [byInvoke, byStream] = await Promise.all([
      usageByInvoke(WITH_USAGE),
      usageByV3(WITH_USAGE),
    ]);
    const expected = [
      { input_tokens: 11, output_tokens: 5, total_tokens: 16 },
      { input_tokens: 20, output_tokens: 3, total_tokens: 23 },
    ];
    expect(byInvoke).toEqual(expected);
    expect(byStream).toEqual(expected);
  });

  it('腳本沒給用量就是 undefined——假模型不編數字', async () => {
    const [byInvoke, byStream] = await Promise.all([usageByInvoke(ONE_CALL), usageByV3(ONE_CALL)]);
    // 「這條路免費」與「我們不知道」在成本比較上是完全不同的結論。
    expect(byInvoke).toEqual([undefined, undefined]);
    expect(byStream).toEqual([undefined, undefined]);
  });
});
