/**
 * 薄測試：listener 讀得到什麼、什麼時候不加（backend 是替身，不經過 agent），加上樹上這一列（#1474）的接線與一致性。
 *
 * **基線真的有沒有進到模型、會不會重複**的驗收在組裝點（`apps/harness/src/agent-instructions.test.ts`），
 * 而且那裡用的是零設定的出貨清單（`apps/harness/cordis.yml`）。**摘要之後的判準**（宿主算 `effectiveMessages` 再交給 listener）
 * 在 `apps/harness/src/pre-step-middleware.test.ts`。兩件事。
 *
 * **測試檔不受 SDK lint 管**（`PLUGIN_LINT_IGNORES`），所以這裡可以 import `@nexus/core`；`src/index.ts` 不行。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { agentLoopToken } from '@nexus/agent-loop';
import type { PreStepInjection, PreStepInvocation } from '@nexus/agent-loop';
import { createAgentLoopProvider } from '@nexus/agent-loop/provider';
import { toolCallSessionAddress } from '@nexus/core';
import type { FsService } from '@nexus/core';
import { Context } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import type { FsLookup } from '@nexus/fs';
import { createFsLookupProvider } from '@nexus/fs/provider';
import { checkConformance } from '@nexus/sdk';
import { CompositeBackend, FilesystemBackend, StateBackend } from 'deepagents';
import { afterEach, describe, expect, it } from 'vitest';

import * as module from './index.js';
import {
  AGENT_INSTRUCTIONS_MARKER,
  AGENT_INSTRUCTIONS_MIDDLEWARE_NAME,
  agentInstructionsConfigSchema,
  Config,
  createAgentInstructionsListener,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_SOURCE_BYTES,
  INSTRUCTION_FILE_CANDIDATES,
  isAgentInstructionsMessage,
} from './index.js';

/** 出廠的兩個上限。 */
const LIMITS = { maxBytes: DEFAULT_MAX_BYTES, maxSourceBytes: DEFAULT_MAX_SOURCE_BYTES };

/** 只回得出指定那幾個檔的假 backend；其餘一律「讀不到」。 */
function fakeBackend(files: Record<string, string>) {
  return {
    read: (path: string) =>
      Object.prototype.hasOwnProperty.call(files, path)
        ? Promise.resolve({ content: files[path] })
        : Promise.resolve({ error: 'file_not_found' }),
  };
}

/** fs 把手的替身：只有 `backend()` 有意義。 */
function handleOf(backend: unknown): FsService {
  return {
    backend: () => backend as never,
    offWorkspacePrefixes: () => [],
    hasWorkspace: () => true,
    workspaceRoot: () => undefined,
    sharedWorkspacePrefix: () => undefined,
    skillSources: () => [],
  };
}

/** root 的 `beforeAgent`：`checkpoint_ns` 只有節點自己那一段（同圖裡的樣子）。 */
const ROOT_NS = 'AgentInstructionsMiddleware.before_agent:1';
const INVOCATION: PreStepInvocation = { configurable: { thread_id: 't', checkpoint_ns: ROOT_NS } };

