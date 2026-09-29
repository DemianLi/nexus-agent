/**
 * 背景續行子代理的探針（[#738](https://github.com/DemianLi/nexus-agent/issues/738)，地圖 #737 的第一張）。
 *
 * 規格是 #708：子代理活在 `task` 那一次呼叫**以外**，派出去當場回編號，之後收到訊息再開新的一輪。這支檔案不實作它、
 * 不改任何產品程式碼，只回答「我們的組裝哪幾塊能照搬、哪幾塊要換載體」，用真組裝＋假模型量：
 *
 * 1. 子代理在 `task` 外用自己的 thread id 連跑兩輪，第二輪看得到第一輪。
 * 2. 換了組裝路之後，核准自動拒絕、問答拒絕樁、圍堵、摘要、檔案工具都還在。
 * 3. 沙箱快照：委派之後 root 切模式，第一輪與被叫醒的第二輪各讀到什麼。
 * 4. root 按停止，背景那一輪還活著；背景在 root 收掉之後拋錯，行程不死。
 *
 * 另外量了卡上第 5 項要動的「身分」那一格：背景圖的呼叫會被認成誰。
 *
 * **留在樹上當絆索**：斷言釘的是今天量到的樣子，包括「今天做不到」的那幾條。後面的子卡落地時，把那幾條翻成
 * 正面驗收；哪一條先紅，就是哪一塊已經換了載體。每條的註解寫明量到什麼、對應卡上哪一項。
 *
 * **怎麼拿到 fold 交給基座的 `SubAgent` 規格**：攔 `createDeepAgent` 收到的參數（`vi.mock` 包一層，原樣轉呼叫），
 * 所以看到的就是產品路徑真的交出去的東西，不是另跑一次 fold 的複本。
 *
 * **背景圖怎麼編**：`compileBackground` 拿同一份規格自己編一張帶存檔點的圖（卡上的乙路）。基座替子代理補的那一疊
 * 預設（檔案系統、摘要、補懸空工具呼叫）在自編路上不會自動有，這裡照基座的樣子補回去（`baseDefaults`）。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。腳本的輪數是全域依序吃的，root 與背景搶同一條，
 * 所以需要順序的測試用閘門（`Gates`）讓 root 停在一顆工具裡，等背景的輪吃完再放行。
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry } from '@nexus/core';
import {
  createHostServicesPlugin,
  SUBAGENT_DELEGATION_CONTEXT,
  toolCallSessionAddress,
  TURN_CANCEL_CONFIG_KEY,
} from '@nexus/core';
import { createAskUserPlugin, DELEGATED_CALLER_MESSAGE } from '@nexus/plugin-ask-user';
import type { SandboxMode } from '@nexus/core';
import { createSandboxPolicyPlugin, SandboxModeController } from '@nexus/plugin-sandbox-policy';
import { createSubmitRecordPlugin } from '@nexus/plugin-submit-record';
import {
  createFilesystemMiddleware,
  createPatchToolCallsMiddleware,
  createSummarizationMiddleware,
} from 'deepagents';
import type { SubAgent } from 'deepagents';
import { createAgent } from 'langchain';
import type { AgentMiddleware } from 'langchain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createNexusAgent, TOOL_RESULT_STASH_PREFIX } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

/** `createDeepAgent` 收到的參數，最近一次。 */
const captured = vi.hoisted(() => ({ params: undefined as Record<string, unknown> | undefined }));

vi.mock('deepagents', async (importOriginal) => {
  const original = await importOriginal<typeof import('deepagents')>();
  return {
    ...original,
    createDeepAgent: ((params: Record<string, unknown>) => {
      captured.params = params;
      return (original.createDeepAgent as (p: unknown) => unknown)(params);
    }) as typeof original.createDeepAgent,
  };
});

const OVERLOADED = 'Service temporarily overloaded';

let dir: string;
let unhandled: unknown[] = [];
const recordUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-bg-probe-'));
  captured.params = undefined;
  unhandled = [];
  process.on('unhandledRejection', recordUnhandled);
});

afterEach(async () => {
  process.off('unhandledRejection', recordUnhandled);
  await rm(dir, { recursive: true, force: true });
});

// ───────────────────────────── 小工具 ─────────────────────────────

const call = (name: string, args: Record<string, unknown>): ScriptedTurn => ({
  content: '',
  toolCalls: [{ name, args }],
});
const say = (name: string, text: string) => call(name, { text });

const texts = (messages: readonly BaseMessage[]) => messages.map((message) => message.text);
const toolTexts = (messages: readonly BaseMessage[]) =>
  texts(messages.filter((message) => message.getType() === 'tool'));
const humanTexts = (messages: readonly BaseMessage[]) =>
  texts(messages.filter((message) => message.getType() === 'human'));
const names = (stack: readonly { name: string }[]) => stack.map((entry) => entry.name);

/** 未處理的 rejection 在 microtask 排空之後才報，等一拍再數。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** 一顆手動開的閘門。 */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

const WORKER: PluginEntry = {
  plugin: {
    name: 'worker-host',
    apply(registry) {
      registry.subagents.register({
        name: 'worker',
        description: '幹活的。',
        systemPrompt: '你是 worker，只做交代給你的事。',
      });
    },
  },
};

const BOOM: PluginEntry = {
  plugin: {
    name: 'boom',
    apply(registry) {
      registry.tools.register(
        tool(
          () => {
            throw new Error('工具本體炸了');
          },
          { name: 'boom', description: '一定拋錯。', schema: z.object({}) },
        ),
      );
    },
  },
};

// ───────────────────────────── 組裝 ─────────────────────────────

interface AssembleOptions {
  backend?: ContainedFilesystemBackend;
  model?: ScriptedChatModel;
}

