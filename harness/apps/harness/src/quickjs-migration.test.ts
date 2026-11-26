/**
 * 產品組裝裡 `run_javascript`（`NexusTool`，#2353）的工具定義、工具結果與日誌上的 `tool/result`，
 * 與 `quickjs-migration.baseline.json` 逐字相同。
 *
 * 走的是部署方掛它的那條路：出貨清單疊一份 `--patch`，`insert` 一列 `@nexus/plugin-quickjs`，再把出貨的腳本模型換成這裡的腳本。
 * 對照組在 `develop` `240e2354`（這顆還是 LangChain 工具、掛在相容層時）以 `K3C_RECORD=1` 錄的。`K3C_RECORD=1` 會拿當下的輸出覆寫對照組。
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { SessionRegistry } from '@nexus/core';
import { afterEach, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { createCordisRoot } from './cordis-root.js';
import type { CordisRoot } from './cordis-root.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { toAgentInvocation } from './messages.js';
import { isBridgeEntry, loadDefaultPlugins } from './plugin-config.js';
import type { ScriptedChatModel } from './scripted-model.js';

const BASELINE = new URL('./quickjs-migration.baseline.json', import.meta.url);
const RUN_JAVASCRIPT = 'run_javascript';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const cases: readonly (readonly [string, unknown, Record<string, number>])[] = [
  ['回傳值', { code: '1 + 1' }, {}],
  ['沒有回傳值', { code: 'const x = 1;' }, {}],
  ['async', { code: '(async () => 41 + 1)()' }, {}],
  ['字串', { code: '"嗨"' }, {}],
  ['物件', { code: '({ a: [1, { b: 2 }], c: "d" })' }, {}],
  ['拋例外', { code: 'throw new TypeError("壞了")' }, {}],
  ['reject', { code: 'Promise.reject(new RangeError("拒絕了"))' }, {}],
  ['逾時', { code: 'while (true) {}' }, { timeoutMs: 200 }],
  ['不會完成的 promise', { code: 'new Promise(() => {})' }, {}],
  ['不是無損 JSON', { code: 'NaN' }, {}],
  ['記憶體上限', { code: 'const a = []; for (;;) a.push(new Array(1e5).fill(1));' }, {}],
  ['堆疊上限', { code: 'function f(n) { return f(n + 1) + 1; } f(0);' }, {}],
  ['參數型別不對', { code: 1 }, {}],
  ['少參數', {}, {}],
  ['多一個鍵', { code: '1', extra: 1 }, {}],
];

/** 疊在出貨清單上的那一份 patch：插一列 quickjs、換掉腳本模型的 `turns`。 */
function overlay(dir: string, args: unknown, config: Record<string, number>): string {
  const turns = [
    { content: '', toolCalls: [{ name: RUN_JAVASCRIPT, args, id: 'c1' }] },
    { content: '收工。' },
  ];
  const text =
    `- insert:\n    - id: quickjs\n      name: '@nexus/plugin-quickjs'\n      config: ${JSON.stringify(config)}\n` +
    `- id: cli-script\n  config: ${JSON.stringify({ turns })}\n`;
  const file = join(dir, 'overlay.yml');
  writeFileSync(file, text);
  return file;
}

async function runOne(
  root: CordisRoot,
  args: unknown,
  config: Record<string, number>,
): Promise<unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-quickjs-migration-'));
  chmodSync(dir, 0o700);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const loaded = await loadDefaultPlugins(
    { env: { [HARNESS_HOME_ENV]: dir }, patches: [overlay(dir, args, config)], warn: () => {} },
    { tree: root.tree },
  );
  expect(loaded.dropped).toEqual([]);
  // 錄對照組要在遷移前的樹上跑（見檔頭），那裡這一列不是橋接列，所以錄的時候不驗這一條。
  if (process.env.K3C_RECORD !== '1') {
    const row = loaded.plugins.find((entry) => entry.id === 'quickjs');
    expect(row !== undefined && isBridgeEntry(row)).toBe(true);
  }
  const built = await createCliAgent({ live: false }, loaded.plugins);
  const sessions = new SessionRegistry('quickjs');
  const detach = built.attachSession(sessions);
  try {
    await built.agent.invoke(toAgentInvocation('跑。'), { configurable: { thread_id: 'quickjs' } });
  } finally {
    detach();
    await built.dispose();
  }
  const model = built.model as ScriptedChatModel;
  const bound = (model.boundTools ?? []) as StructuredToolInterface[];
  const tool = bound.find((entry) => entry.name === RUN_JAVASCRIPT);
  const prompt = (model.prompts[1] ?? []) as readonly BaseMessage[];
  const message = prompt.find((entry): entry is ToolMessage => ToolMessage.isInstance(entry));
  const rootLog = sessions.list().find((entry) => entry.address.kind === 'root');
  return {
    wire: tool === undefined ? undefined : JSON.stringify(convertToOpenAITool(tool)),
    seen:
      message === undefined
        ? undefined
        : {
            content: message.content,
            status: message.status,
            name: message.name,
            id: message.tool_call_id,
          },
    logged: (rootLog?.log.events ?? []).flatMap((event) =>
      event.type === 'tool/result'
        ? [{ isError: event.data.isError, error: event.data.error }]
        : [],
    ),
  };
}

it('run_javascript 的工具定義、結果與日誌，與對照組逐字相同', { timeout: 180_000 }, async () => {
  const root = createCordisRoot();
  cleanups.push(() => root.dispose());
  const now: Record<string, unknown> = {};
  for (const [label, args, config] of cases) now[label] = await runOne(root, args, config);
  if (process.env.K3C_RECORD === '1') {
    writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`);
    return;
  }
  const before = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, unknown>;
  expect(Object.keys(now)).toEqual(Object.keys(before));
  for (const key of Object.keys(before)) expect(now[key], key).toEqual(before[key]);
});
