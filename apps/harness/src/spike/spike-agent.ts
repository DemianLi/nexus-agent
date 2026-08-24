import { tool } from '@langchain/core/tools';
import { createDeepAgent, StateBackend } from 'deepagents';
import { z } from 'zod';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';

/** spike 的自訂工具：只把輸入回聲成一句話，用來證明工具真的被基座呼叫到。 */
export const recordFinding = tool(({ topic, detail }) => `已記錄「${topic}」：${detail}`, {
  name: 'record_finding',
  description: '記錄一則技術驗證結論。',
  schema: z.object({
    topic: z.string().describe('結論的主題'),
    detail: z.string().describe('結論內容'),
  }),
});

/** Phase 0 要跑通的那一條路：呼叫自訂工具 → 寫虛擬檔案 → 回覆。 */
export const SPIKE_SCRIPT: readonly ScriptedTurn[] = [
  {
    content: '先把結論記下來。',
    toolCalls: [
      {
        name: 'record_finding',
        args: {
          topic: 'deepagents 1.13.1 接線',
          detail: 'createDeepAgent 收 backend 單數、interruptOn 是 Record。',
        },
      },
    ],
  },
  {
    content: '再寫進虛擬檔案。',
    toolCalls: [
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

/**
 * 最小可跑的 deep agent：in-memory backend（StateBackend）＋ 一個自訂工具。
 *
 * 模型是寫死腳本的假模型 —— 這裡驗的是基座的組裝與接線，不是模型品質。
 */
export function createSpikeAgent(options: SpikeAgentOptions = {}) {
  const model = new ScriptedChatModel({ turns: options.script ?? SPIKE_SCRIPT });

  const agent = createDeepAgent({
    model,
    tools: [recordFinding],
    backend: new StateBackend(),
    systemPrompt: '你是 nexus-agent 的 Phase 0 驗證用 agent。',
  });

  return { agent, model };
}
