/**
 * core 的工具事件夾在插件監聽者外側與內側（#2416 驗收）。插件以事件監聽者掛進工具呼叫時，兩件事要成立：
 *
 * - 外溢排在每一位插件監聽者外側，量到的是插件換過的結果；
 * - 先讀後改排在插件的 execute 監聽者內側：監聽者短路掉的 `read_file` 沒有讀到磁碟，不算讀過，之後的寫入照樣被拒。
 *
 * 組裝是真的 `createNexusAgent` 加真的磁碟。
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry } from '@nexus/core';
import { tool } from 'langchain';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';

const MARK = 'PLUGIN-REPLACED-7731';

/** 每行都不一樣、約 5 萬字元，遠超下面的預算。 */
const BIG = Array.from(
  { length: 1_000 },
  (_, index) => `${MARK} line ${index} alpha beta ${index * 7919}`,
).join('\n');

const BUDGET = 3_000;

function text(message: BaseMessage): string {
  const content = message.content;
  return typeof content === 'string' ? content : JSON.stringify(content);
}

async function toolTexts(
  turns: ScriptedTurn[],
  plugins: PluginEntry[],
  options: { root?: string; spill?: boolean } = {},
): Promise<string[]> {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), 'nexus-listener-order-')));
  const { agent, dispose } = await createNexusAgent({
    model: new ScriptedChatModel({ turns }),
    backend: new ContainedFilesystemBackend({ rootDir: root }),
    checkpointer: new MemorySaver(),
    plugins,
    ...(options.spill === true && {
      toolResultStash: { rootDir: root, session: 'listener-order' },
      spillPolicy: { maxInlineTokens: BUDGET },
    }),
  });
  try {
    const result = await agent.invoke(toAgentInvocation('動手。'), {
      configurable: { thread_id: 'listener-order' },
    });
    return (result.messages as BaseMessage[])
      .filter((message) => message.getType() === 'tool')
      .map(text);
  } finally {
    await dispose();
  }
}

const small: PluginEntry = {
  plugin: {
    name: 'small-host',
    apply: (registry) =>
      void registry.tools.register(
        tool(() => '一點點', { name: 'small', description: '拿一點。', schema: z.object({}) }),
      ),
  },
};

const callSmall: ScriptedTurn[] = [
  { content: '', toolCalls: [{ name: 'small', args: {} }] },
  { content: '看完了。' },
];

describe('外溢量到的是插件換過的結果', () => {
  it.each([
    [
      'post-execute 換成一大坨',
      {
        plugin: {
          name: 'replace-post',
          apply: (registry) =>
            void registry.events.on('tools/post-execute', async (exec, _result, next) =>
              exec.name === 'small' ? { kind: 'replace' as const, content: BIG } : next(),
            ),
        },
      } satisfies PluginEntry,
    ],
    [
      'execute 跑完本體後換成一大坨',
      {
        plugin: {
          name: 'replace-execute',
          apply: (registry) =>
            void registry.events.on('tools/execute', async (exec, next) => {
              const result = await next();
              return exec.name === 'small'
                ? { kind: 'message' as const, isError: false, content: BIG }
                : result;
            }),
        },
      } satisfies PluginEntry,
    ],
  ] as const)('%s：模型收到的是外溢預覽，不是全文', async (_label, replacer) => {
    const [seen] = await toolTexts(callSmall, [small, replacer], { spill: true });
    expect(seen).toContain(MARK);
    expect(seen).toMatch(/stored at: \/\S+?\.txt\./u);
    expect(seen!.length).toBeLessThan(BIG.length / 2);
  });

  it('對照：沒掛外溢，同一個插件換過的結果原樣進模型', async () => {
    const replacer: PluginEntry = {
      plugin: {
        name: 'replace-post',
        apply: (registry) =>
          void registry.events.on('tools/post-execute', async (exec, _result, next) =>
            exec.name === 'small' ? { kind: 'replace' as const, content: BIG } : next(),
          ),
      },
    };
    const [seen] = await toolTexts(callSmall, [small, replacer]);
    expect(seen).toBe(BIG);
  });
});

const ORIGINAL = '原本的內容';

/** 對 `read_file` 短路：不呼叫 `next()`，交回自己編的內容，工具本體不跑。 */
const fakeRead: PluginEntry = {
  plugin: {
    name: 'fake-read',
    apply: (registry) =>
      void registry.events.on('tools/execute', async (exec, next) =>
        exec.name === 'read_file'
          ? { kind: 'message' as const, isError: false, content: '     1\t插件編的內容' }
          : next(),
      ),
  },
};

const readThenWrite: ScriptedTurn[] = [
  { content: '', toolCalls: [{ name: 'read_file', args: { file_path: '/notes.md' } }] },
  {
    content: '',
    toolCalls: [{ name: 'write_file', args: { file_path: '/notes.md', content: '蓋掉' } }],
  },
  { content: '好了。' },
];

describe('execute 監聽者短路時，寫入繞不過先讀後改', () => {
  it('短路掉的 read_file 不算讀過：接著的 write_file 被拒，磁碟不變', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-listener-order-'));
    await writeFile(join(root, 'notes.md'), ORIGINAL);
    const [read, write] = await toolTexts(readThenWrite, [fakeRead], { root });
    expect(read).toContain('插件編的內容');
    expect(write).toContain('覆蓋它之前要先讀過');
    expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe(ORIGINAL);
  });

  it('對照：沒有短路，真的讀過之後同一個寫入會過', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-listener-order-'));
    await writeFile(join(root, 'notes.md'), ORIGINAL);
    const [read, write] = await toolTexts(readThenWrite, [], { root });
    expect(read).toContain(ORIGINAL);
    expect(write).not.toMatch(/^Error/u);
    expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe('蓋掉');
  });
});
