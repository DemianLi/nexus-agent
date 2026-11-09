/**
 * plan-mode 那一列（[#2551](https://github.com/DemianLi/nexus-agent/issues/2551)）在三種組裝登記的四樣順序、六個情境的日誌與請求位元組、
 * 和 serve 多條 thread 時段落怎麼認呼叫者，與 `plan-mode-on-tree.baseline.json` 逐字相同。
 *
 * - **四樣順序**：middleware 名字、匯流排上每位監聽者、會話參與者的 origin、提示詞各段，加上命令清單、第一則請求、每次 `bindTools` 的
 *   工具名與每顆工具送給供應商的定義。
 *   三種組裝：CLI 出貨清單（`createCliAgent` ＋ `shippedPlugins()`，沒有樹）、CLI 的樹與 serve 的樹（`root.boot` ＋ `assembly.create`）；
 *   各自有工作區與沒有工作區，兩個 loop 各跑一次。
 * - **六個情境**（進出、同意、繼續規劃、關掉這一題、委派、沒有答題管道）：每份會話日誌的落盤位元組、送給模型的每一則請求、`/plan` 的
 *   結果、停下的中斷數與綁進模型的工具（名字與定義），出貨清單與樹各一次、兩個 loop 各一次。情境走 `invoke`，native 在這條路上沒人可問（呼叫上放的是
 *   `NO_HUMAN_INPUT`），所以 native 的三個審核情境錄到的是「沒有人可以回答」那條結局，照錄。
 * - **多條 thread**：serve 的樹上一次 boot 組兩條 thread，各接一張會話註冊表；在「只接了一條」「兩條都接」「一條進了計劃模式」
 *   「收掉一條」四個時點，拿六種呼叫身分各問一次兩條 thread 的段，記指引夾不夾。認不出呼叫者的那幾種走的是 `fallback()`。
 *
 * 比對鍵是位置；origin 換了名字的，只能是 {@link RENAMED} 明列的那幾條。每次跑都不同的值只在 {@link VOLATILE} 明列的欄位換掉，每一條
 * 也都要真的換到。
 *
 * `PLAN_MODE_ON_TREE_RECORD=1` 拿當下的輸出覆寫對照組，`PLAN_MODE_ON_TREE_ONLY=<字串>` 只跑標籤含它的案例。
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { Command } from '@langchain/langgraph';
import { convertMessagesToCompletionsMessageParams } from '@langchain/openai';
import { SessionRegistry } from '@nexus/core';
import type {
  AgentLoopKind,
  ApprovalPolicy,
  PluginEntry,
  PluginRegistry,
  QuestionReply,
} from '@nexus/core';
import {
  EXIT_PLAN_MODE_TOOL_NAME,
  PLAN_APPROVE_LABEL,
  PLAN_COMMAND_NAME,
  PLAN_KEEP_PLANNING_LABEL,
  PLAN_POLICY_SECTION_NAME,
  PLAN_REVIEW_QUESTION_ID,
} from '@nexus/plugin-plan-mode';
import { afterEach, expect, it } from 'vitest';

import { HEADLESS_APPROVALS } from './agent-factory.js';
import { createCliAgent, THREAD_ID } from './assembly-root.js';
import { createCordisRoot, entryApprovalChannel } from './cordis-root.js';
import type { CordisRoot } from './cordis-root.js';
import { shippedPlugins, withScriptedModel } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { toAgentInvocation } from './messages.js';
import { loadDefaultPlugins } from './plugin-config.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';

type CliAgent = Awaited<ReturnType<typeof createCliAgent>>;

const BASELINE = new URL('./plan-mode-on-tree.baseline.json', import.meta.url);
const LOOPS: readonly AgentLoopKind[] = ['langgraph', 'native'];
const shipped = await shippedPlugins();

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 每次 `bindTools` 拿到的工具名，依呼叫順序。 */
const binds: string[][] = [];
/** 同一段期間每個工具名送給供應商的定義（`convertToOpenAITool` 的 JSON），同名而定義不同的每一份都留。 */
const toolDefinitions = new Map<string, Set<string>>();
const originalBind = ScriptedChatModel.prototype.bindTools;
ScriptedChatModel.prototype.bindTools = function (this: ScriptedChatModel, tools) {
  const list = tools as StructuredToolInterface[];
  binds.push(list.map((tool) => tool.name));
  for (const tool of list) {
    const seen = toolDefinitions.get(tool.name) ?? new Set<string>();
    seen.add(JSON.stringify(convertToOpenAITool(tool)));
    toolDefinitions.set(tool.name, seen);
  }
  return originalBind.call(this, tools);
};

