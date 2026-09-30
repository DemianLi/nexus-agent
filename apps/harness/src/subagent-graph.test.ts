/**
 * 背景續行用的子代理圖（[#825](https://github.com/DemianLi/nexus-agent/issues/825)）：`compileSubagent` 編出來的東西，
 * 跟基座 `task` 那條路編出來的，**對模型來說是同一個子代理**。
 *
 * 這是漂移絆索：自編路徑複製了基座 `createSubagentDefaultMiddleware` 與 `mergeMiddlewareStack` 的形狀
 * （`packages/nexus-core/src/subagent-graph.ts` 檔頭），基座升版改掉預設疊時，兩條路模型看到的工具或系統提示會分岔，
 * 這裡就紅。量的是模型請求那一層（綁了哪些工具、收到的 system 文字），不是 middleware 的名單。
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry } from '@nexus/core';
import { createSkillsPlugin } from '@nexus/plugin-skills';
import { describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { shippedPlugins } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { toAgentInvocation } from './messages.js';

const shipped = await shippedPlugins();

/** 記下每一次 `bindTools` 綁了哪些工具（依模型呼叫的順序）。 */
class RecordingModel extends ScriptedChatModel {
  readonly bindings: string[][] = [];
  override bindTools(tools: readonly unknown[]): ScriptedChatModel {
    this.bindings.push(
      tools.map((candidate) => (candidate as { name?: string }).name ?? '<anonymous>'),
    );
    return super.bindTools(tools);
  }
}

const crew: PluginEntry = {
  plugin: {
    name: 'crew',
    apply: (registry) =>
      void registry.subagents.register({
        name: 'writer',
        description: '負責寫東西。',
        systemPrompt: '你是 writer，只寫交代給你的東西。',
      }),
  },
};

function systemText(prompt: readonly BaseMessage[]): string {
  return prompt
    .filter((message) => message.getType() === 'system')
    .map((message) => JSON.stringify(message.content))
    .join('\n');
}

async function workspaceWithSkill(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-subagent-graph-'));
  await mkdir(join(root, 'skills', 'web-research'), { recursive: true });
  await writeFile(
    join(root, 'skills', 'web-research', 'SKILL.md'),
    '---\nname: web-research\ndescription: 上網查資料。\n---\n\n正文。\n',
  );
  return root;
}

async function assemble(model: ScriptedChatModel, root: string) {
  return createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    backend: new ContainedFilesystemBackend({ rootDir: root }),
    plugins: [...shipped, createSkillsPlugin({ sources: ['/skills/'] }), crew],
  });
}

/** 子代理在 `task` 那條路上的那一次模型呼叫：綁了什麼工具、收到什麼 system 文字。 */
async function viaTask(name: string, root: string) {
  const turns: ScriptedTurn[] = [
    {
      content: '',
      toolCalls: [{ name: 'task', args: { description: '幹活', subagent_type: name } }],
    },
    { content: '子代理說完了' },
    { content: '收工' },
  ];
  const model = new RecordingModel({ turns });
  const built = await assemble(model, root);
  try {
    await built.agent.invoke(toAgentInvocation('派 ' + name), {
      configurable: { thread_id: 'root' },
    });
  } finally {
    await built.dispose();
  }
  // 三次模型呼叫：root、子代理、root。
  return { tools: model.bindings[1], system: systemText(model.prompts[1] ?? []) };
}

/** 同一個子代理在背景圖上的那一次模型呼叫。 */
async function viaCompiled(name: string, root: string) {
  const model = new RecordingModel({ turns: [{ content: '子代理說完了' }] });
  const built = await assemble(model, root);
  try {
    const graph = built.compileSubagent(name, new MemorySaver());
    await graph.invoke(toAgentInvocation('幹活'), { configurable: { thread_id: 'bg-1' } });
  } finally {
    await built.dispose();
  }
  return { tools: model.bindings[0], system: systemText(model.prompts[0] ?? []) };
}

describe('漂移絆索：同一份規格，task 那條路與背景圖，模型看到的一樣', () => {
  for (const name of ['writer', 'general-purpose']) {
    it(`${name}：綁的工具名與 system 文字相同`, async () => {
      const root = await workspaceWithSkill();
      const task = await viaTask(name, root);
      const compiled = await viaCompiled(name, root);

      // 先確認比的東西不是空的：檔案工具與（gp 的）skills 段落真的在。
      expect(task.tools).toEqual(expect.arrayContaining(['read_file', 'write_file', 'ls']));
      if (name === 'general-purpose') expect(task.system).toContain('web-research');

      expect(compiled.tools).toEqual(task.tools);
      expect(compiled.system).toBe(task.system);
    });
  }
});

describe('compileSubagent 的邊界', () => {
  it('沒有這個子代理：拋並指名', async () => {
    const root = await workspaceWithSkill();
    const built = await assemble(new RecordingModel({ turns: [] }), root);
    try {
      expect(() => built.compileSubagent('nope', new MemorySaver())).toThrow(/沒有 "nope"/u);
    } finally {
      await built.dispose();
    }
  });
});