/** 產品路徑的真組裝，回它交給基座的參數與各子代理規格。 */
async function assemble(
  turns: readonly ScriptedTurn[],
  plugins: readonly PluginEntry[],
  options: AssembleOptions = {},
) {
  const model = options.model ?? new ScriptedChatModel({ turns });
  const backend =
    options.backend ?? new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' });
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    plugins: [...plugins],
    backend,
  });
  const params = captured.params as {
    subagents: readonly SubAgent[];
    backend: unknown;
    model: unknown;
    permissions?: unknown;
  };
  const spec = (name: string): SubAgent => {
    const found = params.subagents.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`沒有 ${name} 這個子代理規格`);
    return found;
  };
  return { built, model, params, spec };
}

/**
 * 基座替一般子代理補的那一疊預設（`createSubagentDefaultMiddleware`，deepagents 1.13.1
 * `langsmith-zm0ILQsV.js:6245-6259`）。走 `runnable` 或自己編圖的路都不經基座那一步，所以要自己補。
 */
function baseDefaults(backend: unknown, permissions?: unknown): AgentMiddleware[] {
  return [
    createFilesystemMiddleware({
      backend: backend as never,
      // 基座傳的是 `input.permissions ?? permissions`（同檔 :6247）；漏了這一格，全域的 deny 規則在背景路徑上就消失。
      ...(permissions !== undefined && { permissions: permissions as never }),
    }),
    createSummarizationMiddleware({ backend: backend as never }),
    createPatchToolCallsMiddleware(),
  ] as unknown as AgentMiddleware[];
}

/**
 * 同基座 `mergeMiddlewareStack` 的形狀：預設那疊裡同名的原地換成規格自己帶的，沒撞名的接在後面。
 * 基座那個沒有匯出，這裡是探針自己的複本；子卡落地時要決定是複本還是向上游要。
 */
function mergeByName(
  defaults: readonly AgentMiddleware[],
  custom: readonly AgentMiddleware[],
): AgentMiddleware[] {
  const customByName = new Map(custom.map((entry) => [entry.name, entry]));
  const defaultNames = new Set(defaults.map((entry) => entry.name));
  return [
    ...defaults.map((entry) => customByName.get(entry.name) ?? entry),
    ...custom.filter((entry) => !defaultNames.has(entry.name)),
  ];
}

/** 乙路：拿同一份規格自己編一張帶存檔點的圖。 */
function compileBackground(
  spec: SubAgent,
  params: { backend: unknown; model: unknown; permissions?: unknown },
  options: { omitPermissions?: boolean } = {},
) {
  return createAgent({
    model: params.model as never,
    systemPrompt: spec.systemPrompt,
    tools: (spec.tools ?? []) as never,
    middleware: mergeByName(
      baseDefaults(
        params.backend,
        options.omitPermissions === true ? undefined : (spec.permissions ?? params.permissions),
      ),
      (spec.middleware ?? []) as never,
    ),
    name: spec.name,
    checkpointer: new MemorySaver(),
  });
}

type BackgroundGraph = ReturnType<typeof compileBackground>;

/** 背景圖跑一輪（直接呼叫、不經 `task`）。 */
async function runBackground(
  graph: BackgroundGraph,
  text: string,
  threadId = 'bg-1',
  extra: Record<string, unknown> = {},
) {
  return (await graph.invoke(
    { messages: [new HumanMessage(text)] },
    { configurable: { thread_id: threadId, ...extra } },
  )) as { messages: BaseMessage[]; __interrupt__?: unknown };
}

/** 產品路徑：組裝＋pump 接上會話註冊表，再讓 root 先說一句話好讓 root 的日誌實體化。第 0 輪腳本是那句。 */
async function assembleWithPump(
  turns: readonly ScriptedTurn[],
  plugins: readonly PluginEntry[],
  options: AssembleOptions = {},
) {
  const assembled = await assemble([{ content: '根先說一句' }, ...turns], plugins, options);
  const pump = new ThreadPump(assembled.built.agent as unknown as PumpAgent, 'bg-probe');
  const detach = assembled.built.attachSession(pump.sessions);
  await pump.submit({ kind: 'message', text: '根的話' });
  await pump.whenIdle();
  return {
    ...assembled,
    pump,
    close: async () => {
      detach();
      await assembled.built.dispose();
    },
  };
}

// ───────────────────────────── 第 1 項 ─────────────────────────────