/** 從頭記 {@link binds} 與 {@link toolDefinitions}。 */
function resetBinds(): void {
  binds.length = 0;
  toolDefinitions.clear();
}

/** 這段期間的工具名順序與定義，依名字排序。 */
function boundTools(): { binds: string[][]; definitions: Record<string, unknown[]> } {
  return {
    binds: [...binds],
    definitions: Object.fromEntries(
      [...toolDefinitions.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, defs]) => [name, [...defs].map((def) => JSON.parse(def) as unknown)]),
    ),
  };
}

/** 探針列（排在清單最後）：把這條 thread 的 registry 留下來，組裝完再讀。 */
function probe(): { readonly entry: PluginEntry; readonly registry: () => PluginRegistry } {
  let kept: PluginRegistry | undefined;
  return {
    entry: {
      id: 'plan-mode-on-tree-probe',
      plugin: {
        name: 'plan-mode-on-tree-probe',
        apply(registry) {
          kept = registry;
        },
      },
    },
    registry: () => {
      if (kept === undefined) throw new Error('探針那一列沒有 apply：沒掛上');
      return kept;
    },
  };
}

const originOf = (origin: { readonly id: string; readonly name: string } | undefined): string =>
  origin === undefined ? '<core>' : `${origin.id}｜${origin.name}`;

interface Listener {
  readonly event: string;
  readonly origin: string;
  readonly prepend: boolean;
}

/** 這條 thread 的 registry 上，四樣裡由插件登記的三樣。 */
function registrations(registry: PluginRegistry): {
  listeners: Listener[];
  installers: string[];
  sections: { name: string; order: number; separator: string | null; text: string }[];
} {
  return {
    listeners: registry.events.listeners().map((info) => ({
      event: info.name,
      origin: originOf(info.origin),
      prepend: info.prepend,
    })),
    installers: registry.sessions.installers().map((entry) => originOf(entry.origin)),
    sections: registry.prompt.sections().map((section) => ({
      name: section.name,
      order: section.order,
      separator: section.separator ?? null,
      // 函式型的文字每次模型呼叫現算，當下的文字看請求；這裡只記它是不是函式。
      text: typeof section.text === 'function' ? '<function>' : section.text,
    })),
  };
}

/** agent 身上那份 middleware stack 的名字（與 `sandbox-policy-on-tree.test.ts` 同一個走法）。 */
function middlewareNames(agent: unknown): string[] {
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): string[] | null => {
    if (depth > 5 || node == null || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'middleware' && Array.isArray(value)) {
        return value.map((entry) => String((entry as { name?: string })?.name));
      }
      const found = walk(value, depth + 1);
      if (found) return found;
    }
    return null;
  };
  const names = walk(agent, 0);
  if (!names) throw new Error('找不到 agent 的 middleware stack');
  return names;
}

const requestsOf = (model: ScriptedChatModel): unknown[] =>
  model.prompts.map((prompt) =>
    normalizedRequest(
      JSON.stringify(
        convertMessagesToCompletionsMessageParams({ messages: [...prompt], model: 'm' }),
      ),
    ),
  );

type Assembly = 'shipped' | 'cli' | 'serve';

type Registration = ReturnType<typeof registrations> & {
  readonly middleware: string[];
  readonly commands: unknown;
  readonly tools: ReturnType<typeof boundTools>;
  readonly firstRequest: unknown;
};

