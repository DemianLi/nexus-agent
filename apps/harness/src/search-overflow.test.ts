/**
 * 搜尋結果的筆數上限（[#735](https://github.com/DemianLi/nexus-agent/issues/735)）的驗收：真的組裝、真的基座工具、
 * 真的檔案系統，量模型拿到什麼、照定位 `read_file` 讀不讀得回行內沒有的那一筆、搜尋卡記下什麼。
 *
 * **判準是「行內沒有的那一筆讀不讀得回來」**，不只是「訊息長什麼樣」：只看訊息分不出「存了而且讀得回」與「寫了定位但檔不在」。
 *
 * 零憑證、零外部連線：模型是 `ScriptedChatModel`。
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { SessionRegistry } from '@nexus/core';
import type { PluginEntry, SearchResultMeta } from '@nexus/core';
import { describe, expect, it } from 'vitest';

import { createNexusAgent, TOOL_RESULT_STASH_PREFIX } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedToolCall } from './scripted-model.js';
import { toolFsSearchPlugin } from './settings/tool-fs-search.js';
import type { ToolResultStashOptions } from './tool-result-stash.js';

/** 出貨那一列（預設值 250／100）。 */
const ROW: PluginEntry = { plugin: toolFsSearchPlugin as never, config: {} };

const NEEDLE = 'NEEDLE';

/** 第 i 個命中那一行的內容：檔名與序號都在裡面，`includes` 分得出是哪一筆。 */
function hit(file: string, index: number): string {
  return `${NEEDLE}-${file}-${String(index).padStart(3, '0')}`;
}

interface Workspace {
  readonly root: string;
  readonly backend: ContainedFilesystemBackend;
}

/**
 * 工作區：`/a.txt` 有 200 行命中、`/b.txt` 有 `bHits` 行命中（共 200＋bHits 筆）；`/many/` 底下 `files` 個檔。
 * 檔名排序就是基座排版的順序，所以 `b.txt` 的最後一行是第 200＋bHits 筆。
 */
async function workspace(bHits: number, files = 0): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), 'search-overflow-'));
  const lines = (file: string, n: number) =>
    `${Array.from({ length: n }, (_, i) => hit(file, i + 1)).join('\n')}\n`;
  await writeFile(join(root, 'a.txt'), lines('a', 200));
  await writeFile(join(root, 'b.txt'), lines('b', bHits));
  if (files > 0) {
    await mkdir(join(root, 'many'));
    for (let i = 1; i <= files; i += 1) {
      await writeFile(join(root, 'many', `f${String(i).padStart(3, '0')}.txt`), 'x');
    }
  }
  return {
    root,
    backend: new ContainedFilesystemBackend({ rootDir: root, mode: 'workspace-write' }),
  };
}

async function stashOptions(session = 's'): Promise<ToolResultStashOptions> {
  return { rootDir: await mkdtemp(join(tmpdir(), 'search-overflow-stash-')), session };
}

function textOf(message: ToolMessage | undefined): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  return (content ?? [])
    .map((block) => ((block as { text?: unknown }).text as string | undefined) ?? '')
    .join('');
}

interface Run {
  /** 每顆工具結果，依序。 */
  readonly results: ToolMessage[];
  /** root 日誌上每顆 `tool/result` 的 meta。 */
  readonly metas: unknown[];
  /** 模型每一輪看到的訊息。 */
  readonly prompts: readonly (readonly BaseMessage[])[];
}

async function run(
  calls: readonly ScriptedToolCall[],
  options: {
    readonly backend?: ContainedFilesystemBackend;
    readonly plugins?: readonly PluginEntry[];
    readonly stash?: ToolResultStashOptions;
  },
): Promise<Run> {
  const model = new ScriptedChatModel({
    turns: [...calls.map((call) => ({ content: '', toolCalls: [call] })), { content: '收工。' }],
  });
  const { agent, attachSession, dispose } = await createNexusAgent({
    model,
    plugins: [...(options.plugins ?? [ROW])],
    ...(options.backend !== undefined && { backend: options.backend }),
    ...(options.stash !== undefined && { toolResultStash: options.stash }),
    checkpointer: new MemorySaver(),
  });
  const sessions = new SessionRegistry('search-overflow');
  const detach = attachSession(sessions);
  let state: { messages: BaseMessage[] };
  try {
    state = (await agent.invoke(toAgentInvocation('找。'), {
      configurable: { thread_id: 'search-overflow' },
    })) as { messages: BaseMessage[] };
  } finally {
    detach();
    await dispose();
  }
  const rootLog = sessions.list().find((entry) => entry.address.kind === 'root');
  return {
    results: state.messages.filter((message): message is ToolMessage =>
      ToolMessage.isInstance(message),
    ),
    metas: (rootLog?.log.events ?? []).flatMap((event) =>
      event.type === 'tool/result' ? [event.data.meta] : [],
    ),
    prompts: model.prompts,
  };
}

