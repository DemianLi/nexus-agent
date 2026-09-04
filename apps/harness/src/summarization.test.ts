/**
 * summarization 這一層的**行為**驗收（Phase 3 `feat/summarization-tuning`）。
 *
 * 這個擴充點跟 memory / skills 不一樣的地方在於：**基座上沒有「參數化」這個參數。**
 * `createSummarizationMiddleware({ backend })` 被無條件寫死進 root 與每一個 subagent 的
 * stack，`CreateDeepAgentParams` 上一個 summarization 欄位都沒有。唯一的縫是
 * `mergeMiddlewareStack` **按 `.name` 原地取代**——自己建一個名字剛好是
 * `"SummarizationMiddleware"` 的 middleware 從 `middleware` 註冊點傳進去，就換掉內建那個。
 *
 * 所以第一組測試是**釘住那條縫本身**：它掛在一個字串上，而且那是唯一能設定
 * `trigger` / `keep` / `historyPathPrefix` 的路。基座改名或改合併語意時這些測試該紅。
 *
 * 第二、三組是斷言缺陷的升版絆索，跟 [`memory.test.ts`](./memory.test.ts) 與
 * [`skills.test.ts`](./skills.test.ts) 同樣的用意。
 */

import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage, ToolMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import {
  codePointLength,
  DEFAULT_SUMMARIZATION,
  DEFAULT_TOOL_RESULT_PRUNE,
  resolveSummarizationSettings,
  TOOL_RESULT_PRUNE_MARKER,
} from '@nexus/core';
import type { NexusPlugin } from '@nexus/core';
import { tool } from 'langchain';
import { z } from 'zod';
import { createEchoPlugin, ECHO_TOOL_NAME } from '@nexus/plugin-echo';
import { computeSummarizationDefaults, createSummarizationMiddleware } from 'deepagents';
import { describe, expect, it } from 'vitest';
import { createNexusAgent, DEFAULT_RECURSION_LIMIT } from './agent-factory.js';
import { LoopingChatModel } from './looping-model.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { createLiveModel, LIVE_API_KEY_ENV } from './live-model.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

/** 一輪 prompt 裡的 system 訊息。 */
function systemPrompt(messages: readonly BaseMessage[]): string {
  return messages
    .filter((message) => message.getType() === 'system')
    .map((message) => message.text)
    .join('\n');
}

/**
 * 建好的 agent 身上那份 middleware stack 的名字。
 *
 * 這是唯一能分辨「取代」與「多加一個」的辦法——兩者在行為上都會讓我們的 middleware 生效，
 * 差別只在內建那個還在不在。找不到就直接失敗：這個 helper 靠的是基座的內部形狀，
 * 它紅了正是我們要知道的事。
 */
function middlewareNames(agent: unknown): string[] {
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): string[] | null => {
    if (depth > 5 || node == null || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'middleware' && Array.isArray(value)) {
        return value.map((entry) => String((entry as { name?: string })?.name));
      }
      const found = walk(value, depth + 1);
      if (found) return found;
    }
    return null;
  };
  const names = walk(agent, 0);
  if (!names) throw new Error('找不到 agent 的 middleware stack——基座的內部形狀變了。');
  return names;
}

/**
 * 自己建一個低門檻的摘要器換掉內建那個。
 *
 * 這同時是「同名取代」的實際用途：`trigger` / `keep` / `historyPathPrefix` 都只有走這條路
 * 才設得到——基座無條件建的那個只吃 `{ backend }`。
 *
 * `backend` 收成參數而不是寫死，是因為它**是獨立的一格**：摘要器寫歷史用的 backend 不必是
 * agent 那個。最後一組測試就靠這一點。
 */
function tunedSummarization(backend: ContainedFilesystemBackend): NexusPlugin {
  return {
    name: 'tuned-summarization',
    apply: (registry) =>
      void registry.middleware.use(
        createSummarizationMiddleware({
          backend,
          trigger: { type: 'messages', value: 3 },
          keep: { type: 'messages', value: 1 },
        }) as never,
      ),
  };
}

/** 某個根底下 `conversation_history` 裡的檔案；目錄不存在就是空的。 */
async function historyFiles(root: string): Promise<string[]> {
  try {
    return await readdir(join(root, 'conversation_history'));
  } catch {
    return [];
  }
}

const MARKER = '<這是我們自己的摘要器>';

/** 一個只在 system prompt 留記號的假摘要器，名字剛好撞上內建那個。 */
function markerSummarization(): NexusPlugin {
  return {
    name: 'marker-summarization',
    apply: (registry) =>
      void registry.middleware.use({
        name: 'SummarizationMiddleware',
        wrapModelCall: (
          request: { systemMessage: { concat: (text: string) => unknown } },
          handler: (next: unknown) => unknown,
        ) => handler({ ...request, systemMessage: request.systemMessage.concat(`\n${MARKER}`) }),
      } as never),
  };
}

describe('同名取代是唯一的縫', () => {
  /**
   * **取代的是內建那個，不是在旁邊多加一個。**
   *
   * `mergeMiddlewareStack` 按 `.name` 在**預設段與尾段兩邊**原地取代。少了這一條，
   * 「我們的 middleware 有生效」與「內建那個還在旁邊跑」分不出來——而後者意味著
   * 對話會被摘要兩次。
   */
  it('stack 裡只有一個 SummarizationMiddleware，而且是我們的', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-sum-'));
    const model = new ScriptedChatModel({ turns: [{ content: '好。' }] });

    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      plugins: [markerSummarization()],
    });

    try {
      const names = middlewareNames(agent);
      expect(names.filter((name) => name === 'SummarizationMiddleware')).toHaveLength(1);
      // 位置也沒動——原地取代，不是刪掉再追加到尾巴。尾巴上那五個是 fold 每次都掛的：
      // 圍堵（[#159](https://github.com/DemianLi/nexus-agent/issues/159)）、核准閘門
      // （[#111](https://github.com/DemianLi/nexus-agent/issues/111)）、「先讀後改」策略
      // （[#154](https://github.com/DemianLi/nexus-agent/issues/154)）、重複呼叫的提醒器
      // （[#147](https://github.com/DemianLi/nexus-agent/issues/147)）與用量記錄器
      // （[#153](https://github.com/DemianLi/nexus-agent/issues/153)）。
      // **它們跟摘要器的下場不同，而這條同時釘住那個差別**：名字不撞內建任何一個，
      // 所以是 novel entry 被追加在基座那幾個之後、其餘 plugin middleware 之前；摘要器
      // 的名字撞了，所以是原地取代回第三格。
      //
      // **這條順帶釘住圍堵射程的上限**：基座那四個排在它外面，所以它們自己拋的錯圍堵
      // 接不到。那是 `createDeepAgent` 的組裝順序，不是 fold 決定得了的。
      expect(names).toEqual([
        'FilesystemMiddleware',
        'subAgentMiddleware',
        'SummarizationMiddleware',
        'patchToolCallsMiddleware',
        'nexusToolFailureContainment',
        'nexusApprovalGate',
        'nexusFileObservationPolicy',
        'nexusRepeatToolReminder',
        'nexusModelUsage',
      ]);

      await agent.invoke(toAgentInvocation('嗨。'));
      // 那一個是我們的：內建的 SummarizationMiddleware 不碰 system prompt。
      expect(systemPrompt(model.lastPrompt)).toContain(MARKER);
    } finally {
      await dispose();
    }
  });

  /**
   * **`middleware` 註冊點只蓋得到 root**——升版絆索，也是這條縫的射程邊界。
   *
   * `createSubagentDefaultMiddleware` 每個 subagent 各建一份新的
   * `createSummarizationMiddleware({ backend })`，而 `buildSubagentMiddleware` 只併
   * `input.middleware`——root 從 `middleware` 參數傳進去的那個到不了 subagent。
   *
   * **這條的意思在 [#142](https://github.com/DemianLi/nexus-agent/issues/142) 之後變了一半。**
   * 註冊點的射程沒變（仍然只到 root），但 subagent 那一輪拿的**不再是基座那個**：
   * `foldSubAgents` 會逐個 subagent 注一份我們配的進去。所以這條現在釘的是「plugin 從
   * `middleware.use()` 掛的東西不會外溢到 subagent」，而 subagent 拿到什麼由
   * 〈我們配的那份打底到每個 subagent〉那一組量。兩件事分開釘，因為它們會為不同的理由壞掉。
   *
   * （`harnessProfile.excludedMiddleware` 是另一條縫，而且它對每個 subagent 都生效——
   * 但它只能**排除**不能替換，排掉等於 subagent 完全沒有摘要，長對話直接爆 context。
   * 而且它走的是全域 profile registry、綁在模型識別字串上，不是組裝點的參數。所以那不是
   * 這個邊界的解法，詳見 PR 內文。）
   */
  it('註冊點只蓋到 root，記號不會外溢到 subagent 那輪', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-sum-'));
    const crew: NexusPlugin = {
      name: 'crew',
      apply: (registry) =>
        void registry.subagents.register({ name: 'writer', description: '負責寫東西。' }),
    };
    // 三輪：root 叫 subagent → subagent 回話 → root 收尾。
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '',
          toolCalls: [{ name: 'task', args: { description: '去寫', subagent_type: 'writer' } }],
        },
        { content: 'subagent 做完了。' },
        { content: '收工。' },
      ],
    });

    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      plugins: [markerSummarization(), crew],
    });

    try {
      await agent.invoke(toAgentInvocation('叫 writer 去做事。'));
    } finally {
      await dispose();
    }

    const prompts = model.prompts.map(systemPrompt);
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain(MARKER);
    expect(prompts[1]).not.toContain(MARKER);
    expect(prompts[2]).toContain(MARKER);
  });
});

