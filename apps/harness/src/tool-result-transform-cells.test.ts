/**
 * 改寫工具結果的三顆（輸出 schema 校驗、共用區前綴、子代理撞到輸出上限）在兩個 loop 上的可觀察輸出：每次模型呼叫送出去的訊息、
 * 模型拿到的工具清單、每份會話日誌的落盤位元組，加上 root 那幾則工具訊息的 `name`、`response_metadata`、`id`、
 * `additional_kwargs`。兩個 loop 各跑一次，跟對照組（`tool-result-transform-cells.baseline.json`）逐字比。
 * 重錄：`TOOL_RESULT_TRANSFORM_RECORD=1`。
 *
 * 另一格在真組裝上列出每次登記帶不帶輸出 schema（`registry.tools.register` 收到的 `outputSchema`），含 MCP 連上後的動態登記。
 *
 * **零憑證、零外部連線**：模型是腳本，MCP 對手方是本機的 stdio fixture server。
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { AIMessageChunk, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatGenerationChunk, ChatResult } from '@langchain/core/outputs';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { convertMessagesToCompletionsMessageParams } from '@langchain/openai';
import { MemorySaver } from '@langchain/langgraph';
import { SessionRegistry } from '@nexus/core';
import type { AgentLoopKind, PluginEntry, SessionLog } from '@nexus/core';
import { GOALS_SERVICE } from '@nexus/goal';
import { toLangChainTool } from '@nexus/tool-adapter';
import type { NexusTool } from '@nexus/tools';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { createCliAgent } from './assembly-root.js';
import { createCordisRoot } from './cordis-root.js';
import { shippedPlugins, withScriptedModel } from './fixtures.js';
import type { GoalDriverPort } from './goal-driver.js';
import { createGoalPlugin, goalCoreOf } from './goal.fixture.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { toAgentInvocation } from './messages.js';
import { loadDefaultPlugins } from './plugin-config.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedModelState, ScriptedToolCall, ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

/**
 * 外溢存檔的檔名帶 `randomBytes(6)`（`tool-result-stash.ts`），token 數跟著那段十六進位變。換成每格從 0 起算的序列：
 * 每次呼叫仍不相同，同一格每次跑都一樣。
 */
