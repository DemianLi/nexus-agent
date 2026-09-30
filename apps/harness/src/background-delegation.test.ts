/**
 * 背景派出的委派工具 `subagent`（[#831](https://github.com/DemianLi/nexus-agent/issues/831)）的驗收。
 *
 * 產品路徑：真的組裝（`createNexusAgent({ backgroundSubagents })`）、真的 deepagents `task`（前景改派）、
 * 真的 `attachSession` 建的 host。**子代理有自己的假模型**（規格上的 `model`），所以 root 與背景那一輪各吃各的腳本、
 * 不搶同一條，也就不需要用閘門排順序。
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry, SessionLog } from '@nexus/core';
import { createHostServicesPlugin, SessionRegistry, TOOL_ERROR_PREFIX } from '@nexus/core';
import {
  ASK_USER_QUESTION_TOOL_NAME,
  createAskUserPlugin,
  DELEGATED_CALLER_MESSAGE,
} from '@nexus/plugin-ask-user';
import { hasDirectHumanTurn } from '@nexus/plugin-goal';
import { createSandboxPolicyPlugin, SandboxModeController } from '@nexus/plugin-sandbox-policy';
import { createSubmitRecordPlugin } from '@nexus/plugin-submit-record';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createMiddleware } from 'langchain';

import { createNexusAgent } from './agent-factory.js';
import { TASK_DESCRIPTION_REWRITES } from './background-delegation.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import type { SandboxMode } from './contained-backend.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedToolCall, ScriptedTurn } from './scripted-model.js';

const OVERLOADED = 'Service temporarily overloaded';

let dir: string;
let unhandled: unknown[] = [];
const recordUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-bg-delegation-'));
  unhandled = [];
  process.on('unhandledRejection', recordUnhandled);
});
afterEach(async () => {
  process.off('unhandledRejection', recordUnhandled);
  await rm(dir, { recursive: true, force: true });
});

const call = (name: string, args: ScriptedToolCall['args']): ScriptedTurn => ({
  content: '',
  toolCalls: [{ name, args }],
});
const delegate = (runInBackground: boolean | undefined, description = '幹活') =>
  call('subagent', {
    description,
    subagent_type: 'worker',
    ...(runInBackground !== undefined && { run_in_background: runInBackground }),
  });

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

const toolTexts = (messages: readonly BaseMessage[]) =>
  messages.filter((message) => message.getType() === 'tool').map((message) => message.text);

interface Options {
  readonly rootTurns: readonly ScriptedTurn[];
  readonly workerTurns: readonly ScriptedTurn[];
  /** `undefined`＝不給選項（今天的樣子）。 */
  readonly background?:
    { readonly sandbox?: SandboxModeController; readonly maxActive?: number } | undefined;
  readonly plugins?: readonly PluginEntry[];
  readonly backend?: ContainedFilesystemBackend;
  readonly flipTo?: SandboxModeController;
}

