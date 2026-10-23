/**
 * 檔案工具組態（[#1605](https://github.com/DemianLi/nexus-agent/issues/1605) N0355）的驗收：真的組裝、真的基座工具、真的檔案系統，
 * 量**模型實際拿到什麼**——送給它的工具清單、系統提示、`read_file` 與 `grep` 的結果。
 *
 * 判準不是「服務有沒有被提供」，而是「關掉的工具模型看不到、調過的上限模型感受得到」；只看服務分不出
 * 「組裝點讀了但沒往下傳」。零憑證、零外部連線：模型是 `ScriptedChatModel`。
 */

import { mkdir, mkdtemp, open, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolMessage } from '@langchain/core/messages';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry } from '@nexus/core';
import { tool } from '@langchain/core/tools';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedToolCall } from './scripted-model.js';
import { toolFsConfigSchema, toolFsPlugin } from './settings/tool-fs.js';
import { toolFsSearchConfigSchema, toolFsSearchPlugin } from './settings/tool-fs-search.js';

const toolFs = (config: Record<string, unknown>): PluginEntry => ({
  plugin: toolFsPlugin as never,
  config,
});
const toolFsSearch = (config: Record<string, unknown> = {}): PluginEntry => ({
  plugin: toolFsSearchPlugin as never,
  config,
});

const WRITE_SENTENCE = 'Read an existing file before overwriting it with write_file';
const EDIT_SENTENCE = 'Read a file before editing it';

function textOf(message: BaseMessage | undefined): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  return (content ?? [])
    .map((block) => ((block as { text?: unknown }).text as string | undefined) ?? '')
    .join('');
}

interface Run {
  readonly results: ToolMessage[];
  /** 模型綁到的工具名。 */
  readonly tools: readonly string[];
  /** 第一輪的系統提示全文。 */
  readonly system: string;
  /** 綁給模型的工具物件裡 `grep` 的描述與參數說明。 */
  readonly grep: { readonly description: string; readonly pattern: string } | undefined;
  /** 綁給模型的每顆工具的描述。 */
  readonly descriptions: Readonly<Record<string, string>>;
}

async function run(
  calls: readonly ScriptedToolCall[],
  options: { readonly plugins: readonly PluginEntry[]; readonly root?: string },
): Promise<Run> {
  const model = new ScriptedChatModel({
    turns: [...calls.map((call) => ({ content: '', toolCalls: [call] })), { content: '收工。' }],
  });
  const backend =
    options.root === undefined
      ? undefined
      : new ContainedFilesystemBackend({ rootDir: options.root, mode: 'workspace-write' });
  const { agent, dispose } = await createNexusAgent({
    model,
    plugins: [...options.plugins],
    ...(backend !== undefined && { backend }),
    checkpointer: new MemorySaver(),
  });
  let messages: BaseMessage[];
  try {
    ({ messages } = (await agent.invoke(toAgentInvocation('做。'), {
      configurable: { thread_id: 'tool-fs' },
    })) as { messages: BaseMessage[] });
  } finally {
    await dispose();
  }
  const definitions = model.boundTools.map((candidate) =>
    convertToOpenAITool(candidate as Parameters<typeof convertToOpenAITool>[0]),
  );
  const grepTool = definitions.find((candidate) => candidate.function.name === 'grep');
  const grepPattern = (
    grepTool?.function.parameters as { properties?: { pattern?: { description?: string } } }
  ).properties?.pattern?.description;
  return {
    descriptions: Object.fromEntries(
      definitions.map((each) => [each.function.name, each.function.description ?? '']),
    ),
    results: messages.filter((message): message is ToolMessage => ToolMessage.isInstance(message)),
    tools: model.boundToolNames,
    system: textOf(model.prompts[0]?.[0]),
    grep:
      grepTool === undefined
        ? undefined
        : {
            description: grepTool.function.description ?? '',
            pattern: grepPattern ?? '',
          },
  };
}

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tool-fs-'));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