/** 一個新的 Cordis 根，讀出貨的樹（serve 多疊 `cordis.serve.yml`），boot 好交回 `create`。 */
async function bootTree(
  surface: 'cli' | 'serve',
  approvals: ApprovalPolicy | undefined,
  contained: boolean,
): Promise<{
  readonly plugins: readonly PluginEntry[];
  readonly create: (
    invocation: Parameters<typeof createCliAgent>[0],
    plugins: readonly PluginEntry[],
  ) => Promise<CliAgent>;
}> {
  const home = scratch('nexus-plan-tree-home-');
  const root: CordisRoot = createCordisRoot({
    channel: entryApprovalChannel(approvals),
    contained,
  });
  cleanups.push(() => root.dispose());
  const loaded = await loadDefaultPlugins(
    { env: { [HARNESS_HOME_ENV]: home }, warn: () => {}, serve: surface === 'serve' },
    { tree: root.tree },
  );
  expect(loaded.dropped).toEqual([]);
  const booted = await root.boot(surface, { plugins: loaded.plugins });
  return {
    plugins: loaded.plugins,
    create: (invocation, plugins) =>
      booted.create(invocation, {
        plugins,
        ...(approvals !== undefined && { session: { approvals } }),
      }),
  };
}

/** 四樣順序：一種組裝、有沒有工作區、一個 loop。跑一輪「好。」讓第一則請求與 `bindTools` 都發生。 */
async function registrationCase(
  assembly: Assembly,
  contained: boolean,
  loop: AgentLoopKind,
): Promise<Registration> {
  const workspace = contained ? scratch('nexus-plan-tree-ws-') : undefined;
  const home = scratch('nexus-plan-tree-home-');
  const turns: ScriptedTurn[] = [{ content: '好。' }];
  const spy = probe();
  resetBinds();
  const invocation = {
    live: false,
    agentLoop: loop,
    ...(workspace !== undefined && { workspace, sandbox: 'workspace-write' as const }),
  };
  let built: CliAgent;
  if (assembly === 'shipped') {
    built = await createCliAgent(
      invocation,
      [...withScriptedModel(shipped, turns), spy.entry],
      workspace ?? home,
    );
  } else {
    const tree = await bootTree(
      assembly,
      assembly === 'cli' ? HEADLESS_APPROVALS : undefined,
      true,
    );
    built = await tree.create(invocation, withScriptedModel([...tree.plugins, spy.entry], turns));
  }
  try {
    await built.agent.invoke(toAgentInvocation('開工'), {
      configurable: { thread_id: `plan-tree-${assembly}-${String(contained)}-${loop}` },
    });
    const model = built.model as ScriptedChatModel;
    return {
      middleware: middlewareNames(built.agent),
      ...registrations(spy.registry()),
      // 依名字排序、不帶 handler（`CommandRegistrationPoint.list`）。
      commands: built.commands.list(),
      tools: boundTools(),
      firstRequest: requestsOf(model)[0] ?? null,
    };
  } finally {
    await built.dispose();
  }
}

/** 一則 `exit_plan_mode` 呼叫。 */
const exitPlan = (id: string): ScriptedTurn => ({
  content: '我先規劃。',
  toolCalls: [{ name: EXIT_PLAN_MODE_TOOL_NAME, args: { plan: '# 計劃\n\n先看再改。' }, id }],
});

const approve: QuestionReply = {
  answers: [{ id: PLAN_REVIEW_QUESTION_ID, selected: [PLAN_APPROVE_LABEL] }],
};

/** 情境裡的一步：下一行 `/plan`，或跑一輪（停在中斷上就用 `resume` 接回去）。 */
type Step =
  | { readonly plan: string }
  | { readonly say: string; readonly resume?: QuestionReply | { readonly cancelled: true } };

interface Scenario {
  readonly steps: readonly Step[];
  readonly turns: readonly ScriptedTurn[];
  /** 沒有人在（CLI 的 `HEADLESS_APPROVALS`）。 */
  readonly headless?: boolean;
}

