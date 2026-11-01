/**
 * **舊 thread 對守衛擋的目標升級：不掛核准卡，直接說明不能升級**（[#2078](https://github.com/DemianLi/nexus-agent/issues/2078)）。
 *
 * 舊 thread 的可寫根就是 `--workspace`，根目錄的指示檔與技能來源不論模式、不認領 grant 都寫不進去（#1960，`shared-reserved-writes.ts`）。
 * 對這些目標掛核准卡，問的是一個核准了也不會成功的問題，比照唯讀共用區（#1800，`shared-workspace-grants.test.ts`）在升級工具就拒。
 *
 * 舊 thread 照組裝點的旗標造：可寫根是 `--workspace`、`rootIsShared`、沒有共用區前綴。案例都在 `read-only` 下跑，升到 `workspace-write`
 * 是加寬，沒有這道判斷的話會掛卡。
 */

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import type { FsService, PluginEntry } from '@nexus/core';
import { createMemoryPlugin } from '@nexus/plugin-memory';
import { reservedTargetRefusal, SANDBOX_ESCALATION_TOOL_NAME } from '@nexus/plugin-sandbox-policy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { shippedPlugins, withScriptedModel } from './fixtures.js';
import { toAgentInvocation } from './messages.js';
import type { ScriptedTurn } from './scripted-model.js';
import { sharedReservedWrites } from './shared-reserved-writes.js';

const shipped = await shippedPlugins();

/** 守衛的兩種理由：指示檔一格、技能來源一格。 */
const [instructionReason, skillReason] = (() => {
  const reserved = sharedReservedWrites({
    skillSources: () => ['/skills/'],
    offWorkspacePrefixes: () => [],
  } as unknown as FsService);
  return [reserved[0]?.reason ?? '', reserved.at(-1)?.reason ?? ''];
})();

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(join('/var/tmp', 'nexus-legacy-escalation-'));
  await writeFile(join(workspace, 'AGENTS.md'), 'DEPLOY-RULE', 'utf8');
  await mkdir(join(workspace, 'skills', 'normal'), { recursive: true });
  await writeFile(join(workspace, 'skills', 'normal', 'SKILL.md'), 'NORMAL', 'utf8');
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

const escalate = (file_path: string): ScriptedTurn => ({
  content: '',
  toolCalls: [
    {
      name: SANDBOX_ESCALATION_TOOL_NAME,
      args: { file_path, sandbox_permissions: 'workspace-write', justification: '使用者要這個檔' },
    },
  ],
});

/** 舊 thread 對 `target` 升級一次：回有沒有掛核准卡、工具回了什麼。 */
async function escalateOnLegacyThread(
  target: string,
  plugins: readonly PluginEntry[] = shipped,
): Promise<{ card: boolean; reply: string }> {
  const built = await createCliAgent(
    { live: false, workspace, workspaceRoot: workspace, rootIsShared: true, sandbox: 'read-only' },
    withScriptedModel(plugins, [escalate(target), { content: '停。' }]),
    workspace,
  );
  const detach = built.attachSession(built.sessions);
  try {
    const result = await built.agent.invoke(toAgentInvocation('升級。'), {
      configurable: { thread_id: `legacy-escalation-${target}` },
    });
    const card = ((result as { __interrupt__?: unknown[] }).__interrupt__?.length ?? 0) > 0;
    const reply = (result.messages as BaseMessage[])
      .filter((message) => message.getType() === 'tool')
      .map((message) =>
        typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
      )
      .join('\n');
    return { card, reply };
  } finally {
    detach();
    await built.dispose();
  }
}

describe('舊 thread 對守衛擋的目標升級：不掛核准卡（#2078）', () => {
  it.each([
    ['/AGENTS.md', instructionReason],
    ['/CLAUDE.md', instructionReason],
    ['/./AGENTS.local.md', instructionReason],
    ['/claude.local.md', instructionReason],
    ['/skills/normal/SKILL.md', skillReason],
    ['/skills/rogue/SKILL.md', skillReason],
    ['/skills', skillReason],
  ])(
    '對 %s 升級：沒有核准卡，回不能升級與守衛的理由',
    async (target, reason) => {
      const { card, reply } = await escalateOnLegacyThread(target);
      expect(card).toBe(false);
      expect(reply).toContain(reservedTargetRefusal(reason));
      expect(await readFile(join(workspace, 'AGENTS.md'), 'utf8')).toBe('DEPLOY-RULE');
    },
    60000,
  );

  it('記憶來源（#2270）：沒有核准卡，回不能升級與守衛的理由', async () => {
    const reason = sharedReservedWrites(undefined, ['/shared/MEMORY.md']).at(-1)?.reason ?? '';
    const { card, reply } = await escalateOnLegacyThread('/MEMORY.md', [
      ...shipped,
      createMemoryPlugin({ sources: ['/shared/MEMORY.md'] }),
    ]);
    expect(card).toBe(false);
    expect(reply).toContain(reservedTargetRefusal(reason));
  }, 60000);

  it('經符號連結指到根目錄的指示檔：同一份規則，一樣不掛卡', async () => {
    await symlink(workspace, join(workspace, 'docs'));
    const { card, reply } = await escalateOnLegacyThread('/docs/AGENTS.md');
    expect(card).toBe(false);
    expect(reply).toContain(reservedTargetRefusal(instructionReason));
  }, 60000);

  it('反例：根目錄別的檔、子目錄裡的指示檔名、名字像技能來源的目錄：照舊掛核准卡', async () => {
    for (const target of ['/notes.md', '/sub/AGENTS.md', '/skillsx/a.md']) {
      expect((await escalateOnLegacyThread(target)).card).toBe(true);
    }
  }, 60000);
});

describe('CLI 的可寫根不是共用區：記憶來源照常能改（#2270）', () => {
  it('改得動', async () => {
    await writeFile(join(workspace, 'MEMORY.md'), 'OLD', 'utf8');
    const built = await createCliAgent(
      { live: false, workspace, workspaceRoot: workspace, sandbox: 'workspace-write' },
      withScriptedModel(
        [...shipped, createMemoryPlugin({ sources: ['/MEMORY.md'] })],
        [
          { content: '', toolCalls: [{ name: 'read_file', args: { file_path: '/MEMORY.md' } }] },
          {
            content: '',
            toolCalls: [{ name: 'write_file', args: { file_path: '/MEMORY.md', content: 'NEW' } }],
          },
          { content: '完。' },
        ],
      ),
      workspace,
    );
    const detach = built.attachSession(built.sessions);
    try {
      await built.agent.invoke(toAgentInvocation('記下來。'), {
        configurable: { thread_id: 'cli-memory' },
      });
    } finally {
      detach();
      await built.dispose();
    }
    expect(await readFile(join(workspace, 'MEMORY.md'), 'utf8')).toBe('NEW');
  }, 60000);
});