/**
 * **offload 失敗是 fail-open：歷史沒寫出去，摘要照做，只留一行 warn。**
 *
 * 這是計劃「跨 Phase 的坑」那段記的那條，收在這張 PR 是因為機制全在這裡。
 * `summarizeMessages` 的第一行就是 offload，然後：
 * `if (filePath === null) console.warn('...Proceeding with summary generation.')`
 * ——沒有 throw、沒有 interrupt，對話繼續，而完整歷史沒有留下任何副本。
 *
 * 兩條測試共用同一個觸發，只有 fence 的 mode 不同。**兩條都要**：只測 read-only 的話，
 * 一個根本沒觸發 summarization 的組裝也會讓它通過。
 */
describe('offload 失敗是 fail-open', () => {
  async function runUntilSummarized(mode: 'workspace-write' | 'read-only'): Promise<{
    readonly root: string;
    readonly replies: number;
  }> {
    const root = await mkdtemp(join(tmpdir(), 'nexus-sum-'));
    const backend = new ContainedFilesystemBackend({ rootDir: root, mode });
    // 比四句多——摘要本身也要呼叫一次模型，觸發之後每一輪都可能多一次。
    const model = new ScriptedChatModel({
      turns: Array.from({ length: 12 }, (_, index) => ({ content: `第 ${index + 1} 次回話。` })),
    });

    // 要有 checkpointer 加同一個 thread_id，訊息才會累積——少了它每次 invoke 都是新的
    // state，訊息數永遠回到 1，`trigger` 一輩子碰不到。
    const { agent, dispose } = await createNexusAgent({
      model,
      backend,
      checkpointer: new MemorySaver(),
      plugins: [tunedSummarization(backend)],
    });

    let replies = 0;
    try {
      for (const line of ['第一句。', '第二句。', '第三句。', '第四句。']) {
        const result = await agent.invoke(toAgentInvocation(line), {
          configurable: { thread_id: 'summarize' },
        });
        if (result.messages.some((message) => message.getType() === 'ai')) replies += 1;
      }
    } finally {
      await dispose();
    }
    return { root, replies };
  }

  it('可寫的時候歷史真的落檔', async () => {
    const { root, replies } = await runUntilSummarized('workspace-write');

    expect(replies).toBe(4);
    const files = await historyFiles(root);
    expect(files.length).toBeGreaterThan(0);
    const content = await readFile(join(root, 'conversation_history', files[0]!), 'utf8');
    expect(content).toContain('Summarized at');
  });

  it('fence 擋住的時候歷史消失，但對話照樣走完', async () => {
    const { root, replies } = await runUntilSummarized('read-only');

    // 對話沒有中斷——這正是 fail-open 的意思，失敗不會反映在任何回傳值上。
    expect(replies).toBe(4);
    expect(await historyFiles(root)).toEqual([]);
  });
});

/**
 * **`/conversation_history` 有第二個寫入者，而它比 summarization 那個更安靜。**
 *
 * 計劃只記了 summarization 的 offload。實際上 `createFilesystemMiddleware` 的
 * `beforeAgent` 還有一條**超大 human message 的 eviction**：最後一則 human message 超過
 * `4 * humanMessageTokenLimitBeforeEvict` 字元（預設 `5e4`，也就是 20 萬字元）時，
 * 把它寫進 `/conversation_history/<uuid>` 並在送進模型時換成一句佔位。
 *
 * 兩個差別，都往壞的方向：
 *
 * 1. **路徑是寫死的**，不吃 `historyPathPrefix`——所以同名取代那條縫救不了它。
 * 2. **失敗完全靜默**：`if (writeResult.error) return;`，連 summarization 那行 `console.warn`
 *    都沒有。
 *
 * 而失敗的**方向跟直覺相反**：擋住的時候不是「原話消失」，是原話**原封不動**送進模型
 * ——20 萬字元直接灌進 context，正是 eviction 本來要避免的事。
 */
describe('/conversation_history 的另一個寫入者', () => {
  /** 剛好越過 `4 * 5e4` 那條線。 */
  const HUGE = '長'.repeat(200001);

  async function evict(mode: 'workspace-write' | 'read-only'): Promise<{
    readonly files: string[];
    readonly sentToModel: string;
  }> {
    const root = await mkdtemp(join(tmpdir(), 'nexus-evict-'));
    const model = new ScriptedChatModel({ turns: [{ content: '收到。' }] });

    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root, mode }),
      plugins: [],
    });

    let sentToModel = '';
    try {
      await agent.invoke(toAgentInvocation(HUGE));
      sentToModel = model.lastPrompt
        .filter((message) => message.getType() === 'human')
        .map((message) => message.text)
        .join('');
    } finally {
      await dispose();
    }

    let files: string[] = [];
    try {
      files = await readdir(join(root, 'conversation_history'));
    } catch {
      files = [];
    }
    return { files, sentToModel };
  }

  it('可寫的時候原話搬去 /conversation_history，模型只收到一句佔位', async () => {
    const { files, sentToModel } = await evict('workspace-write');

    expect(files).toHaveLength(1);
    expect(sentToModel).toContain('Message content too large');
    expect(sentToModel.length).toBeLessThan(HUGE.length);
  });

  it('fence 擋住的時候無聲失效，20 萬字元原封不動進 context', async () => {
    const { files, sentToModel } = await evict('read-only');

    expect(files).toEqual([]);
    // 方向跟直覺相反：不是原話消失，是該搬走的沒搬走。
    expect(sentToModel).toContain(HUGE);
  });
});

/**
 * **`permissions` 對 offload 完全沒有作用 —— 而規則本身是對的。**
 *
 * `checkPermission` 只在七個工具工廠裡被呼叫（`createWriteFileTool` / `createEditFileTool` /
 * `createReadFileTool` / `createLsTool` / `createGlobTool` / `createGrepTool`，加上 delete 那條），
 * **不在 backend 方法上**。offload 走的是 backend 方法，所以它從來不經過規則表。
 *
 * 這一組是那句話的行為證據，而且刻意做成**四格對照**：同一條規則、同一個路徑前綴，
 * 一邊經工具、一邊經 backend 方法。少了對照組的話，「規則沒擋住」與「規則根本沒生效」
 * 分不出來 —— 而那兩件事要修的東西完全不同。
 *
 * 這是 [`permissions.test.ts`](./permissions.test.ts) 那句「無規則命中即 allow」的更大一半：
 * 一條寫對的規則看起來在保護一個它**碰不到**的東西。使用者的實際結論是
 * **想把對話歷史擋在某個路徑之外，deny 規則做不到** —— 要用 fence，或把摘要器的 backend
 * 指到別處（見下一組）。
 */