const SCENARIOS: readonly (readonly [string, Scenario])[] = [
  [
    '進出',
    {
      steps: [{ plan: '' }, { say: '先想想。' }, { plan: 'off' }, { say: '動手。' }],
      turns: [{ content: '想好了。' }, { content: '做完了。' }],
    },
  ],
  [
    '同意',
    {
      steps: [{ plan: '' }, { say: '幫我改一下。', resume: approve }],
      turns: [exitPlan('x1'), { content: '開始動手。' }],
    },
  ],
  [
    '繼續規劃',
    {
      steps: [
        { plan: '' },
        {
          say: '幫我改一下。',
          resume: {
            answers: [
              {
                id: PLAN_REVIEW_QUESTION_ID,
                selected: [PLAN_KEEP_PLANNING_LABEL],
                custom: '先補測試。',
              },
            ],
          },
        },
      ],
      turns: [exitPlan('x1'), { content: '再想想。' }],
    },
  ],
  [
    '關掉這一題',
    {
      steps: [{ plan: '' }, { say: '幫我改一下。', resume: { cancelled: true } }],
      turns: [exitPlan('x1'), { content: '收到。' }],
    },
  ],
  [
    '委派',
    {
      steps: [{ plan: '' }, { say: '請子代理查一下。' }],
      turns: [
        {
          content: '委派。',
          toolCalls: [
            {
              name: 'task',
              args: { description: '查一個檔', subagent_type: 'general-purpose' },
              id: 't1',
            },
          ],
        },
        { content: '子代理收工。' },
        { content: '根收工。' },
      ],
    },
  ],
  [
    '沒有答題管道',
    {
      headless: true,
      steps: [{ plan: '' }, { say: '幫我改一下。' }],
      turns: [exitPlan('x1'), { content: '開始動手。' }],
    },
  ],
];

/** 下一行命令，回它的結果。 */
async function runCommand(built: CliAgent, name: string, rawInput: string): Promise<unknown> {
  const command = built.commands.find(name);
  if (command === undefined) throw new Error(`沒有 /${name}`);
  return command.handler({
    commandId: `c-${rawInput}`,
    rawInput,
    signal: new AbortController().signal,
    sessionLog: built.sessionLog,
    attachments: [],
    steer: () => undefined,
  });
}

/** 六個情境：一個情境、出貨清單或樹、一個 loop。 */
async function scenarioCase(
  spec: Scenario,
  source: 'shipped' | 'tree',
  loop: AgentLoopKind,
): Promise<unknown> {
  const workspace = scratch('nexus-plan-tree-ws-');
  const approvals = spec.headless === true ? HEADLESS_APPROVALS : undefined;
  resetBinds();
  const invocation = {
    live: false,
    agentLoop: loop,
    workspace,
    sandbox: 'workspace-write' as const,
  };
  let built: CliAgent;
  if (source === 'shipped') {
    built = await createCliAgent(
      invocation,
      withScriptedModel(shipped, spec.turns),
      workspace,
      approvals === undefined ? {} : { approvals },
    );
  } else {
    const tree = await bootTree('cli', approvals, true);
    built = await tree.create(invocation, withScriptedModel(tree.plugins, spec.turns));
  }
  const detach = built.attachSession(built.sessions);
  // 同 CLI：`thread_id` 就是 root 日誌的 id，行程級的會話查找靠它認出這條 thread。
  const config = { configurable: { thread_id: THREAD_ID } };
  const commands: unknown[] = [];
  let raised = 0;
  try {
    for (const step of spec.steps) {
      if ('plan' in step) {
        commands.push(await runCommand(built, PLAN_COMMAND_NAME, step.plan));
        continue;
      }
      const out = (await built.agent.invoke(toAgentInvocation(step.say), config)) as {
        messages: BaseMessage[];
        __interrupt__?: readonly unknown[];
      };
      const paused = out.__interrupt__?.length ?? 0;
      raised += paused;
      if (step.resume !== undefined && paused > 0) {
        await built.agent.invoke(new Command({ resume: step.resume }) as never, config);
      }
    }
  } finally {
    detach();
    await built.dispose();
  }
  return {
    commands,
    raised,
    requests: requestsOf(built.model as ScriptedChatModel),
    tools: boundTools(),
    // 每份會話日誌的落盤位元組（`jsonl-session-store.ts` 一筆一行 `JSON.stringify(event)`），{@link VOLATILE} 的欄位換掉之後。
    logs: built.sessions.list().map((entry) => ({
      address: JSON.stringify(normalizedAddress(entry.address)),
      bytes: entry.log.events
        .map((event) => `${JSON.stringify(normalizedEvent(event))}\n`)
        .join(''),
    })),
  };
}

