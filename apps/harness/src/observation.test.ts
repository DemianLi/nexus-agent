/**
 * 「先讀後改」策略的**行為**驗收——掛進真的 agent、跑在真的磁碟上
 * （[#154](https://github.com/DemianLi/nexus-agent/issues/154)）。
 *
 * **每一條都看磁碟**：擋沒擋住的答案在檔案內容上，不在回傳值的措辭上——`StateBackend`
 * 的「檔案」只是 state 裡的一個 map，而策略是靠後端取版本 token 的，用假的後端等於
 * 沒驗到那條路。
 *
 * **每一條「擋住了」都配一條「本來會過」的對照組。** `ran === 沒動` 同樣被「模型根本沒
 * 呼叫那個工具」滿足，而且這一組還多一種假綠：明著 `observationPolicy: false` 那條就是
 * 用來證明擋住它的真的是策略、不是別的東西。
 *
 * core 那側的規則測試在
 * [`observation.test.ts`](../../../packages/nexus-core/src/observation.test.ts)；掛在哪、
 * 排第幾在 [`fold.test.ts`](../../../packages/nexus-core/src/fold.test.ts)。
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { OBSERVATION_POLICY_NOTICE } from '@nexus/core';
import type { NexusPlugin } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';

const ORIGINAL = '原本的內容\n第二行\n第三行';

/** 一個有 `notes.md` 的可寫根。 */
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-observe-'));
  await writeFile(join(root, 'notes.md'), ORIGINAL);
  return root;
}

/** 註冊一個 subagent，其餘什麼都不做。 */
const crew: NexusPlugin = {
  name: 'crew',
  apply: (registry) =>
    void registry.subagents.register({ name: 'writer', description: '寫檔的。' }),
};

/**
 * 跑一串腳本，回磁碟上的內容與這一輪的 ToolMessage。
 *
 * @param root - 可寫根。
 * @param turns - 模型腳本。
 * @param options - `policy: false` 明著關掉策略；`plugins` 額外的清單。
 * @returns 每一則 ToolMessage 的文字與 status。
 */
async function run(
  root: string,
  turns: ScriptedTurn[],
  options: { policy?: boolean; plugins?: NexusPlugin[] } = {},
): Promise<{ text: string; status?: string }[]> {
  const { agent, dispose } = await createNexusAgent({
    model: new ScriptedChatModel({ turns }),
    backend: new ContainedFilesystemBackend({ rootDir: root }),
    checkpointer: new MemorySaver(),
    plugins: options.plugins ?? [],
    ...(options.policy !== undefined && { observationPolicy: options.policy }),
  });
  try {
    const result = await agent.invoke(toAgentInvocation('動手。'), {
      configurable: { thread_id: 'observe' },
    });
    return (result.messages as (BaseMessage & { status?: string })[])
      .filter((message) => message.getType() === 'tool')
      .map((message) => ({ text: message.text, status: message.status }));
  } finally {
    await dispose();
  }
}

/** 一輪：叫一次 `edit_file`。 */
function edit(from: string, to: string): ScriptedTurn {
  return {
    content: '',
    toolCalls: [
      { name: 'edit_file', args: { file_path: '/notes.md', old_string: from, new_string: to } },
    ],
  };
}

/** 一輪：叫一次 `read_file`。 */
function read(path = '/notes.md', args: Record<string, unknown> = {}): ScriptedTurn {
  return { content: '', toolCalls: [{ name: 'read_file', args: { file_path: path, ...args } }] };
}

/** 一輪：叫一次 `write_file`。 */
function write(path: string, content: string): ScriptedTurn {
  return { content: '', toolCalls: [{ name: 'write_file', args: { file_path: path, content } }] };
}

const DONE: ScriptedTurn[] = [{ content: '好了。' }, { content: '再好一次。' }];