describe('設定列的 schema', () => {
  it('省略全部：全開、數值是 dsh 的預設', () => {
    expect(toolFsConfigSchema.parse({})).toEqual({
      read: true,
      write: true,
      edit: true,
      readLimit: 2000,
      readMaxLineLength: 2000,
      readMaxBytes: 51_200,
      readStreamMinSize: 10 * 1024 * 1024,
    });
  });

  it.each(['readLimit', 'readMaxLineLength', 'readMaxBytes', 'readStreamMinSize'])(
    '%s：0、負數、小數、字串都拒收（同 dsh 的 assertPositiveInteger）',
    (key) => {
      for (const bad of [0, -1, 1.5, '10']) {
        expect(toolFsConfigSchema.safeParse({ [key]: bad }).success, `${key}=${String(bad)}`).toBe(
          false,
        );
      }
      expect(toolFsConfigSchema.safeParse({ [key]: 1 }).success).toBe(true);
    },
  );

  it('多寫的欄位是打錯字：strictObject 拒收', () => {
    expect(toolFsConfigSchema.safeParse({ readImage: true }).success).toBe(false);
  });

  it('`read: false` 載入失敗，訊息指名原因（基座要求 read_file 一定在）', () => {
    const result = toolFsConfigSchema.safeParse({ read: false });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('read_file must be included in tools');
    expect(toolFsConfigSchema.safeParse({ read: true }).success).toBe(true);
  });

  it('tool-fs-search 的 grepMaxLineBytes：預設 2000，正整數', () => {
    expect(toolFsSearchConfigSchema.parse({}).grepMaxLineBytes).toBe(2000);
    expect(toolFsSearchConfigSchema.safeParse({ grepMaxLineBytes: 0 }).success).toBe(false);
    expect(toolFsSearchConfigSchema.safeParse({ grepMaxLineBytes: 1.5 }).success).toBe(false);
  });
});

describe('關掉的工具模型看不到，連同它的系統提示', { timeout: 30_000 }, () => {
  it('全開（含沒有這一列）：八顆檔案工具都在，兩句「先讀後改」都在', async () => {
    for (const plugins of [[], [toolFs({})]]) {
      const { tools, system } = await run([], { plugins });
      for (const name of ['ls', 'read_file', 'write_file', 'edit_file', 'delete', 'glob', 'grep']) {
        expect(tools, name).toContain(name);
      }
      expect(system).toContain(WRITE_SENTENCE);
      expect(system).toContain(EDIT_SENTENCE);
    }
  });

  it('`write: false`：write_file 與 delete 不在清單，write 那句不出現，edit 那句還在', async () => {
    const { tools, system } = await run([], { plugins: [toolFs({ write: false })] });

    expect(tools).not.toContain('write_file');
    expect(tools).not.toContain('delete');
    expect(tools).toContain('edit_file');
    expect(tools).toContain('read_file');
    expect(tools).toContain('grep');
    expect(system).not.toContain(WRITE_SENTENCE);
    expect(system).toContain(EDIT_SENTENCE);
  });

  it('`edit: false`：edit_file 不在清單，edit 那句不出現，write 那句還在且不再提 edit_file', async () => {
    const { tools, system } = await run([], { plugins: [toolFs({ edit: false })] });

    expect(tools).not.toContain('edit_file');
    expect(tools).toContain('write_file');
    expect(tools).toContain('delete');
    expect(system).not.toContain(EDIT_SENTENCE);
    expect(system).toContain(WRITE_SENTENCE);
    expect(system).not.toContain('prefer edit_file');
  });

  it('兩個都關：兩句都不出現，讀取面工具照樣在', async () => {
    const { tools, system } = await run([], {
      plugins: [toolFs({ write: false, edit: false })],
    });

    for (const name of ['write_file', 'edit_file', 'delete']) expect(tools).not.toContain(name);
    for (const name of ['ls', 'read_file', 'glob', 'grep']) expect(tools).toContain(name);
    expect(system).not.toContain(WRITE_SENTENCE);
    expect(system).not.toContain(EDIT_SENTENCE);
  });

  it('標成 `disabled: true` 等於沒有這一列：全開', async () => {
    const { tools } = await run([], {
      plugins: [{ ...toolFs({ write: false }), disabled: true } as PluginEntry],
    });

    expect(tools).toContain('write_file');
  });
});