/** 查找一律成功、把手帶這份 backend 的 listener。 */
async function inject(
  files: Record<string, string>,
  messages: readonly BaseMessage[] = [],
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<readonly PreStepInjection[] | undefined> {
  const handle = handleOf(fakeBackend(files));
  const listener = createAgentInstructionsListener(
    { ...LIMITS, maxBytes },
    {
      fs: () => ({ kind: 'ok', fs: handle, address: { kind: 'root' } }),
    },
  );
  return listener(messages, INVOCATION);
}

function baselineMessage(): HumanMessage {
  return new HumanMessage({
    content: '舊的基線',
    additional_kwargs: { [AGENT_INSTRUCTIONS_MARKER]: true },
  });
}

describe('設定', () => {
  it('合法的覆寫會生效——上限換小之後，同一份基線就被截了', async () => {
    const long = 'x'.repeat(200);
    const full = await inject({ '/AGENTS.md': long });
    const capped = await inject({ '/AGENTS.md': long }, [], 32);

    expect(String(full?.[0]?.content)).toContain(long);
    expect(String(capped?.[0]?.content)).not.toContain(long);
  });

  // **翻面過的絆索**（#453）：驗在載入的時候，訊息因此指得出條目。
  // dsh 拿非正數當「關掉」，我們這側不留那條路——一個看起來像設定值的 `0` 靜靜關掉整個功能
  // 是那種沒有人會發現的失敗。
  it('上限不是正的有限數就讓設定驗證失敗，不會靜默變成「沒有工作區指令」', () => {
    for (const maxBytes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = agentInstructionsConfigSchema.safeParse({ maxBytes });
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain('maxBytes');
    }
    expect(Config).toBe(agentInstructionsConfigSchema);
    expect(Config.parse({}).maxBytes).toBe(DEFAULT_MAX_BYTES);
    expect(Config.safeParse({ extra: 1 }).success).toBe(false);
  });

  it('單檔上限要是正整數（照 dsh `.step(1).min(1)`），不是就讓設定驗證失敗、訊息指得出欄位；省略是 1 MiB', () => {
    for (const maxSourceBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = agentInstructionsConfigSchema.safeParse({ maxSourceBytes });
      expect(result.success, String(maxSourceBytes)).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain('maxSourceBytes');
    }
    expect(DEFAULT_MAX_SOURCE_BYTES).toBe(1_048_576);
    expect(Config.parse({}).maxSourceBytes).toBe(DEFAULT_MAX_SOURCE_BYTES);
    expect(Config.parse({ maxSourceBytes: 1 }).maxSourceBytes).toBe(1);
  });
});

describe('讀工作區根那一層', () => {
  it('四個候選依序讀：基礎檔在前、local overlay 在後', async () => {
    expect([...INSTRUCTION_FILE_CANDIDATES]).toEqual([
      'AGENTS.md',
      'CLAUDE.md',
      'AGENTS.local.md',
      'CLAUDE.local.md',
    ]);
    const injections = await inject({
      '/AGENTS.md': '一。',
      '/CLAUDE.md': '二。',
      '/AGENTS.local.md': '三。',
      '/CLAUDE.local.md': '四。',
    });
    const text = injections?.[0]?.content ?? '';
    const order = INSTRUCTION_FILE_CANDIDATES.map((name) =>
      text.indexOf(`Instructions from: ${name}`),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order]).toEqual([...order].sort((left, right) => left - right));
  });

  it('一個候選都讀不到就不加訊息', async () => {
    expect(await inject({})).toBeUndefined();
  });

  it('空檔與不存在同形——空字串不值得佔一個標頭', async () => {
    expect(await inject({ '/AGENTS.md': '' })).toBeUndefined();
  });

  it('backend 拋錯不會把這一輪弄倒，只是少了那一份', async () => {
    const backend = {
      read: (path: string) =>
        path === '/AGENTS.md'
          ? Promise.reject(new Error('backend 壞了'))
          : Promise.resolve({ content: '還在。' }),
    };
    const listener = createAgentInstructionsListener(LIMITS, {
      fs: () => ({ kind: 'ok', fs: handleOf(backend), address: { kind: 'root' } }),
    });
    const injections = await listener([], INVOCATION);
    expect(injections?.[0]?.content).toContain('Instructions from: CLAUDE.md');
    expect(injections?.[0]?.content).not.toContain('Instructions from: AGENTS.md');
  });

  it('同一層內容相同（去掉首尾空白之後）的只渲染一次，留先出現的那個路徑', async () => {
    const injections = await inject({ '/AGENTS.md': '同一份。', '/CLAUDE.md': '  同一份。\n' });
    const text = injections?.[0]?.content ?? '';
    expect(text).toContain('Instructions from: AGENTS.md');
    expect(text).not.toContain('Instructions from: CLAUDE.md');
  });

  it('回的那一則帶記號，來源標成給模型的指示（#1567 N0136）', async () => {
    const injections = await inject({ '/AGENTS.md': '規矩。' });
    expect(injections).toHaveLength(1);
    expect(injections?.[0]?.additionalKwargs).toEqual({ [AGENT_INSTRUCTIONS_MARKER]: true });
    expect(injections?.[0]?.source).toEqual({
      kind: 'plugin',
      plugin: AGENT_INSTRUCTIONS_MIDDLEWARE_NAME,
      form: 'instructions',
    });
  });
});

