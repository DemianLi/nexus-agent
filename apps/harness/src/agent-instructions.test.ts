/**
 * 工作區指令進不進得了模型——[#388](https://github.com/DemianLi/nexus-agent/issues/388) 的驗收。
 *
 * **每一條都用 `DEFAULT_PLUGINS`，一個 plugin 都不自己傳。** 這是這張卡存在的原因：`memory.test.ts`
 * 綠著，是因為每一條都自己把 plugin 傳進去，而產品路徑上（不帶 `--plugins` 的 CLI 與 serve）那顆
 * 根本沒掛。判準是零設定的組裝看到什麼，不是「掛上去之後會怎樣」。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import {
  AGENT_INSTRUCTIONS_INTRO,
  isAgentInstructionsMessage,
} from '@nexus/plugin-agent-instructions';
import type { Event } from '@nexus/wire';
import { GENERAL_PURPOSE_SUBAGENT } from 'deepagents';
import { describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { DEFAULT_PLUGINS } from './cli.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const GP = GENERAL_PURPOSE_SUBAGENT.name;

const isRootDone = (frame: Event): boolean =>
  frame.method === 'lifecycle' &&
  frame.params.namespace.length === 0 &&
  (frame.params.data as { graph_name?: unknown }).graph_name === 'root' &&
  ['completed', 'failed'].includes(String((frame.params.data as { event?: unknown }).event));

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** 一輪 prompt 裡有幾則基線。看的是記號不是文字——文字改了這些測試不該跟著改。 */
function baselines(prompt: readonly BaseMessage[]): BaseMessage[] {
  return prompt.filter(isAgentInstructionsMessage);
}

function systemText(prompt: readonly BaseMessage[]): string {
  return prompt.find((message) => message.getType() === 'system')?.text ?? '';
}

interface RunOptions {
  /** 要在工作區裡先放好的檔。給 `undefined` 就不給 `--workspace`（預設 `StateBackend`）。 */
  readonly files?: Record<string, string>;
  readonly turns: readonly ScriptedTurn[];
  /** 送幾句話。預設一句。 */
  readonly submits?: readonly string[];
}

/** 真的組裝、真的 pump——serve 那條路的形狀，plugin 清單就是 `DEFAULT_PLUGINS`。 */
async function run(options: RunOptions) {
  const root = await mkdtemp(join(tmpdir(), 'nexus-instructions-'));
  for (const [name, content] of Object.entries(options.files ?? {})) {
    await writeFile(join(root, name), content, 'utf8');
  }
  const model = new ScriptedChatModel({ turns: options.turns });
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    plugins: [...DEFAULT_PLUGINS],
    ...(options.files !== undefined && {
      backend: new ContainedFilesystemBackend({ rootDir: root, mode: 'workspace-write' }),
    }),
  });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'instructions');
  const detach = built.attachSession(pump.sessions);
  const frames: Event[] = [];
  const line = new AbortController();
  const stream = pump.subscribe(['messages', 'tools', 'lifecycle', 'input'], line.signal);
  const draining = (async () => {
    for await (const frame of stream) frames.push(frame);
  })();

  for (const text of options.submits ?? ['開工']) {
    frames.length = 0;
    await pump.submit({ kind: 'message', text });
    await until(() => frames.some(isRootDone));
    await pump.whenIdle();
  }

  const sessions = pump.sessions.list();
  const close = async () => {
    line.abort();
    await draining;
    detach();
    await built.dispose();
    await rm(root, { recursive: true, force: true });
  };
  return { model, sessions, prompts: model.prompts as readonly (readonly BaseMessage[])[], close };
}

