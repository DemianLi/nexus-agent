/**
 * 選擇列怎麼選提供者（[#670](https://github.com/DemianLi/nexus-agent/issues/670)）。
 *
 * 產品路徑上的整條接線（patch → `runServe` → 工具回合）在 `serve-scripted-provider.test.ts`；這裡只管
 * `resolveDefaultModel` 自己的四個出口：內建、提供者列、找不到／停用、指到不是提供者的列。
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { PluginEntry } from '@nexus/core';
import { describe, expect, it } from 'vitest';

import { BUILTIN_PROVIDER, resolveDefaultModel } from './model-provider.js';
import { defaultModelPlugin } from './settings/default-model.js';
import { liveModelPlugin } from './settings/live-model.js';
import { scriptedModelPlugin } from './settings/scripted-model.js';

const BUILTIN = { builtin: true } as unknown as BaseChatModel;

const selection = (provider: string): PluginEntry => ({
  id: 'agent-default-model',
  plugin: defaultModelPlugin as never,
  config: { provider },
});

const scripted = (id: string, extra: Partial<PluginEntry> = {}): PluginEntry => ({
  id,
  plugin: scriptedModelPlugin as never,
  config: { turns: [{ content: '好。' }] },
  ...extra,
});

describe('resolveDefaultModel', () => {
  it('選擇列沒寫或寫內建的名字：用內建那份，不需要清單上有提供者的列', () => {
    expect(resolveDefaultModel([], () => BUILTIN)).toBe(BUILTIN);
    expect(resolveDefaultModel([selection(BUILTIN_PROVIDER)], () => BUILTIN)).toBe(BUILTIN);
  });

  it('指到清單上的提供者列：用那一列驗過的設定建，內建的不被呼叫', async () => {
    let builtinCalls = 0;
    const model = resolveDefaultModel([selection('mine'), scripted('mine')], () => {
      builtinCalls += 1;
      return BUILTIN;
    });
    expect(builtinCalls).toBe(0);
    expect(model).not.toBe(BUILTIN);
    const reply = await model.invoke('隨便');
    expect(reply.content).toBe('好。');
  });

  it('提供者列的設定一樣照 schema 驗：空腳本在建模型時當場拋', () => {
    const bad: PluginEntry = { ...scripted('mine'), config: { turns: [] } };
    expect(() => resolveDefaultModel([selection('mine'), bad], () => BUILTIN)).toThrow(/mine/u);
  });

  it('指到的 id 找不到：拋，訊息指名選擇列、那個 id 與內建的名字', () => {
    expect(() => resolveDefaultModel([selection('ghost')], () => BUILTIN)).toThrow(
      /agent-default-model.*"ghost".*cli-script/u,
    );
  });

  it('指到的列被停用：拋，而且說是停用了', () => {
    expect(() =>
      resolveDefaultModel([selection('mine'), scripted('mine', { disabled: true })], () => BUILTIN),
    ).toThrow(/停用/u);
  });

  it('指到的列存在但不是提供者：拋，不會悄悄退回內建', () => {
    const notProvider: PluginEntry = { id: 'live-model', plugin: liveModelPlugin as never };
    expect(() =>
      resolveDefaultModel([selection('live-model'), notProvider], () => BUILTIN),
    ).toThrow(/不是模型提供者/u);
  });
});
