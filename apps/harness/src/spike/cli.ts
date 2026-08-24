import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { createSpikeAgent } from './spike-agent.js';

/**
 * Phase 0 的手動驗證入口：
 *
 *   pnpm --filter @nexus/harness run spike "記錄 Phase 0 的結論並寫成檔案。"
 *
 * 模型是寫死腳本的假模型（本機沒有模型 API key），所以指令內容不影響 agent
 * 的決策；它驗的是 CLI → agent 迴圈 → 工具 → 虛擬檔案 → 回覆這條線接得起來。
 */
async function main(): Promise<void> {
  const prompt = process.argv.slice(2).join(' ') || '記錄 Phase 0 的結論並寫成檔案。';
  const { agent } = createSpikeAgent();

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
