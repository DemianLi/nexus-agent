/**
 * 舊工具呼叫參數的縮短在日誌裡（[#1303](https://github.com/DemianLi/nexus-agent/issues/1303)）：
 * 純函式（讀、換、比），以及 `createSummarizer` 包的那一層接上**真的基座**之後的行為。
 *
 * 整條線接真的 CLI／serve、拿推導的歷史對線上請求逐位元組比的那一頭在 `apps/harness/src/log-derived-history.test.ts`（S9、SH4、SV6、SR5）。
 * 這裡問的是：基座縮短了就記一筆、記過的下一次沿用不重記、日誌上有而基座這次不縮的照樣換上去、記不進去不殺摘要器。
 */

import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { SessionLog } from './session-log.js';
import type { SessionEvent } from './session-log.js';
import { createSummarizer, DEFAULT_SUMMARIZATION } from './summarization.js';
import {
  applyRecordedArgTruncation,
  applyRecordedArgTruncations,
  newlyTruncatedArgs,
  recordedArgTruncationsOf,
} from './tool-arg-truncation-log.js';
import { TokenAnchorBook } from './token-estimate.js';

const MARKER = '...(argument truncated)';

/** 一則帶 `write_file` 呼叫的助手訊息，帶 `response_metadata` 與 `id`，看換完還在不在。 */
const writeCall = (callId: string, content: string): AIMessage =>
  new AIMessage({
    id: `msg_${callId}`,
    content: '好，我來寫。',
    tool_calls: [{ id: callId, name: 'write_file', args: { file_path: '/a.txt', content } }],
    response_metadata: { output_version: 'v1' },
  });

const toolDone = (callId: string): ToolMessage =>
  new ToolMessage({ content: '寫好了', tool_call_id: callId, name: 'write_file' });

/** 把一個縮短記進一份日誌。 */
function recordInto(
  log: SessionLog,
  callId: string,
  args: Record<string, { originalChars: number; value: string }>,
): void {
  log.append('compaction/truncate-args', { calls: [{ callId, args }] });
}

describe('從日誌讀縮短', () => {
  it('沒有 compaction/truncate-args 就是空的', () => {
    const log = new SessionLog('s');
    log.append('turn/start', { kind: 'message', text: '嗨' });
    expect(recordedArgTruncationsOf(log.events).size).toBe(0);
  });

  it('逐個參數收，同一個參數記了兩次以後記的為準', () => {
    const log = new SessionLog('s');
    recordInto(log, 'a', { content: { originalChars: 500, value: '甲' } });
    recordInto(log, 'a', {
      content: { originalChars: 500, value: '甲二' },
      old_string: { originalChars: 300, value: '乙' },
    });
    recordInto(log, 'b', { content: { originalChars: 600, value: '丙' } });
    const recorded = recordedArgTruncationsOf(log.events);
    expect([...recorded.keys()].sort()).toEqual(['a', 'b']);
    expect(recorded.get('a')?.get('content')?.value).toBe('甲二');
    expect(recorded.get('a')?.get('old_string')?.value).toBe('乙');
  });
});