describe('第 1 項：子代理在 task 以外用自己的 thread id 連跑兩輪', () => {
  it('乙路：同一份規格自己編一張帶存檔點的圖，第二輪看得到第一輪', async () => {
    const { built, model, params, spec } = await assemble(
      [{ content: '一號回覆' }, { content: '二號回覆' }],
      [WORKER],
    );
    try {
      const graph = compileBackground(spec('worker'), params);
      await runBackground(graph, '第一輪的話');
      await runBackground(graph, '第二輪的話');

      // 驗收：第二輪那次模型呼叫錄到的 messages 裡有第一輪的對話。
      expect(model.prompts).toHaveLength(2);
      expect(texts(model.prompts[1] ?? [])).toEqual(
        expect.arrayContaining(['第一輪的話', '一號回覆', '第二輪的話']),
      );
    } finally {
      await built.dispose();
    }
  });

  it('對照：不帶存檔點就沒有記憶——基座 `task` 那條路編出來的圖就是這樣', async () => {
    const { built, model, params, spec } = await assemble(
      [{ content: '一號回覆' }, { content: '二號回覆' }],
      [WORKER],
    );
    try {
      const graph = createAgent({
        model: params.model as never,
        systemPrompt: spec('worker').systemPrompt,
        tools: (spec('worker').tools ?? []) as never,
        middleware: mergeByName(
          baseDefaults(params.backend),
          (spec('worker').middleware ?? []) as never,
        ),
        name: 'worker',
      });
      await runBackground(graph, '第一輪的話');
      await runBackground(graph, '第二輪的話');
      expect(texts(model.prompts[1] ?? [])).not.toContain('第一輪的話');
    } finally {
      await built.dispose();
    }
  });

  /**
   * 甲路：把編好的 `runnable` 交給基座。**一次性那條照樣跑得起來，但 fold 替子代理注的整疊東西一顆都沒進去**——
   * fold 對規格做的是 `{...spec, tools, middleware}`，基座對帶 `runnable` 的規格只取 `runnable`
   * （`langsmith-zm0ILQsV.js:3448-3449`），所以 middleware 靜靜地被丟掉。而 runnable 要在 plugin 的 `apply` 裡編好，
   * 那時 fold 的 middleware 還不存在（它們是 `foldRegistry` 之後才建的）。走甲路，`fold` 就得自己負責編這張圖。
   */
  it('甲路：runnable 一次性跑得起來，但 fold 注的委派聲明與子代理日誌都沒有', async () => {
    const model = new ScriptedChatModel({
      turns: [
        call('task', { description: '幹活', subagent_type: 'compiled' }),
        { content: '編好的子代理收工' },
        { content: '根收尾' },
      ],
    });
    const compiled: PluginEntry = {
      plugin: {
        name: 'compiled-host',
        apply(registry) {
          registry.subagents.register({
            name: 'compiled',
            description: '編好的。',
            runnable: createAgent({
              model,
              systemPrompt: '編好的子代理',
              tools: [],
              checkpointer: new MemorySaver(),
            }),
          } as never);
        },
      },
    };
    const built = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      plugins: [compiled],
    });
    const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'bg-probe-a');
    const detach = built.attachSession(pump.sessions);
    try {
      await pump.submit({ kind: 'message', text: '委派' });
      await pump.whenIdle();

      const subagentPrompt = model.prompts.find((prompt) =>
        prompt.some((message) => message.getType() === 'human' && message.text === '幹活'),
      );
      expect(subagentPrompt).toBeDefined();
      const system = subagentPrompt?.find((message) => message.getType() === 'system')?.text ?? '';
      expect(system).toContain('編好的子代理');
      // fold 注進規格的東西不在：委派聲明沒有，子代理沒有自己的會話日誌（圍堵沒有寫 tool/call 的機會）。
      expect(system).not.toContain(SUBAGENT_DELEGATION_CONTEXT);
      expect(pump.sessions.list().map((session) => session.address.kind)).toEqual(['root']);
    } finally {
      detach();
      await built.dispose();
    }
  });
});

// ───────────────────────────── 第 2 項 ─────────────────────────────

describe('第 2 項：換了組裝路之後 fold 注進規格的東西還在不在', () => {
  it('規格 middleware 帶著 fold 注的整疊：圍堵、中止、核准閘門、摘要器、委派聲明、用量、輸出上限', async () => {
    const { built, spec } = await assemble([{ content: '好' }], [WORKER, createAskUserPlugin()]);
    try {
      const specNames = names((spec('worker').middleware ?? []) as never);
      expect(specNames).toEqual(
        expect.arrayContaining([
          'nexusToolFailureContainment',
          'nexusTurnCancel',
          'nexusApprovalGate',
          'SummarizationMiddleware',
          'nexusSubagentDelegation',
          'nexusModelUsage',
          'nexusMaxTokens',
          'nexusTurnCancelModelSignal',
        ]),
      );
      // 圍堵在第 0 格，中止最內層（fold 的位置契約）。
      expect(specNames[0]).toBe('nexusToolFailureContainment');
      expect(specNames.at(-1)).toBe('nexusTurnCancelModelSignal');
    } finally {
      await built.dispose();
    }
  });

  it('自編的圖比規格多出基座那三顆預設：檔案系統、補懸空工具呼叫，摘要器被規格自己那顆換掉', async () => {
    const { built, params, spec } = await assemble([{ content: '好' }], [WORKER]);
    try {
      const own = names((spec('worker').middleware ?? []) as never);
      const merged = names(
        mergeByName(baseDefaults(params.backend), (spec('worker').middleware ?? []) as never),
      );
      expect(own).not.toContain('FilesystemMiddleware');
      expect(own).not.toContain('patchToolCallsMiddleware');
      expect(merged.slice(0, 3)).toEqual([
        'FilesystemMiddleware',
        'SummarizationMiddleware',
        'patchToolCallsMiddleware',
      ]);
      // 同名的只留一顆（fold 的摘要器），不會兩顆並存。
      expect(merged.filter((name) => name === 'SummarizationMiddleware')).toHaveLength(1);
    } finally {
      await built.dispose();
    }
  });

  it('需要核准的工具在背景圖上被自動拒絕、沒有停下來等人', async () => {
    const run = await assembleWithPump(
      [
        call('submit_record', { file_path: '/out.csv', record: { 姓名: '阿明' } }),
        { content: '收工' },
      ],
      [WORKER, createSubmitRecordPlugin()],
    );
    try {
      const result = await runBackground(compileBackground(run.spec('worker'), run.params), '幹活');
      expect(result.__interrupt__).toBeUndefined();
      expect(run.pump.awaitingInput).toBe(false);
      const [refusal] = toolTexts(result.messages);
      expect(refusal).toContain('這一列要寫出去，先讓人看過');
      expect(refusal).toContain('沒有人被問到');
    } finally {
      await run.close();
    }
  });

  it('問答工具在背景圖上拿到拒絕樁', async () => {
    const run = await assembleWithPump(
      [
        call('ask_user_question', { questions: [{ id: 'day', question: '哪一天？' }] }),
        { content: '收工' },
      ],
      [WORKER, createAskUserPlugin()],
    );
    try {
      const result = await runBackground(compileBackground(run.spec('worker'), run.params), '幹活');
      expect(toolTexts(result.messages)).toEqual([`Error: ${DELEGATED_CALLER_MESSAGE}`]);
    } finally {
      await run.close();
    }
  });

  it('工具拋錯被圍堵、整輪不死；檔案工具照寫', async () => {
    const run = await assembleWithPump(
      [
        call('boom', {}),
        call('write_file', { file_path: '/bg.txt', content: '背景寫的' }),
        { content: '收工' },
      ],
      [WORKER, BOOM],
    );
    try {
      const result = await runBackground(compileBackground(run.spec('worker'), run.params), '幹活');
      expect(toolTexts(result.messages)).toEqual([
        'Error: 工具 boom 執行失敗：工具本體炸了',
        "Successfully wrote to '/bg.txt'",
      ]);
      expect(await readFile(join(dir, 'bg.txt'), 'utf8')).toBe('背景寫的');
    } finally {
      await run.close();
    }
  });
});