describe('deny 規則擋得住工具，擋不住 offload', () => {
  const denyHistory: NexusPlugin = {
    name: 'deny-history',
    apply: (registry) =>
      void registry.permissions.deny(['/conversation_history*', '/conversation_history/**']),
  };

  it('經工具寫同一個路徑：擋住了，磁碟上零檔案', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-deny-'));
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '',
          toolCalls: [
            {
              name: 'write_file',
              args: { file_path: '/conversation_history/x.md', content: '工具寫的' },
            },
          ],
        },
        { content: '寫不進去。' },
      ],
    });

    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      plugins: [denyHistory],
    });

    try {
      const result = await agent.invoke(toAgentInvocation('寫一個。'));
      const toolText = result.messages
        .filter((message: BaseMessage) => message.getType() === 'tool')
        .map((message: BaseMessage) => message.text)
        .join('');
      expect(toolText).toContain('permission denied');
    } finally {
      await dispose();
    }

    expect(await historyFiles(root)).toEqual([]);
  });

  it('經 offload 寫同一個路徑：規則形同不存在，歷史照樣落檔', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-deny-'));
    const backend = new ContainedFilesystemBackend({ rootDir: root, mode: 'workspace-write' });
    const model = new ScriptedChatModel({
      turns: Array.from({ length: 12 }, (_, index) => ({ content: `第 ${index + 1} 次回話。` })),
    });

    const { agent, dispose } = await createNexusAgent({
      model,
      backend,
      checkpointer: new MemorySaver(),
      plugins: [denyHistory, tunedSummarization(backend)],
    });

    try {
      for (const line of ['第一句。', '第二句。', '第三句。', '第四句。']) {
        await agent.invoke(toAgentInvocation(line), { configurable: { thread_id: 'deny' } });
      }
    } finally {
      await dispose();
    }

    // 上一條擋住的那個前綴，這條寫進去了。**這就是那個洞。**
    expect((await historyFiles(root)).length).toBeGreaterThan(0);
  });
});

/**
 * **`read-only` ✕ 長對話：預設不留歷史，但有一條逃生口。**
 *
 * 決定（見開發計劃 Phase 3）：預設接受「`read-only` 就是不留歷史」。「組裝期擋下這個組合」
 * 這個選項**在結構上不可行** —— summarization 是被無條件加進 stack 的，所以那個組合就是
 * **每一個** `read-only` 組裝，擋掉它等於禁用這個 mode 本身，連根本不會觸發摘要的短對話
 * 也一起禁掉。
 *
 * 逃生口是這一條：**`createSummarizationMiddleware` 的 `backend` 是獨立的一格**，不必是
 * agent 的那個。指到另一個可寫的 backend，唯讀那個就一個檔案都不會多。
 *
 * **代價**：走這條就得自己建摘要器，也就等於接管 `trigger` / `keep` 的預設值 —— 同名取代
 * 是唯一的設定入口，而它是全有全無的。
 */
describe('read-only 的逃生口：摘要器的 backend 是獨立的一格', () => {
  it('唯讀根一個檔案都沒多，歷史落在另一個根裡，對話照樣走完', async () => {
    const readOnlyRoot = await mkdtemp(join(tmpdir(), 'nexus-ro-'));
    const historyRoot = await mkdtemp(join(tmpdir(), 'nexus-hist-'));
    const historyBackend = new ContainedFilesystemBackend({
      rootDir: historyRoot,
      mode: 'workspace-write',
    });

    const model = new ScriptedChatModel({
      turns: Array.from({ length: 12 }, (_, index) => ({ content: `第 ${index + 1} 次回話。` })),
    });

    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: readOnlyRoot, mode: 'read-only' }),
      checkpointer: new MemorySaver(),
      plugins: [tunedSummarization(historyBackend)],
    });

    let replies = 0;
    try {
      for (const line of ['第一句。', '第二句。', '第三句。', '第四句。']) {
        const result = await agent.invoke(toAgentInvocation(line), {
          configurable: { thread_id: 'escape' },
        });
        if (result.messages.some((message: BaseMessage) => message.getType() === 'ai')) {
          replies += 1;
        }
      }
    } finally {
      await dispose();
    }

    expect(replies).toBe(4);
    // 唯讀那邊沒被碰——逃生口不是把 fence 鑿開。
    expect(await historyFiles(readOnlyRoot)).toEqual([]);
    // 而歷史真的留下來了，不是靜靜消失。
    expect((await historyFiles(historyRoot)).length).toBeGreaterThan(0);
  });
});

/**
 * **`fraction` 型別的門檻在解不出 `maxInputTokens` 的模型上會靜默壞掉，而且兩個方向相反。**
 *
 * 調研見 [#142](https://github.com/DemianLi/nexus-agent/issues/142)。基座只有兩組預設
 * （`computeSummarizationDefaults`）：模型的 `profile.maxInputTokens` 是數字就用比例，
 * 否則退到固定值。**我們的模型退到固定值** —— `LIVE_MODEL_ID` 是 `openai/gpt-oss-120b`，
 * 而這個字串在整個 `node_modules/.pnpm/` 裡零命中，沒有任何 profile 表認得它。
 *
 * 缺了那個數字之後，兩個讀它的地方各自決定怎麼退，而且退向相反：
 *
 * - `shouldSummarize`：`if (t.type === "fraction" && maxInputTokens)` —— 整個分支跳過，
 *   回 `false`。**fail-closed，門檻一輩子不觸發。**
 * - `determineCutoffIndex`：`keep.type === "fraction" && maxInputTokens ? floor(max * value)
 *   : keep.value` —— 把 `0.1` 當成「保留 0.1 個 token」。**fail-open，一則逐字訊息都不留。**
 *
 * 兩個都不警告、不拋。**這是這幾條要存在的理由**：dsh 那側的預設答案（`thresholdRatio`
 * 0.8 / `retainRatio` 0.16）正是比例形式，照抄過來會踩中其中一個，而踩中的當下沒有徵兆。
 *
 * 絆索的方向：**基座哪天讓這個模型解得出 `maxInputTokens`，這三條會紅** —— 那正是比例形式
 * 開始可用、而我們寫死的絕對值開始說謊的那一刻。
 */