async function assemble(options: Options) {
  const rootModel = new ScriptedChatModel({ turns: options.rootTurns });
  const workerModel = new ScriptedChatModel({ turns: options.workerTurns });
  const worker: PluginEntry = {
    plugin: {
      name: 'worker-host',
      apply(registry) {
        registry.subagents.register({
          name: 'worker',
          description: '幹活的。',
          systemPrompt: '你是 worker，只做交代給你的事。',
          model: workerModel as never,
        });
        // 子代理拿得到的小工具：`look` 什麼都不做；`flip` 在子代理那一輪裡切 root 的沙箱模式（同 `subagent-sandbox.test.ts`）。
        registry.tools.register(
          tool(() => '看過了', { name: 'look', description: '看一眼。', schema: z.object({}) }),
        );
        const controller = options.flipTo;
        if (controller !== undefined) {
          registry.tools.register(
            tool(
              ({ to }: { to: SandboxMode }) => {
                controller.switchTo(to);
                return `切到 ${to}`;
              },
              {
                name: 'flip',
                description: '切 root 的沙箱模式。',
                schema: z.object({
                  to: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
                }),
              },
            ),
          );
        }
      },
    },
  };
  const built = await createNexusAgent({
    model: rootModel,
    checkpointer: new MemorySaver(),
    plugins: [worker, ...(options.plugins ?? [])],
    backend:
      options.backend ?? new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' }),
    ...(options.background !== undefined && { backgroundSubagents: options.background }),
  });
  const sessions = new SessionRegistry('root-1');
  const detach = built.attachSession(sessions);
  return {
    built,
    sessions,
    rootModel,
    workerModel,
    /** 一輪到收尾。 */
    async say(text = '委派') {
      return (await built.agent.invoke(
        { messages: [new HumanMessage(text)] },
        { configurable: { thread_id: 'thread-1' } },
      )) as { messages: BaseMessage[] };
    },
    /** 背景子代理的日誌。 */
    backgroundLogs(): SessionLog[] {
      return sessions
        .list()
        .filter((entry) => entry.address.kind === 'subagent')
        .map((entry) => entry.log);
    },
    async backgroundDone(log: SessionLog) {
      await until(() =>
        log.events.some((event) => event.type === 'turn/end' || event.type === 'turn/failed'),
      );
    },
    close: async () => {
      detach();
      await built.dispose();
    },
  };
}

const turnTypes = (log: SessionLog) =>
  log.events.map((event) => event.type).filter((type) => type.startsWith('turn/'));

describe('不給選項：完全不變', () => {
  it('模型看到基座的 task，沒有 subagent', async () => {
    const run = await assemble({ rootTurns: [{ content: '好' }], workerTurns: [] });
    try {
      await run.say();
      expect(run.rootModel.boundToolNames).toContain('task');
      expect(run.rootModel.boundToolNames).not.toContain('subagent');
      expect(run.rootModel.boundToolNames).not.toContain('list_agents');
    } finally {
      await run.close();
    }
  });

  it('沒有 checkpointer 就不給背景選項——沒有存檔點就沒有第二輪', async () => {
    await expect(
      createNexusAgent({
        model: new ScriptedChatModel({ turns: [] }),
        plugins: [],
        backgroundSubagents: {},
      }),
    ).rejects.toThrow(/checkpointer/);
  });
});

/** 模型看到的 `task`／`subagent` 描述：用一顆 `last` 的 middleware 讀當次請求。 */
async function describedTool(background: boolean, name: 'task' | 'subagent'): Promise<string> {
  let seen = '';
  const spy = createMiddleware({
    name: 'zzDescriptionSpy',
    wrapModelCall: (request, handler) => {
      seen =
        (request.tools.find((each) => each.name === name) as { description?: string })
          ?.description ?? '';
      return handler(request);
    },
  });
  const run = await assemble({
    rootTurns: [{ content: '好' }],
    workerTurns: [],
    ...(background && { background: {} }),
    plugins: [
      {
        plugin: {
          name: 'spy',
          apply: (registry) => void registry.middleware.use(spy, { last: true }),
        },
      },
    ],
  });
  try {
    await run.say();
    return seen;
  } finally {
    await run.close();
  }
}

describe('模型面的描述', () => {
  it('上游絆索：基座 task 的描述還帶著我們改寫的那幾句原文——變了就要重讀新描述', async () => {
    const original = await describedTool(false, 'task');
    for (const [from] of TASK_DESCRIPTION_REWRITES) expect(original).toContain(from);
  });

  it('subagent 的描述：沒有一次性的措辭、沒有提到被藏起來的 task，有子代理清單與 run_in_background', async () => {
    const text = await describedTool(true, 'subagent');
    expect(text).toContain('worker: 幹活的。');
    expect(text).toContain('general-purpose');
    expect(text).toContain('run_in_background');
    expect(text).not.toMatch(/ephemeral|stateless|single final report/);
    expect(text).not.toContain('`task`');
    expect(text).not.toMatch(/\btask tool\b/);
  });
});