describe('第 2 項（續）：全域 deny 規則與大結果外溢在背景圖上還在', () => {
  const DENY: PluginEntry = {
    plugin: {
      name: 'deny',
      apply(registry) {
        registry.permissions.deny(['/secret/**']);
      },
    },
  };

  const MARK = 'MURASAKI-7391';
  const BULK: PluginEntry = {
    plugin: {
      name: 'bulk',
      apply(registry) {
        registry.tools.register(
          tool(() => `${MARK}${'X'.repeat(80_001)}`, {
            name: 'bulk',
            description: '拿一坨東西。',
            schema: z.object({}),
          }),
        );
      },
    },
  };

  const exists = async (path: string) =>
    readFile(path).then(
      () => true,
      () => false,
    );

  it('全域 deny：規格帶著 permissions，背景圖照擋；對照組漏傳就寫得進去', async () => {
    const guarded = await assemble(
      [call('write_file', { file_path: '/secret/a.txt', content: '寫' }), { content: '收工' }],
      [WORKER, DENY],
    );
    try {
      expect(guarded.spec('worker').permissions).toBeDefined();
      const result = await runBackground(
        compileBackground(guarded.spec('worker'), guarded.params),
        '幹活',
      );
      expect(toolTexts(result.messages).join('\n')).not.toContain('Successfully wrote');
      expect(await exists(join(dir, 'secret/a.txt'))).toBe(false);
    } finally {
      await guarded.built.dispose();
    }

    const leaky = await assemble(
      [call('write_file', { file_path: '/secret/b.txt', content: '寫' }), { content: '收工' }],
      [WORKER, DENY],
    );
    try {
      const graph = compileBackground(leaky.spec('worker'), leaky.params, {
        omitPermissions: true,
      });
      const result = await runBackground(graph, '幹活');
      expect(toolTexts(result.messages).join('\n')).toContain('Successfully wrote');
      expect(await exists(join(dir, 'secret/b.txt'))).toBe(true);
    } finally {
      await leaky.built.dispose();
    }
  });

  it('大結果外溢（#719 要驗的）：超過 80,000 字元的工具結果搬去暫存，下一輪 read_file 讀得回暗號', async () => {
    const run = await assemble(
      [
        call('bulk', {}),
        call('read_file', { file_path: `${TOOL_RESULT_STASH_PREFIX}/call_1_0.txt`, limit: 5 }),
        { content: '收工' },
      ],
      [WORKER, BULK],
    );
    try {
      const result = await runBackground(compileBackground(run.spec('worker'), run.params), '幹活');
      const [first, second] = toolTexts(result.messages);
      expect(first).toContain(TOOL_RESULT_STASH_PREFIX);
      expect(first).not.toContain('X'.repeat(1000));
      expect(second).toContain(MARK);
    } finally {
      await run.built.dispose();
    }
  });
});

// ───────────────────────────── 第 3 項 ─────────────────────────────

/**
 * 探針自己的控制器：**在叫醒那一輪把委派時拍下的那一格重新放進 ALS**。
 * `SandboxModeController.delegate()` 只會拍「進去那一刻的 `current`」，表達不出「用先前記下的那一格」——
 * 這是實作時要在 `@nexus/plugin-sandbox-policy` 加的那一個入口，這裡用子類別覆寫 `current` 代替，只為了量
 * 「每一輪重新進 ALS」這個機制能不能穿過 LangGraph。
 */
class PinnedController extends SandboxModeController {
  readonly #pin = new AsyncLocalStorage<SandboxMode>();
  override get current(): SandboxMode {
    return this.#pin.getStore() ?? super.current;
  }
  runPinned<T>(mode: SandboxMode, run: () => T): T {
    return this.#pin.run(mode, run);
  }
}

