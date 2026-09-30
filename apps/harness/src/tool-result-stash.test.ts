/**
 * 工具結果暫存那一格 —— [#170](https://github.com/DemianLi/nexus-agent/issues/170)。
 *
 * 守的是一件會**丟資料**的事：基座把過大的工具結果搬去 backend，而**那次 write 失敗時
 * 它不保留原文**，只留一句「存不進去」。`ContainedFilesystemBackend` 的 `read-only` mode
 * 對每一次 write 回 `{ error }`，所以那個組裝底下每一則超過 80,000 字元的結果都會中。
 *
 * 修法是在組裝點把 `/large_tool_results` 路由到獨立的暫存 backend
 * （{@link ./agent-factory.ts} 的 `withToolResultStash`），於是那次 write 不會失敗。
 * [#734](https://github.com/DemianLi/nexus-agent/issues/734) 起優先存主機私有目錄、存不進去才退回 graph state；
 * 沒給 `toolResultStash` 的組裝（eval、spike）走記憶體，前半的測試守那一條，後半的 describe 守主機那一條。
 *
 * **這裡的判準一律是「暗號讀不讀得回來」，不是「訊息長什麼樣」。** 只看訊息會把
 * 「搬走了而且取得回來」跟「搬走了但取不回來」讀成同一件事 —— 前者第二輪 `read_file`
 * 拿到原文，後者拿到 `ENOENT`，而第一輪的訊息文字差不多。
 */

import { chmod, mkdir, mkdtemp, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage, ToolMessage } from '@langchain/core/messages';
import type { PluginEntry } from '@nexus/core';
import { MemorySaver } from '@langchain/langgraph';
import type { AnyBackendProtocol } from 'deepagents';
import { tool } from 'langchain';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { createNexusAgent, TOOL_RESULT_STASH_PREFIX } from './agent-factory.js';
import { createMountPlugin } from './fixtures.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import { cleanupToolResultStash, stashSessionDirName } from './tool-result-stash.js';
import type { ToolResultStashOptions } from './tool-result-stash.js';

/** 暗號放在**最前面**：截斷與「只拿到預覽」都會讓它消失，`includes` 才分得出來。 */
const MARK = 'MURASAKI-7391';

/** 剛好越過基座那條線（`4 * toolTokenLimitBeforeEvict`，預設 `2e4` → 80,000 字元）。 */
const OVERSIZED = `${MARK}${'X'.repeat(80_001)}`;

/** 遠低於那條線 —— 這一則不該經過暫存那條路。 */
const SMALL = `${MARK}${'X'.repeat(100)}`;

/** 基座搬完之後告訴模型去讀的那個檔名。`call_1_0` 是腳本模型第一輪那次呼叫的 id。 */
const STASHED = `${TOOL_RESULT_STASH_PREFIX}/call_1_0.txt`;

function bulkPlugin(payload: string): PluginEntry {
  return {
    plugin: {
      name: 'bulk',
      apply: (registry) => {
        registry.tools.register(
          tool(() => payload, { name: 'bulk', description: '拿一坨東西。', schema: z.object({}) }),
        );
      },
    },
  };
}

function toolResults(prompt: readonly BaseMessage[]): ToolMessage[] {
  return prompt.filter((message) => message.getType() === 'tool') as ToolMessage[];
}

