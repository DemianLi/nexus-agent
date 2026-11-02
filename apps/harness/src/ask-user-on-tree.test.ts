/**
 * ask-user 在 Cordis 樹上，答題管道接縫與工具登記選項上樹（[#1458](https://github.com/DemianLi/nexus-agent/issues/1458)）：
 * 驗收 B、D、E、F。量的是產品路徑——真的 `createCordisRoot`、真的 `loadDefaultPlugins`（帶樹）、真的寫入口 `changePlugin`、
 * 真的 `createCliAgent`；不手搭 `ctx.plugin`。
 *
 * 驗收 C（行為不變的 golden）是一次性錄製，不在這個檔，做法與數字寫在 PR 內文。入口那兩條（CLI 沒有人在、serve 有人在）的
 * 產品組裝版在 `ask-user-assembly.test.ts`（`runCli`、`runServe`），這個檔補它沒量的：樹上的列、沒有樹的呼叫端、同一個行程裡
 * 兩份組裝各有各的答題管道、停用之後開著的 thread 照樣答得出來。
 */

import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from '@langchain/langgraph';
import { deriveApprovalChannel, loadPlugins } from '@nexus/core';
import { createHostServicesPlugin } from '@nexus/core';
import {
  ASK_USER_QUESTION_TOOL_NAME,
  DELEGATED_CALLER_ERROR,
  DELEGATED_CALLER_MESSAGE,
  noAnswererMessage,
} from '@nexus/plugin-ask-user';
import { afterEach, describe, expect, it } from 'vitest';

import { HEADLESS_APPROVALS } from './agent-factory.js';
import { createCliAgent } from './assembly-root.js';
import { createCordisRoot, entryApprovalChannel } from './cordis-root.js';
import type { CordisRoot } from './cordis-root.js';
import { withScriptedModel } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { toAgentInvocation } from './messages.js';
import { changePlugin } from './plugin-change.js';
import { isBridgeEntry, loadDefaultPlugins } from './plugin-config.js';
import type { LoadedPluginConfig } from './plugin-config.js';
import { buildPluginSnapshot } from './plugin-snapshot.js';
import type { ScriptedTurn } from './scripted-model.js';
import { auditStartupEntries, REQUIRED_TREE_ENTRY_IDS } from './startup-audit.js';

const temporary: string[] = [];
const roots: CordisRoot[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await root.dispose().catch(() => {});
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-ask-user-tree-'));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return dir;
}

function home(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = scratch();
  return { dir, env: { [HARNESS_HOME_ENV]: dir } };
}

/** 入口怎麼建樹就怎麼建：預設答題管道由入口依自己的情境算出來交進去。 */
function newRoot(approvals?: typeof HEADLESS_APPROVALS): CordisRoot {
  const root = createCordisRoot({ channel: entryApprovalChannel(approvals) });
  roots.push(root);
  return root;
}

const warnNothing = (): void => {};
const ID = 'ask-user';

const QUESTIONS = [
  { id: 'day', question: '哪一天？', options: [{ label: '週一' }, { label: '週二' }] },
];

/** 一輪問、一輪收工的腳本。 */
const ASK: readonly ScriptedTurn[] = [
  {
    content: '我先問。',
    toolCalls: [{ name: ASK_USER_QUESTION_TOOL_NAME, args: { questions: QUESTIONS } }],
  },
  { content: '收工。' },
];

/** 讀清單（有樹就帶樹）→ 換成腳本模型 → 組一個 agent。`approvals` 是這個入口給組裝的核准政策。 */
async function assemble(
  env: NodeJS.ProcessEnv,
  options: {
    root?: CordisRoot;
    approvals?: typeof HEADLESS_APPROVALS;
    turns?: readonly ScriptedTurn[];
  } = {},
) {
  const loaded: LoadedPluginConfig = await loadDefaultPlugins(
    { env, warn: warnNothing },
    options.root === undefined ? undefined : { tree: options.root.tree },
  );
  const plugins = withScriptedModel([...loaded.plugins], options.turns ?? ASK);
  const built = await createCliAgent(
    { live: false },
    plugins,
    undefined,
    options.approvals === undefined ? undefined : { approvals: options.approvals },
  );
  return { loaded, built };
}

