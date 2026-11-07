/**
 * MCP 那一列上樹（[#2533](https://github.com/DemianLi/nexus-agent/issues/2533)）前後，兩個 loop 各自的請求本文、每次模型呼叫的工具清單、
 * 中斷酬載、組裝警告與整份會話日誌的落盤位元組，與 `mcp-on-tree.baseline.json` 逐字相同。
 *
 * 走部署方掛它的那條路（出貨清單疊一份 `--patch`，`insert` 一列 `@nexus/plugin-mcp`），`langgraph` 與 `native` 各跑一次。場景是
 * `mcp-migration.test.ts` 的全部，再加首連失敗、放棄重連、憑證引用、連線池、預設要問人五種組裝路徑。
 * 對照組在 `develop` `46419a14`（這一列還掛在相容層時）以 `K7C_RECORD=1` 錄的；`K7C_RECORD=1` 會拿當下的輸出覆寫對照組。
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { Command } from '@langchain/langgraph';
import { convertMessagesToCompletionsMessageParams } from '@langchain/openai';
import { SessionRegistry } from '@nexus/core';
import type { AgentLoopKind } from '@nexus/core';
import { McpConnectionPool, publicToolName } from '@nexus/plugin-mcp';
import { afterEach, expect, it } from 'vitest';

import { HEADLESS_APPROVALS } from './agent-factory.js';
import { createCliAgent } from './assembly-root.js';
import { createCordisRoot } from './cordis-root.js';
import type { CordisRoot } from './cordis-root.js';
import { CREDENTIALS_FILE, createCredentialService } from './credentials.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { processLaunchEnv } from './launch-env.js';
import { toAgentInvocation } from './messages.js';
import { loadDefaultPlugins } from './plugin-config.js';
import { ScriptedChatModel } from './scripted-model.js';

const BASELINE = new URL('./mcp-on-tree.baseline.json', import.meta.url);
const SERVER = 'srv';
const LOOPS: readonly AgentLoopKind[] = ['langgraph', 'native'];
const CREDENTIAL = 'NEXUS_TEST_MCP_ON_TREE';
const CREDENTIAL_VALUE = 'zq8tree-managed-0123456789';

const SERVERS = {
  legacy: fileURLToPath(
    new URL('../../../packages/nexus-plugin-mcp/src/fixture-server.ts', import.meta.url),
  ),
  modern: fileURLToPath(
    new URL('../../../packages/nexus-plugin-mcp/src/modern-stdio-server.ts', import.meta.url),
  ),
  raw: fileURLToPath(new URL('./mcp-raw-schema.fixture-server.ts', import.meta.url)),
} as const;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Answer = (raised: { readonly requests: Readonly<Record<string, unknown>> }) => unknown;

interface Case {
  readonly server: keyof typeof SERVERS;
  /** 呼叫的工具：MCP 工具給 raw 名字；hub 的資源工具給公開名字（`hub` 為 true）。不給就只叫一次模型。 */
  readonly tool?: string;
  readonly hub?: boolean;
  readonly args?: Record<string, unknown>;
  readonly answer?: Answer;
  readonly headless?: boolean;
  readonly env?: Record<string, string>;
  readonly config?: Record<string, unknown>;
  /** 首連前就建好 `FIXTURE_EXIT_IF_FILE` 的旗標檔：連不上。 */
  readonly down?: boolean;
  /** 第一輪之後讓 server 起不來並殺掉它，等放棄重連，再跑第二輪。 */
  readonly giveUp?: boolean;
  /** `MCP_TOKEN` 引用受管憑證檔裡的 {@link CREDENTIAL}。 */
  readonly credential?: boolean;
  /** 經連線池連（serve 的路徑）。 */
  readonly pool?: boolean;
  /** 再插一列 `srv2`（新協定、有資源）：同一條 thread 上兩台 server 共用一個 hub。 */
  readonly second?: boolean;
  /** 換掉腳本模型的 `turns`；給了就不看 `tool`。 */
  readonly turns?: readonly unknown[];
}

const everyKey =
  (answer: unknown): Answer =>
  (raised) => ({
    responses: Object.fromEntries(Object.keys(raised.requests).map((key) => [key, answer])),
  });