describe('fraction 型別的門檻在我們的模型上是壞的', () => {
  /** 每一輪真正送進模型的非 system 訊息數。摘要生效的話這個數字會被壓下來。 */
  async function promptSizes(options: Record<string, unknown>): Promise<number[]> {
    const root = await mkdtemp(join(tmpdir(), 'nexus-frac-'));
    const backend = new ContainedFilesystemBackend({ rootDir: root });
    const model = new ScriptedChatModel({
      turns: Array.from({ length: 20 }, (_, index) => ({ content: `第 ${index + 1} 次回話。` })),
    });
    const plugin: NexusPlugin = {
      name: 'fraction-probe',
      apply: (registry) =>
        void registry.middleware.use(
          createSummarizationMiddleware({ backend, ...options }) as never,
        ),
    };

    const { agent, dispose } = await createNexusAgent({
      model,
      backend,
      checkpointer: new MemorySaver(),
      plugins: [plugin],
    });
    try {
      for (const line of ['一。', '二。', '三。', '四。', '五。', '六。']) {
        await agent.invoke(toAgentInvocation(line), { configurable: { thread_id: 'fraction' } });
      }
    } finally {
      await dispose();
    }

    return model.prompts.map(
      (prompt) => prompt.filter((message) => message.getType() !== 'system').length,
    );
  }

  it('fraction trigger 連 0.01% 都碰不到——一次都沒觸發', async () => {
    const sizes = await promptSizes({ trigger: { type: 'fraction', value: 0.0001 } });

    // 六輪、每輪多兩則（human ＋ ai），一路長上去。**摘要器一次都沒有自己叫過模型**，
    // 所以陣列長度就是輪數——跟根本沒掛摘要器分不出來。
    expect(sizes).toEqual([1, 3, 5, 7, 9, 11]);
  });

  it('fraction keep 一則逐字訊息都不留，而且每輪重新摘要一次', async () => {
    const sizes = await promptSizes({
      // trigger 用 messages 才觸發得了——上一條就是它的理由。
      trigger: { type: 'messages', value: 3 },
      keep: { type: 'fraction', value: 0.1 },
    });

    // 十一次呼叫（六輪 ＋ 五次摘要），**每一次都只帶一則**。奇數是摘要器自己那次，
    // 偶數是 agent 那一輪——而它唯一帶的那則就是摘要載體本身。
    expect(sizes).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('對照：兩邊都用 messages 就正常', async () => {
    const sizes = await promptSizes({
      trigger: { type: 'messages', value: 3 },
      keep: { type: 'messages', value: 1 },
    });

    // 同樣十一次呼叫，但 agent 那幾輪帶得到兩則（摘要 ＋ 這一輪的新訊息）。
    // **`2` 就是上一條缺的那一則。**
    expect(sizes).toEqual([1, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2]);
  });
});

/**
 * **subagent 那側的射程：spec 上的 `middleware` 到得了，而且走的是同一套同名取代。**
 *
 * 這是上面「取代只蓋到 root」那條的鏡像，兩條合起來才把射程講完整：**root 的註冊點只到
 * root，subagent 的 spec 只到那個 subagent。**
 *
 * 我們的 `foldSubAgents` 已經把它原樣傳出去了（`middleware: [approvalGate,
 * ...(spec.middleware ?? [])]`），基座的 `buildSubagentMiddleware` 則把它交給**同一個**
 * `mergeMiddlewareStack` —— 也就是 root 那條路上已經被 `stack 裡只有一個
 * SummarizationMiddleware` 釘住的那個函式。
 *
 * **這一條證的是「到得了、有生效」，不是「取代而不是多加一個」** —— 兩者在行為上分不出來
 * （見上面 `middlewareNames` 的註解）。取代那半靠的是 `mergeMiddlewareStack` 的結構：
 * 名字在 default 裡的走以 name 為鍵的 `Map`，名字不在的才進 `novelMiddleware`，所以
 * `SummarizationMiddleware` **進不了 append 那條路**。
 */
describe('subagent 自帶的 middleware 到得了那個 subagent', () => {
  it('記號只出現在 subagent 那一輪，root 的兩輪都沒有', async () => {
    const crew: NexusPlugin = {
      name: 'crew',
      apply: (registry) =>
        void registry.subagents.register({
          name: 'writer',
          description: '負責寫東西。',
          // 名字撞上內建那個，但塞的是 subagent 的 spec 而不是 root 的註冊點。
          middleware: [
            {
              name: 'SummarizationMiddleware',
              wrapModelCall: (
                request: { systemMessage: { concat: (text: string) => unknown } },
                handler: (next: unknown) => unknown,
              ) =>
                handler({ ...request, systemMessage: request.systemMessage.concat(`\n${MARKER}`) }),
            },
          ],
        } as never),
    };
    // 三輪：root 叫 subagent → subagent 回話 → root 收尾。
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '',
          toolCalls: [{ name: 'task', args: { description: '去寫', subagent_type: 'writer' } }],
        },
        { content: 'subagent 做完了。' },
        { content: '收工。' },
      ],
    });

    const { agent, dispose } = await createNexusAgent({ model, plugins: [crew] });
    try {
      await agent.invoke(toAgentInvocation('叫 writer 去做事。'));
    } finally {
      await dispose();
    }

    const prompts = model.prompts.map(systemPrompt);
    expect(prompts).toHaveLength(3);
    // 正好是「取代只蓋到 root」那條量到的 `[true, false, true]` 的鏡像。
    expect(prompts.map((prompt) => prompt.includes(MARKER))).toEqual([false, true, false]);
  });
});

/**
 * **摘要發生過這件事讀得到，但不在 `invoke()` 的回傳值裡。**
 *
 * 基座把 `_summarizationEvent`（`cutoffIndex` / `summaryMessage` / `filePath`）寫進 graph
 * state，而 **`filePath === null` 正是 [#66](https://github.com/DemianLi/nexus-agent/issues/66)
 * 那個 fail-open 的訊號** —— 基座只印一行 `console.warn`，但同一件事在 state 裡有值。
 *
 * 這一條釘的是**取得它的路徑**，因為 [#143](https://github.com/DemianLi/nexus-agent/issues/143)
 * 的成本估算掛在上面：`invoke()` 拿不到，`getState()` 拿得到，所以要 checkpointer 而且是
 * 主動讀、不是推播。基座哪天把它放進回傳值，這條會紅——那時 #143 會變便宜。
 */
describe('_summarizationEvent 的取得路徑', () => {
  it('invoke 的回傳值裡沒有，checkpointer 的快照裡有', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-evt-'));
    const backend = new ContainedFilesystemBackend({ rootDir: root });
    const model = new ScriptedChatModel({
      turns: Array.from({ length: 12 }, (_, index) => ({ content: `第 ${index + 1} 次回話。` })),
    });

    const { agent, dispose } = await createNexusAgent({
      model,
      backend,
      checkpointer: new MemorySaver(),
      plugins: [tunedSummarization(backend)],
    });

    let returned: Record<string, unknown> = {};
    try {
      for (const line of ['第一句。', '第二句。', '第三句。', '第四句。']) {
        returned = (await agent.invoke(toAgentInvocation(line), {
          configurable: { thread_id: 'event' },
        })) as unknown as Record<string, unknown>;
      }
    } finally {
      await dispose();
    }

    // 前提：這一輪真的觸發過。少了它，下面兩條斷言在一個沒摘要過的組裝上也會通過。
    expect((await historyFiles(root)).length).toBeGreaterThan(0);

    // 回傳值只有這兩格——摘要那組是 middleware 的私有 state，不在輸出通道上。
    expect(Object.keys(returned).sort()).toEqual(['files', 'messages']);

    const snapshot = await (
      agent as unknown as {
        getState: (config: unknown) => Promise<{ values: Record<string, unknown> }>;
      }
    ).getState({ configurable: { thread_id: 'event' } });
    const event = snapshot.values._summarizationEvent as
      { cutoffIndex: number; filePath: string | null } | undefined;

    expect(event).toBeDefined();
    expect(event?.cutoffIndex).toBeGreaterThan(0);
    // 落點讀得到——`null` 的那一天就是 #66 那個 fail-open 真的發生的那一天。
    expect(event?.filePath).toContain('/conversation_history/');
  });
});

/**
 * **正式路徑上跑的那組門檻是我們選的**——[#142](https://github.com/DemianLi/nexus-agent/issues/142)
 * 的決定 1 與決定 2。
 *
 * 上面每一組都是在 plugin 的 `middleware` 註冊點自己建一個摘要器；那是**測試才走的路**。
 * 這一組量的是另一件事：`createNexusAgent` 什麼都不傳的時候，root 與每個 subagent 拿到的
 * 是誰配的門檻。在這張 PR 之前答案是「基座在執行期二選一挑的」，而挑法是
 * `computeSummarizationDefaults`：模型的 `profile.maxInputTokens` 是數字就用比例，否則
 * 退到一組與模型無關的常數——**而沒有任何一側在檢查那個常數跟真實窗口的關係**。
 */