describe('沒讀過的檔不准改', () => {
  /** **這一條是整張卡的驗收句。** */
  it('沒讀就 edit → 拒絕，磁碟上一個字都沒動', async () => {
    const root = await workspace();
    const messages = await run(root, [edit('原本的內容', '被改掉了'), ...DONE]);

    expect(messages[0]?.status).toBe('error');
    expect(messages[0]?.text).toContain('FS_NOT_OBSERVED');
    expect(messages[0]?.text).toContain('read_file');
    expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe(ORIGINAL);
  });

  /**
   * **對照組，而且它是承重的。**
   *
   * 沒有這一條，一個「什麼都改不動」的組裝也會讓上面那條通過。
   */
  it('讀了再 edit → 照常改得動', async () => {
    const root = await workspace();
    const messages = await run(root, [read(), edit('原本的內容', '被改掉了'), ...DONE]);

    expect(messages[1]?.status).not.toBe('error');
    expect(await readFile(join(root, 'notes.md'), 'utf8')).toContain('被改掉了');
  });

  /**
   * **第二個對照組：明著關掉策略，同一串腳本就過。**
   *
   * 沒有這一條，「是策略擋住的」與「這一串腳本本來就改不動」分不出來。
   */
  it('`observationPolicy: false` → 同一串盲改照樣寫得進去', async () => {
    const root = await workspace();
    const messages = await run(root, [edit('原本的內容', '被改掉了'), ...DONE], { policy: false });

    expect(messages[0]?.status).not.toBe('error');
    expect(await readFile(join(root, 'notes.md'), 'utf8')).toContain('被改掉了');
  });

  it('**帶 offset / limit 的部分讀也算讀過**——照 dsh，這是刻意的弱化', async () => {
    const root = await workspace();
    // dsh：「任何窗口读取都会授权对未变文件执行全文件覆盖，这有意弱于完整视图规则」。
    const messages = await run(root, [
      read('/notes.md', { offset: 1, limit: 1 }),
      edit('原本的內容', '被改掉了'),
      ...DONE,
    ]);

    expect(messages[1]?.status).not.toBe('error');
    expect(await readFile(join(root, 'notes.md'), 'utf8')).toContain('被改掉了');
  });
});

describe('write_file 那一半', () => {
  it('新建一個不存在的檔不受影響', async () => {
    const root = await workspace();
    const messages = await run(root, [write('/fresh.md', '新的'), ...DONE]);

    expect(messages[0]?.status).not.toBe('error');
    expect(await readFile(join(root, 'fresh.md'), 'utf8')).toBe('新的');
  });

  it('覆蓋一個沒讀過的既有檔 → 拒絕，內容沒動', async () => {
    const root = await workspace();
    const messages = await run(root, [write('/notes.md', '整個蓋掉'), ...DONE]);

    expect(messages[0]?.status).toBe('error');
    expect(messages[0]?.text).toContain('FS_NOT_OBSERVED');
    expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe(ORIGINAL);
  });

  it('讀過之後覆蓋得動（上一條的對照組）', async () => {
    const root = await workspace();
    const messages = await run(root, [read(), write('/notes.md', '整個蓋掉'), ...DONE]);

    expect(messages[1]?.status).not.toBe('error');
    expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe('整個蓋掉');
  });

  /**
   * **「確認缺席」是第三個狀態，不是「沒觀測過」。**
   *
   * 讀一個不存在的檔會把它記成確認缺席，而那**授權受防護的新建**。少了這一格，模型讀了
   * 一個不存在的檔之後反而更不能建它，那說不通。
   */
  it('讀到不存在 → 記成確認缺席，之後的新建照樣放行', async () => {
    const root = await workspace();
    const messages = await run(root, [read('/nope.md'), write('/nope.md', '建出來'), ...DONE]);

    expect(messages[1]?.status).not.toBe('error');
    expect(await readFile(join(root, 'nope.md'), 'utf8')).toBe('建出來');
  });
});

describe('讀過之後又變了', () => {
  /**
   * 版本 token 真的在比。**這條紅了最可能的原因是 token 沒有跟著內容變**——那種壞法
   * 長得跟「一切正常」一模一樣：策略照掛、照過、只是永遠不擋。
   */
  it('讀過之後檔案被外部改掉 → FS_STALE_VERSION，改不進去', async () => {
    const root = await workspace();
    const touch: NexusPlugin = {
      name: 'touch',
      apply(registry) {
        // 在模型讀完、還沒改之前把檔案換掉——這正是策略要抓的那個縫。
        registry.approvals.gate(async (exec, next) => {
          if (exec.name === 'edit_file') await writeFile(join(root, 'notes.md'), '別人改過了');
          return next();
        });
      },
    };
    const messages = await run(root, [read(), edit('原本的內容', '被改掉了'), ...DONE], {
      plugins: [touch],
    });

    expect(messages[1]?.status).toBe('error');
    expect(messages[1]?.text).toContain('FS_STALE_VERSION');
    expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe('別人改過了');
  });
});

