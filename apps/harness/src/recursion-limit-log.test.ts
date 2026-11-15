/**
 * 預設遞迴上限 100 在**歷史從日誌推（`log`，產品預設）**下的輪數：補懸空呼叫那顆不掛 `beforeAgent`，圖上少一個節點（#2362）。
 *
 * - 出貨清單（`createNexusAgent`，不經樹）：32 輪。`state` 下是 31（`agent-instructions-on-tree.test.ts` 的 D 組，那份測試把組裝留在 `state`），差的正是那一格。
 * - CLI 的樹：31 輪不變。三位 pre-step listener 加切換核准政策的通知共四顆 `beforeAgent`，少一顆是 `floor((100 - 2 - 3) / 3)`，與 `floor((100 - 2 - 4) / 3)` 同為 31。
 * - serve 的樹：23 輪不變。每輪四格，`floor((100 - 2 - 3) / 4)` 與 `floor((100 - 2 - 4) / 4)` 同為 23。
 *
 * 這一份量**產品預設**，所以 `vi.unmock('./assembly-root.js')`（見 `history-source-state.setup.ts`）。
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionRegistry } from '@nexus/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('./assembly-root.js');

import { createNexusAgent, HEADLESS_APPROVALS } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { createCordisRoot, entryApprovalChannel } from './cordis-root.js';
import type { CordisRoot } from './cordis-root.js';
import { shippedPlugins, withScriptedModel } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { LoopingChatModel } from './looping-model.js';
import { toAgentInvocation } from './messages.js';
import { loadDefaultPlugins } from './plugin-config.js';
import { ScriptedChatModel } from './scripted-model.js';

const temporary: string[] = [];
const roots: CordisRoot[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await root.dispose().catch(() => {});
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-rounds-log-'));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return dir;
}

describe('log 下預設上限的輪數', () => {
  it('出貨清單（不經樹）：32 輪', async () => {
    const workspace = scratch();
    writeFileSync(join(workspace, 'AGENTS.md'), '規矩。', 'utf8');
    const model = new LoopingChatModel();
    const { agent, attachSession, dispose } = await createNexusAgent({
      model,
      plugins: await shippedPlugins(),
      summarization: false,
      historySource: 'log',
      backend: new ContainedFilesystemBackend({ rootDir: workspace, mode: 'workspace-write' }),
    });
    const detach = attachSession(new SessionRegistry('rounds-log'));
    try {
      await expect(
        agent.invoke(toAgentInvocation('一直跑'), { configurable: { thread_id: 'rounds-log' } }),
      ).rejects.toThrow(/Recursion limit/);
    } finally {
      detach();
      await dispose();
    }
    expect(model.calls).toBe(32);
  }, 60000);

  it.each([
    ['CLI', 'cli', {}, 31],
    ['serve', 'serve', { stepInbox: true }, 23],
  ] as const)(
    '%s 的樹：%i 輪不變',
    async (_label, entry, invocation, rounds) => {
      const looping = new LoopingChatModel();
      vi.spyOn(ScriptedChatModel.prototype, '_generate').mockImplementation((messages) =>
        looping._generate(messages),
      );
      const root = createCordisRoot({
        channel: entryApprovalChannel(entry === 'cli' ? HEADLESS_APPROVALS : undefined),
        contained: true,
      });
      roots.push(root);
      const loaded = await loadDefaultPlugins(
        { env: { [HARNESS_HOME_ENV]: scratch() }, warn: () => {} },
        { tree: root.tree },
      );
      const assembly = await root.boot(entry, { plugins: loaded.plugins });
      const built = await assembly.create(
        {
          live: false,
          historySource: 'log',
          workspace: scratch(),
          sandbox: 'workspace-write',
          ...invocation,
        },
        { plugins: withScriptedModel(loaded.plugins, [{ content: '好。' }]) },
      );
      const sessions = new SessionRegistry(`rounds-${entry}`);
      const attachment = built.attachSessions(sessions);
      try {
        await expect(
          built.agent.invoke(toAgentInvocation('開工'), {
            configurable: { thread_id: `rounds-${entry}` },
          }),
        ).rejects.toThrow(/Recursion limit/);
      } finally {
        await attachment.detach();
        await built.dispose();
      }
      expect(looping.calls).toBe(rounds);
    },
    60000,
  );
});