/** 結尾那句裡的定位。 */
function locatorOf(text: string): string {
  const locator = /stored at: (\S+?)\. Use read_file/u.exec(text)?.[1];
  expect(locator, text.slice(-400)).toBeDefined();
  return locator ?? '';
}

/** 另組一個 agent（同一個暫存會話）照定位讀一段，回讀到的文字。 */
async function readBack(
  stash: ToolResultStashOptions,
  locator: string,
  offset: number,
  limit: number,
): Promise<string> {
  const { results } = await run(
    [{ name: 'read_file', args: { file_path: locator, offset, limit } }],
    { plugins: [], stash },
  );
  return textOf(results[0]);
}

const GREP = { name: 'grep', args: { pattern: NEEDLE } } as const;
const GLOB = { name: 'glob', args: { pattern: '*.txt', path: '/many' } } as const;
const LS = { name: 'ls', args: { path: '/many' } } as const;

// 每條都真的組裝一到兩個 agent 並寫上百個檔；忙的機器上預設的 5 秒不夠。
describe('搜尋結果超過筆數上限時自存全文（#735）', { timeout: 30_000 }, () => {
  describe('grep', () => {
    it('251 筆：行內是前 250 筆加定位，照定位讀得到第 251 筆', async () => {
      const { backend } = await workspace(51);
      const stash = await stashOptions();
      const { results } = await run([GREP], { backend, stash });
      const text = textOf(results[0]);

      expect(text.startsWith('Found 250 of 251 matches\n\n')).toBe(true);
      expect(text).toContain(hit('b', 50));
      expect(text).not.toContain(hit('b', 51));
      expect(text).toContain(`Full grep result stored at: ${TOOL_RESULT_STASH_PREFIX}/`);
      expect(results[0]?.status).not.toBe('error');
      // 基座那句「the search stopped early … raise max_count」不該出現：截的是我們，不是 backend。
      expect(text).not.toContain('max_count');

      // 存檔那份：`Found 251 matches`、空行、`/a.txt:`、200 行、`/b.txt:`、51 行——第 251 筆在第 255 行（0 起算 254）。
      const back = await readBack(stash, locatorOf(text), 250, 10);
      expect(back).toContain(hit('b', 51));
    });

    it('剛好 250 筆：原樣，跟沒掛這一列一字不差', async () => {
      const { backend } = await workspace(50);
      const capped = await run([GREP], { backend, stash: await stashOptions() });
      const plain = await run([GREP], { backend, plugins: [] });
      expect(textOf(capped.results[0])).toBe(textOf(plain.results[0]));
      expect(textOf(capped.results[0])).toContain(hit('b', 50));
    });

    it('files_with_matches 與 count 模式不截（按命中截會把計數算錯）', async () => {
      const { backend } = await workspace(51);
      const calls = [
        { name: 'grep', args: { pattern: NEEDLE, output_mode: 'count' } },
        { name: 'grep', args: { pattern: NEEDLE, output_mode: 'files_with_matches' } },
      ];
      const capped = await run(calls, { backend, stash: await stashOptions() });
      const plain = await run(calls, { backend, plugins: [] });
      expect(capped.results.map(textOf)).toEqual(plain.results.map(textOf));
      expect(textOf(capped.results[0])).toContain('/b.txt: 51');
    });
  });

  describe('glob', () => {
    it('101 條：行內前 100 條加定位，照定位讀得到第 101 條；剛好 100 條原樣', async () => {
      const { backend } = await workspace(1, 101);
      const stash = await stashOptions();
      const { results } = await run([GLOB], { backend, stash });
      const text = textOf(results[0]);
      expect(text).toContain('/many/f100.txt');
      expect(text).not.toContain('/many/f101.txt');
      expect(text).toContain('(Showing 100 of 101 paths. Full glob result stored at: ');
      expect(await readBack(stash, locatorOf(text), 95, 10)).toContain('/many/f101.txt');

      const exact = await workspace(1, 100);
      const capped = await run([GLOB], { backend: exact.backend, stash: await stashOptions() });
      const plain = await run([GLOB], { backend: exact.backend, plugins: [] });
      expect(textOf(capped.results[0])).toBe(textOf(plain.results[0]));
    });
  });

  describe('ls（dsh 沒有這顆，退到 glob 的形狀與上限）', () => {
    it('101 項：行內前 100 項加定位，照定位讀得到第 101 項；剛好 100 項原樣', async () => {
      const { backend } = await workspace(1, 101);
      const stash = await stashOptions();
      const { results } = await run([LS], { backend, stash });
      const text = textOf(results[0]);
      expect(text).toContain('/many/f100.txt');
      expect(text).not.toContain('/many/f101.txt');
      expect(text).toContain('(Showing 100 of 101 entries. Full ls result stored at: ');
      expect(await readBack(stash, locatorOf(text), 95, 10)).toContain('/many/f101.txt');

      const exact = await workspace(1, 100);
      const capped = await run([LS], { backend: exact.backend, stash: await stashOptions() });
      const plain = await run([LS], { backend: exact.backend, plugins: [] });
      expect(textOf(capped.results[0])).toBe(textOf(plain.results[0]));
    });
  });

  describe('存不下照樣成功', () => {
    it('沒有暫存（eval、spike 那種組裝）：行內前段加一句沒存到，不是錯誤', async () => {
      const { backend } = await workspace(51);
      const { results } = await run([GREP], { backend });
      const text = textOf(results[0]);
      expect(text.startsWith('Found 250 of 251 matches\n\n')).toBe(true);
      expect(text).not.toContain(hit('b', 51));
      expect(text).toContain(
        '(The complete result could not be saved; narrow pattern, path, or glob to see more.)',
      );
      expect(results[0]?.status).not.toBe('error');
    });

    it('暫存目錄寫不進：同上，而且講一聲', async () => {
      const { backend } = await workspace(1, 101);
      const warnings: string[] = [];
      const { results } = await run([GLOB], {
        backend,
        stash: { rootDir: '/dev/null/nope', session: 's', warn: (m) => warnings.push(m) },
      });
      const text = textOf(results[0]);
      expect(text).toContain(
        '(Showing 100 of 101 paths. The complete result could not be saved; narrow pattern or path to see more.)',
      );
      expect(results[0]?.status).not.toBe('error');
      expect(warnings.some((m) => m.includes('search-overflow'))).toBe(true);
    });
  });

  it('搜尋卡記的是行內那一頁，truncated 為真、total 是截之前的數（同 dsh）', async () => {
    const { backend } = await workspace(51, 101);
    const { metas } = await run([GREP, GLOB], { backend, stash: await stashOptions() });
    const grep = metas[0] as Extract<SearchResultMeta, { shape: 'matches' }>;
    expect(grep.shape).toBe('matches');
    expect(grep.files.reduce((sum, file) => sum + file.matches.length, 0)).toBe(250);
    expect(grep.truncated).toBe(true);
    expect(grep.total).toBe(251);
    const glob = metas[1] as Extract<SearchResultMeta, { shape: 'paths' }>;
    expect(glob.paths).toHaveLength(100);
    expect(glob.truncated).toBe(true);
    expect(glob.total).toBe(101);
  });

  it('子代理那條組裝路也截：一次性委派的 general-purpose 拿到的是前段加定位', async () => {
    const { backend } = await workspace(51);
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '',
          toolCalls: [
            { name: 'task', args: { description: '找', subagent_type: 'general-purpose' } },
          ],
        },
        { content: '', toolCalls: [{ name: 'grep', args: { pattern: NEEDLE }, id: 'sub_grep' }] },
        { content: '子代理收工。' },
        { content: '好。' },
      ],
    });
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [ROW],
      backend,
      toolResultStash: await stashOptions(),
    });
    try {
      await agent.invoke(toAgentInvocation('派人。'));
    } finally {
      await dispose();
    }
    // 第三次呼叫模型是子代理拿到 grep 結果之後的那一輪。
    const seen = textOf(
      [...(model.prompts[2] ?? [])].reverse().find((m) => ToolMessage.isInstance(m)) as
        ToolMessage | undefined,
    );
    expect(seen.startsWith('Found 250 of 251 matches')).toBe(true);
    expect(seen).toContain('Full grep result stored at: ');
  });

  it('沒有這一列（或標成 disabled）：基座原樣，101 條全在行內', async () => {
    const { backend } = await workspace(1, 101);
    const { results } = await run([GLOB], { backend, plugins: [], stash: await stashOptions() });
    const text = textOf(results[0]);
    expect(text).toContain('/many/f101.txt');
    expect(text).not.toContain('Showing');
  });
});
