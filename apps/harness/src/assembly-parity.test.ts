import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry } from '@nexus/core';
import { createDeepAgent } from 'deepagents';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';

/** `assembleAgent` 收到的參數，最近一次。 */
const captured = vi.hoisted(() => ({ params: undefined as Record<string, unknown> | undefined }));

vi.mock('@nexus/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@nexus/core')>();
  return {
    ...original,
    assembleAgent: ((params: Record<string, unknown>) => {
      captured.params = params;
      return (original.assembleAgent as (p: unknown) => unknown)(params);
    }) as typeof original.assembleAgent,
  };
});

/**
 * **自有組裝點對上基座的 `createDeepAgent`：逐位元組比對。**
 *
 * 研究文件 §七的接縫 1。換掉 `createDeepAgent` 的風險不是「跑不起來」，是「組出來的東西跟今天不完全一樣，
 * 而沒有人看得出來」——系統提示少一段、工具多一個、middleware 換了順序，模型都不會報錯。所以這裡拿
 * **基座本身當參照答案**：同一份 fold 產物（從產品路徑 `createNexusAgent` 截下來）分別交給
 * `createDeepAgent` 與自有的 `assembleAgent`，各跑一輪**含一次 `task` 委派**的腳本，比對：
 *
 * - **每一次送給模型的請求**：訊息串（含 system 訊息）與綁定的工具清單（名稱、描述、參數 schema）。root 的第一次、
 *   子代理的第一次、root 的第二次都在裡面，所以 root 與子代理的組成一次驗到。
 * - **圖的節點**：middleware 的名稱與順序。
 *
 * 這條測試在 `deepagents` 被拿乾淨之前同時是升版絆索：基座改了組裝（多一顆 middleware、換順序、改提示），
 * 它會在這裡紅，而不是在生產上才發現。基座拿乾淨之後這條測試連同 `createDeepAgent` 的 import 一起拿掉。
 *
 * **沒涵蓋的**：skills 與 memory 的 middleware（兩個 plugin 都不在預設清單裡）、Anthropic／Bedrock 的快取
 * middleware（組裝點對它們拋出具名錯誤，不照搬）、`interruptOn`、async 與 fork 子代理——都是「拒絕」而不是
 * 「照做」，由 `agent-assembly.test.ts` 釘住那個拒絕。
 */

/** 每次 `bindTools` 都記下綁了什麼的假模型：`ScriptedChatModel` 只留最後一次。 */
class RecordingModel extends ScriptedChatModel {
  readonly bindings: string[] = [];
  readonly sink: string[];

  constructor(turns: readonly ScriptedTurn[], sink: string[] = []) {
    super({ turns });
    this.sink = sink;
  }

  override bindTools(tools: readonly unknown[]): ScriptedChatModel {
    this.sink.push(
      JSON.stringify(
        tools.map((candidate) => convertToOpenAITool(candidate as Parameters<typeof convertToOpenAITool>[0])),
      ),
    );
    return super.bindTools(tools);
  }
}

const WORKER: PluginEntry = {
  plugin: {
    name: 'parity-host',
    apply(registry) {
      registry.tools.register(
        tool(() => 'pong', { name: 'ping', description: '回 pong。', schema: z.object({}) }),
      );
      registry.subagents.register({
        name: 'worker',
        description: '幹活的。',
        systemPrompt: '你是 worker，只做交代給你的事。',
      });
      registry.permissions.deny(['/secret/**']);
    },
  },
};

const SYSTEM_PROMPT = '你是對照測試用的 agent。';

/** root 呼叫一次 `task` 委派 worker，worker 回一句話，root 收尾。 */
const SCRIPT: readonly ScriptedTurn[] = [
  {
    content: '',
    toolCalls: [
      { name: 'task', args: { description: '把事情做完', subagent_type: 'worker' } },
      { name: 'ping', args: {} },
    ],
  },
  { content: '子代理做完了。' },
  { content: '全部完成。' },
];

/** 訊息串的穩定投影：型別、內容、工具呼叫，不含 uuid 與時間這種每次都不同的欄位。 */
function project(messages: readonly BaseMessage[]): unknown[] {
  return messages.map((message) => ({
    type: message.getType(),
    content: message.content,
    ...(AIMessage.isInstance(message) &&
      message.tool_calls !== undefined &&
      message.tool_calls.length > 0 && {
        toolCalls: message.tool_calls.map((call) => ({ name: call.name, args: call.args })),
      }),
    ...('name' in message && typeof message.name === 'string' && { name: message.name }),
  }));
}

interface Observed {
  readonly requests: unknown[];
  readonly bindings: readonly string[];
  readonly nodes: readonly string[];
  readonly finalText: string | undefined;
}

type Runnable = {
  invoke: (input: unknown, config?: unknown) => Promise<{ messages: BaseMessage[] }>;
  graph?: { nodes?: Record<string, unknown> };
};

async function observe(agent: Runnable, model: RecordingModel): Promise<Observed> {
  const result = await agent.invoke(toAgentInvocation('開工。'), {
    configurable: { thread_id: 'parity' },
  });
  return {
    requests: model.prompts.map((prompt) => project(prompt)),
    bindings: model.sink,
    nodes: Object.keys(agent.graph?.nodes ?? {}),
    finalText: result.messages.at(-1)?.text,
  };
}

