/**
 * skills 與記憶這兩段在系統訊息裡的位置與時機（[#2414](https://github.com/DemianLi/nexus-agent/issues/2414)）。
 *
 * `skills.test.ts`、`memory.test.ts` 各自量一段；這裡量兩件它們沒走到的：
 *
 * - **掃描不完整的下一次 invoke**：這一次一個字都不接、不凍住，下一次 invoke 重掃，掃到了就接上。
 * - **同一次請求裡 skills、組裝點的中段、記憶都在**：各段的先後與記憶自成一塊。
 *
 * 看的是送進模型的那則系統訊息，跟那兩檔同一個做法。
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BaseMessage } from '@langchain/core/messages';
import { createMemoryPlugin } from '@nexus/plugin-memory';
import { describe, expect, it, vi } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import { createSkillsPlugin } from './skills.fixture.js';

/** 一輪 prompt 裡的系統訊息。 */
function systemOf(messages: readonly BaseMessage[]): BaseMessage {
  const system = messages.find((message) => message.getType() === 'system');
  if (system === undefined) throw new Error('這一輪沒有系統訊息');
  return system;
}

/** 一個工作區：`skills/<名字>/SKILL.md`，加上根目錄的幾個檔。 */
async function workspace(
  skills: Record<string, string>,
  files: Record<string, string> = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-base-sections-'));
  for (const [name, description] of Object.entries(skills)) {
    await mkdir(join(root, 'skills', name), { recursive: true });
    await writeFile(
      join(root, 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n正文：${name} 的完整步驟。\n`,
    );
  }
  for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content);
  return root;
}

describe('skills 掃描不完整的下一次 invoke', () => {
  it('這一次一個字都不接，下一次 invoke 重掃、接上', async () => {
    const root = await workspace({ 'web-research': '上網查資料。' });
    let failures = 1;
    class FlakyBackend extends ContainedFilesystemBackend {
      override async ls(
        path: string,
      ): Promise<Awaited<ReturnType<ContainedFilesystemBackend['ls']>>> {
        if (path === '/skills/' && failures > 0) {
          failures -= 1;
          throw new Error('備份端暫時讀不到');
        }
        return super.ls(path);
      }
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const model = new ScriptedChatModel({ turns: [{ content: '一。' }, { content: '二。' }] });
    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new FlakyBackend({ rootDir: root }),
      plugins: [createSkillsPlugin({ sources: ['/skills/'] })],
    });
    try {
      await agent.invoke(toAgentInvocation('第一次。'));
      const first = systemOf(model.lastPrompt).text;
      await agent.invoke(toAgentInvocation('第二次。'));
      const second = systemOf(model.lastPrompt).text;

      expect(first).not.toContain('Skills System');
      expect(first).not.toContain('web-research');
      expect(second).toContain('Skills System');
      expect(second).toContain('**web-research**: 上網查資料。');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('掃描不完整'));
    } finally {
      warn.mockRestore();
      await dispose();
    }
  });
});

describe('同一次請求裡 skills、中段與記憶都在', () => {
  it('skills 在組裝點的中段前面，記憶在最後、自成一塊', async () => {
    const root = await workspace(
      { 'web-research': '上網查資料。' },
      { 'AGENTS.md': '使用者的代號是胡桃。' },
    );
    const model = new ScriptedChatModel({ turns: [{ content: '知道了。' }] });
    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      plugins: [
        createSkillsPlugin({ sources: ['/skills/'] }),
        createMemoryPlugin({ sources: ['/AGENTS.md'] }),
      ],
    });
    try {
      await agent.invoke(toAgentInvocation('嗨。'));
    } finally {
      await dispose();
    }

    const system = systemOf(model.lastPrompt);
    const text = system.text;
    const skills = text.indexOf('Skills System');
    const observation = text.indexOf('Read a file before editing it');
    const memory = text.indexOf('<agent_memory>');
    expect(skills).toBeGreaterThan(-1);
    expect(observation).toBeGreaterThan(skills);
    expect(memory).toBeGreaterThan(observation);
    expect(text).toContain('使用者的代號是胡桃。');

    // 記憶不是接在前一塊後面，是另建一則區塊陣列的系統訊息、自己一塊，而且是最後一塊。
    const blocks = system.content as readonly { readonly type: string; readonly text?: string }[];
    expect(Array.isArray(blocks)).toBe(true);
    const last = blocks.at(-1);
    expect(last?.type).toBe('text');
    expect(last?.text?.startsWith('<agent_memory>')).toBe(true);
    expect(blocks.slice(0, -1).some((block) => block.text?.includes('<agent_memory>'))).toBe(false);
  });
});
