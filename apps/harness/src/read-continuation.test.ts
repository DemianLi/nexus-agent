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
 * 一頁多大照 dsh（[#602](https://github.com/DemianLi/nexus-agent/issues/602)）：預設 2000 行、50 KiB。
 * 模型收到的說明量在 `read-limits-openai.test.ts`。
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
    await writeFile(join(root, 'app.log'), numbered(4500));
    const { messages, logged } = await run([
      { name: 'read_file', args: { file_path: '/app.log' } },
      { name: 'read_file', args: { file_path: '/app.log', offset: 2000 } },
      { name: 'read_file', args: { file_path: '/app.log', offset: 4000 } },
    ]);
    const [first, second, third] = messages.map(textOf);
    // 沒給 `limit`：一頁 2000 行，同 dsh。
    expect(first).toMatch(
      / {2}2000\tline 2000\n\n\(Showing lines 1-2000 of 4500\. Use offset=2000 to continue\.\)$/,
    );
    expect(second?.split('\n')[0]).toBe('  2001\tline 2001');
    expect(second).toMatch(/\(Showing lines 2001-4000 of 4500\. Use offset=4000 to continue\.\)$/);
    expect(third).toMatch(/ {2}4500\tline 4500\n\n\(End of file - total 4500 lines\)$/);
    expect(logged[0]).toContain('Use offset=2000 to continue.');
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

  it('位元組上限：選到的行累計超過 50 KiB 就停在前一行，照提示翻頁接得上', async () => {
    // 100 行、每行 1002–1004 位元組：前 51 行累計 51,194（含換行），第 52 行放不下。
    const long = Array.from({ length: 100 }, (_, i) => `${i + 1}:${'x'.repeat(1000)}`).join('\n');
    await writeFile(join(root, 'wide.txt'), long);
    const { messages } = await run([
      { name: 'read_file', args: { file_path: '/wide.txt' } },
      { name: 'read_file', args: { file_path: '/wide.txt', offset: 51 } },
    ]);
    const [first, second] = messages.map(textOf);
    expect(first).not.toContain('[Output was truncated due to size limits.');
    expect(first).toMatch(
      /\t51:x+\n\n\(Output capped\. Showing lines 1-51\. Use offset=51 to continue\.\)$/,
    );
    expect(second?.split('\n')[0]).toMatch(/^ {4}52\t52:x+$/);
    // 剩下 49 行約 49 KB，一頁放得下。
    expect(second).toMatch(/\t100:x+\n\n\(End of file - total 100 lines\)$/);
  }, 20000);

  it('limit 超過 2000：dsh 的原句，是工具錯誤', async () => {
    await writeFile(join(root, 'small.txt'), numbered(3));
    const { messages, logged } = await run([
      { name: 'read_file', args: { file_path: '/small.txt', limit: 2001 } },
    ]);
    expect(messages[0]?.status).toBe('error');
    expect(textOf(messages[0])).toContain('limit must be less than or equal to 2000');
    expect(textOf(messages[0])).not.toContain('line 1');
    expect(logged[0]).toContain('limit must be less than or equal to 2000');
  }, 20000);

  it('基座自己截斷（上游絆索）：第一行自己就超過上限時落到這條，寫 Output capped', async () => {
    // 第一行 90,000 字元：超過 50 KiB，照樣給它（偏離二），格式化後超過基座的 80,000 字元上限。
    await writeFile(join(root, 'wide.txt'), `${'x'.repeat(90_000)}\nsecond\n`);
    const { messages } = await run([
      { name: 'read_file', args: { file_path: '/wide.txt' } },
      { name: 'read_file', args: { file_path: '/wide.txt', offset: 1 } },
    ]);
    const [first, second] = messages.map(textOf);
    expect(first).toContain('[Output was truncated due to size limits.');
    // 第一行就沒顯示完：重讀只會再截一次，所以跳過它。
    expect(first).toMatch(/\(Output capped\. Use offset=1 to continue\.\)$/);
    expect(second).toBe('     2\tsecond\n\n(End of file - total 2 lines)');
  }, 20000);

  it('沒給 --workspace（基座的 StateBackend）一樣補', async () => {
    const { messages } = await run(
      [
        { name: 'write_file', args: { file_path: '/notes.txt', content: numbered(2100) } },
        { name: 'read_file', args: { file_path: '/notes.txt' } },
      ],
      false,
    );
    expect(textOf(messages[1])).toMatch(
      /\(Showing lines 1-2000 of 2100\. Use offset=2000 to continue\.\)$/,
    );
  }, 20000);
});
