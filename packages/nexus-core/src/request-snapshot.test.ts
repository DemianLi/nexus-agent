/**
 * 請求快照的**純邏輯**：怎麼從 `handleChatModelStart` 收到的東西抽出要記的，以及「變了才記」的基準怎麼走。
 * 接進模型呼叫那一格（middleware 包出來的 callback、與端點實際收到的 body 逐項對）在
 * `apps/harness/src/request-snapshot.test.ts`。
 *
 * @see [#1020](https://github.com/DemianLi/nexus-agent/issues/1020)
 */

import type { AIMessage } from '@langchain/core/messages';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { Runnable } from '@langchain/core/runnables';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { describe, expect, it, vi } from 'vitest';

import {
  createRequestSnapshotRecorder,
  extractRequest,
  recordRequestSnapshot,
} from './request-snapshot.js';
import type { ExtractedRequest } from './request-snapshot.js';
import { SessionEventDepthError, SessionLog } from './session-log.js';

const ECHO = {
  type: 'function',
  function: {
    name: 'echo',
    description: '回聲。',
    parameters: { type: 'object', properties: { message: { type: 'string' } } },
  },
};

const messages = [[new SystemMessage('甲'), new SystemMessage('乙'), new HumanMessage('嗨')]];

describe('extractRequest', () => {
  it('系統提示詞：所有 system 訊息依序併起來，人類訊息不算', () => {
    expect(extractRequest(messages, {}, {}).system).toBe('甲\n\n乙');
  });

  it('設定：專屬欄位拆出來，其餘進 extra 且鍵照字母排，messages／stream／tools 不算設定', () => {
    const { header } = extractRequest(
      messages,
      {
        model: 'm',
        temperature: 0.2,
        top_p: 0.9,
        max_completion_tokens: 100,
        reasoning_effort: 'low',
        stop: ['。'],
        thinking: { type: 'disabled' },
        a_flag: true,
        stream: true,
        messages: [],
        tools: [ECHO],
      },
      {},
    );
    expect(header.config).toEqual({
      model: 'm',
      temperature: 0.2,
      topP: 0.9,
      maxTokens: 100,
      reasoningEffort: 'low',
      stop: ['。'],
      extra: { a_flag: true, thinking: { type: 'disabled' } },
    });
    expect(Object.keys(header.config.extra ?? {})).toEqual(['a_flag', 'thinking']);
  });

  it('工具：invocation_params 優先，沒有就退到 options.tools；兩邊形狀都收成 name／description／parameters', () => {
    const fromInvocation = extractRequest(messages, { tools: [ECHO] }, { tools: [] });
    const fromOptions = extractRequest(messages, {}, { tools: [ECHO] });
    const expected = [
      {
        name: 'echo',
        description: '回聲。',
        parameters: { type: 'object', properties: { message: { type: 'string' } } },
      },
    ];
    expect(fromInvocation.header.tools).toEqual(expected);
    expect(fromOptions.header.tools).toEqual(expected);
  });

  it('沒有工具就沒有 tools 這一格；認不得的形狀不進來也不拋', () => {
    expect(extractRequest(messages, {}, {}).header).not.toHaveProperty('tools');
    expect(
      extractRequest(messages, { tools: [null, 3, { nope: 1 }] }, {}).header,
    ).not.toHaveProperty('tools');
  });

  it('供應商沒報模型 id 時用備援', () => {
    expect(extractRequest(messages, {}, {}, 'fallback').header.config.model).toBe('fallback');
    expect(extractRequest(messages, { model: 'real' }, {}, 'fallback').header.config.model).toBe(
      'real',
    );
  });
});

/** 外面包 `layers` 層物件的 schema（最裡面是純量，所以巢狀層數剛好是 `layers`）。 */
function nested(layers: number): Record<string, unknown> {
  let value: Record<string, unknown> = { type: 'string' };
  for (let layer = 1; layer < layers; layer++) value = { next: value };
  return value;
}

const toolOf = (name: string, parameters: unknown) => ({
  type: 'function',
  function: { name, description: '壞掉的。', parameters },
});