describe('正式路徑上的門檻是我們選的', () => {
  /**
   * **四格永遠一起給，而那是基座逼出來的。**
   *
   * `defaultsComputed = trigger != null` 讓 `applyModelDefaults` 收到 `trigger` 的當下就
   * return，於是只給 trigger 會同時做兩件沒有徵兆的事：arg 截斷停用，`keep` 從 fallback
   * 的 6 悄悄變成建構初值 20。設定型別把四格都設成必填就沒有「只給一格」這種寫法。
   */
  it('預設那組四格都在，而且一個 fraction 都沒有', () => {
    const settings = resolveSummarizationSettings();
    expect(settings).toEqual(DEFAULT_SUMMARIZATION);

    const types = [
      ...settings.trigger.map((threshold) => threshold.type),
      settings.keep.type,
      settings.truncateArgs.trigger.type,
      settings.truncateArgs.keep.type,
    ];
    expect(types).not.toContain('fraction');
    // 兩道並聯：token 估算靠不住時還有訊息數那道兜著。
    expect(settings.trigger.map((threshold) => threshold.type).sort()).toEqual([
      'messages',
      'tokens',
    ]);
    expect(settings.historyPathPrefix).toBe('/conversation_history');
  });

  /**
   * **型別擋不住的呼叫端由這道擋。**
   *
   * `'fraction'` 不在 {@link SummarizationThreshold} 的聯集裡，但 JS 呼叫端與 `as never`
   * 繞得過型別。兩個方向都要有一條：`trigger` 是 fail-closed（一輩子不觸發），`keep` 是
   * fail-open（一則逐字訊息都不留），**兩種壞法都不會自己出聲**。
   */
  it.each([
    ['trigger[0]', { trigger: [{ type: 'fraction', value: 0.85 }] }],
    ['keep', { keep: { type: 'fraction', value: 0.1 } }],
    [
      'truncateArgs.trigger',
      {
        truncateArgs: {
          trigger: { type: 'fraction', value: 0.8 },
          keep: { type: 'messages', value: 20 },
        },
      },
    ],
  ])('%s 用 fraction 當場拋，訊息指名是哪一格也說得出為什麼', (where, override) => {
    // **逐格斷言而不是只看 /fraction/**：四格共用同一個檢查函式，只驗共同字串的話，
    // 一個只檢查 `settings.trigger` 的 bug 會讓三條同時通過。
    expect(() => resolveSummarizationSettings(override as never)).toThrow(`summarization.${where}`);
    expect(() => resolveSummarizationSettings(override as never)).toThrow(/maxInputTokens/);
  });

  it('空的 trigger 陣列也擋——基座對它一律回 false，那等於沒有摘要器', () => {
    expect(() => resolveSummarizationSettings({ trigger: [] })).toThrow(/summarization: false/);
  });

  it('門檻的值要是正的有限數', () => {
    expect(() => resolveSummarizationSettings({ keep: { type: 'messages', value: 0 } })).toThrow(
      /正的有限數/,
    );
  });

  /**
   * **絆索：我們的模型解得出 `maxInputTokens` 的那天，這條要紅。**
   *
   * 那一天有兩個後果同時發生：比例形式開始可用（`fraction` 的兩個靜默失敗消失），而我們
   * 寫死的 `tokens: 100_000` 開始說謊（它建立在「窗口至少 128k」這個**未經實測**的假設上）。
   * 所以那不是一個該靜靜通過的變化。
   *
   * 手法照 [`harness-profile.test.ts`](./harness-profile.test.ts) 那條「真實 live model
   * 過得了這道檢查」：塞一把假 key 進環境變數、只建模型不發任何請求。**刻意不是
   * `it.skipIf(缺 key)`**——缺 key 就跳過的絆索永遠不紅。
   */
  it('live model 今天仍然解不出 maxInputTokens，所以走的是固定值那條', () => {
    const savedKey = process.env[LIVE_API_KEY_ENV];
    process.env[LIVE_API_KEY_ENV] = 'test-key-not-used';
    try {
      const defaults = computeSummarizationDefaults(createLiveModel());
      // 比例形式的話這裡是 'fraction'。
      expect(defaults.trigger.type).toBe('tokens');
      expect(defaults.keep.type).toBe('messages');
    } finally {
      if (savedKey === undefined) delete process.env[LIVE_API_KEY_ENV];
      else process.env[LIVE_API_KEY_ENV] = savedKey;
    }
  });
});

/**
 * **打底射得到每一個 subagent**——[#142](https://github.com/DemianLi/nexus-agent/issues/142)
 * 的決定 2。
 *
 * 上面那條「取代只蓋到 root」量的是 `middleware` **註冊點**的射程，而它今天仍然只到 root。
 * 這一組量的是另一條路：`foldSubAgents` 逐個 subagent 把我們配的那份注進 `spec.middleware`，
 * 走的是同一套同名取代（`buildSubagentMiddleware` 呼叫的是**同一個** `mergeMiddlewareStack`）。
 *
 * 判準是 `historyPathPrefix`：基座那份寫死用 `/conversation_history`，我們配的用別的。
 * **落在自訂前綴底下的檔案有兩份**（root 一份、subagent 一份——`EXCLUDED_STATE_KEYS` 雙向
 * 排除 `_summarizationSessionId`，所以 subagent 自己生一個新的 session id），而
 * `/conversation_history` 底下一份都沒有。少了打底的話，subagent 那份會落在後者。
 */
describe('我們配的那份打底到每個 subagent', () => {
  async function filesUnder(root: string, dir: string): Promise<string[]> {
    try {
      return await readdir(join(root, dir));
    } catch {
      return [];
    }
  }

  /** root 叫 subagent、subagent 自己再叫一次工具——兩邊都累積得到門檻。 */
  function crewModel(): ScriptedChatModel {
    return new ScriptedChatModel({
      turns: [
        {
          content: '',
          toolCalls: [{ name: 'task', args: { description: '去寫', subagent_type: 'writer' } }],
        },
        { content: '', toolCalls: [{ name: ECHO_TOOL_NAME, args: { message: '一' } }] },
        { content: '（subagent 那側的摘要）' },
        { content: 'subagent 做完了。' },
        { content: '（root 那側的摘要）' },
        { content: '收工。' },
        { content: '多的一輪，腳本用不到就不會被消費。' },
      ],
    });
  }

  const crew: NexusPlugin = {
    name: 'crew',
    apply: (registry) =>
      void registry.subagents.register({ name: 'writer', description: '負責寫東西。' }),
  };

  it('自訂前綴底下有 root 與 subagent 各一份，基座那個前綴是空的', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-sum-'));
    const model = crewModel();

    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      plugins: [crew, createEchoPlugin()],
      summarization: {
        historyPathPrefix: '/ours',
        trigger: [{ type: 'messages', value: 3 }],
        keep: { type: 'messages', value: 1 },
      },
    });

    try {
      await agent.invoke(toAgentInvocation('叫 writer 去做事。'));
    } finally {
      await dispose();
    }

    expect(await filesUnder(root, 'ours')).toHaveLength(2);
    expect(await filesUnder(root, 'conversation_history')).toHaveLength(0);
  });

  /**
   * **subagent 自己帶的同名 middleware 贏得過打底那份，而那是選的。**
   *
   * 陣列順序決定同名誰贏（`mergeMiddleware$1` 是以 `name` 為鍵的 `Map`，後設的覆蓋前設的），
   * 而 `foldSubAgents` 把我們那份排在 `spec.middleware` **之前**。這是「打底」不是「強制」：
   * 跟同一個函式裡 `tools` 那條軸線一致（全域打底 → 自帶的 → 該層註冊的），因為摘要門檻是
   * 效能與正確性的預設值，不是安全邊界。安全邊界那幾格（`permissions`、核准閘門）維持
   * 全域勝，沒有動。
   *
   * **這條分得出兩個答案**：排到 `spec.middleware` 之後的話記號不會出現。
   */
  it('subagent 自帶一個同名的，贏的是它', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-sum-'));
    const withOwn: NexusPlugin = {
      name: 'crew-with-own',
      apply: (registry) =>
        void registry.subagents.register({
          name: 'writer',
          description: '負責寫東西。',
          middleware: [
            {
              name: 'SummarizationMiddleware',
              wrapModelCall: (
                request: { systemMessage: { concat: (text: string) => unknown } },
                handler: (next: unknown) => unknown,
              ) =>
                handler({ ...request, systemMessage: request.systemMessage.concat(`\n${MARKER}`) }),
            },
          ] as never,
        }),
    };
    // 三輪：root 叫 subagent → subagent 回話 → root 收尾。
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '',
          toolCalls: [{ name: 'task', args: { description: '去寫', subagent_type: 'writer' } }],
        },
        { content: 'subagent 做完了。' },
        { content: '收工。' },
      ],
    });

    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      plugins: [withOwn],
    });

    try {
      await agent.invoke(toAgentInvocation('叫 writer 去做事。'));
    } finally {
      await dispose();
    }

    // 記號只在 subagent 那一輪——root 兩輪拿的是我們打底的那份，它不碰 system prompt。
    expect(model.prompts.map((prompt) => systemPrompt(prompt).includes(MARKER))).toEqual([
      false,
      true,
      false,
    ]);
  });

  /**
   * **`summarization: false` 真的把整件事還回去。**
   *
   * 沒有這條的話，「打底生效」與「打底根本沒建」在別的測試裡分不出來——它們都會讓歷史
   * 落在某個地方。這條釘的是逃生口本身：關掉之後前綴回到基座寫死的那個。
   */
  it('關掉之後歷史回到基座寫死的前綴', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-sum-'));
    const backend = new ContainedFilesystemBackend({ rootDir: root });
    const model = crewModel();

    const { agent, dispose } = await createNexusAgent({
      model,
      backend,
      plugins: [crew, createEchoPlugin(), tunedSummarization(backend)],
      summarization: false,
    });

    try {
      await agent.invoke(toAgentInvocation('叫 writer 去做事。'));
    } finally {
      await dispose();
    }

    expect(await filesUnder(root, 'ours')).toHaveLength(0);
    expect((await filesUnder(root, 'conversation_history')).length).toBeGreaterThan(0);
  });
});