/** 段落拿到的六種呼叫身分。`own`／`other` 是這條與另一條 thread 的 id。 */
function callShapes(own: string, other: string): readonly (readonly [string, unknown])[] {
  return [
    ['root', { configurable: { thread_id: own, checkpoint_ns: 'model_request:1' } }],
    ['子代理', { configurable: { thread_id: own, checkpoint_ns: 'tools:s1|model_request:1' } }],
    [
      '別條 thread 的 root',
      { configurable: { thread_id: other, checkpoint_ns: 'model_request:1' } },
    ],
    ['沒有 thread_id', { configurable: { checkpoint_ns: 'model_request:1' } }],
    ['沒有 checkpoint_ns', { configurable: { thread_id: own } }],
    ['空的', {}],
  ];
}

/**
 * 多條 thread：serve 的樹上一次 boot、兩次 `create`，各接一張以 thread id 為名的會話註冊表（同 `thread-pump.ts`）。每個時點拿
 * {@link callShapes} 問兩條 thread 各自那一段，記指引夾不夾。
 */
async function threadsCase(loop: AgentLoopKind): Promise<unknown> {
  const tree = await bootTree('serve', undefined, true);
  const threads: {
    readonly id: string;
    readonly built: CliAgent;
    readonly sessions: SessionRegistry;
    readonly registry: () => PluginRegistry;
    detach?: () => void;
  }[] = [];
  const open = async (id: string): Promise<void> => {
    const spy = probe();
    const built = await tree.create(
      { live: false, agentLoop: loop },
      withScriptedModel([...tree.plugins, spy.entry], [{ content: '好。' }]),
    );
    cleanups.push(() => built.dispose());
    const sessions = new SessionRegistry(id);
    const thread = { id, built, sessions, registry: spy.registry };
    threads.push(thread);
    Object.assign(thread, { detach: built.attachSession(sessions) });
  };
  const sample = (): Record<string, Record<string, string>> => {
    const out: Record<string, Record<string, string>> = {};
    for (const thread of threads) {
      const section = thread
        .registry()
        .prompt.sections()
        .find((entry) => entry.name === PLAN_POLICY_SECTION_NAME);
      if (section === undefined || typeof section.text !== 'function') {
        throw new Error(`${thread.id} 沒有函式型的 ${PLAN_POLICY_SECTION_NAME}`);
      }
      const text = section.text;
      const other = thread.id === 'a' ? 'b' : 'a';
      out[thread.id] = Object.fromEntries(
        callShapes(thread.id, other).map(([shape, call]) => [
          shape,
          text({ agent: undefined, call, tools: [] }) === '' ? '不夾' : '夾',
        ]),
      );
    }
    return out;
  };
  const moments: Record<string, unknown> = {};
  await open('a');
  moments['只接了 a'] = sample();
  await open('b');
  moments['a、b 都接'] = sample();
  const [a, b] = threads as [(typeof threads)[number], (typeof threads)[number]];
  const entered = await a.built.commands.find(PLAN_COMMAND_NAME)?.handler({
    commandId: 'c-a',
    rawInput: '',
    signal: new AbortController().signal,
    sessionLog: a.sessions.root,
    attachments: [],
    steer: () => undefined,
  });
  moments['a 進計劃模式'] = { command: entered, ...sample() };
  b.detach?.();
  moments['收掉 b'] = sample();
  a.detach?.();
  return moments;
}