/**
 * 上游絆索：我們偏離的理由是 langchain 禁止在 `wrapModelCall` 改已註冊的工具。哪天這一條放行了，這個測試會紅，
 * 那時可以直接給 `task` 加 `run_in_background`，`subagent` 這一整套偏離就能拆。
 */
describe('上游絆索：wrapModelCall 不能改已註冊的工具', () => {
  it('換掉 task 會拋 “You have modified a tool”', async () => {
    const swap = createMiddleware({
      name: 'zzSwapTask',
      wrapModelCall: (request, handler) =>
        handler({
          ...request,
          tools: request.tools.map((each) =>
            each.name === 'task'
              ? tool(() => '', { name: 'task', description: '換掉的', schema: z.object({}) })
              : each,
          ),
        }),
    });
    const run = await assemble({
      rootTurns: [{ content: '好' }],
      workerTurns: [],
      plugins: [
        { plugin: { name: 'swap', apply: (registry) => void registry.middleware.use(swap) } },
      ],
    });
    try {
      await expect(run.say()).rejects.toThrow(/You have modified a tool/);
    } finally {
      await run.close();
    }
  });
});

describe('給了選項：模型面', () => {
  it('task 從模型視野消失、換成 subagent；描述帶子代理清單與 run_in_background；系統提示詞多一句並行派', async () => {
    const run = await assemble({
      rootTurns: [{ content: '好' }],
      workerTurns: [],
      background: {},
    });
    try {
      await run.say();
      expect(run.rootModel.boundToolNames).toContain('subagent');
      expect(run.rootModel.boundToolNames).not.toContain('task');
      expect(run.rootModel.boundToolNames).toContain('list_agents');
      const bound = run.rootModel.prompts[0]!;
      const system = bound.find((message) => message.getType() === 'system')!.text;
      expect(system).toContain('同一則訊息裡一起呼叫 `subagent`');
    } finally {
      await run.close();
    }
  });
});

describe('前景（run_in_background: false）：改派給基座的 task', () => {
  it('子代理照今天的路徑跑完，結果回給模型，名字是 subagent', async () => {
    const run = await assemble({
      rootTurns: [delegate(false), { content: '根收尾' }],
      workerTurns: [{ content: '子答' }],
      background: {},
    });
    try {
      const result = await run.say();
      const toolMessage = result.messages.find((message) => message.getType() === 'tool')!;
      expect(toolMessage.text).toBe('子答');
      expect((toolMessage as { name?: string }).name).toBe('subagent');
      // 走的是基座的 task：子代理的日誌是 `checkpoint_ns` 那一條，不是背景編號。
      expect(run.backgroundLogs().some((log) => /\/bg-/.test(log.sessionId))).toBe(false);
      expect(run.backgroundLogs()).toHaveLength(1);
    } finally {
      await run.close();
    }
  });

  it('模型直接送藏起來的 task：照樣一次性跑完（等同前景）', async () => {
    const run = await assemble({
      rootTurns: [
        call('task', { description: '幹活', subagent_type: 'worker' }),
        { content: '根收尾' },
      ],
      workerTurns: [{ content: '子答' }],
      background: {},
    });
    try {
      const result = await run.say();
      expect(toolTexts(result.messages)).toEqual(['子答']);
    } finally {
      await run.close();
    }
  });
});

