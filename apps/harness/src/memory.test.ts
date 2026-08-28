/**
 * 記憶層的**行為**驗收（Phase 3 `feat/memory-plugin`）。
 *
 * 每一條看的都是**送進模型的那份 system prompt**——記憶這個擴充點沒有工具、沒有回傳值、
 * 沒有事件，它唯一的產物就是 prompt 裡多出來的一段。斷言 registry 裡有幾筆來源證明不了
 * 任何事：`@nexus/plugin-memory` 那邊的薄測試做的是那件事，這裡做的是另一件。
 *
 * 五條裡有三條是**斷言缺陷**的（`deny 擋不住`、`subagent 沒有記憶`、`空檔與不存在同形`）。
 * 跟 [`contained-backend.test.ts`](./contained-backend.test.ts) 那組升版絆索同樣的用意：
 * 這些是 `deepagents@1.13.1` 的實際形狀，寫成可執行的證據比寫在註解裡強，而且基座哪天
 * 改了它們會紅——紅了不是壞消息，是該回頭看的時刻。
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import type { NexusPlugin } from '@nexus/core';
import { createMemoryPlugin } from '@nexus/plugin-memory';
import { StateBackend } from 'deepagents';
import { describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

/** 一輪 prompt 裡的 system 訊息。基座把記憶併進 system prompt，不是併進對話。 */
function systemPrompt(messages: readonly BaseMessage[]): string {
  return messages
    .filter((message) => message.getType() === 'system')
    .map((message) => message.text)
    .join('\n');
}

/** 一個有 AGENTS.md 的可寫根。 */
async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-memory-'));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(root, name), content);
  }
  return root;
}

const CODENAME = '使用者的代號是胡桃。';

describe('記憶進到 system prompt', () => {
  it('多來源依註冊順序串進 prompt', async () => {
    const root = await workspace({
      'AGENTS.md': CODENAME,
      'PROJECT.md': '這個 repo 用 pnpm。',
    });
    const model = new ScriptedChatModel({ turns: [{ content: '知道了。' }] });

    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      plugins: [createMemoryPlugin({ sources: ['/PROJECT.md', '/AGENTS.md'] })],
    });

    try {
      await agent.invoke(toAgentInvocation('嗨。'));
    } finally {
      await dispose();
    }

    const prompt = systemPrompt(model.lastPrompt);
    expect(prompt).toContain('pnpm');
    expect(prompt).toContain('胡桃');
    // 順序有意義：基座的 `formatMemoryContents(contents, sources)` 照註冊順序串，
    // 而後面的內容在 prompt 裡通常壓得過前面的。
    expect(prompt.indexOf('pnpm')).toBeLessThan(prompt.indexOf('胡桃'));
  });

  /**
   * **`permissions` 對記憶載入完全沒有作用**——這一條是斷言缺陷，而且缺陷的方向跟直覺相反。
   *
   * `checkPermission` 只在七個工具工廠裡被呼叫（`createReadFileTool` 那一票），**不在
   * backend 方法上**。而 `loadMemoryFromBackend` 呼叫的是 `backend.downloadFiles` /
   * `backend.read`——backend 方法、不是工具。所以一條蓋到記憶檔的 deny 規則**擋不住它**：
   * 檔案內容照樣被注入 system prompt。
   *
   * 這跟 [#66](https://github.com/DemianLi/nexus-agent/issues/66) 記的 `uploadFiles`
   * 是同一件事的第三次現身：**規則表管工具，管不到 backend 方法**。差別在失敗方向——
   * offload 那邊是「該寫的沒寫成」，這邊是「該擋的沒擋住」，而後者是把檔案內容送進模型
   * 的 context，比前者嚴重。
   *
   * 這條同時推翻了開發計劃原本的說法（「一條蓋到記憶檔的 deny 規則 = agent 安靜地沒有
   * 記憶」）。真正會造成「安靜地沒有記憶」的是**路徑寫錯**，而那個現在被
   * `@nexus/core` 的 `assertLoadableMemoryPath` 擋在註冊期。
   */
  it('deny 規則擋不住記憶載入——規則表管工具，管不到 backend 方法', async () => {
    const root = await workspace({ 'AGENTS.md': CODENAME });
    const model = new ScriptedChatModel({ turns: [{ content: '知道了。' }] });
    const guard: NexusPlugin = {
      name: 'guard',
      apply: (registry) => void registry.permissions.deny(['/AGENTS.md']),
    };

    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      plugins: [createMemoryPlugin(), guard],
    });

    try {
      await agent.invoke(toAgentInvocation('嗨。'));
    } finally {
      await dispose();
    }

    const prompt = systemPrompt(model.lastPrompt);
    expect(prompt).toContain('胡桃');
    // 而模型同時被指示「學到東西就用 edit_file 存起來」——存去一個規則明文禁止它寫的檔。
    // 讀得到寫不回去，是這個組合的實際結果。
    expect(prompt).toContain('edit_file');
  });

  /**
   * **讀不到與讀到空的分不出來**——靜默是構造出來的，不是意外。
   *
   * `createMemoryMiddleware` 的載入迴圈是 `if (content) contents[path] = content`：
   * 空字串是 falsy，所以一個空的 AGENTS.md 跟一個不存在的 AGENTS.md 走到同一個
   * `(No memory loaded)`。整條路上沒有 warn、沒有 throw，只有一句 `console.debug`
   * ——而且那句只在 `catch` 裡，讀成功但內容為空根本走不到。
   */
  it('空的記憶檔與不存在的記憶檔在 prompt 裡同形', async () => {
    const root = await workspace({ 'EMPTY.md': '' });

    for (const source of ['/EMPTY.md', '/MISSING.md']) {
      const model = new ScriptedChatModel({ turns: [{ content: '知道了。' }] });
      const { agent, dispose } = await createNexusAgent({
        model,
        backend: new ContainedFilesystemBackend({ rootDir: root }),
        plugins: [createMemoryPlugin({ sources: [source] })],
      });

      try {
        await agent.invoke(toAgentInvocation('嗨。'));
      } finally {
        await dispose();
      }

      expect(systemPrompt(model.lastPrompt), source).toContain('(No memory loaded)');
    }
  });
});