const bytes = vi.hoisted(() => ({ count: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  return {
    ...crypto,
    randomBytes: (size: number) => {
      bytes.count += 1;
      return crypto.createHash('sha256').update(String(bytes.count)).digest().subarray(0, size);
    },
  };
});

const BASELINE = new URL('./tool-result-transform-cells.baseline.json', import.meta.url);
const LOOPS: readonly AgentLoopKind[] = ['langgraph', 'native'];

const shipped = await shippedPlugins();

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const call = (name: string, args: Record<string, unknown>, id: string): ScriptedTurn => ({
  content: '',
  toolCalls: [{ name, args, id } satisfies ScriptedToolCall],
});

/** 宣告 `{ ok: boolean }` 的那幾顆工具共用的 schema。 */
const OK_SCHEMA = z.object({ ok: z.boolean() });

/** 校驗器自己拋。 */
const THROWING_SCHEMA = z.unknown().superRefine(() => {
  throw new Error('校驗器壞了');
});

const NO_PARAMETERS = z.toJSONSchema(z.object({}), { io: 'input' }) as NexusTool['parameters'];

/** 一顆回 `content` 的 `NexusTool`；`defer` 給了就在回之前補一則訊息，adapter 因而回 `Command`。 */
function fixtureTool(name: string, content: string, defer?: string): NexusTool {
  return {
    name,
    description: `測試工具 ${name}。`,
    parameters: NO_PARAMETERS,
    execute: (_args, exec) => {
      if (defer !== undefined) exec.deferContext(defer);
      return Promise.resolve({ ok: true, content });
    },
  };
}

/** 掛上宣告了輸出 schema 的測試工具。 */
const schemaTools: PluginEntry = {
  plugin: {
    name: 'fx-schema-tools',
    apply(registry) {
      const register = (tool: NexusTool, outputSchema: z.ZodType) =>
        registry.tools.register(toLangChainTool(tool), { outputSchema });
      register(fixtureTool('fx_ok', '{"ok":true}'), OK_SCHEMA);
      register(fixtureTool('fx_bad', '{"ok":"yes"}'), OK_SCHEMA);
      register(fixtureTool('fx_not_json', '好了'), OK_SCHEMA);
      register(fixtureTool('fx_cmd_ok', '{"ok":true}', '補充：照做。'), OK_SCHEMA);
      register(fixtureTool('fx_cmd_bad', '{"ok":1}', '補充：照做。'), OK_SCHEMA);
      register(fixtureTool('fx_throws', '{"ok":true}'), THROWING_SCHEMA);
    },
  },
};

/**
 * 子代理的模型：回覆一律標上 `finish_reason: 'length'`，其餘同 {@link ScriptedChatModel}。`bindTools` 的副本也是這一種，
 * 與本體共用腳本進度。
 */
class CutOffModel extends ScriptedChatModel {
  readonly #turns: readonly ScriptedTurn[];
  readonly #state: ScriptedModelState;

  constructor(turns: readonly ScriptedTurn[], state?: ScriptedModelState) {
    const shared = state ?? { turn: 0, boundToolNames: [], lastPrompt: [], prompts: [] };
    super({ turns, shared });
    this.#turns = turns;
    this.#state = shared;
  }

  override bindTools(tools: readonly unknown[]): CutOffModel {
    super.bindTools(tools);
    return new CutOffModel(this.#turns, this.#state);
  }

  override async _generate(
    messages: BaseMessage[],
    options?: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    const result = await super._generate(messages, options);
    for (const generation of result.generations) {
      generation.message.response_metadata = {
        ...generation.message.response_metadata,
        finish_reason: 'length',
      };
    }
    return result;
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    yield* super._streamResponseChunks(messages, options, runManager);
    yield {
      text: '',
      message: new AIMessageChunk({ content: '', response_metadata: { finish_reason: 'length' } }),
    } as ChatGenerationChunk;
  }
}

/** 前景委派的對象；`cut` 時它的回覆撞到輸出上限。 */
function workerEntry(cut: boolean): PluginEntry {
  const turns: readonly ScriptedTurn[] = [{ content: '報告寫到一半' }];
  return {
    plugin: {
      name: 'fx-worker',
      apply(registry) {
        registry.subagents.register({
          name: 'worker',
          description: '幹活的。',
          systemPrompt: '你是 worker。',
          model: cut ? new CutOffModel(turns) : new ScriptedChatModel({ turns }),
        });
      },
    },
  };
}

/** 1×1 的 PNG。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

interface Case {
  readonly turns: readonly ScriptedTurn[];
  readonly extra?: readonly PluginEntry[];
  /** 有共用區的新 thread 形狀（私有根加掛在 `/shared` 的工作區）。 */
  readonly shared?: true;
  /** 外溢存檔的根（`toolResultStash`）。 */
  readonly stash?: true;
  /** 跑之前在共用區裡多寫的檔。 */
  readonly seed?: (shared: string) => Promise<void>;
  /** 走 {@link runGoal}：`turns` 之外的欄位不看。 */
  readonly goal?: true;
}

/** 人講一句 → 模型建目標 → 續行那一輪 `update_goal(complete)`，goal 補收尾指示，adapter 回 `Command` → 收工。 */
const GOAL_TURNS: readonly ScriptedTurn[] = [
  call('create_goal', { objective: '把 CI 修綠', max_goal_rounds: 2 }, 'c1'),
  { content: '建好了。' },
  call('update_goal', { goal_id: 'goal-1', revision: 1, action: 'complete' }, 'c2'),
  { content: '做完了。' },
];

const cases: readonly (readonly [string, Case])[] = [
  ['goal：自主收尾（Command 合）', { goal: true, turns: GOAL_TURNS }],
  ['schema：合', { turns: [call('fx_ok', {}, 'c1')], extra: [schemaTools] }],
  ['schema：不合', { turns: [call('fx_bad', {}, 'c1')], extra: [schemaTools] }],
  ['schema：不是 JSON', { turns: [call('fx_not_json', {}, 'c1')], extra: [schemaTools] }],
  ['schema：Command 合', { turns: [call('fx_cmd_ok', {}, 'c1')], extra: [schemaTools] }],
  ['schema：Command 不合', { turns: [call('fx_cmd_bad', {}, 'c1')], extra: [schemaTools] }],
  ['schema：校驗器拋', { turns: [call('fx_throws', {}, 'c1')], extra: [schemaTools] }],
  [
    '共用區：read_file 文字',
    { shared: true, turns: [call('read_file', { file_path: '/shared/ref.md' }, 'c1')] },
  ],
  [
    '共用區：read_file 二進位檔（錯誤，不標）',
    { shared: true, turns: [call('read_file', { file_path: '/shared/dot.png' }, 'c1')] },
  ],
  [
    '共用區：grep content',
    { shared: true, turns: [call('grep', { pattern: 'deployer', path: '/shared' }, 'c1')] },
  ],
  [
    '共用區：grep 超過搜尋上限',
    {
      shared: true,
      stash: true,
      seed: async (shared) => {
        const many = Array.from({ length: 300 }, (_, index) => `deployer-${index}`).join('\n');
        await writeFile(join(shared, 'many.md'), `${many}\n`, 'utf8');
      },
      turns: [call('grep', { pattern: 'deployer-', path: '/shared' }, 'c1')],
    },
  ],
  [
    '私有根：read_file（不標）',
    { shared: true, turns: [call('read_file', { file_path: '/own.md' }, 'c1')] },
  ],
  [
    '私有根：grep（不標）',
    { shared: true, turns: [call('grep', { pattern: 'private', path: '/own.md' }, 'c1')] },
  ],
  [
    '子代理：撞到輸出上限',
    {
      turns: [call('task', { description: '寫報告', subagent_type: 'worker' }, 'c1')],
      extra: [workerEntry(true)],
    },
  ],
  [
    '子代理：正常收',
    {
      turns: [call('task', { description: '寫報告', subagent_type: 'worker' }, 'c1')],
      extra: [workerEntry(false)],
    },
  ],
];

/** 每次 `bindTools` 拿到的清單，依呼叫順序。 */
const binds: (readonly unknown[])[] = [];
const originalBind = ScriptedChatModel.prototype.bindTools;
ScriptedChatModel.prototype.bindTools = function (this: ScriptedChatModel, tools) {
  binds.push(tools);
  return originalBind.call(this, tools);
};

/** 一則工具訊息上，不送給模型、但會往下傳的欄位也一起記。 */
function toolMessageFields(message: ToolMessage): unknown {
  return {
    tool_call_id: message.tool_call_id,
    name: message.name ?? null,
    status: message.status ?? null,
    id: message.id ?? null,
    artifact: message.artifact === undefined ? null : JSON.stringify(message.artifact),
    additional_kwargs: message.additional_kwargs,
    response_metadata: message.response_metadata,
  };
}

/** 等排程器把續行那一串排完。同 `wrapup-batch-order.test.ts`。 */
async function settle(pump: ThreadPump): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    await pump.whenIdle();
    await new Promise((resolve) => setImmediate(resolve));
    if (!pump.running) {
      await pump.whenIdle();
      await new Promise((resolve) => setImmediate(resolve));
      if (!pump.running) return;
    }
  }
}

