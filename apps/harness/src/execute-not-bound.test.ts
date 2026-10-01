/**
 * 模型實際綁到的工具清單裡沒有 `execute`，走**產品組裝**（[#666](https://github.com/DemianLi/nexus-agent/issues/666)）。
 *
 * 產品組裝是 `createCliAgent`（serve 每條 thread 也走它）。backend 在那裡選：有 `--workspace` 是
 * `ContainedFilesystemBackend`，沒有就交給 `agent-factory` 墊 `TextOnlyStateBackend`。`execute` 只有在 backend
 * 實作了 `SandboxBackendProtocol` 時才會被基座綁上，所以這兩條組裝裡它都不該出現。
 *
 * 原本唯一的斷言在 `workspace-changes.test.ts`，backend 是測試自己手建的——`cli.ts` 改建別的 backend，
 * 它照樣綠。web 的 `tool-view.test.ts` 也曾為此掃整個 harness 原始碼，那是把 harness 的組裝事實放在別人家。
 * 樣板同 `sandbox-escalation.test.ts` 的「產品路徑」那條。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { shippedPlugins } from './fixtures.js';
import { toAgentInvocation } from './messages.js';
import type { ScriptedChatModel } from './scripted-model.js';

const shipped = await shippedPlugins();

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexus-execute-root-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('產品組裝不綁 execute', () => {
  it.each([
    ['沒給 --workspace（墊 TextOnlyStateBackend）', undefined],
    ['給了 --workspace（ContainedFilesystemBackend）', true],
  ])('%s', async (_label, fenced) => {
    const assembled = await createCliAgent(
      { live: false, ...(fenced === true && { workspace: root }) },
      shipped,
      root,
    );
    try {
      await assembled.agent.invoke(toAgentInvocation('看一下。'), {
        configurable: { thread_id: 'execute-check' },
      });
      const names = (assembled.model as ScriptedChatModel).boundToolNames;
      // 前提：真的綁過工具。空清單也「不含」execute，那樣的綠什麼都不代表。
      expect(names).toContain('write_file');
      expect(names).not.toContain('execute');
    } finally {
      await assembled.dispose();
    }
  });
});