describe('讀檔上限', { timeout: 30_000 }, () => {
  const thirty = `${Array.from({ length: 30 }, (_, i) => `line-${i + 1}`).join('\n')}\n`;

  it('`readLimit: 10`：三十行的檔一頁讀十行，並給續讀提示', async () => {
    const root = await workspace({ 'f.txt': thirty });
    const { results } = await run([{ name: 'read_file', args: { file_path: '/f.txt' } }], {
      plugins: [toolFs({ readLimit: 10 })],
      root,
    });
    const text = textOf(results[0]);

    expect(text).toContain('line-10');
    expect(text).not.toContain('line-11\n');
    expect(text).toContain('offset=10');
  });

  it('沒有這一列：同一個檔三十行一次讀完', async () => {
    const root = await workspace({ 'f.txt': thirty });
    const { results } = await run([{ name: 'read_file', args: { file_path: '/f.txt' } }], {
      plugins: [],
      root,
    });

    expect(textOf(results[0])).toContain('line-30');
  });

  it('`readMaxBytes: 60`：單次讀檔輸出只到 60 位元組，剩下的給續讀提示', async () => {
    const root = await workspace({ 'f.txt': thirty });
    const { results } = await run([{ name: 'read_file', args: { file_path: '/f.txt' } }], {
      plugins: [toolFs({ readMaxBytes: 60 })],
      root,
    });
    const text = textOf(results[0]);

    expect(text).toContain('line-1\n');
    expect(text).not.toContain('line-30');
    expect(text).toMatch(/offset=\d+/u);
  });

  it('`readMaxLineLength: 5`：超過 5 個字元的行被截並標出上限', async () => {
    const root = await workspace({ 'f.txt': 'abcdefghij\nxy\n' });
    const { results } = await run([{ name: 'read_file', args: { file_path: '/f.txt' } }], {
      plugins: [toolFs({ readMaxLineLength: 5 })],
      root,
    });
    const text = textOf(results[0]);

    expect(text).toContain('abcde... (line truncated to 5 chars)');
    expect(text).not.toContain('abcdef');
    expect(text).toContain('xy');
  });

  it('`readStreamMinSize: 1`：連小檔都走串流讀；預設門檻下小檔不走', async () => {
    const root = await workspace({ 'f.txt': thirty });
    const handle = await open(join(root, 'f.txt'));
    const proto = Object.getPrototypeOf(handle) as { createReadStream: () => unknown };
    await handle.close();
    const spy = vi.spyOn(proto, 'createReadStream');
    try {
      const read = [{ name: 'read_file', args: { file_path: '/f.txt' } }];
      await run(read, { plugins: [], root });
      expect(spy).not.toHaveBeenCalled();

      const { results } = await run(read, { plugins: [toolFs({ readStreamMinSize: 1 })], root });
      expect(spy).toHaveBeenCalled();
      expect(textOf(results[0])).toContain('line-30');
    } finally {
      spy.mockRestore();
    }
  });

  it('read_file 的工具描述講的預設行數跟著 readLimit 走', async () => {
    const root = await workspace({ 'f.txt': 'x\n' });
    const tuned = await run([], { plugins: [toolFs({ readLimit: 10 })], root });
    const plain = await run([], { plugins: [], root });

    expect(tuned.descriptions.read_file).toContain('By default, it reads up to 10 lines');
    expect(plain.descriptions.read_file).toContain('By default, it reads up to 2000 lines');
  });
});

describe('grep 是正規式（N0347）', { timeout: 30_000 }, () => {
  it('模型看到的描述與 pattern 說明講的是 regular expression', async () => {
    const { grep } = await run([], { plugins: [] });

    expect(grep?.description).toMatch(/regular expression/iu);
    expect(grep?.description).not.toContain('LITERAL');
    expect(grep?.pattern).toMatch(/regular expression/iu);
  });

  it('`foo|bar` 同時命中兩個檔；`a.c` 的點是任意字元', async () => {
    const root = await workspace({ 'x.txt': 'foo\n', 'y.txt': 'bar\n', 'z.txt': 'abc\n' });
    const { results } = await run(
      [
        { name: 'grep', args: { pattern: 'foo|bar', output_mode: 'files_with_matches' } },
        { name: 'grep', args: { pattern: 'a.c', output_mode: 'files_with_matches' } },
      ],
      { plugins: [], root },
    );

    const first = textOf(results[0]);
    expect(first).toContain('/x.txt');
    expect(first).toContain('/y.txt');
    expect(textOf(results[1])).toContain('/z.txt');
  });
});