type Assembled = Awaited<ReturnType<typeof assemble>>;

/** 以某條 thread 的身分跑一輪：回 `interrupt` 酬載（停在問題上）或最後那則工具訊息的文字。 */
async function runOnce(thread: Assembled, threadId: string) {
  const result = (await thread.built.agent.invoke(toAgentInvocation('問我一個問題。'), {
    configurable: { thread_id: threadId },
  })) as {
    __interrupt__?: { value: { kind?: string; questions?: { id: string }[] } }[];
    messages?: { type?: string; content?: unknown; name?: string }[];
  };
  const interrupt = result.__interrupt__?.[0]?.value;
  const toolMessage = result.messages?.filter((message) => message.type === 'tool').at(-1);
  return {
    interrupt,
    toolText: toolMessage === undefined ? undefined : String(toolMessage.content),
  };
}

describe('B：出貨清單上的 ask-user 經樹進來，位置與名字不變', () => {
  it('是橋接列、樹上那一列與答題管道那一列都 ACTIVE、沒有掉列；啟動稽核過；快照上是 mounted', async () => {
    const { env } = home();
    const root = newRoot();
    const loaded = await loadDefaultPlugins({ env, warn: warnNothing }, { tree: root.tree });
    const entry = loaded.plugins.find((candidate) => loaded.rows.get(candidate)?.id === ID);
    expect(entry).toBeDefined();
    expect(entry !== undefined && isBridgeEntry(entry)).toBe(true);
    expect(entry?.plugin.name).toBe('ask-user');
    expect(loaded.dropped).toEqual([]);
    expect(loaded.rows.get(entry as never)).toEqual({ id: ID, module: '@nexus/plugin-ask-user' });
    expect(() => auditStartupEntries(loaded, { live: false })).not.toThrow();

    const tree = await root.tree.context();
    expect(tree.loader.resolve(`include:${ID}`).fiber?.ctx.fiber.state).toBe(2);
    // 答題管道是樹上一列，起來了；它是必掛的列（跟工具、投影、技能來源、命令登記處一樣）。
    expect(tree.loader.resolve('approval-channel').fiber?.ctx.fiber.state).toBe(2);

    const source = {
      entries: loaded.entries,
      ids: loaded.ids,
      plugins: loaded.plugins,
      rows: loaded.rows,
      drops: loaded.dropped.map(({ id, stage }) => ({ id, stage })),
    };
    const snapshot = buildPluginSnapshot({
      running: source,
      saved: source,
      generatedAt: new Date(0),
    });
    expect(snapshot.rows.find((row) => row.id === ID)).toMatchObject({
      module: '@nexus/plugin-ask-user',
      running: { state: 'mounted' },
      saved: { state: 'mounted' },
      sync: 'same',
    });
  }, 60000);

  it('樹上的答題管道服務：歸屬是 approval-channel 那一列、契約版本 1.0.0、值是入口給的那一份', async () => {
    const { env } = home();
    const human = newRoot();
    await loadDefaultPlugins({ env, warn: warnNothing }, { tree: human.tree });
    const service = (await human.tree.context()).get('approvalChannel') as
      { provider?: string; contractVersion?: string; current(): unknown } | undefined;
    expect(service?.provider).toBe('approval-channel');
    expect(service?.contractVersion).toBe('1.0.0');
    expect(service?.current()).toEqual({ kind: 'human' });

    const headless = newRoot(HEADLESS_APPROVALS);
    await loadDefaultPlugins({ env, warn: warnNothing }, { tree: headless.tree });
    const other = (await headless.tree.context()).get('approvalChannel') as
      { current(): unknown } | undefined;
    expect(other?.current()).toEqual({ kind: 'policy-never' });
  }, 60000);

  it('答題管道那一列是必掛的：它起不來，ask-user 沒有地方讀預設答題者，整個起不來', () => {
    expect(REQUIRED_TREE_ENTRY_IDS.has('approval-channel')).toBe(true);
  });

  it('入口算的預設答題管道與組裝根算的是同一個決定（兩個入口各一格）', () => {
    // 組裝根（`assembly-root.ts`）用 `deriveApprovalChannel`、`hasCheckpointer` 綁在 `PrunedMemorySaver` 上，兩個入口都有。
    expect(entryApprovalChannel(HEADLESS_APPROVALS)).toEqual(
      deriveApprovalChannel({ approvalsEnabled: false, hasCheckpointer: true }),
    );
    expect(entryApprovalChannel(undefined)).toEqual(
      deriveApprovalChannel({ hasCheckpointer: true }),
    );
    expect(entryApprovalChannel(HEADLESS_APPROVALS).kind).toBe('policy-never');
    expect(entryApprovalChannel(undefined).kind).toBe('human');
  });

  it('沒有指定答題管道的樹（入口沒有交）：服務照樣在、值是 undefined，工具在呼叫當下拒絕、載入不掉列', async () => {
    const { env } = home();
    const root = createCordisRoot();
    roots.push(root);
    const thread = await assemble(env, { root });
    expect(thread.loaded.dropped).toEqual([]);
    const { interrupt, toolText } = await runOnce(thread, 'unspecified');
    expect(interrupt).toBeUndefined();
    expect(toolText).toContain('沒有指定問答管道');
    await thread.built.dispose();
  }, 60000);
});

