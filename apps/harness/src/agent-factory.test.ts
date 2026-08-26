import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { createEchoPlugin, ECHO_TOOL_NAME } from '@nexus/plugin-echo';
import { describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import {
  createMountPlugin,
  createNotePlugin,
  createToolPlugin,
  fakeTool,
  NOTE_TOOL_NAME,
} from './fixtures.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';

/**
 * 兩個 plugin 的工具在**同一輪**一起被呼叫，那一輪沒有文字內容，最後回一句話。
 *
 * 形狀是照真模型寫的，不是隨手挑的（[#51](https://github.com/DemianLi/nexus-agent/issues/51)）：
 * [PR #50](https://github.com/DemianLi/nexus-agent/pull/50) 第一次用真實供應商跑起來時，
 * 兩個工具就是在同一輪一起回來的。這條是 [#29](https://github.com/DemianLi/nexus-agent/issues/29)
 * 的正面路徑驗收，而它的證明力直接取決於假模型有多像真的——寫成「多輪、每輪一個工具」
 * 一樣會綠，但驗到的是一個真模型不會走的形狀。
 *
 * 多輪各一個工具的覆蓋沒有因此消失：同一個檔案裡的呈現順序與 default backend 兩條都是多輪。
 */
const BOTH_TOOLS: readonly ScriptedTurn[] = [
  {
    content: '',
    toolCalls: [
      { name: ECHO_TOOL_NAME, args: { message: '嗨' } },
      { name: NOTE_TOOL_NAME, args: { text: '兩個 plugin 都接上了' } },
    ],
  },
  { content: '兩邊都跑過了。' },
];

/** 把一次 run 的所有訊息文字攤平，用來斷言工具真的回了東西。 */
function texts(messages: readonly BaseMessage[]): string[] {
  return messages.map((message) => message.text);
}

describe('createNexusAgent', () => {
  it('一份清單 fold 出的 agent 兩個 plugin 的工具都呼叫得到', async () => {
    const model = new ScriptedChatModel({ turns: BOTH_TOOLS });

    const { agent } = await createNexusAgent({
      model,
      plugins: [createEchoPlugin(), createNotePlugin()],
    });

    const result = await agent.invoke(toAgentInvocation('兩個工具都跑一次。'));
    const all = texts(result.messages).join('\n');

    // 兩個工具的回傳值都在對話裡：一個來自 packages/nexus-plugin-echo（真的
    // workspace package），一個來自本套件的 fixture。
    expect(all).toContain('回聲：嗨');
    expect(all).toContain('已記下：兩個 plugin 都接上了');

    // 基座真的把兩個工具都交給了模型（連同它自己那些內建工具）。
    expect(model.boundToolNames).toContain(ECHO_TOOL_NAME);
    expect(model.boundToolNames).toContain(NOTE_TOOL_NAME);
  });

  it('plugin 註冊的工具依呈現順序交給模型，未列出的落在 rest 那一格', async () => {
    const order = async (toolOrder?: readonly string[]): Promise<readonly string[]> => {
      const model = new ScriptedChatModel({ turns: [{ content: '不做事。' }] });
      const { agent } = await createNexusAgent({
        model,
        plugins: [createEchoPlugin(), createNotePlugin({ deny: false })],
        ...(toolOrder !== undefined && { toolOrder }),
      });
      // 工具是在跑起來的時候才綁給模型的，不是建構時。
      await agent.invoke(toAgentInvocation('不做事。'));
      return model.boundToolNames;
    };

    // 沒給清單就是字典序：'echo' 排在 'take_note' 前面。
    const byDefault = await order();
    expect(byDefault.indexOf(ECHO_TOOL_NAME)).toBeLessThan(byDefault.indexOf(NOTE_TOOL_NAME));

    // note 明著排到最前，echo 沒列到 —— 它落在 rest 那一格，於是換到後面。
    const reordered = await order([NOTE_TOOL_NAME, '<unlisted-tools>']);
    expect(reordered.indexOf(NOTE_TOOL_NAME)).toBeLessThan(reordered.indexOf(ECHO_TOOL_NAME));
  });

  it('deny 規則折出來的形狀基座收得下', async () => {
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

    // fixture 的 deny 是 `/secrets/**` 且 except `/secrets/public/**`。基座只要看到
    // 規則就會跑 validatePermissionPaths()（非絕對路徑、含 ".." 或 "~" 一律拋錯），
    // 那道檢查 fold 看不到，所以這條同時是「fold 的輸出真的過得了基座那關」的證據。
    const { agent } = await createNexusAgent({ model, plugins: [createNotePlugin()] });

    const result = await agent.invoke(toAgentInvocation('寫檔。'));
    const files = Object.keys(result.files ?? {});

    expect(files).not.toContain('/secrets/token');
    expect(files).toContain('/notes.md');
  });

  it('宣告了要核准的工具、也給了 checkpointer 時中斷得起來', async () => {
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '記一筆。',
          toolCalls: [{ name: NOTE_TOOL_NAME, args: { text: '要先核准' } }],
        },
      ],
    });

    const { agent } = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      plugins: [
        createNotePlugin(),
        {
          name: 'gatekeeper',
          requires: ['note'],
          apply(registry) {
            registry.interrupts.require(NOTE_TOOL_NAME, { reason: '記筆記要人看過' });
          },
        },
      ],
    });

    const result = await agent.invoke(toAgentInvocation('記一筆。'), {
      configurable: { thread_id: 'factory-interrupt' },
    });

    expect(result.__interrupt__).toBeDefined();
  });

  it('組裝點自己備著 default backend —— plugin 只掛路由也組得起來', async () => {
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '寫檔。',
          toolCalls: [{ name: 'write_file', args: { file_path: '/a.md', content: 'x' } }],
        },
        { content: '寫完了。' },
      ],
    });

    // 沒給 `backend`。fold 對「有人掛了路由卻沒有兜底的那個」是報錯的，所以這一條
    // 組得起來就等於證明了組裝點自己補上了 default backend。
    const { agent } = await createNexusAgent({
      model,
      plugins: [createMountPlugin('/memories/'), createEchoPlugin()],
    });

    const result = await agent.invoke(toAgentInvocation('寫檔。'));

    expect(Object.keys(result.files ?? {})).toContain('/a.md');
  });

  it('組裝點給的 system prompt 到得了模型', async () => {
    const model = new ScriptedChatModel({ turns: [{ content: '好。' }] });

    const { agent } = await createNexusAgent({
      model,
      systemPrompt: '你是 nexus 的測試 agent。',
      plugins: [createEchoPlugin()],
    });
    await agent.invoke(toAgentInvocation('嗨。'));

    expect(texts(model.lastPrompt).join('\n')).toContain('你是 nexus 的測試 agent。');
  });

  it('基座自己帶的工具名認得出來 —— 標得上核准，也排得進呈現順序', async () => {
    const model = new ScriptedChatModel({ turns: [{ content: '不做事。' }] });

    // `task` 由基座的 subagent middleware 註冊，不經過我們的 registry。少了
    // `BASE_TOOL_NAMES` 那份名單，這兩件事都會被誤判成「指向不存在的工具」。
    await expect(
      createNexusAgent({
        model,
        checkpointer: new MemorySaver(),
        toolOrder: ['task', '<unlisted-tools>'],
        plugins: [
          {
            name: 'gatekeeper',
            apply: (registry) =>
              void registry.interrupts.require('task', { reason: '委派出去要人看過' }),
          },
        ],
      }),
    ).resolves.toBeDefined();
  });

  describe('載入期失敗', () => {
    it('兩個 plugin 註冊同名工具 → 報錯且指名兩個 plugin 與工具名', async () => {
      const failure = await createNexusAgent({
        model: new ScriptedChatModel({ turns: [] }),
        plugins: [createEchoPlugin(), createEchoPlugin({ prefix: '第二份' })],
      }).catch((error: unknown) => (error as Error).message);

      // 錯誤傳播路徑只有一條，訊息本身要指得出撞的是哪兩個 plugin 與哪個工具名 ——
      // `feat/harness-cli` 的端到端驗收靠的就是這幾個字串沒有在半路被吞掉。
      expect(failure).toContain('plugins[0] (echo)');
      expect(failure).toContain('plugins[1] (echo)');
      expect(failure).toContain(`"${ECHO_TOOL_NAME}"`);
    });

    it('requires 缺件 → 報錯', async () => {
      await expect(
        createNexusAgent({
          model: new ScriptedChatModel({ turns: [] }),
          plugins: [{ name: 'needs-mcp', requires: ['mcp'], apply: () => {} }],
        }),
      ).rejects.toThrow(/需要能力 "mcp"/);
    });

    it('宣告了要核准的工具但沒給 checkpointer → 報錯', async () => {
      await expect(
        createNexusAgent({
          model: new ScriptedChatModel({ turns: [] }),
          plugins: [
            createNotePlugin(),
            {
              name: 'gatekeeper',
              apply: (registry) =>
                void registry.interrupts.require(NOTE_TOOL_NAME, { reason: '要人看過' }),
            },
          ],
        }),
      ).rejects.toThrow(/沒給 checkpointer/);
    });

    it('工具名撞到基座內建的 → 報錯且指名是誰註冊的', async () => {
      await expect(
        createNexusAgent({
          model: new ScriptedChatModel({ turns: [] }),
          plugins: [createEchoPlugin(), createToolPlugin('write_file')],
        }),
      ).rejects.toThrow(/plugins\[1\] \(provides-write_file\).*"write_file"/s);
    });

    it('註冊到 subagent 層的工具撞到基座內建的也擋 —— 基座自己不查那一層', async () => {
      await expect(
        createNexusAgent({
          model: new ScriptedChatModel({ turns: [] }),
          plugins: [
            {
              name: 'researcher',
              apply: (registry) =>
                void registry.subagents.register({
                  name: 'researcher',
                  description: '測試用的 subagent',
                }),
            },
            createToolPlugin('grep', 'researcher'),
          ],
        }),
      ).rejects.toThrow(/subagent "researcher".*"grep"/s);
    });

    it('async 任務工具的名字也擋 —— 基座那道保留是無條件的', async () => {
      // 這五個名字在目前的組裝裡不會有對應的工具（`BASE_TOOL_NAMES` 因此不收它們），
      // 但基座的 BUILTIN_TOOL_NAMES 檢查不看有沒有 async subagent，一律拒絕。
      await expect(
        createNexusAgent({
          model: new ScriptedChatModel({ turns: [] }),
          plugins: [createToolPlugin('start_async_task')],
        }),
      ).rejects.toThrow(/plugins\[0\] \(provides-start_async_task\).*"start_async_task"/s);
    });

    it('subagent 定義自帶的工具撞到基座內建的也擋 —— 那些工具不經過 registry', async () => {
      await expect(
        createNexusAgent({
          model: new ScriptedChatModel({ turns: [] }),
          plugins: [
            {
              name: 'researcher',
              apply: (registry) =>
                void registry.subagents.register({
                  name: 'researcher',
                  description: '測試用的 subagent',
                  tools: [fakeTool('delete')],
                }),
            },
          ],
        }),
      ).rejects.toThrow(/subagent "researcher" 自帶的工具裡.*"delete"/s);
    });
  });
});