describe('第 3 項：沙箱快照在背景路徑上', () => {
  /** 照 `cli.ts` 的接法：fence 與 plugin 讀同一顆控制器。 */
  async function fenced(
    mode: SandboxMode,
    turns: readonly ScriptedTurn[],
    controller: SandboxModeController = new SandboxModeController(mode),
  ) {
    const backend = new ContainedFilesystemBackend({
      rootDir: dir,
      mode: controller.source,
      grants: controller,
    });
    const run = await assemble(
      turns,
      [
        createHostServicesPlugin({ sandboxPolicy: { controller, rootDir: dir } }),
        WORKER,
        createSandboxPolicyPlugin(),
      ],
      { backend },
    );
    return { ...run, controller, graph: compileBackground(run.spec('worker'), run.params) };
  }

  const write = (file: string) => call('write_file', { file_path: file, content: '寫' });
  const lastTool = (messages: readonly BaseMessage[]) => toolTexts(messages).at(-1) ?? '';
  const REFUSED = '這個 backend 是唯讀的';
  const twoTurns = (a = '/a.txt', b = '/b.txt') =>
    [write(a), { content: '一' }, write(b), { content: '二' }] as const;
  const TWO_TURNS = twoTurns();

  it('沒有任何包裝：被叫醒的那一輪讀 root 現在那一格，不是委派那一格（root 收緊，子代理跟著被擋）', async () => {
    const run = await fenced('workspace-write', TWO_TURNS);
    try {
      const first = await runBackground(run.graph, '第一輪');
      run.controller.switchTo('read-only');
      const second = await runBackground(run.graph, '第二輪');
      expect(lastTool(first.messages)).toContain('Successfully wrote');
      // 委派時是 workspace-write，照快照應該寫得進去；實際被擋。
      expect(lastTool(second.messages)).toContain(REFUSED);
    } finally {
      await run.built.dispose();
    }
  });

  it('沒有任何包裝：root 之後放寬，委派在 read-only 的子代理被叫醒時反而寫得進去（越權）', async () => {
    const run = await fenced('read-only', TWO_TURNS);
    try {
      const first = await runBackground(run.graph, '第一輪');
      run.controller.switchTo('workspace-write');
      const second = await runBackground(run.graph, '第二輪');
      expect(lastTool(first.messages)).toContain(REFUSED);
      expect(lastTool(second.messages)).toContain('Successfully wrote');
    } finally {
      await run.built.dispose();
    }
  });

  it('叫醒那刻再 `controller.delegate` 一次也救不了：它拍的是叫醒那刻的 root，一樣放寬', async () => {
    const run = await fenced('read-only', TWO_TURNS);
    try {
      const first = await run.controller.delegate(() => runBackground(run.graph, '第一輪'));
      run.controller.switchTo('workspace-write');
      const second = await run.controller.delegate(() => runBackground(run.graph, '第二輪'));
      expect(lastTool(first.messages)).toContain(REFUSED);
      expect(lastTool(second.messages)).toContain('Successfully wrote');
    } finally {
      await run.built.dispose();
    }
  });

  it('第一輪不 await、派出去之後 root 立刻切：ALS 快照撐得過分離的 promise，仍是委派那一格', async () => {
    const run = await fenced('workspace-write', [write('/a.txt'), { content: '一' }]);
    try {
      const detached = run.controller.delegate(() => runBackground(run.graph, '第一輪'));
      run.controller.switchTo('read-only');
      expect(lastTool((await detached).messages)).toContain('Successfully wrote');
    } finally {
      await run.built.dispose();
    }
  });

  it('退路：每一輪用記下的那一格重新進 ALS，兩個方向都守得住委派那一格', async () => {
    // root 收緊：委派時 workspace-write，叫醒時 root 已是 read-only，記下的那一格讓它照寫。
    const tighten = await fenced(
      'workspace-write',
      TWO_TURNS,
      new PinnedController('workspace-write'),
    );
    try {
      const pinned = tighten.controller as PinnedController;
      const first = await pinned.runPinned('workspace-write', () =>
        runBackground(tighten.graph, '第一輪'),
      );
      tighten.controller.switchTo('read-only');
      const second = await pinned.runPinned('workspace-write', () =>
        runBackground(tighten.graph, '第二輪'),
      );
      expect(lastTool(first.messages)).toContain('Successfully wrote');
      expect(lastTool(second.messages)).toContain('Successfully wrote');
    } finally {
      await tighten.built.dispose();
    }

    // root 放寬：委派時 read-only，叫醒時 root 已放寬，記下的那一格仍擋住它。
    const loosen = await fenced(
      'read-only',
      twoTurns('/c.txt', '/d.txt'),
      new PinnedController('read-only'),
    );
    try {
      const pinned = loosen.controller as PinnedController;
      const first = await pinned.runPinned('read-only', () =>
        runBackground(loosen.graph, '第一輪'),
      );
      loosen.controller.switchTo('workspace-write');
      const second = await pinned.runPinned('read-only', () =>
        runBackground(loosen.graph, '第二輪'),
      );
      expect(lastTool(first.messages)).toContain(REFUSED);
      expect(lastTool(second.messages)).toContain(REFUSED);
    } finally {
      await loosen.built.dispose();
    }
  });
  it('退路的缺口：只換 `current` 的話，root 那顆待消費的 grant 與委派標記在背景那一輪看得到；`delegate` 則看不到', async () => {
    const controller = new PinnedController('read-only');
    controller.grant({ mode: 'workspace-write', target: '/a.txt', denied: undefined });

    // 重新進 ALS 只蓋住 `current`：一次性 grant 一律不給子代理，這裡卻認領得到；子代理日誌開啟時讀的
    // `delegatedMode` 也是空的。所以實作要的入口是 `delegate(capturedMode, run)`，重新進控制器自己那份 ALS。
    const pinned = controller.runPinned('read-only', () => ({
      grant: controller.peekGrant(),
      delegatedMode: controller.delegatedMode,
    }));
    expect(pinned.grant).toBeDefined();
    expect(pinned.delegatedMode).toBeUndefined();

    const delegated = controller.delegate(() => ({
      grant: controller.peekGrant(),
      delegatedMode: controller.delegatedMode,
    }));
    expect(delegated.grant).toBeUndefined();
    expect(delegated.delegatedMode).toBe('read-only');
  });
});

// ─────────────── 第 1、4、5 項：背景那一輪由 root 的工具拉起 ───────────────

/**
 * 兩種拉起法，差在**背景那一輪的非同步環境是誰的**：
 * - `inherit`：在工具本體裡排 `setTimeout` 再 `graph.invoke`。AsyncLocalStorage 帶著工具呼叫當下的環境走，
 *   LangGraph／LangChain 的 config 也是靠它隱式繼承的——這是「工具本體裡 `void graph.invoke()`」最自然的寫法。
 * - `loop`：由一個在任何圖的環境**之外**建好的長壽迴圈取件、執行，dsh 收件匣模型的形狀。
 */
type LaunchMode = 'inherit' | 'loop';

