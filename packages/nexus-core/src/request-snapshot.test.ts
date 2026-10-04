/**
 * 請求快照的**純邏輯**：怎麼從 `handleChatModelStart` 收到的東西抽出要記的，以及「變了才記」的基準怎麼走。
 * 接進模型呼叫那一格（middleware 包出來的 callback、與端點實際收到的 body 逐項對）在
 * `apps/harness/src/request-snapshot.test.ts`。
 *
 * @see [#1020](https://github.com/DemianLi/nexus-agent/issues/1020)
 */

import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import { extractRequest, recordRequestSnapshot } from './request-snapshot.js';
import type { ExtractedRequest } from './request-snapshot.js';
import { SessionLog } from './session-log.js';

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
