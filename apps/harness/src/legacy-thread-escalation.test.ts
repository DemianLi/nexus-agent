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
import { SANDBOX_ESCALATION_TOOL_NAME } from '@nexus/plugin-sandbox-policy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { shippedPlugins, withScriptedModel } from './fixtures.js';
import { toAgentInvocation } from './messages.js';
import type { ScriptedTurn } from './scripted-model.js';

const shipped = await shippedPlugins();

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
async function escalateOnLegacyThread(target: string): Promise<{ card: boolean; reply: string }> {
  const built = await createCliAgent(
    { live: false, workspace, workspaceRoot: workspace, rootIsShared: true, sandbox: 'read-only' },
    withScriptedModel(shipped, [escalate(target), { content: '停。' }]),
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
    ['/AGENTS.md', '工作區指示'],
    ['/CLAUDE.md', '工作區指示'],
    ['/./AGENTS.local.md', '工作區指示'],
    ['/claude.local.md', '工作區指示'],
    ['/skills/normal/SKILL.md', '技能來源'],
    ['/skills/rogue/SKILL.md', '技能來源'],
    ['/skills', '技能來源'],
  ])(
    '對 %s 升級：沒有核准卡，回不能升級與守衛的理由',
    async (target, reason) => {
      const { card, reply } = await escalateOnLegacyThread(target);
      expect(card).toBe(false);
      expect(reply).toContain('沒有去問人');
      expect(reply).toContain(reason);
      expect(await readFile(join(workspace, 'AGENTS.md'), 'utf8')).toBe('DEPLOY-RULE');
    },
    60000,
  );

  it('經符號連結指到根目錄的指示檔：同一份規則，一樣不掛卡', async () => {
    await symlink(workspace, join(workspace, 'docs'));
    const { card, reply } = await escalateOnLegacyThread('/docs/AGENTS.md');
    expect(card).toBe(false);
    expect(reply).toContain('工作區指示');
  }, 60000);

  it('反例：根目錄別的檔、子目錄裡的指示檔名、名字像技能來源的目錄：照舊掛核准卡', async () => {
    for (const target of ['/notes.md', '/sub/AGENTS.md', '/skillsx/a.md']) {
      expect((await escalateOnLegacyThread(target)).card).toBe(true);
    }
  }, 60000);
});
