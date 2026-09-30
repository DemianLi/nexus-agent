/**
 * `compileSubagent` 遇到會動子代理組成的 harness profile 就拋（[#825](https://github.com/DemianLi/nexus-agent/issues/825)）。
 *
 * profile 的槓桿基座在 `createSubAgent` 之外套用，自編的圖不套用；靜靜略過的話背景子代理與一次性子代理就是兩個不同的東西。
 * 沒有辦法讓內建模型解出這樣的 profile 又不打真的端點，所以把 `describeHarnessProfileEffects` 換成會回傳槓桿的版本；
 * 組裝點的「宣告」檢查（`assertHarnessProfileDeclared`）用真的，它在模組內部呼叫自己，不受這個替換影響。
 */

import { MemorySaver } from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vitest';

import type { HarnessProfileEffects } from './harness-profile.js';
import { NO_HARNESS_PROFILE_EFFECTS } from './harness-profile.js';

const effects = vi.hoisted(() => ({ current: undefined as HarnessProfileEffects | undefined }));

vi.mock('./harness-profile.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./harness-profile.js')>();
  return {
    ...original,
    describeHarnessProfileEffects: (model: never) =>
      effects.current ?? original.describeHarnessProfileEffects(model),
  };
});

const { createNexusAgent } = await import('./agent-factory.js');
const { shippedPlugins } = await import('./fixtures.js');
const { ScriptedChatModel } = await import('./scripted-model.js');

async function assemble() {
  return createNexusAgent({
    model: new ScriptedChatModel({ turns: [] }),
    checkpointer: new MemorySaver(),
    plugins: [...(await shippedPlugins())],
  });
}

describe('compileSubagent 與 harness profile', () => {
  it('profile 什麼都不做：編得出來', async () => {
    effects.current = undefined;
    const built = await assemble();
    try {
      expect(() => built.compileSubagent('general-purpose', new MemorySaver())).not.toThrow();
    } finally {
      await built.dispose();
    }
  });

  for (const [label, override] of [
    ['拿掉工具', { excludedTools: ['execute'] }],
    ['移除 middleware', { excludedMiddleware: ['SummarizationMiddleware'] }],
    ['加 middleware', { extraMiddleware: ['<factory>'] }],
  ] as const) {
    it(`profile ${label}：拋，訊息指名是哪一根槓桿`, async () => {
      const built = await assemble();
      try {
        effects.current = { ...NO_HARNESS_PROFILE_EFFECTS, ...override };
        expect(() => built.compileSubagent('general-purpose', new MemorySaver())).toThrow(
          new RegExp(label, 'u'),
        );
      } finally {
        effects.current = undefined;
        await built.dispose();
      }
    });
  }

  it('只改系統提示詞的 profile 不影響背景圖（基座對子代理的系統提示詞不套用）', async () => {
    const built = await assemble();
    try {
      effects.current = { ...NO_HARNESS_PROFILE_EFFECTS, systemPromptSuffix: true };
      expect(() => built.compileSubagent('general-purpose', new MemorySaver())).not.toThrow();
    } finally {
      effects.current = undefined;
      await built.dispose();
    }
  });
});
