import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { installLaunchProxy } from '../http-proxy-boot.js';
import { loadLiveLaunchEnv, DEFAULT_LIVE_MODEL_ID } from '../live-model.js';
import type { CredentialService } from '../credentials.js';
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

/** 真模型路徑的啟動：載入環境、裝對外代理（#746），回憑證服務。這支腳本跑到行程結束，代理不另收尾。 */
async function launchLive(): Promise<CredentialService> {
  const { credentials, launchEnv } = loadLiveLaunchEnv();
  await installLaunchProxy(launchEnv, (message) => console.error(message));
  return credentials;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  const prompt =
    args.filter((arg) => arg !== '--live').join(' ') || '記錄 Phase 0 的結論並寫成檔案。';

  const { agent } = live
    ? await createLiveSpikeAgent(await launchLive())
    : await createSpikeAgent();

  console.log(`模型：${live ? DEFAULT_LIVE_MODEL_ID : '假模型（ScriptedChatModel）'}`);
  console.log(`> ${prompt}\n`);

  let files: Record<string, unknown> = {};

  // 一次 run 收兩種事件：updates 給人看過程，values 拿最終狀態。
  // 假模型的腳本只有兩輪，跑第二次就會用完，所以不能 stream 完再 invoke 一次。
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
