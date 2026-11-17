/**
 * 注入源放不下時在產品路徑上的樣子（[#2929](https://github.com/DemianLi/nexus-agent/issues/2929)）：技能目錄、記憶檔的延後，
 * 與必要來源超過上限時的失敗。
 *
 * 用真的 `createCordisRoot`、真的 `loadDefaultPlugins`、真的 `root.boot`，只有模型是照稿回話的替身。各源自己的算法在各自套件的
 * 單元測試；這裡量的是它們接上出貨清單之後，送給模型的那一份與 `context/measure` 記下的那一筆。
 * agent-instructions 與技能叫用正文的同一件事在 `skill-invocation-on-tree.test.ts`。
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionRegistry } from '@nexus/core';
import type { PluginEntry } from '@nexus/core';
import { createMemoryPlugin } from '@nexus/plugin-memory';
import { afterEach, describe, expect, it } from 'vitest';

import { createCordisRoot, entryApprovalChannel } from './cordis-root.js';
import type { CordisRoot, NexusAssembly } from './cordis-root.js';
import { withScriptedModel } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { toAgentInvocation } from './messages.js';
import { loadDefaultPlugins } from './plugin-config.js';
import type { LoadedPluginConfig } from './plugin-config.js';
import type { ScriptedChatModel } from './scripted-model.js';
import { SystemPromptBudgetError } from './system-prompt-middleware.js';

const temporary: string[] = [];
const roots: CordisRoot[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await root.dispose().catch(() => {});
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-injection-deferral-'));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return dir;
}

/** 工作區：路徑 → 內容。 */
function workspace(files: Record<string, string>): string {
  const root = scratch();
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content, 'utf8');
  }
  return root;
}

function home(patch?: string): NodeJS.ProcessEnv {
  const dir = scratch();
  if (patch !== undefined) writeFileSync(join(dir, 'cordis.patch.yml'), patch, { mode: 0o600 });
  return { [HARNESS_HOME_ENV]: dir };
}

interface Booted {
  readonly loaded: LoadedPluginConfig;
  readonly assembly: NexusAssembly;
}

async function boot(env: NodeJS.ProcessEnv): Promise<Booted> {
  const root = createCordisRoot({ channel: entryApprovalChannel(undefined), contained: true });
  roots.push(root);
  const loaded = await loadDefaultPlugins({ env, warn: () => {} }, { tree: root.tree });
  return { loaded, assembly: await root.boot('serve', { plugins: loaded.plugins }) };
}

interface Source {
  readonly id: string;
  readonly bytes: number;
  readonly limit?: number;
  readonly deferredBytes?: number;
}

/** 說一句話，回送給模型的系統提示各塊與 `context/measure` 記下的各源。 */
async function sayOnce(
  booted: Booted,
  ws: string,
  extra: readonly PluginEntry[] = [],
): Promise<{ readonly system: readonly string[]; readonly sources: readonly Source[] }> {
  const built = await booted.assembly.create(
    { live: false, workspace: ws, sandbox: 'workspace-write' as const },
    { plugins: withScriptedModel([...booted.loaded.plugins, ...extra], [{ content: '好。' }]) },
  );
  const sessions = new SessionRegistry('t');
  const attachment = built.attachSessions(sessions);
  try {
    await built.agent.invoke(toAgentInvocation('你好'), { configurable: { thread_id: 't' } });
    const sent = (built.model as ScriptedChatModel).prompts[0] ?? [];
    const log = sessions.list().find((item) => item.address.kind === 'root')!.log;
    return {
      system: (sent[0]!.content as readonly { readonly text: string }[]).map((part) => part.text),
      sources: log.events
        .filter((event) => event.type === 'context/measure')
        .flatMap((event) => (event.data as { sources?: Source[] }).sources ?? []),
    };
  } finally {
    await attachment.detach();
    await built.dispose();
  }
}

const bytesOf = (text: string) => Buffer.byteLength(text, 'utf8');