/** 工具結果的文字。非文字區塊會被 `JSON.stringify` 攤平，暗號照樣找得到。 */
function resultText(prompt: readonly BaseMessage[] | undefined): string {
  const content = prompt === undefined ? undefined : toolResults(prompt).at(-1)?.content;
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

/**
 * 跑一場「拿一坨 → 用 `read_file` 讀回來」。
 *
 * @returns 模型第一輪看到的工具結果，與第二輪 `read_file` 拿回來的東西。
 */
async function fetchThenRead(
  payload: string,
  backend?: AnyBackendProtocol,
  extra: readonly PluginEntry[] = [],
  stash?: ToolResultStashOptions,
): Promise<{ first: string; readBack: string }> {
  const model = new ScriptedChatModel({
    turns: [
      { content: '', toolCalls: [{ name: 'bulk', args: {} }] },
      { content: '', toolCalls: [{ name: 'read_file', args: { file_path: STASHED, limit: 2 } }] },
      { content: '看完了。' },
    ],
  });
  const { agent, dispose } = await createNexusAgent({
    model,
    plugins: [bulkPlugin(payload), ...extra],
    ...(backend === undefined ? {} : { backend }),
    ...(stash === undefined ? {} : { toolResultStash: stash }),
  });
  try {
    await agent.invoke(toAgentInvocation('去拿一坨，然後讀回來。'));
  } finally {
    await dispose();
  }
  // 兩輪都要真的發生過。少了這一句，「模型第二輪根本沒被叫到」會讀成綠。
  expect(model.prompts.length).toBeGreaterThanOrEqual(3);
  return { first: resultText(model.prompts[1]), readBack: resultText(model.prompts[2]) };
}

async function containedRoot(mode: 'read-only' | 'workspace-write'): Promise<{
  root: string;
  backend: ContainedFilesystemBackend;
}> {
  const root = await mkdtemp(join(tmpdir(), `stash-${mode}-`));
  return { root, backend: new ContainedFilesystemBackend({ rootDir: root, mode }) };
}

describe('過大的工具結果搬走之後還取得回來', () => {
  it('read-only 組裝 —— 這一條就是 #170', async () => {
    // 修之前：模型收到 166 個字元的「存不進去」，接著 read_file 拿到 ENOENT，
    // 原文 80,014 個字元沒有任何地方還留著。
    const { backend } = await containedRoot('read-only');
    const { first, readBack } = await fetchThenRead(OVERSIZED, backend);

    expect(first).not.toContain('could not be saved');
    expect(readBack).toContain(MARK);
  });

  it('workspace-write 組裝', async () => {
    const { backend } = await containedRoot('workspace-write');
    const { readBack } = await fetchThenRead(OVERSIZED, backend);
    expect(readBack).toContain(MARK);
  });

  it('預設組裝（StateBackend）', async () => {
    const { readBack } = await fetchThenRead(OVERSIZED);
    expect(readBack).toContain(MARK);
  });

  /**
   * **這條是絆索，它釘的是基座那個寫死的路徑。**
   *
   * 我們的路由只蓋得住 `TOOL_RESULT_STASH_PREFIX` 這一個前綴。基座哪天把
   * `/large_tool_results/` 改成別的，路由就落空、`read-only` 那條缺陷會**無聲地回來** ——
   * 上面三條仍然綠（暗號從工作區那一側讀得回來，除了 read-only 那格）。所以這裡直接
   * 斷言基座指路的那個路徑真的在我們的前綴底下。
   */
  it('基座指去的路徑落在我們路由的前綴底下', async () => {
    const { backend } = await containedRoot('workspace-write');
    const { first } = await fetchThenRead(OVERSIZED, backend);
    const advertised = /at this path: (\S+)/.exec(first)?.[1];
    expect(advertised).toBeDefined();
    expect(advertised?.startsWith(`${TOOL_RESULT_STASH_PREFIX}/`)).toBe(true);
  });

  it('暫存不再落在使用者的工作區裡 —— 它是 harness 的暫存，不是模型在做的事', async () => {
    // 這是這張卡刻意改掉的行為：修之前 workspace-write 會在使用者的專案目錄下留一個
    // 永遠沒人清的 large_tool_results/。dsh 的 spill 同樣不寫工作區（它有自己的私有根）。
    const { root, backend } = await containedRoot('workspace-write');
    await fetchThenRead(OVERSIZED, backend);
    expect(await readdir(root)).not.toContain('large_tool_results');
  });

  /**
   * **有 plugin 掛路由時，暫存那一格是包在包裡面的，這條驗它還通。**
   *
   * `foldBackend` 看到有人 `backend.mount()` 就把組裝點給的那個再包一層 `CompositeBackend`，
   * 而組裝點給的已經是一個 `CompositeBackend` 了。外層先比它自己的前綴、沒中就把**完整
   * 路徑**交給 default，內層才比暫存那個前綴 —— 兩層剝前綴不能互相吃掉對方。
   */
  it('plugin 也掛了路由時，兩層 composite 疊起來仍然取得回來', async () => {
    const { backend } = await containedRoot('read-only');
    const { readBack } = await fetchThenRead(OVERSIZED, backend, [createMountPlugin('/memories/')]);
    expect(readBack).toContain(MARK);
  });

  it('沒過門檻的結果原樣通過 —— 這條路根本不該碰它', async () => {
    const { backend } = await containedRoot('read-only');
    const { first } = await fetchThenRead(SMALL, backend);
    expect(first).toContain(SMALL);
    expect(first).not.toContain('Tool result too large');
  });
});

/**
 * 跑一場「拿一坨 → 在暫存目錄底下 `ls` → 在暫存目錄底下 `grep` 暗號」。
 *
 * @returns 第二輪 `ls` 與第三輪 `grep` 拿回來的工具結果。
 */
async function fetchThenBrowse(
  backend?: AnyBackendProtocol,
): Promise<{ listed: string; grepped: string }> {
  const model = new ScriptedChatModel({
    turns: [
      { content: '', toolCalls: [{ name: 'bulk', args: {} }] },
      { content: '', toolCalls: [{ name: 'ls', args: { path: TOOL_RESULT_STASH_PREFIX } }] },
      {
        content: '',
        toolCalls: [{ name: 'grep', args: { pattern: MARK, path: TOOL_RESULT_STASH_PREFIX } }],
      },
      { content: '看完了。' },
    ],
  });
  const { agent, dispose } = await createNexusAgent({
    model,
    plugins: [bulkPlugin(OVERSIZED)],
    ...(backend === undefined ? {} : { backend }),
  });
  try {
    await agent.invoke(toAgentInvocation('去拿一坨，然後在暫存目錄底下找找。'));
  } finally {
    await dispose();
  }
  expect(model.prompts.length).toBeGreaterThanOrEqual(4);
  return { listed: resultText(model.prompts[2]), grepped: resultText(model.prompts[3]) };
}

describe.each([
  ['read-only', () => containedRoot('read-only').then(({ backend }) => backend)],
  ['workspace-write', () => containedRoot('workspace-write').then(({ backend }) => backend)],
  ['預設（StateBackend）', () => Promise.resolve(undefined)],
] as const)('暫存目錄底下 ls 與 grep 對得上（%s）—— #354', (_, makeBackend) => {
  it('ls 列出基座指路的那個路徑，grep 命中原文', async () => {
    const { listed, grepped } = await fetchThenBrowse(await makeBackend());
    // 修之前 `ls` 列出 `/large_tool_result// (directory)`（少一個 s）。
    expect.soft(listed).toContain(STASHED);
    // 暗號後面接著的 X 只在原文裡：找不到時的 `No matches found for pattern '<暗號>'` 不含它。
    expect.soft(grepped).toContain(`${MARK}X`);
  });
});

describe('沒給主機目錄時，暫存放在 graph state 裡，而且是逐 thread 的', () => {
  /**
   * **這條驗的是路由目標沒有自己的記憶體，所以也沒有跨對話的洩漏。**
   *
   * `new StateBackend()`（零參數）不是 legacy 模式：它從 LangGraph 的執行脈絡讀
   * `files`、用 `__pregel_send` 送更新（`deepagents@1.13.1`，`dist/langsmith-zm0ILQsV.js:737`
   * 的 `isLegacy` / `get files`）。**那個物件本身不存東西**，所以「組裝點建了一個實例、
   * 兩場對話共用它」不會發生 —— 但那是讀碼推的，這一條把它量出來：暫存進得了 state
   * 快照（所以它也進 checkpoint，那是這個修法的代價），而另一個 thread 看不到它。
   */
  it('進得了 state 快照，而且另一個 thread 看不到', async () => {
    const { backend } = await containedRoot('read-only');
    const model = new ScriptedChatModel({
      turns: [{ content: '', toolCalls: [{ name: 'bulk', args: {} }] }, { content: '好。' }],
    });
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [bulkPlugin(OVERSIZED)],
      backend,
      checkpointer: new MemorySaver(),
    });
    const readState = (thread: string): Promise<{ values: Record<string, unknown> }> =>
      (
        agent as unknown as {
          getState: (config: unknown) => Promise<{ values: Record<string, unknown> }>;
        }
      ).getState({ configurable: { thread_id: thread } });
    try {
      await agent.invoke(toAgentInvocation('去拿一坨超大的。'), {
        configurable: { thread_id: 'stash' },
      });

      // **state 上的鍵不是模型看到的那個路徑。** composite 把路由前綴剝掉之後交給
      // `StateBackend`，剝完的那一份就是鍵。**鍵的形狀就是 #354 的修法，所以釘死**：路由鍵
      // 沒有結尾斜線時這裡是 `//call_1_0.txt`，而在暫存目錄底下 `ls`／`grep` 都對不上。
      //
      // **推翻過一次的決定，代價照實記。** 這裡原本刻意留著 `//`，理由是乾淨的
      // `/call_1_0.txt` 更容易跟預設組裝裡模型自己的檔案撞在同一格 state 上。那個撞法是真的
      // （實測：沒給 `--workspace` 時模型 `ls /` 看得到 `/call_1_0.txt`、照那個路徑讀得到），
      // 但 `//` 也沒藏住它（`ls /` 列出 `// (directory)`、`grep /` 命中 `//call_1_0.txt`），
      // 只是讓暫存目錄本身壞掉。會話歷史那一格（#348）已經帶斜線、接受同一個代價。
      const mine = Object.keys(
        ((await readState('stash')).values.files ?? {}) as Record<string, unknown>,
      );
      expect(mine.filter((key) => key.endsWith('call_1_0.txt'))).toEqual(['/call_1_0.txt']);

      const other = Object.keys(
        ((await readState('別人')).values.files ?? {}) as Record<string, unknown>,
      );
      expect(other.filter((key) => key.endsWith('call_1_0.txt'))).toHaveLength(0);
    } finally {
      await dispose();
    }
  });
});