describe('拷不動的參數不再靜靜丟掉（#1731，照 dsh snapshotJsonValue 拋出）', () => {
  it('循環參照的工具參數：拋 TypeError、訊息帶工具名稱，不是回一份少了參數的 header', () => {
    const cyclic: Record<string, unknown> = { type: 'object' };
    cyclic['self'] = cyclic;
    const call = () => extractRequest(messages, { tools: [ECHO, toolOf('looped', cyclic)] }, {});
    expect(call).toThrow(TypeError);
    expect(call).toThrow(/tools\["looped"\]\.parameters/);
    expect(call).toThrow(/這次請求不送/);
  });

  it('頂層不是 JSON（函式）：同樣拋、帶名稱', () => {
    expect(() => extractRequest(messages, { tools: [toolOf('fn', () => 1)] }, {})).toThrow(
      /tools\["fn"\]\.parameters.*function/,
    );
  });

  it('BigInt（原生 stringify 拒）：拋、帶名稱', () => {
    expect(() =>
      extractRequest(messages, { tools: [toolOf('big', { max: BigInt(1) })] }, {}),
    ).toThrow(/tools\["big"\]\.parameters/);
  });

  it('config.extra 也一樣：循環的 body 參數拋、帶鍵名，不是把那一格拿掉', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => extractRequest(messages, { model: 'm', thinking: cyclic }, {})).toThrow(
      /config\.extra\.thinking/,
    );
  });

  it('讀值的時候就拋（存取器壞了）：同樣帶名稱拋出，原錯留在 cause', () => {
    const parameters = {};
    Object.defineProperty(parameters, 'bad', {
      enumerable: true,
      get: () => {
        throw new Error('讀不了');
      },
    });
    let thrown: unknown;
    try {
      extractRequest(messages, { tools: [toolOf('getter', parameters)] }, {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toMatch(/tools\["getter"\]\.parameters.*讀不了/);
    expect(((thrown as Error).cause as Error).message).toBe('讀不了');
  });

  it('config.extra 頂層是 undefined 的鍵：略過，不拋、也不進 extra（那一格沒有值，供應商收不到）', () => {
    const { header } = extractRequest(messages, { model: 'm', gone: undefined, kept: 1 }, {});
    expect(header.config.extra).toEqual({ kept: 1 });
    expect(extractRequest(messages, { model: 'm', gone: undefined }, {}).header.config).toEqual({
      model: 'm',
    });
  });

  it('已知多報：最深處的 Date 在 JSON 往返後是字串，量法仍算它一層（fail-closed，工具 schema 實務上沒有 Date）', () => {
    // 596 層物件加最裡面一個 Date：量成 597 層而拒；往返後只剩 596 層、`append` 其實收得下。
    let value: Record<string, unknown> = { at: new Date(0) };
    for (let layer = 1; layer < 596; layer++) value = { next: value };
    expect(() => extractRequest(messages, { tools: [toolOf('dated', value)] }, {})).toThrow(
      SessionEventDepthError,
    );
    const roundTripped = JSON.parse(JSON.stringify(value)) as unknown;
    const header = { config: {}, tools: [{ name: 'dated', parameters: roundTripped }] };
    expect(() =>
      new SessionLog('d').append('request/header', { header, reason: 'initial' }),
    ).not.toThrow();
  });

  it('JSON 本來就丟的照舊（巢狀裡的 undefined、函式）：供應商收到的就是那樣，不算拷不動', () => {
    const { header } = extractRequest(
      messages,
      { tools: [toolOf('lossy', { type: 'object', a: undefined, b: () => 1, c: [1, undefined] })] },
      {},
    );
    expect(header.tools).toEqual([
      { name: 'lossy', description: '壞掉的。', parameters: { type: 'object', c: [1, null] } },
    ]);
  });

  it('參數是 undefined 或沒給：沒有那一格，不拋', () => {
    const { header } = extractRequest(messages, { tools: [toolOf('bare', undefined)] }, {});
    expect(header.tools).toEqual([{ name: 'bare', description: '壞掉的。' }]);
  });

  it('深度：工具名稱進 SessionEventDepthError，且界線跟寫入那一關完全一致（596 層過、597 層拒）', () => {
    // data(1) → header(2) → tools(3) → 一顆工具(4)，parameters 的根是第 5 層：596 層 parameters 剛好 600 層。
    const ok = extractRequest(messages, { tools: [toolOf('edge', nested(596))] }, {});
    const log = new SessionLog('s');
    expect(() => recordRequestSnapshot(log, ok, 0)).not.toThrow();
    expect(kinds(log)).toContain('request/header:initial');

    const call = () => extractRequest(messages, { tools: [toolOf('edge', nested(597))] }, {});
    expect(call).toThrow(SessionEventDepthError);
    expect(call).toThrow(/tools\["edge"\]\.parameters/);
    expect(call).toThrow(/超過上限 600 層/);
    // 沒有先量的話，是寫入那一關在 597 層拒（只是訊息裡沒有名字）：量法對得上它。
    const raw = { config: {}, tools: [{ name: 'edge', parameters: nested(597) }] };
    expect(() =>
      new SessionLog('t').append('request/header', { header: raw, reason: 'initial' }),
    ).toThrow(SessionEventDepthError);
    const fits = { config: {}, tools: [{ name: 'edge', parameters: nested(596) }] };
    expect(() =>
      new SessionLog('u').append('request/header', { header: fits, reason: 'initial' }),
    ).not.toThrow();
  });

  it('深到原生 stringify 會爆堆疊（5000 層）：先量先拒，拋的是帶名字的深度錯誤，不是 RangeError', () => {
    const call = () => extractRequest(messages, { tools: [toolOf('abyss', nested(5000))] }, {});
    expect(call).toThrow(SessionEventDepthError);
    expect(call).toThrow(/tools\["abyss"\]\.parameters/);
  });

  it('深度錯誤帶穩定碼：回合失敗分類認 code，不認訊息', () => {
    try {
      extractRequest(messages, { tools: [toolOf('edge', nested(700))] }, {});
      expect.unreachable();
    } catch (error) {
      expect((error as SessionEventDepthError).code).toBe('session_event_depth_exceeded');
    }
  });

  it('多顆工具只有一顆壞：名稱指的是壞的那一顆', () => {
    expect(() =>
      extractRequest(
        messages,
        { tools: [ECHO, toolOf('fine', {}), toolOf('deep', nested(900))] },
        {},
      ),
    ).toThrow(/tools\["deep"\]\.parameters/);
  });
});

const request = (system: string, tool = 'echo', temperature = 0): ExtractedRequest => ({
  system,
  header: { config: { model: 'm', temperature }, tools: [{ name: tool }] },
});

const kinds = (log: SessionLog) =>
  log.events
    .filter((event) => event.type === 'request/system' || event.type === 'request/header')
    .map((event) => `${event.type}:${(event.data as { reason: string }).reason}`);

describe('recordRequestSnapshot：變了才記', () => {
  it('第一次兩種都記（initial），沒變就什麼都不記', () => {
    const log = new SessionLog('s');
    recordRequestSnapshot(log, request('提示'), 0);
    recordRequestSnapshot(log, request('提示'), 1);
    recordRequestSnapshot(log, request('提示'), 2);
    expect(kinds(log)).toEqual(['request/system:initial', 'request/header:initial']);
  });

  it('只動系統提示詞就只記一顆 system；只動工具或設定就只記一顆 header', () => {
    const log = new SessionLog('s');
    recordRequestSnapshot(log, request('甲'), 0);
    recordRequestSnapshot(log, request('乙'), 1);
    recordRequestSnapshot(log, request('乙', 'other'), 2);
    recordRequestSnapshot(log, request('乙', 'other', 0.5), 3);
    expect(kinds(log)).toEqual([
      'request/system:initial',
      'request/header:initial',
      'request/system:change',
      'request/header:change',
      'request/header:change',
    ]);
  });

  it('改回原樣算變：基準是上一份，不是第一份', () => {
    const log = new SessionLog('s');
    recordRequestSnapshot(log, request('甲'), 0);
    recordRequestSnapshot(log, request('乙'), 1);
    recordRequestSnapshot(log, request('甲'), 2);
    expect(
      log.events.filter((event) => event.type === 'request/system').map((e) => e.data),
    ).toMatchObject([{ reason: 'initial' }, { reason: 'change' }, { reason: 'change' }]);
  });

  it('長提示詞：呼叫幾次都只記一份，日誌不隨呼叫數線性長', () => {
    const log = new SessionLog('s');
    const long = '很長的系統提示詞。'.repeat(2000);
    for (let call = 0; call < 50; call += 1) recordRequestSnapshot(log, request(long), call);
    expect(log.events.filter((event) => event.type === 'request/system')).toHaveLength(1);
  });

  it('識別附在兩顆上；沒有識別就不附這一格', () => {
    const log = new SessionLog('s');
    recordRequestSnapshot(log, request('甲'), 7);
    recordRequestSnapshot(log, request('乙', 'other'), undefined);
    expect(log.events.map((event) => (event.data as { modelCall?: number }).modelCall)).toEqual([
      7,
      7,
      undefined,
      undefined,
    ]);
    expect(log.events[2]!.data).not.toHaveProperty('modelCall');
  });

  it('兩種都標 ignorable，也不進模型', () => {
    const log = new SessionLog('s');
    recordRequestSnapshot(log, request('甲'), 0);
    expect(log.events.every((event) => event.ignorable === true)).toBe(true);
  });

  it('續接：新行程碰到帶快照的舊日誌，設定沒變就不重記；變了才記', () => {
    const before = new SessionLog('s');
    recordRequestSnapshot(before, request('甲'), 0);

    // 同一份事件當 seed 開出新日誌 = 新行程的 resume（基準住在日誌物件上，所以是全新的一份）。
    const same = new SessionLog('s', { seed: before.events });
    recordRequestSnapshot(same, request('甲'), 1);
    expect(kinds(same)).toEqual(['request/system:initial', 'request/header:initial']);

    const changed = new SessionLog('s', { seed: before.events });
    recordRequestSnapshot(changed, request('乙'), 1);
    expect(kinds(changed)).toEqual([
      'request/system:initial',
      'request/header:initial',
      'request/system:change',
    ]);
  });

  it('續接：舊日誌裡那顆 header 有 3000 層陣列巢狀，基準照樣建得起來，變了照記（#1526）', () => {
    // 深度取 3000 層陣列：CI（Node 22.23.3 Linux x64）上原生 `JSON.stringify` 對凍過的陣列約 2200 層就拋、沒凍過的
    // 約 4100 層，夾在中間才分得出「先拷再序列化」。
    let deep: unknown = 'leaf';
    for (let level = 0; level < 3_000; level++) deep = [deep];
    const before = new SessionLog('s');
    const shallow = request('甲');
    recordRequestSnapshot(before, shallow, 0);
    // 寫入那一關有深度上限（#1661），3000 層只會出現在上限之前寫下的舊日誌裡：把記下的 header 換成深的再續接。
    const seed = before.events.map((event) =>
      event.type === 'request/header'
        ? {
            ...event,
            data: {
              ...event.data,
              header: { ...event.data.header, tools: [{ name: 'echo', parameters: { deep } }] },
            },
          }
        : event,
    );

    const resumed = new SessionLog('s', { seed });
    const header = resumed.events.find((event) => event.type === 'request/header')!;
    // 前提：基準讀的是日誌裡凍過的那一份（見上：凍過的那一份直接序列化會拋）。
    expect(Object.isFrozen((header.data as { header: object }).header)).toBe(true);
    // 改之前：基準在 stringify 那一行拋，產品路徑上被 handler 的 `catch` 吞掉，之後每次呼叫兩種快照都不記。
    recordRequestSnapshot(resumed, shallow, 1);
    expect(kinds(resumed)).toEqual([
      'request/system:initial',
      'request/header:initial',
      'request/header:change',
    ]);
  });

  it('寫不進去（append 拋）基準不前進：下一次再試', () => {
    const log = new SessionLog('s');
    const append = log.append.bind(log);
    let fail = true;
    (log as { append: unknown }).append = (...args: Parameters<typeof log.append>) => {
      if (fail) {
        fail = false;
        throw new Error('壞了');
      }
      return append(...args);
    };
    expect(() => recordRequestSnapshot(log, request('甲'), 0)).toThrow('壞了');
    recordRequestSnapshot(log, request('甲'), 1);
    expect(kinds(log)).toContain('request/system:initial');
  });
});

describe('記不進去，這次請求不送（#1726，照 dsh agent.ts:637-650）', () => {
  it('handler 的錯原樣拋出、模型沒被叫；基準不前進，下一次記得進去照記 initial', async () => {
    const log = new SessionLog('s');
    const append = log.append.bind(log);
    const broken = new Error('壞了');
    let fail = true;
    (log as { append: unknown }).append = (...args: Parameters<typeof log.append>) => {
      if (fail) {
        fail = false;
        throw broken;
      }
      return append(...args);
    };
    const recorder = createRequestSnapshotRecorder({
      forCall: () => ({ kind: 'ok', address: { kind: 'root' }, log }),
    });
    const hook = (
      recorder as unknown as {
        wrapModelCall: (
          request: unknown,
          handler: (next: { model: Runnable }) => Promise<unknown>,
        ) => Promise<unknown>;
      }
    ).wrapModelCall;
    const model = new FakeListChatModel({ responses: ['好'] });
    let generated = 0;
    const generate = model._generate.bind(model);
    model._generate = (...args: Parameters<typeof model._generate>) => {
      generated += 1;
      return generate(...args);
    };
    // 走真的 callback：middleware 把 handler 綁在模型上，模型被叫時 `handleChatModelStart` 才跑。
    const call = () =>
      hook({ model, messages: [], runtime: { configurable: {} } }, (next) =>
        next.model.invoke(messages[0]!),
      );
    // LangChain 重拋前自己印一行 console.error（`callbacks/manager.js:376`），收起來不讓它弄髒輸出，順便斷言它真的印了。
    const printed = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(call()).rejects.toBe(broken);
      expect(generated).toBe(0);
      expect(kinds(log)).toEqual([]);
      expect(printed).toHaveBeenCalledTimes(1);
    } finally {
      printed.mockRestore();
    }

    const reply = (await call()) as AIMessage;
    expect(reply.content).toBe('好');
    expect(generated).toBe(1);
    expect(kinds(log)).toEqual(['request/system:initial', 'request/header:initial']);
  });
});
