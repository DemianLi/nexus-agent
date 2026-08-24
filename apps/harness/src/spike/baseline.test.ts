import { HumanMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { createDeepAgent, StateBackend } from 'deepagents';
import { describe, expect, it } from 'vitest';
import { ScriptedChatModel } from './scripted-model.js';
import { recordFinding } from './spike-agent.js';

/**
 * 升版防護：斷言 deepagents 擴充點的「形狀事實」（issue #27 查到的那幾條）。
 *
 * 這些不是在測第三方的功能好不好，是在測「基座還是不是我們以為的那個形狀」。
 * 型別檢查擋不住執行期的參數改名與預設值翻轉，這組測試會在升版時當場爆。
 * 範圍與斷言清單的正式收斂在 issue #32。
 */
describe('deepagents 1.13.x 基座形狀', () => {
  it('backend 是單數，且 StateBackend 下註冊的內建工具是這七個加 task', async () => {
    const model = new ScriptedChatModel({ turns: [{ content: '好。' }] });
    const agent = createDeepAgent({
      model,
      backend: new StateBackend(),
    });

    await agent.invoke({ messages: [new HumanMessage('嗨。')] });

    expect(model.boundToolNames).toEqual([
      'ls',
      'read_file',
      'write_file',
      'edit_file',
      'delete',
      'glob',
      'grep',
      // execute 在 FILESYSTEM_TOOL_NAMES 裡，但 StateBackend 沒有 shell，所以不註冊。
      // task 來自 subagent middleware，不是檔案工具。
      'task',
    ]);
  });

  it('permissions 無命中則 allow（寬鬆預設）', async () => {
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '寫兩個檔案。',
          toolCalls: [
            { name: 'write_file', args: { file_path: '/secrets/token', content: 'x' } },
            { name: 'write_file', args: { file_path: '/notes.md', content: 'y' } },
          ],
        },
        { content: '寫完了。' },
      ],
    });

    const agent = createDeepAgent({
      model,
      backend: new StateBackend(),
      permissions: [{ operations: ['write'], paths: ['/secrets/**'], mode: 'deny' }],
    });

    const result = await agent.invoke({ messages: [new HumanMessage('寫檔。')] });
    const files = Object.keys(result.files ?? {});

    // /secrets/** 有 deny 規則 → 擋下；/notes.md 沒有任何規則命中 → 放行。
    expect(files).not.toContain('/secrets/token');
    expect(files).toContain('/notes.md');
  });

  it('interruptOn 是 Record 不是陣列，且需要 checkpointer', async () => {
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '記一筆。',
          toolCalls: [{ name: 'record_finding', args: { topic: 't', detail: 'd' } }],
        },
      ],
    });

    const agent = createDeepAgent({
      model,
      tools: [recordFinding],
      backend: new StateBackend(),
      interruptOn: { record_finding: true },
      checkpointer: new MemorySaver(),
    });

    const result = await agent.invoke(
      { messages: [new HumanMessage('記一筆。')] },
      { configurable: { thread_id: 'spike-interrupt' } },
    );

    expect(result.__interrupt__).toBeDefined();
  });
});
