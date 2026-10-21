/**
 * 薄測試：listener 讀得到什麼、什麼時候不加（backend 是替身，不經過 agent），加上樹上這一列（#1474）的接線與一致性。
 *
 * **基線真的有沒有進到模型、會不會重複**的驗收在組裝點（`apps/harness/src/agent-instructions.test.ts`），
 * 而且那裡用的是零設定的出貨清單（`apps/harness/cordis.yml`）。**摘要之後的判準**（宿主算 `effectiveMessages` 再交給 listener）
 * 在 `apps/harness/src/pre-step-middleware.test.ts`。兩件事。
 *
 * **測試檔不受 SDK lint 管**（`PLUGIN_LINT_IGNORES`），所以這裡可以 import `@nexus/core`；`src/index.ts` 不行。
 */

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
import { afterEach, describe, expect, it } from 'vitest';

import * as module from './index.js';
import {
  AGENT_INSTRUCTIONS_MARKER,
  AGENT_INSTRUCTIONS_MIDDLEWARE_NAME,
  agentInstructionsConfigSchema,
  Config,
  createAgentInstructionsListener,
  DEFAULT_MAX_BYTES,
  INSTRUCTION_FILE_CANDIDATES,
  isAgentInstructionsMessage,
} from './index.js';

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
  const listener = createAgentInstructionsListener(maxBytes, {
    fs: () => ({ kind: 'ok', fs: handle, address: { kind: 'root' } }),
  });
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
    const listener = createAgentInstructionsListener(DEFAULT_MAX_BYTES, {
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

  it('回的那一則帶記號、而且只帶記號：source 由宿主蓋，不是這裡的事', async () => {
    const injections = await inject({ '/AGENTS.md': '規矩。' });
    expect(injections).toHaveLength(1);
    expect(injections?.[0]?.additionalKwargs).toEqual({ [AGENT_INSTRUCTIONS_MARKER]: true });
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
    const listener = createAgentInstructionsListener(DEFAULT_MAX_BYTES, { fs: () => lookup });
    expect(await listener([], INVOCATION)).toBeUndefined();
  });

  it('把手在、但這次組裝一個 backend 都沒有：不注入', async () => {
    const listener = createAgentInstructionsListener(DEFAULT_MAX_BYTES, {
      fs: () => ({ kind: 'ok', fs: handleOf(undefined), address: { kind: 'root' } }),
    });
    expect(await listener([], INVOCATION)).toBeUndefined();
  });

  it('呼叫設定原樣交給 fs 查找，沒有被改形狀（交裸的 configurable 會變 unknown-caller）', async () => {
    const seen: unknown[] = [];
    const listener = createAgentInstructionsListener(DEFAULT_MAX_BYTES, {
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
    const listener = createAgentInstructionsListener(DEFAULT_MAX_BYTES, {
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

  it('manifest 宣告兩個必要依賴：agentLoop（^1.0.0）、fs（^2.0.0）；沒有 default 匯出', () => {
    expect(module.manifest.consumes).toEqual([
      { token: 'agentLoop', range: '^1.0.0' },
      { token: 'fs', range: '^2.0.0' },
    ]);
    expect(module.manifest.provides).toEqual([]);
    expect(module.inject).toEqual({
      agentLoop: { range: '^1.0.0' },
      fs: { range: '^2.0.0' },
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
