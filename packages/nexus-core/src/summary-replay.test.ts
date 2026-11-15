/**
 * 生摘要的那一次呼叫重播上一次主請求，條件不齊就退回模板——[#2775](https://github.com/DemianLi/nexus-agent/issues/2775)。
 *
 * 走出貨的 `createSummarizer` 組出來的整條鏈，摘要模型記下每次 `invoke` 收到的訊息與選項。線上位元組的比對在
 * `apps/harness/src/summary-replay-prefix.test.ts`（真的 `ChatOpenAI` 打假端點）。
 */

import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { lastSentRequestOf, noteSentRequest } from './last-sent-request.js';
import type { SessionLookup } from './registry.js';
import { SessionLog } from './session-log.js';
import {
  createSummarizer,
  DEFAULT_SUMMARIZATION,
  SUMMARY_INSTRUCTION,
  SUMMARY_PROMPT,
} from './summarization.js';
import type { SentHistoryReader } from './summarization.js';
import { SummaryCutoffTable } from './summary-cutoffs.js';
import { TokenAnchorBook } from './token-estimate.js';

const BIG = '這是一段很長的內容。'.repeat(300);
const conversation = (): BaseMessage[] => [
  new HumanMessage(BIG),
  new AIMessage('一'),
  new HumanMessage('二'),
  new AIMessage('三'),
  new HumanMessage('四'),
  new AIMessage('五'),
  new HumanMessage('短問題'),
];

const SYSTEM = new SystemMessage('送出去的系統提示。');
const TOOLS = [{ type: 'function', function: { name: 'echo', parameters: {} } }];

interface Invoke {
  readonly input: BaseMessage[];
  readonly options: Record<string, unknown> | undefined;
}

async function run(options: {
  /** 這份日誌「上一次送出的請求」；不給就是這個行程還沒送過。 */
  sent?: { messages: BaseMessage[]; options: unknown };
  sentHistoryOf?: SentHistoryReader;
  lookup?: (log: SessionLog) => SessionLookup;
}) {
  const log = new SessionLog('s');
  if (options.sent !== undefined)
    noteSentRequest(log, [options.sent.messages], options.sent.options);
  const invokes: Invoke[] = [];
  const model = {
    profile: {},
    invoke: async (input: BaseMessage[], config?: Record<string, unknown>) => {
      invokes.push({ input, options: config });
      return { text: '這是摘要。' };
    },
  };
  const messages = conversation();
  const config = { configurable: { thread_id: 't', checkpoint_ns: 'model_request:x' } };
  const middleware = createSummarizer(
    { write: async (path: string) => ({ path }) } as never,
    { ...DEFAULT_SUMMARIZATION, retainTokens: 1, trigger: [{ type: 'tokens', value: 2_000 }] },
    new TokenAnchorBook(),
    {
      forCall: () =>
        options.lookup?.(log) ?? ({ kind: 'ok', address: { kind: 'root' }, log } as SessionLookup),
    },
    false,
    undefined,
    undefined,
    () => {},
    undefined,
    new SummaryCutoffTable(),
    options.sentHistoryOf,
  );
  const handled: BaseMessage[][] = [];
  await middleware.wrapModelCall?.(
    {
      messages,
      state: { messages },
      model,
      systemMessage: new SystemMessage('摘要器看到的系統提示。'),
      tools: [],
      runtime: config,
    } as never,
    ((request: { messages: BaseMessage[] }) => {
      handled.push(request.messages);
      return new AIMessage('好。');
    }) as never,
  );
  return { log, invokes, handled, messages };
}

/** 日誌推出來的那一串：則數、型別與 state 相同，物件不同。 */
const derived = (): BaseMessage[] =>
  conversation().map((message) =>
    message.getType() === 'human'
      ? new HumanMessage(`推：${String(message.content)}`)
      : new AIMessage(`推：${String(message.content)}`),
  );

const expectTemplate = (invokes: readonly Invoke[]): void => {
  expect(invokes).toHaveLength(1);
  expect(invokes[0]!.input).toHaveLength(1);
  expect(String(invokes[0]!.input[0]!.content).startsWith('Conversation to condense:')).toBe(true);
  expect(invokes[0]!.options?.['tools']).toBeUndefined();
};

