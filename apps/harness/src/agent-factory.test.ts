import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { loadPlugins, SessionLog } from '@nexus/core';
import type { NexusPlugin } from '@nexus/core';
import { createEchoPlugin, ECHO_TOOL_NAME } from '@nexus/plugin-echo';
import { describe, expect, it } from 'vitest';
import { createNexusAgent, DEFAULT_RECURSION_LIMIT } from './agent-factory.js';
import type { NexusAgentHandle } from './agent-factory.js';
import { LoopingChatModel } from './looping-model.js';
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
      expect(failure).toContain('echo#0 (echo)');
      expect(failure).toContain('echo#1 (echo)');
      expect(failure).toContain(`"${ECHO_TOOL_NAME}"`);
    });

    it('手寫 id 那個寫法在真的工廠上成立，不只在 fixture 上', async () => {
      // `NexusPlugin.id` 的 JSDoc 教使用者展開工廠的產物再補一個 id。**展開只對純
      // 物件字面值成立**——哪天某個工廠改成回 class 實例、frozen 物件或 getter，
      // `apply` 或 `name` 就會在展開時掉掉，而那份文件會變成錯的。這條測試用真的
      // `createEchoPlugin()` 守著它；`@nexus/harness` 是唯一相依全部 plugin 的地方。
      const failure = await createNexusAgent({
        model: new ScriptedChatModel({ turns: [] }),
        plugins: [
          { ...createEchoPlugin(), id: 'echo-main' },
          { ...createEchoPlugin({ prefix: '第二份' }), id: 'echo-second' },
        ],
      }).catch((error: unknown) => (error as Error).message);

      expect(failure).toContain('echo-main (echo)');
      expect(failure).toContain('echo-second (echo)');

      // `disabled` 走同一個展開寫法，所以綁在同一條測試上。關掉第二份，撞名就不成立了
      // ——**那同時證明它的 `apply` 真的沒跑**：跑了就會註冊同名工具，這裡就會炸。
      const { registry, dispose } = await loadPlugins([
        createEchoPlugin(),
        { ...createEchoPlugin({ prefix: '第二份' }), disabled: true },
      ]);
      try {
        expect(registry.tools.resolve(ECHO_TOOL_NAME)).toBeDefined();
      } finally {
        await dispose();
      }
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
      ).rejects.toThrow(/provides-write_file#0 \(provides-write_file\).*"write_file"/s);
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
      ).rejects.toThrow(
        /provides-start_async_task#0 \(provides-start_async_task\).*"start_async_task"/s,
      );
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

/**
 * 迴圈上限 —— **基座設了一個等於沒設的值，所以組裝點必須自己設一個。**
 *
 * `createDeepAgent` 最後一步是 `.withConfig({ recursionLimit: 1e4 })`，換算約 5,000 輪
 * 模型呼叫。這一組釘的是「我們真的蓋掉了它」：拿掉 `withConfig` 那一行的話，下面第一條
 * 會跑到 4,999 輪才停，數字對不上而且會慢上兩個數量級。
 *
 * 為什麼不直接斷言「基座的預設是 10000」：那個值**讀不到**（`createDeepAgent` 回的是
 * `ReactAgent`，只有一個 `options` 鍵，`config` / `kwargs` / `lc_kwargs` 全是 undefined），
 * 唯一的驗法是真的跑到上限，而那要 20 到 35 秒。所以那個數字記在
 * `agent-factory.ts` 的檔頭當量測結果，這裡釘的是我們自己的行為。
 */
describe('迴圈上限', () => {
  it('沒傳就套預設，而且真的會擋下來', async () => {
    const model = new LoopingChatModel();
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [createEchoPlugin()],
    });

    try {
      await expect(agent.invoke(toAgentInvocation('一直跑'))).rejects.toThrow(/Recursion limit/);
    } finally {
      await dispose();
    }

    // `recursionLimit = 2 × 模型輪數 + 2`，所以 100 換算是 49 輪。
    // **這條斷言才是承重的那個**：少了 `withConfig` 的話它是 4999。
    expect(model.calls).toBe((DEFAULT_RECURSION_LIMIT - 2) / 2);
  });

  it('傳進來的值蓋得掉預設', async () => {
    const model = new LoopingChatModel();
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [createEchoPlugin()],
      recursionLimit: 8,
    });

    try {
      await expect(agent.invoke(toAgentInvocation('一直跑'))).rejects.toThrow(
        /Recursion limit of 8/,
      );
    } finally {
      await dispose();
    }
    expect(model.calls).toBe(3);
  });

  it('正常收工的對話不受影響 —— 上限擋的是跑掉，不是複雜', async () => {
    const model = new ScriptedChatModel({ turns: BOTH_TOOLS });
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [createEchoPlugin(), createNotePlugin()],
    });

    try {
      const result = await agent.invoke(toAgentInvocation('兩個工具都用一次'));
      const messages: BaseMessage[] = result.messages;
      expect(messages.length).toBeGreaterThan(0);
    } finally {
      await dispose();
    }
  });

  it('包上 withConfig 之後型別沒有塌成 any', () => {
    // **這一條是型別檢查在跑，不是 vitest。** `agent-factory.ts` 檔頭已經記過同一型的坑：
    // `ReturnType<typeof createDeepAgent>` 會讓 `result.messages` 變成 `any`。`withConfig`
    // 回的是另一個型別，所以要重驗 —— 而 `any` 是**不會讓 typecheck 紅**的那種壞掉，
    // 上面那條 `const messages: BaseMessage[] = result.messages` 在 `any` 底下照樣過。
    // 塌掉的話下面這個 `= true` 會變成把 `true` 指派給 `false`，typecheck 當場紅。
    const notAny: MessagesAreTyped = true;
    expect(notAny).toBe(true);
  });
});

