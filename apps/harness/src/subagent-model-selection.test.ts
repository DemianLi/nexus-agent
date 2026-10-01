/**
 * 模型逐次替子代理挑模型的工具面（[#877](https://github.com/DemianLi/nexus-agent/issues/877)，卡 [#709](https://github.com/DemianLi/nexus-agent/issues/709)）。
 *
 * 兩層：
 *
 * - **解析與探索**（純函式）：授權用的是「有效路由」、推理等級只認 `off`／`default`、都沒給＝繼承。
 * - **產品路徑**：真的組裝（`createNexusAgent({ backgroundSubagents })`）、真的 `attachSession` 建的 host；`modelFor` 回假端點。
 *   **有政策才有那兩格與 `list_subagent_models`；沒政策連帶了那兩格也拒絕**；前景不收；挑到的模型真的是子代理叫的那一顆。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry } from '@nexus/core';
import { SessionRegistry } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { LIST_SUBAGENT_MODELS_TOOL_NAME } from './background-delegation.js';
import type { ModelChoice } from './background-subagents.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { createLiveModel } from './live-model.js';
import type { ModelEntry } from './model-catalog.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { describeSubagentModels, resolveModelSelection } from './subagent-model-selection.js';
import type { ModelSelectionConfig } from './subagent-model-selection.js';

const entry = (id: string, extra: Partial<ModelEntry> = {}): ModelEntry => ({
  id,
  contextWindow: 100_000,
  maxTokens: 4096,
  ...extra,
});
const THINKING = { chatTemplateKwargs: { enable_thinking: { $var: 'thinking.enabled' as const } } };
const CATALOG: ModelEntry[] = [
  entry('strong', { reasoningEfforts: { off: null, low: 'low', default: null }, compat: THINKING }),
  entry('cheap', { reasoningEfforts: { off: null }, compat: THINKING }),
  entry('plain', { reasoningEfforts: false }),
  entry('silent'),
  entry('secret', { reasoningEfforts: { off: null } }),
];
const config = (allowedModels: string[], rootModelId = 'strong'): ModelSelectionConfig => ({
  allowedModels,
  rootModelId,
  catalog: CATALOG,
});

describe('resolveModelSelection', () => {
  const all = config(['strong', 'cheap', 'plain', 'silent']);
  const resolve = (request: Parameters<typeof resolveModelSelection>[1], c = all) =>
    resolveModelSelection(c, request);

  it('都沒給＝繼承，不查政策（授權清單是空的也一樣）', () => {
    expect(resolve({})).toEqual({ ok: true, choice: undefined });
    expect(resolve({}, config([]))).toEqual({ ok: true, choice: undefined });
  });

  it('給了授權清單裡的模型：選擇就是它；沒給推理等級＝不帶推理格', () => {
    expect(resolve({ model: 'cheap' })).toEqual({ ok: true, choice: { model: 'cheap' } });
  });

  it('不在清單裡的模型：拒絕並列出可選的；清單外但型錄裡有的也一樣', () => {
    const outcome = resolve({ model: 'secret' });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? '' : outcome.error).toMatch(/"secret".*不在.*授權.*"strong".*"cheap"/);
  });

  it('授權用的是有效路由：只給 reasoning_effort 時，root 那顆不在清單裡就拒絕', () => {
    expect(resolve({ reasoning_effort: 'off' }, config(['cheap']))).toMatchObject({ ok: false });
    expect(resolve({ reasoning_effort: 'off' }, config(['strong', 'cheap']))).toEqual({
      ok: true,
      choice: { model: 'strong', effort: 'off' },
    });
  });

  it('授權清單裡有、型錄裡沒有：拒絕，指名 id', () => {
    const outcome = resolve({ model: 'ghost' }, config(['ghost']));
    expect(outcome.ok ? '' : outcome.error).toContain('型錄裡沒有模型 "ghost"');
  });

  it('推理等級：宣告過且支援的收；default 等於沒給；root 加 default 仍是繼承', () => {
    expect(resolve({ model: 'cheap', reasoning_effort: 'off' })).toEqual({
      ok: true,
      choice: { model: 'cheap', effort: 'off' },
    });
    expect(resolve({ model: 'cheap', reasoning_effort: 'default' })).toMatchObject({ ok: false }); // cheap 沒宣告 default
    expect(resolve({ model: 'strong', reasoning_effort: 'default' })).toEqual({
      ok: true,
      choice: undefined,
    });
    expect(resolve({ model: 'strong' })).toEqual({ ok: true, choice: undefined });
  });

  it('推理等級：沒宣告（false／沒寫）、名字不在宣告裡、宣告了但還不支援，各自拒絕並說明', () => {
    const text = (request: Parameters<typeof resolveModelSelection>[1]) => {
      const outcome = resolve(request);
      return outcome.ok ? '' : outcome.error;
    };
    expect(text({ model: 'plain', reasoning_effort: 'off' })).toContain('沒有宣告可選的推理等級');
    expect(text({ model: 'silent', reasoning_effort: 'off' })).toContain('沒有宣告可選的推理等級');
    expect(text({ model: 'cheap', reasoning_effort: 'high' })).toContain('沒有推理等級 "high"');
    expect(text({ model: 'strong', reasoning_effort: 'low' })).toContain('還不支援');
  });

  it('空字串兩格都拒絕', () => {
    expect(resolve({ model: '' })).toMatchObject({ ok: false });
    expect(resolve({ reasoning_effort: '' })).toMatchObject({ ok: false });
  });
});

describe('describeSubagentModels', () => {
  const c = config(['strong', 'cheap', 'plain']);
  it('無參數：列授權清單，root 那顆標出來；不透露清單外的', () => {
    const text = describeSubagentModels(c, {});
    expect(text.split('\n')).toEqual(['strong（主對話目前用的）', 'cheap', 'plain']);
    expect(text).not.toContain('secret');
  });
  it('帶 model：只列宣告過又支援的推理等級（strong 的 low 還不支援，不列）', () => {
    expect(describeSubagentModels(c, { model: 'strong' })).toBe(
      'strong\nReasoning efforts:\noff\ndefault',
    );
    expect(describeSubagentModels(c, { model: 'plain' })).toBe(
      'plain\nReasoning efforts:\n(no advertised reasoning efforts)',
    );
  });
  it('帶清單外的 model：授權在前，拋錯、不透露型錄裡有沒有', () => {
    expect(() => describeSubagentModels(c, { model: 'secret' })).toThrow(/不在.*授權/);
    expect(() => describeSubagentModels(c, { model: 'nope' })).toThrow(/不在.*授權/);
  });
});

describe('createLiveModel 的 thinkingOff', () => {
  const live = {
    modelId: 'cheap',
    models: CATALOG,
    baseUrl: 'http://127.0.0.1:1/v1',
  };
  const kwargs = (thinkingOff?: boolean) =>
    (
      createLiveModel(live as never, undefined, { resolve: () => 'k' } as never, {
        ...(thinkingOff !== undefined && { thinkingOff }),
      }) as unknown as { modelKwargs?: Record<string, unknown> }
    ).modelKwargs;

  it('開了就帶型錄的 off 寫法；沒開（主對話那一顆）什麼都不帶', () => {
    expect(kwargs(true)).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(kwargs(undefined)).not.toHaveProperty('chat_template_kwargs');
    expect(kwargs(false)).not.toHaveProperty('chat_template_kwargs');
  });
});

describe('產品路徑：subagent 工具帶 model／reasoning_effort', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexus-model-select-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const call = (name: string, args: Record<string, unknown>): ScriptedTurn => ({
    content: '',
    toolCalls: [{ name, args }],
  });
  const delegate = (extra: Record<string, unknown>) =>
    call('subagent', { description: '幹活', subagent_type: 'worker', ...extra });
  const toolTexts = (messages: readonly BaseMessage[]) =>
    messages.filter((message) => message.getType() === 'tool').map((message) => message.text);

  async function assemble(options: {
    rootTurns: ScriptedTurn[];
    selection: ModelSelectionConfig | undefined;
    modelFor?: (choice: ModelChoice) => ScriptedChatModel;
  }) {
    const worker: PluginEntry = {
      plugin: {
        name: 'worker-host',
        apply(registry) {
          registry.subagents.register({
            name: 'worker',
            description: '幹活的。',
            systemPrompt: '你是 worker。',
          });
        },
      },
    };
    const rootModel = new ScriptedChatModel({ turns: options.rootTurns });
    const built = await createNexusAgent({
      model: rootModel,
      checkpointer: new MemorySaver(),
      plugins: [worker],
      backend: new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' }),
      backgroundSubagents: {
        ...(options.modelFor !== undefined && { modelFor: options.modelFor }),
        ...(options.selection !== undefined && { modelSelection: options.selection }),
      },
    });
    const sessions = new SessionRegistry('root-1');
    const detach = built.attachSession(sessions, {});
    return {
      rootModel,
      sessions,
      async say() {
        return (await built.agent.invoke(
          { messages: [new HumanMessage('委派')] },
          { configurable: { thread_id: 'thread-1' } },
        )) as { messages: BaseMessage[] };
      },
      subagentLogs: () => sessions.list().filter((each) => each.address.kind === 'subagent'),
      async close() {
        detach();
        await built.dispose();
      },
    };
  }
  const until = async (predicate: () => boolean) => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > 5000) throw new Error('等太久了');
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };

  it('授權的模型：背景那一輪打到 modelFor 回的那顆，root 的那顆只收尾；模型面多出兩格與 list_subagent_models', async () => {
    const cheap = new ScriptedChatModel({ turns: [{ content: '便宜做完' }] });
    const asked: ModelChoice[] = [];
    const run = await assemble({
      rootTurns: [delegate({ model: 'cheap' }), { content: '根收尾' }],
      selection: config(['strong', 'cheap']),
      modelFor: (choice) => {
        asked.push(choice);
        return cheap;
      },
    });
    try {
      const result = await run.say();
      expect(result.messages.at(-1)?.text).toBe('根收尾');
      expect(toolTexts(result.messages)[0]).toMatch(/bg-[0-9a-f]{12}/);
      await until(() => cheap.prompts.length === 1);
      expect(asked).toEqual([{ model: 'cheap' }]);
      expect(run.rootModel.boundToolNames).toContain(LIST_SUBAGENT_MODELS_TOOL_NAME);
      expect(run.subagentLogs()).toHaveLength(1);
    } finally {
      await run.close();
    }
  });

  it('只給 reasoning_effort：有效路由是 root 那顆，modelFor 收到 {root, off}', async () => {
    const alt = new ScriptedChatModel({ turns: [{ content: '好' }] });
    const asked: ModelChoice[] = [];
    const run = await assemble({
      rootTurns: [delegate({ reasoning_effort: 'off' }), { content: '根收尾' }],
      selection: config(['strong', 'cheap']),
      modelFor: (choice) => {
        asked.push(choice);
        return alt;
      },
    });
    try {
      await run.say();
      await until(() => alt.prompts.length === 1);
      expect(asked).toEqual([{ model: 'strong', effort: 'off' }]);
    } finally {
      await run.close();
    }
  });

  it('不在授權清單：工具結果講原因並列可選的，沒有派出任何子代理，modelFor 沒被叫', async () => {
    let called = 0;
    const run = await assemble({
      rootTurns: [delegate({ model: 'secret' }), { content: '根收尾' }],
      selection: config(['strong', 'cheap']),
      modelFor: () => {
        called += 1;
        return new ScriptedChatModel({ turns: [] });
      },
    });
    try {
      const result = await run.say();
      expect(toolTexts(result.messages)[0]).toMatch(/"secret".*不在.*授權.*"strong".*"cheap"/);
      expect(run.subagentLogs()).toHaveLength(0);
      expect(called).toBe(0);
    } finally {
      await run.close();
    }
  });

  it('前景（run_in_background: false）帶 model：拒絕，說明只有背景委派能指定', async () => {
    const run = await assemble({
      rootTurns: [
        delegate({ model: 'cheap', run_in_background: false }),
        delegate({ reasoning_effort: 'off', run_in_background: false }),
        { content: '根收尾' },
      ],
      selection: config(['strong', 'cheap']),
      modelFor: () => new ScriptedChatModel({ turns: [] }),
    });
    try {
      const texts = toolTexts((await run.say()).messages);
      expect(texts).toHaveLength(2);
      for (const text of texts) expect(text).toContain('只有背景委派能指定');
      expect(run.subagentLogs()).toHaveLength(0);
    } finally {
      await run.close();
    }
  });

  it('modelFor 建不出來：變成工具結果，不是整輪失敗', async () => {
    const run = await assemble({
      rootTurns: [delegate({ model: 'cheap' }), { content: '根收尾' }],
      selection: config(['strong', 'cheap']),
      modelFor: () => {
        throw new Error('端點連不上');
      },
    });
    try {
      const result = await run.say();
      expect(result.messages.at(-1)?.text).toBe('根收尾');
      expect(toolTexts(result.messages)[0]).toContain('端點連不上');
      expect(run.subagentLogs()).toHaveLength(0);
    } finally {
      await run.close();
    }
  });

  it('沒政策：沒有 list_subagent_models；模型硬帶 model／reasoning_effort 也拒絕，不靜靜忽略', async () => {
    const run = await assemble({
      rootTurns: [
        delegate({ model: 'cheap' }),
        delegate({ reasoning_effort: 'off' }),
        { content: '根收尾' },
      ],
      selection: undefined,
    });
    try {
      const texts = toolTexts((await run.say()).messages);
      expect(texts).toHaveLength(2);
      for (const text of texts) expect(text).toContain('沒有開子代理選模型');
      expect(run.rootModel.boundToolNames).not.toContain(LIST_SUBAGENT_MODELS_TOOL_NAME);
      expect(run.subagentLogs()).toHaveLength(0);
    } finally {
      await run.close();
    }
  });

  it('list_subagent_models：無參數列清單；帶 model 列推理等級；清單外的是錯誤結果', async () => {
    const run = await assemble({
      rootTurns: [
        call(LIST_SUBAGENT_MODELS_TOOL_NAME, {}),
        call(LIST_SUBAGENT_MODELS_TOOL_NAME, { model: 'cheap' }),
        call(LIST_SUBAGENT_MODELS_TOOL_NAME, { model: 'secret' }),
        { content: '根收尾' },
      ],
      selection: config(['strong', 'cheap']),
    });
    try {
      const texts = toolTexts((await run.say()).messages);
      expect(texts[0]).toBe('strong（主對話目前用的）\ncheap');
      expect(texts[1]).toBe('cheap\nReasoning efforts:\noff');
      expect(texts[2]).toMatch(/不在.*授權/);
    } finally {
      await run.close();
    }
  });
});