describe('把記過的換上去', () => {
  const original = 'abc'.repeat(100);
  const recorded = () => {
    const log = new SessionLog('s');
    recordInto(log, 'call_w', { content: { originalChars: 300, value: `abc${MARKER}` } });
    return recordedArgTruncationsOf(log.events);
  };

  it('只換記過的那個參數，其餘欄位（id、response_metadata、content、其他參數）原樣', () => {
    const message = writeCall('call_w', original);
    const replaced = applyRecordedArgTruncation(message, recorded()) as AIMessage;
    expect(replaced).not.toBe(message);
    expect(replaced.tool_calls?.[0]?.args).toEqual({
      file_path: '/a.txt',
      content: `abc${MARKER}`,
    });
    expect(replaced.id).toBe('msg_call_w');
    expect(replaced.response_metadata).toEqual({ output_version: 'v1' });
    // v1 的訊息建構子補了 `tool_call` content block，block 裡的參數跟著換，文字區塊原樣。
    expect(replaced.content).toEqual([
      { type: 'text', text: '好，我來寫。' },
      {
        type: 'tool_call',
        id: 'call_w',
        name: 'write_file',
        args: { file_path: '/a.txt', content: `abc${MARKER}` },
      },
    ]);
    // 原訊息沒被動到。
    expect(message.tool_calls?.[0]?.args.content).toBe(original);
  });

  it('舊路的訊息（字串內容、沒有 v1 標記）：content 不動', () => {
    const message = new AIMessage({
      id: 'msg_old',
      content: '舊路。',
      tool_calls: [
        { id: 'call_w', name: 'write_file', args: { file_path: '/a.txt', content: original } },
      ],
    });
    const replaced = applyRecordedArgTruncation(message, recorded()) as AIMessage;
    expect(replaced.content).toBe('舊路。');
    expect(replaced.tool_calls?.[0]?.args.content).toBe(`abc${MARKER}`);
  });

  it('edit_file 的兩個長參數都能換', () => {
    const log = new SessionLog('s');
    recordInto(log, 'call_e', {
      old_string: { originalChars: 250, value: `o${MARKER}` },
      new_string: { originalChars: 260, value: `n${MARKER}` },
    });
    const message = new AIMessage({
      content: '',
      tool_calls: [
        {
          id: 'call_e',
          name: 'edit_file',
          args: { file_path: '/b.ts', old_string: 'o'.repeat(250), new_string: 'n'.repeat(260) },
        },
      ],
    });
    const replaced = applyRecordedArgTruncation(message, recordedArgTruncationsOf(log.events));
    expect((replaced as AIMessage).tool_calls?.[0]?.args).toEqual({
      file_path: '/b.ts',
      old_string: `o${MARKER}`,
      new_string: `n${MARKER}`,
    });
  });

  it('長度對不上不換（供應商重用了工具呼叫 id）', () => {
    const message = writeCall('call_w', 'x'.repeat(299));
    expect(applyRecordedArgTruncation(message, recorded())).toBe(message);
  });

  it('沒記過的呼叫、不是助手訊息、助手訊息沒有工具呼叫，都原樣', () => {
    const other = writeCall('call_other', original);
    expect(applyRecordedArgTruncation(other, recorded())).toBe(other);
    const human = new HumanMessage('嗨');
    expect(applyRecordedArgTruncation(human, recorded())).toBe(human);
    const plain = new AIMessage('沒有呼叫');
    expect(applyRecordedArgTruncation(plain, recorded())).toBe(plain);
  });

  it('一則都沒換時 applyRecordedArgTruncations 回原本那個陣列，換了則長度與順序不變', () => {
    const untouched = [new HumanMessage('嗨'), writeCall('call_other', original)];
    expect(applyRecordedArgTruncations(untouched, recorded())).toBe(untouched);
    expect(applyRecordedArgTruncations(untouched, new Map())).toBe(untouched);
    const messages = [new HumanMessage('嗨'), writeCall('call_w', original), toolDone('call_w')];
    const next = applyRecordedArgTruncations(messages, recorded());
    expect(next).toHaveLength(3);
    expect(next[0]).toBe(messages[0]);
    expect(next[2]).toBe(messages[2]);
    expect((next[1] as AIMessage).tool_calls?.[0]?.args.content).toBe(`abc${MARKER}`);
  });
});

describe('拿基座交下去的串跟進來的串比', () => {
  const original = 'abc'.repeat(100);

  it('用工具呼叫 id 對：交下去的串開頭多一則摘要、少一截舊訊息也照樣認得', () => {
    const before = [
      new HumanMessage('舊的'),
      writeCall('call_w', original),
      toolDone('call_w'),
      new HumanMessage('新的'),
    ];
    const sent = [
      new HumanMessage('摘要'),
      new AIMessage({
        content: '',
        tool_calls: [
          { id: 'call_w', name: 'write_file', args: { file_path: '/a.txt', content: 'abc…' } },
        ],
      }),
      toolDone('call_w'),
      new HumanMessage('新的'),
    ];
    expect(newlyTruncatedArgs(before, sent)).toEqual([
      { callId: 'call_w', args: { content: { originalChars: 300, value: 'abc…' } } },
    ]);
  });

  it('沒變的不記；非字串的參數不記；交下去才有的呼叫不記', () => {
    const before = [writeCall('call_w', original)];
    expect(newlyTruncatedArgs(before, before)).toEqual([]);
    const numeric = new AIMessage({
      content: '',
      tool_calls: [{ id: 'call_n', name: 'x', args: { n: 1 } }],
    });
    const changed = new AIMessage({
      content: '',
      tool_calls: [{ id: 'call_n', name: 'x', args: { n: 2 } }],
    });
    expect(newlyTruncatedArgs([numeric], [changed])).toEqual([]);
    expect(newlyTruncatedArgs([], before)).toEqual([]);
  });

  it('進來的串裡同一個 id 出現兩次的不比', () => {
    const before = [writeCall('dup', original), writeCall('dup', original + 'x')];
    const sent = [
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'dup', name: 'write_file', args: { file_path: '/a', content: '短' } }],
      }),
    ];
    expect(newlyTruncatedArgs(before, sent)).toEqual([]);
  });
});