/**
 * **什麼都不傳的時候，門檻真的碰得到，而且只碰一次。**
 *
 * 這條同時證三件事，而且用的是**預設值本身**——不是測試自己塞的低門檻：
 *
 * 1. 打底在正式路徑上生效（`createNexusAgent` 沒有任何 summarization 參數）
 * 2. `messages: 60` 那道在一場跑滿 {@link DEFAULT_RECURSION_LIMIT} 的迴圈裡碰得到
 * 3. **沒有重摘迴圈**——摘要器只多叫了一次模型。`keep` 用訊息數而 `trigger` 有一道用
 *    token，兩邊不同尺，最壞情況是留下的那些又立刻越過門檻、每一輪都重摘一次
 *    （`keep: fraction` 那組量到的正是這個病徵）。多一次就是多一次。
 *
 * 對照組在 [`agent-factory.test.ts`](./agent-factory.test.ts) 的「迴圈上限」：那條明著傳
 * `summarization: false`，模型剛好少被叫一次。
 *
 * **輪數的換算在 [#147](https://github.com/DemianLi/nexus-agent/issues/147) 之後變了**：
 * 打底的提醒器掛在 `beforeModel` 上，那在圖裡是一個節點，所以每一輪是三格而不是兩格，
 * 100 換算成 33 輪。這條照樣不傳任何參數——量的就是**真正的預設組裝**，換算跟著它走。
 */
describe('預設門檻在跑滿的迴圈裡摘要一次', () => {
  it('模型被叫的次數比迴圈上限換算多一次，多的那次是摘要器', async () => {
    const model = new LoopingChatModel();
    const { agent, dispose } = await createNexusAgent({ model, plugins: [createEchoPlugin()] });

    try {
      await expect(agent.invoke(toAgentInvocation('一直跑'))).rejects.toThrow(/Recursion limit/);
    } finally {
      await dispose();
    }

    // 預設組裝每輪三格：`模型輪數 = floor((上限 - 1) / 3)`。
    const agentTurns = Math.floor((DEFAULT_RECURSION_LIMIT - 1) / 3);
    expect(model.calls).toBe(agentTurns + 1);
  });
});

/**
 * **`trigger` 用 token、`keep` 用訊息數，兩邊不同尺——這條量的是那個縫平常不會裂開。**
 *
 * 病徵長這樣：摘要留下 K 則，那 K 則的 token 總量又立刻越過門檻，於是**每一輪都重摘一次**，
 * 每輪的 prompt 訊息數塌成一條平線。`keep: fraction` 那組量到的 `[1,1,1,…]` 就是它，
 * 只是成因不同。
 *
 * 那為什麼 `keep` 不乾脆也用 token？因為 `determineCutoffIndex` 的 token 分支是從最新那則
 * 往前累加、超過就切：
 *
 * ```js
 * if (tokensKept + msgTokens > targetTokenCount) { rawCutoff = i + 1; break; }
 * ```
 *
 * 最新那一則自己就超過門檻時（一個剛回來的超大工具結果），第一圈就
 * `rawCutoff = messages.length`——**一則都不留**。那是 fail-open，跟我們拒絕 `fraction`
 * 的理由同型。`messages` 分支是 `messages.length - keep.value`，恆定留得下東西。所以這裡
 * 選的是「保證留得下」。
 *
 * **代價是誠實的：退化條件真的存在，只是這條測不到它。** 退化要 `keep 則數 × 每則 token
 * ≥ trigger`——用預設值換算是留下的 20 則平均每則超過 5,000 token。單一則就辦得到（讀一個
 * 大檔的工具結果），而那時真正的解法是**壓縮前先剪掉過大的工具結果**
 * （[#149](https://github.com/DemianLi/nexus-agent/issues/149)，dsh 的 `ctx.toolResultPruner`
 * 做的正是這件事），不是把 `keep` 換成一把會 fail-open 的尺。這條盯的是「一般長對話不該
 * 退化」，那條退路留給 #149。
 *
 * 設定是等比縮小的：`tokens: 3_000` 配預設的 `keep: 20 則`，訊息長度普通——結構上等同
 * 預設的 `tokens: 100_000` 配一般大小的訊息。
 */
describe('一般長對話不會退化成逐輪重摘', () => {
  it('prompt 的訊息數是鋸齒不是平線', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-sum-'));
    // 每則約 100 token（`countTokensApproximately` 約當 4 字元 1 token）。
    const body = '這是一段普通長度的回話。'.repeat(32);
    const model = new ScriptedChatModel({
      turns: Array.from({ length: 40 }, () => ({ content: body })),
    });

    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      checkpointer: new MemorySaver(),
      plugins: [],
      summarization: { trigger: [{ type: 'tokens', value: 3_000 }] },
    });

    try {
      for (let index = 0; index < 15; index += 1) {
        await agent.invoke(toAgentInvocation(`第 ${index + 1} 句。`), {
          configurable: { thread_id: 'saw' },
        });
      }
    } finally {
      await dispose();
    }

    const sizes = model.prompts.map(
      (prompt) => prompt.filter((message) => message.getType() !== 'system').length,
    );
    // 前提：真的摘要過。少了它，一個門檻根本沒碰到的組裝也會讓下面通過。
    expect((await historyFiles(root)).length).toBeGreaterThan(0);
    // 平線的話最大值會是 1（只剩摘要載體）。`keep: 20 則`留得下東西，所以看得到爬升。
    expect(Math.max(...sizes)).toBeGreaterThan(20);
    // 摘要器自己那幾輪的 prompt 也算在裡面，所以不要求「一則 1 都沒有」，要求的是它不是常態。
    expect(sizes.filter((size) => size <= 1).length).toBeLessThan(sizes.length / 2);
  });
});

