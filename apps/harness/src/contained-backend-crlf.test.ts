/**
 * **改檔保留 CRLF**（[#1563](https://github.com/DemianLi/nexus-agent/issues/1563) N0335）：Windows 行尾的檔，模型照讀到的內容去改就改得成功，
 * 而且行尾保持原樣。照 dsh `fs-local` 的 `readForEdit`／`applyLiteralEdit`／`restoreLineEndings`（`fsio.ts:683-836`，`687f282e`）。
 *
 * 每一條都**看磁碟上的位元組**：行尾對不對的答案在檔案內容上，不在回傳值的措辭上。拿掉正規化，CRLF 檔裡 LF 寫的 `old_string` 就回「找不到」；
 * 拿掉還原，LF 的新內容會混進 CRLF 檔裡。
 *
 * **零憑證、零外部連線**：`read_file` 那一條的模型是 `ScriptedChatModel`。
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

let root: string;
let backend: ContainedFilesystemBackend;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexus-crlf-'));
  backend = new ContainedFilesystemBackend({ rootDir: root, mode: 'workspace-write' });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const bytesOf = async (name: string): Promise<string> =>
  (await readFile(join(root, name))).toString('latin1');

describe('edit：CRLF 檔', () => {
  it('LF 寫的 old_string 對得上，改完行尾還是 CRLF', async () => {
    await writeFile(join(root, 'a.txt'), 'a\r\nb\r\n');
    const result = await backend.edit('/a.txt', 'a\nb', 'X\nb');
    expect(result).toMatchObject({ path: '/a.txt', occurrences: 1 });
    expect(result.error).toBeUndefined();
    expect(await bytesOf('a.txt')).toBe('X\r\nb\r\n');
  });

  it('照抄 CRLF 寫的 old_string／new_string 也對得上，不會變成 `\\r\\r\\n`', async () => {
    await writeFile(join(root, 'a.txt'), 'a\r\nb\r\nc\r\n');
    const result = await backend.edit('/a.txt', 'a\r\nb', 'X\r\nY');
    expect(result.error).toBeUndefined();
    expect(await bytesOf('a.txt')).toBe('X\r\nY\r\nc\r\n');
  });

  it('new_string 帶換行：新增的行也是 CRLF', async () => {
    await writeFile(join(root, 'a.txt'), 'a\r\nb\r\n');
    await backend.edit('/a.txt', 'a', 'a1\na2');
    expect(await bytesOf('a.txt')).toBe('a1\r\na2\r\nb\r\n');
  });

  it('replace_all 在 CRLF 檔上照算次數', async () => {
    await writeFile(join(root, 'a.txt'), 'x\r\nx\r\ny\r\n');
    const result = await backend.edit('/a.txt', 'x\n', 'z\n', true);
    expect(result).toMatchObject({ occurrences: 2 });
    expect(await bytesOf('a.txt')).toBe('z\r\nz\r\ny\r\n');
  });

  it('LF 檔改完仍是 LF，沒有被誤加 `\\r`', async () => {
    await writeFile(join(root, 'a.txt'), 'a\nb\n');
    const result = await backend.edit('/a.txt', 'a\nb', 'X\nb');
    expect(result.error).toBeUndefined();
    expect(await bytesOf('a.txt')).toBe('X\nb\n');
  });

  it('沒有換行的檔照 LF 處理；開頭的 BOM 留著', async () => {
    await writeFile(join(root, 'plain.txt'), 'hello');
    await backend.edit('/plain.txt', 'hello', 'bye\nnow');
    expect(await bytesOf('plain.txt')).toBe('bye\nnow');

    await writeFile(
      join(root, 'bom.txt'),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\ntwo\r\n')]),
    );
    await backend.edit('/bom.txt', 'two', 'TWO');
    expect((await readFile(join(root, 'bom.txt'))).toString('hex')).toBe(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\nTWO\r\n')]).toString(
        'hex',
      ),
    );
  });

  it('找不到：錯誤字句仍回顯模型給的原字串，檔案原封不動', async () => {
    await writeFile(join(root, 'a.txt'), 'a\r\nb\r\n');
    const result = await backend.edit('/a.txt', 'a\r\nzzz', 'X');
    expect(result.error).toBe("Error: String not found in file: 'a\r\nzzz'");
    expect(await bytesOf('a.txt')).toBe('a\r\nb\r\n');
  });

  it('命中兩處又沒有 replace_all：字句照基座，檔案原封不動', async () => {
    await writeFile(join(root, 'a.txt'), 'x\r\nx\r\n');
    const result = await backend.edit('/a.txt', 'x', 'y');
    expect(result.error).toContain(
      "String 'x' has multiple occurrences (appears 2 times) in file.",
    );
    expect(await bytesOf('a.txt')).toBe('x\r\nx\r\n');
  });

  it('二進位與壞掉的 UTF-8 不改：位元組原封不動（有損解碼再寫回會換成 U+FFFD）', async () => {
    const nul = Buffer.from([0x61, 0x00, 0x62]);
    await writeFile(join(root, 'nul.bin'), nul);
    expect(await backend.edit('/nul.bin', 'a', 'X')).toMatchObject({
      error: 'cannot edit "/nul.bin": binary file',
    });
    expect(await readFile(join(root, 'nul.bin'))).toEqual(nul);

    const bad = Buffer.from([0x61, 0xff, 0xfe, 0x62]);
    await writeFile(join(root, 'bad.txt'), bad);
    expect(await backend.edit('/bad.txt', 'a', 'X')).toMatchObject({
      error: 'cannot edit "/bad.txt": invalid UTF-8 text',
    });
    expect(await readFile(join(root, 'bad.txt'))).toEqual(bad);
  });
});

describe('write：不還原行尾（照 dsh）', () => {
  it('內容原樣寫進去', async () => {
    await backend.write('/w.txt', 'a\nb\n');
    expect(await bytesOf('w.txt')).toBe('a\nb\n');
    await backend.write('/w.txt', 'a\r\nb\r\n');
    expect(await bytesOf('w.txt')).toBe('a\r\nb\r\n');
  });
});

describe('read：只有 read_file 裡去掉行尾 `\\r`', () => {
  it('read_file 讀 CRLF 檔：每一行都不以 `\\r` 結尾，版本仍對原文算（讀完直接改不被擋）', async () => {
    await writeFile(join(root, 'c.txt'), 'one\r\ntwo\r\nthree\r\n');
    const { agent, dispose } = await createNexusAgent({
      model: new ScriptedChatModel({
        turns: [
          { content: '', toolCalls: [{ name: 'read_file', args: { file_path: '/c.txt' } }] },
          {
            content: '',
            toolCalls: [
              {
                name: 'edit_file',
                // 模型照讀到的內容寫：沒有 `\r`。
                args: { file_path: '/c.txt', old_string: 'one\ntwo', new_string: '1\n2' },
              },
            ],
          },
          { content: '收工。' },
        ],
      }),
      backend,
      checkpointer: new MemorySaver(),
      plugins: [],
    });
    let state: { messages: BaseMessage[] };
    try {
      state = (await agent.invoke(toAgentInvocation('讀。'), {
        configurable: { thread_id: 'crlf' },
      })) as { messages: BaseMessage[] };
    } finally {
      await dispose();
    }
    const [readMessage, editMessage] = state.messages.filter((message): message is ToolMessage =>
      ToolMessage.isInstance(message),
    );
    const text = (message: ToolMessage | undefined): string => {
      const content = message?.content;
      if (typeof content === 'string') return content;
      return (content ?? [])
        .map((block) => ((block as { text?: unknown }).text as string | undefined) ?? '')
        .join('');
    };
    expect(text(readMessage)).not.toContain('\r');
    expect(text(readMessage)).toContain('     1\tone\n     2\ttwo\n     3\tthree\n');
    expect(editMessage?.status).not.toBe('error');
    expect(text(editMessage)).toContain('Successfully replaced');
    expect(await bytesOf('c.txt')).toBe('1\r\n2\r\nthree\r\n');
  }, 60000);

  it('不在 read_file 裡的 read（摘要器、直接呼叫）維持基座的切片語意：`\\r` 原樣', async () => {
    await writeFile(join(root, 'c.txt'), 'one\r\ntwo\r\n');
    const result = await backend.read('/c.txt');
    expect(result.content).toBe('one\r\ntwo\r\n');
  });
});