describe('射程', () => {
  /**
   * **紀錄逐 agent 一份，不是逐 session 一份。**
   *
   * dsh 的 owner 是 `agent.session`，而那邊 agent id ≡ session id、child agent 各自一份。
   * 共用一份的下場是 root 讀過的檔變成每個 subagent 都可以直接改——那正好把這件事要擋的
   * 東西放掉。這條紅了就是 `foldObservationPolicy` 被改成回一份共用實例了。
   */
  it('root 讀過的檔，subagent 還是不准改', async () => {
    const root = await workspace();
    const messages = await run(
      root,
      [
        read(),
        {
          content: '',
          toolCalls: [{ name: 'task', args: { description: '去改', subagent_type: 'writer' } }],
        },
        edit('原本的內容', 'subagent 改的'),
        { content: 'subagent 收工。' },
        ...DONE,
      ],
      { plugins: [crew] },
    );

    // **判準是磁碟。** subagent 自己那幾則 ToolMessage 不會冒到 root 的 `messages` 上
    // ——`task` 交回來的只有它最後說的那句話，所以拒絕的措辭在這一層看不到。
    expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe(ORIGINAL);
    void messages;
  });

  it('**subagent 自己讀過就改得動**（上一條的對照組）', async () => {
    const root = await workspace();
    await run(
      root,
      [
        {
          content: '',
          toolCalls: [{ name: 'task', args: { description: '去改', subagent_type: 'writer' } }],
        },
        read(),
        edit('原本的內容', 'subagent 改的'),
        { content: 'subagent 收工。' },
        ...DONE,
      ],
      { plugins: [crew] },
    );

    expect(await readFile(join(root, 'notes.md'), 'utf8')).toContain('subagent 改的');
  });
});

describe('規則要在模型動手之前就講給它聽', () => {
  /**
   * **這一句是機制的一部分，不是文件。**
   *
   * 沒有它，模型每碰一個新檔都得先撞一次牆才學會——而省掉那一輪往返正是這件事的主要
   * 價值。dsh 把同一件事寫在**工具描述**裡（`snapshots/web` 底下每一份
   * `system-prompt.expected.md`：「read an existing file first (the **default**
   * fs-observation-policy requires it)」）。那個縫在我們這裡是關著的——
   * `customToolDescriptions` 只在 `FilesystemMiddlewareOptions` 上，而 `createDeepAgent`
   * 建 `createFilesystemMiddleware` 時只傳 `{ backend, permissions, tools }`。所以載體
   * 退到系統提示詞，紀律沒退。
   */
  it('root 那一輪的 system prompt 裡有那句話', async () => {
    const root = await workspace();
    const model = new ScriptedChatModel({ turns: DONE });
    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      plugins: [],
    });
    try {
      await agent.invoke(toAgentInvocation('嗨。'));
    } finally {
      await dispose();
    }

    const system = model.lastPrompt
      .filter((message) => message.getType() === 'system')
      .map((message) => message.text)
      .join('\n');
    expect(system).toContain(OBSERVATION_POLICY_NOTICE);
  });

  it('關掉策略就不該出現那句話（上一條的對照組）', async () => {
    const root = await workspace();
    const model = new ScriptedChatModel({ turns: DONE });
    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      observationPolicy: false,
      plugins: [],
    });
    try {
      await agent.invoke(toAgentInvocation('嗨。'));
    } finally {
      await dispose();
    }

    const system = model.lastPrompt
      .filter((message) => message.getType() === 'system')
      .map((message) => message.text)
      .join('\n');
    expect(system).not.toContain(OBSERVATION_POLICY_NOTICE);
  });
});
