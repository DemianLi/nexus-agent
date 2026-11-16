import { SystemMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import {
  captureInjectionSources,
  INJECTION_DEFERRED_BYTES_KEY,
  carriedInjectionSources,
  INJECTION_SOURCES,
  measuredInjectionSources,
  messageInjectionSources,
  reportInjectionSources,
} from './injection-sources.js';
import { sourceKwargs } from './message-source.js';
import { systemPromptWrapWith } from './system-prompt-step.js';
import type { SystemPromptPiece, SystemPromptRequest } from './system-prompt-step.js';

const stepOf =
  (pieces: readonly SystemPromptPiece[]) =>
  <R>(request: SystemPromptRequest, handler: (request: SystemPromptRequest) => R): R =>
    systemPromptWrapWith<SystemPromptRequest, R>({ step: () => pieces })(request, handler);

const base: SystemPromptRequest = { systemMessage: new SystemMessage('基底') };

describe('收集格', () => {
  it('沒有開著的格子：回報回 false，什麼都不留', () => {
    expect(reportInjectionSources([{ id: 'memory', bytes: 3 }])).toBe(false);
  });

  it('格子裡同一批同名相加，後一批蓋掉前一批（串流重試重跑內層）', async () => {
    const { result, reports } = await captureInjectionSources(undefined, () => {
      expect(
        reportInjectionSources([
          { id: 'a', bytes: 1 },
          { id: 'a', bytes: 2 },
        ]),
      ).toBe(true);
      reportInjectionSources([{ id: 'b', bytes: 5 }]);
      reportInjectionSources([{ id: 'a', bytes: 10 }]);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(reports).toEqual([
      { id: 'a', bytes: 10 },
      { id: 'b', bytes: 5 },
    ]);
  });

  it('底：外層帶進來的先放，內層同名的蓋掉它', async () => {
    const { reports } = await captureInjectionSources(
      [
        { id: 'skill-catalog', bytes: 7 },
        { id: 'x', bytes: 1 },
      ],
      () => reportInjectionSources([{ id: 'x', bytes: 9 }]),
    );
    expect(reports).toEqual([
      { id: 'skill-catalog', bytes: 7 },
      { id: 'x', bytes: 9 },
    ]);
  });

  it('巢狀：內層的格子收內層的，外層的不受影響；call 拋的錯原樣往外', async () => {
    const outer = await captureInjectionSources(undefined, async () => {
      reportInjectionSources([{ id: 'outer', bytes: 1 }]);
      const inner = await captureInjectionSources(undefined, () =>
        reportInjectionSources([{ id: 'inner', bytes: 2 }]),
      );
      expect(inner.reports).toEqual([{ id: 'inner', bytes: 2 }]);
    });
    expect(outer.reports).toEqual([{ id: 'outer', bytes: 1 }]);
    const boom = new Error('boom');
    await expect(
      captureInjectionSources(undefined, () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});

describe('系統提示那一步的回報', () => {
  it('有格子：帶 source 的塊照 UTF-8 位元組回報，沒帶的不報，請求上不掛東西', async () => {
    const { reports } = await captureInjectionSources(undefined, () =>
      stepOf([
        { prepend: '頭', source: 'system-prompt-prefix' },
        { append: '\n\n尾巴', source: 'system-prompt-suffix' },
        { append: '沒有來源' },
        { block: 'mem', source: 'memory' },
      ])(base, (request) => {
        expect(carriedInjectionSources(request)).toBeUndefined();
        return undefined;
      }),
    );
    expect(reports).toEqual([
      { id: 'system-prompt-prefix', bytes: 3 },
      { id: 'system-prompt-suffix', bytes: 8 },
      { id: 'memory', bytes: 3 },
    ]);
  });

  it('沒有格子：掛在往內交的請求上，一層一層累加；原本的請求物件不動', () => {
    const seen = stepOf([{ append: 'ab', source: 'skill-catalog' }])(base, (first) =>
      stepOf([{ append: 'cde', source: 'other' }])(first, (second) => second),
    );
    expect(carriedInjectionSources(seen)).toEqual([
      { id: 'skill-catalog', bytes: 2 },
      { id: 'other', bytes: 3 },
    ]);
    expect(INJECTION_SOURCES in base).toBe(false);
    // 展開複製帶得走：中間幾層 middleware 是這樣往內交的。
    expect(carriedInjectionSources({ ...seen })).toEqual(carriedInjectionSources(seen));
  });

  it('這一步沒有帶 source 的塊：不回報、不掛', () => {
    const seen = stepOf([{ append: 'x' }])(base, (request) => request);
    expect(carriedInjectionSources(seen)).toBeUndefined();
  });
});

describe('訊息串裡的源', () => {
  const instructions = sourceKwargs({
    kind: 'plugin',
    plugin: 'AgentInstructionsMiddleware',
    form: 'instructions',
  });
  const skill = sourceKwargs({ kind: 'skill-invocation', name: 'report', form: 'instructions' });

  it('照來源標記認，同源幾則相加；人講的話、別的機器訊息、沒有來源的都不算', () => {
    expect(
      messageInjectionSources([
        { content: '規則一', additional_kwargs: instructions },
        { content: 'hello', additional_kwargs: sourceKwargs({ kind: 'user' }) },
        { content: [{ type: 'text', text: 'ab' }, { type: 'image' }], additional_kwargs: skill },
        { content: 'cd', additional_kwargs: skill },
        { content: '時間', additional_kwargs: sourceKwargs({ kind: 'plugin', plugin: 'Other' }) },
        { content: '沒有來源' },
      ]),
    ).toEqual([
      { id: 'agent-instructions', bytes: 9 },
      { id: 'skill-invocation', bytes: 4 },
    ]);
  });
});

describe('組成 sources', () => {
  it('照 id 排序；表上整源一個上限的附 limit，每台一個上限的與表上沒有的不附', () => {
    expect(
      measuredInjectionSources(
        [
          { id: 'skill-catalog', bytes: 10 },
          { id: 'mcp:servers', bytes: 4 },
          { id: 'agent-instructions', bytes: 20 },
          { id: 'sandbox:policy', bytes: 2 },
          { id: 'plan:policy', bytes: 1 },
        ],
        32_768,
      ),
    ).toEqual([
      { id: 'agent-instructions', bytes: 20, limit: 13_107 },
      { id: 'mcp:servers', bytes: 4 },
      { id: 'plan:policy', bytes: 1, limit: 16_384 },
      { id: 'sandbox:policy', bytes: 2 },
      { id: 'skill-catalog', bytes: 10, limit: 6_553 },
    ]);
  });

  it('取不到窗口：limit 是絕對上限', () => {
    expect(measuredInjectionSources([{ id: 'memory', bytes: 1 }], undefined)).toEqual([
      { id: 'memory', bytes: 1, limit: 32_768 },
    ]);
  });
});

describe('延後的位元組（#2777）', () => {
  it('系統提示的塊帶 deferredBytes：跟著回報，同名相加', async () => {
    const { reports } = await captureInjectionSources(undefined, () =>
      stepOf([
        { append: '清單', source: 'skill-catalog', deferredBytes: 40 },
        { block: '記憶', source: 'memory' },
      ])(base, () => undefined),
    );
    expect(reports).toEqual([
      { id: 'skill-catalog', bytes: 6, deferredBytes: 40 },
      { id: 'memory', bytes: 6 },
    ]);
  });

  it('訊息上的那一格：正整數才算，同源幾則相加', () => {
    const skill = (content: string, deferred?: unknown) => ({
      content,
      additional_kwargs: {
        ...sourceKwargs({ kind: 'skill-invocation', name: 'x', form: 'instructions' }),
        ...(deferred !== undefined && { [INJECTION_DEFERRED_BYTES_KEY]: deferred }),
      },
    });
    expect(
      messageInjectionSources([
        skill('ab', 100),
        skill('c', 20),
        skill('d'),
        skill('e', -1),
        skill('f', '9'),
      ]),
    ).toEqual([{ id: 'skill-invocation', bytes: 6, deferredBytes: 120 }]);
  });

  it('sources 上只有延後過的源有 deferredBytes', () => {
    expect(
      measuredInjectionSources(
        [
          { id: 'memory', bytes: 10, deferredBytes: 300 },
          { id: 'skill-catalog', bytes: 20 },
        ],
        undefined,
      ),
    ).toEqual([
      { id: 'memory', bytes: 10, limit: 32768, deferredBytes: 300 },
      { id: 'skill-catalog', bytes: 20, limit: 32768 },
    ]);
  });
});
