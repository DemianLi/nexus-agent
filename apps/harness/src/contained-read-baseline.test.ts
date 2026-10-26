/**
 * **讀檔行為的基準**（[#1530](https://github.com/DemianLi/nexus-agent/issues/1530) 驗收 4、8）：在動 `read` 之前，把今天 develop
 * （`959e9af7`）上 `ContainedFilesystemBackend.read` 與真的 `read_file` 工具對每一種檔回的東西逐字記下來。之後把 `read`
 * 改成自己讀、串流、建視窗，這份要一直綠——字句與內容「逐字相同」不是靠讀基座原始碼抄，是靠這份對照。
 *
 * 兩處**刻意**不在這裡：行長截斷（驗收 1）與副檔名不再決定（驗收 6），它們是這張要改的行為，各有自己的測試。
 * 錯誤訊息裡帶根目錄的絕對路徑（基座的 `stat '…'`、`open '…'`），比對前換成 `<ROOT>`。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { SessionRegistry } from '@nexus/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

const textOf = (message: ToolMessage | undefined): string => {
  const content = message?.content;
  if (typeof content === 'string') return content;
  return (content ?? [])
    .map((block) => ((block as { text?: unknown }).text as string | undefined) ?? '')
    .join('');
};

let root: string;
let outside: string;
let backend: ContainedFilesystemBackend;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexus-read-baseline-'));
  outside = await mkdtemp(join(tmpdir(), 'nexus-read-baseline-out-'));
  await writeFile(join(root, 'empty.txt'), '');
  await writeFile(join(root, 'blank.txt'), '  \n\t\n');
  await writeFile(join(root, 'two.txt'), 'a\nb\n');
  await writeFile(join(root, 'nul.txt'), Buffer.from([0x61, 0, 0x62]));
  await writeFile(join(root, 'bad.txt'), Buffer.from([0x61, 0xff, 0xfe, 0x62]));
  await mkdir(join(root, 'dir'));
  await writeFile(join(outside, 'secret.txt'), 'secret\n');
  // 根內互指的檔案連結照舊 `ELOOP`（基座的 `O_NOFOLLOW`）；指向根外的在那之前就被讀取面的圍堵拒掉（#1982）。
  await symlink(join(root, 'two.txt'), join(root, 'link.txt'));
  await symlink(join(outside, 'secret.txt'), join(root, 'out-link.txt'));
  await writeFile(join(root, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n');
  await writeFile(
    join(root, 'bom.txt'),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom line\nsecond\n')]),
  );
  await writeFile(join(root, 'tail.txt'), 'x\ny\nz\n');
  await writeFile(join(root, 'notail.txt'), 'x\ny\nz');
  await writeFile(join(root, 'cjk.txt'), '你好\n世界🙂\n');
  backend = new ContainedFilesystemBackend({ rootDir: root, mode: 'workspace-write' });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

/** 把根目錄的絕對路徑換掉，讓基座帶路徑的錯誤字句可以逐字比對。 */
const scrub = (text: string): string =>
  text.split(root).join('<ROOT>').split(outside).join('<OUT>');

