/**
 * 背景子代理逐次帶不同模型（[#876](https://github.com/DemianLi/nexus-agent/issues/876)，卡 [#709](https://github.com/DemianLi/nexus-agent/issues/709)）。
 *
 * 兩層：
 *
 * - **假 agent**：圖快取鍵含模型、同名不同模型是兩張圖、一個編號的模型從派出到收線不變（`send`、被退回的插話都沿用）、
 *   換模型被拒、沒指定時行為與今天相同（`compile` 的第二個引數是 `undefined`）。
 * - **真圖**：`compileSubagentGraph` 的模型覆寫勝過組裝點的模型——假端點（`ScriptedChatModel`）記到的是被指定的那一顆，
 *   root 的那一顆一次都沒被叫；第二輪沿用同一顆。
 *
 * 本卡不開任何模型可見的欄位，指定模型的入口只有 `host.start({ model })`；工具面在 #877。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry } from '@nexus/core';
import { SessionRegistry } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { BackgroundSubagentHost } from './background-subagents.js';
import type { BackgroundAgent } from './background-subagents.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { ScriptedChatModel } from './scripted-model.js';

/** 一顆手動開的閘門。 */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

describe('host 逐次帶模型（假 agent）', () => {
  /** 每次 `compile` 記一筆 `(名字, 模型)`，回一個記下自己是誰、收到什麼話的假 agent。 */
  function rig() {
    const compiled: { subagent: string; model: string | undefined }[] = [];
    const handled: { agent: string; text: string }[] = [];
    let hold: Promise<void> | undefined;
    const sessions = new SessionRegistry('root-1');
    const host = new BackgroundSubagentHost({
      sessions,
      compile: (subagent, model) => {
        compiled.push({ subagent, model });
        const label = `${subagent}/${model ?? '-'}#${String(compiled.length)}`;
        const agent: BackgroundAgent = {
          async streamEvents(input) {
            const text = String(
              (input as { messages: { content: unknown }[] }).messages.at(-1)?.content,
            );
            handled.push({ agent: label, text });
            await hold;
            return (async function* () {})() as never;
          },
        };
        return agent;
      },
    });
    return {
      host,
      compiled,
      handled,
      holdRounds: (promise: Promise<void>) => {
        hold = promise;
      },
    };
  }

  it('沒指定模型：compile 的模型引數是 undefined，同今天；同名只編一次', async () => {
    const { host, compiled } = rig();
    const first = host.start({ subagent: 'worker', text: '一' });
    const second = host.start({ subagent: 'worker', text: '二' });
    await Promise.all([first.outcome, second.outcome]);
    expect(compiled).toEqual([{ subagent: 'worker', model: undefined }]);
    await host.close();
  });

  it('指定模型：編圖時帶著它；之後對同一個編號的每一輪（send）沿用同一張圖，不重編', async () => {
    const { host, compiled, handled } = rig();
    const started = host.start({ subagent: 'worker', text: '第一句', model: 'cheap' });
    expect(await started.outcome).toEqual({ ok: true });
    expect(await host.send({ runId: started.runId, message: '第二句' })).toEqual({ ok: true });
    expect(compiled).toEqual([{ subagent: 'worker', model: 'cheap' }]);
    expect(handled.map((each) => each.agent)).toEqual(['worker/cheap#1', 'worker/cheap#1']);
    await host.close();
  });

  it('同名子代理、不同模型是兩張圖，各編一次、互不污染；相同模型的第二個編號重用那張圖', async () => {
    const { host, compiled, handled } = rig();
    const plain = host.start({ subagent: 'worker', text: 'a' });
    const cheap = host.start({ subagent: 'worker', text: 'b', model: 'cheap' });
    const strong = host.start({ subagent: 'worker', text: 'c', model: 'strong' });
    const cheapAgain = host.start({ subagent: 'worker', text: 'd', model: 'cheap' });
    await Promise.all([plain, cheap, strong, cheapAgain].map((each) => each.outcome));
    expect(compiled).toEqual([
      { subagent: 'worker', model: undefined },
      { subagent: 'worker', model: 'cheap' },
      { subagent: 'worker', model: 'strong' },
    ]);
    const by = (text: string) => handled.find((each) => each.text === text)?.agent;
    expect(by('a')).toBe('worker/-#1');
    expect(by('b')).toBe('worker/cheap#2');
    expect(by('c')).toBe('worker/strong#3');
    expect(by('d')).toBe('worker/cheap#2');
    await host.close();
  });

  it('一個編號不能換模型：換成別顆、換成沒指定、沒指定換成有指定，都拒絕', async () => {
    const { host } = rig();
    const withModel = host.start({ subagent: 'worker', text: '一', model: 'cheap' });
    await withModel.outcome;
    const plain = host.start({ subagent: 'worker', text: '一' });
    await plain.outcome;

    for (const [runId, model] of [
      [withModel.runId, 'strong'],
      [withModel.runId, undefined],
      [plain.runId, 'cheap'],
    ] as const) {
      const outcome = await host.submit({
        runId,
        subagent: 'worker',
        text: '換',
        ...(model !== undefined && { model }),
      });
      expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining('不能換成') });
    }
    // 沒換的（同一顆）照收。
    expect(
      await host.submit({ runId: withModel.runId, subagent: 'worker', text: '同', model: 'cheap' }),
    ).toEqual({ ok: true });
    await host.close();
  });

  it('跑到一半被退回的插話沿用這個編號的模型（不掉回沒指定的那張圖）', async () => {
    const { host, compiled, handled, holdRounds } = rig();
    const release = gate();
    holdRounds(release.opened);
    const started = host.start({ subagent: 'worker', text: '第一句', model: 'cheap' });
    // 第一輪卡在假 agent 裡；此時插一句話（排進這一輪的插話收件匣），再中斷這一輪。
    while (handled.length === 0) await new Promise((resolve) => setTimeout(resolve, 2));
    host.sendFromUser({ runId: started.runId, text: '插話' });
    host.interrupt(started.runId);
    release.open();
    await started.outcome;
    // 中斷暫停了佇列；下一次送話恢復，先跑被退回的插話，再跑新的。
    host.sendFromUser({ runId: started.runId, text: '新的' });
    await host.idle();
    expect(handled.map((each) => each.text)).toEqual(['第一句', '插話', '新的']);
    expect(compiled).toEqual([{ subagent: 'worker', model: 'cheap' }]);
    expect(new Set(handled.map((each) => each.agent))).toEqual(new Set(['worker/cheap#1']));
    await host.close();
  });
});

