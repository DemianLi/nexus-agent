/**
 * 評測的組裝就是 serve 一條 thread 組出來的那一份（[#3011](https://github.com/DemianLi/nexus-agent/issues/3011)）。
 *
 * 量的是三件事：
 *
 * 1. **同一份**：評測記下的 `request/system` 與工具，跟 serve 的入口順序（讀清單帶樹 → 建根 → `assembly.create` → 接日誌）
 *    組出來、送到模型手上的逐位元組相同。對照組是真的 serve 路徑，不是同一個函式叫兩次。
 * 2. **記得到**：每次模型呼叫都記 `request/system`、工具名稱與雜湊、token；中途拋錯的執行已記的留得住。
 * 3. **會變**：不改提示詞時兩次相同，出貨提示詞換一句後不同——雜湊不是常數。
 *
 * `time-context` 在系統提示詞之外另送一則帶牆鐘時間的使用者訊息，不進 `request/system`；這裡照樣把 `Date` 固定住，
 * 免得之後有人把時間搬進系統提示詞時這一檔靜靜變成每次都不同。
 */

import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BaseMessage } from '@langchain/core/messages';
import { SessionRegistry } from '@nexus/core';
import type { PluginEntry } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCordisRoot, entryApprovalChannel } from '../cordis-root.js';
import type { CordisRoot } from '../cordis-root.js';
import { withScriptedModel } from '../fixtures.js';
import { HARNESS_HOME_ENV } from '../harness-home.js';
import { toAgentInvocation } from '../messages.js';
import { loadDefaultPlugins } from '../plugin-config.js';
import { ScriptedChatModel } from '../scripted-model.js';
import type { ScriptedTurn } from '../scripted-model.js';
import { BENCHMARK, BENCHMARK_FILE } from './dataset.js';
import type { BenchmarkCase } from './dataset.js';
import { systemPromptVersion } from './result-file.js';
import { runBenchmarkCase, shippedSystemPrompt } from './runner.js';
import type { ModelCallRecord } from './runner.js';

const T0 = Date.parse('2026-11-27T01:00:00Z');
const temporary: string[] = [];
const roots: CordisRoot[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) await root.dispose().catch(() => {});
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return dir;
}

const WRITE_THEN_READ = BENCHMARK.find((entry) => entry.id === 'write-then-read') as BenchmarkCase;

/** `write-then-read` 的標準解，每一輪都給 usage。 */
const STANDARD: readonly ScriptedTurn[] = [
  {
    content: '先寫。',
    toolCalls: [{ name: 'write_file', args: { file_path: BENCHMARK_FILE, content: '第二次' } }],
    usage: { inputTokens: 140, outputTokens: 22 },
  },
  {
    content: '再讀回來。',
    toolCalls: [{ name: 'read_file', args: { file_path: BENCHMARK_FILE } }],
    usage: { inputTokens: 190, outputTokens: 16 },
  },
  { content: '裡面是「第二次」。', usage: { inputTokens: 230, outputTokens: 12 } },
];

async function record(
  turns: readonly ScriptedTurn[],
  plugins?: readonly PluginEntry[],
): Promise<readonly ModelCallRecord[]> {
  const calls: ModelCallRecord[] = [];
  await runBenchmarkCase(WRITE_THEN_READ, {
    model: new ScriptedChatModel({ turns }),
    calls,
    ...(plugins === undefined ? {} : { plugins }),
  });
  return calls;
}

/** 出貨清單（serve 層）疊一份 patch，persona 前綴那一句換成別的，其餘一列不動——部署方換一句提示詞的真路徑。 */
async function withPersona(prefix: string): Promise<readonly PluginEntry[]> {
  const home = scratch('nexus-eval-persona-');
  const patch = join(home, 'persona.patch.yml');
  writeFileSync(
    patch,
    [
      '- id: system-prompt',
      '  config:',
      '    includeHarnessIdentity: true',
      `    personaPrefix: '${prefix}'`,
      "    personaSuffix: 'Your working directory is {{cwd}}.'",
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  const { plugins } = await loadDefaultPlugins({
    serve: true,
    env: { [HARNESS_HOME_ENV]: home },
    patches: [patch],
    warn: () => {},
  });
  return plugins;
}

function systemTextOf(prompt: readonly BaseMessage[]): string {
  return prompt
    .filter((message) => message.getType() === 'system')
    .map((message) => message.text)
    .join('\n\n');
}

describe('每次模型呼叫都記下請求與用量', () => {
  it('三輪就三筆：request/system 全文、工具名稱與雜湊、輸入／輸出 token', async () => {
    const calls = await record(STANDARD);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.system).toContain('You are an AI agent powered by nexus-agent.');
      expect(call.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['write_file', 'read_file', 'edit_file', 'grep']),
      );
      for (const tool of call.tools) expect(tool.hash).toMatch(/^[0-9a-f]{12}$/);
    }
    expect(calls.map((call) => [call.inputTokens, call.outputTokens])).toEqual([
      [140, 22],
      [190, 16],
      [230, 12],
    ]);
    expect(new Set(calls.map((call) => call.system)).size).toBe(1);
    expect(new Set(calls.map((call) => JSON.stringify(call.tools))).size).toBe(1);
  });

  it('中途拋錯的執行：已記的留得住，而且有輸入／輸出 token', async () => {
    const calls: ModelCallRecord[] = [];
    await expect(
      runBenchmarkCase(WRITE_THEN_READ, {
        model: new ScriptedChatModel({
          turns: [STANDARD[0] as ScriptedTurn, { content: '', error: '端點掛了' }],
        }),
        calls,
      }),
    ).rejects.toThrow();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]?.system).toContain('nexus-agent');
    expect(calls[0]?.inputTokens).toBe(140);
    expect(calls.at(-1)?.inputTokens).toBeUndefined();
  });

  it('模型沒回報用量：token 是 undefined，不是 0', async () => {
    const calls = await record([{ content: '好。' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.inputTokens).toBeUndefined();
    expect(calls[0]?.outputTokens).toBeUndefined();
  });
});

