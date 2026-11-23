/**
 * **插件用 `backend.mount()` 掛 `/shared/`（唯讀共用區的前綴）不能遮住唯讀路由**（#1775 第 3 項：前綴不能撞到插件掛的前綴）。
 *
 * `fold.ts` 的 `foldBackend` 把插件的路由包在組裝點那層 composite 的**外面**，而 `backends.insert` 的撞名檢查只比插件之間；
 * 所以不擋的話，插件掛 `/shared/` 會先被外層路由接住，模型寫 `/shared/x` 落在插件的 backend 裡，唯讀那條形同虛設。
 *
 * 走產品組裝（`createCliAgent`，帶 `sharedWorkspaceRoot`），模型換成清單上的腳本提供者。
 */

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { createMountPlugin, shippedPlugins, withScriptedModel } from './fixtures.js';
import { toAgentInvocation } from './messages.js';

const shipped = await shippedPlugins();

let shared: string;
let priv: string;
beforeEach(async () => {
  shared = await mkdtemp(join(tmpdir(), 'nexus-shared-collision-ws-'));
  priv = await mkdtemp(join(tmpdir(), 'nexus-shared-collision-priv-'));
  await writeFile(join(shared, 'ref.md'), '參考資料', 'utf8');
});
afterEach(async () => {
  await Promise.all([shared, priv].map((dir) => rm(dir, { recursive: true, force: true })));
});

function toolMessagesOf(messages: readonly BaseMessage[]): Map<string, ToolMessage> {
  const found = new Map<string, ToolMessage>();
  for (const message of messages) {
    if (ToolMessage.isInstance(message) && message.name !== undefined)
      found.set(message.name, message);
  }
  return found;
}

async function writeToShared(
  extra: typeof shipped,
): Promise<{ result: ToolMessage | undefined; error?: unknown }> {
  const turns = [
    {
      content: '',
      toolCalls: [{ name: 'write_file', args: { file_path: '/shared/probe.md', content: '寫了' } }],
    },
    { content: '收工。' },
  ];
  try {
    const built = await createCliAgent(
      { live: false, workspace: shared, workspaceRoot: priv, sharedWorkspaceRoot: shared },
      withScriptedModel([...shipped, ...extra], turns),
      priv,
    );
    const detach = built.attachSession(built.sessions);
    try {
      const state = (await built.agent.invoke(toAgentInvocation('寫。'), {
        configurable: { thread_id: 'shared-collision' },
      })) as { messages: BaseMessage[] };
      return { result: toolMessagesOf(state.messages).get('write_file') };
    } finally {
      detach();
      await built.dispose();
    }
  } catch (error) {
    return { result: undefined, error };
  }
}

describe('插件掛的路由跟唯讀共用區重疊', () => {
  it('對照：沒有插件掛它，寫 /shared/probe.md 被拒、兩邊磁碟都沒有新檔', async () => {
    const { result, error } = await writeToShared([]);
    expect(error).toBeUndefined();
    expect(result?.status).toBe('error');
    expect(await readdir(shared)).toEqual(['ref.md']);
    expect(await readdir(priv)).toEqual([]);
  }, 30000);

  // 以前的行為（實測，2026-10-21）：插件的路由包在組裝點那層 composite 外面，掛 `/shared/` 的插件先接住請求，
  // `write_file /shared/probe.md` 回「Successfully wrote」、寫進插件自己的 backend——唯讀路由形同虛設。現在 fold 當場拋。
  it.each([
    ['相同', '/shared/'],
    ['更深一層', '/shared/sub/'],
    ['更上一層（根）', '/'],
  ])(
    '插件掛 %s（%s）：組裝當場拋，訊息點名插件與重疊的前綴',
    async (_label, prefix) => {
      const { error } = await writeToShared([createMountPlugin(prefix)]);
      expect(String(error)).toContain(`"${prefix}"`);
      // 根（`/`）跟組裝點每一條都重疊，訊息點名的是最先比到的那一條；其餘兩個點名 `/shared/`。
      if (prefix !== '/') expect(String(error)).toContain('"/shared/"');
      expect(String(error)).toContain('mount');
    },
    30000,
  );

  it('不重疊的前綴照常掛（拿掉檢查整個擋掉也會紅的反例）', async () => {
    const { error, result } = await writeToShared([createMountPlugin('/mounted/')]);
    expect(error).toBeUndefined();
    expect(result?.status).toBe('error');
  }, 30000);
});