describe('路由開的是暫存那一格，不是把 fence 打開', () => {
  it('read-only 底下模型自己的 write_file 照樣被擋，措辭一字不動', async () => {
    // 少了這一條，「把 read-only 整個路由掉」會跟「只路由暫存那一格」一樣綠。
    const { backend } = await containedRoot('read-only');
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '',
          toolCalls: [{ name: 'write_file', args: { file_path: '/notes.txt', content: '嗨' } }],
        },
        { content: '好。' },
      ],
    });
    const { agent, dispose } = await createNexusAgent({ model, plugins: [], backend });
    try {
      await agent.invoke(toAgentInvocation('寫個檔。'));
    } finally {
      await dispose();
    }
    expect(resultText(model.prompts[1])).toContain('這個 backend 是唯讀的');
  });
});

/**
 * **主機上的私有目錄**（[#734](https://github.com/DemianLi/nexus-agent/issues/734)）：給了 `toolResultStash`，暫存改存
 * 主機、按會話分目錄，所以重開之後照預覽路徑 `read_file` 讀得回。上面的測試沒給它，走的是 eval／spike 那條記憶體暫存。
 *
 * 判準仍是「暗號讀不讀得回來」；**組裝是真的 `createNexusAgent`＋真的檔案系統**，不用會失敗的替身。
 */