describe('grep 每一行命中文字的長度上限（#1605）', { timeout: 30_000 }, () => {
  /** 一萬個中文字（三萬位元組）的一行，開頭有命中字。 */
  const long = `NEEDLE${'漢'.repeat(10_000)}`;

  it('預設 2000 位元組：行內不超過上限、仍是合法 UTF-8、標了截斷', async () => {
    const root = await workspace({ 'big.txt': `${long}\n` });
    const { results } = await run([{ name: 'grep', args: { pattern: 'NEEDLE' } }], {
      plugins: [toolFsSearch()],
      root,
    });
    const text = textOf(results[0]);
    const line = text.split('\n').find((each) => each.includes('NEEDLE')) ?? '';
    const body = line.replace(/^\s*\d+: /u, '').replace(' (line truncated)', '');

    expect(line).toContain('(line truncated)');
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(2000);
    expect(body).not.toContain('�');
    expect(body.startsWith('NEEDLE漢')).toBe(true);
  });

  it('`grepMaxLineBytes: 100`：上限跟著設定走', async () => {
    const root = await workspace({ 'big.txt': `${long}\n` });
    const { results } = await run([{ name: 'grep', args: { pattern: 'NEEDLE' } }], {
      plugins: [toolFsSearch({ grepMaxLineBytes: 100 })],
      root,
    });
    const line =
      textOf(results[0])
        .split('\n')
        .find((each) => each.includes('NEEDLE')) ?? '';
    const body = line.replace(/^\s*\d+: /u, '').replace(' (line truncated)', '');

    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(100);
    expect(body).not.toContain('�');
    expect(line).toContain('(line truncated)');
  });

  it('沒掛 tool-fs-search 這一列：整行原樣（不截）', async () => {
    const root = await workspace({ 'big.txt': `${long}\n` });
    const { results } = await run([{ name: 'grep', args: { pattern: 'NEEDLE' } }], {
      plugins: [],
      root,
    });

    expect(textOf(results[0])).not.toContain('(line truncated)');
    expect(textOf(results[0])).toContain('漢'.repeat(5000));
  });
});

describe('子代理也拿同一份白名單', { timeout: 30_000 }, () => {
  /** 每一次 `bindTools`（root 與子代理各一次以上）收到的工具名。 */
  class RecordingModel extends ScriptedChatModel {
    readonly bindings: string[][] = [];

    override bindTools(tools: readonly unknown[]): ScriptedChatModel {
      this.bindings.push(tools.map((each) => (each as { name: string }).name));
      return super.bindTools(tools);
    }
  }

  const WORKER: PluginEntry = {
    plugin: {
      name: 'tool-fs-host',
      apply(registry) {
        registry.tools.register(
          tool(() => 'pong', { name: 'ping', description: '回 pong。', schema: z.object({}) }),
        );
        registry.subagents.register({
          name: 'worker',
          description: '幹活的。',
          systemPrompt: '你是 worker。',
        });
      },
    },
  };

  it('`write: false`、`edit: false`：root 與子代理的每一次綁定都沒有 write_file／edit_file／delete，讀取面都在', async () => {
    const model = new RecordingModel({
      turns: [
        {
          content: '',
          toolCalls: [{ name: 'task', args: { description: '做', subagent_type: 'worker' } }],
        },
        { content: '子代理做完了。' },
        { content: '收工。' },
      ],
    });
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [WORKER, toolFs({ write: false, edit: false })],
      checkpointer: new MemorySaver(),
    });
    try {
      await agent.invoke(toAgentInvocation('做。'), { configurable: { thread_id: 'sub' } });
    } finally {
      await dispose();
    }

    // root、子代理、root 回來：至少兩次不同的綁定，不然這條沒量到子代理。
    expect(model.bindings.length).toBeGreaterThanOrEqual(2);
    expect(model.bindings.some((names) => names.includes('task'))).toBe(true);
    expect(model.bindings.some((names) => !names.includes('task'))).toBe(true);
    for (const names of model.bindings) {
      for (const closed of ['write_file', 'edit_file', 'delete']) {
        expect(names, closed).not.toContain(closed);
      }
      for (const kept of ['ls', 'read_file', 'glob', 'grep']) expect(names, kept).toContain(kept);
    }
  });
});