/**
 * 每次跑都不同、跟這一列怎麼掛無關的欄位，一條一條明列；只換這幾格，其餘逐位元組比。每一條在一次完整的跑裡都要真的換到
 * （{@link touched}），沒換到就紅。
 */
const VOLATILE = {
  eventTime: '日誌每一行頂層的 `time`（epoch 毫秒）',
  messageId: '`assistant/message` 的 `data.message.data.id`（`run-` 加 uuid）',
  sampledAt: 'time context 那則 `user/message` 的 `data.message.data.content` 開頭那一行的取樣時刻',
  sampledAtEpoch:
    "time context 那則 `user/message` 的 `data.message.data.additional_kwargs['nexus.timeContext'].sampledAt`",
  subagentRunId: '子代理會話位址的 `runId`（`tools:` 加 uuid）',
  catalogChildId: '`subagent/catalog` 的 `data.childId`（帶子代理的 `runId`）',
  requestSampledAt: '請求裡 time context 那則 user 訊息開頭那一行的取樣時刻',
} as const;
type Volatile = keyof typeof VOLATILE;
const touched = new Set<Volatile>();

/** time context 那則訊息的第一行：`Time sampled while preparing turn N, step M: <帶時區的時刻>`。只換冒號後面那一段。 */
const SAMPLED_AT = /^(Time sampled while preparing turn \d+, step \d+: )\S+/u;

function sampled(text: string, key: Volatile): string {
  if (!SAMPLED_AT.test(text)) return text;
  touched.add(key);
  return text.replace(SAMPLED_AT, '$1<now>');
}

function normalizedEvent(event: unknown): unknown {
  const copy = structuredClone(event) as {
    type: string;
    time?: unknown;
    data?: {
      childId?: unknown;
      message?: {
        data?: {
          id?: unknown;
          content?: unknown;
          additional_kwargs?: { 'nexus.timeContext'?: { sampledAt?: unknown } };
        };
      };
    };
  };
  if (copy.time !== undefined) {
    copy.time = '<epoch>';
    touched.add('eventTime');
  }
  const inner = copy.data?.message?.data;
  if (copy.type === 'assistant/message' && typeof inner?.id === 'string') {
    inner.id = '<message-id>';
    touched.add('messageId');
  }
  if (copy.type === 'user/message' && typeof inner?.content === 'string') {
    inner.content = sampled(inner.content, 'sampledAt');
  }
  const timeContext = inner?.additional_kwargs?.['nexus.timeContext'];
  if (copy.type === 'user/message' && timeContext?.sampledAt !== undefined) {
    timeContext.sampledAt = '<epoch>';
    touched.add('sampledAtEpoch');
  }
  if (copy.type === 'subagent/catalog' && typeof copy.data?.childId === 'string') {
    copy.data.childId = '<child-id>';
    touched.add('catalogChildId');
  }
  return copy;
}

function normalizedAddress(address: unknown): unknown {
  const copy = { ...(address as Record<string, unknown>) };
  if (copy.kind === 'subagent' && typeof copy.runId === 'string') {
    copy.runId = '<run-id>';
    touched.add('subagentRunId');
  }
  return copy;
}

function normalizedRequest(request: string): unknown {
  const messages = JSON.parse(request) as { role: string; content: unknown }[];
  for (const message of messages) {
    if (message.role === 'user' && typeof message.content === 'string') {
      message.content = sampled(message.content, 'requestSampledAt');
    }
  }
  return messages;
}

/**
 * 這一列上樹之後 origin 換了名字的，**一條一條明列「舊 → 新」**（舊的是對照組裡的 `id｜name`）。基線裡每一處 origin 不同都要在表上，
 * 表上每一條也都要真的用到（{@link usedRenames}）。
 */
const RENAMED: ReadonlyMap<string, string> = new Map<string, string>([]);
const usedRenames = new Set<string>();

function renamed(origin: string): string {
  const next = RENAMED.get(origin);
  if (next === undefined) return origin;
  usedRenames.add(origin);
  return next;
}