describe('技能目錄放不下：尾端的條目照列，其餘換成一行指標', () => {
  it('serve 的樹：整段不超過 32768 位元組，sources 上那一列有 deferredBytes', async () => {
    // 40 則、每則說明 1000 個位元組：整段四萬多，超過 32768。
    const names = Array.from(
      { length: 40 },
      (_, index) => `skill-${String(index).padStart(2, '0')}`,
    );
    const ws = workspace(
      Object.fromEntries(
        names.map((name) => [
          `skills/${name}/SKILL.md`,
          `---\nname: ${name}\ndescription: ${'d'.repeat(1000)}\n---\n\n步驟。\n`,
        ]),
      ),
    );
    const { system, sources } = await sayOnce(await boot(home()), ws);

    const section = system.find((text) => text.startsWith('## Skills System'))!;
    expect(bytesOf(section)).toBeLessThanOrEqual(32_768);
    const pointer =
      /- \((\d+) more skills not listed: skills section budget 32768 bytes\. List `\/skills\/` with ls and read a SKILL\.md with read_file\.\)/.exec(
        section,
      );
    expect(pointer).not.toBeNull();
    const dropped = Number(pointer![1]);
    expect(dropped).toBeGreaterThan(0);
    const listed = names.filter((name) => section.includes(`**${name}**`));
    expect(listed).toEqual(names.slice(dropped));

    const row = sources.find((source) => source.id === 'skill-catalog')!;
    expect(row).toEqual({
      id: 'skill-catalog',
      bytes: bytesOf(section),
      limit: 32_768,
      deferredBytes: row.deferredBytes,
    });
    // 沒列的每一條至少有那 1000 個位元組的說明。
    expect(row.deferredBytes).toBeGreaterThan(dropped * 1000);
  }, 60000);
});

describe('記憶檔放不下：那一份整份不放、原地留一行指標，放得下的照放', () => {
  it('serve 的樹：40000 位元組的那一份延後，後面小的那一份原樣，sources 上那一列有 deferredBytes', async () => {
    const ws = workspace({
      'AGENTS.md': '規矩。',
      'notes/big.md': 'm'.repeat(40_000),
      'notes/small.md': '代號胡桃。',
    });
    const memory = createMemoryPlugin({ sources: ['/notes/big.md', '/notes/small.md'] });
    const { system, sources } = await sayOnce(await boot(home()), ws, [memory]);

    const section = system.find((text) => text.includes('<agent_memory>'))!;
    expect(section).toContain(
      '/notes/big.md\n(Not loaded: 40000 bytes, memory section budget 32768 bytes. Read it with read_file when you need it.)',
    );
    expect(section).not.toContain('mmmm');
    expect(section).toContain('/notes/small.md\n代號胡桃。');
    expect(sources.find((source) => source.id === 'memory')).toEqual({
      id: 'memory',
      bytes: bytesOf(section),
      limit: 32_768,
      deferredBytes: 40_000,
    });
  }, 60000);
});

describe('必要來源超過上限：不截斷也不延後，失敗並說出是哪一段', () => {
  it('serve 的樹：系統提示前段超過 16384 位元組，組 thread 失敗，原因是 SystemPromptBudgetError', async () => {
    const patch = `- id: system-prompt\n  config:\n    personaPrefix: '${'a'.repeat(16_385)}'\n`;
    const booted = await boot(home(patch));
    expect(booted.loaded.dropped).toEqual([]);
    const create = booted.assembly.create(
      { live: false, workspace: workspace({ 'AGENTS.md': '規矩。' }) },
      { plugins: withScriptedModel([...booted.loaded.plugins], [{ content: '好。' }]) },
    );
    const error = await create.then(
      () => undefined,
      (reason: unknown) => reason as Error,
    );
    // 樹把它包成「apply 失敗」那一句，原來的錯在 cause。
    expect(error?.cause).toBeInstanceOf(SystemPromptBudgetError);
    expect(error?.message).toMatch(/系統提示詞的前段有 \d+ 個 UTF-8 位元組，超過上限 16384/);
  }, 60000);

  it('讀清單：計劃模式的 guidance 超過 16384 位元組，那一列掉了，訊息說超過多少', async () => {
    const patch = `- id: plan-mode\n  config:\n    guidance: '${'g'.repeat(16_385)}'\n`;
    const root = createCordisRoot({ channel: entryApprovalChannel(undefined), contained: true });
    roots.push(root);
    const loaded = await loadDefaultPlugins(
      { env: home(patch), warn: () => {} },
      { tree: root.tree },
    );
    const drop = loaded.dropped.find((item) => item.id === 'plan-mode');
    expect(drop?.message).toContain('guidance 超過 16384 個 UTF-8 位元組');
    expect(drop?.stage).toBe('config');
  }, 60000);
});
