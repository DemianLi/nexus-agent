/**
 * subagent 定義的註冊驗證（[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 3 項）：`model` 要在型錄裡、`reasoningEffort` 要是
 * 那顆模型宣告過而且今天實作的等級，認不得就在註冊的當下拋，並指名是誰註冊的。
 */

import { createRegistry } from '@nexus/core';
import type { NexusSubAgent } from '@nexus/core';
import { describe, expect, it } from 'vitest';

import type { ModelEntry } from './model-catalog.js';
import { subagentDefinitionValidator } from './subagent-definition.js';

const entry = (id: string, extra: Partial<ModelEntry> = {}): ModelEntry => ({
  id,
  contextWindow: 100_000,
  maxTokens: 4096,
  ...extra,
});
const CATALOG: ModelEntry[] = [
  entry('strong', { reasoningEfforts: { off: null, low: 'low', default: null } }),
  entry('cheap', { reasoningEfforts: { off: null } }),
  entry('plain', { reasoningEfforts: false }),
  entry('silent'),
];

const definition = (extra: Partial<NexusSubAgent> = {}): NexusSubAgent => ({
  name: 'worker',
  description: '幹活的。',
  systemPrompt: '你是 worker。',
  ...extra,
});

describe('subagentDefinitionValidator', () => {
  const validate = subagentDefinitionValidator(CATALOG);

  it('什麼都沒釘：收', () => {
    expect(() => validate(definition())).not.toThrow();
  });

  it('model 是型錄 id：收；認不得的拋，列出型錄有哪些', () => {
    expect(() => validate(definition({ model: 'cheap' }))).not.toThrow();
    expect(() => validate(definition({ model: 'nope' }))).toThrow(
      /"nope".*不在型錄.*strong.*cheap/,
    );
  });

  it('model 給實例：不對型錄驗（實例不是型錄 id）', () => {
    expect(() => validate(definition({ model: { invoke: () => 0 } as never }))).not.toThrow();
  });

  it('reasoningEffort 配 model：要是那顆宣告過的、今天實作的（off／default）', () => {
    expect(() => validate(definition({ model: 'cheap', reasoningEffort: 'off' }))).not.toThrow();
    expect(() =>
      validate(definition({ model: 'strong', reasoningEffort: 'default' })),
    ).not.toThrow();
    // strong 宣告了 low，但今天還不支援。
    expect(() => validate(definition({ model: 'strong', reasoningEffort: 'low' }))).toThrow(
      /"low".*還不支援.*off.*default/,
    );
    // plain 沒宣告任何等級。
    expect(() => validate(definition({ model: 'plain', reasoningEffort: 'off' }))).toThrow(
      /"plain".*沒有推理等級 "off"/,
    );
    // cheap 只宣告 off，沒宣告 default 但 default 一律收（不加任何東西）。
    expect(() =>
      validate(definition({ model: 'cheap', reasoningEffort: 'default' })),
    ).not.toThrow();
  });

  it('reasoningEffort 不配 model（＝父代理當下那顆，註冊時未知）：型錄裡至少有一顆宣告過才收', () => {
    expect(() => validate(definition({ reasoningEffort: 'off' }))).not.toThrow();
    const noEfforts = subagentDefinitionValidator([entry('plain', { reasoningEfforts: false })]);
    expect(() => noEfforts(definition({ reasoningEffort: 'off' }))).toThrow(/沒有任何一顆/);
  });

  it('reasoningEffort 配模型實例：拒絕（強度要設在實例上）；空字串也拒絕', () => {
    expect(() =>
      validate(definition({ model: { invoke: () => 0 } as never, reasoningEffort: 'off' })),
    ).toThrow(/模型實例/);
    expect(() => validate(definition({ reasoningEffort: '' }))).toThrow(/空字串/);
  });

  it('沒有型錄（沒連真實供應商）：字串 model 與 reasoningEffort 一律拒絕，只收 maxTurns 與實例', () => {
    const none = subagentDefinitionValidator(undefined);
    expect(() => none(definition({ model: 'cheap' }))).toThrow(/沒有型錄/);
    expect(() => none(definition({ reasoningEffort: 'off' }))).toThrow(/沒有型錄/);
    expect(() => none(definition({ maxTurns: 3 }))).not.toThrow();
    expect(() => none(definition({ model: { invoke: () => 0 } as never }))).not.toThrow();
  });

  it('接上註冊點：當場拋，訊息指名註冊者與子代理名；合法的照常登記', () => {
    const registry = createRegistry({ validateSubagent: validate });
    const leave = registry.enter({ id: 'writer#0', name: 'writer' });
    registry.subagents.register(definition({ model: 'cheap', maxTurns: 4 }));
    expect(() => registry.subagents.register(definition({ name: 'bad', model: 'nope' }))).toThrow(
      /writer#0 \(writer\).*"bad".*"nope"/,
    );
    leave();
    expect([...registry.subagents.entries()].map(([name]) => name)).toEqual(['worker']);
  });
});