/** 對照組裡一格順序的 origin 照 {@link RENAMED} 換過，其餘原樣。 */
function withRenames(baseline: Registration): Registration {
  return {
    ...baseline,
    listeners: baseline.listeners.map((info) => ({ ...info, origin: renamed(info.origin) })),
    installers: baseline.installers.map(renamed),
  };
}

/**
 * 計劃模式改聽 `agent/pre-step`（#2358）之後，四樣順序跟對照組不同的地方，**只有這兩處**：
 *
 * - listeners 多一位 `plan-mode` 的 `agent/pre-step`（交出排著的待關）；
 * - middleware 上 `nexusPlanMode` 那一格不在了，換成 core 的 `nexusPreStep`（langgraph 下有 `agent/pre-step` 監聽者才掛）與
 *   `nexusToolNameRestore`（補回 `concludesTurn` 工具結果的 `name`）。
 */
function withPreStepHandoff(baseline: Registration, loop: string): Registration {
  const at = baseline.middleware.indexOf('nexusPlanMode');
  expect(at, '對照組上 nexusPlanMode 那一格').toBeGreaterThanOrEqual(0);
  const replacement =
    loop === 'langgraph' ? ['nexusPreStep', 'nexusToolNameRestore'] : ['nexusToolNameRestore'];
  return {
    ...baseline,
    listeners: [
      { event: 'agent/pre-step', origin: 'plan-mode｜plan-mode', prepend: false },
      ...baseline.listeners,
    ],
    middleware: [
      ...baseline.middleware.slice(0, at),
      ...replacement,
      ...baseline.middleware.slice(at + 1),
    ],
  };
}

const isPlanMode = (origin: string): boolean => origin.startsWith('plan-mode｜');

/**
 * 上樹之後跟對照組不同的格，**封閉清單**：每一筆都要真的用到，對照組在那一格的值也要正好是 `before`。
 *
 * - 多條 thread 那張表「a 進計劃模式」時，a 的指引段拿到「別條 thread 的 root」的呼叫身分：舊的相容層查找每次組裝一份，只綁一份
 *   註冊表時不核對 `thread_id`，所以認成 a 自己；樹上的會話查找是行程層的，照 `thread_id` 認到 b，b 不在計劃模式。產品上兩邊相同：
 *   CLI 的 `thread_id` 就是 root 日誌的 id（`THREAD_ID`），serve 的每條 thread 也是。
 */
const KNOWN_DIFFERENCES: readonly {
  readonly label: string;
  readonly path: readonly string[];
  readonly before: unknown;
  readonly after: unknown;
}[] = LOOPS.map((loop) => ({
  label: `多條 thread｜serve｜${loop}`,
  path: ['a 進計劃模式', 'a', '別條 thread 的 root'],
  before: '夾',
  after: '不夾',
}));
const usedDifferences = new Set<number>();

/** 對照組的一格套上 {@link KNOWN_DIFFERENCES}；對照組在那一格的值不是 `before` 就紅。 */
function withKnownDifferences(label: string, baseline: unknown): unknown {
  const expected = structuredClone(baseline);
  for (const [index, difference] of KNOWN_DIFFERENCES.entries()) {
    if (difference.label !== label) continue;
    const parent = difference.path
      .slice(0, -1)
      .reduce<Record<string, unknown>>(
        (node, key) => node[key] as Record<string, unknown>,
        expected as Record<string, unknown>,
      );
    const leaf = difference.path.at(-1)!;
    expect(parent[leaf], `${label} ${difference.path.join(' › ')} 的對照值`).toEqual(
      difference.before,
    );
    parent[leaf] = difference.after;
    usedDifferences.add(index);
  }
  return expected;
}