describe('生摘要重播上一次主請求', () => {
  it('條件齊：上一次的系統訊息與工具、日誌推出來的訊息到切點為止，最後接摘要指令', async () => {
    const sentHistory = derived();
    const out = await run({
      sent: {
        messages: [SYSTEM, new HumanMessage('上一次的訊息')],
        options: {
          tools: TOOLS,
          strict: true,
          tool_choice: 'required',
          response_format: { type: 'json_object' },
          stop: ['\n'],
          signal: new AbortController().signal,
        },
      },
      sentHistoryOf: () => sentHistory,
    });
    expect(out.invokes).toHaveLength(1);
    const { input, options } = out.invokes[0]!;
    // 交下去的是「摘要＋留下的尾巴」，被摘掉的就是前面那幾則。
    const kept = out.handled.at(-1)!.length - 1;
    const replayed = sentHistory.slice(0, sentHistory.length - kept);
    expect(replayed.length).toBeGreaterThan(0);
    expect(input.slice(0, -1)).toEqual([SYSTEM, ...replayed]);
    expect(input[0]).toBe(SYSTEM);
    expect(input.at(-1)!.getType()).toBe('human');
    expect(input.at(-1)!.content).toBe(SUMMARY_INSTRUCTION);
    // 工具照帶；只管那一次呼叫與回覆形狀的幾格不帶。`tags` 是摘要呼叫自己加的。
    const { tags: _tags, ...sentOptions } = options ?? {};
    expect(sentOptions).toEqual({ tools: TOOLS, strict: true });
    expect(sentOptions['tools']).toBe(TOOLS);
    expect(out.log.events.filter((event) => event.type === 'compaction/summary')).toHaveLength(1);
  });

  it('子代理的日誌：讀者收到 subagent 旗標', async () => {
    const seen: (boolean | undefined)[] = [];
    await run({
      sent: { messages: [SYSTEM], options: {} },
      sentHistoryOf: (_log, subagent) => {
        seen.push(subagent);
        return derived();
      },
      lookup: (log) => ({ kind: 'ok', address: { kind: 'subagent' }, log }) as never,
    });
    expect(seen).toEqual([true]);
  });

  it.each<[string, Parameters<typeof run>[0]]>([
    ['這個行程還沒送過請求', { sentHistoryOf: derived }],
    ['沒有日誌讀者（state、shadow）', { sent: { messages: [SYSTEM], options: {} } }],
    [
      '日誌推出來的則數對不上',
      { sent: { messages: [SYSTEM], options: {} }, sentHistoryOf: () => derived().slice(1) },
    ],
    [
      '要摘的那一段裡有一則型別不同',
      {
        sent: { messages: [SYSTEM], options: {} },
        sentHistoryOf: () => [new AIMessage('不是人話'), ...derived().slice(1)],
      },
    ],
    [
      '推導拋錯',
      {
        sent: { messages: [SYSTEM], options: {} },
        sentHistoryOf: () => {
          throw new Error('推不出來');
        },
      },
    ],
    [
      '找不到這次呼叫的日誌',
      {
        sent: { messages: [SYSTEM], options: {} },
        sentHistoryOf: derived,
        lookup: () => ({ kind: 'not-attached' }) as never,
      },
    ],
  ])('退回模板：%s', async (_name, options) => {
    expectTemplate((await run(options)).invokes);
  });

  it('模板的後半就是摘要指令', () => {
    expect(SUMMARY_PROMPT.endsWith(`--- END OF CONVERSATION ---\n\n${SUMMARY_INSTRUCTION}`)).toBe(
      true,
    );
    expect(SUMMARY_INSTRUCTION).not.toContain('{conversation}');
  });
});

describe('最近一次送出的請求', () => {
  it('只留開頭連續的系統訊息；選項不是物件就是空的', () => {
    const log = new SessionLog('s');
    const later = new SystemMessage('中途的系統訊息');
    noteSentRequest(log, [[SYSTEM, new HumanMessage('一'), later]], undefined);
    expect(lastSentRequestOf(log)).toEqual({ system: [SYSTEM], options: {} });
    noteSentRequest(log, [], { timeout: 5, tools: TOOLS });
    expect(lastSentRequestOf(log)).toEqual({ system: [], options: { tools: TOOLS } });
  });

  it.each<[string, BaseMessage[], unknown]>([
    [
      '系統訊息帶非文字區塊',
      [
        new SystemMessage({
          content: [
            { type: 'text', text: '看圖' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        }),
      ],
      {},
    ],
    ['工具被遮蔽（mcp）', [SYSTEM], { tools: [{ type: 'mcp', headers: '[REDACTED]' }] }],
  ])('%s：連舊的一起清掉', (_name, messages, options) => {
    const log = new SessionLog('s');
    noteSentRequest(log, [[SYSTEM]], { tools: TOOLS });
    expect(lastSentRequestOf(log)).toBeDefined();
    noteSentRequest(log, [messages], options);
    expect(lastSentRequestOf(log)).toBeUndefined();
  });

  it('系統訊息是純文字區塊照留', () => {
    const log = new SessionLog('s');
    const blocks = new SystemMessage({ content: [{ type: 'text', text: '提示' }] });
    noteSentRequest(log, [[blocks]], { tools: TOOLS });
    expect(lastSentRequestOf(log)?.system).toEqual([blocks]);
  });
});