describe('新 thread 讀唯讀共用區（#1775）', () => {
  /** 有共用區前綴的 fs 把手：私有根（`/`）與共用區（`/shared`）各有一份指示檔，內容不同。 */
  function handleWithShared(prefix: string | undefined, backend: unknown): FsService {
    return { ...handleOf(backend), sharedWorkspacePrefix: () => prefix };
  }
  const BACKEND = fakeBackend({
    '/AGENTS.md': 'PRIVATE-RULE',
    '/shared/AGENTS.md': 'DEPLOY-RULE',
  });
  const run = (prefix: string | undefined) =>
    createAgentInstructionsListener(LIMITS, {
      fs: () => ({ kind: 'ok', fs: handleWithShared(prefix, BACKEND), address: { kind: 'root' } }),
    })([], INVOCATION);

  it('有共用區前綴：部署方放在共用區的指示進基線，模型寫進私有根的 /AGENTS.md 不會', async () => {
    const text = (await run('/shared'))?.[0]?.content ?? '';
    expect(text).toContain('DEPLOY-RULE');
    expect(text).not.toContain('PRIVATE-RULE');
    // 標頭仍是候選檔名，不帶前綴（模型看到的是「Instructions from: AGENTS.md」）。
    expect(text).toContain('Instructions from: AGENTS.md');
  });

  it('沒有共用區前綴（舊 thread、沒有圍堵）：照舊讀 /', async () => {
    const text = (await run(undefined))?.[0]?.content ?? '';
    expect(text).toContain('PRIVATE-RULE');
    expect(text).not.toContain('DEPLOY-RULE');
  });
});

/**
 * 帶 `ls` 的替身：`ls` 回那個目錄底下每個檔的 `size`（`sizes` 可以撒謊），`read` 記下讀了哪些路徑。
 * `lsFails` 讓 `ls` 回錯誤；`onRead` 在回內容之前跑（測「讀到一半被停下」）。
 */
function listingBackend(
  files: Record<string, string>,
  options: {
    readonly sizes?: Record<string, number>;
    readonly lsFails?: boolean;
    readonly onLs?: () => void;
    readonly onRead?: (path: string) => void;
  } = {},
) {
  const reads: string[] = [];
  const listed: string[] = [];
  return {
    reads,
    listed,
    ls: (path: string) => {
      listed.push(path);
      options.onLs?.();
      if (options.lsFails === true) return Promise.resolve({ error: 'ls 壞了' });
      const prefix = path === '/' ? '' : path;
      return Promise.resolve({
        files: Object.entries(files)
          .filter(([file]) => file.startsWith(`${prefix}/`))
          .map(([file, content]) => ({
            path: file,
            is_dir: false,
            size: options.sizes?.[file] ?? Buffer.byteLength(content, 'utf8'),
          })),
      });
    },
    read: (path: string) => {
      reads.push(path);
      options.onRead?.(path);
      return Object.prototype.hasOwnProperty.call(files, path)
        ? Promise.resolve({ content: files[path] })
        : Promise.resolve({ error: 'file_not_found' });
    },
  };
}

/** 照這兩個上限、這個共用區前綴、這顆中止訊號跑一次 listener。 */
function listen(
  backend: unknown,
  limits: { maxBytes: number; maxSourceBytes: number },
  options: { readonly prefix?: string; readonly signal?: AbortSignal } = {},
) {
  const handle: FsService = { ...handleOf(backend), sharedWorkspacePrefix: () => options.prefix };
  return createAgentInstructionsListener(limits, {
    fs: () => ({ kind: 'ok', fs: handle, address: { kind: 'root' } }),
  })([], { ...INVOCATION, ...(options.signal !== undefined && { signal: options.signal }) });
}

