/**
 * **工具本體拋錯，不留下沒人接的 rejection**——[#346](https://github.com/DemianLi/nexus-agent/issues/346) 的驗收。
 *
 * v3 `streamEvents` 替每一次工具呼叫（子代理那層、子代理本身也各一份）建一顆 `output` promise，
 * 沒有人有義務去 await 它。工具本體一拋錯，工具自己的 run manager 當下就發 `tool-error`
 * （`@langchain/core` `dist/tools/index.js:141-143`），langchain 的投影隨即 reject 那顆 promise
 * （`langchain` `src/agents/transformers/tool-call.ts:235`）。Node 預設遇到未處理的 rejection 就結束
 * 行程——serve 上所有 thread 一起斷。`containment` 救得回這一輪（它在 `handler` 外面把錯誤轉成
 * 回饋），救不回那顆 promise：它接到的時候 `tool-error` 早就發出去了。
 *
 * 這裡量的是**真的組裝＋真的 `ThreadPump`**（web 那條）。CLI 走 `stream(streamMode)`，不建這些
 * 投影，不在射程裡。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry, SessionEvent } from '@nexus/core';
import { createDeepAgent, GENERAL_PURPOSE_SUBAGENT } from 'deepagents';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createNexusAgent } from './agent-factory.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const OVERLOADED = 'Service temporarily overloaded';

const boom = tool(
  async () => {
    throw new Error(OVERLOADED);
  },
  { name: 'boom', description: '一律拋錯。', schema: z.object({}) },
);

const BOOM: PluginEntry = {
  plugin: {
    name: 'boom',
    apply(registry) {
      registry.tools.register(boom);
    },
  },
};

const WORKER: PluginEntry = {
  plugin: {
    name: 'worker-host',
    apply(registry) {
      registry.subagents.register({ name: 'worker', description: '幹活的。' });
    },
  },
};

const GP = GENERAL_PURPOSE_SUBAGENT.name;

const call = (name: string, args: Record<string, unknown> = {}): ScriptedTurn => ({
  content: '',
  toolCalls: [{ name, args }],
});
const delegate = (subagentType: string): ScriptedTurn =>
  call('task', { description: '幹活', subagent_type: subagentType });

/**
 * 這一條測試期間冒出來的未處理 rejection。
 *
 * vitest 自己也會把它們報成失敗，但那是整份測試檔的紅、指不到是哪一條；這裡逐條計，
 * 斷言寫在會紅的那一條上。
 */
let unhandled: unknown[] = [];
const record = (reason: unknown): void => {
  unhandled.push(reason);
};
beforeEach(() => {
  unhandled = [];
  process.on('unhandledRejection', record);
});
afterEach(() => {
  process.off('unhandledRejection', record);
});

/** 未處理的 rejection 在 microtask 排空之後才報，等一拍再數。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** 真的組裝跑一輪到收尾，回 root 日誌。 */
async function runOnce(
  turns: readonly ScriptedTurn[],
  plugins: readonly PluginEntry[],
): Promise<readonly SessionEvent[]> {
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns }),
    checkpointer: new MemorySaver(),
    plugins: [...plugins],
  });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'tool-throw');
  const detach = built.attachSession(pump.sessions);
  try {
    await pump.submit({ kind: 'message', text: '跑。' });
    await pump.whenIdle();
    await settle();
    return pump.sessions.list().find((entry) => entry.address.kind === 'root')?.log.events ?? [];
  } finally {
    detach();
    await built.dispose();
  }
}

const typesOf = (events: readonly SessionEvent[]) => events.map((event) => event.type);

/** root 日誌上 `callId` 那一顆的判定，比對時不看內容。 */
function verdictOf(
  events: readonly SessionEvent[],
  name: string,
): { isError: boolean } | undefined {
  const called = events.find(
    (event) => event.type === 'tool/call' && (event.data as { name?: unknown }).name === name,
  );
  const callId = (called?.data as { callId?: unknown } | undefined)?.callId;
  const result = events.find(
    (event) =>
      event.type === 'tool/result' && (event.data as { callId?: unknown }).callId === callId,
  );
  return result === undefined
    ? undefined
    : { isError: (result.data as { isError: boolean }).isError };
}