/** 一份會話登記處的每份日誌落盤位元組（`jsonl-session-store.ts` 一筆一行 `JSON.stringify(event)`）。 */
function logBytes(sessions: SessionRegistry): unknown[] {
  return sessions.list().map((entry) => ({
    address: JSON.stringify(entry.address),
    bytes: entry.log.events.map((event) => `${JSON.stringify(event)}\n`).join(''),
  }));
}

/** 每次模型呼叫送給供應商的訊息（Chat Completions 形狀）。 */
function requestsOf(model: ScriptedChatModel): string[] {
  return model.prompts.map((prompt) =>
    JSON.stringify(
      convertMessagesToCompletionsMessageParams({ messages: [...prompt], model: 'm' }),
    ),
  );
}

/** 每次 `bindTools` 拿到的清單（逐支工具的 OpenAI 形狀，照順序）。 */
function boundLists(): unknown[] {
  return binds.map((tools) =>
    (tools as StructuredToolInterface[]).map((tool) => convertToOpenAITool(tool)),
  );
}

/**
 * goal 的自主收尾要續行輪才走得到（`authority.kind === 'goal-round'`），所以走 pump 與續行旗標，同 `wrapup-batch-order.test.ts`。
 * 工具訊息取自最後一次模型呼叫的 prompt。
 */
async function runGoal(
  loop: AgentLoopKind,
): Promise<{ readonly dirs: readonly string[]; readonly result: unknown }> {
  let serial = 0;
  const plugin = createGoalPlugin({ now: () => 100, newGoalId: () => `goal-${(serial += 1)}` });
  const model = new ScriptedChatModel({ turns: GOAL_TURNS });
  binds.length = 0;
  bytes.count = 0;
  const { agent, dispose, attachSession, services } = await createNexusAgent({
    model: model as never,
    plugins: [plugin],
    checkpointer: new MemorySaver(),
    agentLoop: loop,
  });
  // 同 `wire-handler.ts`：port 要日誌，而日誌由 pump 建，而 pump 的建構參數是 port。
  const late: { log?: SessionLog } = {};
  const goals = goalCoreOf(services.use(GOALS_SERVICE));
  const port: GoalDriverPort = {
    goal: () => goals.serviceFor(late.log as SessionLog)?.get(),
    block: (ref, reason) => void goals.serviceFor(late.log as SessionLog)?.block(ref, reason),
    disarm: () => void goals.serviceFor(late.log as SessionLog)?.disarm(),
    pause: (ref) => void goals.serviceFor(late.log as SessionLog)?.pause(ref),
    flush: () => Promise.resolve(),
    warn: () => {},
  };
  const pump = new ThreadPump(agent as unknown as PumpAgent, 'trx-goal', port);
  late.log = pump.sessionLog;
  const detach = attachSession(pump.sessions);
  const errors: string[] = [];
  try {
    await pump.submit({ kind: 'message', text: '把 CI 修綠' });
    await settle(pump);
  } catch (error) {
    errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  } finally {
    detach();
    await dispose();
  }
  return {
    dirs: [],
    result: {
      errors,
      calls: model.prompts.length,
      binds: boundLists(),
      requests: requestsOf(model),
      toolMessages: (model.prompts.at(-1) ?? [])
        .filter((message): message is ToolMessage => ToolMessage.isInstance(message))
        .map(toolMessageFields),
      logs: logBytes(pump.sessions),
    },
  };
}