/**
 * **壓縮前先剪掉過大的工具結果**（[#149](https://github.com/DemianLi/nexus-agent/issues/149)）。
 *
 * 剪刀不是一顆獨立的 middleware，是**包在同名取代的那顆摘要器外面**——那不是選的、是唯一
 * 的路，理由見 [`tool-result-pruner.ts`](../../../packages/nexus-core/src/tool-result-pruner.ts)
 * 檔頭的偏離登記二。
 *
 * ## 三個 fixture 上的細節，寫在這裡免得下一個人以為是隨手挑的
 *
 * **一、工具的參數是空的，體積全在結果上。** 用 echo 那種「參數多大結果就多大」的工具會讓
 * 對照組失效：剪刀不碰工具**參數**（那是 `truncateArgs` 的事），所以參數裡那坨字照樣撐著
 * 壓力，剪完還是會摘要。
 *
 * **二、單則工具結果不能超過 8 萬字元，否則輪不到我們。** `createFilesystemMiddleware` 的
 * `wrapToolCall` 有一條**自己的**大結果處置：`toolTokenLimitBeforeEvict` 預設 `2e4`，
 * 文字超過 `4 * 2e4 = 80,000` 字元就把結果**寫進檔案系統**、換成一段頭尾預覽加一句
 * 「用 read_file 自己去讀」（`TOO_LARGE_TOOL_MSG`，`deepagents@1.13.1`
 * `dist/langsmith-zm0ILQsV.js:1574`、`:2426`、`:2507-2510`；`read_file` 那幾個檔案工具自己
 * 被排除在外）。它掛在**工具那一格**，比摘要器早得多，所以：
 *
 * > **這把剪刀的射程是「8,192 到 80,000 字元」這一段。** 上面那截被基座搬去檔案系統了
 * > ——而那件事其實是 dsh `spill/` 的形狀（[#151](https://github.com/DemianLi/nexus-agent/issues/151)），
 * > 不是 pruner 的。下面那截本來就在預算內。
 *
 * 這一段是量出來的、也是這組測試最容易被寫錯的地方：第一版 fixture 用 50 萬字元，結果
 * 每一格都在測基座的 eviction，一條都沒測到剪刀。
 *
 * **三、`keep` 要調到 1 才看得到「摘要那次模型呼叫沒有發生」。** 預設的 `keep: 20 則`碰上
 * 一段只有幾則訊息的對話，`determineCutoffIndex` 會算出 `cutoffIndex <= 0`、直接
 * `return handler(...)`——**摘要本來就不會呼叫模型**，那樣的綠是假的。
 */