describe('背景（預設）：當場回編號，背景那一輪自己跑', () => {
  it('省略 run_in_background 就是背景：父輪不等，背景那一輪寫進 <root>/<編號> 自己的日誌', async () => {
    const run = await assemble({
      rootTurns: [delegate(undefined), { content: '根收尾' }],
      workerTurns: [call('look', {}), { content: '背景做完' }],
      background: {},
    });
    try {
      const result = await run.say();
      expect(result.messages.at(-1)?.text).toBe('根收尾');
      const [text] = toolTexts(result.messages);
      const id = /bg-[0-9a-f]{12}/.exec(text ?? '')?.[0];
      expect(id).toBeDefined();

      await until(() => run.backgroundLogs().length === 1);
      const [log] = run.backgroundLogs();
      expect(log?.sessionId).toBe(`root-1/${id}`);
      await run.backgroundDone(log!);
      expect(turnTypes(log!)).toEqual(['turn/start', 'turn/end']);
      expect(log!.events.filter((event) => event.type === 'tool/result')).toHaveLength(1);
      expect(log!.events.find((event) => event.type === 'turn/start')?.data).toEqual({
        kind: 'message',
        text: '幹活',
      });
    } finally {
      await run.close();
    }
  });

  it('派兩個：編號不同、各有各的日誌', async () => {
    const run = await assemble({
      rootTurns: [
        {
          content: '',
          toolCalls: [delegate(true, 'A').toolCalls![0]!, delegate(true, 'B').toolCalls![0]!],
        },
        { content: '根收尾' },
      ],
      workerTurns: [{ content: '甲' }, { content: '乙' }],
      background: {},
    });
    try {
      const result = await run.say();
      const ids = toolTexts(result.messages).map((text) => /bg-[0-9a-f]{12}/.exec(text)?.[0]);
      expect(new Set(ids).size).toBe(2);
      await until(() => run.backgroundLogs().length === 2);
      for (const log of run.backgroundLogs()) await run.backgroundDone(log);
    } finally {
      await run.close();
    }
  });

  it('編號、子代理名不對：回錯誤結果，不是背景那一輪的 turn/failed', async () => {
    const run = await assemble({
      rootTurns: [
        call('subagent', {
          description: '幹活',
          subagent_type: '沒有這個',
          run_in_background: true,
        }),
        { content: '根收尾' },
      ],
      workerTurns: [],
      background: {},
    });
    try {
      const result = await run.say();
      expect(toolTexts(result.messages)[0]).toContain(TOOL_ERROR_PREFIX);
      expect(toolTexts(result.messages)[0]).toContain('沒有 "沒有這個" 這個子代理');
      expect(run.backgroundLogs()).toHaveLength(0);
    } finally {
      await run.close();
    }
  });

  it('沒有接上會話（attachSession 之前）：回錯誤結果', async () => {
    const run = await assemble({
      rootTurns: [delegate(true), { content: '根收尾' }],
      workerTurns: [],
      background: {},
    });
    try {
      // detach 之後 host 已收。
      await run.close();
      const late = await run.built.agent.invoke(
        { messages: [new HumanMessage('委派')] },
        { configurable: { thread_id: 'thread-2' } },
      );
      expect(toolTexts(late.messages as BaseMessage[])[0]).toContain('還沒接上會話');
    } finally {
      await run.close().catch(() => undefined);
    }
  });

  it('背景那一輪模型拋錯：父輪不受影響，錯誤記在它自己的日誌、行程不死', async () => {
    const run = await assemble({
      rootTurns: [delegate(true), { content: '根收尾' }],
      workerTurns: [{ content: '', error: OVERLOADED }],
      background: {},
    });
    try {
      const result = await run.say();
      expect(result.messages.at(-1)?.text).toBe('根收尾');
      await until(() => run.backgroundLogs().length === 1);
      const [log] = run.backgroundLogs();
      await run.backgroundDone(log!);
      expect(turnTypes(log!)).toEqual(['turn/start', 'turn/failed']);
      await settle();
      expect(unhandled.map(String)).toEqual([]);
    } finally {
      await run.close();
    }
  });
});