async function runOne(
  spec: Case,
  loop: AgentLoopKind,
): Promise<{ readonly dirs: readonly string[]; readonly result: unknown }> {
  const shared = tempDir('nexus-trx-shared-');
  const priv = tempDir('nexus-trx-priv-');
  const stash = tempDir('nexus-trx-stash-');
  await writeFile(join(shared, 'ref.md'), 'deployer-reference-line\n', 'utf8');
  await writeFile(join(shared, 'dot.png'), PNG);
  await writeFile(join(priv, 'own.md'), 'private-root-line\n', 'utf8');
  await spec.seed?.(shared);
  binds.length = 0;
  bytes.count = 0;
  const built = await createCliAgent(
    {
      live: false,
      agentLoop: loop,
      workspace: spec.shared === true ? shared : priv,
      ...(spec.shared === true && { workspaceRoot: priv, sharedWorkspaceRoot: shared }),
      sandbox: 'workspace-write',
      ...(spec.stash === true && { toolResultStash: { rootDir: stash, session: 'trx' } }),
    },
    [...withScriptedModel(shipped, [...spec.turns, { content: '收工。' }]), ...(spec.extra ?? [])],
    priv,
  );
  const sessions = new SessionRegistry('trx');
  const detach = built.attachSession(sessions);
  const errors: string[] = [];
  let toolMessages: unknown[] = [];
  try {
    const state = (await built.agent.invoke(toAgentInvocation('跑。'), {
      configurable: { thread_id: 'trx' },
    })) as { messages: BaseMessage[] };
    toolMessages = state.messages
      .filter((message): message is ToolMessage => ToolMessage.isInstance(message))
      .map(toolMessageFields);
  } catch (error) {
    errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  } finally {
    detach();
    await built.dispose();
  }
  const model = built.model as ScriptedChatModel;
  return {
    dirs: [shared, priv, stash],
    result: {
      errors,
      calls: model.prompts.length,
      binds: boundLists(),
      requests: requestsOf(model),
      toolMessages,
      logs: logBytes(sessions),
    },
  };
}

/** 對照組：共用的工具清單表（鍵是清單內容的雜湊），與每一格。 */
interface Baseline {
  readonly toolLists: Record<string, unknown>;
  readonly cases: Record<string, unknown>;
}

/** 每次跑都不同的值：暫存目錄、epoch 毫秒、uuid、帶時區偏移的取樣時刻。字串裡的 JSON 也照樣換。 */
function normalized(value: unknown, dirs: readonly string[]): unknown {
  let text = JSON.stringify(value);
  for (const [index, dir] of dirs.entries()) text = text.split(dir).join(`<dir${index}>`);
  text = text
    .replace(/(?<![\d.])1[7-9]\d{11}(?![\d.])/gu, '<epoch>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, '<uuid>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}(\[[^\]]*\])?/gu, '<now>');
  return JSON.parse(text) as unknown;
}