describe('E：答題管道由入口決定，每個入口各一條，沒有樹的呼叫端也一樣', () => {
  it('serve 那一格（有人在）：問題發出去，停在中斷上，酬載帶 question 判別式', async () => {
    const { env } = home();
    const thread = await assemble(env, { root: newRoot() });
    const { interrupt } = await runOnce(thread, 'serve-like');
    expect(interrupt?.kind).toBe('question');
    expect(interrupt?.questions?.map((question) => question.id)).toEqual(['day']);
    await thread.built.dispose();
  }, 60000);

  it('CLI 那一格（沒有人在）：不發中斷，結果文字含 policy-never 那一句', async () => {
    const { env } = home();
    const thread = await assemble(env, {
      root: newRoot(HEADLESS_APPROVALS),
      approvals: HEADLESS_APPROVALS,
    });
    const { interrupt, toolText } = await runOnce(thread, 'cli-like');
    expect(interrupt).toBeUndefined();
    expect(toolText).toContain(noAnswererMessage({ kind: 'policy-never' }));
    await thread.built.dispose();
  }, 60000);

  it('沒有樹的呼叫端：同一個行程裡兩份無樹組裝（一份 headless、一份有人在）各有各的答題管道', async () => {
    const { env } = home();
    const headless = await assemble(env, { approvals: HEADLESS_APPROVALS });
    const attended = await assemble(env);
    // 交錯跑：兩份各自組裝時讀的是自己組裝根的 `channel`，不是行程級的某一格。
    const [a, b] = await Promise.all([runOnce(headless, 'bare-a'), runOnce(attended, 'bare-b')]);
    expect(a.interrupt).toBeUndefined();
    expect(a.toolText).toContain(noAnswererMessage({ kind: 'policy-never' }));
    expect(b.interrupt?.kind).toBe('question');
    await headless.built.dispose();
    await attended.built.dispose();
    // 反過來：先組有人在的、後組 headless 的（腳本每顆模型從頭吃，所以各組新的），確認沒有「後組的蓋掉先組的」。
    const attendedFirst = await assemble(env);
    const headlessSecond = await assemble(env, { approvals: HEADLESS_APPROVALS });
    const [c, d] = await Promise.all([
      runOnce(attendedFirst, 'bare-c'),
      runOnce(headlessSecond, 'bare-d'),
    ]);
    expect(c.interrupt?.kind).toBe('question');
    expect(d.interrupt).toBeUndefined();
    expect(d.toolText).toContain(noAnswererMessage({ kind: 'policy-never' }));
    await attendedFirst.built.dispose();
    await headlessSecond.built.dispose();
  }, 90000);

  it('同一棵樹上兩條 thread（serve 的形狀）：各自停在自己的中斷上，互不串線', async () => {
    const { env } = home();
    const root = newRoot();
    const first = await assemble(env, { root });
    const second = await assemble(env, { root });
    const [a, b] = await Promise.all([runOnce(first, 'tree-a'), runOnce(second, 'tree-b')]);
    expect(a.interrupt?.kind).toBe('question');
    expect(b.interrupt?.kind).toBe('question');
    await first.built.dispose();
    await second.built.dispose();
  }, 90000);
});