describe('讀整份，單檔有上限（#1533，照 dsh `files.ts:387-417`）', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function workspace(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'agent-instructions-'));
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return dir;
  }
  const RULES = Array.from({ length: 600 }, (_, index) => `rule ${index + 1}`).join('\n');

  // 替身不會補 500 行：這條一定要用基座真的 backend（卡上驗收 1）。
  it.each([
    ['裸的 FilesystemBackend', undefined],
    ['外面包一層 CompositeBackend（組裝點的形狀）', undefined],
    ['共用區前綴底下（新 thread，經 composite 的 /shared/ 路由）', '/shared'],
  ] as const)('600 行的 AGENTS.md，%s：讀到第 600 行，沒有截斷說明', async (label, prefix) => {
    const root = workspace({ 'AGENTS.md': RULES });
    const files = new FilesystemBackend({ rootDir: root, virtualMode: true });
    const backend = label.startsWith('裸的')
      ? files
      : prefix === undefined
        ? new CompositeBackend(files, { '/large_tool_results/': new StateBackend() })
        : new CompositeBackend(
            new FilesystemBackend({ rootDir: workspace({}), virtualMode: true }),
            {
              '/shared/': files,
            },
          );
    const text =
      (await listen(backend, LIMITS, prefix === undefined ? {} : { prefix }))?.[0]?.content ?? '';
    expect(text).toContain('rule 1\n');
    expect(text).toContain('rule 500\n');
    expect(text).toContain('rule 600');
    expect(text).not.toContain('Workspace instruction budget');
  });

  it.each([
    ['/', undefined],
    ['共用區前綴', '/shared'],
  ] as const)(
    '超過上限的不讀（%s）：ls 報的大小超過就跳過，對它一次 read 都沒有；其他照讀',
    async (_label, prefix) => {
      const at = prefix ?? '';
      const backend = listingBackend({
        [`${at}/AGENTS.md`]: 'a'.repeat(2048),
        [`${at}/CLAUDE.md`]: 'b'.repeat(100),
      });
      const text =
        (
          await listen(
            backend,
            { ...LIMITS, maxSourceBytes: 1024 },
            prefix === undefined ? {} : { prefix },
          )
        )?.[0]?.content ?? '';
      expect(text).toContain('Instructions from: CLAUDE.md');
      expect(text).not.toContain('Instructions from: AGENTS.md');
      expect(backend.listed).toEqual([prefix ?? '/']);
      expect(backend.reads).not.toContain(`${at}/AGENTS.md`);
      expect(backend.reads).toContain(`${at}/CLAUDE.md`);
    },
  );

  it('讀完那一道：ls 報的大小是小的、讀回來卻超過，照樣丟掉', async () => {
    const backend = listingBackend(
      { '/AGENTS.md': 'a'.repeat(2048) },
      { sizes: { '/AGENTS.md': 10 } },
    );
    expect(await listen(backend, { ...LIMITS, maxSourceBytes: 1024 })).toBeUndefined();
    expect(backend.reads).toContain('/AGENTS.md');
  });

  it('ls 回錯誤、或 backend 根本沒有 ls：每個候選照讀，超過的由讀完那一道擋下', async () => {
    const failing = listingBackend({ '/AGENTS.md': 'a'.repeat(2048) }, { lsFails: true });
    expect(await listen(failing, { ...LIMITS, maxSourceBytes: 1024 })).toBeUndefined();
    expect(failing.reads).toContain('/AGENTS.md');

    const noLs = fakeBackend({ '/AGENTS.md': 'a'.repeat(2048), '/CLAUDE.md': '留下。' });
    const text = (await listen(noLs, { ...LIMITS, maxSourceBytes: 1024 }))?.[0]?.content ?? '';
    expect(text).toContain('留下。');
    expect(text).not.toContain('Instructions from: AGENTS.md');
  });

  it('上限算的是 UTF-8 位元組不是字元：1000 個中文字（3000 位元組）過不了 2048；剛好等於上限的留下', async () => {
    const wide = listingBackend({ '/AGENTS.md': '中'.repeat(1000) }, { lsFails: true });
    expect(await listen(wide, { ...LIMITS, maxSourceBytes: 2048 })).toBeUndefined();

    const exact = listingBackend({ '/AGENTS.md': 'a'.repeat(1024) });
    const text = (await listen(exact, { ...LIMITS, maxSourceBytes: 1024 }))?.[0]?.content ?? '';
    expect(text).toContain('Instructions from: AGENTS.md');
  });
});

