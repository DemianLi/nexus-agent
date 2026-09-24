/**
 * **讀檔結果最後告訴模型讀到哪了**——[#594](https://github.com/DemianLi/nexus-agent/issues/594) 的驗收，
 * 量的是真的組裝、真的基座 `read_file` 跑完之後，模型拿到什麼、會話日誌記下什麼。
 *
 * 那一層自己的邏輯在 `@nexus/core` 的 `read-continuation.test.ts`；這一份量的是掛進真的組裝之後：
 * 基座的工具真的經過包過的 backend、真的自己編號與截斷，提示真的跨過一整條 middleware 鏈進了日誌。
 * 兩條 backend 都走：`--workspace` 的 `ContainedFilesystemBackend`，與沒給時的 `StateBackend`。
 *
 * 「基座自己截斷」那一條同時是**上游絆索**：它認的是基座 `READ_FILE_TRUNCATION_MSG` 的開頭，
 * 基座換了措辭，這一條會紅。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { SessionRegistry } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

interface Call {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/** `n` 行的檔，第 i 行（1 起算）是 `line i`，結尾有換行。 */
function numbered(n: number): string {
  return `${Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')}\n`;
}

/** 工具訊息的文字：基座回的是文字塊陣列。 */
function textOf(message: ToolMessage | undefined): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  return (content ?? [])
    .map((block) => ((block as { text?: unknown }).text as string | undefined) ?? '')
    .join('');
}

describe('讀檔結果最後補上讀到哪', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nexus-read-continuation-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /**
   * 依序跑幾顆呼叫，回模型拿到的工具訊息與 root 日誌上每顆 `tool/result` 的整份內容。
   *
   * @param workspace - 給就走 `ContainedFilesystemBackend`，不給走基座預設的 `StateBackend`。
   */
  async function run(
    calls: readonly Call[],
    workspace = true,
  ): Promise<{ messages: ToolMessage[]; logged: string[] }> {
    const { agent, attachSession, dispose } = await createNexusAgent({
      model: new ScriptedChatModel({
        turns: [
          ...calls.map((call) => ({ content: '', toolCalls: [call] })),
          { content: '收工。' },
        ],
      }),
      ...(workspace
        ? { backend: new ContainedFilesystemBackend({ rootDir: root, mode: 'workspace-write' }) }
        : {}),
      checkpointer: new MemorySaver(),
      plugins: [],
    });
    const sessions = new SessionRegistry('read-continuation');
    const detach = attachSession(sessions);
    let state: { messages: BaseMessage[] };
    try {
      state = (await agent.invoke(toAgentInvocation('讀。'), {
        configurable: { thread_id: 'read-continuation' },
      })) as { messages: BaseMessage[] };
    } finally {
      detach();
      await dispose();
    }
    const rootLog = sessions.list().find((entry) => entry.address.kind === 'root');
    return {
      messages: state.messages.filter((message): message is ToolMessage =>
        ToolMessage.isInstance(message),
      ),
      logged: (rootLog?.log.events ?? []).flatMap((event) =>
        event.type === 'tool/result' ? [JSON.stringify(event.data.message)] : [],
      ),
    };
  }

  it('沒讀完：模型拿到下一頁的 offset，照它讀的第一行剛好接上；日誌記的是同一份', async () => {
    await writeFile(join(root, 'app.log'), numbered(250));
    const { messages, logged } = await run([
      { name: 'read_file', args: { file_path: '/app.log' } },
      { name: 'read_file', args: { file_path: '/app.log', offset: 100 } },
      { name: 'read_file', args: { file_path: '/app.log', offset: 200 } },
    ]);
    const [first, second, third] = messages.map(textOf);
    expect(first).toMatch(
      / {3}100\tline 100\n\n\(Showing lines 1-100 of 250\. Use offset=100 to continue\.\)$/,
    );
    expect(second?.split('\n')[0]).toBe('   101\tline 101');
    expect(second).toMatch(/\(Showing lines 101-200 of 250\. Use offset=200 to continue\.\)$/);
    expect(third).toMatch(/ {3}250\tline 250\n\n\(End of file - total 250 lines\)$/);
    expect(logged[0]).toContain('Use offset=100 to continue.');
  }, 20000);

  it('反例：一頁讀得完的檔只寫檔尾，不叫模型翻頁', async () => {
    await writeFile(join(root, 'small.txt'), numbered(3));
    const { messages } = await run([{ name: 'read_file', args: { file_path: '/small.txt' } }]);
    expect(textOf(messages[0])).toBe(
      '     1\tline 1\n     2\tline 2\n     3\tline 3\n\n(End of file - total 3 lines)',
    );
  }, 20000);

  it('讀失敗照舊是錯誤，不補', async () => {
    const { messages } = await run([{ name: 'read_file', args: { file_path: '/nope.txt' } }]);
    expect(messages[0]?.status).toBe('error');
    expect(textOf(messages[0])).not.toContain('End of file');
  }, 20000);

  it('基座自己截斷（上游絆索）：寫 Output capped，下一頁從最後那一行重讀', async () => {
    // 100 行、每行 1000 字元：格式化後超過基座的 80,000 字元上限。
    const long = Array.from({ length: 100 }, (_, i) => `${i + 1}:${'x'.repeat(1000)}`).join('\n');
    await writeFile(join(root, 'wide.txt'), long);
    const { messages } = await run([{ name: 'read_file', args: { file_path: '/wide.txt' } }]);
    const text = textOf(messages[0]);
    expect(text).toContain('[Output was truncated due to size limits.');
    const footer =
      /\(Output capped\. Showing lines 1-(\d+)\. Use offset=(\d+) to continue\.\)$/.exec(text);
    expect(footer).not.toBeNull();
    // 完整顯示到第 B 行，下一頁的 offset（0 起算）是 B，也就是從第 B+1 行重讀。
    expect(footer?.[1]).toBe(footer?.[2]);
    const shown = Number(footer?.[1]);
    expect(text).toContain(`\t${shown}:`);
    expect(shown).toBeLessThan(100);
  }, 20000);

  it('沒給 --workspace（基座的 StateBackend）一樣補', async () => {
    const { messages } = await run(
      [
        { name: 'write_file', args: { file_path: '/notes.txt', content: numbered(150) } },
        { name: 'read_file', args: { file_path: '/notes.txt' } },
      ],
      false,
    );
    expect(textOf(messages[1])).toMatch(
      /\(Showing lines 1-100 of 150\. Use offset=100 to continue\.\)$/,
    );
  }, 20000);
});