describe('list_agents（#837）', () => {
  it('沒派過：回 (no subagents)；派了一個還在跑：running；跑完：inactive；一次性的不列', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holdPlugin: PluginEntry = {
      plugin: {
        name: 'hold-host',
        apply(registry) {
          registry.tools.register(
            tool(async () => (await held, '放行了'), {
              name: 'hold',
              description: '等放行。',
              schema: z.object({}),
            }),
          );
        },
      },
    };
    const run = await assemble({
      rootTurns: [
        call('list_agents', {}),
        delegate(undefined),
        call('list_agents', {}),
        // 前景（一次性）的不會出現在目錄。
        delegate(false),
        { content: '根收尾' },
        call('list_agents', {}),
        { content: '第二輪收尾' },
      ],
      workerTurns: [call('hold', {}), { content: '甲做完' }, { content: '一次性做完' }],
      background: {},
      plugins: [holdPlugin],
    });
    try {
      const first = await run.say();
      const texts = toolTexts(first.messages);
      expect(texts[0]).toBe('(no subagents)');
      const id = /bg-[0-9a-f]{12}/.exec(texts[1] ?? '')?.[0];
      expect(id).toBeDefined();
      expect(texts[2]).toBe(`${id} [running] — worker`);
      // 一次性那個跑過了，仍然只有一列。
      release();
      await until(() => turnTypes(run.backgroundLogs()[0]!).includes('turn/end'));
      const second = await run.say('再看一次');
      expect(toolTexts(second.messages).at(-1)).toBe(`${id} [inactive] — worker`);
    } finally {
      release();
      await run.close();
    }
  });
});

describe('list_agents 只給 root（#837）', () => {
  it('子代理叫它：被 root-only 的拒絕樁擋下，不列任何東西', async () => {
    const run = await assemble({
      rootTurns: [delegate(undefined), { content: '根收尾' }],
      workerTurns: [call('list_agents', {}), { content: '背景收工' }],
      background: {},
    });
    try {
      await run.say();
      await until(() => run.backgroundLogs().length === 1);
      await run.backgroundDone(run.backgroundLogs()[0]!);
      const seen = toolTexts(run.workerModel.prompts.at(-1)!).at(-1) ?? '';
      expect(seen).toContain(TOOL_ERROR_PREFIX);
      expect(seen).not.toContain('no subagents');
    } finally {
      await run.close();
    }
  });
});

describe('interrupt_agent（#838）', () => {
  it('模型叫它：只停那個子代理當下那一輪——慢工具落定後結果換成 aborted、之後不再叫模型；日誌收成 aborted/parent；父輪不受影響', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holdPlugin: PluginEntry = {
      plugin: {
        name: 'hold-host',
        apply(registry) {
          registry.tools.register(
            tool(
              async () => {
                entered();
                await held;
                return '放行了';
              },
              { name: 'hold', description: '等放行。', schema: z.object({}) },
            ),
          );
        },
      },
    };
    // root 的第二段要等編號出來才寫得出來，所以腳本是活的陣列。
    const rootTurns: ScriptedTurn[] = [delegate(undefined), { content: '根收尾' }];
    const run = await assemble({
      rootTurns,
      workerTurns: [call('hold', {}), { content: '不該走到這一步' }],
      background: {},
      plugins: [holdPlugin],
    });
    try {
      const first = await run.say();
      const id = /bg-[0-9a-f]{12}/.exec(toolTexts(first.messages)[0] ?? '')?.[0];
      expect(id).toBeDefined();
      await started;
      rootTurns.push(call('interrupt_agent', { agent_id: id! }), { content: '已請它停' });
      const second = await run.say('停掉它');
      expect(toolTexts(second.messages).at(-1)).toBe(`interrupt requested for agent ${id}`);

      // 同步回：此刻工具還沒落定，那一輪還沒收。
      const [log] = run.backgroundLogs();
      expect(log!.events.some((event) => event.type === 'turn/end')).toBe(false);
      release();
      await run.backgroundDone(log!);

      expect(log!.events.find((event) => event.type === 'turn/end')?.data).toEqual({
        reason: { kind: 'aborted', cause: { kind: 'parent' } },
      });
      const result = log!.events.find((event) => event.type === 'tool/result');
      expect((result?.data as { isError?: boolean }).isError).toBe(true);
      expect(JSON.stringify(result?.data)).toContain('tool call aborted');
      // 中止之後一步都不再開：worker 只叫過一次模型。
      expect(run.workerModel.prompts).toHaveLength(1);
      await settle();
      expect(unhandled).toEqual([]);
    } finally {
      release();
      await run.close();
    }
  });

  it('未知的編號：被接受的 no-op，回同一句、什麼都沒發生（不能靠回應試探編號）', async () => {
    const run = await assemble({
      rootTurns: [call('interrupt_agent', { agent_id: 'bg-000000000000' }), { content: '好' }],
      workerTurns: [],
      background: {},
    });
    try {
      const result = await run.say();
      expect(toolTexts(result.messages)[0]).toBe('interrupt requested for agent bg-000000000000');
    } finally {
      await run.close();
    }
  });

  it('只給 root：子代理叫它會被拒絕樁擋下', async () => {
    const run = await assemble({
      rootTurns: [delegate(undefined), { content: '根收尾' }],
      workerTurns: [call('interrupt_agent', { agent_id: 'bg-000000000000' }), { content: '收工' }],
      background: {},
    });
    try {
      await run.say();
      await until(() => run.backgroundLogs().length === 1);
      await run.backgroundDone(run.backgroundLogs()[0]!);
      const seen = toolTexts(run.workerModel.prompts.at(-1)!).at(-1) ?? '';
      expect(seen).toContain(TOOL_ERROR_PREFIX);
      expect(seen).not.toContain('interrupt requested');
    } finally {
      await run.close();
    }
  });
});

