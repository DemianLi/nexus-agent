/**
 * 選擇列怎麼選提供者（[#670](https://github.com/DemianLi/nexus-agent/issues/670)）。
 *
 * 產品路徑上的整條接線（patch → `runServe` → 工具回合）在 `serve-scripted-provider.test.ts`；這裡只管
 * `resolveDefaultModel` 自己的四個出口：出貨那一列、提供者列、找不到／停用、指到不是提供者的列。
 */

import type { PluginEntry } from '@nexus/core';
import { describe, expect, it } from 'vitest';

import { SHIPPED_PROVIDER, resolveDefaultModel } from './model-provider.js';
import { defaultModelPlugin } from './settings/default-model.js';
import { liveModelPlugin } from './settings/live-model.js';
import { scriptedModelPlugin } from './settings/scripted-model.js';

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
  it('選擇列沒寫或寫出貨的名字：用清單上那一列，不再有程式碼裡的退路', async () => {
    const shipped = scripted(SHIPPED_PROVIDER);
    for (const rows of [[shipped], [selection(SHIPPED_PROVIDER), shipped]]) {
      const reply = await resolveDefaultModel(rows).invoke('隨便');
      expect(reply.content).toBe('好。');
    }
  });

  it('清單上沒有出貨的那一列（被 patch 刪掉）而選擇列沒改：拋，指名選擇列與 cli-script，不悄悄退回別的腳本', () => {
    expect(() => resolveDefaultModel([])).toThrow(/agent-default-model.*"cli-script"/u);
    expect(() => resolveDefaultModel([selection(SHIPPED_PROVIDER)])).toThrow(/"cli-script"/u);
  });

  it('指到清單上的提供者列：用那一列驗過的設定建，出貨那一列不被用到', async () => {
    const model = resolveDefaultModel([
      selection('mine'),
      scripted(SHIPPED_PROVIDER, { config: { turns: [{ content: '出貨的。' }] } }),
      scripted('mine'),
    ]);
    const reply = await model.invoke('隨便');
    expect(reply.content).toBe('好。');
  });

  it('提供者列的設定一樣照 schema 驗：空腳本在建模型時當場拋', () => {
    const bad: PluginEntry = { ...scripted('mine'), config: { turns: [] } };
    expect(() => resolveDefaultModel([selection('mine'), bad])).toThrow(/mine/u);
  });

  it('指到的 id 找不到：拋，訊息指名選擇列、那個 id 與內建的名字', () => {
    expect(() => resolveDefaultModel([selection('ghost')])).toThrow(
      /agent-default-model.*"ghost".*cli-script/u,
    );
  });

  it('指到的列被停用：拋，而且說是停用了', () => {
    expect(() =>
      resolveDefaultModel([selection('mine'), scripted('mine', { disabled: true })]),
    ).toThrow(/停用/u);
  });

  it('指到的列存在但不是提供者：拋，不會悄悄退回內建', () => {
    const notProvider: PluginEntry = { id: 'live-model', plugin: liveModelPlugin as never };
    expect(() => resolveDefaultModel([selection('live-model'), notProvider])).toThrow(
      /不是模型提供者/u,
    );
  });
});
