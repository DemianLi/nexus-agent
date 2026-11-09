/**
 * sandbox-policy 那一列（[#2533](https://github.com/DemianLi/nexus-agent/issues/2533)）在三種組裝登記的四樣順序與三個情境的日誌位元組，
 * 與 `sandbox-policy-on-tree.baseline.json` 逐字相同。
 *
 * - **四樣順序**：middleware 名字、匯流排上每位監聽者（事件名、origin、`prepend`）、會話參與者的 origin、提示詞各段（名字、order、
 *   separator；函式型的段只記它是函式，當下的文字看第一則請求），加上送給模型的第一則請求與每次 `bindTools` 的工具名。三種組裝：CLI 出貨清單（`createCliAgent` ＋
 *   `shippedPlugins()`，沒有樹）、CLI 的樹與 serve 的樹（`root.boot` ＋ `assembly.create`）；各自有工作區（有圍堵）與沒有工作區
 *   （沒圍堵），兩個 loop 各跑一次。
 * - **三個情境**（切換模式、升級、委派）：整份會話日誌的落盤位元組，出貨清單與樹各一次、兩個 loop 各一次。
 *
 * 比對鍵是位置；origin 換了名字的，只能是 {@link RENAMED} 明列的那幾條，而且基線裡每一處 origin 不同都要在表上、表上每一條都要用到。
 * 每次跑都不同、跟這一列怎麼掛無關的值只在 {@link VOLATILE} 明列的欄位換掉，每一條也都要真的換到。
 *
 * `SANDBOX_POLICY_ON_TREE_RECORD=1` 拿當下的輸出覆寫對照組，`SANDBOX_POLICY_ON_TREE_ONLY=<字串>` 只跑標籤含它的案例。
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import { convertMessagesToCompletionsMessageParams } from '@langchain/openai';
import type { AgentLoopKind, PluginEntry, PluginRegistry, SandboxMode } from '@nexus/core';
import { SANDBOX_ESCALATION_TOOL_NAME } from '@nexus/plugin-sandbox-policy';
import { afterEach, expect, it } from 'vitest';

import { HEADLESS_APPROVALS } from './agent-factory.js';
import { createCliAgent } from './assembly-root.js';
import { createCordisRoot, entryApprovalChannel } from './cordis-root.js';
import type { CordisRoot } from './cordis-root.js';
import { shippedPlugins, withScriptedModel } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { toAgentInvocation } from './messages.js';
import { loadDefaultPlugins } from './plugin-config.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';

const BASELINE = new URL('./sandbox-policy-on-tree.baseline.json', import.meta.url);
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
const originalBind = ScriptedChatModel.prototype.bindTools;
ScriptedChatModel.prototype.bindTools = function (this: ScriptedChatModel, tools) {
  binds.push((tools as StructuredToolInterface[]).map((tool) => tool.name));
  return originalBind.call(this, tools);
};

/** 探針列（排在 sandbox-policy 之後）：把這條 thread 的 registry 留下來，組裝完再讀（`apply` 當下讀會漏掉排在它後面的列與 fold 之後補的東西）。 */
function probe(): { readonly entry: PluginEntry; readonly registry: () => PluginRegistry } {
  let kept: PluginRegistry | undefined;
  return {
    entry: {
      id: 'sandbox-policy-on-tree-probe',
      plugin: {
        name: 'sandbox-policy-on-tree-probe',
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
      // 函式型的文字每次模型呼叫現算，當下的文字看 `firstRequest`；這裡只記它是不是函式。
      text: typeof section.text === 'function' ? '<function>' : section.text,
    })),
  };
}

/** agent 身上那份 middleware stack 的名字（與 `agent-instructions-on-tree.test.ts` 同一個走法）。 */
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

const requestsOf = (model: ScriptedChatModel): string[] =>
  model.prompts.map((prompt) =>
    JSON.stringify(
      convertMessagesToCompletionsMessageParams({ messages: [...prompt], model: 'm' }),
    ),
  );

type Assembly = 'shipped' | 'cli' | 'serve';

type Registration = ReturnType<typeof registrations> & {
  readonly middleware: string[];
  readonly binds: string[][];
  readonly firstRequest: unknown;
};

/** 兩條組裝路徑交回來的東西裡，這一檔用到的那幾格。 */
interface Built {
  readonly agent: { invoke: (input: never, config: unknown) => Promise<unknown> };
  readonly model: unknown;
  readonly dispose: () => Promise<void>;
}