describe('D：樹上那一列停用，開著的 thread 照舊答得出來，下一條才看到新的', () => {
  it('中斷掛著時停用 ask-user：續答照樣回到工具手上；之後開的 thread 沒有這顆工具', async () => {
    const { env } = home();
    const root = newRoot();
    const first = await assemble(env, { root });
    const asked = await runOnce(first, 'pending');
    expect(asked.interrupt?.kind).toBe('question');

    await changePlugin({ op: 'disable', id: ID }, { env });
    const second = await assemble(env, { root, turns: [{ content: '沒有那顆工具。' }] });
    const tree = await root.tree.context();
    expect(tree.loader.resolve(`include:${ID}`).fiber?.ctx.fiber.state).toBe(4);
    // 下一條 thread 的模型沒有被綁上這顆工具。
    await second.built.agent.invoke(toAgentInvocation('看一下。'), {
      configurable: { thread_id: 'next' },
    });
    const bound = (second.built.model as unknown as { boundTools: { name: string }[] }).boundTools;
    expect(bound.map((tool) => tool.name)).not.toContain(ASK_USER_QUESTION_TOOL_NAME);

    // 開著的那條：工具手上的答題管道在 `apply` 當下抓住了，樹上那一列卸了它也照樣答（決議 §3-2 第 6 條）。
    const resumed = (await first.built.agent.invoke(
      new Command({ resume: { answers: [{ id: 'day', selected: ['週二'] }] } }),
      { configurable: { thread_id: 'pending' } },
    )) as { messages?: { type?: string; content?: unknown }[] };
    const toolMessage = resumed.messages?.filter((message) => message.type === 'tool').at(-1);
    expect(JSON.parse(String(toolMessage?.content))).toEqual({
      answers: [{ id: 'day', selected: ['週二'] }],
    });
    await first.built.dispose();
    await second.built.dispose();
  }, 90000);
});

describe('F：工具登記選項（rootOnly、outputSchema）折進 thread 的註冊點', () => {
  it('經樹進來的那顆工具在 thread 的 registry 上帶著 rootOnly 的句與碼、以及輸出 schema', async () => {
    const { env } = home();
    const root = newRoot();
    const loaded = await loadDefaultPlugins({ env, warn: warnNothing }, { tree: root.tree });
    const entry = loaded.plugins.find((candidate) => loaded.rows.get(candidate)?.id === ID);
    if (entry === undefined) throw new Error('清單上沒有 ask-user');
    const { registry, dispose } = await loadPlugins([
      createHostServicesPlugin({ channel: { kind: 'human' } }),
      entry,
    ]);
    try {
      const resolved = registry.tools.resolve(ASK_USER_QUESTION_TOOL_NAME);
      expect(resolved).toBeDefined();
      expect(registry.tools.isRootOnly(ASK_USER_QUESTION_TOOL_NAME)).toBe(true);
      expect(registry.tools.rootOnlyRefusalOf(ASK_USER_QUESTION_TOOL_NAME)).toEqual({
        message: DELEGATED_CALLER_MESSAGE,
        error: DELEGATED_CALLER_ERROR,
      });
      expect(registry.tools.outputSchemaOf(resolved?.value)).toBeDefined();
    } finally {
      await dispose();
    }
  }, 60000);

  it('沒有樹的呼叫端（單獨掛一次）同樣帶著選項', async () => {
    const { env } = home();
    const loaded = await loadDefaultPlugins({ env, warn: warnNothing });
    const entry = loaded.plugins.find((candidate) => loaded.rows.get(candidate)?.id === ID);
    if (entry === undefined) throw new Error('清單上沒有 ask-user');
    const { registry, dispose } = await loadPlugins([
      createHostServicesPlugin({ channel: { kind: 'human' } }),
      entry,
    ]);
    try {
      expect(registry.tools.isRootOnly(ASK_USER_QUESTION_TOOL_NAME)).toBe(true);
      expect(
        registry.tools.outputSchemaOf(registry.tools.resolve(ASK_USER_QUESTION_TOOL_NAME)?.value),
      ).toBeDefined();
    } finally {
      await dispose();
    }
  }, 60000);
});