describe('壓縮前先剪掉過大的工具結果', () => {
  /** 一則工具結果：超過剪刀的 8,192，但**低於基座 eviction 的 80,000**。 */
  const BULK = 'X'.repeat(40_000);

  /** 一個參數是空的、結果很大的工具。體積全在結果上，剪刀才有事做。 */
  function bulkPlugin(payload: string, subagent = false): NexusPlugin {
    return {
      name: 'bulk',
      apply: (registry) => {
        registry.tools.register(
          tool(() => payload, {
            name: 'bulk',
            description: '回一大坨東西',
            schema: z.object({}),
          }),
        );
        if (subagent) registry.subagents.register({ name: 'worker', description: '幹活的。' });
      },
    };
  }

  /**
   * 叫 `count` 次 bulk 再收尾的腳本。
   *
   * `spare` 是**留給摘要器自己那次模型呼叫**的。腳本用完會拋，所以「摘要器動手了」在
   * 沒有備料的腳本上會表現成一個看不出所以然的例外，而不是一個多出來的呼叫次數。
   */
  function bulkTurns(count = 1, spare = 0): ScriptedChatModel {
    return new ScriptedChatModel({
      turns: [
        ...Array.from({ length: count }, () => ({
          content: '',
          toolCalls: [{ name: 'bulk', args: {} }],
        })),
        { content: '看完了。' },
        ...Array.from({ length: spare }, (_, index) => ({ content: `備料 ${index + 1}。` })),
      ],
    });
  }

  /** 某一輪 prompt 裡的工具結果。 */
  function toolResults(prompt: readonly BaseMessage[]): ToolMessage[] {
    return prompt.filter((message) => message.getType() === 'tool') as ToolMessage[];
  }

  /** 這一整場裡有沒有哪一輪送出過剪過的工具結果。 */
  function prunedPrompts(model: ScriptedChatModel): number {
    return model.prompts.filter((prompt) =>
      toolResults(prompt).some((message) =>
        String(message.content).includes(TOOL_RESULT_PRUNE_MARKER),
      ),
    ).length;
  }

  /**
   * **零 plugin、零設定的預設組裝就會剪。**
   *
   * 預設門檻是 10 萬 token，換算約 40 萬字元，而單則不能超過 8 萬（見檔頭第二點）——所以
   * 產品預設下真正會踩到剪刀的形狀是「**很多則中等大小的結果累積起來**」，不是一則巨大的。
   * 這一條就照那個形狀跑：12 次 4 萬字元。
   */
  it('零 plugin 的預設組裝就會剪，而且剪出來是頭 ＋ 標記 ＋ 尾', async () => {
    const model = bulkTurns(12);
    const { agent, dispose } = await createNexusAgent({ model, plugins: [bulkPlugin(BULK)] });
    try {
      await agent.invoke(toAgentInvocation('去拿十二坨。'));
    } finally {
      await dispose();
    }

    expect(prunedPrompts(model)).toBeGreaterThan(0);
    const pruned = toolResults(model.prompts.at(-1)!).filter((message) =>
      String(message.content).includes(TOOL_RESULT_PRUNE_MARKER),
    );
    expect(pruned.length).toBeGreaterThan(0);

    const text = String(pruned[0]!.content);
    expect(text.startsWith('X'.repeat(DEFAULT_TOOL_RESULT_PRUNE.headChars))).toBe(true);
    expect(text.endsWith('X'.repeat(DEFAULT_TOOL_RESULT_PRUNE.tailChars))).toBe(true);
    expect(codePointLength(text)).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_PRUNE.thresholdChars);
    // 呼叫的身分不准變——變了模型就對不回那次呼叫。
    expect(pruned[0]!.tool_call_id).toBeTruthy();
    expect(pruned[0]!.name).toBe('bulk');
  });

  /** 對照組：小輸出一字不動，壓力再大也一樣。 */
  it('沒超過預算的工具結果一字不動', async () => {
    const small = '小'.repeat(100);
    const model = bulkTurns();
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [bulkPlugin(small)],
      summarization: { trigger: [{ type: 'messages', value: 2 }] },
    });
    try {
      await agent.invoke(toAgentInvocation('去拿一點點。'));
    } finally {
      await dispose();
    }

    expect(String(toolResults(model.prompts[1]!)[0]!.content)).toBe(small);
  });

  /**
   * **壓力沒到就一個字都不准碰**——dsh 那句「低于压力的对话绝不被碰」。
   *
   * 這一條是 `aboutToCompact` 那道閘門唯一的承重測試。少了它，「剪得對」那幾條在一個
   * 「每次超預算就剪」的版本上照樣全綠——而那正是卡上點名的那筆偏離。
   */
  it('壓力沒到就不剪，即使結果已經超出預算', async () => {
    const model = bulkTurns();
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [bulkPlugin(BULK)],
      // 4 萬字元約 1 萬 token，離門檻遠得很；訊息也只有四則。
      summarization: {
        trigger: [
          { type: 'tokens', value: 100_000 },
          { type: 'messages', value: 60 },
        ],
      },
    });
    try {
      await agent.invoke(toAgentInvocation('去拿一大坨。'));
    } finally {
      await dispose();
    }

    expect(String(toolResults(model.prompts[1]!)[0]!.content)).toBe(BULK);
  });

  /**
   * **主判準：剪完壓力就沒了，摘要那次模型呼叫沒有發生。**
   *
   * 兩輪腳本＝兩次模型呼叫。摘要器要是動了手，會多出第三次。門檻壓到 5,000 token
   * （約 2 萬字元）：4 萬字元的結果越得過，剪成 5 千多字元之後就越不過了。
   */
  it('剪完壓力落回門檻下，摘要那次模型呼叫沒有發生', async () => {
    const model = bulkTurns();
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [bulkPlugin(BULK)],
      summarization: {
        trigger: [{ type: 'tokens', value: 5_000 }],
        keep: { type: 'messages', value: 1 },
      },
    });
    try {
      await agent.invoke(toAgentInvocation('去拿一大坨。'));
    } finally {
      await dispose();
    }

    expect(model.prompts).toHaveLength(2);
    expect(String(toolResults(model.prompts[1]!)[0]!.content)).toContain(
      TOOL_RESULT_PRUNE_MARKER,
    );
  });

  /**
   * **同一格拔掉剪刀就紅——這條在證上一條不是碰巧綠的。**
   *
   * 拔法是掛一顆同名的**基座原版**摘要器（設定一模一樣）把我們那顆換掉。名字撞上，
   * `mergeMiddlewareStack` 就地取代，於是這一格是「有摘要器、沒有剪刀」。
   */
  it('拔掉剪刀（換成基座原版摘要器）就多一次模型呼叫', async () => {
    const settings = resolveSummarizationSettings({
      trigger: [{ type: 'tokens', value: 5_000 }],
      keep: { type: 'messages', value: 1 },
    });
    // 摘要器一動手就要有地方寫歷史。這一格的重點是「有摘要器、沒有剪刀」，所以 backend
    // 要給——不給的話它會在 `resolveBackend` 當場炸掉，測到的就變成別的東西了。
    const backend = new ContainedFilesystemBackend({
      rootDir: await mkdtemp(join(tmpdir(), 'nexus-bare-')),
    });
    const bare: NexusPlugin = {
      name: 'bare-summarization',
      apply: (registry) =>
        void registry.middleware.use(
          createSummarizationMiddleware({
            backend,
            trigger: [...settings.trigger],
            keep: { ...settings.keep },
            historyPathPrefix: settings.historyPathPrefix,
            truncateArgsSettings: {
              trigger: { ...settings.truncateArgs.trigger },
              keep: { ...settings.truncateArgs.keep },
            },
          }) as never,
        ),
    };
    const model = bulkTurns(1, 3);
    const { agent, dispose } = await createNexusAgent({
      model,
      backend,
      plugins: [bulkPlugin(BULK), bare],
      summarization: {
        trigger: [{ type: 'tokens', value: 5_000 }],
        keep: { type: 'messages', value: 1 },
      },
    });
    try {
      await agent.invoke(toAgentInvocation('去拿一大坨。'));
    } finally {
      await dispose();
    }

    // 第三次就是摘要自己那一次——剪刀在場時它不存在。
    expect(model.prompts.length).toBeGreaterThan(2);
    expect(prunedPrompts(model)).toBe(0);
  });

  /**
   * **`summarization: false` 就沒有剪。**
   *
   * 剪刀搭在摘要器上，摘要器不在就一起不在。這與 dsh 一致（那邊的 pruner 也是 optional，
   * `ctx.get('toolResultPruner')` 拿不到就不剪），而且**它不是第二顆開關**——我們沒有加
   * 開關。這條釘住那個耦合，免得下一個人以為關掉摘要還會剩下剪刀。
   */
  it('關掉摘要就一起沒有剪刀', async () => {
    const model = bulkTurns();
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [bulkPlugin(BULK)],
      summarization: false,
    });
    try {
      await agent.invoke(toAgentInvocation('去拿一大坨。'));
    } finally {
      await dispose();
    }

    expect(String(toolResults(model.prompts[1]!)[0]!.content)).toBe(BULK);
  });

  /** 射程：subagent 那半也要剪，理由與 `foldSubAgents` 打底那條線相同。 */
  it('subagent 裡的工具結果照樣剪', async () => {
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '',
          toolCalls: [{ name: 'task', args: { description: '去拿', subagent_type: 'worker' } }],
        },
        { content: '', toolCalls: [{ name: 'bulk', args: {} }] },
        { content: 'subagent 看完了。' },
        { content: '收工。' },
      ],
    });
    // 摘要器真的可能在 subagent 那一輪動手，而它一動手就要有地方寫歷史——不給 backend
    // 的話 `summarizeMessages` 會在 `resolveBackend` 當場炸掉。
    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({
        rootDir: await mkdtemp(join(tmpdir(), 'nexus-prune-sub-')),
      }),
      plugins: [bulkPlugin(BULK, true)],
      summarization: { trigger: [{ type: 'tokens', value: 5_000 }] },
    });
    try {
      await agent.invoke(toAgentInvocation('叫 worker 去拿。'));
    } finally {
      await dispose();
    }

    // 第三次呼叫是 subagent 收到工具結果之後那一輪。
    expect(model.prompts.length).toBeGreaterThanOrEqual(3);
    expect(String(toolResults(model.prompts[2]!)[0]!.content)).toContain(
      TOOL_RESULT_PRUNE_MARKER,
    );
  });

  /**
   * **摘要已經發生過之後再剪，配對不能斷。**
   *
   * 基座的 `getEffectiveMessages` 是 `[summary, ...messages.slice(cutoffIndex)]`，而那個
   * `cutoffIndex` 是**前幾輪**存進 state 的。剪刀要是少回傳一則訊息，這個 slice 就切在錯
   * 的位置，AI／Tool 配對當場斷掉——**而且不會拋**，只會讓模型收到一段對不起來的歷史。
   */
  it('state 裡已經有 _summarizationEvent 時，剪過的那輪照樣走得完', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-prune-'));
    const backend = new ContainedFilesystemBackend({ rootDir: root });
    const model = new ScriptedChatModel({
      // **腳本的輪數不能照 invoke 數去數**：摘要器自己也會吃掉一輪（它要叫模型寫摘要），
      // 而它哪一輪動手是基座決定的。所以 bulk 排在最前面、後面墊足夠多的填充輪——這一條
      // 要的是「摘要發生過**之後**還會剪」，而那從第二次 invoke 起就成立了。
      turns: [
        { content: '', toolCalls: [{ name: 'bulk', args: {} }] },
        ...Array.from({ length: 12 }, (_, index) => ({ content: `第 ${index + 1} 句。` })),
      ],
    });
    const { agent, dispose } = await createNexusAgent({
      model,
      backend,
      checkpointer: new MemorySaver(),
      plugins: [bulkPlugin(BULK)],
      summarization: {
        trigger: [
          { type: 'messages', value: 3 },
          { type: 'tokens', value: 5_000 },
        ],
        keep: { type: 'messages', value: 1 },
      },
    });

    let last: { readonly messages: readonly BaseMessage[] } = { messages: [] };
    try {
      for (const line of ['一。', '二。', '三。']) {
        last = (await agent.invoke(toAgentInvocation(line), {
          configurable: { thread_id: 'prune' },
        })) as unknown as { readonly messages: readonly BaseMessage[] };
      }
    } finally {
      await dispose();
    }

    // 前提：真的摘要過。少了它這條測的就不是「摘要之後」。
    expect((await historyFiles(root)).length).toBeGreaterThan(0);
    // 走得完，而且工具那一輪的結果被剪過。
    expect(last.messages.at(-1)?.getType()).toBe('ai');
    expect(prunedPrompts(model)).toBeGreaterThan(0);
  });

  /**
   * **基座 8 萬字元那條線是我們的射程上界，所以它是一條絆索。**
   *
   * 基座哪天調了 `toolTokenLimitBeforeEvict`（或把 eviction 拿掉），這把剪刀能碰到的區間
   * 就跟著變，而**兩邊都不會拋**。這一條把那條線釘在測試裡：超過 8 萬字元的結果**不會**
   * 帶著我們的標記，它會被換成基座那句 `read_file` 指路。
   */
  it('超過 8 萬字元的結果輪不到剪刀——基座先把它搬去檔案系統', async () => {
    const model = bulkTurns();
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [bulkPlugin('X'.repeat(80_001))],
      summarization: { trigger: [{ type: 'tokens', value: 5_000 }] },
    });
    try {
      await agent.invoke(toAgentInvocation('去拿一坨超大的。'));
    } finally {
      await dispose();
    }

    const text = String(toolResults(model.prompts[1]!)[0]!.content);
    expect(text).not.toContain(TOOL_RESULT_PRUNE_MARKER);
    expect(text).toContain('read_file');
  });
});
