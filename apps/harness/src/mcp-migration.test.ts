/**
 * 產品組裝裡 MCP 工具（#2353）的工具定義、模型看到的工具結果、elicitation 的中斷酬載、日誌上整份 `tool/result`（含 artifact）、
 * 這一輪叫了模型幾次，與 `mcp-migration.baseline.json` 逐字相同。
 *
 * 走的是部署方掛它的那條路：出貨清單疊一份 `--patch`，`insert` 一列 `@nexus/plugin-mcp`、換掉 `cli-script` 的 `turns`。三台真的走
 * stdio 的 server：舊協定（`fixture-server.ts`）、新協定（`modern-stdio-server.ts`），與回原始 JSON Schema 的
 * `mcp-raw-schema.fixture-server.ts`。要問人的案例停在中斷上、照案例給的回答以 `Command({ resume })` 接回去，問幾次接幾次。
 * 對照組以 `develop` `b5855f0c`（MCP 工具還是 `@langchain/mcp-adapters` 轉出來的時候）`K3C_RECORD=1` 錄的為底，#2353 接受兩處差之後重錄：
 * 成功的 `tool/result` 多 `metadata.versions`；`舊：逾時` 改記 `TOOL_TIMEOUT` 與預算句。
 * `K3C_RECORD=1` 會拿當下的輸出覆寫對照組。
 */
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
import { publicToolName } from '@nexus/plugin-mcp';
import { afterEach, expect, it } from 'vitest';

import { HEADLESS_APPROVALS } from './agent-factory.js';
import { createCliAgent } from './assembly-root.js';
import { createCordisRoot } from './cordis-root.js';
import type { CordisRoot } from './cordis-root.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { toAgentInvocation } from './messages.js';
import { loadDefaultPlugins } from './plugin-config.js';
import type { ScriptedChatModel } from './scripted-model.js';

const BASELINE = new URL('./mcp-migration.baseline.json', import.meta.url);
const SERVER = 'srv';

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

/** 一個中斷的酬載 → 接回去的值。 */
type Answer = (raised: { readonly requests: Readonly<Record<string, unknown>> }) => unknown;

interface Case {
  readonly server: keyof typeof SERVERS;
  /** 呼叫的工具：MCP 工具給 raw 名字；hub 的資源工具給公開名字（`hub` 為 true）。不給就只錄工具清單。 */
  readonly tool?: string;
  readonly hub?: boolean;
  readonly args?: Record<string, unknown>;
  readonly answer?: Answer;
  readonly headless?: boolean;
  readonly env?: Record<string, string>;
  readonly config?: Record<string, unknown>;
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
];

/** 疊在出貨清單上的那一份 patch：插一列 MCP、換掉腳本模型的 `turns`。 */
function overlay(dir: string, spec: Case): string {
  const name =
    spec.tool === undefined
      ? undefined
      : spec.hub === true
        ? spec.tool
        : publicToolName(SERVER, spec.tool);
  const turns = [
    ...(name === undefined
      ? []
      : [{ content: '', toolCalls: [{ name, args: spec.args ?? {}, id: 'c1' }] }]),
    { content: '收工。' },
  ];
  const config = {
    serverName: SERVER,
    approval: { default: 'allow' },
    connection: {
      transport: 'stdio',
      command: process.execPath,
      args: ['--import', 'tsx', SERVERS[spec.server]],
      ...(spec.env === undefined ? {} : { env: spec.env }),
    },
    ...spec.config,
  };
  const text =
    `- insert:\n    - id: mcp-srv\n      name: '@nexus/plugin-mcp'\n      config: ${JSON.stringify(config)}\n` +
    `- id: cli-script\n  config: ${JSON.stringify({ turns })}\n`;
  const file = join(dir, 'overlay.yml');
  writeFileSync(file, text);
  return file;
}

async function runOne(root: CordisRoot, label: string, spec: Case): Promise<unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-mcp-migration-'));
  chmodSync(dir, 0o700);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const loaded = await loadDefaultPlugins(
    { env: { [HARNESS_HOME_ENV]: dir }, patches: [overlay(dir, spec)], warn: () => {} },
    { tree: root.tree },
  );
  expect(loaded.dropped).toEqual([]);
  const built = await createCliAgent(
    { live: false },
    loaded.plugins,
    undefined,
    spec.headless === true ? { approvals: HEADLESS_APPROVALS } : {},
  );
  const sessions = new SessionRegistry('mcp-migration');
  const detach = built.attachSession(sessions);
  const config = { configurable: { thread_id: `mcp-migration-${label}` } };
  const raised: unknown[] = [];
  let messages: readonly BaseMessage[] = [];
  try {
    let input: unknown = toAgentInvocation('跑。');
    for (let round = 0; round < 4; round += 1) {
      const out = (await built.agent.invoke(input as never, config)) as {
        messages: BaseMessage[];
        __interrupt__?: readonly { value?: unknown }[];
      };
      messages = out.messages;
      const pending = out.__interrupt__?.map((entry) => entry.value) ?? [];
      raised.push(...pending);
      const [first] = pending;
      if (first === undefined || spec.answer === undefined) break;
      input = new Command({
        resume: spec.answer(first as { requests: Record<string, unknown> }),
      });
    }
  } finally {
    detach();
    await built.dispose();
  }
  const model = built.model as ScriptedChatModel;
  const bound = (model.boundTools ?? []) as StructuredToolInterface[];
  const rootLog = sessions.list().find((entry) => entry.address.kind === 'root');
  return {
    ...(spec.tool === undefined && {
      wire: bound
        .filter((tool) => tool.name.startsWith('mcp__') || tool.name.includes('mcp_resource'))
        .map((tool) => JSON.stringify(convertToOpenAITool(tool)))
        .sort(),
    }),
    raised: JSON.stringify(raised),
    calls: model.prompts.length,
    // 最後一次請求送給供應商的 tool 訊息（Chat Completions 形狀），前面幾次是它的前綴。
    sent: JSON.stringify(
      convertMessagesToCompletionsMessageParams({
        messages: [...(model.prompts.at(-1) ?? [])],
        model: 'm',
      }).filter((entry) => entry.role === 'tool'),
    ),
    state: messages
      .filter((message) => message.getType() === 'tool')
      .map((message) => ({ name: (message as { name?: string }).name ?? null })),
    logged: (rootLog?.log.events ?? []).flatMap((event) =>
      event.type === 'tool/result' ? [JSON.stringify(event.data)] : [],
    ),
  };
}

it('MCP 工具的定義、結果、中斷與日誌，與對照組逐字相同', { timeout: 600_000 }, async () => {
  const root = createCordisRoot();
  cleanups.push(() => root.dispose());
  const now: Record<string, unknown> = {};
  // 逾時句講出實際等了幾毫秒，每次跑都不同；只把那個數字換掉。
  for (const [label, spec] of cases) {
    now[label] = JSON.parse(
      JSON.stringify(await runOne(root, label, spec)).replace(/等了 \d+ms/gu, '等了 <ms>ms'),
    ) as unknown;
  }
  if (process.env.K3C_RECORD === '1') {
    writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`);
    return;
  }
  const before = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, unknown>;
  expect(Object.keys(now)).toEqual(Object.keys(before));
  for (const key of Object.keys(before)) expect(now[key], key).toEqual(before[key]);
});