/**
 * **subagent 拿不到 root 的記憶**——升版絆索。
 *
 * `buildSubagentMiddleware(input, isForkable)` 只在 `isForkable` 為真時把 root 的 memory
 * middleware 併進去，而 `SubAgent` 定義上沒有 `memory` 欄位可以自帶
 * （`createSubagentDefaultMiddleware` 有 `input.skills` 分支，沒有對應的 memory 分支）。
 * 內建的 general-purpose subagent 也一樣拿不到：它走 `normalizeSubagentSpec`
 * （`isForkable` 為 false），而它那次 `mergeMiddlewareStack` 帶 `{ appendNew: false }`
 * ——連從 `middleware` 參數塞一個同名的進去都會被丟掉。
 *
 * 也就是「subagent 也有記憶」在 1.13.1 上沒有任何公開介面做得到。這是基座的邊界，
 * 跟 `feat/summarization-tuning` 記的「root 換掉不影響 subagent」是同一種邊界。
 */
describe('subagent 的記憶邊界', () => {
  it('root 那幾輪有 <agent_memory>，subagent 那輪沒有', async () => {
    const root = await workspace({ 'AGENTS.md': CODENAME });
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
      plugins: [createMemoryPlugin(), crew],
    });

    try {
      await agent.invoke(toAgentInvocation('叫 writer 去做事。'));
    } finally {
      await dispose();
    }

    const prompts = model.prompts.map(systemPrompt);
    expect(prompts).toHaveLength(3);
    // 第二輪是 subagent 的。`lastPrompt` 看不到它——root 在 subagent 之後還會再問一次。
    expect(prompts[0]).toContain('<agent_memory>');
    expect(prompts[1]).not.toContain('<agent_memory>');
    expect(prompts[2]).toContain('<agent_memory>');
  });
});

/**
 * **記憶在 state 裡快取，一個 thread 只載一次。**
 *
 * `beforeAgent` 開頭是 `if ("memoryContents" in state && state.memoryContents != null) return;`
 * ——配上 checkpointer，同一個 thread 的第二輪之後永遠拿第一輪那份。thread 中途改
 * AGENTS.md 不生效，而這件事沒有任何提示。
 */
