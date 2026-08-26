/**
 * `permissions` 擴充點的**行為**驗收（[#34](https://github.com/DemianLi/nexus-agent/issues/34)
 * 的「主路徑驗收」後半）。
 *
 * Phase 1 只驗到物件形狀——fold 產出的 `permissions` 陣列長得對。**形狀對而行為錯正是這個
 * 擴充點最容易出的錯**，因為基座是**無規則命中即 allow**：一條沒被套用的規則與一條不存在的
 * 規則，在物件層面分不出來，在行為層面差別是全開。
 *
 * 兩件事在這裡第一次有行為證據：
 *
 * 1. **deny 規則擋得住 `.env` 類路徑**，而且是在**真的磁碟**上（`StateBackend` 的「檔案」
 *    只是 state 裡的一個 map，擋住它證明不了什麼）。
 * 2. **subagent 裡執行的操作同樣被擋**——[#28](https://github.com/DemianLi/nexus-agent/issues/28)
 *    決議 4「全域 deny 主動併進每個 subagent」的行為證據。
 *
 * 第 2 點要補一句決議當時沒說的：**整組替換只發生在 subagent 自帶了 `permissions` 的時候**。
 * 基座解析的是 `input.permissions ?? permissions`（`createDeepAgent` 內，1.13.1 實測），所以
 * 什麼都沒帶的 subagent 本來就會沿用 root 那份，fold 併不併都一樣。決議 4 真正在防的是
 * **自帶設定**的那一種——`??` 的左邊一有值，root 那份就整組不見了。這組測試因此刻意用一個
 * 自帶規則的 subagent；用一個什麼都沒帶的去測，等於什麼都沒測到。
 *
 * 每一條都**看磁碟**：擋沒擋住的答案在檔案內容上，不在回傳值的措辭上。
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NexusPlugin } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

const SECRET = 'SECRET=不該被改掉';

/** 一個有 `.env` 的可寫根。 */
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-perm-'));
  await writeFile(join(root, '.env'), SECRET);
  return root;
}

/** 擋掉 `.env` 類路徑的 plugin。 */
const guard: NexusPlugin = {
  name: 'guard',
  apply: (registry) => void registry.permissions.deny(['/.env*']),
};

/**
 * 註冊一個**自帶 `permissions`** 的 subagent。
 *
 * 自帶這件事是這組測試的關鍵。基座解析 subagent 的規則是
 * `input.permissions ?? permissions`（`createDeepAgent` 內，1.13.1）——**沒自帶的 subagent 會
 * 直接沿用 root 那份**，所以拿一個什麼都沒帶的 subagent 去測，fold 那一步在不在都會過。
 * 真正需要 fold 主動併入的是**自帶了設定**的這一種：`??` 的左邊一有值，root 那份就整組
 * 不見了。
 *
 * 它自己那條規則刻意跟 `.env` 無關——它只是用來讓 `input.permissions` 非空。
 */
const crew: NexusPlugin = {
  name: 'crew',
  apply: (registry) =>
    void registry.subagents.register({
      name: 'writer',
      description: '負責寫檔的 subagent。',
      permissions: [{ operations: ['read', 'write'], paths: ['/機密/**'], mode: 'deny' }],
    }),
};

describe('deny 規則在 Disk backend 上', () => {
  it('擋得住 .env，磁碟上的內容一個字都沒動', async () => {
    const root = await workspace();
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '',
          toolCalls: [{ name: 'write_file', args: { file_path: '/.env', content: '被改掉了' } }],
        },
        { content: '寫不進去。' },
      ],
    });

    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      plugins: [guard],
    });

    try {
      const result = await agent.invoke(toAgentInvocation('把 .env 改掉。'));
      const denial = result.messages.find((message) => message.getType() === 'tool');
      expect(denial?.text).toContain('permission denied');
    } finally {
      await dispose();
    }

    expect(await readFile(join(root, '.env'), 'utf8')).toBe(SECRET);
  });

  // 沒有這一條的話，一個「什麼都寫不進去」的組裝也會讓上面那條通過。
  it('沒被 deny 的路徑照樣寫得進磁碟', async () => {
    const root = await workspace();
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '',
          toolCalls: [
            { name: 'write_file', args: { file_path: '/notes.md', content: '一般的檔案' } },
          ],
        },
        { content: '寫好了。' },
      ],
    });

    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      plugins: [guard],
    });

    try {
      await agent.invoke(toAgentInvocation('寫個筆記。'));
    } finally {
      await dispose();
    }

    expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe('一般的檔案');
  });
});

describe('全域 deny 併進 subagent', () => {
  it('自帶 permissions 的 subagent 一樣擋得住 .env，而同一輪的另一個寫入成功', async () => {
    const root = await workspace();

    // 四輪：root 叫 subagent → subagent 同一輪兩個寫入（一擋一過）→ subagent 收尾 → root 收尾。
    // 兩個寫入放同一輪是刻意的：**成功的那個證明 subagent 的寫入路徑本來就是通的**，
    // 所以 `.env` 沒被改掉只可能是被擋，不可能是「那一輪根本沒跑到」。
    //
    // 這條是真的絆索：把 `fold.ts` 裡併入全域 deny 的那一行拿掉，`writer` 自帶的規則會把
    // root 那份整組蓋掉，`.env` 當場寫得進去（實測過）。
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '',
          toolCalls: [
            { name: 'task', args: { description: '去寫兩個檔', subagent_type: 'writer' } },
          ],
        },
        {
          content: '',
          toolCalls: [
            { name: 'write_file', args: { file_path: '/.env', content: 'subagent 改的' } },
            { name: 'write_file', args: { file_path: '/from-sub.md', content: 'subagent 寫的' } },
          ],
        },
        { content: 'subagent 做完了。' },
        { content: '都試過了。' },
      ],
    });

    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      plugins: [guard, crew],
    });

    try {
      await agent.invoke(toAgentInvocation('叫 writer 去寫檔。'));
    } finally {
      await dispose();
    }

    expect(await readFile(join(root, '.env'), 'utf8')).toBe(SECRET);
    expect(await readFile(join(root, 'from-sub.md'), 'utf8')).toBe('subagent 寫的');
  });
});