/**
 * 接真的基座：`createSummarizer` 包的那一層。摘要門檻設到碰不到（只觀察縮短），縮短門檻壓低。
 */
describe('createSummarizer 接上真的基座', () => {
  const settings = {
    ...DEFAULT_SUMMARIZATION,
    trigger: [{ type: 'messages' as const, value: 1_000 }],
    keep: { type: 'messages' as const, value: 2 },
    truncateArgs: {
      trigger: { type: 'messages' as const, value: 4 },
      keep: { type: 'messages' as const, value: 2 },
      maxLength: 100,
    },
  };
  const original = 'abc'.repeat(100);
  const model = { profile: {}, invoke: async () => ({ text: '摘要' }) };

  /** 一串夠長、舊的一則帶長參數的訊息。 */
  const history = (extra = 0): BaseMessage[] => [
    new HumanMessage('寫檔'),
    writeCall('call_w', original),
    toolDone('call_w'),
    new AIMessage('寫好了'),
    ...Array.from({ length: extra }, (_, i) => new HumanMessage(`再說 ${i}`)),
    new HumanMessage('最後一句'),
  ];

  function setup(lookup: (log: SessionLog) => unknown) {
    const log = new SessionLog('s');
    const middleware = createSummarizer(
      { write: async (path: string) => ({ path }) } as never,
      settings,
      new TokenAnchorBook(),
      { forCall: () => lookup(log) } as never,
      false,
    );
    const sent: (readonly BaseMessage[])[] = [];
    const call = (messages: readonly BaseMessage[]) =>
      middleware.wrapModelCall?.(
        {
          messages,
          state: {},
          model,
          systemMessage: new SystemMessage('系統。'),
          tools: [],
        } as never,
        ((request: { messages: readonly BaseMessage[] }) => {
          sent.push(request.messages);
          return new AIMessage('好。');
        }) as never,
      );
    return { log, sent, call };
  }

  const argOf = (messages: readonly BaseMessage[]): unknown =>
    (messages.find((m) => AIMessage.isInstance(m) && m.tool_calls?.length) as AIMessage)
      .tool_calls?.[0]?.args.content;
  const truncations = (log: SessionLog): SessionEvent<'compaction/truncate-args'>[] =>
    log.events.filter(
      (e): e is SessionEvent<'compaction/truncate-args'> => e.type === 'compaction/truncate-args',
    );

  it('基座縮短了就記一筆；記的是進來的原長與交下去的那份', async () => {
    const { log, sent, call } = setup((l) => ({ kind: 'ok', address: { kind: 'root' }, log: l }));
    await call(history());
    expect(String(argOf(sent[0]!))).toContain('argument truncated');
    const events = truncations(log);
    expect(events).toHaveLength(1);
    expect(events[0]!.data.calls).toEqual([
      { callId: 'call_w', args: { content: { originalChars: 300, value: argOf(sent[0]!) } } },
    ]);
  });

  it('記過的下一次沿用、不重記——訊息變多、基座照樣重算也一樣', async () => {
    const { log, sent, call } = setup((l) => ({ kind: 'ok', address: { kind: 'root' }, log: l }));
    await call(history());
    await call(history(2));
    await call(history(5));
    expect(sent.map((s) => String(argOf(s)))).toEqual([
      String(argOf(sent[0]!)),
      String(argOf(sent[0]!)),
      String(argOf(sent[0]!)),
    ]);
    expect(truncations(log)).toHaveLength(1);
  });

  /**
   * 基座的 `modified` 旗標是迴圈外的一個變數：長參數那則一被截斷，它後面（切點之前）的每一則助手訊息都被整則重建，丟掉 `response_metadata`。
   * 這裡一次跨過一串，把這個行為釘住——日誌記的只有**真的變短的參數**，被連累重建的鄰居不記（它們的參數沒變）。
   * 夾具的 SV7 在 serve 上量這件事對 wire 是中性的。
   */
  it('一次跨過一串：長參數後面的助手訊息被基座整則重建，日誌只記變短的那一個', async () => {
    const plain = (text: string): AIMessage =>
      new AIMessage({ content: text, response_metadata: { output_version: 'v1' } });
    const { log, sent, call } = setup((l) => ({ kind: 'ok', address: { kind: 'root' }, log: l }));
    const messages = [
      new HumanMessage('寫檔'),
      writeCall('call_w', original),
      toolDone('call_w'),
      plain('寫好了'),
      new HumanMessage('二'),
      plain('二的回覆'),
      new HumanMessage('三'),
      plain('三的回覆'),
      new HumanMessage('四'),
    ];
    await call(messages);
    const metaOf = (message: BaseMessage) => Object.keys((message as AIMessage).response_metadata);
    const ais = sent[0]!.filter((m) => AIMessage.isInstance(m));
    expect(String(argOf(sent[0]!))).toContain('argument truncated');
    // 基座重建：長參數那則與它後面、切點之前的兩則，`response_metadata` 都沒了；切點之後（最後保留的兩則裡的那則）原樣。
    expect(ais.map(metaOf)).toEqual([[], [], [], ['output_version']]);
    const events = truncations(log);
    expect(events).toHaveLength(1);
    expect(events[0]!.data.calls.map((c) => c.callId)).toEqual(['call_w']);
    // 下一次請求：記過的預先換上去，基座看不到長參數、沒有東西被截斷，鄰居與被換過的那則都保有原本的 `response_metadata`。
    await call(messages);
    expect(sent[1]!.filter((m) => AIMessage.isInstance(m)).map(metaOf)).toEqual([
      ['output_version'],
      ['output_version'],
      ['output_version'],
      ['output_version'],
    ]);
    expect(truncations(log)).toHaveLength(1);
  });

  it('日誌上記著、基座這次不縮（還沒到門檻）：照日誌換上去，不重記——重啟之後就是這一格', async () => {
    const { log, sent, call } = setup((l) => ({ kind: 'ok', address: { kind: 'root' }, log: l }));
    recordInto(log, 'call_w', { content: { originalChars: 300, value: `abc${MARKER}` } });
    // 只有兩則：沒到縮短的門檻（4 則），基座自己不會縮。
    await call([new HumanMessage('寫檔'), writeCall('call_w', original)]);
    expect(argOf(sent[0]!)).toBe(`abc${MARKER}`);
    expect(truncations(log)).toHaveLength(1);
  });

  it('沒有被縮短的會話：日誌不多寫事件，交下去的訊息就是進來的', async () => {
    const { log, sent, call } = setup((l) => ({ kind: 'ok', address: { kind: 'root' }, log: l }));
    const messages = [
      new HumanMessage('寫檔'),
      writeCall('call_s', '短'),
      toolDone('call_s'),
      new AIMessage('好'),
      new HumanMessage('再來'),
    ];
    await call(messages);
    expect(truncations(log)).toHaveLength(0);
    expect(sent[0]).toEqual(messages);
  });

  it('接不到日誌（沒接註冊表）：基座照縮、不記、不拋', async () => {
    const { log, sent, call } = setup(() => ({ kind: 'not-attached' }));
    await call(history());
    expect(String(argOf(sent[0]!))).toContain('argument truncated');
    expect(truncations(log)).toHaveLength(0);
  });

  it('記不進去（append 拋）不殺摘要器：模型呼叫照常發生', async () => {
    const broken = {
      kind: 'ok',
      address: { kind: 'root' },
      log: {
        events: [],
        append: () => {
          throw new Error('寫不進去');
        },
      },
    };
    const { sent, call } = setup(() => broken);
    await expect(call(history())).resolves.toBeDefined();
    expect(String(argOf(sent[0]!))).toContain('argument truncated');
  });
});