describe('暫存在主機上的私有目錄', () => {
  const isRoot = process.getuid?.() === 0;

  async function stashRoot(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'stash-host-'));
  }

  /** 一個會話目錄底下的檔，與它的權限。 */
  async function stashedFiles(root: string, session: string) {
    const dir = join(root, stashSessionDirName(session));
    const names = await readdir(dir);
    return {
      dir,
      names,
      dirMode: (await stat(dir)).mode & 0o777,
      rootMode: (await stat(root)).mode & 0o777,
      fileModes: await Promise.all(
        names.map(async (name) => (await stat(join(dir, name))).mode & 0o777),
      ),
    };
  }

  it.each([
    ['read-only（#170 那條）', () => containedRoot('read-only').then(({ backend }) => backend)],
    ['workspace-write', () => containedRoot('workspace-write').then(({ backend }) => backend)],
    ['預設（StateBackend）', () => Promise.resolve(undefined)],
  ] as const)('%s：讀得回，檔在主機上，目錄 0700、檔案 0600', async (_, makeBackend) => {
    const root = await stashRoot();
    const { first, readBack } = await fetchThenRead(OVERSIZED, await makeBackend(), [], {
      rootDir: root,
      session: 's1',
    });
    expect(first).not.toContain('could not be saved');
    expect(readBack).toContain(MARK);

    const files = await stashedFiles(root, 's1');
    expect(files.names).toEqual(['call_1_0.txt']);
    expect(files.fileModes).toEqual([0o600]);
    expect(files.dirMode).toBe(0o700);
    expect(files.rootMode).toBe(0o700);
  });

  it('暫存不在對話狀態裡：進不了 checkpoint，也不在模型看得到的根目錄', async () => {
    const root = await stashRoot();
    const model = new ScriptedChatModel({
      turns: [{ content: '', toolCalls: [{ name: 'bulk', args: {} }] }, { content: '好。' }],
    });
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [bulkPlugin(OVERSIZED)],
      checkpointer: new MemorySaver(),
      toolResultStash: { rootDir: root, session: 's1' },
    });
    try {
      await agent.invoke(toAgentInvocation('去拿一坨超大的。'), {
        configurable: { thread_id: 'stash' },
      });
      const state = await (
        agent as unknown as {
          getState: (config: unknown) => Promise<{ values: Record<string, unknown> }>;
        }
      ).getState({ configurable: { thread_id: 'stash' } });
      const keys = Object.keys((state.values.files ?? {}) as Record<string, unknown>);
      expect(keys.filter((key) => key.endsWith('call_1_0.txt'))).toEqual([]);
    } finally {
      await dispose();
    }
    expect((await stashedFiles(root, 's1')).names).toEqual(['call_1_0.txt']);
  });

  it('兩個會話各自一個目錄，互相看不到對方的檔', async () => {
    const root = await stashRoot();
    // 兩個會話的工具呼叫編號一樣（`call_1_0`）：同一個檔名，落在不同的目錄。
    await fetchThenRead(`A-${OVERSIZED}`, undefined, [], { rootDir: root, session: 'a' });
    await fetchThenRead(`B-${OVERSIZED}`, undefined, [], { rootDir: root, session: 'b' });
    const dirs = (await readdir(root)).sort();
    expect(dirs).toEqual([stashSessionDirName('a'), stashSessionDirName('b')].sort());
    expect(stashSessionDirName('a')).not.toBe(stashSessionDirName('b'));
    for (const session of ['a', 'b']) {
      expect((await stashedFiles(root, session)).names).toEqual(['call_1_0.txt']);
    }

    // 換成 b 的鑰匙重開，讀到的是 b 自己的檔，不是 a 的。
    const model = new ScriptedChatModel({
      turns: [
        { content: '', toolCalls: [{ name: 'read_file', args: { file_path: STASHED, limit: 1 } }] },
        { content: '好。' },
      ],
    });
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [],
      toolResultStash: { rootDir: root, session: 'b' },
    });
    try {
      await agent.invoke(toAgentInvocation('讀回來。'));
    } finally {
      await dispose();
    }
    expect(resultText(model.prompts[1])).toContain(`B-${MARK}`);
  });

  /**
   * **這是 #734 的驗收：重開之後照預覽路徑 `read_file` 唸得回暗號。**
   * 第一個 agent 收掉（`dispose`）之後另組一個全新的、沒有任何共用記憶體的 agent，只憑同一個根與同一把會話鑰匙。
   * 突變（把路由換回記憶體）這條紅：第二個 agent 找不到那個檔。
   */
  it('重開：全新組裝的 agent 照預覽路徑讀得回上一個行程外溢的原文', async () => {
    const root = await stashRoot();
    const stash = { rootDir: root, session: 'resume-me' };
    const { first } = await fetchThenRead(OVERSIZED, undefined, [], stash);
    const advertised = /at this path: (\S+)/.exec(first)?.[1];
    expect(advertised).toBe(STASHED);

    const model = new ScriptedChatModel({
      turns: [
        {
          content: '',
          toolCalls: [{ name: 'read_file', args: { file_path: advertised, limit: 2 } }],
        },
        { content: '好。' },
      ],
    });
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [],
      toolResultStash: stash,
    });
    try {
      await agent.invoke(toAgentInvocation('接著上次讀。'));
    } finally {
      await dispose();
    }
    expect(resultText(model.prompts[1])).toContain(MARK);
  });

  it.skipIf(isRoot)(
    '根目錄不可寫（真的不可寫的目錄）：模型拿到預覽加路徑，行程內照路徑讀得回，不是「存不進去」',
    async () => {
      const root = await stashRoot();
      await chmod(root, 0o500);
      const warnings: string[] = [];
      try {
        const { first, readBack } = await fetchThenRead(OVERSIZED, undefined, [], {
          rootDir: root,
          session: 'ro',
          warn: (message) => warnings.push(message),
        });
        expect(first).not.toContain('could not be saved');
        expect(first).toContain(STASHED);
        expect(readBack).toContain(MARK);
        // 主機上一個檔都沒有；只講一聲，不刷屏。
        expect(await readdir(root)).toEqual([]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('退回記憶體');
      } finally {
        await chmod(root, 0o700);
      }
    },
  );

  it('根目錄的祖先別人改得動：不寫主機，退回記憶體，暗號照樣讀得回', async () => {
    const shared = await stashRoot();
    await chmod(shared, 0o777);
    const warnings: string[] = [];
    const { readBack } = await fetchThenRead(OVERSIZED, undefined, [], {
      rootDir: join(shared, 'stash'),
      session: 's',
      warn: (message) => warnings.push(message),
    });
    expect(readBack).toContain(MARK);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('群組或其他人可寫');
    // 檔案沒有寫進那個別人改得動的目錄底下。
    expect(await readdir(join(shared, 'stash')).catch(() => [])).toEqual([
      expect.stringMatching(/^session-/),
    ]);
    expect(await readdir(join(shared, 'stash', stashSessionDirName('s')))).toEqual([]);
  });

  it('已存在的根不會被改權限——只有自己建的那一層才收緊', async () => {
    const root = await stashRoot();
    await chmod(root, 0o750);
    await fetchThenRead(OVERSIZED, undefined, [], { rootDir: root, session: 's' });
    expect((await stat(root)).mode & 0o777).toBe(0o750);
    expect((await stashedFiles(root, 's')).dirMode).toBe(0o700);
  });

  it('read-only 底下模型自己 write_file 到暫存前綴：只落在自己會話的目錄，不在工作區', async () => {
    const root = await stashRoot();
    const { root: workspace, backend } = await containedRoot('read-only');
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '',
          toolCalls: [
            {
              name: 'write_file',
              args: { file_path: `${TOOL_RESULT_STASH_PREFIX}/notes.txt`, content: '嗨' },
            },
          ],
        },
        { content: '好。' },
      ],
    });
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [],
      backend,
      toolResultStash: { rootDir: root, session: 's' },
    });
    try {
      await agent.invoke(toAgentInvocation('寫個檔。'));
    } finally {
      await dispose();
    }
    expect((await stashedFiles(root, 's')).names).toEqual(['notes.txt']);
    expect(await readdir(workspace)).toEqual([]);
  });

  it('二進位仍被拒讀（#642）：寫進暫存前綴的含 NUL 內容，讀回來是 binary file', async () => {
    const root = await stashRoot();
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '',
          toolCalls: [
            {
              name: 'write_file',
              args: { file_path: `${TOOL_RESULT_STASH_PREFIX}/blob.txt`, content: 'a\u0000b' },
            },
          ],
        },
        {
          content: '',
          toolCalls: [
            { name: 'read_file', args: { file_path: `${TOOL_RESULT_STASH_PREFIX}/blob.txt` } },
          ],
        },
        { content: '好。' },
      ],
    });
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [],
      toolResultStash: { rootDir: root, session: 's' },
    });
    try {
      await agent.invoke(toAgentInvocation('寫一個二進位的。'));
    } finally {
      await dispose();
    }
    expect(resultText(model.prompts[2])).toContain('binary file');
  });
});

