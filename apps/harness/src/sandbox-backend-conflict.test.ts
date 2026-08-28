/**
 * 升版絆索：**基座不讓 `permissions` 與「會執行指令的 backend」共存**。
 *
 * 形狀照 `contained-backend.test.ts` 裡「基座的 virtualMode 是純字串比對」那一組——**刻意
 * 斷言一個基座現況**，而不是斷言我們自己的行為。它紅了不是壞消息，是該回頭看設計的時刻。
 *
 * 為什麼值得一條測試：`feat/sandbox-plugin` 本來的形狀是把 QuickJS 做成
 * `SandboxBackendProtocolV2` 的 backend。這條線走不通，而且不是「走得通但不好」——
 * `createFilesystemMiddleware` 在
 *
 *   `permissions` 非空 ＋ `execute` 工具開著 ＋ backend 通過 `isSandboxBackend()`
 *
 * 三件事同時成立時**直接拋錯**，除非所有規則路徑都收斂在 `CompositeBackend` 的 route
 * 前綴下。也就是說那個形狀會讓 `permissions.test.ts` 現有的驗收在**組裝期**就炸掉。
 * 所以 QuickJS 走的是 custom tool（`@nexus/plugin-quickjs` 的 `run_javascript`），基座
 * 明文「custom tools from the agent or other middleware are left untouched」，完全不經過
 * 這條路。
 *
 * **這修正了計劃第 7 節決策 3 的預測。** 原文寫「權限規則對 `execute` 不生效，原因是它的
 * 參數是命令字串、沒有路徑可比對」。「不生效」與「構造期硬失敗」是兩件事，而基座選的是
 * 後者。[#34](https://github.com/DemianLi/nexus-agent/issues/34) 把這條列為「待驗證，
 * 引進 sandbox 時當場驗一次」——這就是那一次。
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NexusPlugin } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { ScriptedChatModel } from './scripted-model.js';

/**
 * 一個會執行指令的 backend。
 *
 * `isSandboxBackend()` 是**純 duck-type**——`typeof backend.execute === 'function'` 加上
 * 一個非空的 `id` 字串就算數（`deepagents@1.13.1`，`dist/langsmith-zm0ILQsV.js:635` 實測）。
 * 所以這裡不必真的起一個 `LocalShellBackend` 去 spawn shell：那樣測到的是 spawn，不是
 * 這條規則。`execute` 永遠不會被呼叫到——衝突發生在組裝期，早於任何一次工具呼叫。
 */
class 會執行指令的 extends ContainedFilesystemBackend {
  readonly id = 'fake-sandbox';
  execute(command: string): never {
    throw new Error(`不該被呼叫到：${command}`);
  }
}

/** 擋掉 `.env` 類路徑的 plugin，跟 `permissions.test.ts` 用的是同一條規則。 */
const guard: NexusPlugin = {
  name: 'guard',
  apply: (registry) => void registry.permissions.deny(['/.env*']),
};

const model = new ScriptedChatModel({ turns: [{ content: '不會跑到這裡。' }] });

describe('permissions 與會執行指令的 backend 互斥（升版絆索）', () => {
  it('兩個一起給，agent 在組裝期就拋錯', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-sandbox-'));

    await expect(
      createNexusAgent({ model, backend: new 會執行指令的({ rootDir: root }), plugins: [guard] }),
    ).rejects.toThrow(/permissions cannot be used with a backend that supports command execution/);
  });

  // 沒有這一條的話，一個「什麼組裝都會失敗」的 harness 也會讓上面那條通過。要證明的是
  // **那個 backend** 讓它壞掉，不是那個 plugin、也不是那份設定。
  it('同一份 plugin 清單配不執行指令的 backend 組得起來', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-sandbox-'));

    const { dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      plugins: [guard],
    });
    await dispose();
  });

  // 另一半：deny 規則拿掉，同一個會執行指令的 backend 就沒問題了。兩條合起來釘住的是
  // 「衝突來自兩者相遇」，而不是其中任何一個自己有問題。
  it('沒有 deny 規則時，會執行指令的 backend 組得起來', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-sandbox-'));

    const { dispose } = await createNexusAgent({
      model,
      backend: new 會執行指令的({ rootDir: root }),
      plugins: [],
    });
    await dispose();
  });
});
