import { resolve } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { LIVE_API_KEY_ENV, LIVE_MODEL_ID } from './live-model.js';
import { createLiveSpikeAgent, createSpikeAgent } from './spike-agent.js';

/**
 * Phase 0 的手動驗證入口。
 *
 *   pnpm --filter @nexus/harness run spike "記錄 Phase 0 的結論並寫成檔案。"
 *   pnpm --filter @nexus/harness run spike:live "記錄 Phase 0 的結論並寫成檔案。"
 *
 * 預設是寫死腳本的假模型：不需要任何 API key、可重複跑，驗的是 CLI → agent 迴圈
 * → 工具 → 虛擬檔案 → 回覆這條線接得起來（指令內容不影響它的決策）。
 *
 * `--live` 換成真實供應商（issue #31 的一次性人工驗證）。那條路徑會花錢，
 * **不進 CI** —— CI 不放模型 secret。
 */

/** 專案根目錄的 `.env`（已被 .gitignore 排除）。`--live` 才需要。 */
const ENV_FILE = resolve(import.meta.dirname, '../../../../.env');

/**
 * key 只從環境變數讀。`.env` 只是填充環境變數的一種方式，不是 fallback：
 * 讀不到檔案就繼續走，`createLiveModel` 會因為缺變數而失敗並說明缺哪一個。
 */
function loadEnvFileIfNeeded(): void {
  if (process.env[LIVE_API_KEY_ENV]) return;
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    // 沒有 .env 就靠 shell 裡既有的環境變數。
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  const prompt =
    args.filter((arg) => arg !== '--live').join(' ') || '記錄 Phase 0 的結論並寫成檔案。';

  if (live) loadEnvFileIfNeeded();

  const { agent } = live ? createLiveSpikeAgent() : createSpikeAgent();

  console.log(`模型：${live ? LIVE_MODEL_ID : '假模型（ScriptedChatModel）'}`);
  console.log(`> ${prompt}\n`);

  let files: Record<string, unknown> = {};

  // 一次 run 收兩種事件：updates 給人看過程，values 拿最終狀態。
  // 假模型的腳本只有三輪，跑第二次就會用完，所以不能 stream 完再 invoke 一次。
  for await (const [mode, payload] of await agent.stream(
    { messages: [new HumanMessage(prompt)] },
    { streamMode: ['updates', 'values'] },
  )) {
    if (mode === 'values') {
      files = (payload as { files?: Record<string, unknown> }).files ?? {};
      continue;
    }

    for (const [node, update] of Object.entries(payload as Record<string, unknown>)) {
      const messages = (update as { messages?: BaseMessage[] }).messages ?? [];
      for (const message of messages) {
        const label = message.name ? `${node}/${message.name}` : node;
        console.log(`[${label}] ${message.text.trim() || '(呼叫工具)'}`);
      }
    }
  }

  console.log('\n虛擬檔案系統：');
  for (const path of Object.keys(files)) {
    console.log(`  ${path}`);
  }
}

await main();
