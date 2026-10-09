/**
 * **子代理個別設定走完產品路徑**——[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 3 項的驗收。規則本身的單元測試在
 * `subagent-model-selection.test.ts`（路由合併）、`subagent-definition.test.ts`（註冊驗證）與 core 的 `model-selection.test.ts`。
 *
 * 組裝走 `createCliAgent({ live: true })`，模型是真的 `ChatOpenAI`，對手方是本機的假 Chat Completions 端點，量到的是**真的會送上線的
 * 請求本體**：每一次請求打到哪顆模型、是 root 還是子代理打的（用子代理自己的 system prompt 分辨）。
 *
 * 要回答的幾件事：
 * - 沒設定的子代理沿用會話**此刻**的選擇——會話換了模型之後派前景子代理，請求打到新模型（PM 2026-10-09 C）。
 * - 定義釘的 `model` 勝過會話的選擇；`maxTurns` 真的擋下第 n+1 次叫模型。
 * - 背景子代理在**委派那一刻**定了模型，之後使用者換模型不影響已經派出去的。
 *
 * **零憑證、零外部連線。**
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PluginEntry } from '@nexus/core';
import type { NexusSubAgent } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { shippedPlugins } from './fixtures.js';
import { DEFAULT_LIVE_MODEL_ENTRY, LIVE_API_KEY_ENV } from './live-model.js';
import { liveModelConfigSchema } from './settings/live-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const shipped = await shippedPlugins();

const A = 'model-a';
const B = 'model-b';
const WORKER_PROMPT = '你是 worker。';

interface Seen {
  readonly model: string;
  readonly role: 'root' | 'worker';
  /** 這個角色的第幾次請求（從 1 起算）。 */
  readonly nth: number;
  /** 這次請求訊息串裡最後一則工具結果的文字（沒有是 `undefined`）。 */
  readonly toolResult?: string;
}

type Reply = { text: string } | { call: { id: string; name: string; arguments: string } };

/** 依角色與次序回答的假端點（一律走 SSE）。`onRequest` 在請求到達、回答之前呼叫。 */
async function fakeEndpoint(answer: (seen: Seen) => Reply, onRequest?: (seen: Seen) => void) {
  const requests: Seen[] = [];
  const counts = { root: 0, worker: 0 };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw) as {
        model: string;
        messages?: { role: string; content: unknown }[];
      };
      const system = JSON.stringify((body.messages ?? []).find((m) => m.role === 'system'));
      const role = system.includes(WORKER_PROMPT) ? 'worker' : 'root';
      const lastTool = (body.messages ?? []).findLast((m) => m.role === 'tool');
      const seen: Seen = {
        model: body.model,
        role,
        nth: ++counts[role],
        ...(lastTool !== undefined && { toolResult: JSON.stringify(lastTool.content) }),
      };
      requests.push(seen);
      onRequest?.(seen);
      const reply = answer(seen);
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        `data: ${JSON.stringify({
          id: `chatcmpl-${requests.length}`,
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fake',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if ('text' in reply) {
        res.write(chunk({ role: 'assistant', content: reply.text }));
        res.write(chunk({}, 'stop'));
      } else {
        res.write(chunk({ role: 'assistant', content: '' }));
        res.write(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: reply.call.id,
                type: 'function',
                function: { name: reply.call.name, arguments: reply.call.arguments },
              },
            ],
          }),
        );
        res.write(chunk({}, 'tool_calls'));
      }
      res.write(
        `data: ${JSON.stringify({
          id: `chatcmpl-${requests.length}`,
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fake',
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    models: (role: Seen['role']) =>
      requests.filter((seen) => seen.role === role).map((seen) => seen.model),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env[LIVE_API_KEY_ENV];
  process.env[LIVE_API_KEY_ENV] = 'fake-key-for-loopback';
});
afterEach(() => {
  if (savedKey === undefined) delete process.env[LIVE_API_KEY_ENV];
  else process.env[LIVE_API_KEY_ENV] = savedKey;
});

/** 兩顆：A 預設、B 窗口小且沒有推理資訊。 */
function configFor(baseUrl: string) {
  const entry = (id: string, extra: Record<string, unknown> = {}) => ({
    ...structuredClone(DEFAULT_LIVE_MODEL_ENTRY),
    id,
    ...extra,
  });
  return liveModelConfigSchema.parse({
    baseUrl,
    maxRetries: 0,
    modelId: A,
    models: [
      entry(A),
      entry(B, { contextWindow: 65_000, maxTokens: 4_000, reasoningEfforts: false }),
    ],
  });
}

const workerPlugin = (definition: Partial<NexusSubAgent>): PluginEntry => ({
  plugin: {
    name: 'worker-host',
    apply(registry) {
      registry.subagents.register({
        name: 'worker',
        description: '幹活的。',
        systemPrompt: WORKER_PROMPT,
        ...definition,
      });
    },
  },
});

async function assemble(
  baseUrl: string,
  definition: Partial<NexusSubAgent>,
  options: { background?: boolean; policy?: boolean } = {},
) {
  const built = await createCliAgent(
    {
      live: true,
      liveModel: configFor(baseUrl),
      ...(options.background === true && { backgroundSubagents: { maxActive: 2 } }),
      ...(options.policy === true && { modelSelectionPolicy: { allowedModels: [A, B] } }),
    },
    [...shipped, workerPlugin(definition)],
    undefined,
    {},
  );
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'subagent-config');
  const detach = built.attachSessions(pump.sessions);
  const host = built.modelSelection!;
  return {
    host,
    say: (text: string) => pump.submit({ kind: 'message', text }),
    close: async () => {
      await detach.detach();
      await built.dispose();
    },
  };
}

