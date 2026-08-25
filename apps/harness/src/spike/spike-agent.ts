import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool } from '@langchain/core/tools';
import type { NexusPlugin } from '@nexus/core';
import { z } from 'zod';
import { createNexusAgent } from '../agent-factory.js';
import { ScriptedChatModel } from '../scripted-model.js';
import type { ScriptedTurn } from '../scripted-model.js';
import { createLiveModel } from '../live-model.js';

/** spike 的自訂工具：只把輸入回聲成一句話，用來證明工具真的被基座呼叫到。 */
export const recordFinding = tool(({ topic, detail }) => `已記錄「${topic}」：${detail}`, {
  name: 'record_finding',
  description: '記錄一則技術驗證結論。',
  schema: z.object({
    topic: z.string().describe('結論的主題'),
    detail: z.string().describe('結論內容'),
  }),
});

/**
 * Phase 0 要跑通的那一條路：呼叫自訂工具 → 寫虛擬檔案 → 回覆。
 *
 * **兩個工具在同一輪，而且那一輪沒有文字內容**——這是照真模型的實際行為寫的，不是
 * 假模型的表達限制（[#51](https://github.com/DemianLi/nexus-agent/issues/51)）。
 * [PR #50](https://github.com/DemianLi/nexus-agent/pull/50) 第一次用真實供應商跑這條路
 * 時的輸出是：
 *
 * ```
 * [model_request/model] (呼叫工具)
 * [tools/record_finding] 已記錄「Phase 0 驗證結論」：……
 * [tools/write_file] Successfully wrote to '/findings.md'
 * [model_request/model] 已完成 Phase 0 的驗證，流程如下：……
 * ```
 *
 * 原本的腳本寫成三輪、每輪一個工具，於是 `streamMode: 'updates'` 的**輪數與每輪的
 * 工具數都跟真模型對不上**。假模型是 repo 裡唯一能在 CI 跑完整 agent 迴圈的東西
 * （[#31](https://github.com/DemianLi/nexus-agent/issues/31)：CI 不放模型 secret），
 * 靠它建立的每一條端到端驗收，證明力都取決於它有多忠實。
 *
 * **這份腳本對齊的是一個模型的一次記錄。** 那次執行沒辦法重跑複驗——接線用的模型
 * 目前在端點上不回應（[#57](https://github.com/DemianLi/nexus-agent/issues/57)）。
 * 下一次分歧由 [#32](https://github.com/DemianLi/nexus-agent/issues/32) 的升版檢查
 * 清單接住，不是由這份腳本本身。
 */
export const SPIKE_SCRIPT: readonly ScriptedTurn[] = [
  {
    // 真模型那一輪只有 tool_calls、沒有文字。空內容照樣要走得通：CLI 印的是
    // `message.text.trim() || '(呼叫工具)'`，而那個 fallback 只有在這裡才被驗到。
    content: '',
    toolCalls: [
      {
        name: 'record_finding',
        args: {
          topic: 'deepagents 1.13.1 接線',
          detail: 'createDeepAgent 收 backend 單數、interruptOn 是 Record。',
        },
      },
      {
        name: 'write_file',
        args: {
          file_path: '/findings.md',
          content: '# Phase 0\n\ndeepagents 1.13.1 在 in-memory backend 上跑通。\n',
        },
      },
    ],
  },
  { content: '已記錄並寫入 /findings.md。' },
];

export interface SpikeAgentOptions {
  readonly script?: readonly ScriptedTurn[];
}

const SYSTEM_PROMPT = [
  '你是 nexus-agent 的 Phase 0 驗證用 agent。',
  '收到請求時，先用 record_finding 記下結論，再用 write_file 把結論寫進 /findings.md，最後回覆使用者。',
  '工具要真的呼叫，不要只在文字裡描述你打算做什麼。',
].join('\n');

/** 把 spike 的自訂工具包成一個 plugin —— 組裝點只收 plugin 清單。 */
const spikePlugin: NexusPlugin = {
  name: 'spike',
  apply: (registry) => void registry.tools.register(recordFinding),
};

/**
 * 兩條路徑共用的組裝。
 *
 * **走 `createNexusAgent`，不自己呼叫 `createDeepAgent`**：Phase 0 當時它是自己組的，
 * Phase 1 有了組裝點之後留著第二條組裝路徑只會讓 `--live` 驗的東西跟真的會出貨的東西
 * 分岔。default backend 由組裝點補（`StateBackend`），與原本的組裝一致。
 */
function buildAgent(model: BaseChatModel) {
  return createNexusAgent({ model, systemPrompt: SYSTEM_PROMPT, plugins: [spikePlugin] });
}

/**
 * 最小可跑的 deep agent，用寫死腳本的假模型。
 *
 * 驗的是基座的組裝與接線，不是模型品質。假模型不是鷹架而是**長期測試基座**
 * （issue #31）—— CI 不放模型 secret，所以這是唯一能在 CI 上跑完整 agent 迴圈的路徑。
 */
export async function createSpikeAgent(options: SpikeAgentOptions = {}) {
  const model = new ScriptedChatModel({ turns: options.script ?? SPIKE_SCRIPT });
  return { agent: await buildAgent(model), model };
}

/**
 * 同一個 agent，換成真實供應商的 model（issue #31 的一次性人工驗證用）。
 *
 * **不進 CI** —— 它需要 API key 而且會花錢。缺少 key 時 `createLiveModel` 直接失敗。
 */
export async function createLiveSpikeAgent() {
  const model = createLiveModel();
  return { agent: await buildAgent(model), model };
}
