/**
 * 子代理選模型的政策怎麼從設定與日誌決定（[#875](https://github.com/DemianLi/nexus-agent/issues/875)）：
 * 新會話取樣設定、有歷史的只讀日誌、沒有事件就是關。
 */

import type { SessionEvent } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import {
  assertAllowedModelsInCatalog,
  modelSelectionPolicyFor,
  recordedModelSelectionPolicy,
} from './model-selection-policy.js';

const policyEvent = (seq: number, allowedModels: string[]): SessionEvent =>
  ({
    type: 'subagent/model-selection-policy',
    seq,
    time: seq,
    data: { allowedModels },
  }) as SessionEvent;
const otherEvent = (seq: number): SessionEvent =>
  ({ type: 'turn/end', seq, time: seq, data: {} }) as unknown as SessionEvent;

const ON = { enabled: true, allowedModels: ['a', 'b'] };
const OFF = { enabled: false, allowedModels: [] };

describe('recordedModelSelectionPolicy', () => {
  it('沒有那顆事件是 undefined（＝關）；有就讀最後一顆', () => {
    expect(recordedModelSelectionPolicy([])).toBeUndefined();
    expect(recordedModelSelectionPolicy([otherEvent(0)])).toBeUndefined();
    expect(
      recordedModelSelectionPolicy([policyEvent(0, ['x']), otherEvent(1), policyEvent(2, ['y'])]),
    ).toEqual({ allowedModels: ['y'] });
  });
});

describe('modelSelectionPolicyFor', () => {
  it('沒有歷史的新會話：設定開著就取樣，關著就沒有', () => {
    expect(modelSelectionPolicyFor({ resumedEvents: undefined, setting: ON })).toEqual({
      allowedModels: ['a', 'b'],
    });
    expect(modelSelectionPolicyFor({ resumedEvents: undefined, setting: OFF })).toBeUndefined();
  });

  it('有歷史的：只讀日誌那一份，不看現在的設定', () => {
    // 開著時建的，設定後來關了：政策仍在。
    expect(
      modelSelectionPolicyFor({ resumedEvents: [policyEvent(0, ['x'])], setting: OFF }),
    ).toEqual({ allowedModels: ['x'] });
    // 設定後來改成別的清單：仍是日誌那份。
    expect(
      modelSelectionPolicyFor({ resumedEvents: [policyEvent(0, ['x'])], setting: ON }),
    ).toEqual({ allowedModels: ['x'] });
    // 關著時建的（沒有事件），設定後來打開：仍然沒有。
    expect(
      modelSelectionPolicyFor({ resumedEvents: [otherEvent(0)], setting: ON }),
    ).toBeUndefined();
    expect(modelSelectionPolicyFor({ resumedEvents: [], setting: ON })).toBeUndefined();
  });
});

describe('assertAllowedModelsInCatalog', () => {
  const catalog = [{ id: 'a' }, { id: 'b' }] as never;

  it('都在型錄裡：過；關著的不驗', () => {
    expect(() => assertAllowedModelsInCatalog(ON, catalog)).not.toThrow();
    expect(() =>
      assertAllowedModelsInCatalog({ enabled: false, allowedModels: ['ghost'] }, catalog),
    ).not.toThrow();
  });

  it('有型錄沒有的：拋，指名它與型錄有哪些', () => {
    expect(() =>
      assertAllowedModelsInCatalog({ enabled: true, allowedModels: ['a', 'ghost'] }, catalog),
    ).toThrow(/"ghost".*型錄有：a、b/);
  });
});