describe('這一輪被停下（invocation.signal，#1533）', () => {
  it('已經停下：拋中止原因（AbortError），連 ls 都沒做、一個候選都沒讀', async () => {
    const controller = new AbortController();
    controller.abort();
    const backend = listingBackend({ '/AGENTS.md': '規矩。' });
    await expect(listen(backend, LIMITS, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(backend.listed).toEqual([]);
    expect(backend.reads).toEqual([]);
  });

  it('讀第一個檔的時候被停下：拋中止，後面的候選不再讀', async () => {
    const controller = new AbortController();
    const backend = listingBackend(
      { '/AGENTS.md': '一。', '/CLAUDE.md': '二。' },
      { onRead: () => controller.abort() },
    );
    await expect(listen(backend, LIMITS, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(backend.reads).toEqual(['/AGENTS.md']);
  });

  it('ls 的時候被停下：拋中止，一個候選都沒讀（每個候選讀之前都看一次，dsh `files.ts:396`）', async () => {
    const controller = new AbortController();
    const backend = listingBackend({ '/AGENTS.md': '一。' }, { onLs: () => controller.abort() });
    await expect(listen(backend, LIMITS, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(backend.reads).toEqual([]);
  });

  it('讀最後一個候選的時候被停下：照樣拋中止，不把讀到的那幾份當成結果交回去', async () => {
    const controller = new AbortController();
    const last = INSTRUCTION_FILE_CANDIDATES[INSTRUCTION_FILE_CANDIDATES.length - 1];
    const backend = listingBackend(
      { '/AGENTS.md': '一。', [`/${last}`]: '最後。' },
      { onRead: (path) => path === `/${last}` && controller.abort() },
    );
    await expect(listen(backend, LIMITS, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(backend.reads.at(-1)).toBe(`/${last}`);
  });

  it('讀的時候拋錯而且這一輪已經停下：拋的是中止，不當成「讀不到」吞掉', async () => {
    const controller = new AbortController();
    const backend = {
      read: () => {
        controller.abort();
        return Promise.reject(new Error('串流被切斷'));
      },
    };
    await expect(listen(backend, LIMITS, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('沒有訊號（1.0.0 的宿主）照讀', async () => {
    const text = (await listen(listingBackend({ '/AGENTS.md': '規矩。' }), LIMITS))?.[0]?.content;
    expect(text).toContain('規矩。');
  });
});

describe('一個 agent 一份', () => {
  it('模型看得到的那一串裡已經有基線就不再加', async () => {
    const existing = baselineMessage();
    expect(isAgentInstructionsMessage(existing)).toBe(true);
    expect(await inject({ '/AGENTS.md': '規矩。' }, [existing])).toBeUndefined();
  });

  it('認的是記號不是文字：一則長得一模一樣但沒有記號的使用者訊息擋不住注入', async () => {
    const rendered = await inject({ '/AGENTS.md': '規矩。' });
    const copy = new HumanMessage({ content: rendered?.[0]?.content ?? '' });
    expect(isAgentInstructionsMessage(copy)).toBe(false);
    expect(await inject({ '/AGENTS.md': '規矩。' }, [copy])).toHaveLength(1);
  });

  it('摘要訊息本身不會被當成基線——它是判準唯一可能的假陽性來源', () => {
    const summary = new HumanMessage({
      content: '前情提要。',
      additional_kwargs: { lc_source: 'summarization' },
    });
    expect(isAgentInstructionsMessage(summary)).toBe(false);
  });
});

describe('什麼時候不注入（查找不是 ok、或沒有 backend）', () => {
  it.each<[string, FsLookup]>([
    ['not-attached', { kind: 'not-attached' }],
    ['unknown-caller', { kind: 'unknown-caller' }],
    ['ambiguous', { kind: 'ambiguous', count: 2 }],
  ])('fs 查找是 %s：不注入、不拋', async (_label, lookup) => {
    const listener = createAgentInstructionsListener(LIMITS, { fs: () => lookup });
    expect(await listener([], INVOCATION)).toBeUndefined();
  });

  it('把手在、但這次組裝一個 backend 都沒有：不注入', async () => {
    const listener = createAgentInstructionsListener(LIMITS, {
      fs: () => ({ kind: 'ok', fs: handleOf(undefined), address: { kind: 'root' } }),
    });
    expect(await listener([], INVOCATION)).toBeUndefined();
  });

  it('呼叫設定原樣交給 fs 查找，沒有被改形狀（交裸的 configurable 會變 unknown-caller）', async () => {
    const seen: unknown[] = [];
    const listener = createAgentInstructionsListener(LIMITS, {
      fs: (invocation) => {
        seen.push(invocation);
        return { kind: 'not-attached' };
      },
    });
    await listener([], INVOCATION);
    expect(seen).toEqual([INVOCATION]);
    expect(seen[0]).toBe(INVOCATION);
  });

  it('已經有基線時連 fs 都不查', async () => {
    let looked = 0;
    const listener = createAgentInstructionsListener(LIMITS, {
      fs: () => {
        looked += 1;
        return { kind: 'not-attached' };
      },
    });
    await listener([baselineMessage()], INVOCATION);
    expect(looked).toBe(0);
  });
});

describe('樹上這一列（#1474）', () => {
  const opened: Context[] = [];
  afterEach(async () => {
    for (const root of opened.splice(0)) await root.fiber.dispose();
  });

  /** 掛一次：agentLoop 提供者、fs 查找（backend 是替身）與這一列。 */
  async function mount(files: Record<string, string>, lookups: unknown[] = []) {
    const loop = createAgentLoopProvider();
    const handle = handleOf(fakeBackend(files));
    const root = new Context();
    opened.push(root);
    await root.plugin(Loader);
    Object.assign(root.loader.builtins, {
      'pre-step': loop.Provider,
      fs: createFsLookupProvider((config) => {
        lookups.push(config);
        const address = toolCallSessionAddress(config);
        return address === undefined
          ? { kind: 'unknown-caller' }
          : { kind: 'ok', fs: handle, address };
      }).Provider,
      'agent-instructions': module,
    });
    const create = (entry: { id: string; name: string; config?: unknown }) =>
      root.loader.create(entry as never, null);
    await create({ id: 'pre-step', name: 'cordis:pre-step' });
    await create({ id: 'fs', name: 'cordis:fs' });
    await create({ id: 'agent-instructions', name: 'cordis:agent-instructions', config: {} });
    await root.loader.await();
    return { loop, root };
  }

  it('一致性套件全格通過：manifest、匯出形式、卸載後登記處回到空的、缺提供者停在 PENDING', async () => {
    let latest = createAgentLoopProvider();
    const failures = await checkConformance({
      row: 'agent-instructions',
      module,
      config: {},
      providers: {
        agentLoop: () => {
          latest = createAgentLoopProvider();
          return latest.Provider;
        },
        fs: () => createFsLookupProvider(() => ({ kind: 'not-attached' })).Provider,
      },
      residue: () => latest.registrations(),
    });
    expect(failures).toEqual([]);
  });

  it('manifest 宣告兩個必要依賴：agentLoop（^1.3.0）、fs（^2.1.0）；沒有 default 匯出', () => {
    expect(module.manifest.consumes).toEqual([
      { token: 'agentLoop', range: '^1.3.0' },
      { token: 'fs', range: '^2.1.0' },
    ]);
    expect(module.manifest.provides).toEqual([]);
    expect(module.inject).toEqual({
      agentLoop: { range: '^1.3.0' },
      fs: { range: '^2.1.0' },
    });
    expect(agentLoopToken.name).toBe('agentLoop');
    expect('default' in module).toBe(false);
    expect(module.manifest.reload).toEqual({ code: 'restart', config: 'next-thread' });
  });

  it('掛上之後登記的是一位名叫 AgentInstructionsMiddleware 的 listener，登記者是這一列', async () => {
    const { loop } = await mount({ '/AGENTS.md': '規矩。' });
    expect(loop.preSteps().map(({ name, source }) => ({ name, source }))).toEqual([
      { name: AGENT_INSTRUCTIONS_MIDDLEWARE_NAME, source: 'agent-instructions' },
    ]);
  });

  it('登記的 listener 在呼叫當下才問 fs 查找，而且把呼叫設定原樣交過去', async () => {
    const lookups: unknown[] = [];
    const { loop } = await mount({ '/AGENTS.md': '規矩。' }, lookups);
    expect(lookups).toEqual([]);
    const listener = loop.preSteps()[0]!.listener;
    const invocation = { configurable: { thread_id: 'x', checkpoint_ns: ROOT_NS } };
    const injections = await listener([], invocation);
    expect(lookups).toEqual([invocation]);
    expect(injections?.[0]?.content).toContain('規矩。');
  });

  it('列卸載之後抓進閉包的 fs 服務仍可呼叫（沒有樹的路徑掛完就卸載）', async () => {
    const { loop, root } = await mount({ '/AGENTS.md': '規矩。' });
    const listener = loop.preSteps()[0]!.listener;
    await root.loader.resolve('agent-instructions').fiber?.ctx.fiber.dispose();
    expect(loop.preSteps()).toEqual([]);
    const injections = await listener([], {
      configurable: { thread_id: 'x', checkpoint_ns: ROOT_NS },
    });
    expect(injections?.[0]?.content).toContain('規矩。');
  });
});
