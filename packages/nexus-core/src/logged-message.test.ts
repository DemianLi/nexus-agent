import { describe, it, expect } from 'vitest';
import type { BaseMessage, ContentBlock } from '@langchain/core/messages';
import {
  AIMessage,
  AIMessageChunk,
  ChatMessage,
  FunctionMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
} from '@langchain/core/messages';
import { fromLoggedMessage, loggedContentBlocks, toLoggedMessage } from './logged-message.js';
import { resumedLog } from './fixtures.js';
import {
  SESSION_EVENT_DEPTH_EXCEEDED,
  SESSION_EVENT_MAX_DEPTH,
  SessionEventDepthError,
} from './session-log.js';

describe('loggedContentBlocks', () => {
  it('把字串轉成一塊 text', () => {
    const blocks = loggedContentBlocks('hello');
    expect(blocks).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('空字串也是一塊', () => {
    const blocks = loggedContentBlocks('');
    expect(blocks).toEqual([{ type: 'text', text: '' }]);
  });

  it('區塊陣列原樣回傳', () => {
    const input: ContentBlock[] = [
      { type: 'text', text: '文字' },
      { type: 'reasoning', reasoning: '思考' } as unknown as ContentBlock,
    ];
    const blocks = loggedContentBlocks(input);
    expect(blocks).toEqual(input);
  });

  it('text + reasoning 陣列原樣', () => {
    const input: ContentBlock[] = [
      { type: 'text', text: '文字' },
      { type: 'reasoning', reasoning: '思考' } as unknown as ContentBlock,
      { type: 'text', text: '更多' },
    ];
    const blocks = loggedContentBlocks(input);
    expect(blocks).toEqual(input);
  });

  it('非字串非陣列回空陣列', () => {
    expect(loggedContentBlocks(null)).toEqual([]);
    expect(loggedContentBlocks(undefined)).toEqual([]);
    expect(loggedContentBlocks({})).toEqual([]);
    expect(loggedContentBlocks(123)).toEqual([]);
  });
});

describe('LoggedMessage 的型別', () => {
  /**
   * 型別絆索：`data.content` 是 `string | ContentBlock[]`，不是 LangChain d.ts 講的 `string`。
   * 還原成 `StoredMessage` 時，下面那行不再是錯誤，`@ts-expect-error` 變成「未使用」而讓 typecheck 轉紅。
   */
  it('data.content 直接 .trim() 編不過', () => {
    const message = toLoggedMessage(new AIMessage('x'));
    // @ts-expect-error 陣列沒有 trim；讀方要走 loggedContentBlocks。
    const attempt = () => message.data.content.trim();
    expect(typeof attempt).toBe('function');
  });
});

/**
 * 物件與陣列交錯的巢狀（#1526）。深度取 3000：`structuredClone` 在 CI（Node 22.23.3 Linux x64）約 1500–2100 層就
 * `RangeError`；Node 22 的原生 `JSON.stringify` 連沒凍過的也是遞迴的，CI 上約 4100 層就拋，再深連改寫後也過不了。
 */
function deepMixed(depth: number): unknown {
  let value: unknown = 'leaf';
  for (let level = 0; level < depth; level++) value = level % 2 ? { next: value } : [value];
  return value;
}

describe('fromLoggedMessage 推得回深巢狀的那一則（#1526）', () => {
  it('日誌裡凍過的、工具參數 3000 層交錯巢狀的 AI 訊息：推得回來，參數原樣、拿到的是可改的副本', () => {
    const args = { v: deepMixed(3_000) };
    // 照續接時的來路造：日誌形狀的訊息是從磁碟讀回來的，不經過 `toLoggedMessage`（LangChain 的 `toDict` 本身是遞迴的）。
    const shallow = new AIMessage({
      id: 'm1',
      content: '',
      tool_calls: [{ id: 'c1', name: 't', args: {} }],
    });
    const logged = toLoggedMessage(shallow);
    // `StoredMessageData` 的型別沒有列 `tool_calls`，實際落盤的 AI 訊息有。
    const data = logged.data as typeof logged.data & { readonly tool_calls: readonly object[] };
    const message = { ...logged, data: { ...data, tool_calls: [{ ...data.tool_calls[0], args }] } };
    // 寫入那一關有深度上限（#1661），3000 層只會出現在上限之前寫下、續接回來的舊日誌裡。
    const event = resumedLog('t', [['assistant/message', { message }]]).events[0]!;
    if (event.type !== 'assistant/message') throw new Error('第 0 顆不是 assistant/message');
    const back = fromLoggedMessage(event.data.message) as AIMessage;
    const backArgs = back.tool_calls?.[0]?.args as Record<string, unknown>;
    // 比對用 JSON.stringify：vitest 的 toEqual 是遞迴的。
    expect(JSON.stringify(backArgs)).toBe(JSON.stringify(args));
    expect(Object.isFrozen(backArgs)).toBe(false);
  });
});

describe('toLoggedMessage 交給 toDict 之前先量（#1668）', () => {
  const deepCall = (depth: number) =>
    new AIMessage({
      id: 'm1',
      content: '',
      tool_calls: [{ id: 'c1', name: 't', args: { v: deepMixed(depth) } }],
    });

  it('超過上限兩倍的先拒：帶碼的 SessionEventDepthError，不是 toDict 的 RangeError', () => {
    let thrown: unknown;
    try {
      toLoggedMessage(deepCall(SESSION_EVENT_MAX_DEPTH * 2 + 100));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SessionEventDepthError);
    expect((thrown as SessionEventDepthError).code).toBe(SESSION_EVENT_DEPTH_EXCEEDED);
  });

  it('比上限深、但不到兩倍的放行：交給日誌那一關拒，錯誤訊息才帶得到事件種類與路徑', () => {
    expect(() => toLoggedMessage(deepCall(SESSION_EVENT_MAX_DEPTH + 300))).not.toThrow();
  });
});

/** 帶自有 `"__proto__"` 鍵的物件，形狀同模型或 MCP 回的 JSON。 */
const POLLUTING = '{"__proto__":{"x":1},"a":1}';
const parsed = (): Record<string, unknown> => JSON.parse(POLLUTING) as Record<string, unknown>;

/** 基座 `toDict()` 那條路（改寫前 `toLoggedMessage` 的做法），當對照組。 */
function viaToDict(message: BaseMessage): string {
  const [stored] = mapChatMessagesToStoredMessages([message]);
  return JSON.stringify(JSON.parse(JSON.stringify(stored)));
}

describe('toLoggedMessage 自己取欄位（#1660）', () => {
  /**
   * 對照：沒有 `__proto__`、沒有 `lc` 鍵的訊息，新做法與基座 `toDict()` 逐位元組相同（鍵序也比）。
   * 這是「取欄位」這條路沒有悄悄改形狀的唯一憑據——鍵集、別名、`key in this` 的取值規則都是照基座抄的。
   */
  const SAMPLES: readonly [string, () => BaseMessage][] = [
    ['人話（字串）', () => new HumanMessage('哈囉')],
    [
      '人話（區塊＋name）',
      () => new HumanMessage({ content: [{ type: 'text', text: 'a' }], name: 'u' }),
    ],
    ['系統', () => new SystemMessage('規則')],
    [
      'AI：工具呼叫、壞的呼叫、用量、推理、回應中繼',
      () =>
        new AIMessage({
          id: 'm1',
          content: [
            { type: 'reasoning', reasoning: '想' },
            { type: 'text', text: '好' },
          ] as unknown as ContentBlock[],
          tool_calls: [
            { id: 'c1', name: 'read_file', args: { path: '/a', nested: { n: [1, 2] } } },
          ],
          invalid_tool_calls: [{ id: 'c2', name: 'x', args: '{oops', error: 'bad' }],
          usage_metadata: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
          additional_kwargs: { reasoning_content: '推理', n: 1 },
          response_metadata: { finish_reason: 'stop', model: 'm' },
        }),
    ],
    [
      'AIMessageChunk：串流來的 tool_call_chunks',
      () =>
        new AIMessageChunk({
          content: 'x',
          tool_call_chunks: [{ name: 'f', args: '{"a":1}', id: 'c1', index: 0 }],
        }),
    ],
    [
      'AI：v1 輸出（lc_kwargs 有 camelCase 的 contentBlocks，物件上的 content 與建構子收到的不同）',
      () =>
        new AIMessage({
          content: [{ type: 'text', text: 't' }],
          response_metadata: { output_version: 'v1' },
        }),
    ],
    ['AI：明著傳 undefined 的 id', () => new AIMessage({ content: 'x', id: undefined })],
    [
      '工具結果：artifact、status、name',
      () =>
        new ToolMessage({
          content: '結果',
          tool_call_id: 'c1',
          name: 'read_file',
          status: 'error',
          artifact: { kind: 'file', lines: [1, 2] },
        }),
    ],
    [
      '工具結果：artifact 明著傳 undefined',
      () => new ToolMessage({ content: 'r', tool_call_id: 'c1', artifact: undefined }),
    ],
    ['ChatMessage（role）', () => new ChatMessage({ content: 'c', role: 'critic' })],
    ['FunctionMessage', () => new FunctionMessage({ content: 'f', name: 'fn' })],
  ];

  /**
   * 別名表守衛：子類別的 `lc_aliases` getter 不一定 `...super.lc_aliases`（`ToolMessage` 就只回自己的一項），
   * 基座 `toJSON` 沿整條原型鏈合併。這裡造一個父類有「不是自己對應自己」的別名、子類 getter 又不帶 super 的訊息，
   * 只讀實例上那一份的做法會在這一組分岔。
   */
  it('別名表沿原型鏈合併：父類的別名子類沒帶上也算', () => {
    class Parent extends HumanMessage {
      override get lc_aliases(): Record<string, string> {
        return { ...super.lc_aliases, name: 'speaker' };
      }
    }
    class Child extends Parent {
      override get lc_aliases(): Record<string, string> {
        return { additional_kwargs: 'additional_kwargs' };
      }
    }
    const message = new Child({ content: 'x', name: 'n' });
    const logged = toLoggedMessage(message);
    expect(JSON.stringify(logged)).toBe(viaToDict(message));
    expect((logged.data as unknown as Record<string, unknown>)['speaker']).toBe('n');
  });

  it.each(SAMPLES)('對照：%s', (_label, make) => {
    const message = make();
    expect(JSON.stringify(toLoggedMessage(message))).toBe(viaToDict(message));
  });

  /** 每一格欄位各放一個帶自有 `"__proto__"` 的物件。 */
  const FIELDS: readonly [
    string,
    () => BaseMessage,
    (logged: ReturnType<typeof toLoggedMessage>) => unknown,
  ][] = [
    [
      'tool_calls[].args',
      () => new AIMessage({ content: '', tool_calls: [{ id: 'c1', name: 'p', args: parsed() }] }),
      (logged) =>
        (logged.data as unknown as { tool_calls: { args: unknown }[] }).tool_calls[0]?.args,
    ],
    [
      'ToolMessage.artifact',
      () => new ToolMessage({ content: 'r', tool_call_id: 'c1', artifact: parsed() }),
      (logged) => (logged.data as unknown as { artifact: unknown }).artifact,
    ],
    [
      'additional_kwargs',
      () => new AIMessage({ content: '', additional_kwargs: parsed() }),
      (logged) => logged.data.additional_kwargs,
    ],
    [
      'response_metadata',
      () => new AIMessage({ content: '', response_metadata: parsed() }),
      (logged) => logged.data.response_metadata,
    ],
    [
      'content 區塊',
      () =>
        new AIMessage({
          content: [{ type: 'text', text: 't', extra: parsed() }] as unknown as ContentBlock[],
        }),
      (logged) => (logged.data.content as unknown as { extra: unknown }[])[0]?.extra,
    ],
  ];

  it.each(FIELDS)('%s 裡的自有 "__proto__" 鍵記得下、原型乾淨', (_label, make, pick) => {
    const logged = toLoggedMessage(make());
    const value = pick(logged) as Record<string, unknown>;
    expect(Object.hasOwn(value, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(value, '__proto__')?.value).toEqual({ x: 1 });
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(value['x']).toBeUndefined();
    expect(value['a']).toBe(1);
  });

  it('來回一趟（記下、讀回）：args 仍有自有 "__proto__" 鍵，原型乾淨、沒有繼承來的鍵', () => {
    const ai = new AIMessage({
      id: 'm1',
      content: '',
      tool_calls: [{ id: 'c1', name: 'probe', args: parsed() }],
    });
    const back = fromLoggedMessage(toLoggedMessage(ai)) as AIMessage;
    const args = back.tool_calls?.[0]?.args as Record<string, unknown>;
    expect(Object.hasOwn(args, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(args, '__proto__')?.value).toEqual({ x: 1 });
    expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
    expect(args['x']).toBeUndefined();
    expect(JSON.stringify(args)).toBe(POLLUTING);
    // 再記一次，位元組相同：續接後的下一輪看到的就是模型當時送的那份。
    expect(JSON.stringify(toLoggedMessage(back))).toBe(JSON.stringify(toLoggedMessage(ai)));
  });

  it('來源訊息不被動：args 還是原來那一份，原型沒被換', () => {
    const args = parsed();
    const ai = new AIMessage({ content: '', tool_calls: [{ id: 'c1', name: 'p', args }] });
    toLoggedMessage(ai);
    expect(ai.tool_calls?.[0]?.args).toBe(args);
    expect(Object.hasOwn(args, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
  });

  it('記下來的是副本：之後改來源，日誌那一份不變', () => {
    const args = parsed();
    const ai = new AIMessage({ content: '', tool_calls: [{ id: 'c1', name: 'p', args }] });
    const logged = toLoggedMessage(ai);
    args['a'] = 2;
    (args['__proto__'] as Record<string, unknown>)['x'] = 9;
    const stored = (logged.data as unknown as { tool_calls: { args: Record<string, unknown> }[] })
      .tool_calls[0]!.args;
    expect(stored['a']).toBe(1);
    expect(Object.getOwnPropertyDescriptor(stored, '__proto__')?.value).toEqual({ x: 1 });
  });

  /**
   * 順帶修好的一格：基座的 `escapeIfNeeded` 把帶 `lc` 鍵的物件包成 `{ __lc_escaped__: … }`，而讀回那一半
   * （`mapStoredMessagesToChatMessages`）不拆，續接回來的工具參數就多一層。自己取欄位之後原樣記、原樣讀回。
   */
  it('帶 lc 鍵的工具參數不被包一層', () => {
    const args = { lc: 1, type: 'constructor', id: ['x'] };
    const ai = new AIMessage({ content: '', tool_calls: [{ id: 'c1', name: 'p', args }] });
    const logged = toLoggedMessage(ai);
    expect(JSON.stringify(logged)).not.toContain('__lc_escaped__');
    const back = fromLoggedMessage(logged) as AIMessage;
    expect(back.tool_calls?.[0]?.args).toEqual(args);
  });
  /**
   * PM 的兩個條件（#1950 審查）：形狀像 LangChain 序列化物件的參數，讀回來還是普通物件，不能被還原成訊息之類的實例；
   * 舊日誌裡已經被包過 `__lc_escaped__` 的資料，讀回行為不能變（照基座原樣讀），再記一次也不會多包一層。
   */
  const SHAPED = {
    lc: 1,
    type: 'constructor',
    id: ['langchain_core', 'messages', 'AIMessage'],
    kwargs: { content: 'boom' },
  };

  it('形狀像 LangChain 序列化物件的參數：讀回來是普通物件，不是還原出的實例', () => {
    const ai = new AIMessage({ content: '', tool_calls: [{ id: 'c1', name: 'p', args: SHAPED }] });
    const back = fromLoggedMessage(toLoggedMessage(ai)) as AIMessage;
    const args = back.tool_calls?.[0]?.args as Record<string, unknown>;
    expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
    expect('lc_serializable' in args).toBe(false);
    expect(args).toEqual(SHAPED);
  });

  it('舊日誌裡已包過 __lc_escaped__ 的參數：讀回與基座原樣讀一致，再記一次不多包', () => {
    const oldLogged = {
      type: 'ai',
      data: {
        content: '',
        tool_calls: [{ id: 'c1', name: 'p', args: { __lc_escaped__: SHAPED } }],
        invalid_tool_calls: [],
        additional_kwargs: {},
        response_metadata: {},
      },
    };
    const viaBase = mapStoredMessagesToChatMessages([
      JSON.parse(JSON.stringify(oldLogged)) as never,
    ])[0] as AIMessage;
    const ours = fromLoggedMessage(oldLogged as never) as AIMessage;
    expect(JSON.stringify(ours.tool_calls)).toBe(JSON.stringify(viaBase.tool_calls));
    expect(ours.tool_calls?.[0]?.args).toEqual({ __lc_escaped__: SHAPED });
    expect(
      JSON.stringify((toLoggedMessage(ours).data as unknown as { tool_calls: unknown }).tool_calls),
    ).toBe(JSON.stringify(oldLogged.data.tool_calls));
  });
});