interface Background {
  mode: LaunchMode;
  /** 由測試在組裝完成後設。參數是這一輪的人話。 */
  run: ((text: string) => Promise<unknown>) | undefined;
  /** 每一次拉起的結果，依序。 */
  done: Promise<{ ok: true } | { ok: false; error: string }>[];
  /** 背景圖裡探測工具每次被叫時看到的 `configurable`。 */
  seen: Record<string, unknown>[];
  /** `loop` 模式的件。 */
  queue: (() => void)[];
  /** 給了就等它 resolve 才開始跑背景那一輪——讓腳本的模型輪次照預期的順序被吃掉。 */
  after?: Promise<void>;
  /** root 與背景各自停在 `hold`／`hold_bg` 那顆工具裡，測試手動放行。 */
  root: ReturnType<typeof gate>;
  rootRelease: ReturnType<typeof gate>;
  bg: ReturnType<typeof gate>;
  bgRelease: ReturnType<typeof gate>;
  /** 拉起背景圖時額外放進 configurable 的東西。 */
  extra: Record<string, unknown>;
}

function backgroundPlugin(bg: Background): PluginEntry {
  const launch = (text: string) => {
    const start = () =>
      bg.done.push(
        (bg.after ?? Promise.resolve())
          .then(() => bg.run!(text))
          .then(
            () => ({ ok: true }) as const,
            (error: unknown) => ({ ok: false, error: String(error) }) as const,
          ),
      );
    if (bg.mode === 'inherit') setTimeout(start, 30);
    else bg.queue.push(start);
  };
  return {
    plugin: {
      name: 'background-host',
      apply(registry) {
        for (const name of ['spawn_bg', 'send_bg']) {
          registry.tools.register(
            tool(
              ({ text }: { text: string }) => {
                launch(text);
                return 'bg-1';
              },
              {
                name,
                description: '把一輪交給背景子代理。',
                schema: z.object({ text: z.string() }),
              },
            ),
          );
        }
        registry.tools.register(
          tool(
            async () => {
              bg.root.open();
              await bg.rootRelease.opened;
              return '根放行';
            },
            { name: 'hold', description: '停在這裡等放行。', schema: z.object({}) },
          ),
        );
        registry.subagents.register({
          name: 'probe-worker',
          description: '探測用。',
          systemPrompt: '探測。',
          tools: [
            tool(
              async () => {
                bg.bg.open();
                await bg.bgRelease.opened;
                return '背景放行';
              },
              { name: 'hold_bg', description: '停在這裡等放行。', schema: z.object({}) },
            ),
            tool(
              () => {
                throw new Error('背景工具炸了');
              },
              { name: 'boom_bg', description: '一定拋錯。', schema: z.object({}) },
            ),
            tool(
              (
                _input: Record<string, never>,
                config: { configurable?: Record<string, unknown> },
              ) => {
                bg.seen.push({ ...config.configurable });
                return '看過了';
              },
              { name: 'look', description: '記下 configurable。', schema: z.object({}) },
            ),
          ],
        });
      },
    },
  };
}