describe('ContainedFilesystemBackend.read：十種情況與切片，字句與內容逐字不變', () => {
  const cases: [string, string, number, number, unknown][] = [
    [
      'missing',
      '/nope.txt',
      0,
      2000,
      {
        error:
          "Error reading file '/nope.txt': ENOENT: no such file or directory, stat '<ROOT>/nope.txt'",
      },
    ],
    ['directory', '/dir', 0, 2000, { error: "File '/dir' not found" }],
    [
      'symlink',
      '/link.txt',
      0,
      2000,
      {
        error:
          "Error reading file '/link.txt': ELOOP: too many symbolic links encountered, open '<ROOT>/link.txt'",
      },
    ],
    [
      'outward-symlink',
      '/out-link.txt',
      0,
      2000,
      {
        error:
          '[containment] 拒絕 read "/out-link.txt"：經符號連結解析之後落在根之外（mode: workspace-write）',
      },
    ],
    [
      'dotdot',
      '/../x.txt',
      0,
      2000,
      { error: "Error reading file '/../x.txt': Path traversal not allowed" },
    ],
    [
      'empty',
      '/empty.txt',
      0,
      2000,
      { content: 'System reminder: File exists but has empty contents', mimeType: 'text/plain' },
    ],
    [
      'blank',
      '/blank.txt',
      0,
      2000,
      { content: 'System reminder: File exists but has empty contents', mimeType: 'text/plain' },
    ],
    ['offset-beyond', '/two.txt', 5, 10, { error: 'Line offset 5 exceeds file length (3 lines)' }],
    ['nul', '/nul.txt', 0, 2000, { error: 'cannot read "/nul.txt": binary file' }],
    ['bad-utf8', '/bad.txt', 0, 2000, { error: 'cannot read "/bad.txt": invalid UTF-8 text' }],
    ['two-slice', '/two.txt', 0, 1, { content: 'a', mimeType: 'text/plain' }],
  ];

  it.each(cases)('%s', async (_name, path, offset, limit, expected) => {
    const result = await backend.read(path, offset, limit);
    expect(JSON.parse(scrub(JSON.stringify(result)))).toEqual(expected);
  });
});

describe('真的 read_file 工具：ToolMessage 逐字不變', () => {
  const expected: [string, 'success' | 'error', string][] = [
    // CRLF 檔：行尾的 `\r` 去掉（#1563 N0335，照 dsh `read-render.ts:91-93`）。這是這份基準唯一被刻意改掉的一格。
    [
      '/crlf.txt',
      'success',
      '     1\tone\n     2\ttwo\n     3\tthree\n\n(End of file - total 3 lines)',
    ],
    ['/bom.txt', 'success', '     1\t﻿bom line\n     2\tsecond\n\n(End of file - total 2 lines)'],
    ['/tail.txt', 'success', '     1\tx\n     2\ty\n     3\tz\n\n(End of file - total 3 lines)'],
    ['/notail.txt', 'success', '     1\tx\n     2\ty\n     3\tz\n\n(End of file - total 3 lines)'],
    ['/cjk.txt', 'success', '     1\t你好\n     2\t世界🙂\n\n(End of file - total 2 lines)'],
    ['/two.txt', 'success', '     1\ta\n     2\tb\n\n(End of file - total 2 lines)'],
    ['/empty.txt', 'success', '     1\tSystem reminder: File exists but has empty contents'],
    ['/blank.txt', 'success', '     1\tSystem reminder: File exists but has empty contents'],
    [
      '/nope.txt',
      'error',
      "Error: Error reading file '/nope.txt': ENOENT: no such file or directory, stat '<ROOT>/nope.txt'",
    ],
    ['/dir', 'error', "Error: File '/dir' not found"],
    ['/nul.txt', 'error', 'Error: cannot read "/nul.txt": binary file'],
    ['/bad.txt', 'error', 'Error: cannot read "/bad.txt": invalid UTF-8 text'],
  ];

  it('每一種檔的結果', async () => {
    const { agent, attachSession, dispose } = await createNexusAgent({
      model: new ScriptedChatModel({
        turns: [
          ...expected.map(([file]) => ({
            content: '',
            toolCalls: [{ name: 'read_file', args: { file_path: file } }],
          })),
          { content: '收工。' },
        ],
      }),
      backend,
      checkpointer: new MemorySaver(),
      plugins: [],
    });
    const sessions = new SessionRegistry('read-baseline');
    const detach = attachSession(sessions);
    let state: { messages: BaseMessage[] };
    try {
      state = (await agent.invoke(toAgentInvocation('讀。'), {
        configurable: { thread_id: 'read-baseline' },
      })) as { messages: BaseMessage[] };
    } finally {
      detach();
      await dispose();
    }
    const messages = state.messages.filter((message): message is ToolMessage =>
      ToolMessage.isInstance(message),
    );
    expect(messages.map((message) => [message.status, scrub(textOf(message))])).toEqual(
      expected.map(([, status, text]) => [status, text]),
    );
  }, 60000);
});
