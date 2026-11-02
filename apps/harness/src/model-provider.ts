/**
 * **模型提供者由清單上的列選**（[#670](https://github.com/DemianLi/nexus-agent/issues/670)）。
 *
 * 以前 `createCliModel` 在一個 `if` 裡二選一：沒帶 `--live` 是寫死的 `CLI_SCRIPT`，帶了是 `live-model`
 * 那一列的連線值。想在產品組裝上跑一條自訂的工具回合只能自己起一台 OpenAI 相容的假端點，或手抄一份組裝根——
 * 而手抄的組裝跟產品組裝之間沒有任何東西保證同形。
 *
 * 現在的形狀照 dsh：模型的選擇是一列（`agent-default-model`，dsh `packages/bundle/base/cordis.patch.yml:82-86`），
 * 提供者各是一列；測試用 patch `insert` 一列腳本提供者、把選擇列指過去，同 dsh
 * `apps/cli/tests/profiles/headless/tests/source-tool.built.e2e.ts:36-42`。
 *
 * ## 偏離登記：提供者不在 `apply` 裡註冊進服務，退到起動期讀
 *
 * dsh 的提供者在 `apply` 裡註冊進 `ctx.llm`，選擇在之後解析。我們的組裝點在 `loadPlugins` **之前**就要有
 * 模型：`createNexusAgent` 一開頭用它比對 harness profile、算系統提示詞裡的型號標籤。這是我們自己的載入順序，
 * 不是 deepagents 的限制——可以搬，但那是另一張卡的範圍；這張退到最接近的載體：**提供者是只講設定的列**
 * （同 `live-model`，#529 登記的起動期讀），多一格 {@link ModelProviderPlugin.createModel}，由選擇列指到它時
 * 用驗過的 config 建出模型。
 *
 * ## `--live` 仍是進 live 的唯一閘門
 *
 * 帶了 `--live` 時走 `live-model`，**不看選擇列**。這是啟動順序推出來的：`runCli` 與 `runServe` 在載入清單**之前**
 * 就依 `--live` 讀 `.env`、裝代理（#730、#746），選擇列若能把人帶進 live，就會在沒走過那一段的情況下拿不到 key。
 * 選擇列只在沒帶 `--live` 時，於 in-process 的提供者之間選。「改啟動順序，讓清單決定 live」是另一個決定。
 *
 * ## 出貨的 `cli-script` 是清單上的一列

出貨的預設提供者是 `cordis.yml` 上 id 為 `cli-script` 的那一列腳本提供者（`#settings/scripted-model`），腳本就是它的 config：
`--dump-config` 看得到假模型，組裝讀的和印出來的是同一份資料，不再有一份只存在程式碼裡的腳本。選擇列的預設值
{@link SHIPPED_PROVIDER} 指它。拿 patch 把那一列關掉或刪掉、選擇列卻沒改，就是載入期的明確錯誤，不會悄悄退回別的腳本。
**標題那一顆不從這裡拿**：標題只在帶 `--live` 時掛（#658），假模型的腳本是一格一格吃的，多出來的標題呼叫會吃掉主回覆的那一格。
 *
 * @module
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { parseEntryConfig } from '@nexus/core';
import type { NexusPlugin, PluginEntry } from '@nexus/core';

import { defaultModelPlugin } from './settings/default-model.js';
import { startupSetting } from './settings/startup.js';

/** 選擇列的預設值：出貨清單上那一列腳本提供者的 `id`（`cordis.yml` 的 `cli-script`）。 */
export const SHIPPED_PROVIDER = 'cli-script';

/**
 * 一個模型提供者：只講設定的列（`apply` 是空的），外加一支用驗過的設定建出模型的函式。
 *
 * 型別住在這裡而不是 core：消費者只有 harness 的組裝根。
 */
export interface ModelProviderPlugin<TConfig = void> extends NexusPlugin<TConfig> {
  readonly createModel: (config: TConfig) => BaseChatModel;
}

function isModelProvider(plugin: NexusPlugin<unknown>): plugin is ModelProviderPlugin<unknown> {
  return typeof (plugin as { createModel?: unknown }).createModel === 'function';
}

/**
 * 沒帶 `--live` 時這一次要用的模型：選擇列指到哪個提供者就用哪個。
 *
 * @param plugins - 這一次解析好的條目清單。
 * @returns 選到的提供者建出來的模型。
 * @throws {Error} 選擇列指到的 id 不在清單上、已停用、或那一列不是提供者；訊息指名選擇列與該 id。
 */
export function resolveDefaultModel(plugins: readonly PluginEntry[]): BaseChatModel {
  const { provider } = startupSetting(plugins, defaultModelPlugin);
  const entry = plugins.find((candidate) => candidate.id === provider);
  if (entry === undefined || entry.disabled === true) {
    throw new Error(
      `agent-default-model 的 provider "${provider}" 在清單上找不到${entry === undefined ? '' : '（那一列被停用了）'}。` +
        `出貨的是 "${SHIPPED_PROVIDER}"（腳本提供者，在 cordis.yml 上）；要用別的，先在清單上 insert 一列提供者，id 就是這裡寫的名字。`,
    );
  }
  if (!isModelProvider(entry.plugin)) {
    throw new Error(
      `agent-default-model 的 provider "${provider}" 指到的那一列（${entry.plugin.name}）不是模型提供者。`,
    );
  }
  const config = parseEntryConfig(entry, entry.plugin, { id: provider, name: entry.plugin.name });
  return entry.plugin.createModel(config);
}
