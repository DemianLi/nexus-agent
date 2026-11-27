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

import { tagModelRoute } from '@nexus/core';
import type { PluginEntry } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { foldTurn, serveClient } from '../fixtures.js';
import { startScriptedServe } from '../scripted-serve.js';
import { closedSessionEvents, sessionOf } from '../session-files.fixture.js';
import { HARNESS_HOME_ENV } from '../harness-home.js';
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(async () => {
  vi.useRealTimers();
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
  modelId?: string,
): Promise<readonly ModelCallRecord[]> {
  const calls: ModelCallRecord[] = [];
  const scripted = new ScriptedChatModel({ turns });
  await runBenchmarkCase(WRITE_THEN_READ, {
    model: modelId === undefined ? scripted : tagModelRoute(scripted, { model: modelId }),
    calls,
    ...(plugins === undefined ? {} : { plugins }),
  });
  return calls;
}

/** 出貨清單（serve 層）疊一份 patch：部署方改設定的真路徑。 */
async function withPatch(patchText: string): Promise<readonly PluginEntry[]> {
  const home = scratch('nexus-eval-patch-');
  const patch = join(home, 'eval.patch.yml');
  writeFileSync(patch, patchText, { mode: 0o600 });
  const { plugins } = await loadDefaultPlugins({
    serve: true,
    env: { [HARNESS_HOME_ENV]: home },
    patches: [patch],
    warn: () => {},
  });
  return plugins;
}

/** persona 前綴那一句換成別的，其餘一列不動。 */
function withPersona(prefix: string): Promise<readonly PluginEntry[]> {
  return withPatch(
    [
      '- id: system-prompt',
      '  config:',
      '    includeHarnessIdentity: true',
      `    personaPrefix: '${prefix}'`,
      "    personaSuffix: 'Your working directory is {{cwd}}.'",
      '',
    ].join('\n'),
  );
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

describe('真模型貼了型號標籤：{{model}} 換成它的 id，結果檔跟著模型記', () => {
  const REAL = 'vendor/real-model-x';

  it('貼標籤的實例送出的 request/system 帶真型號，shippedSystemPrompt(模型 id) 記到同一份', async () => {
    const [sent] = await record([{ content: '好。' }], undefined, REAL);
    const [plain] = await record([{ content: '好。' }]);
    expect(sent?.system).toContain(`powered by the ${REAL} model`);
    expect(sent?.system).not.toBe(plain?.system);
    expect(await shippedSystemPrompt(undefined, REAL)).toBe(sent?.system);
    expect(await shippedSystemPrompt()).toBe(plain?.system);
  });

  it('兩個模型的雜湊不同，各自對得上自己送出的那一份', async () => {
    const other = 'vendor/real-model-y';
    const [first] = await record([{ content: '好。' }], undefined, REAL);
    const [second] = await record([{ content: '好。' }], undefined, other);
    expect(systemPromptVersion(first?.system ?? '')).not.toBe(
      systemPromptVersion(second?.system ?? ''),
    );
    expect(await shippedSystemPrompt(undefined, other)).toBe(second?.system);
  });
});

describe('跟 serve 組出來的是同一份', () => {
  /**
   * 真的 `runServe`（`startScriptedServe`：出貨清單、真的 wire client、真的落盤），模型換成同一份腳本，說一句話，
   * 從這條 thread 的會話日誌讀 `request/system`——那是 serve 實際送出的系統提示詞（日誌記的是模型被叫那一刻的全文）。
   * 對照組不自己拼 `assembly.create` 的參數：serve 傳哪幾格由 `serve-run.ts` 決定，這裡只看它送出了什麼。
   */
  async function serveSends(turns: readonly ScriptedTurn[], extraRows = ''): Promise<string[]> {
    const logs = scratch('nexus-eval-serve-logs-');
    const workspace = scratch('nexus-eval-serve-ws-');
    const serve = await startScriptedServe(turns, {
      workspace,
      extraRows,
      argv: ['--session-log', logs],
    });
    try {
      const client = await serveClient(serve.running);
      const events = await client.openEvents('eval-thread');
      expect((await client.runStart('eval-thread', WRITE_THEN_READ.prompt)).type).toBe('success');
      await foldTurn(events);
      await events.return?.(undefined);
    } finally {
      await serve.close();
    }
    const root = await sessionOf(logs, 'eval-thread');
    return (await closedSessionEvents(root))
      .filter((event) => event.type === 'request/system')
      .map((event) => (event.data as { system: string }).system);
  }

  it('serve 實際送出的 request/system 跟評測記下的逐位元組相同', async () => {
    const served = await serveSends(STANDARD);
    const ours = await record(STANDARD);
    expect(served).toHaveLength(1);
    expect(new Set(ours.map((call) => call.system))).toEqual(new Set(served));
  }, 90_000);

  it('出廠是背景續行：serve 與評測的系統提示詞都帶 subagent 那一句，工具是 subagent 不是 task', async () => {
    const [sent] = await serveSends(STANDARD);
    const ours = await record(STANDARD);
    expect(sent).toContain('`subagent`');
    expect(ours[0]?.system).toContain('`subagent`');
    const names = ours[0]?.tools.map((tool) => tool.name) ?? [];
    expect(names).toContain('subagent');
    expect(names).not.toContain('task');
  }, 90_000);

  it('serve 改成 one-shot：兩邊一起跟著變，仍然逐位元組相同', async () => {
    const patch = [
      '- id: background-subagents',
      '  config:',
      '    backgroundMode: one-shot',
      '',
    ].join('\n');
    const served = await serveSends(STANDARD, patch);
    const ours = await record(STANDARD, await withPatch(patch));
    expect(served).toHaveLength(1);
    expect(served[0]).not.toContain('`subagent`');
    expect(new Set(ours.map((call) => call.system))).toEqual(new Set(served));
    expect(ours[0]?.tools.map((tool) => tool.name)).toContain('task');
  }, 90_000);
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