const until = async (predicate: () => boolean) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 8000) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const delegateForeground: Reply = {
  call: {
    id: 'call-task',
    name: 'task',
    arguments: JSON.stringify({ description: '幹活', subagent_type: 'worker' }),
  },
};
const delegateBackground: Reply = {
  call: {
    id: 'call-bg',
    name: 'subagent',
    arguments: JSON.stringify({
      description: '幹活',
      subagent_type: 'worker',
      run_in_background: true,
    }),
  },
};
const listFiles: Reply = {
  call: { id: 'call-ls', name: 'ls', arguments: JSON.stringify({ path: '/' }) },
};

/** root 第一次就派前景子代理，其後收尾；子代理先叫一次 `ls` 再收尾。 */
const foregroundScript = (seen: Seen): Reply => {
  if (seen.role === 'root') return seen.nth === 1 ? delegateForeground : { text: '根收尾。' };
  return seen.nth === 1 ? listFiles : { text: '子代理做完。' };
};

describe('前景子代理沿用會話此刻的選擇', () => {
  it('沒選過：子代理打部署預設那顆，與今天相同', async () => {
    const endpoint = await fakeEndpoint(foregroundScript);
    const run = await assemble(endpoint.baseUrl, {});
    try {
      await run.say('委派');
      expect(endpoint.models('root')).toEqual([A, A]);
      expect(endpoint.models('worker')).toEqual([A, A]);
    } finally {
      await run.close();
      await endpoint.close();
    }
  }, 60_000);

  it('會話換了模型之後派前景子代理：請求打到新模型（PM C 的驗收）', async () => {
    const endpoint = await fakeEndpoint(foregroundScript);
    const run = await assemble(endpoint.baseUrl, {});
    try {
      run.host.controller.select({ model: B });
      await run.say('委派');
      expect(endpoint.models('worker')).toEqual([B, B]);
      expect(endpoint.models('root')).toEqual([B, B]);
    } finally {
      await run.close();
      await endpoint.close();
    }
  }, 60_000);

  it('前景子代理跑到一半使用者才換：下一次叫模型就換過去（逐次跟隨，不快照）', async () => {
    const endpoint = await fakeEndpoint(foregroundScript, (seen) => {
      if (seen.role === 'worker' && seen.nth === 1) run.host.controller.select({ model: B });
    });
    const run = await assemble(endpoint.baseUrl, {});
    try {
      await run.say('委派');
      expect(endpoint.models('worker')).toEqual([A, B]);
    } finally {
      await run.close();
      await endpoint.close();
    }
  }, 60_000);
});

describe('定義釘的 model 與 maxTurns', () => {
  it('釘了 model：子代理用它，不管會話選了什麼；root 不受影響', async () => {
    const endpoint = await fakeEndpoint(foregroundScript);
    const run = await assemble(endpoint.baseUrl, { model: B });
    try {
      await run.say('委派');
      expect(endpoint.models('worker')).toEqual([B, B]);
      expect(endpoint.models('root')).toEqual([A, A]);
    } finally {
      await run.close();
      await endpoint.close();
    }
  }, 60_000);

  it('釘了 model，會話又選了 A：還是釘的那顆', async () => {
    const endpoint = await fakeEndpoint(foregroundScript);
    const run = await assemble(endpoint.baseUrl, { model: B });
    try {
      run.host.controller.select({ model: A });
      await run.say('委派');
      expect(endpoint.models('worker')).toEqual([B, B]);
    } finally {
      await run.close();
      await endpoint.close();
    }
  }, 60_000);

  it('maxTurns：子代理叫到上限就收尾，第 n+1 次不會發出去；root 照常收尾', async () => {
    const endpoint = await fakeEndpoint((seen) => {
      if (seen.role === 'root') return seen.nth === 1 ? delegateForeground : { text: '根收尾。' };
      // 子代理永遠想再看一次；沒有上限的話會一直叫到遞迴上限。這裡自己在第 8 次收手，免得測試跑太久。
      return seen.nth >= 8 ? { text: '放棄。' } : listFiles;
    });
    const run = await assemble(endpoint.baseUrl, { maxTurns: 2 });
    try {
      await run.say('委派');
      expect(endpoint.models('worker')).toHaveLength(2);
      expect(endpoint.models('root')).toHaveLength(2);
    } finally {
      await run.close();
      await endpoint.close();
    }
  }, 60_000);
});

