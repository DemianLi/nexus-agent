/**
 * 模型看到的 `task` 對著真的基座逐字比（[#2415](https://github.com/DemianLi/nexus-agent/issues/2415)）：同一份子代理清單，各交給基座
 * `createSubAgentMiddleware` 與 {@link taskToolDefinition}，比轉成 OpenAI 形狀之後的整份定義。升級基座時字變了就紅在這裡。
 * 組好的 agent 送給模型的是 core 這一份、它頂替的（`originalToolOf`）是基座那顆，也在這裡量。
 */

import { FakeListChatModel } from '@langchain/core/utils/testing';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { createSubAgentMiddleware, StateBackend } from 'deepagents';
import type { SubAgent } from 'deepagents';
import { createMiddleware } from 'langchain';
import { describe, expect, it } from 'vitest';

import { assembleAgent } from './agent-assembly.js';
import { taskToolDefinition, taskToolOverride } from './task-tool-definition.js';
import type { TaskSubagent } from './task-tool-definition.js';
import { originalToolOf, overriddenTools, toolNameOf } from './tool-resolution.js';

function baseTask(subagents: readonly TaskSubagent[]): unknown {
  const middleware = createSubAgentMiddleware({
    defaultModel: new FakeListChatModel({ responses: ['好'] }) as never,
    defaultTools: [],
    subagents: subagents.map((subagent) => ({ ...subagent, systemPrompt: '' })),
    generalPurposeAgent: false,
  });
  return middleware.tools?.[0];
}

const cases: Record<string, readonly TaskSubagent[]> = {
  只有一個: [{ name: 'general-purpose', description: '通用。' }],
  '幾個，照先後': [
    { name: 'general-purpose', description: '通用。' },
    { name: 'worker', description: '幹活的。' },
    { name: 'reviewer', description: 'Reviews code.' },
  ],
  '描述帶換行、縮排、$& 與反斜線': [
    { name: 'a', description: '多行\n  縮排\n\n結尾 $& \\' },
    { name: 'b c', description: '' },
  ],
};

describe('taskToolDefinition 對著基座的 task', () => {
  for (const [title, subagents] of Object.entries(cases)) {
    it(title, () => {
      const fromBase = convertToOpenAITool(baseTask(subagents) as never);
      const fromCore = taskToolDefinition(subagents);
      expect(JSON.stringify(fromCore)).toBe(JSON.stringify(fromBase));
      expect(convertToOpenAITool(fromCore as never)).toEqual(fromBase);
    });
  }

  it('名字不可列舉：清單上認得出是 task，序列化出去沒有多一格', () => {
    const definition = taskToolDefinition(cases['只有一個']!);
    expect(toolNameOf(definition)).toBe('task');
    expect(Object.keys(definition)).toEqual(['type', 'function']);
  });
});

describe('taskToolOverride', () => {
  it('只換 task，每次交同一個定義；原本那顆從 originalToolOf 取回', () => {
    const subagents = cases['只有一個']!;
    const task = baseTask(subagents) as object;
    const other = { name: 'grep' };
    const override = taskToolOverride(subagents);
    const once = overriddenTools([other, task], override);
    const twice = overriddenTools(once, override);
    expect(once[0]).toBe(other);
    expect(once[1]).toBe(twice[1]);
    expect(JSON.stringify(once[1])).toBe(JSON.stringify(convertToOpenAITool(task as never)));
    expect(originalToolOf(twice[1])).toBe(task);
  });
});

describe('組好的 agent', () => {
  it('模型看到的 task 是 core 那一份，原本那顆是基座的工具', async () => {
    const seen: unknown[] = [];
    const spy = createMiddleware({
      name: 'zzTaskSpy',
      wrapModelCall: (request, handler) => {
        seen.push(request.tools.find((tool) => toolNameOf(tool) === 'task'));
        return handler(request);
      },
    });
    const subagents: SubAgent[] = [
      { name: 'general-purpose', description: '通用。', systemPrompt: '通用。', tools: [] },
      { name: 'worker', description: '幹活的。', systemPrompt: '幹活。', tools: [] },
    ];
    const agent = assembleAgent({
      tools: [],
      subagents,
      middleware: [spy as never],
      model: new FakeListChatModel({ responses: ['好。'] }),
      backend: new StateBackend(),
    });
    await agent.invoke({ messages: [{ role: 'user', content: '嗨' }] });

    const definition = taskToolDefinition(subagents);
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0])).toBe(JSON.stringify(definition));
    const original = originalToolOf(seen[0]);
    expect(original).not.toBe(seen[0]);
    expect(convertToOpenAITool(original as never)).toEqual(JSON.parse(JSON.stringify(definition)));
  });
});