it(
  'plan-mode 那一列的四樣順序、六個情境的位元組與多條 thread 的認法，與對照組逐字相同',
  { timeout: 900_000 },
  async () => {
    // time context 那則訊息帶行程時區的名字；對照組在 Asia/Taipei 錄。
    const tz = process.env.TZ;
    process.env.TZ = 'Asia/Taipei';
    cleanups.push(() => {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    });
    const only = process.env.PLAN_MODE_ON_TREE_ONLY;
    const now: Record<string, unknown> = {};
    for (const assembly of ['shipped', 'cli', 'serve'] as const) {
      for (const contained of [true, false]) {
        for (const loop of LOOPS) {
          const label = `順序｜${assembly}｜${contained ? '有圍堵' : '沒圍堵'}｜${loop}`;
          if (only !== undefined && !label.includes(only)) continue;
          const result = await registrationCase(assembly, contained, loop);
          // 防空讀：探針讀到的若不是這條 thread 的 registry，兩邊都會錄到空的而照樣相等。
          expect(
            result.sections.map((section) => section.name),
            label,
          ).toContain(PLAN_POLICY_SECTION_NAME);
          expect(result.installers.filter(isPlanMode), label).toHaveLength(1);
          expect(result.tools.binds.flat(), label).toContain(EXIT_PLAN_MODE_TOOL_NAME);
          expect(
            (result.commands as readonly { name: string }[]).map((command) => command.name),
            label,
          ).toContain(PLAN_COMMAND_NAME);
          now[label] = result;
        }
      }
    }
    for (const [name, spec] of SCENARIOS) {
      for (const source of ['shipped', 'tree'] as const) {
        for (const loop of LOOPS) {
          const label = `情境｜${name}｜${source}｜${loop}`;
          if (only !== undefined && !label.includes(only)) continue;
          now[label] = await scenarioCase(spec, source, loop);
        }
      }
    }
    for (const loop of LOOPS) {
      const label = `多條 thread｜serve｜${loop}`;
      if (only !== undefined && !label.includes(only)) continue;
      now[label] = await threadsCase(loop);
    }
    if (process.env.PLAN_MODE_ON_TREE_RECORD === '1') {
      writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`);
      return;
    }
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, unknown>;
    if (only === undefined) expect(Object.keys(now)).toEqual(Object.keys(baseline));
    for (const key of Object.keys(now)) {
      const expected = key.startsWith('順序｜')
        ? withPreStepHandoff(withRenames(baseline[key] as Registration), key.split('｜').at(-1)!)
        : withKnownDifferences(key, baseline[key]);
      expect(now[key], key).toEqual(expected);
    }
    if (only === undefined) {
      expect([...usedRenames].sort(), '改名表上每一條都要用到').toEqual([...RENAMED.keys()].sort());
      expect([...usedDifferences].sort(), '已知差異每一條都要用到').toEqual(
        KNOWN_DIFFERENCES.map((_difference, index) => index),
      );
      expect([...touched].sort(), '每一條易變欄位都要真的換到').toEqual(
        Object.keys(VOLATILE).sort(),
      );
    }
  },
);

/**
 * 退出工具排的待關，在下一步開頭由同一列的 `agent/pre-step` 監聽者交出（#2358）：兩邊拿到的不是同一份狀態表的話，同意之後
 * root 日誌上不會有 `plan/mode { active: false }`，模式關不掉。出貨清單與 CLI 的樹各量一次。
 */
it.each(['shipped', 'tree'] as const)(
  '同意之後模式真的關了：退出工具排的待關，下一步開頭交得出去（%s）',
  { timeout: 120_000 },
  async (source) => {
    const spec = SCENARIOS.find(([name]) => name === '同意')?.[1];
    if (spec === undefined) throw new Error('沒有「同意」情境');
    const result = (await scenarioCase(spec, source, 'langgraph')) as {
      readonly logs: readonly { readonly address: string; readonly bytes: string }[];
    };
    const root = result.logs.find(
      (log) => (JSON.parse(log.address) as { kind?: string }).kind === 'root',
    );
    const modes = (root?.bytes ?? '')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { type: string; data?: { active?: boolean } })
      .filter((event) => event.type === 'plan/mode')
      .map((event) => event.data?.active);
    expect(modes).toEqual([true, false]);
  },
);