describe('send_message（#839）', () => {
  it('對做完的子代理追加指示：它開新的一輪、看得到第一輪；日誌是 agent-message；沒有直接人類授權', async () => {
    const rootTurns: ScriptedTurn[] = [delegate(undefined), { content: '根收尾' }];
    const run = await assemble({
      rootTurns,
      workerTurns: [{ content: '第一輪做完' }, { content: '第二輪做完' }],
      background: {},
    });
    try {
      const first = await run.say();
      const id = /bg-[0-9a-f]{12}/.exec(toolTexts(first.messages)[0] ?? '')?.[0];
      await until(() => run.backgroundLogs().length === 1);
      const [log] = run.backgroundLogs();
      await run.backgroundDone(log!);

      rootTurns.push(call('send_message', { agent_id: id!, message: '再補一份' }), {
        content: '已傳',
      });
      const second = await run.say('追加');
      // 回條，不是子代理的回答。
      expect(toolTexts(second.messages).at(-1)).toBe(`message delivered to agent ${id}`);
      await until(() => log!.events.filter((event) => event.type === 'turn/end').length === 2);

      const starts = log!.events.filter((event) => event.type === 'turn/start');
      expect(starts.map((event) => event.data)).toEqual([
        { kind: 'message', text: '幹活' },
        {
          kind: 'agent-message',
          text: 'Agent root-1 sent a message: 再補一份',
          senderSessionId: 'root-1',
        },
      ]);
      // 第二輪的模型看得到第一輪的任務與這則訊息。
      const humans = run.workerModel.prompts
        .at(-1)!
        .filter((message) => message.getType() === 'human')
        .map((message) => message.text);
      expect(humans).toEqual(['幹活', 'Agent root-1 sent a message: 再補一份']);
      expect(hasDirectHumanTurn(log!.events)).toBe(false);
    } finally {
      await run.close();
    }
  });

  it('編號不對：錯誤結果說明原因，沒有多開日誌；子代理自己叫它被 root-only 的拒絕樁擋下', async () => {
    const run = await assemble({
      rootTurns: [
        call('send_message', { agent_id: 'bg-000000000000', message: '喂' }),
        delegate(undefined),
        { content: '根收尾' },
      ],
      workerTurns: [
        call('send_message', { agent_id: 'bg-000000000000', message: '喂' }),
        { content: '收工' },
      ],
      background: {},
    });
    try {
      const result = await run.say();
      const [refused] = toolTexts(result.messages);
      expect(refused).toContain(TOOL_ERROR_PREFIX);
      expect(refused).toContain('沒有編號 bg-000000000000');
      await until(() => run.backgroundLogs().length === 1);
      await run.backgroundDone(run.backgroundLogs()[0]!);
      const seen = toolTexts(run.workerModel.prompts.at(-1)!).at(-1) ?? '';
      expect(seen).toContain(TOOL_ERROR_PREFIX);
      expect(seen).not.toContain('delivered');
    } finally {
      await run.close();
    }
  });
});