/** 產品路徑組一個 agent，順手截下它交給 `assembleAgent` 的參數。 */
async function assemble(model: RecordingModel, plugins: readonly PluginEntry[] = [WORKER]) {
  captured.params = undefined;
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    plugins: [...plugins],
    systemPrompt: SYSTEM_PROMPT,
  });
  const params = captured.params;
  if (params === undefined) throw new Error('assembleAgent 沒被呼叫：組裝點沒走自有組裝');
  return { built, params };
}

/** 同一份 fold 參數經基座的 `createDeepAgent` 跑一次當參照答案；模型與存檔點換成乾淨的。 */
async function referenceRun(plugins: readonly PluginEntry[], model: RecordingModel): Promise<Observed> {
  const { params } = await assemble(model, plugins);
  const reference = createDeepAgent({
    ...(params as Record<string, unknown>),
    model,
    checkpointer: new MemorySaver(),
  } as never) as unknown as Runnable;
  return observe(reference, model);
}

describe('自有組裝點對上 createDeepAgent', () => {
  it('同一份 fold 產物：每一次送給模型的請求、綁定的工具、圖的節點都逐位元組相同', async () => {
    const ownModel = new RecordingModel(SCRIPT);
    const { built } = await assemble(ownModel);
    const own = await observe(built.agent as unknown as Runnable, ownModel);

    const referenceModel = new RecordingModel(SCRIPT);
    const reference = await referenceRun([WORKER], referenceModel);

    // 先確認這條測試真的跑過了該跑的東西：三次模型呼叫（root、子代理、root），兩邊都是。
    expect(own.requests).toHaveLength(3);
    expect(own.finalText).toBe('全部完成。');
    expect(own.nodes.length).toBeGreaterThan(2);
    expect(own.bindings.length).toBeGreaterThanOrEqual(2);

    expect(own.requests).toEqual(reference.requests);
    expect(own.bindings).toEqual(reference.bindings);
    expect(own.nodes).toEqual(reference.nodes);
    expect(own.finalText).toBe(reference.finalText);
  });

  it('root 的系統提示就是組裝點給的那一句，沒有基座的 base prompt 墊在後面', async () => {
    const model = new RecordingModel(SCRIPT);
    const { built } = await assemble(model);
    await observe(built.agent as unknown as Runnable, model);

    const rootSystem = model.prompts[0]?.[0];
    expect(rootSystem?.getType()).toBe('system');
    // 內容是區塊陣列（檔案工具那顆 middleware 會往系統訊息後面接段落），讀文字用 `.text`。
    const text = rootSystem?.text ?? '';
    expect(text.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(text).not.toContain('You are a Deep Agent');
  });
});

/**
 * **翻面的絆索：自有組裝點不套 harness profile。**
 *
 * 基座的 `createDeepAgent` 從模型解出一份 profile 並改寫組裝；舊的 `harness-profile.ts` 要求組裝點「宣告」
 * 才放行。自有組裝點之後**沒有 profile 這回事**，所以舊檢查拿掉了。這條測試守的是它的反面：挑一顆基座有內建
 * profile 的模型（Codex），**基座那邊的組裝確實會被改**（證明這條測試量得到東西），**自有組裝點的組裝不變**。
 */
describe('自有組裝點不套 harness profile', () => {
  /** 讓基座的 `getModelProvider`／`getModelIdentifier` 解成 `openai:gpt-5.2-codex` 的假模型。 */
  class CodexLikeModel extends RecordingModel {
    readonly _defaultConfig = { modelProvider: 'openai', model: 'gpt-5.2-codex' };
    override getName(): string {
      return 'ConfigurableModel';
    }
  }

  it('基座對 Codex 會改組裝；自有組裝點對 Codex 與對一般模型組出同一個東西', async () => {
    const plain = new RecordingModel(SCRIPT);
    const plainBuilt = await assemble(plain);
    const plainObserved = await observe(plainBuilt.built.agent as unknown as Runnable, plain);

    const codex = new CodexLikeModel(SCRIPT);
    const codexBuilt = await assemble(codex);
    const codexObserved = await observe(codexBuilt.built.agent as unknown as Runnable, codex);

    // 自有組裝點：模型字串不影響組成。
    expect(codexObserved.requests).toEqual(plainObserved.requests);
    expect(codexObserved.bindings).toEqual(plainObserved.bindings);
    expect(codexObserved.nodes).toEqual(plainObserved.nodes);

    // 對照：同一份參數丟給基座，Codex 那份 profile 確實改了組裝——否則上面那條證明不了什麼。
    const baseModel = new CodexLikeModel(SCRIPT);
    const base = await referenceRun([WORKER], baseModel);
    const changed =
      JSON.stringify(base.requests) !== JSON.stringify(plainObserved.requests) ||
      JSON.stringify(base.bindings) !== JSON.stringify(plainObserved.bindings) ||
      JSON.stringify(base.nodes) !== JSON.stringify(plainObserved.nodes);
    expect(changed).toBe(true);
  });
});