/** 四樣順序：一種組裝、有沒有工作區、一個 loop。跑一輪「好。」讓第一則請求與 `bindTools` 都發生。 */
async function registrationCase(
  assembly: Assembly,
  contained: boolean,
  loop: AgentLoopKind,
): Promise<Registration> {
  const workspace = contained ? scratch('nexus-sandbox-tree-ws-') : undefined;
  const home = scratch('nexus-sandbox-tree-home-');
  const turns: ScriptedTurn[] = [{ content: '好。' }];
  const spy = probe();
  binds.length = 0;
  const invocation = {
    live: false,
    agentLoop: loop,
    ...(workspace !== undefined && { workspace, sandbox: 'workspace-write' as const }),
  };
  let built: Built;
  if (assembly === 'shipped') {
    built = (await createCliAgent(
      invocation,
      [...withScriptedModel(shipped, turns), spy.entry],
      workspace ?? home,
    )) as unknown as Built;
  } else {
    const root: CordisRoot = createCordisRoot({
      channel: entryApprovalChannel(assembly === 'cli' ? HEADLESS_APPROVALS : undefined),
      contained: true,
    });
    cleanups.push(() => root.dispose());
    // serve 多疊一層 `cordis.serve.yml`（workspace-changes 只在那一層）。
    const loaded = await loadDefaultPlugins(
      { env: { [HARNESS_HOME_ENV]: home }, warn: () => {}, serve: assembly === 'serve' },
      { tree: root.tree },
    );
    expect(loaded.dropped).toEqual([]);
    const booted = await root.boot(assembly, { plugins: loaded.plugins });
    built = (await booted.create(invocation, {
      plugins: withScriptedModel([...loaded.plugins, spy.entry], turns),
    })) as unknown as Built;
  }
  try {
    await built.agent.invoke(toAgentInvocation('開工') as never, {
      configurable: { thread_id: `sandbox-tree-${assembly}-${String(contained)}-${loop}` },
    });
    const model = built.model as ScriptedChatModel;
    return {
      middleware: middlewareNames(built.agent),
      ...registrations(spy.registry()),
      binds: [...binds],
      firstRequest: normalizedRequest(requestsOf(model)[0]),
    };
  } finally {
    await built.dispose();
  }
}

const write = (id: string): ScriptedTurn => ({
  content: '',
  toolCalls: [{ name: 'write_file', args: { file_path: '/a.txt', content: '一' }, id }],
});

interface Scenario {
  readonly mode: SandboxMode;
  readonly turns: readonly ScriptedTurn[];
  /** 開跑前先下的 `/permission` 參數。 */
  readonly permission?: string;
  /** 停在中斷上時接回去的答覆。 */
  readonly resume?: unknown;
}

const SCENARIOS: readonly (readonly [string, Scenario])[] = [
  [
    '切換模式',
    {
      mode: 'workspace-write',
      permission: 'read-only',
      turns: [write('w1'), { content: '收工。' }],
    },
  ],
  [
    '升級',
    {
      mode: 'read-only',
      turns: [
        write('w1'),
        {
          content: '',
          toolCalls: [
            {
              name: SANDBOX_ESCALATION_TOOL_NAME,
              args: {
                file_path: '/a.txt',
                sandbox_permissions: 'workspace-write',
                justification: '要寫報告',
              },
              id: 'e1',
            },
          ],
        },
        write('w2'),
        { content: '收工。' },
      ],
      resume: { decisions: [{ type: 'approve' }] },
    },
  ],
  [
    '委派',
    {
      mode: 'read-only',
      turns: [
        {
          content: '委派。',
          toolCalls: [
            {
              name: 'task',
              args: { description: '寫一個檔', subagent_type: 'general-purpose' },
              id: 't1',
            },
          ],
        },
        write('s1'),
        { content: '子代理收工。' },
        { content: '根收工。' },
      ],
    },
  ],
];

/** 三個情境：一個情境、出貨清單或樹、一個 loop。回來的是每份會話日誌的落盤位元組。 */
async function scenarioCase(
  label: string,
  spec: Scenario,
  source: 'shipped' | 'tree',
  loop: AgentLoopKind,
): Promise<unknown> {
  const workspace = scratch('nexus-sandbox-tree-ws-');
  const home = scratch('nexus-sandbox-tree-home-');
  let plugins: readonly PluginEntry[] = shipped;
  if (source === 'tree') {
    const root = createCordisRoot({ contained: true });
    cleanups.push(() => root.dispose());
    const loaded = await loadDefaultPlugins(
      { env: { [HARNESS_HOME_ENV]: home }, warn: () => {} },
      { tree: root.tree },
    );
    expect(loaded.dropped).toEqual([]);
    plugins = loaded.plugins;
  }
  const built = await createCliAgent(
    { live: false, agentLoop: loop, workspace, sandbox: spec.mode },
    withScriptedModel(plugins, spec.turns),
    workspace,
  );
  const detach = built.attachSession(built.sessions);
  const config = { configurable: { thread_id: `sandbox-tree-${label}-${source}-${loop}` } };
  const raised: unknown[] = [];
  try {
    if (spec.permission !== undefined) {
      await built.commands.find('permission')?.handler({
        commandId: 'c',
        rawInput: spec.permission,
        signal: new AbortController().signal,
        sessionLog: built.sessionLog,
        attachments: [],
        steer: () => undefined,
      });
    }
    const out = (await built.agent.invoke(toAgentInvocation('寫一個檔。'), config)) as {
      messages: BaseMessage[];
      __interrupt__?: readonly { value?: unknown }[];
    };
    raised.push(...(out.__interrupt__?.map((entry) => entry.value) ?? []));
    if (spec.resume !== undefined && raised.length > 0) {
      await built.agent.invoke(new Command({ resume: spec.resume }) as never, config);
    }
  } finally {
    detach();
    await built.dispose();
  }
  return {
    raised: raised.length,
    // 每份會話日誌的落盤位元組（`jsonl-session-store.ts` 一筆一行 `JSON.stringify(event)`），{@link VOLATILE} 的欄位換掉之後。
    logs: built.sessions.list().map((entry) => ({
      address: JSON.stringify(normalizedAddress(entry.address)),
      bytes: entry.log.events
        .map((event) => `${JSON.stringify(normalizedEvent(event))}\n`)
        .join(''),
    })),
  };
}

