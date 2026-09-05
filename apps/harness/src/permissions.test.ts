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
 *
 * ## 比「無規則命中即 allow」更大的那個洞：規則只蓋到工具
 *
 * `checkPermission` **只在七個工具工廠裡被呼叫**（`createLsTool` / `createReadFileTool` /
 * `createWriteFileTool` / `createEditFileTool` / `createGlobTool` / `createGrepTool`，加上
 * delete 那條走 `findDeleteDenyPatterns` 的分支）。它**不在 backend 方法上**。
 *
 * 所以任何不經過工具的寫入都不經過規則表 —— summarization 的歷史 offload 就是一個，它走
 * backend 方法。實測的四格對照在 [`summarization.test.ts`](./summarization.test.ts)：同一條
 * `deny(['/conversation_history*', ...])`，經 `write_file` 換來 `permission denied`、磁碟零檔案；
 * 經 offload 則照樣落檔。
 *
 * 這是 [`contained-backend.test.ts`](./contained-backend.test.ts) 那句「讀不經過 fence——讀的
 * 策略歸 permissions，兩層正交」的另一面：**寫不經過 permissions，寫的圍堵歸 fence**。兩層
 * 各守一半，而 offload 落在 permissions 守不到的那半。
 *
 * 對使用者的意思很直接：**想把某個路徑擋在寫入之外，deny 規則只擋得住模型主動去寫的那條路**。
 * 基座自己在背景寫的東西要用 fence（`ContainedFilesystemBackend` 的 mode），或把那個寫入者的
 * backend 指到別處。
 *
 * ## 「先讀後改」策略排在 permissions 前面，而那有代價
 *
 * [#154](https://github.com/DemianLi/nexus-agent/issues/154) 之後，覆蓋一個既有檔要先讀過它。
 * `checkPermission` 住在**工具本體裡**，而策略是 `wrapToolCall`——所以**策略先講話**。
 * 對一條 deny 掉的路徑，模型第一次拿到的是「先讀一次再重試」，而 `registry.permissions.deny`
 * 產生的規則同時擋讀與寫（`fold.ts` 的 `foldPermissions`），所以那句話它**做不到**。
 *
 * **安全結果沒有變**：兩層都不放行，磁碟一個字都沒動。變的是第一則訊息的措辭，代價是
 * 一輪往返加一句幫不上忙的話。dsh 那側是同一個分層（策略在 fs seam，「分层权限、审计或
 * 沙箱拦截属于 `tools/execute` waterfall」），它也不讓策略去認得權限。
 *
 * **還有一件要說出來的**：策略取版本 token 是**直接叫 backend 的 `readRaw`**，所以它讀
 * 得到 deny 規則不讓模型讀的路徑。那是上一節「規則只蓋到工具」的同一件事換一面——
 * summarization 的 offload 是**寫**不經過規則表，這是**讀**。內容不會到模型手上（token
 * 是雜湊出來的，從不渲染），但拒絕那句話會透露那個檔存在。要把一個路徑徹底藏起來，
 * 一樣只有 fence 那條路。
 *
 * **所以下面刻意有兩條**：一條釘住「策略先講話、檔案照樣沒動」，一條釘住**permissions
 * 這一層還講得出話**——走一個不存在的路徑，策略放行新建，deny 接手。少了後面那條，
 * 「permissions 還在不在」就沒有人在看了。
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
      // **第一則是策略的，不是 permissions 的**——理由與代價見檔頭最後一節。
      // 承重的是下面那句：**磁碟上一個字都沒動**。
      expect(denial?.text).toContain('FS_NOT_OBSERVED');
    } finally {
      await dispose();
    }

    expect(await readFile(join(root, '.env'), 'utf8')).toBe(SECRET);
  });

  /**
   * **permissions 這一層還講得出話。**
   *
   * 上面那條之後，「deny 有沒有效」就沒有任何一條測試在直接看它的措辭了——策略永遠先
   * 講話。這一條把它接回來：`.env.new` **不存在**，所以策略照 `createIfAbsent` 放行，
   * deny 接手並自己回話。它紅了代表 permissions 真的不見了，而不是被策略遮住。
   */
  it('**deny 對不存在的路徑照樣自己回話**——策略放行新建，permissions 接手', async () => {
    const root = await workspace();
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '',
          toolCalls: [
            { name: 'write_file', args: { file_path: '/.env.new', content: '新建也不行' } },
          ],
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
      const result = await agent.invoke(toAgentInvocation('新建一個 .env.new。'));
      const denial = result.messages.find((message) => message.getType() === 'tool');
      expect(denial?.text).toContain('permission denied');
    } finally {
      await dispose();
    }

    await expect(readFile(join(root, '.env.new'), 'utf8')).rejects.toThrow();
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