describe('啟動時清掉超過保留期的暫存', () => {
  const DAY = 24 * 60 * 60 * 1000;

  /** 造一個會話目錄，裡面一個檔，時間設成 `ageDays` 天前。 */
  async function session(root: string, name: string, ageDays: number): Promise<string> {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, 'call_1_0.txt');
    await writeFile(file, 'x');
    const then = new Date(Date.now() - ageDays * DAY);
    await utimes(file, then, then);
    await utimes(dir, then, then);
    return dir;
  }

  async function root(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'stash-clean-'));
    await chmod(dir, 0o700);
    return dir;
  }

  it('過了保留期的清掉，沒過的留著；只碰 session-* 開頭的目錄', async () => {
    const dir = await root();
    await session(dir, 'session-old', 40);
    await session(dir, 'session-new', 5);
    await session(dir, 'notes', 400);
    expect(await cleanupToolResultStash(dir, 30)).toBe(1);
    expect((await readdir(dir)).sort()).toEqual(['notes', 'session-new']);
  });

  it('cleanupPeriodDays 為 0 表示不清', async () => {
    const dir = await root();
    await session(dir, 'session-old', 4000);
    expect(await cleanupToolResultStash(dir, 0)).toBe(0);
    expect(await readdir(dir)).toEqual(['session-old']);
  });

  it('以會話裡最新的檔為準：續接後又寫了新檔的會話不會因為第一個檔很舊被清掉', async () => {
    const dir = await root();
    const old = await session(dir, 'session-resumed', 90);
    await writeFile(join(old, 'call_9_0.txt'), 'fresh');
    expect(await cleanupToolResultStash(dir, 30)).toBe(0);
    expect(await readdir(dir)).toEqual(['session-resumed']);
  });

  it('根別人改得動就一個檔都不碰，而且講一聲', async () => {
    const dir = await root();
    await session(dir, 'session-old', 400);
    await chmod(dir, 0o777);
    const warnings: string[] = [];
    expect(await cleanupToolResultStash(dir, 30, { warn: (m) => warnings.push(m) })).toBe(0);
    expect(await readdir(dir)).toEqual(['session-old']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('群組或其他人可寫');
  });

  it('根還不存在：沒東西可清，不拋', async () => {
    const dir = await root();
    expect(await cleanupToolResultStash(join(dir, '還沒有'), 30)).toBe(0);
  });

  it('清得掉的照清、清不掉的記一筆不擋其餘', async () => {
    if (process.getuid?.() === 0) return;
    const dir = await root();
    const locked = await session(dir, 'session-a-locked', 60);
    await session(dir, 'session-b-old', 60);
    // 目錄本身唯讀：裡面的檔刪不掉。
    await chmod(locked, 0o500);
    const warnings: string[] = [];
    try {
      const removed = await cleanupToolResultStash(dir, 30, { warn: (m) => warnings.push(m) });
      expect(removed).toBe(1);
      expect(warnings).toHaveLength(1);
      expect(await readdir(dir)).toEqual(['session-a-locked']);
    } finally {
      await chmod(locked, 0o700);
    }
  });
});