describe('背景那一輪由 root 的工具拉起（第 1、4、5 項的實況）', () => {
  const timers: ReturnType<typeof setInterval>[] = [];
  afterEach(() => {
    for (const timer of timers.splice(0)) clearInterval(timer);
  });

  /** 迴圈要在任何圖的環境**之外**建：計時器回呼帶的是建它那一刻的環境。 */
  async function scenario(
    mode: LaunchMode,
    turns: readonly ScriptedTurn[],
    extra: Record<string, unknown> = {},
  ) {
    const bg: Background = {
      mode,
      run: undefined,
      done: [],
      seen: [],
      queue: [],
      root: gate(),
      rootRelease: gate(),
      bg: gate(),
      bgRelease: gate(),
      extra,
    };
    timers.push(setInterval(() => bg.queue.shift()?.(), 5));
    const run = await assembleWithPump(turns, [backgroundPlugin(bg)]);
    const graph = compileBackground(run.spec('probe-worker'), run.params);
    bg.run = (text) => runBackground(graph, text, 'bg-1', bg.extra);
    return { ...run, bg };
  }
  type Scenario = Awaited<ReturnType<typeof scenario>>;

  /** root 送一句話、跑到收尾，並等第 `launched` 次拉起的背景那一輪也結束。 */
  async function rootTurn(run: Scenario, text: string, launched: number) {
    await run.pump.submit({ kind: 'message', text });
    await run.pump.whenIdle();
    await until(() => run.bg.done.length >= launched);
    return run.bg.done[launched - 1];
  }

  /** 兩輪都由 root 的工具拉起的腳本：spawn 一輪、send 一輪，背景每輪叫一次 `look`。 */
  const TWO_LAUNCHES = [
    say('spawn_bg', '第一輪的話'),
    { content: '根收尾' },
    call('look', {}),
    { content: '背景一號' },
    say('send_bg', '第二輪的話'),
    { content: '根收尾二' },
    call('look', {}),
    { content: '背景二號' },
  ] as const;

  /** 背景那幾次模型呼叫看到的人話（背景的第一句都是「…的話」）。 */
  const backgroundPrompts = (run: Scenario) =>
    run.model.prompts
      .filter((prompt) => humanTexts(prompt).some((text) => text.endsWith('的話')))
      .map(humanTexts);

  it('inherit：背景圖繼承 root 的中止訊號與命名空間；第二輪由另一個工具呼叫拉起，看不到第一輪', async () => {
    const run = await scenario('inherit', TWO_LAUNCHES);
    try {
      expect(await rootTurn(run, '派', 1)).toEqual({ ok: true });
      expect(await rootTurn(run, '再送', 2)).toEqual({ ok: true });
      const [first, second] = run.bg.seen;

      // 4：root 的中止訊號跟著進了背景圖（`configurable` 的隱式繼承）。
      expect(first?.[TURN_CANCEL_CONFIG_KEY]).toBeInstanceOf(AbortSignal);
      // 5：命名空間是「拉起它的那一次工具呼叫」的，兩段——被認成某個子代理，runId 是那次呼叫的命名空間。
      const addresses = [first, second].map((seen) =>
        toolCallSessionAddress({ configurable: seen }),
      );
      expect(addresses.map((address) => address?.kind)).toEqual(['subagent', 'subagent']);
      const runIds = addresses.map((address) =>
        address?.kind === 'subagent' ? address.runId : undefined,
      );
      // 同一個背景子代理，兩輪的身分不同——身分綁在拉起它的那一次呼叫上。
      expect(runIds[0]).not.toBe(runIds[1]);
      // 1：命名空間不同，存檔點就對不上，第二輪沒有第一輪的對話。
      expect(backgroundPrompts(run).at(-1)).toEqual(['第二輪的話']);
    } finally {
      await run.close();
    }
  });

  it('loop：迴圈在圖的環境之外取件，configurable 乾淨、第二輪看得到第一輪；但位址被認成 root', async () => {
    const run = await scenario('loop', TWO_LAUNCHES);
    try {
      expect(await rootTurn(run, '派', 1)).toEqual({ ok: true });
      expect(await rootTurn(run, '再送', 2)).toEqual({ ok: true });
      const [first, second] = run.bg.seen;

      // 4：root 的中止訊號沒有進來。
      expect(first?.[TURN_CANCEL_CONFIG_KEY]).toBeUndefined();
      // 1：第二輪看得到第一輪。
      expect(backgroundPrompts(run).at(-1)).toEqual(['第一輪的話', '第二輪的話']);
      // 5：最上層的圖，命名空間只有一段，`toolCallSessionAddress` 認成 root。
      expect(
        [first, second].map((seen) => toolCallSessionAddress({ configurable: seen })?.kind),
      ).toEqual(['root', 'root']);
      // 後果：背景那幾輪的工具呼叫寫進 root 的日誌，沒有自己的會話——靜默合流。
      const sessions = run.pump.sessions.list();
      expect(sessions.map((session) => session.address.kind)).toEqual(['root']);
      const rootResults =
        sessions[0]?.log.events.filter((event) => event.type === 'tool/result') ?? [];
      expect(rootResults.length).toBeGreaterThanOrEqual(4); // root 的 spawn、send，加背景的兩顆 look。
    } finally {
      await run.close();
    }
  });

  it('loop：自訂 checkpoint_ns 被最上層的圖無視，位址推不出來；自訂的 configurable 鍵倒是原樣送到工具', async () => {
    const run = await scenario('loop', TWO_LAUNCHES, {
      checkpoint_ns: 'bg-1',
      nexus_background_session: 'bg-1',
    });
    try {
      await rootTurn(run, '派', 1);
      const [seen] = run.bg.seen;
      // 想靠傳 `checkpoint_ns` 給背景圖一個穩定的命名空間：不行，最上層的圖自己重寫它。
      expect(seen?.checkpoint_ns).not.toBe('bg-1');
      expect(toolCallSessionAddress({ configurable: seen })?.kind).toBe('root');
      // 顯式的鍵可以：身分要改成讀這種鍵，不能繼續只讀 `checkpoint_ns`（卡上第 5 項）。
      expect(seen?.nexus_background_session).toBe('bg-1');
    } finally {
      await run.close();
    }
  });

  for (const mode of ['inherit', 'loop'] as const) {
    it(`${mode}：root 按停止之後背景那一輪的下場`, async () => {
      // 背景的兩輪在 root 停住的時候先被吃掉，所以排在 root 收尾之前。
      const run = await scenario(mode, [
        say('spawn_bg', '背景的活'),
        call('hold', {}),
        call('hold_bg', {}),
        { content: '背景完成' },
        { content: '根收尾' },
      ]);
      try {
        run.bg.after = run.bg.root.opened;
        const submitted = run.pump.submit({ kind: 'message', text: '派' });
        await run.bg.root.opened;
        await run.bg.bg.opened;
        const before = run.model.prompts.length;
        expect(run.pump.cancel()).toBe('run');
        run.bg.bgRelease.open();
        await settle();
        run.bg.rootRelease.open();
        await submitted;
        await run.pump.whenIdle();
        expect(await run.bg.done[0]).toEqual({ ok: true });

        const bgCalledAgain = run.model.prompts
          .slice(before)
          .some((prompt) => toolTexts(prompt).includes('背景放行'));
        if (mode === 'inherit') {
          // root 的停止順著繼承傳進背景圖：背景那一輪被截掉，且**沒有任何錯誤**——promise 照樣成功。
          expect(bgCalledAgain).toBe(false);
        } else {
          // 沒繼承訊號：背景那一輪在 root 停止之後照樣跑完。
          expect(bgCalledAgain).toBe(true);
        }
        expect(unhandled.map(String)).toEqual([]);
      } finally {
        await run.close();
      }
    });

    for (const [label, bgTurns] of [
      ['模型呼叫拋錯', [{ content: '', error: OVERLOADED }]],
      ['工具本體拋錯', [call('boom_bg', {}), { content: '背景收到錯誤了' }]],
    ] as const) {
      it(`${mode}：root 還在跑的時候背景${label}——行程不死，root 那一輪照收尾`, async () => {
        const run = await scenario(mode, [
          say('spawn_bg', '背景的活'),
          call('hold', {}),
          ...bgTurns,
          { content: '根收尾' },
        ]);
        try {
          run.bg.after = run.bg.root.opened;
          const submitted = run.pump.submit({ kind: 'message', text: '派' });
          await run.bg.root.opened;
          await until(() => run.bg.done.length >= 1);
          const outcome = await run.bg.done[0];
          await settle();
          run.bg.rootRelease.open();
          await submitted;
          await run.pump.whenIdle();
          await settle();

          // 模型拋錯落在呼叫方的 promise 上（被我們接住）；工具本體拋錯被圍堵成回饋，整輪不死。
          expect(outcome).toEqual(
            label === '模型呼叫拋錯' ? { ok: false, error: `Error: ${OVERLOADED}` } : { ok: true },
          );
          const root = run.pump.sessions.list().find((session) => session.address.kind === 'root');
          expect(root?.log.events.at(-1)?.type).toBe('turn/end');
          expect(unhandled.map(String)).toEqual([]);
        } finally {
          await run.close();
        }
      });

      it(`${mode}：root 收掉之後背景才${label}——行程不死`, async () => {
        const run = await scenario(mode, [
          say('spawn_bg', '背景的活'),
          { content: '根收尾' },
          ...bgTurns,
        ]);
        try {
          const outcome = await rootTurn(run, '派', 1);
          await settle();
          expect(outcome).toEqual(
            label === '模型呼叫拋錯' ? { ok: false, error: `Error: ${OVERLOADED}` } : { ok: true },
          );
          expect(unhandled.map(String)).toEqual([]);
        } finally {
          await run.close();
        }
      });
    }
  }
});