it(
  '三顆改寫工具結果的格在兩個 loop 上的請求、工具清單、工具訊息欄位與落盤位元組，與對照組逐字相同',
  { timeout: 600_000 },
  async () => {
    // time context 那則訊息帶行程時區的名字，token 數在換成 <now> 之前就從原文算好了：固定時區，對照組才在任何主機上都對得上。
    const tz = process.env.TZ;
    process.env.TZ = 'Asia/Taipei';
    cleanups.push(() => {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    });
    const only = process.env.TOOL_RESULT_TRANSFORM_ONLY;
    const now: Baseline = { toolLists: {}, cases: {} };
    for (const [label, spec] of cases) {
      if (only !== undefined && !label.includes(only)) continue;
      for (const loop of LOOPS) {
        const { dirs, result } =
          spec.goal === true ? await runGoal(loop) : await runOne(spec, loop);
        // 各格的工具清單大多相同：收進共用的表，格裡換成鍵。
        const { binds: lists, ...rest } = normalized(result, dirs) as {
          readonly binds: readonly unknown[];
        };
        now.cases[`${label}｜${loop}`] = {
          ...rest,
          binds: lists.map((list) => {
            const key = createHash('sha256')
              .update(JSON.stringify(list))
              .digest('hex')
              .slice(0, 12);
            now.toolLists[key] = list;
            return key;
          }),
        };
      }
    }
    if (process.env.TOOL_RESULT_TRANSFORM_RECORD === '1') {
      writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`);
      return;
    }
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline;
    if (only === undefined) expect(Object.keys(now.cases)).toEqual(Object.keys(baseline.cases));
    for (const key of Object.keys(now.cases)) {
      expect(now.cases[key], key).toEqual(baseline.cases[key]);
    }
    for (const key of Object.keys(now.toolLists)) {
      expect(now.toolLists[key], key).toEqual(baseline.toolLists[key]);
    }
  },
);

const MCP_SERVERS = {
  modern: fileURLToPath(
    new URL('../../../packages/nexus-plugin-mcp/src/modern-stdio-server.ts', import.meta.url),
  ),
  raw: fileURLToPath(new URL('./mcp-raw-schema.fixture-server.ts', import.meta.url)),
} as const;

/** 清單最前面一列：之後每次 `registry.tools.register` 記下名字與有沒有帶 `outputSchema`。 */
function registrationProbe(seen: Map<string, boolean>): PluginEntry {
  return {
    plugin: {
      name: 'zz-register-probe',
      apply(registry) {
        const register = registry.tools.register.bind(registry.tools);
        registry.tools.register = (tool, options) => {
          const name = (tool as { readonly name: string }).name;
          seen.set(name, (seen.get(name) ?? false) || options?.outputSchema !== undefined);
          return register(tool, options);
        };
      },
    },
  };
}

it(
  '出貨樹加兩台 MCP（伺服端有宣告 outputSchema 的工具）：帶輸出 schema 登記的只有 ask_user_question 與 goal 的三顆',
  { timeout: 300_000 },
  async () => {
    const home = tempDir('nexus-trx-mcp-');
    const row = (id: string, server: keyof typeof MCP_SERVERS) =>
      `    - id: ${id}\n      name: '@nexus/plugin-mcp'\n      config: ${JSON.stringify({
        serverName: id,
        approval: { default: 'allow' },
        connection: {
          transport: 'stdio',
          command: process.execPath,
          args: ['--import', 'tsx', MCP_SERVERS[server]],
        },
      })}\n`;
    const overlay = join(home, 'overlay.yml');
    writeFileSync(
      overlay,
      `- insert:\n${row('mcpmodern', 'modern')}${row('mcpraw', 'raw')}` +
        `- id: cli-script\n  config: ${JSON.stringify({ turns: [{ content: '收工。' }] })}\n`,
    );
    const root = createCordisRoot();
    cleanups.push(() => root.dispose());
    const loaded = await loadDefaultPlugins(
      { env: { [HARNESS_HOME_ENV]: home }, patches: [overlay], warn: () => {} },
      { tree: root.tree },
    );
    expect(loaded.dropped).toEqual([]);
    for (const loop of LOOPS) {
      const seen = new Map<string, boolean>();
      const built = await createCliAgent(
        { live: false, agentLoop: loop },
        [registrationProbe(seen), ...loaded.plugins],
        home,
      );
      const detach = built.attachSession(new SessionRegistry('trx-mcp'));
      try {
        await built.agent.invoke(toAgentInvocation('跑。'), {
          configurable: { thread_id: `trx-mcp-${loop}` },
        });
      } finally {
        detach();
        await built.dispose();
      }
      const withSchema = [...seen].filter(([, has]) => has).map(([name]) => name);
      const mcp = [...seen.keys()].filter((name) => name.startsWith('mcp'));
      expect(withSchema.sort(), loop).toEqual(
        ['ask_user_question', 'create_goal', 'get_goal', 'update_goal'].sort(),
      );
      // 對照：兩台 MCP 都連上並登記了工具（raw 的 `stats` 在伺服端宣告了 outputSchema），只是登記時都沒帶。
      expect(
        mcp.some((name) => name.includes('stats')),
        loop,
      ).toBe(true);
      expect(mcp.length, loop).toBeGreaterThan(1);
    }
  },
);