const cases: readonly (readonly [string, Case])[] = [
  ['清單：舊協定', { server: 'legacy' }],
  ['清單：新協定', { server: 'modern' }],
  ['清單：原始 schema', { server: 'raw' }],
  ['舊：文字', { server: 'legacy', tool: 'fetch_release_note', args: { topic: 'nexus' } }],
  ['舊：isError', { server: 'legacy', tool: 'fail', args: {} }],
  ['舊：文字夾圖', { server: 'legacy', tool: 'snapshot', args: {} }],
  ['舊：只有圖', { server: 'legacy', tool: 'only_image', args: {} }],
  ['舊：資源連結', { server: 'legacy', tool: 'cite_sources', args: {} }],
  ['舊：內嵌文字資源', { server: 'legacy', tool: 'embed_text', args: { kb: 1 } }],
  ['舊：內嵌二進位資源', { server: 'legacy', tool: 'embed_blob', args: { kb: 1 } }],
  ['舊：超過上限的圖', { server: 'legacy', tool: 'big_image', args: { kb: 64 } }],
  ['舊：結構化', { server: 'legacy', tool: 'structured', args: { kb: 1 } }],
  ['舊：參數型別不對', { server: 'legacy', tool: 'fetch_release_note', args: { topic: 1 } }],
  ['舊：少參數', { server: 'legacy', tool: 'fetch_release_note', args: {} }],
  [
    '舊：多一個鍵',
    { server: 'legacy', tool: 'fetch_release_note', args: { topic: 'nexus', extra: 1 } },
  ],
  [
    '舊：逾時',
    {
      server: 'legacy',
      tool: 'hang',
      args: {},
      env: { FIXTURE_STALL_TOOLS: '1' },
      config: { toolCallTimeoutMs: 300 },
    },
  ],
  [
    '舊：必須用 task',
    { server: 'legacy', tool: 'needs_task', args: {}, env: { FIXTURE_TASK_TOOLS: '1' } },
  ],
  ['新：文字', { server: 'modern', tool: 'fetch_release_note', args: { topic: 'nexus' } }],
  ['新：isError', { server: 'modern', tool: 'fail', args: {} }],
  ['新：結構化', { server: 'modern', tool: 'structured', args: { kb: 1 } }],
  [
    '新：問人同意',
    {
      server: 'modern',
      tool: 'ask',
      args: {},
      answer: everyKey({ action: 'accept', content: { confirm: true } }),
    },
  ],
  [
    '新：問人拒絕',
    { server: 'modern', tool: 'ask_url', args: {}, answer: everyKey({ action: 'decline' }) },
  ],
  [
    '新：問兩次網址',
    { server: 'modern', tool: 'ask_twice', args: {}, answer: everyKey({ action: 'accept' }) },
  ],
  ['新：沒有人可以回答', { server: 'modern', tool: 'ask', args: {}, headless: true }],
  [
    '資源：列出',
    {
      server: 'modern',
      tool: 'list_mcp_resources',
      hub: true,
      args: { server: SERVER },
      env: { FIXTURE_RESOURCES: '1' },
    },
  ],
  [
    '資源：讀',
    {
      server: 'modern',
      tool: 'read_mcp_resource',
      hub: true,
      args: { server: SERVER, uri: 'memo://readme' },
      env: { FIXTURE_RESOURCES: '1' },
    },
  ],
  [
    '資源：讀二進位',
    {
      server: 'modern',
      tool: 'read_mcp_resource',
      hub: true,
      args: { server: SERVER, uri: 'memo://logo' },
      env: { FIXTURE_RESOURCES: '1' },
    },
  ],
  [
    '原始：合法',
    {
      server: 'raw',
      tool: 'book_meeting',
      args: { room: 'A1', start: '2026-11-04T10:00:00Z', attendees: [{ email: 'a@b.co' }] },
    },
  ],
  [
    '原始：format 不對',
    { server: 'raw', tool: 'book_meeting', args: { room: 'A1', start: 'tomorrow' } },
  ],
  [
    '原始：anyOf 都不符',
    { server: 'raw', tool: 'book_meeting', args: { room: true, start: '2026-11-04T10:00:00Z' } },
  ],
  [
    '原始：$ref 裡少欄位',
    {
      server: 'raw',
      tool: 'book_meeting',
      args: { room: 2, start: '2026-11-04T10:00:00Z', attendees: [{ role: 'guest' }] },
    },
  ],
  [
    '原始：多一個鍵',
    {
      server: 'raw',
      tool: 'book_meeting',
      args: { room: 'A1', start: '2026-11-04T10:00:00Z', extra: 1 },
    },
  ],
  ['原始：沒有參數', { server: 'raw', tool: 'ping_raw', args: {} }],
  ['原始：outputSchema', { server: 'raw', tool: 'stats', args: { team: 'core' } }],
  ['組裝：首連失敗', { server: 'legacy', down: true }],
  [
    '組裝：兩台共用 hub',
    {
      server: 'modern',
      tool: 'list_mcp_resources',
      hub: true,
      args: { server: 'srv2' },
      env: { FIXTURE_RESOURCES: '1', FIXTURE_INSTRUCTIONS: '先 list 再 read。' },
      second: true,
    },
  ],
  [
    '組裝：子代理',
    {
      server: 'modern',
      env: { FIXTURE_RESOURCES: '1', FIXTURE_INSTRUCTIONS: '先 list 再 read。' },
      turns: [
        {
          content: '委派。',
          toolCalls: [
            {
              name: 'task',
              args: { description: '列資源', subagent_type: 'general-purpose' },
              id: 't1',
            },
          ],
        },
        {
          content: '列一下。',
          toolCalls: [{ name: 'list_mcp_resources', args: { server: SERVER }, id: 't2' }],
        },
        { content: '子代理收工。' },
        { content: '根收工。' },
      ],
    },
  ],
  [
    '組裝：放棄重連',
    {
      server: 'legacy',
      tool: 'fetch_release_note',
      args: { topic: 'nexus' },
      giveUp: true,
      config: { reconnect: { initialDelayMs: 20, maxDelayMs: 40, maxAttempts: 2 } },
    },
  ],
  [
    '組裝：憑證引用',
    { server: 'legacy', tool: 'read_env', args: { names: ['MCP_TOKEN'] }, credential: true },
  ],
  [
    '組裝：連線池',
    { server: 'legacy', tool: 'fetch_release_note', args: { topic: 'nexus' }, pool: true },
  ],
  [
    '組裝：預設要問人、沒有人可以回答',
    {
      server: 'legacy',
      tool: 'fetch_release_note',
      args: { topic: 'nexus' },
      headless: true,
      config: { approval: { default: 'ask' } },
    },
  ],
];

