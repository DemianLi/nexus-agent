/**
 * **關掉用量記錄器之後，日誌裡真的沒有 `model/usage`**——
 * [#456](https://github.com/DemianLi/nexus-agent/issues/456) 第四刀的行為判準。
 *
 * ## 為什麼這條非在 harness 這一層不可
 *
 * `fold.test.ts` 那一組量的是「stack 裡有沒有那一顆」，而那在這一顆身上**不夠**：它寫不寫得
 * 進去還取決於 `sessions.forCall()` 答不答得出來，而
 * [`model-usage.ts`](../../../packages/nexus-core/src/model-usage.ts) 的檔頭明寫
 * **`not-attached` 是常態不是異常**——`eval/runner.ts`、`spike` 與絕大多數測試的組裝都不接
 * 日誌。所以一條「關掉之後日誌裡沒有」的測試，在沒接 `attachSession` 的組裝上**兩邊都是空的**，
 * 綠得毫無意義。
 *
 * 因此這裡的每一條都配一個**用同一組裝、同一份腳本量出來的正對照**：先證明開著的時候真的
 * 記得進去，「關掉之後是 0」才有東西可講。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`，它只在腳本明著給 `usage` 時才帶
 * `usage_metadata`——假模型不會自己編那個數字。
 */

import { SessionRegistry } from '@nexus/core';
import { modelUsagePlugin } from '@nexus/core/model-usage';
import type { ModelUsage, PluginEntry, SessionEvent } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

const ROOT_ID = 'model-usage-root';

/** 腳本只有一輪，而且明著報了用量——沒有這一格，開著的那一邊也會是空的。 */
const TURNS = [{ content: '好。', usage: { inputTokens: 11, outputTokens: 7 } }];

function usagesOf(events: readonly SessionEvent[]): ModelUsage[] {
  return events
    .filter((event) => event.type === 'model/usage')
    .map((event) => event.data as ModelUsage);
}

/**
 * 跑一輪對話，回傳 root 那份日誌裡的用量紀錄。
 *
 * @param options - 條目清單，以及要不要明著傳 `modelUsage`。
 * @returns root 那份日誌裡的每一筆用量。
 */
async function run(
  options: { plugins?: readonly PluginEntry[]; modelUsage?: boolean } = {},
): Promise<ModelUsage[]> {
  const { agent, attachSession, dispose } = await createNexusAgent({
    model: new ScriptedChatModel({ turns: TURNS }),
    plugins: [...(options.plugins ?? [])],
    summarization: false,
    observationPolicy: false,
    ...(options.modelUsage !== undefined && { modelUsage: options.modelUsage }),
  });
  const sessions = new SessionRegistry(ROOT_ID);
  const detach = attachSession(sessions);
  try {
    await agent.invoke(toAgentInvocation('一句話。'), {
      configurable: { thread_id: ROOT_ID },
    });
  } finally {
    detach();
    await dispose();
  }
  const root = sessions.list().find((entry) => entry.address.kind === 'root');
  return usagesOf(root?.log.events ?? []);
}

describe('用量記錄器的條目，量在日誌上', () => {
  /**
   * **正對照，而且它是這一整個檔案的前提。** 這一條一旦紅了，底下每一條「關掉之後是 0」
   * 都變成空談——它們會照樣綠，因為兩邊都是空的。
   */
  it('條目不在清單上（＝今天的預設）：模型報了用量就記得進去', async () => {
    expect(await run()).toEqual([{ inputTokens: 11, outputTokens: 7, totalTokens: 18 }]);
  });

  it('條目在清單上、沒被關：跟上一條一模一樣（它不帶設定，所以帶不了差別）', async () => {
    expect(await run({ plugins: [{ plugin: modelUsagePlugin }] })).toHaveLength(1);
  });

  it('`disabled: true` 之後一筆都沒有——不是 0，是整顆事件不存在', async () => {
    expect(await run({ plugins: [{ plugin: modelUsagePlugin, disabled: true }] })).toEqual([]);
  });

  it('組裝點明著傳 `false` 也一樣沒有', async () => {
    expect(await run({ modelUsage: false })).toEqual([]);
  });

  it('組裝點明著傳 `true` 贏過條目的 `disabled: true`', async () => {
    expect(
      await run({ plugins: [{ plugin: modelUsagePlugin, disabled: true }], modelUsage: true }),
    ).toHaveLength(1);
  });

  /**
   * **關掉的射程只到這一顆。** 用量與模型呼叫起訖是相鄰的兩層（`foldMiddleware` 裡緊貼著），
   * 而它們讀的是同一個 `sessions` 通道——把 gate 寫在錯的變數上會把隔壁一起拿掉，而上面那幾條
   * 一條都不會紅。
   */
  it('關掉它不會連帶拿掉模型呼叫的起訖紀錄', async () => {
    const { agent, attachSession, dispose } = await createNexusAgent({
      model: new ScriptedChatModel({ turns: TURNS }),
      plugins: [{ plugin: modelUsagePlugin, disabled: true }],
      summarization: false,
      observationPolicy: false,
    });
    const sessions = new SessionRegistry(ROOT_ID);
    const detach = attachSession(sessions);
    try {
      await agent.invoke(toAgentInvocation('一句話。'), {
        configurable: { thread_id: ROOT_ID },
      });
    } finally {
      detach();
      await dispose();
    }
    const events = sessions.list().find((entry) => entry.address.kind === 'root')?.log.events ?? [];
    expect(usagesOf(events)).toEqual([]);
    expect(events.filter((event) => event.type === 'model/start')).toHaveLength(1);
  });
});
