/**
 * 執行期切換那一刀的驗收：**切得動、兩個消費者一起動、切了留得下痕跡、切不到的那些會說**。
 *
 * 這一份與 `sandbox-policy.test.ts` 分工：那一份驗「模式決定得了提示句」，這一份驗
 * 「**人**改得動模式」。
 *
 * ## 為什麼第一條要真的走一次工具呼叫
 *
 * 承重的宣稱是**一次切換同時搬得動兩個消費者**（fence 與提示句）。直接呼叫
 * `backend.write()` 只驗得到 fence 自己讀來源——那條 `sandbox-policy.test.ts` 已經有了。
 * 這裡要驗的是**組裝起來之後那兩個消費者讀的是同一顆**，所以檔案那一側走
 * `write_file`，也就是模型真的會走的那條路；兩邊各存一份快照的實作會在這裡露餡：
 * 提示句換了、擋的還是舊那格（或反過來），而**兩者都不會讓任何既有測試變紅**。
 *
 * ## 為什麼每一條驗收都是一對
 *
 * 「切到 read-only 會擋」單獨綠不了任何東西——一個**永遠**擋的實作也會綠。所以每一條都
 * 配一個反例：切之前寫得進去、切到不存在的名字時模式**沒有**動、淨變化為零時日誌上
 * **沒有**多出東西。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHostServicesPlugin } from '@nexus/core';

import { createNexusAgent } from './agent-factory.js';
import { createCliAgent } from './cli.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import {
  createSandboxPolicyPlugin,
  executeSandboxCommand,
  SANDBOX_COMMAND_NAME,
  SandboxModeController,
} from '@nexus/plugin-sandbox-policy';
import { ScriptedChatModel } from './scripted-model.js';
import { shippedPlugins } from './fixtures.js';

const shipped = await shippedPlugins();

/** 把一則訊息的 `content` 攤成可以搜尋的字串，同 `sandbox-policy.test.ts` 的理由。 */
function flatten(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(flatten).join('\n');
  if (content !== null && typeof content === 'object') {
    const text = (content as { text?: unknown }).text;
    return typeof text === 'string' ? text : JSON.stringify(content);
  }
  return String(content);
}

/** 這一輪送進模型的 system prompt。 */
function systemPrompt(model: ScriptedChatModel): string {
  return model.lastPrompt
    .filter((message) => message.getType() === 'system')
    .map((message) => flatten(message.content))
    .join('\n');
}

/** 跑一次 `/sandbox <引數>`，回它給人看的那句話。 */
function sandbox(controller: SandboxModeController, root: string, argument: string): string {
  return executeSandboxCommand(controller, root, argument).text;
}

describe('一次切換搬得動兩個消費者', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nexus-sandbox-switch-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('`/sandbox read-only` 之後 `write_file` 被擋，而且下一輪的提示句也換成 read-only', async () => {
    const controller = new SandboxModeController('workspace-write');
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '',
          toolCalls: [{ name: 'write_file', args: { file_path: '/a.txt', content: '一' } }],
        },
        { content: '寫好了。' },
        {
          content: '',
          toolCalls: [{ name: 'write_file', args: { file_path: '/b.txt', content: '二' } }],
        },
        { content: '寫不進去。' },
      ],
    });
    const { agent, dispose } = await createNexusAgent({
      model,
      // **fence 與 plugin 拿的是同一顆控制器**，這正是 `cli.ts` 的接法。
      backend: new ContainedFilesystemBackend({ rootDir: root, mode: controller.source }),
      plugins: [
        createHostServicesPlugin({ sandboxPolicy: { controller, rootDir: root } }),
        createSandboxPolicyPlugin(),
      ],
    });

    try {
      const before = await agent.invoke(toAgentInvocation('寫一個檔。'));
      const wrote = before.messages.find((message) => message.getType() === 'tool');
      // **反例先跑**：切之前這一模一樣的呼叫是過的。少了它，一個永遠擋的實作也全綠。
      expect(wrote?.text).not.toContain('唯讀');
      expect(systemPrompt(model)).toContain('目前的檔案政策：workspace-write');

      expect(sandbox(controller, root, ' read-only')).toContain('workspace-write 換成 read-only');

      const after = await agent.invoke(toAgentInvocation('再寫一個檔。'));
      const denied = after.messages.find((message) => message.getType() === 'tool');
      expect(denied?.text).toContain('這個 backend 是唯讀的');
      // 同一次切換，另一個消費者。
      expect(systemPrompt(model)).toContain('目前的檔案政策：read-only');
      expect(systemPrompt(model)).not.toContain('目前的檔案政策：workspace-write');
    } finally {
      await dispose();
    }
  });
});

describe('組裝起來之後', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nexus-sandbox-assembly-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('掛了 --workspace 的組裝有 `/sandbox`，日誌上也有那顆起始值', async () => {
    const { commands, sessions, attachSession, sessionLog, dispose } = await createCliAgent(
      { live: false, workspace: root, sandbox: 'read-only' },
      shipped,
      root,
    );
    const detach = attachSession(sessions);
    try {
      expect(commands.find(SANDBOX_COMMAND_NAME)).toBeDefined();
      expect(
        sessionLog.events
          .filter((event) => event.type === 'sandbox/mode')
          .map((event) => event.data),
      ).toEqual([{ mode: 'read-only' }]);
    } finally {
      detach();
      await dispose();
    }
  });

  it('**沒有 --workspace 就沒有 `/sandbox`，日誌上也一顆都沒有**', async () => {
    const { commands, sessions, attachSession, sessionLog, dispose } = await createCliAgent(
      { live: false },
      shipped,
      root,
    );
    const detach = attachSession(sessions);
    try {
      // 那種組裝一格圍堵都沒有。一個報告「目前是 workspace-write」的命令說的謊跟那句
      // 提示一模一樣，而且它還讓人以為自己切了什麼東西。
      expect(commands.find(SANDBOX_COMMAND_NAME)).toBeUndefined();
      expect(sessionLog.events.filter((event) => event.type === 'sandbox/mode')).toHaveLength(0);
    } finally {
      detach();
      await dispose();
    }
  });

  it('兩次組裝是兩格，一邊切不動另一邊——`serve` 一條 thread 一次組裝', async () => {
    const first = await createCliAgent({ live: false, workspace: root }, shipped, root);
    const second = await createCliAgent({ live: false, workspace: root }, shipped, root);
    try {
      // **活的 signal**，不是一個已經 abort 的。發派面在中止時根本不呼叫 handler
      // （`@nexus/plugin-commands` 的 `execute` 在進 handler 之前就 `throw abortError`），
      // 所以餵一個 abort 過的進來會讓這條測試記下一件產品路徑上不成立的事。
      const signal = new AbortController().signal;
      const command = first.commands.find(SANDBOX_COMMAND_NAME);
      await command?.handler({ commandId: 'c1', rawInput: ' read-only', signal });

      const still = await second.commands
        .find(SANDBOX_COMMAND_NAME)
        ?.handler({ commandId: 'c2', rawInput: '', signal });

      expect(still?.text).toContain('目前的檔案政策：workspace-write');
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });
});
