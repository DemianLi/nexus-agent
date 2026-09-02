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
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import type { NexusPlugin } from '@nexus/core';
import { createSummarizationMiddleware } from 'deepagents';
import { describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
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
      // 位置也沒動——原地取代，不是刪掉再追加到尾巴。尾巴上那個核准閘門是 fold 每次
      // 都掛的（[#111](https://github.com/DemianLi/nexus-agent/issues/111)），它排在
      // 基座那幾個之後、其餘 plugin middleware 之前。
      expect(names).toEqual([
        'FilesystemMiddleware',
        'subAgentMiddleware',
        'SummarizationMiddleware',
        'patchToolCallsMiddleware',
        'nexusApprovalGate',
      ]);

      await agent.invoke(toAgentInvocation('嗨。'));
      // 那一個是我們的：內建的 SummarizationMiddleware 不碰 system prompt。
      expect(systemPrompt(model.lastPrompt)).toContain(MARKER);
    } finally {
      await dispose();
    }
  });

  /**
   * **root 換掉不影響 subagent**——升版絆索，也是這條縫的射程邊界。
   *
   * `createSubagentDefaultMiddleware` 每個 subagent 各建一份新的
   * `createSummarizationMiddleware({ backend })`，而 `buildSubagentMiddleware` 只併
   * `input.middleware`——root 從 `middleware` 參數傳進去的那個到不了 subagent。
   *
   * 這件事的實際後果：**長任務的 token 大戶正是 subagent**，所以「靠換掉 root 那個來控
   * token」在結構上就不完整。要嘛每個 subagent 定義自己帶，要嘛承認這個邊界。
   *
   * （`harnessProfile.excludedMiddleware` 是另一條縫，而且它對每個 subagent 都生效——
   * 但它只能**排除**不能替換，排掉等於 subagent 完全沒有摘要，長對話直接爆 context。
   * 而且它走的是全域 profile registry、綁在模型識別字串上，不是組裝點的參數。所以那不是
   * 這個邊界的解法，詳見 PR 內文。）
   */
  it('取代只蓋到 root，subagent 那輪拿的還是內建的', async () => {
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
