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

import { createCliAgent } from './assembly-root.js';
import { toAgentInvocation } from './messages.js';
import { PERMISSION_COMMAND_NAME } from '@nexus/plugin-permission-presets';
import type { ScriptedChatModel } from './scripted-model.js';
import { shippedPlugins, withScriptedModel } from './fixtures.js';

const shipped = await shippedPlugins();

/** 這條命令不 steer；直接呼叫 handler 的測試補上這一格。 */
const noSteer = (): void => undefined;

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

describe('一次切換搬得動兩個消費者', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nexus-sandbox-switch-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('`/permission read-only` 之後 `write_file` 被擋，而且下一輪的提示句也換成 read-only', async () => {
    // **產品組裝**（#670）：控制器、backend、沙箱 plugin 都是 `createCliAgent` 建的，切換走產品掛上去的 `/permission` 命令，
    // 不再自己握一顆控制器——「兩個消費者讀的是同一顆」要在產品組裝上成立才算數。
    const turns = [
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
    ];
    const built = await createCliAgent(
      { live: false, workspace: root },
      withScriptedModel(shipped, turns),
      root,
    );
    const model = built.model as ScriptedChatModel;
    const detach = built.attachSession(built.sessions);
    const config = { configurable: { thread_id: 'sandbox-switch' } };

    try {
      const before = await built.agent.invoke(toAgentInvocation('寫一個檔。'), config);
      const wrote = before.messages.find((message) => message.getType() === 'tool');
      // **反例先跑**：切之前這一模一樣的呼叫是過的。少了它，一個永遠擋的實作也全綠。
      expect(wrote?.text).not.toContain('唯讀');
      expect(systemPrompt(model)).toContain('目前的檔案政策：workspace-write');

      const switched = await built.commands.find(PERMISSION_COMMAND_NAME)?.handler({
        commandId: 'switch',
        rawInput: ' read-only',
        signal: new AbortController().signal,
        sessionLog: built.sessionLog,
        attachments: [],
        steer: noSteer,
      });
      expect(switched?.text).toContain('從 workspace-write 換成 read-only');

      const after = await built.agent.invoke(toAgentInvocation('再寫一個檔。'), config);
      const denied = after.messages.filter((message) => message.getType() === 'tool').at(-1);
      expect(denied?.text).toContain('這個 backend 是唯讀的');
      // 同一次切換，另一個消費者。
      expect(systemPrompt(model)).toContain('目前的檔案政策：read-only');
      expect(systemPrompt(model)).not.toContain('目前的檔案政策：workspace-write');
    } finally {
      detach();
      await built.dispose();
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

  it('掛了 --workspace 的組裝有 `/permission`（沒有 `/sandbox`），日誌上也有那顆起始值與起始組合', async () => {
    const { commands, sessions, attachSession, sessionLog, dispose } = await createCliAgent(
      { live: false, workspace: root, sandbox: 'read-only' },
      shipped,
      root,
    );
    const detach = attachSession(sessions);
    try {
      expect(commands.find(PERMISSION_COMMAND_NAME)).toBeDefined();
      // `/sandbox` 在 #437 拿掉了：切換的唯一入口是 `/permission`。
      expect(commands.find('sandbox')).toBeUndefined();
      expect(
        sessionLog.events
          .filter((event) => event.type === 'sandbox/mode')
          .map((event) => event.data),
      ).toEqual([{ mode: 'read-only' }]);
      // 新會話把起始組合釘進日誌（dsh `pinInitialPermission`）：`--sandbox read-only` 配核准 `ask` 就是 `read-only` 那一組。
      expect(
        sessionLog.events
          .filter((event) => event.type === 'permission/preset')
          .map((event) => event.data),
      ).toEqual([{ preset: 'read-only' }]);
    } finally {
      detach();
      await dispose();
    }
  });

  it('**沒有 --workspace 就沒有 `/permission`，日誌上也一顆都沒有**', async () => {
    const { commands, sessions, attachSession, sessionLog, dispose } = await createCliAgent(
      { live: false },
      shipped,
      root,
    );
    const detach = attachSession(sessions);
    try {
      // 那種組裝一格圍堵都沒有。一個報告「目前是 workspace-write」的命令說的謊跟那句
      // 提示一模一樣，而且它還讓人以為自己切了什麼東西。
      expect(commands.find(PERMISSION_COMMAND_NAME)).toBeUndefined();
      expect(sessionLog.events.filter((event) => event.type === 'sandbox/mode')).toHaveLength(0);
      expect(sessionLog.events.filter((event) => event.type === 'permission/preset')).toHaveLength(
        0,
      );
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
      const command = first.commands.find(PERMISSION_COMMAND_NAME);
      await command?.handler({
        commandId: 'c1',
        rawInput: ' read-only',
        signal,
        sessionLog: first.sessionLog,
        attachments: [],
        steer: noSteer,
      });

      const still = await second.commands.find(PERMISSION_COMMAND_NAME)?.handler({
        commandId: 'c2',
        rawInput: '',
        signal,
        sessionLog: second.sessionLog,
        attachments: [],
        steer: noSteer,
      });

      expect(still?.text).toContain('目前的權限組合：workspace-write');
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });
});