/** 疊在出貨清單上的那一份 patch：插一列 MCP、換掉腳本模型的 `turns`。`marker` 讓這一列的子行程在 `ps` 裡認得出來。 */
function overlay(dir: string, spec: Case, marker: string): string {
  const name =
    spec.tool === undefined
      ? undefined
      : spec.hub === true
        ? spec.tool
        : publicToolName(SERVER, spec.tool);
  const turns = spec.turns ?? [
    ...(name === undefined
      ? []
      : [{ content: '', toolCalls: [{ name, args: spec.args ?? {}, id: 'c1' }] }]),
    { content: '收工。' },
    // 放棄之後再叫一次同一支：工具清單該藏起它，呼叫得到放棄的說明。
    ...(spec.giveUp === true && name !== undefined
      ? [
          { content: '', toolCalls: [{ name, args: spec.args ?? {}, id: 'c2' }] },
          { content: '再收工。' },
        ]
      : []),
  ];
  const env: Record<string, unknown> = {
    ...spec.env,
    ...((spec.down === true || spec.giveUp === true) && {
      FIXTURE_EXIT_IF_FILE: join(dir, 'down'),
    }),
    ...(spec.credential === true && { MCP_TOKEN: { credential: CREDENTIAL } }),
  };
  const config = {
    serverName: SERVER,
    approval: { default: 'allow' },
    connection: {
      transport: 'stdio',
      command: process.execPath,
      args: ['--import', 'tsx', SERVERS[spec.server], marker],
      ...(Object.keys(env).length > 0 && { env }),
    },
    ...spec.config,
  };
  const second = {
    serverName: 'srv2',
    approval: { default: 'allow' },
    connection: {
      transport: 'stdio',
      command: process.execPath,
      args: ['--import', 'tsx', SERVERS.modern, marker],
      env: { FIXTURE_RESOURCES: '1', FIXTURE_INSTRUCTIONS: '第二台的指引。' },
    },
  };
  const rows =
    `    - id: mcp-srv\n      name: '@nexus/plugin-mcp'\n      config: ${JSON.stringify(config)}\n` +
    (spec.second === true
      ? `    - id: mcp-srv2\n      name: '@nexus/plugin-mcp'\n      config: ${JSON.stringify(second)}\n`
      : '');
  const text =
    `- insert:\n${rows}` +
    `- id: cli-script\n  config: ${JSON.stringify({ turns })}\n`;
  const file = join(dir, 'overlay.yml');
  writeFileSync(file, text);
  return file;
}

