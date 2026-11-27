/**
 * 基準任務的組裝 —— **跟 serve 一條 thread 組出來的是同一份**，CI 那半與尺寸比較那半共用。
 *
 * 量尺量的要是出貨的那一份，不然每張改提示詞的卡附的前後對照量的是別的東西（#3010）。
 * 所以這裡不自己列清單、不自己寫提示詞：
 *
 * - 清單是 {@link shippedServePlugins}（出貨層加 serve 專屬層），跟 `serve` 零設定時組出來的相同；
 * - 組 agent 走相容層的 `assembly.create`（`cordis-root.ts` 的 `compatLayer`，它呼叫 `createCliAgent`），serve 每條 thread
 *   也是這一條（`serve-run.ts` 的 `assembly.create`）；入口那一列的答題管道、有圍堵都照 serve 交；
 * - 私有可寫根與唯讀共用區是這一次的暫存目錄，核准政策不傳（serve 不傳，維持出廠值）。
 *
 * **這是唯一的定義點**，`runner.ts` 從這裡拿。
 *
 * ## 跟真的 serve 不同的地方
 *
 * - 模型是注進來的實例（CI 傳假模型、供應商比較傳真模型），用一列只回這顆實例的提供者掛在選擇列上（跟 `withScriptedModel` 同形），
 *   不走 `--live`。所以系統提示詞裡的型號標籤是假模型那一個（`SCRIPTED_MODEL_NAME`），不是真模型的 id。
 * - 沒有會話日誌、沒有落盤（見 `runner.ts` 檔頭）。serve 的出廠對話史來源是日誌（`log`），沒有日誌時組不起來
 *   （pre-step 找不到這次呼叫的日誌），所以這裡明著傳 `historySource: 'state'`，對話史走圖狀態。這只換「訊息串從哪來」，系統提示詞與
 *   工具清單不經它；`assembly.test.ts` 對著接了日誌的組裝比過系統提示詞逐位元組相同。
 *
 * @module
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentModel, PluginEntry } from '@nexus/core';
import { z } from 'zod';

import { createCordisRoot, entryApprovalChannel } from '../cordis-root.js';
import type { NexusAssembly } from '../cordis-root.js';
import { shippedServePlugins } from '../fixtures.js';
import type { ModelProviderPlugin } from '../model-provider.js';

type CliAgent = Awaited<ReturnType<NexusAssembly['create']>>;

/** 掛在選擇列上、回注進來那顆實例的提供者的 id。 */
const EVAL_MODEL_PROVIDER = 'eval-model';

/**
 * 把選擇列（`agent-default-model`）指到一列只回 `model` 的提供者，其餘一列不動、順序不變。
 *
 * @param plugins - 出貨清單。
 * @param model - 這一輪的受測模型。
 * @throws {Error} 清單上找不到選擇列——出貨清單改了名，這裡要跟著改，不要靜靜退回出貨的腳本。
 */
export function withModel(
  plugins: readonly PluginEntry[],
  model: AgentModel,
): readonly PluginEntry[] {
  let selected = false;
  const rows = plugins.map((entry) => {
    if (entry.id !== 'agent-default-model') return entry;
    selected = true;
    return { ...entry, config: { provider: EVAL_MODEL_PROVIDER } };
  });
  if (!selected) throw new Error('清單上沒有 agent-default-model 那一列，換不了模型');
  const provider: ModelProviderPlugin<Record<string, never>> = {
    name: 'eval-model',
    Config: z.strictObject({}),
    apply: () => {},
    createModel: () => model as BaseChatModel,
  };
  return [...rows, { id: EVAL_MODEL_PROVIDER, plugin: provider, config: {} }];
}

/** 組好的基準任務 agent。 */
export interface BenchmarkAgent {
  readonly agent: CliAgent['agent'];
  /** agent 手上的那顆模型（`bindTools` 之前的那一份），讀工具綁定用。 */
  readonly model: CliAgent['model'];
  /** 收掉 agent、樹與暫存目錄。 */
  dispose(): Promise<void>;
}

export interface OpenBenchmarkAgentOptions {
  /** 這一輪的受測模型。 */
  readonly model: AgentModel;
  /** 迴圈上限；省略即組裝點的預設。 */
  readonly recursionLimit?: number;
  /** 整份清單換成這一份（測試用：在出貨清單上動一句提示詞）；省略即出貨清單。 */
  readonly plugins?: readonly PluginEntry[];
}

/**
 * 組一個跟 serve 一條 thread 同形的 agent。
 *
 * 每次呼叫建一棵新的根、新的暫存目錄：虛擬 FS 與對話狀態都不跨題。
 *
 * @throws {Error} 出貨清單有列沒掛上，或組裝失敗；已經開的東西先收掉再拋。
 */
export async function openBenchmarkAgent(
  options: OpenBenchmarkAgentOptions,
): Promise<BenchmarkAgent> {
  const base = options.plugins ?? (await shippedServePlugins());
  const plugins = withModel(base, options.model);
  const scratch = await mkdtemp(join(tmpdir(), 'nexus-eval-'));
  const privateRoot = join(scratch, 'private');
  const sharedRoot = join(scratch, 'shared');
  const root = createCordisRoot({ channel: entryApprovalChannel(undefined), contained: true });
  let built: CliAgent | undefined;
  try {
    await mkdir(privateRoot);
    await mkdir(sharedRoot);
    const assembly = await root.boot('serve', { plugins, cwd: scratch });
    built = await assembly.create(
      {
        live: false,
        historySource: 'state',
        workspace: sharedRoot,
        workspaceRoot: privateRoot,
        sharedWorkspaceRoot: sharedRoot,
        ...(options.recursionLimit === undefined ? {} : { recursionLimit: options.recursionLimit }),
      },
      { plugins },
    );
  } catch (error) {
    await built?.dispose().catch(() => {});
    await root.dispose().catch(() => {});
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
  const opened = built;
  return {
    agent: opened.agent,
    model: opened.model,
    dispose: async () => {
      try {
        await opened.dispose();
      } finally {
        await root.dispose();
        await rm(scratch, { recursive: true, force: true });
      }
    },
  };
}
