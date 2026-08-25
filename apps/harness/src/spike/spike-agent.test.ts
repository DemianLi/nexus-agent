import { HumanMessage } from '@langchain/core/messages';
import type { AIMessageChunk } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { createSpikeAgent } from './spike-agent.js';

describe('Phase 0 spike：最小 deep agent', () => {
  it('一個指令跑完「呼叫自訂工具 → 寫虛擬檔案 → 回覆」', async () => {
    const { agent, model } = await createSpikeAgent();

    const result = await agent.invoke({
      messages: [new HumanMessage('記錄 Phase 0 的結論並寫成檔案。')],
    });

    const toolMessages = result.messages.filter((message) => message.getType() === 'tool');
    expect(toolMessages.map((message) => message.name)).toEqual(['record_finding', 'write_file']);

    expect(toolMessages[0]?.content).toContain('已記錄');
    expect(Object.keys(result.files ?? {})).toContain('/findings.md');
    expect(result.messages.at(-1)?.text).toBe('已記錄並寫入 /findings.md。');

    // 基座確實把自訂工具與內建檔案工具一起交給了模型。
    expect(model.boundToolNames).toContain('record_finding');
    expect(model.boundToolNames).toContain('write_file');

    // spike 的 system prompt 經組裝點到得了模型。假模型不看它，但 `--live` 那條路徑
    // 靠它才知道要真的呼叫工具而不是描述自己打算做什麼。
    expect(model.lastPrompt.map((message) => message.text).join('\n')).toContain(
      'nexus-agent 的 Phase 0 驗證用 agent',
    );
  });

  it('streaming 會逐步吐出 agent 的狀態更新', async () => {
    const { agent } = await createSpikeAgent();

    const nodes: string[] = [];
    for await (const chunk of await agent.stream(
      { messages: [new HumanMessage('跑一次。')] },
      { streamMode: 'updates' },
    )) {
      nodes.push(...Object.keys(chunk as Record<string, unknown>));
    }

    expect(nodes.length).toBeGreaterThan(1);
    expect(nodes).toContain('tools');
  });

  it("streamMode: 'messages' 收得到逐 token 的 chunk", async () => {
    const { agent } = await createSpikeAgent();

    const aiChunks: string[] = [];
    for await (const [message] of (await agent.stream(
      { messages: [new HumanMessage('跑一次。')] },
      { streamMode: 'messages' },
    )) as AsyncIterable<[AIMessageChunk, unknown]>) {
      if (message.getType() === 'ai') {
        aiChunks.push(message.text);
      }
    }

    // 三輪回覆共 38 個字元；聚合成整段訊息的話只會有 3 個 chunk。
    expect(aiChunks.length).toBeGreaterThan(10);
    expect(aiChunks.join('')).toContain('已記錄並寫入 /findings.md。');
  });
});
