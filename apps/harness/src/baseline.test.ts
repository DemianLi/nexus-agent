import { HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { createDeepAgent, getHarnessProfile, StateBackend } from 'deepagents';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fakeTool } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';

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

    // 比集合不比順序：這裡要抓的是「工具集合變了」，不是註冊順序變了。
    // 順序另有自己的問題（#28 已定案要自建顯式呈現順序），不該讓它在這裡造成 flake。
    expect([...model.boundToolNames].sort()).toEqual(
      [
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
      ].sort(),
    );
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

  /**
   * **這是「工具拋錯就整場 run 死掉」那條的基座半邊。**
   *
   * 它以前住在 `validation.test.ts` 的第一條，當那個檔案裡「沒掛 plugin」還等於「沒有
   * 圍堵」的時候。[#159](https://github.com/DemianLi/nexus-agent/issues/159) 把圍堵搬進
   * fold 打底之後，我們自己的組裝**再也造不出那個對照組**——所以基座那一半搬到這裡，
   * 這個檔案本來就是唯一直接叫 `createDeepAgent` 的地方。
   *
   * **刪掉它等於把唯一一條指著這個缺口的線拿走**：哪天基座自己改回把工具的錯翻成回饋，
   * 這一條會紅，而那正是「我們還需不需要圍堵」該重問的時刻。
   *
   * 成因：`ToolNode.runTool` 只要 `wrapToolCall` 存在就把工具自己拋的錯當成 middleware
   * 的錯（`langchain@1.5.10`，`ToolNode.js:275-282`），`#handleError:150` 對那種錯是
   * `handleToolErrors !== true` 即重拋，而 `ReactAgent` 建 `ToolNode` 時根本不傳那個參數
   * （`:174-179`）。`createDeepAgent` 又永遠掛帶 `wrapToolCall` 的 `FilesystemMiddleware`。
   */
  it('**工具拋錯 → 整場 run 死掉**（我們掛圍堵的理由，不是我們的行為）', async () => {
    const ran: string[] = [];
    const model = new ScriptedChatModel({
      turns: [
        { content: '動手。', toolCalls: [{ name: 'boom', args: {} }] },
        { content: '收工。' },
      ],
    });
    const agent = createDeepAgent({
      model,
      backend: new StateBackend(),
      tools: [
        tool(
          () => {
            ran.push('boom');
            throw new Error('磁碟滿了');
          },
          { name: 'boom', description: '會炸的工具', schema: z.object({}) },
        ),
      ],
    });

    await expect(agent.invoke({ messages: [new HumanMessage('動手。')] })).rejects.toThrow(
      '磁碟滿了',
    );
    // 工具真的跑到了才拋——不然這條會被「模型根本沒呼叫它」滿足。
    expect(ran).toEqual(['boom']);
  });

  it('interruptOn 是 Record 不是陣列，且需要 checkpointer', async () => {
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '記一筆。',
          toolCalls: [{ name: 'probe', args: {} }],
        },
      ],
    });

    const agent = createDeepAgent({
      model,
      tools: [fakeTool('probe')],
      backend: new StateBackend(),
      interruptOn: { probe: true },
      checkpointer: new MemorySaver(),
    });

    const result = await agent.invoke(
      { messages: [new HumanMessage('記一筆。')] },
      { configurable: { thread_id: 'baseline-interrupt' } },
    );

    expect(result.__interrupt__).toBeDefined();
  });
});

/**
 * 升版防護：**基座按模型改寫組裝**這件事的內容面。
 *
 * 組裝點那道檢查（[`harness-profile.ts`](./harness-profile.ts)）比的是「這次解出來的
 * 槓桿組合，跟組裝點宣告的一不一致」——它抓得到「我的 agent 變了」，抓不到「基座那側
 * 的內建 profile 換人了」。後者是這裡的事，而且**只該在 CI 紅**：一次 patch 升版不該
 * 變成生產上的組裝失敗。
 *
 * 詳見 [#140](https://github.com/DemianLi/nexus-agent/issues/140)。
 */
describe('deepagents 1.13.x 內建 harness profile', () => {
  it('裸供應商鍵沒有人認領', () => {
    // **這一條是這裡最要緊的那個。** Codex 那段 register() 的註解明說用 per-model key 就是
    // 為了「keep the default behavior of non-Codex OpenAI models unchanged」；哪天有人註冊了
    // 裸 `openai`，我們今天在跑的 `nvidia/nemotron-3-super-120b-a12b` 會**跟著**被改寫（它也走
    // `ChatOpenAI`，供應商鍵一樣是 `openai`），而那條路上沒有
    // 任何一個字串 spec 可以讓人事先看到。
    expect(getHarnessProfile('openai')).toBeUndefined();
    expect(getHarnessProfile('anthropic')).toBeUndefined();
    expect(getHarnessProfile('google')).toBeUndefined();
  });

  it('Codex 那份仍然帶著會多掛工具的 extraMiddleware', () => {
    const profile = getHarnessProfile('openai:gpt-5.2-codex');

    expect(profile).toBeDefined();
    // 工廠函式而不是靜態陣列——所以「它會掛上哪些工具」要建出來才知道，這也是
    // HarnessProfileEffects 在那一欄放哨兵而不放名字的理由。
    expect(typeof profile?.extraMiddleware).toBe('function');
    expect(profile?.systemPromptSuffix).toBeDefined();
  });

  it('Anthropic 三份只動提示詞，不動組成', () => {
    for (const spec of [
      'anthropic:claude-opus-4-7',
      'anthropic:claude-sonnet-4-6',
      'anthropic:claude-haiku-4-5',
    ]) {
      const profile = getHarnessProfile(spec);

      expect(profile?.systemPromptSuffix, spec).toBeDefined();
      expect(profile?.excludedTools.size, spec).toBe(0);
      expect(Object.keys(profile?.toolDescriptionOverrides ?? {}), spec).toEqual([]);
      expect(profile?.extraMiddleware, spec).toEqual([]);
    }
  });
});