/**
 * 每次跑都不同、跟這一列怎麼掛無關的欄位，一條一條明列；只換這幾格，其餘逐位元組比。每一條在一次完整的跑裡都要真的換到
 * （{@link touched}），沒換到就紅：欄位改名或搬家時，這張表不會悄悄變成沒有作用。
 */
const VOLATILE = {
  eventTime: '日誌每一行頂層的 `time`（epoch 毫秒）',
  messageId: '`assistant/message` 的 `data.message.data.id`（`run-` 加 uuid）',
  sampledAt: 'time context 那則 `user/message` 的 `data.message.data.content` 開頭那一行的取樣時刻',
  sampledAtEpoch:
    "time context 那則 `user/message` 的 `data.message.data.additional_kwargs['nexus.timeContext'].sampledAt`",
  subagentRunId: '子代理會話位址的 `runId`（`tools:` 加 uuid）',
  catalogChildId: '`subagent/catalog` 的 `data.childId`（帶子代理的 `runId`）',
  requestSampledAt: '第一則請求裡 time context 那則 user 訊息開頭那一行的取樣時刻',
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

function normalizedRequest(request: string | undefined): unknown {
  if (request === undefined) return null;
  const messages = JSON.parse(request) as { role: string; content: unknown }[];
  for (const message of messages) {
    if (message.role === 'user' && typeof message.content === 'string') {
      message.content = sampled(message.content, 'requestSampledAt');
    }
  }
  return messages;
}

/**
 * 這一列上樹之後 origin 換了名字的，**一條一條明列「舊 → 新」**（舊的是對照組裡的 `id｜name`）。基線裡每一處 origin 不同都要在表上
 * （不在表上，下面的 `toEqual` 就紅），表上每一條也都要真的用到（{@link usedRenames}）。
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

const SANDBOX_POLICY_ID = 'sandbox-policy';
const isSandboxPolicy = (origin: string): boolean => origin.startsWith(`${SANDBOX_POLICY_ID}｜`);

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

it(
  'sandbox-policy 那一列的四樣順序與三個情境的日誌位元組，與對照組逐字相同',
  { timeout: 600_000 },
  async () => {
    // time context 那則訊息帶行程時區的名字，context/measure 的 token 數從原文算；對照組在 Asia/Taipei 錄。
    const tz = process.env.TZ;
    process.env.TZ = 'Asia/Taipei';
    cleanups.push(() => {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    });
    const only = process.env.SANDBOX_POLICY_ON_TREE_ONLY;
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
          ).toContain('sandbox:policy');
          if (contained) {
            expect(result.installers.filter(isSandboxPolicy), label).toHaveLength(1);
            expect(
              result.listeners.filter(
                (info) => info.event === 'tools/execute' && isSandboxPolicy(info.origin),
              ),
              label,
            ).toHaveLength(1);
          }
          now[label] = result;
        }
      }
    }
    for (const [name, spec] of SCENARIOS) {
      for (const source of ['shipped', 'tree'] as const) {
        for (const loop of LOOPS) {
          const label = `情境｜${name}｜${source}｜${loop}`;
          if (only !== undefined && !label.includes(only)) continue;
          now[label] = await scenarioCase(name, spec, source, loop);
        }
      }
    }
    if (process.env.SANDBOX_POLICY_ON_TREE_RECORD === '1') {
      writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`);
      return;
    }
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, unknown>;
    if (only === undefined) expect(Object.keys(now)).toEqual(Object.keys(baseline));
    for (const key of Object.keys(now)) {
      const expected = key.startsWith('順序｜')
        ? withPreStepHandoff(withRenames(baseline[key] as Registration), key.split('｜').at(-1)!)
        : baseline[key];
      expect(now[key], key).toEqual(expected);
    }
    if (only === undefined) {
      expect([...usedRenames].sort(), '改名表上每一條都要用到').toEqual([...RENAMED.keys()].sort());
      expect([...touched].sort(), '每一條易變欄位都要真的換到').toEqual(
        Object.keys(VOLATILE).sort(),
      );
    }
  },
);

it.each(LOOPS)(
  'serve 有圍堵（%s）：tools/execute 上 sandbox-policy 排在 workspace-changes 之前，兩位都不 prepend',
  async (loop) => {
    const result = await registrationCase('serve', true, loop);
    expect(
      result.listeners
        .filter((info) => info.event === 'tools/execute')
        .map((info) => [info.origin.split('｜')[0], info.prepend]),
    ).toEqual([
      [SANDBOX_POLICY_ID, false],
      ['workspace-changes', false],
    ]);
  },
  60_000,
);