describe('maxTurns 的計數不外漏到下一次委派', () => {
  // 前景子代理的 state 鍵會併回父代理（deepagents 的 EXCLUDED_STATE_KEYS 之外），`modelCallLimitMiddleware` 的計數也在 state 裡：
  // 外漏的話第二次委派一開始就已經到上限。
  it('同一輪派兩次、再開一輪派第三次：每次都叫滿 2 次', async () => {
    const endpoint = await fakeEndpoint((seen) => {
      if (seen.role === 'root') {
        // 第 1、2、4 次根請求派子代理，第 3、5 次收尾。
        return [1, 2, 4].includes(seen.nth) ? delegateForeground : { text: '根收尾。' };
      }
      return seen.nth >= 12 ? { text: '放棄。' } : listFiles;
    });
    const run = await assemble(endpoint.baseUrl, { maxTurns: 2 });
    try {
      await run.say('第一輪');
      expect(endpoint.models('worker')).toHaveLength(4);
      await run.say('第二輪');
      expect(endpoint.models('worker')).toHaveLength(6);
    } finally {
      await run.close();
      await endpoint.close();
    }
  }, 60_000);
});

describe('list_subagent_models 標的是主對話此刻用的那顆', () => {
  it('會話換到 B 之後，清單把 B 標成目前用的，而不是部署預設 A', async () => {
    const endpoint = await fakeEndpoint((seen) =>
      seen.role === 'root' && seen.nth === 1
        ? { call: { id: 'call-list', name: 'list_subagent_models', arguments: '{}' } }
        : { text: '根收尾。' },
    );
    const run = await assemble(endpoint.baseUrl, {}, { background: true, policy: true });
    try {
      run.host.controller.select({ model: B });
      await run.say('列出');
      const second = endpoint.requests.find((seen) => seen.role === 'root' && seen.nth === 2);
      expect(second?.toolResult).toContain(`${B}（主對話目前用的）`);
      expect(second?.toolResult).not.toContain(`${A}（主對話目前用的）`);
    } finally {
      await run.close();
      await endpoint.close();
    }
  }, 60_000);
});

describe('背景子代理在委派那一刻定了模型', () => {
  it('定義釘了 model：背景子代理用釘的，會話停在別顆也一樣', async () => {
    const endpoint = await fakeEndpoint((seen) => {
      if (seen.role === 'root') return seen.nth === 1 ? delegateBackground : { text: '根收尾。' };
      return { text: '做完。' };
    });
    const run = await assemble(endpoint.baseUrl, { model: B }, { background: true });
    try {
      await run.say('委派');
      await until(() => endpoint.models('worker').length === 1);
      expect(endpoint.models('worker')).toEqual([B]);
      expect(endpoint.models('root')).toEqual([A, A]);
    } finally {
      await run.close();
      await endpoint.close();
    }
  }, 60_000);

  it('會話在 B 時派出去：那顆子代理打 B', async () => {
    const endpoint = await fakeEndpoint((seen) => {
      if (seen.role === 'root') return seen.nth === 1 ? delegateBackground : { text: '根收尾。' };
      return { text: '做完。' };
    });
    const run = await assemble(endpoint.baseUrl, {}, { background: true });
    try {
      run.host.controller.select({ model: B });
      await run.say('委派');
      await until(() => endpoint.models('worker').length === 1);
      expect(endpoint.models('worker')).toEqual([B]);
    } finally {
      await run.close();
      await endpoint.close();
    }
  }, 60_000);

  it('派出去之後使用者才換模型：已派出的子代理後續請求仍是原本那顆', async () => {
    const endpoint = await fakeEndpoint(
      (seen) => {
        if (seen.role === 'root') return seen.nth === 1 ? delegateBackground : { text: '根收尾。' };
        return seen.nth === 1 ? listFiles : { text: '做完。' };
      },
      (seen) => {
        // 子代理第一次請求到達時使用者換了模型；它的第二次請求不該跟過去。
        if (seen.role === 'worker' && seen.nth === 1) run.host.controller.select({ model: B });
      },
    );
    const run = await assemble(endpoint.baseUrl, {}, { background: true });
    try {
      await run.say('委派');
      await until(() => endpoint.models('worker').length === 2);
      expect(endpoint.models('worker')).toEqual([A, A]);
    } finally {
      await run.close();
      await endpoint.close();
    }
  }, 60_000);
});

describe('註冊時對型錄驗證（組裝點接上的）', () => {
  it('model 不在型錄：組裝當場失敗，指名註冊者與子代理，不等到委派', async () => {
    const endpoint = await fakeEndpoint(foregroundScript);
    try {
      await expect(assemble(endpoint.baseUrl, { model: 'no-such-model' })).rejects.toThrow(
        /worker-host.*"worker".*"no-such-model".*不在型錄/s,
      );
      // 型錄裡有 B 但它沒宣告任何推理等級：強度也在註冊時拒絕。
      await expect(
        assemble(endpoint.baseUrl, { model: B, reasoningEffort: 'off' }),
      ).rejects.toThrow(/"worker".*沒有推理等級 "off"/s);
      expect(endpoint.requests).toHaveLength(0);
    } finally {
      await endpoint.close();
    }
  }, 60_000);
});