describe('記憶的快取邊界', () => {
  it('同一個 thread 中途改檔不重載，換一個 thread 才看得到新的', async () => {
    const root = await workspace({ 'AGENTS.md': '第一版：代號胡桃。' });
    const model = new ScriptedChatModel({
      turns: [{ content: '一。' }, { content: '二。' }, { content: '三。' }],
    });

    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      checkpointer: new MemorySaver(),
      plugins: [createMemoryPlugin()],
    });

    try {
      await agent.invoke(toAgentInvocation('第一句。'), {
        configurable: { thread_id: 'memory-cache' },
      });
      await writeFile(join(root, 'AGENTS.md'), '第二版：代號鍾離。');

      await agent.invoke(toAgentInvocation('第二句。'), {
        configurable: { thread_id: 'memory-cache' },
      });
      const sameThread = systemPrompt(model.lastPrompt);
      expect(sameThread).toContain('胡桃');
      expect(sameThread).not.toContain('鍾離');

      // 換 thread ＝ 換一份 state ＝ 快取沒了。這一條同時證明上面那條不是「檔案沒改成」。
      await agent.invoke(toAgentInvocation('第三句。'), {
        configurable: { thread_id: 'memory-cache-2' },
      });
      const freshThread = systemPrompt(model.lastPrompt);
      expect(freshThread).toContain('鍾離');
      expect(freshThread).not.toContain('胡桃');
    } finally {
      await dispose();
    }
  });
});

/**
 * **「記憶留不留得住」是 backend 的問題，不是 checkpointer 的。**
 *
 * 這一組是狀態儲存三軸決策的可執行證據（開發計劃第 7 節決策 4）。memory middleware
 * 唯讀、不註冊任何工具，寫回去唯一的路是模型自己呼叫 `write_file` / `edit_file`
 * ——那條路的終點是 backend。所以換掉 checkpointer 改變不了任何事，換掉 backend 才會。
 *
 * 兩個 agent 都是全新建的（沒有共用 checkpointer、沒有共用 state），差別只有 backend。
 */
describe('記憶的保存軸', () => {
  /**
   * 第一個 agent 用 `write_file` 寫記憶，第二個全新的 agent 讀。
   *
   * **回傳值帶著第一步的工具結果**，因為兩條斷言裡有一條是「讀不到」——少了它，一個
   * `write_file` 根本沒寫成的組裝也會讓那條通過，而且是通過在錯的理由上。
   */
  async function writeThenReload(
    backendFor: () => ContainedFilesystemBackend | StateBackend,
  ): Promise<{ readonly wrote: string; readonly prompt: string }> {
    const writer = new ScriptedChatModel({
      turns: [
        {
          content: '',
          toolCalls: [{ name: 'write_file', args: { file_path: '/AGENTS.md', content: CODENAME } }],
        },
        { content: '記下來了。' },
      ],
    });
    const first = await createNexusAgent({
      model: writer,
      backend: backendFor(),
      plugins: [createMemoryPlugin()],
    });
    let wrote = '';
    try {
      const result = await first.agent.invoke(toAgentInvocation('記住我的代號。'));
      wrote = result.messages.find((message) => message.getType() === 'tool')?.text ?? '';
    } finally {
      await first.dispose();
    }

    const reader = new ScriptedChatModel({ turns: [{ content: '記得。' }] });
    const second = await createNexusAgent({
      model: reader,
      backend: backendFor(),
      plugins: [createMemoryPlugin()],
    });
    try {
      await second.agent.invoke(toAgentInvocation('我的代號是什麼？'));
    } finally {
      await second.dispose();
    }
    return { wrote, prompt: systemPrompt(reader.lastPrompt) };
  }

  it('落磁碟的 backend 下，模型寫的記憶下一個 agent 讀得到', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-memory-'));
    const { wrote, prompt } = await writeThenReload(
      () => new ContainedFilesystemBackend({ rootDir: root }),
    );

    expect(wrote).not.toContain('error');
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(CODENAME);
    expect(prompt).toContain('胡桃');
  });

  it('StateBackend 下同樣的動作換個 agent 就沒了', async () => {
    const { wrote, prompt } = await writeThenReload(() => new StateBackend());

    // 先證明寫入本身成功，否則下一條會因為「根本沒寫進去」而通過。
    expect(wrote).toContain('/AGENTS.md');
    expect(wrote).not.toContain('error');
    expect(prompt).toContain('(No memory loaded)');
  });
});