describe('並存上限（#836）', () => {
  it('超過上限的那一個：模型收到指名上限的錯誤結果，沒有多開日誌；等第一個做完就派得出去', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holdPlugin: PluginEntry = {
      plugin: {
        name: 'hold-host',
        apply(registry) {
          registry.tools.register(
            tool(async () => (await held, '放行了'), {
              name: 'hold',
              description: '等放行。',
              schema: z.object({}),
            }),
          );
        },
      },
    };
    const two = {
      content: '',
      toolCalls: [
        { name: 'subagent', args: { description: '甲', subagent_type: 'worker' } },
        { name: 'subagent', args: { description: '乙', subagent_type: 'worker' } },
      ],
    };
    const run = await assemble({
      rootTurns: [two, { content: '根收尾' }, delegate(undefined, '丙'), { content: '第二輪收尾' }],
      workerTurns: [call('hold', {}), { content: '甲做完' }, { content: '丙做完' }],
      background: { maxActive: 1 },
      plugins: [holdPlugin],
    });
    try {
      const first = await run.say();
      const texts = toolTexts(first.messages);
      expect(texts[0]).toMatch(/子代理已在背景啟動，編號：bg-[0-9a-f]{12}/);
      expect(texts[1]).toContain(TOOL_ERROR_PREFIX);
      expect(texts[1]).toContain('背景子代理已達並存上限 1（現在有 1 個在跑）');
      // 只開了一個日誌：被拒絕的沒有編號。
      expect(run.backgroundLogs()).toHaveLength(1);
      release();
      await run.backgroundDone(run.backgroundLogs()[0]!);
      await until(() => turnTypes(run.backgroundLogs()[0]!).includes('turn/end'));
      // 名額讓出來了：同一個 thread 再派一個成功。
      const second = await run.say('再派一個');
      expect(toolTexts(second.messages).at(-1)).toMatch(/子代理已在背景啟動/);
    } finally {
      release();
      await run.close();
    }
  });
});

describe('背景路徑上的 #324：核准自動拒絕、問答拒絕樁', () => {
  it('子代理叫 ask_user_question：拒絕、帶 DELEGATED_CALLER、不停下來', async () => {
    const run = await assemble({
      rootTurns: [delegate(true), { content: '根收尾' }],
      workerTurns: [
        call(ASK_USER_QUESTION_TOOL_NAME, { questions: [{ id: 'day', question: '哪一天？' }] }),
        { content: '背景收工' },
      ],
      background: {},
      plugins: [createAskUserPlugin()],
    });
    try {
      await run.say();
      await until(() => run.backgroundLogs().length === 1);
      const [log] = run.backgroundLogs();
      await run.backgroundDone(log!);
      const refusal = run.workerModel.prompts
        .flat()
        .find((message) => message.getType() === 'tool');
      expect(refusal?.text).toBe(`${TOOL_ERROR_PREFIX}${DELEGATED_CALLER_MESSAGE}`);
    } finally {
      await run.close();
    }
  });

  it('子代理叫掛 ask 的 submit_record：閘門判 policy-never，沒有人被問到', async () => {
    const run = await assemble({
      rootTurns: [delegate(true), { content: '根收尾' }],
      workerTurns: [
        call('submit_record', { file_path: '/out.csv', record: { 姓名: '阿明' } }),
        { content: '背景收工' },
      ],
      background: {},
      plugins: [createSubmitRecordPlugin()],
    });
    try {
      await run.say();
      await until(() => run.backgroundLogs().length === 1);
      const [log] = run.backgroundLogs();
      await run.backgroundDone(log!);
      expect(turnTypes(log!)).toEqual(['turn/start', 'turn/end']);
      const refusal = run.workerModel.prompts
        .flat()
        .find((message) => message.getType() === 'tool');
      expect(refusal?.text).toContain('沒有人被問到');
    } finally {
      await run.close();
    }
  });
});