describe('裸組裝（零 --plugins）就看得到工作區指令', () => {
  it('給了 --workspace 與 AGENTS.md：第一輪 prompt 裡就有那一則基線，內容與路徑都在', async () => {
    const found = await run({
      files: { 'AGENTS.md': '這個 repo 的規矩：先跑測試。' },
      turns: [{ content: '好。' }],
    });
    try {
      const first = found.prompts[0] ?? [];
      const baseline = baselines(first);
      expect(baseline).toHaveLength(1);
      const text = baseline[0]?.text ?? '';
      expect(text).toContain('<system-reminder>');
      expect(text).toContain(AGENT_INSTRUCTIONS_INTRO);
      expect(text).toContain('Instructions from: AGENTS.md');
      expect(text).toContain('這個 repo 的規矩：先跑測試。');

      // **位置**：緊跟在使用者那一句之後（dsh 插在已領取的訊息之後）。
      const roles = first.map((message) => message.getType());
      const userIndex = first.findIndex((message) => message.text === '開工');
      expect(roles[0]).toBe('system');
      expect(first.indexOf(baseline[0] as BaseMessage)).toBe(userIndex + 1);
    } finally {
      await found.close();
    }
  }, 20000);

  it('沒給 --workspace：沒有基線，也沒有基座那段叫模型寫記憶的 <memory_guidelines>', async () => {
    const found = await run({ turns: [{ content: '好。' }] });
    try {
      const first = found.prompts[0] ?? [];
      expect(baselines(first)).toHaveLength(0);
      // 翻面寫的那一半：`@nexus/plugin-memory` 不在預設清單上，所以那段寫入指示一個字都不該出現。
      expect(systemText(first)).not.toContain('<memory_guidelines>');
      expect(systemText(first)).not.toContain('memory_guidelines');
    } finally {
      await found.close();
    }
  }, 20000);

  it('四個候選依序渲染，同一層內容一樣的只算一次', async () => {
    const found = await run({
      files: {
        'AGENTS.md': '基礎規矩。',
        // 與 `AGENTS.md` 只差首尾空白——dsh 的去重是「去掉首尾空白之後」比內容。
        'CLAUDE.md': '\n基礎規矩。\n\n',
        'AGENTS.local.md': '我自己的補充。',
      },
      turns: [{ content: '好。' }],
    });
    try {
      const text = baselines(found.prompts[0] ?? [])[0]?.text ?? '';
      expect(text).toContain('Instructions from: AGENTS.md');
      expect(text).not.toContain('Instructions from: CLAUDE.md');
      expect(text).toContain('Instructions from: AGENTS.local.md');
      // 順序：基礎檔在前、local overlay 在後（最具體的最後，預算不夠時它最後才被截）。
      expect(text.indexOf('Instructions from: AGENTS.md')).toBeLessThan(
        text.indexOf('Instructions from: AGENTS.local.md'),
      );
    } finally {
      await found.close();
    }
  }, 20000);
});

describe('一個 agent 一份，不會越積越多', () => {
  it('同一條 thread 送第二句話：還是只有一則基線', async () => {
    const found = await run({
      files: { 'AGENTS.md': '規矩。' },
      turns: [{ content: '第一輪好。' }, { content: '第二輪好。' }],
      submits: ['第一句', '第二句'],
    });
    try {
      expect(found.prompts).toHaveLength(2);
      expect(baselines(found.prompts[0] ?? [])).toHaveLength(1);
      // **這一條是去重的判準本身。** 拿掉 `beforeAgent` 開頭那道 `some(isAgentInstructionsMessage)`
      // 就會變成 2——第二次 invoke 的 `beforeAgent` 照樣會跑。
      expect(baselines(found.prompts[1] ?? [])).toHaveLength(1);
    } finally {
      await found.close();
    }
  }, 20000);

  it('每一則基線都記成 user/message，來源指名是這顆 plugin', async () => {
    const found = await run({
      files: { 'AGENTS.md': '規矩。' },
      turns: [{ content: '第一輪好。' }, { content: '第二輪好。' }],
      submits: ['第一句', '第二句'],
    });
    try {
      const root = found.sessions.find((session) => session.address.kind === 'root');
      const injected = (root?.log.events ?? []).filter(
        (event) =>
          event.type === 'user/message' &&
          (event.data as { source?: { kind?: string } }).source?.kind === 'plugin',
      );
      expect(injected).toHaveLength(1);
      expect((injected[0]?.data as { source?: { plugin?: string } }).source?.plugin).toBe(
        'AgentInstructionsMiddleware',
      );
    } finally {
      await found.close();
    }
  }, 20000);
});

describe('子代理也各有一份', () => {
  for (const subagentType of [GP]) {
    it(`委派給 ${subagentType}：子代理那幾輪的 prompt 裡有基線`, async () => {
      const found = await run({
        files: { 'AGENTS.md': '規矩。' },
        turns: [
          {
            content: '委派。',
            toolCalls: [
              { name: 'task', args: { description: '幹活', subagent_type: subagentType } },
            ],
          },
          { content: '子代理收工。' },
          { content: '根收工。' },
        ],
      });
      try {
        const subagentPrompts = found.prompts.filter((prompt) =>
          prompt.some((message) => message.getType() === 'human' && message.text === '幹活'),
        );
        expect(subagentPrompts.length).toBeGreaterThan(0);
        for (const prompt of subagentPrompts) expect(baselines(prompt)).toHaveLength(1);
      } finally {
        await found.close();
      }
    }, 20000);
  }
});
