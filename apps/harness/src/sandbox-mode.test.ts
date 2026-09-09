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

import { SessionLog } from '@nexus/core';
import type { SessionStore } from '@nexus/core';

import { createNexusAgent } from './agent-factory.js';
import { createCliAgent, DEFAULT_PLUGINS } from './cli.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import {
  executeSandboxCommand,
  SANDBOX_COMMAND_NAME,
  SandboxModeController,
} from './sandbox-mode.js';
import { createSandboxPolicyPlugin } from './sandbox-policy.js';
import { ScriptedChatModel } from './scripted-model.js';

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
      plugins: [createSandboxPolicyPlugin(controller, root)],
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

describe('`/sandbox` 這個命令本身', () => {
  it('沒有引數就報告現況與可切的那幾格，**不動任何東西**', () => {
    const controller = new SandboxModeController('workspace-write');

    const text = sandbox(controller, '/w', '');

    expect(text).toContain('目前的檔案政策：workspace-write');
    expect(text).toContain('"/w"');
    expect(text).toContain('read-only');
    expect(text).toContain('danger-full-access');
    expect(controller.current).toBe('workspace-write');
  });

  it('認不得的名字回 error，**而且模式沒有動**', () => {
    const controller = new SandboxModeController('workspace-write');

    const result = executeSandboxCommand(controller, '/w', ' readonly');

    expect(result.kind).toBe('error');
    expect(result.text).toContain('認不得 "readonly"');
    // 承重的是這一句：一個把打錯字靜靜吞掉的實作會讓人以為自己切過了。
    expect(controller.current).toBe('workspace-write');
  });

  it('切到已經生效的那一格什麼都不發生——照 dsh 的「淨變化為零不追加」', () => {
    const controller = new SandboxModeController('read-only');
    const log = new SessionLog('t');
    controller.attach(log);
    const afterAttach = log.events.length;

    expect(sandbox(controller, '/w', ' read-only')).toContain('本來就是 read-only');
    expect(log.events).toHaveLength(afterAttach);
  });

  it('沒有日誌接在上面時，切換要說「這次沒留痕跡」', () => {
    const controller = new SandboxModeController('workspace-write');

    expect(sandbox(controller, '/w', ' read-only')).toContain('沒有記進任何會話日誌');
  });
});

describe('切換寫進會話日誌', () => {
  it('接線當下就釘一顆起始值——一份沒人切過的日誌也答得出政策是哪一格', () => {
    const controller = new SandboxModeController('read-only');
    const log = new SessionLog('t');

    controller.attach(log);

    expect(log.events.map((event) => event.type)).toEqual(['sandbox/mode']);
    expect(log.events[0]?.data).toEqual({ mode: 'read-only' });
  });

  it('每一次真的變了都多一顆，帶的是整個值不是差異', () => {
    const controller = new SandboxModeController('workspace-write');
    const log = new SessionLog('t');
    controller.attach(log);

    controller.switchTo('read-only');
    controller.switchTo('danger-full-access');

    expect(log.events.map((event) => (event.data as { mode: string }).mode)).toEqual([
      'workspace-write',
      'read-only',
      'danger-full-access',
    ]);
  });

  it('收掉接線之後就不再往那份日誌寫', () => {
    const controller = new SandboxModeController('workspace-write');
    const log = new SessionLog('t');
    const detach = controller.attach(log);

    detach();
    controller.switchTo('read-only');

    expect(log.events).toHaveLength(1);
    // 值照樣換了——收掉的是記帳，不是政策。
    expect(controller.current).toBe('read-only');
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
      DEFAULT_PLUGINS,
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
      DEFAULT_PLUGINS,
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
    const first = await createCliAgent({ live: false, workspace: root }, DEFAULT_PLUGINS, root);
    const second = await createCliAgent({ live: false, workspace: root }, DEFAULT_PLUGINS, root);
    try {
      const command = first.commands.find(SANDBOX_COMMAND_NAME);
      await command?.handler({
        commandId: 'c1',
        rawInput: ' read-only',
        signal: AbortSignal.abort(),
      });

      const still = await second.commands
        .find(SANDBOX_COMMAND_NAME)
        ?.handler({ commandId: 'c2', rawInput: '', signal: AbortSignal.abort() });

      expect(still?.text).toContain('目前的檔案政策：workspace-write');
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });
});

describe('跨重啟讀不回來（絆索）', () => {
  it('`SessionStore` 只有 `create`——長出讀介面的那天，這裡就是該把模式接回去的地方', () => {
    // 這一條不是在驗我們的行為，是在**釘住一個結構性的缺席**：`sandbox/mode` 寫得進日誌，
    // 但沒有任何東西讀得回來（會話 resume 的兩扇門都關著，見 `session-resume-doors.test.ts`）。
    // 所以模式在重開一個 process 之後一律回到 `--sandbox` 那一格。
    //
    // **釘的是介面不是某個實作的鍵**：`createJsonlSessionStore` 回的物件上多一個
    // `directory` 這種與讀寫無關的欄位不該讓這裡響。`SessionStore` 多一個成員才該響——
    // 那就是門 A 開了，也正是該把這裡接回去的時候。
    const KNOWN = ['create'] as const;
    KNOWN satisfies readonly (keyof SessionStore)[];
    type Exhaustive = keyof SessionStore extends (typeof KNOWN)[number] ? true : never;
    const exhaustive: Exhaustive = true;

    expect(exhaustive).toBe(true);
  });
});