/** 命令列帶著 `marker` 的行程。 */
function pidsWith(marker: string): number[] {
  const out = execFileSync('ps', ['-Ao', 'pid=,args='], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter((line) => line.includes(marker))
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid !== process.pid);
}

async function waitFor(check: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('等不到');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 每次 `bindTools` 拿到的清單，依呼叫順序。 */
const binds: (readonly unknown[])[] = [];
const originalBind = ScriptedChatModel.prototype.bindTools;
ScriptedChatModel.prototype.bindTools = function (this: ScriptedChatModel, tools) {
  binds.push(tools);
  return originalBind.call(this, tools);
};

async function runOne(
  root: CordisRoot,
  label: string,
  spec: Case,
  loop: AgentLoopKind,
): Promise<{ readonly dir: string; readonly result: unknown }> {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-mcp-on-tree-'));
  chmodSync(dir, 0o700);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const marker = `--nexus-mcp-on-tree=${dir}`;
  if (spec.down === true) writeFileSync(join(dir, 'down'), '');
  if (spec.credential === true) {
    const file = join(dir, CREDENTIALS_FILE);
    writeFileSync(file, `version: 1\nrefs:\n  ${CREDENTIAL}: ${CREDENTIAL_VALUE}\n`, {
      mode: 0o600,
    });
    chmodSync(file, 0o600);
  }
  const loaded = await loadDefaultPlugins(
    { env: { [HARNESS_HOME_ENV]: dir }, patches: [overlay(dir, spec, marker)], warn: () => {} },
    { tree: root.tree },
  );
  expect(loaded.dropped).toEqual([]);
  const pool = spec.pool === true ? new McpConnectionPool({ log: () => {} }) : undefined;
  if (pool !== undefined) cleanups.push(() => pool.close());
  const credentials =
    spec.credential === true
      ? createCredentialService({
          home: dir,
          launchEnv: processLaunchEnv({}),
          store: true,
          warn: () => {},
        })
      : undefined;
  binds.length = 0;
  const built = await createCliAgent(
    { live: false, agentLoop: loop, ...(credentials !== undefined && { credentials }) },
    loaded.plugins,
    dir,
    {
      ...(spec.headless === true && { approvals: HEADLESS_APPROVALS }),
      ...(pool !== undefined && { mcpPool: pool }),
    },
  );
  const sessions = new SessionRegistry('mcp-on-tree');
  const detach = built.attachSession(sessions);
  const config = { configurable: { thread_id: `mcp-on-tree-${label}` } };
  const raised: unknown[] = [];
  const errors: string[] = [];
  const invokeUntilDone = async (first: unknown): Promise<void> => {
    let input = first;
    for (let round = 0; round < 4; round += 1) {
      const out = (await built.agent.invoke(input as never, config)) as {
        messages: BaseMessage[];
        __interrupt__?: readonly { value?: unknown }[];
      };
      const pending = out.__interrupt__?.map((entry) => entry.value) ?? [];
      raised.push(...pending);
      const [head] = pending;
      if (head === undefined || spec.answer === undefined) break;
      input = new Command({ resume: spec.answer(head as { requests: Record<string, unknown> }) });
    }
  };
  try {
    try {
      await invokeUntilDone(toAgentInvocation('跑。'));
      if (spec.giveUp === true) {
        writeFileSync(join(dir, 'down'), '');
        for (const pid of pidsWith(marker)) process.kill(pid, 'SIGKILL');
        // 放棄之前每次重連嘗試都會起一個馬上退出的子行程，兩次之間只隔幾十毫秒的退避；連續 3 秒都沒有子行程才算用完。
        let quietSince = Date.now();
        await waitFor(() => {
          if (pidsWith(marker).length > 0) quietSince = Date.now();
          return Date.now() - quietSince >= 3_000;
        }, 20_000);
        await invokeUntilDone(toAgentInvocation('再跑。'));
      }
    } catch (error) {
      errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    }
  } finally {
    detach();
    await built.dispose();
  }
  const model = built.model as ScriptedChatModel;
  const toolLists = binds.map((tools) =>
    (tools as StructuredToolInterface[]).map((tool) => JSON.stringify(convertToOpenAITool(tool))),
  );
  const distinct = [...new Set(toolLists.map((list) => JSON.stringify(list)))];
  return {
    dir,
    result: {
      errors,
      warnings: built.warnings.map(({ message }) => message),
      raised: JSON.stringify(raised),
      calls: model.prompts.length,
      // 每次 `bindTools` 拿到哪一份清單（`toolLists` 的下標），與去重後的清單本身（逐支工具的 OpenAI 形狀，照順序）。
      binds: toolLists.map((list) => distinct.indexOf(JSON.stringify(list))),
      toolLists: distinct.map((list) => JSON.parse(list) as unknown),
      // 每次模型呼叫送給供應商的訊息（Chat Completions 形狀）。
      requests: model.prompts.map((prompt) =>
        JSON.stringify(
          convertMessagesToCompletionsMessageParams({ messages: [...prompt], model: 'm' }),
        ),
      ),
      // 每份會話日誌的落盤位元組（`jsonl-session-store.ts` 一筆一行 `JSON.stringify(event)`）。
      logs: sessions.list().map((entry) => ({
        address: JSON.stringify(entry.address),
        bytes: entry.log.events.map((event) => `${JSON.stringify(event)}\n`).join(''),
      })),
    },
  };
}

/**
 * 每次跑都不同、跟這一列怎麼掛無關的值：暫存目錄、逾時句的毫秒數、epoch 毫秒（日誌的 `time`、time context 的 `sampledAt`），
 * run id 這類 uuid，與 time context 文字裡帶時區偏移的取樣時刻（案例參數裡的時刻寫成 `Z`，不受影響）。字串裡的 JSON 也照樣換，因為
 * 日誌位元組與請求都是字串。
 */
function normalized(value: unknown, dir: string): unknown {
  const text = JSON.stringify(value)
    .split(dir)
    .join('<dir>')
    .replace(/等了 \d+ms/gu, '等了 <ms>ms')
    .replace(/(?<![\d.])1[7-9]\d{11}(?![\d.])/gu, '<epoch>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, '<uuid>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}(\[[^\]]*\])?/gu, '<now>');
  return JSON.parse(text) as unknown;
}

it(
  'MCP 那一列兩個 loop 的請求、工具清單、中斷、警告與落盤位元組，與對照組逐字相同',
  { timeout: 1_800_000 },
  async () => {
    const root = createCordisRoot();
    cleanups.push(() => root.dispose());
    const only = process.env.K7C_ONLY;
    const now: Record<string, unknown> = {};
    for (const [label, spec] of cases) {
      if (only !== undefined && !label.includes(only)) continue;
      for (const loop of LOOPS) {
        const { dir, result } = await runOne(root, label, spec, loop);
        now[`${label}｜${loop}`] = normalized(result, dir);
      }
    }
    if (process.env.K7C_RECORD === '1') {
      writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`);
      return;
    }
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, unknown>;
    if (only === undefined) expect(Object.keys(now)).toEqual(Object.keys(baseline));
    for (const key of Object.keys(now)) expect(now[key], key).toEqual(baseline[key]);
  },
);
