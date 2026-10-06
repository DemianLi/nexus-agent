/**
 * 自有組裝點（`agent-assembly.ts`）的邊界：併法與「不支援就拋」。
 *
 * **組出來的東西與基座逐位元組相同**的證據在 `@nexus/harness` 的 `assembly-parity.test.ts`（它要整份產品路徑的
 * fold 產物與 `createDeepAgent` 當對照組）；這裡只驗不需要那些的：`mergeMiddlewareStack` 的規則，以及
 * 組裝點對「基座支援、我們不支援」的東西**拋並指名**而不是靜靜略過。
 */

import { FakeListChatModel } from '@langchain/core/utils/testing';
import { StateBackend } from 'deepagents';
import type { SubAgent } from 'deepagents';
import { createMiddleware } from 'langchain';
import { describe, expect, it } from 'vitest';

import { assembleAgent, mergeMiddlewareStack } from './agent-assembly.js';
import type { AssembleAgentParams } from './agent-assembly.js';

const named = (name: string, tag = name) => Object.assign(createMiddleware({ name }), { tag });
const namesOf = (stack: readonly { name: string }[]) => stack.map((entry) => entry.name);

describe('mergeMiddlewareStack', () => {
  it('同名的原地換掉預設與尾段，沒撞名的新 middleware 排在兩段之間', () => {
    const replacedDefault = named('summary', 'custom-summary');
    const replacedTail = named('memory', 'custom-memory');
    const merged = mergeMiddlewareStack(
      [named('fs'), named('summary')],
      [replacedTail, named('novel'), replacedDefault],
      [named('memory')],
    );

    expect(namesOf(merged)).toEqual(['fs', 'summary', 'novel', 'memory']);
    expect(merged[1]).toBe(replacedDefault);
    expect(merged[3]).toBe(replacedTail);
  });

  it('appendNew: false 時沒撞名的 custom 被丟掉，同名的照換', () => {
    const replaced = named('summary', 'custom');
    const merged = mergeMiddlewareStack(
      [named('fs'), named('summary')],
      [named('novel'), replaced],
      [],
      {
        appendNew: false,
      },
    );

    expect(namesOf(merged)).toEqual(['fs', 'summary']);
    expect(merged[1]).toBe(replaced);
  });

  it('custom 裡同名出現兩次時，後給的贏（基座用 Map.set 覆寫）', () => {
    const first = named('fs', 'first');
    const second = named('fs', 'second');

    expect(mergeMiddlewareStack([named('fs')], [first, second])[0]).toBe(second);
  });

  it('什麼都沒給時原樣回預設疊', () => {
    expect(namesOf(mergeMiddlewareStack([named('a'), named('b')], []))).toEqual(['a', 'b']);
  });
});

const GENERAL_PURPOSE: SubAgent = {
  name: 'general-purpose',
  description: '通用。',
  systemPrompt: '通用子代理。',
  tools: [],
};

function paramsWith(overrides: Partial<AssembleAgentParams> = {}): AssembleAgentParams {
  return {
    tools: [],
    subagents: [GENERAL_PURPOSE],
    middleware: [],
    model: new FakeListChatModel({ responses: ['好。'] }),
    backend: new StateBackend(),
    ...overrides,
  };
}

describe('assembleAgent 拒絕基座支援而我們不支援的東西', () => {
  it('組得起來的最小參數不拋', () => {
    expect(() => assembleAgent(paramsWith())).not.toThrow();
  });

  it('沒有模型、沒有 backend 就拋，指名缺哪一個', () => {
    expect(() => assembleAgent(paramsWith({ model: undefined }))).toThrow(/model/);
    expect(() => assembleAgent(paramsWith({ backend: undefined }))).toThrow(/backend/);
  });

  it('清單裡沒有 general-purpose 就拋：fold 一律自己補，缺了表示 fold 壞了', () => {
    expect(() => assembleAgent(paramsWith({ subagents: [] }))).toThrow(/general-purpose/);
  });

  it.each([
    ['async 子代理（帶 graphId）', { graphId: 'remote' }, /graphId/],
    ['fork 模式', { mode: 'fork' }, /fork/],
    ['interruptOn', { interruptOn: { write_file: true } }, /interruptOn/],
    ['responseFormat', { responseFormat: {} }, /responseFormat/],
  ])('子代理帶了 %s 就拋並指名', (_label, extra, pattern) => {
    const worker = {
      name: 'worker',
      description: '幹活。',
      systemPrompt: '幹活。',
      tools: [],
      ...extra,
    };

    expect(() =>
      assembleAgent(paramsWith({ subagents: [GENERAL_PURPOSE, worker as unknown as SubAgent] })),
    ).toThrow(pattern);
  });
});