/**
 * 第 4 項後半要走 pump 那條產品路徑量：`streamEvents` v3 會替每次工具呼叫建一顆沒人 await 的 `output` promise，
 * 工具本體一拋錯它就 reject（#346）。上面 `invoke` 的那幾條碰不到這一層，所以 `unhandled: []` 不算證據。
 */
describe('第 4 項：背景那一輪走 v3 串流時的孤兒 rejection', () => {
  const BOOM_BG: PluginEntry = {
    plugin: {
      name: 'boom-bg-host',
      apply(registry) {
        registry.subagents.register({
          name: 'worker',
          description: '幹活的。',
          systemPrompt: '幹活。',
          tools: [
            tool(
              () => {
                throw new Error(OVERLOADED);
              },
              { name: 'boom_bg', description: '一律拋錯。', schema: z.object({}) },
            ),
          ],
        });
      },
    },
  };

  it('對照組（子行程）：背景圖直接走 v3 `streamEvents`，工具本體拋錯會讓行程以未處理的 rejection 結束——圍堵救不了', async () => {
    const fixture = fileURLToPath(
      new URL('./subagent-background-orphan.fixture.ts', import.meta.url),
    );
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    const outcome = await promisify(execFile)(process.execPath, ['--import', 'tsx', fixture], {
      cwd,
    }).then(
      () => ({ exited: 0, stderr: '' }),
      (error: { code?: number; stderr?: string }) => ({
        exited: error.code ?? -1,
        stderr: error.stderr ?? '',
      }),
    );
    expect(outcome.exited).not.toBe(0);
    // 釘住是**那一顆**，不是子行程別的原因起不來。
    expect(outcome.stderr).toContain(OVERLOADED);
    expect(outcome.stderr).toContain('transformers/tool-call');
  }, 30_000);

  /**
   * 背景圖包一顆自己的 `ThreadPump`：pump 替它寫輪次（`turn/start`、`turn/end`、`turn/failed`），也替 v3 投影掛 catch。
   * 但模型與工具的事件是圍堵與記錄器經 `registry.sessions.forCall` 寫的，它只認**組裝點綁著的那一張**會話註冊表：
   * - 背景 pump 沒接上組裝：事件寫進 root 的日誌（位址被認成 root），背景 pump 自己的日誌只有輪次。
   * - 兩張都接上：`forCall` 回 `ambiguous`，事件**兩邊都沒有**——輪照跑、沒有任何錯誤，只是背景那一輪沒有日誌。
   */
  for (const attached of [false, true]) {
    for (const [label, turns, expectedEnd] of [
      ['工具本體拋錯', [call('boom_bg', {}), { content: '背景收到錯誤了' }], 'turn/end'],
      ['模型呼叫拋錯', [{ content: '', error: OVERLOADED }], 'turn/failed'],
    ] as const) {
      it(`產品形狀：背景圖包一顆自己的 ThreadPump，${label}不漏 rejection（背景 pump ${attached ? '也接上組裝' : '沒接上組裝'}）`, async () => {
        const run = await assembleWithPump(turns, [BOOM_BG]);
        const bgPump = new ThreadPump(
          compileBackground(run.spec('worker'), run.params) as unknown as PumpAgent,
          'bg-pump',
        );
        const detachBg = attached ? run.built.attachSession(bgPump.sessions) : undefined;
        const count = (registry: typeof bgPump.sessions, type: string) =>
          registry.root.events.filter((event) => event.type === type).length;
        const rootBefore = count(run.pump.sessions, 'model/start');
        try {
          await bgPump.submit({ kind: 'message', text: '背景的活' }).catch(() => undefined);
          await bgPump.whenIdle();
          await settle();
          expect(unhandled.map(String)).toEqual([]);

          // 輪次在背景 pump 自己的日誌裡。
          expect(bgPump.sessions.root.events.map((event) => event.type)).toContain(expectedEnd);
          // 事件歸誰：沒接上就進 root 的日誌；兩張都接上就哪裡都沒有。
          const rootGained = count(run.pump.sessions, 'model/start') - rootBefore;
          // 工具那條有兩次模型呼叫（叫工具、收尾），模型拋錯那條只有一次。
          expect(rootGained).toBe(attached ? 0 : label === '工具本體拋錯' ? 2 : 1);
          expect(count(bgPump.sessions, 'model/start')).toBe(0);
          if (label === '工具本體拋錯') {
            expect(count(run.pump.sessions, 'tool/call')).toBe(attached ? 0 : 1);
            expect(count(bgPump.sessions, 'tool/call')).toBe(0);
          }
        } finally {
          detachBg?.();
          await run.close();
        }
      });
    }
  }
});