describe('request/system 會隨出貨提示詞變、不改就不變', () => {
  it('同一題跑兩次：request/system 與工具雜湊逐位元組相同', async () => {
    const first = await record(STANDARD);
    const second = await record(STANDARD);
    expect(second.map((call) => call.system)).toEqual(first.map((call) => call.system));
    expect(second.map((call) => call.tools)).toEqual(first.map((call) => call.tools));
  });

  it('出貨提示詞換一句：request/system 不同，結果檔的雜湊跟著不同', async () => {
    const before = await record(STANDARD);
    const changed = await withPersona('You are a terse assistant.');
    const after = await record(STANDARD, changed);
    expect(after[0]?.system).not.toBe(before[0]?.system);
    expect(after[0]?.system).toContain('You are a terse assistant.');
    expect(systemPromptVersion(after[0]?.system ?? '')).not.toBe(
      systemPromptVersion(before[0]?.system ?? ''),
    );
    expect(after[0]?.tools).toEqual(before[0]?.tools);
  });

  it('結果檔記的提示詞就是實際送出的那一份', async () => {
    const [sent] = await record([{ content: '好。' }]);
    expect(await shippedSystemPrompt()).toBe(sent?.system);
    const changed = await withPersona('You are a terse assistant.');
    expect(await shippedSystemPrompt(changed)).toContain('You are a terse assistant.');
  });
});

describe('跟 serve 組出來的是同一份', () => {
  /**
   * serve 的入口順序（`serve-run.ts`）：讀 serve 層的清單（帶樹）→ 建根（答題管道、有圍堵）→ `boot('serve')` →
   * 每條 thread `assembly.create`（私有根、共用區）→ 接會話日誌 → 說一句話。回模型收到的 system 文字與綁上的工具。
   */
  async function serveSends(turns: readonly ScriptedTurn[]) {
    const home = scratch('nexus-eval-serve-home-');
    const privateRoot = scratch('nexus-eval-serve-private-');
    const sharedRoot = scratch('nexus-eval-serve-shared-');
    const root = createCordisRoot({ channel: entryApprovalChannel(undefined), contained: true });
    roots.push(root);
    const loaded = await loadDefaultPlugins(
      { env: { [HARNESS_HOME_ENV]: home }, serve: true, warn: () => {} },
      { tree: root.tree },
    );
    const assembly = await root.boot('serve', { plugins: loaded.plugins });
    const built = await assembly.create(
      {
        live: false,
        workspace: sharedRoot,
        workspaceRoot: privateRoot,
        sharedWorkspaceRoot: sharedRoot,
      },
      { plugins: withScriptedModel(loaded.plugins, turns) },
    );
    const attachment = built.attachSessions(new SessionRegistry('serve-thread'));
    try {
      await built.agent.invoke(toAgentInvocation(WRITE_THEN_READ.prompt), {
        configurable: { thread_id: 'serve-thread' },
      });
      const model = built.model as ScriptedChatModel;
      return {
        prompts: model.prompts,
        toolNames: model.boundToolNames,
      };
    } finally {
      await attachment.detach();
      await built.dispose();
    }
  }

  it('每一輪的 system 文字逐位元組相同，工具名稱的集合與順序相同', async () => {
    const served = await serveSends(STANDARD);
    const ours = await record(STANDARD);
    expect(served.prompts).toHaveLength(ours.length);
    expect(ours.map((call) => call.system)).toEqual(
      served.prompts.map((prompt) => systemTextOf(prompt)),
    );
    expect(ours[0]?.tools.map((tool) => tool.name)).toEqual(served.toolNames);
  }, 60_000);
});

describe('評測的程式碼裡沒有舊的組裝', () => {
  it('BENCHMARK_SYSTEM_PROMPT 與 echo 外掛不在評測的非測試檔裡', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const sources = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map((name) => [name, readFileSync(join(dir, name), 'utf8')] as const);
    expect(sources.length).toBeGreaterThan(5);
    const code = (text: string): string =>
      text
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line))
        .join('\n');
    const offending = sources
      .filter(([, text]) =>
        /BENCHMARK_SYSTEM_PROMPT|createEchoPlugin|benchmarkPlugins/u.test(code(text)),
      )
      .map(([name]) => name);
    expect(offending).toEqual([]);
  });
});