describe('背景路徑上的 #326：沙箱快照', () => {
  /** root 是 read-only 時派出去；背景那一輪裡 root 被切到 workspace-write，寫檔仍要被擋。 */
  async function readOnlyDelegation(withSandboxPlugin: boolean) {
    const controller = new SandboxModeController('read-only');
    const backend = new ContainedFilesystemBackend({
      rootDir: dir,
      mode: controller.source,
      grants: controller,
    });
    return {
      controller,
      run: await assemble({
        rootTurns: [delegate(true), { content: '根收尾' }],
        workerTurns: [
          call('flip', { to: 'workspace-write' }),
          call('write_file', { file_path: '/b.txt', content: '寫' }),
          { content: '背景收工' },
        ],
        background: { sandbox: controller },
        flipTo: controller,
        backend,
        plugins: withSandboxPlugin
          ? [
              createHostServicesPlugin({ sandboxPolicy: { controller, rootDir: dir } }),
              createSandboxPolicyPlugin(),
            ]
          : [],
      }),
    };
  }

  it('委派那一格記在子代理日誌，root 之後放寬也不越權', async () => {
    const { controller, run } = await readOnlyDelegation(true);
    try {
      await run.say();
      await until(() => run.backgroundLogs().length === 1);
      const [log] = run.backgroundLogs();
      await run.backgroundDone(log!);
      expect(turnTypes(log!)).toEqual(['turn/start', 'turn/end']);
      expect(log!.events.find((event) => event.type === 'sandbox/mode')?.data).toEqual({
        mode: 'read-only',
        source: 'delegation',
      });
      // root 確實被放寬了，但背景寫不進去。
      expect(controller.current).toBe('workspace-write');
      await expect(readFile(join(dir, 'b.txt'))).rejects.toThrow();
      const writeResult = toolTexts(run.workerModel.prompts.at(-1)!).at(-1) ?? '';
      expect(writeResult).toContain('這個 backend 是唯讀的');
    } finally {
      await run.close();
    }
  });

  it('沒掛沙箱 plugin 的組裝：背景那一輪正常結束，不是 turn/failed', async () => {
    const run = await assemble({
      rootTurns: [delegate(true), { content: '根收尾' }],
      workerTurns: [{ content: '背景收工' }],
      background: {},
    });
    try {
      await run.say();
      await until(() => run.backgroundLogs().length === 1);
      const [log] = run.backgroundLogs();
      await run.backgroundDone(log!);
      expect(turnTypes(log!)).toEqual(['turn/start', 'turn/end']);
    } finally {
      await run.close();
    }
  });

  it('給了控制器卻沒掛沙箱 plugin（日誌上沒有委派那一格）：這一輪 turn/failed 並指名原因', async () => {
    const { run } = await readOnlyDelegation(false);
    try {
      await run.say();
      await until(() => run.backgroundLogs().length === 1);
      const [log] = run.backgroundLogs();
      await run.backgroundDone(log!);
      expect(turnTypes(log!)).toEqual(['turn/start', 'turn/failed']);
      expect(log!.events.find((event) => event.type === 'turn/failed')?.data).toMatchObject({
        message: expect.stringContaining('sandbox/mode'),
      });
    } finally {
      await run.close();
    }
  });
});