describe('工具本體拋錯（#346）', () => {
  it('root 那層的工具拋錯：這一輪走完，模型收到錯誤回饋，沒有未處理的 rejection', async () => {
    const root = await runOnce([call('boom'), { content: '收到錯誤了。' }], [BOOM]);

    expect(typesOf(root)).toContain('turn/end');
    expect(typesOf(root)).not.toContain('turn/failed');
    expect(verdictOf(root, 'boom')).toEqual({ isError: true });
    expect(unhandled.map(String)).toEqual([]);
  });

  it.each([
    ['登記過的子代理', 'worker'],
    ['fold 補的 general-purpose', GP],
  ])('%s裡的工具拋錯：root 這一輪走完，沒有未處理的 rejection', async (_label, subagentType) => {
    const root = await runOnce(
      [
        delegate(subagentType),
        call('boom'),
        { content: '子代理收到錯誤了。' },
        { content: '收尾。' },
      ],
      [BOOM, WORKER],
    );

    expect(typesOf(root)).toContain('turn/end');
    expect(typesOf(root)).not.toContain('turn/failed');
    expect(verdictOf(root, 'task')).toEqual({ isError: false });
    expect(unhandled.map(String)).toEqual([]);
  });

  it.each([
    ['登記過的子代理', 'worker'],
    ['fold 補的 general-purpose', GP],
  ])(
    '%s那一輪的模型呼叫拋錯（#327 那次）：root 的 task 拿到錯誤、這一輪照跑完，沒有未處理的 rejection',
    async (_label, subagentType) => {
      // 對上 dsh：子代理失敗 → 父代理那顆委派工具 `isError`，父代理那一輪照跑
      // （`packages/subagent/tool-subagent/src/index.ts:207-214`）。
      const root = await runOnce(
        [
          delegate(subagentType),
          { content: '', error: OVERLOADED },
          { content: '委派失敗了，收尾。' },
        ],
        [WORKER],
      );

      expect(typesOf(root)).toContain('turn/end');
      expect(typesOf(root)).not.toContain('turn/failed');
      expect(verdictOf(root, 'task')).toEqual({ isError: true });
      expect(unhandled.map(String)).toEqual([]);
    },
  );

  it('整輪失敗時還開著的子代理，它自己那顆 output 也標掉（裸基座組裝；產品路徑今天到不了）', async () => {
    // 產品組裝上 `containment` 讓子代理與 `task` 都弄不垮整輪，所以子代理自己那顆 `output`
    // 只在「整輪失敗時它還開著」才 reject——上面兩組量不到它。裸 `createDeepAgent` 沒有圍堵：
    // 子代理裡的工具拋錯一路炸穿 `task`、整輪失敗，實測子代理那層的工具呼叫、root 的 `task`、
    // 子代理本身三顆一起冒。這一條釘的是第三顆。
    const agent = createDeepAgent({
      model: new ScriptedChatModel({ turns: [delegate('worker'), call('boom')] }),
      checkpointer: new MemorySaver(),
      subagents: [
        { name: 'worker', description: '幹活的。', systemPrompt: '幹活。', tools: [boom] },
      ],
    });
    const pump = new ThreadPump(agent as unknown as PumpAgent, 'bare-deep-agent');

    await expect(pump.submit({ kind: 'message', text: '跑。' })).rejects.toThrow(OVERLOADED);
    await pump.whenIdle();
    await settle();

    expect(unhandled.map(String)).toEqual([]);
  });
});

/**
 * **上游絆索。** 裸 `createAgent`＋v3＋拋錯的工具，今天會漏——`ThreadPump` 那一段就是為它存在的。
 * 這條紅了（子行程乾淨地跑完），代表 langchain 修掉了，那一段該拆。
 *
 * 在子行程裡跑：直接在這裡觸發，vitest 自己的 unhandled 偵測會把整份測試報成失敗。
 */
describe('上游絆索（#346）', () => {
  it('裸 createAgent 走 v3 時，工具拋錯仍會讓行程以未處理的 rejection 結束', async () => {
    const fixture = fileURLToPath(
      new URL('./upstream-orphan-rejection.fixture.ts', import.meta.url),
    );
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    const outcome = await promisify(execFile)(process.execPath, ['--import', 'tsx', fixture], {
      cwd,
    }).then(
      () => ({ exited: 0, stderr: '' }),
      (error: { code?: number; stderr?: string }) => ({
        exited: error.code ?? -1,
        stderr: error.stderr ?? '',
      }),
    );

    expect(outcome.exited).not.toBe(0);
    // 釘住是**那一顆**，不是子行程別的原因起不來。
    expect(outcome.stderr).toContain(OVERLOADED);
    expect(outcome.stderr).toContain('transformers/tool-call');
  }, 30_000);
});