/**
 * 一個一律報違規的配套入口。**選擇有沒有生效只有靠它看得出來**：安靜的配套入口在
 * 「裝了但沒違規」與「根本沒裝」之間長得一模一樣。
 */
function noisyInvariantPlugin(packageName: string, name = 'noisy-invariant'): NexusPlugin {
  return {
    name,
    apply(registry) {
      registry.invariants.register(packageName, (subject, fail) => {
        subject.observe((event) => fail(`看到 ${event.type}`));
      });
    },
  };
}

/**
 * 接上不變量、發一筆事件，回收到的違規。
 *
 * 攔 `console.error` 是因為 `attachInvariants` 沒有讓呼叫端換掉 `onViolation` 的口
 * ——違規就是印到那裡去（同 `invariant-paths.test.ts` 的理由）。
 */
async function violationsUnder(
  plugins: readonly NexusPlugin[],
  invariants?: Parameters<typeof createNexusAgent>[0]['invariants'],
): Promise<string[] | undefined> {
  const { attachInvariants, dispose } = await createNexusAgent({
    model: new ScriptedChatModel({ turns: [] }),
    plugins,
    ...(invariants !== undefined && { invariants }),
  });
  const log = new SessionLog('selection');
  const seen: string[] = [];
  const original = console.error;
  console.error = (message: unknown) => void seen.push(String(message));
  try {
    const detach = attachInvariants(log);
    if (detach === undefined) return undefined;
    log.append('turn/start', { kind: 'resume' });
    detach();
    return seen;
  } finally {
    console.error = original;
    await dispose();
  }
}

describe('不變量的選擇面', () => {
  it('不給就全裝——這是預設，也是下面每一條的對照組', async () => {
    expect(
      await violationsUnder([createEchoPlugin(), noisyInvariantPlugin('@nexus/noisy')]),
    ).toEqual(['invariant violated by "@nexus/noisy": 看到 turn/start']);
  });

  it('blocklist 從組裝點傳得進去，那個 package 的檢查就真的沒裝', async () => {
    // **這條是 #104 那個落差的回歸測試**：`InvariantSelection` 早就存在，但組裝點沒有
    // 把它接出來，所以九個配套入口一個都選不動。它要走 `createNexusAgent`，core 那側
    // 的單元測試驗不到「接沒接出來」。
    expect(
      await violationsUnder([createEchoPlugin(), noisyInvariantPlugin('@nexus/noisy')], {
        packageBlocklist: ['^@nexus/noisy$'],
      }),
    ).toEqual([]);
  });

  it('enabled: false 是總開關，一個都不裝', async () => {
    expect(
      await violationsUnder(
        [
          createEchoPlugin(),
          noisyInvariantPlugin('@nexus/noisy'),
          noisyInvariantPlugin('@nexus/other', 'noisy-other'),
        ],
        { enabled: false },
      ),
    ).toEqual([]);
  });

  it('過濾成空集合照樣接線——那與「沒有人註冊」是兩件事', async () => {
    // `attachInvariants` 的 `undefined` 意思是「沒有人註冊配套入口」。過濾掉全部是一個
    // 有效的選擇結果，runner 照樣要接（它擁有訂閱與失敗語意），只是一個檢查都不裝。
    expect(
      await violationsUnder([createEchoPlugin(), noisyInvariantPlugin('@nexus/noisy')], {
        enabled: false,
      }),
    ).not.toBeUndefined();
  });

  it('條目層的 disabled 才是主要那個開關——關掉配套入口 plugin 就沒有人註冊了', async () => {
    expect(
      await violationsUnder([
        createEchoPlugin(),
        { ...noisyInvariantPlugin('@nexus/noisy'), disabled: true },
      ]),
    ).toBeUndefined();
  });

  it('壞掉的 pattern 在組裝時就炸，不是拖到第一輪對話', async () => {
    // runner 是每一份會話日誌各建一個的，所以不先驗的話這個錯誤會落在第一次
    // `attachInvariants` ——也就是使用者已經送出第一句話之後。
    await expect(
      createNexusAgent({
        model: new ScriptedChatModel({ turns: [] }),
        plugins: [createEchoPlugin()],
        invariants: { packageAllowlist: ['('] },
      }),
    ).rejects.toThrow(/無效的 regex/);
  });
});

/** `T` 是不是 `any` —— `any` 會讓 `1 & T` 也是 `any`，於是 `0 extends` 成立。 */
type IsAny<T> = 0 extends 1 & T ? true : false;
type AgentInvokeResult = Awaited<ReturnType<NexusAgentHandle['agent']['invoke']>>;
type MessagesAreTyped = IsAny<AgentInvokeResult['messages']> extends true ? false : true;