describe('指定的模型真的接到圖上（真圖＋假端點）', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexus-bg-model-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('子代理的請求打到被指定的那顆，root 的那顆一次都沒被叫；第二輪沿用', async () => {
    const worker: PluginEntry = {
      plugin: {
        name: 'worker-host',
        apply(registry) {
          registry.subagents.register({
            name: 'worker',
            description: '幹活的。',
            systemPrompt: '你是 worker。',
          });
        },
      },
    };
    const rootModel = new ScriptedChatModel({ turns: [{ content: '根不該被叫' }] });
    const cheap = new ScriptedChatModel({
      turns: [{ content: '便宜答一' }, { content: '便宜答二' }],
    });
    const built = await createNexusAgent({
      model: rootModel,
      checkpointer: new MemorySaver(),
      plugins: [worker],
      backend: new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' }),
    });
    const sessions = new SessionRegistry('root-1');
    const models: Record<string, ScriptedChatModel> = { cheap };
    const host = new BackgroundSubagentHost({
      sessions,
      compile: (name, modelId) =>
        built.compileSubagent(
          name,
          new MemorySaver(),
          modelId === undefined ? undefined : models[modelId],
        ) as unknown as BackgroundAgent,
    });
    try {
      const started = host.start({ subagent: 'worker', text: '第一句', model: 'cheap' });
      expect(await started.outcome).toEqual({ ok: true });
      expect(await host.send({ runId: started.runId, message: '第二句' })).toEqual({ ok: true });
      expect(cheap.prompts).toHaveLength(2);
      expect(rootModel.prompts).toHaveLength(0);
    } finally {
      await host.close();
      await built.dispose();
    }
  });

  it('對照組：不指定模型，子代理用組裝點的（root 的）那一顆', async () => {
    const worker: PluginEntry = {
      plugin: {
        name: 'worker-host',
        apply(registry) {
          registry.subagents.register({
            name: 'worker',
            description: '幹活的。',
            systemPrompt: '你是 worker。',
          });
        },
      },
    };
    const rootModel = new ScriptedChatModel({ turns: [{ content: '根這顆答' }] });
    const built = await createNexusAgent({
      model: rootModel,
      checkpointer: new MemorySaver(),
      plugins: [worker],
      backend: new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' }),
    });
    const host = new BackgroundSubagentHost({
      sessions: new SessionRegistry('root-1'),
      compile: (name) =>
        built.compileSubagent(name, new MemorySaver()) as unknown as BackgroundAgent,
    });
    try {
      const started = host.start({ subagent: 'worker', text: '一句' });
      expect(await started.outcome).toEqual({ ok: true });
      expect(rootModel.prompts).toHaveLength(1);
    } finally {
      await host.close();
      await built.dispose();
    }
  });
});
