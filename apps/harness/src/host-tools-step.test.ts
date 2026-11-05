/**
 * 宿主頁工具在工具那一側的一步（{@link hostToolsToolStep}）：只接 root 叫、宣告裡有的 `page__<name>`，換上當場轉出來的工具。
 * 兩個 loop 都走這一步；端到端在 `host-tools-wire.test.ts`。
 */

import { BACKGROUND_SESSION_CONFIG_KEY } from '@nexus/core';
import type { ToolCallSite, ToolCallSubstitute } from '@nexus/core';
import type { NexusTool } from '@nexus/tools';
import type { HostToolDeclaration } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { createHostToolsSlot, hostToolsToolStep } from './host-tools.js';

const focus: HostToolDeclaration = {
  name: 'focus_device',
  description: '把鏡頭轉到指定設備',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

const ROOT = { checkpoint_ns: 'tools:call_1' };
const FOREGROUND_CHILD = { checkpoint_ns: 'tools:call_0|tools:call_1' };
const BACKGROUND_CHILD = { [BACKGROUND_SESSION_CONFIG_KEY]: 'bg-1' };

function site(name: string, configurable: unknown): ToolCallSite {
  return {
    callId: 'call_1',
    name,
    args: { id: 'P-101' },
    tool: undefined,
    state: {},
    configurable,
    signal: undefined,
  };
}

/** 跑一次這一步，回傳交給內層的那一份替換（`null`＝沒往內交）。 */
async function substituteOf(
  name: string,
  configurable: unknown,
): Promise<ToolCallSubstitute | undefined | null> {
  const slot = createHostToolsSlot();
  slot.current = [focus];
  const step = hostToolsToolStep(slot, (tool: NexusTool) => ({ converted: tool.name }));
  let seen: ToolCallSubstitute | undefined | null = null;
  await step(site(name, configurable), (substitute) => {
    seen = substitute;
    return Promise.resolve('結果');
  });
  return seen;
}

describe('hostToolsToolStep', () => {
  it('root 叫宣告裡的工具：換上轉出來的那顆', async () => {
    expect(await substituteOf('page__focus_device', ROOT)).toEqual({
      tool: { converted: 'page__focus_device' },
    });
  });

  it('子代理叫（前景與背景）：原樣往內交，不換工具', async () => {
    expect(await substituteOf('page__focus_device', FOREGROUND_CHILD)).toBeUndefined();
    expect(await substituteOf('page__focus_device', BACKGROUND_CHILD)).toBeUndefined();
  });

  it('宣告裡沒有、或不是 page__ 開頭：原樣往內交', async () => {
    expect(await substituteOf('page__highlight_device', ROOT)).toBeUndefined();
    expect(await substituteOf('focus_device', ROOT)).toBeUndefined();
  });
});
