/**
 * **`/shared`（唯讀共用區）不接受任何 grant**（#1775 Q8 (a)）：核准過的升級也寫不進去。
 *
 * 共用區的 backend 固定 `read-only`、不傳 `grants`（`agent-factory.ts`），所以沙箱控制器發出的 grant 認領不到它。
 * 這一檔是那條「不傳 grants」的紅燈：把 grants 傳給共用區的 backend，核准後的重試會寫進去，這裡就紅。
 *
 * 會走到升級的只有 session 模式是 `read-only` 的時候（`workspace-write` 下「升到 workspace-write」不比現在更寬，工具直接拒、不發卡）。
 * 所以兩個案例都在 `read-only` 下跑，**同一串動作（寫 → 升級 → 核准 → 原樣重試）打兩個目標**：
 * 私有根的 `/own.txt` 要走完整條（發卡、核准、重試成功）——證明這個組裝下 grant 機制是活的；
 * 共用區的 `/shared/x.txt` 同一串動作一個字都寫不進去（卡照發、核准照回，但沒有 backend 認領得到那顆 grant）。
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { SANDBOX_ESCALATION_TOOL_NAME } from '@nexus/plugin-sandbox-policy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { shippedPlugins, withScriptedModel } from './fixtures.js';
import { toAgentInvocation } from './messages.js';
import type { ScriptedTurn } from './scripted-model.js';

const shipped = await shippedPlugins();
const APPROVE = new Command({ resume: { decisions: [{ type: 'approve' }] } }) as never;

let shared: string;
let priv: string;
beforeEach(async () => {
  shared = await mkdtemp(join(tmpdir(), 'nexus-shared-grant-ws-'));
  priv = await mkdtemp(join(tmpdir(), 'nexus-shared-grant-priv-'));
  await writeFile(join(shared, 'ref.md'), '參考資料', 'utf8');
});
afterEach(async () => {
  await Promise.all([shared, priv].map((dir) => rm(dir, { recursive: true, force: true })));
});

const flatten = (content: unknown): string =>
  typeof content === 'string' ? content : JSON.stringify(content);

const toolTexts = (result: { messages: unknown }): string[] =>
  (result.messages as BaseMessage[])
    .filter((message) => message.getType() === 'tool')
    .map((message) => flatten(message.content));

const write = (file_path: string, content: string): ScriptedTurn => ({
  content: '',
  toolCalls: [{ name: 'write_file', args: { file_path, content } }],
});

const escalate = (file_path: string): ScriptedTurn => ({
  content: '',
  toolCalls: [
    {
      name: SANDBOX_ESCALATION_TOOL_NAME,
      args: { file_path, sandbox_permissions: 'workspace-write', justification: '使用者要這個檔' },
    },
  ],
});

async function product(turns: readonly ScriptedTurn[]) {
  return createCliAgent(
    {
      live: false,
      workspace: shared,
      workspaceRoot: priv,
      sharedWorkspaceRoot: shared,
      sandbox: 'read-only',
    },
    withScriptedModel(shipped, turns),
    priv,
  );
}

/** 寫 → 升級 → 核准 → 原樣重試。回第一次被拒的訊息、有沒有掛出核准卡、核准之後的各則工具訊息。 */
async function writeEscalateRetry(target: string, thread: string, escalateFor = target) {
  const built = await product([
    write(target, '內容'),
    escalate(escalateFor),
    write(target, '內容'),
    { content: '停。' },
  ]);
  const detach = built.attachSession(built.sessions);
  const config = { configurable: { thread_id: thread } };
  try {
    const paused = await built.agent.invoke(toAgentInvocation('寫。'), config);
    const card = ((paused as { __interrupt__?: unknown[] }).__interrupt__?.length ?? 0) > 0;
    const first = toolTexts(paused);
    const after = card ? toolTexts(await built.agent.invoke(APPROVE, config)) : first;
    return { first, card, after };
  } finally {
    detach();
    await built.dispose();
  }
}

describe('/shared 不接受 grant', () => {
  it('對照：私有根 /own.txt 走完整條——發卡、核准、原樣重試寫得進去', async () => {
    const { first, card, after } = await writeEscalateRetry('/own.txt', 'grant-own');
    // 前提：第一次寫真的是被 read-only 擋下的，升級真的掛出核准卡。
    expect(first[0]).toContain('唯讀');
    expect(card).toBe(true);
    expect(after[after.length - 1]).not.toContain('[containment]');
    expect(await readFile(join(priv, 'own.txt'), 'utf8')).toBe('內容');
    expect(await readdir(shared)).toEqual(['ref.md']);
  }, 60000);

  // 升級填哪個路徑？被拒的訊息寫的是 backend 內的位址（`/x.txt`），模型照抄就是 `/x.txt`；照呼叫寫的完整路徑是 `/shared/x.txt`。
  // 兩種都要釘：grant 綁的是被擋下那次的位址，只測 `/shared/x.txt` 會被「位址對不上」擋住，看不出 backend 到底認不認 grant
  // （實測：把 grants 傳給共用區的 backend，`/shared/x.txt` 那種仍然綠，`/x.txt` 那種才紅）。
  it.each([
    ['完整路徑 /shared/x.txt', '/shared/x.txt'],
    ['訊息裡的 backend 內位址 /x.txt', '/x.txt'],
  ])(
    '共用區 /shared/x.txt 同一串動作（升級填 %s）：寫不進去，兩邊磁碟都沒有新檔',
    async (_label, escalateFor) => {
      const { first, card, after } = await writeEscalateRetry(
        '/shared/x.txt',
        `grant-shared${escalateFor}`,
        escalateFor,
      );
      // 前提：第一次寫真的是共用區的唯讀擋下的。
      expect(first[0]).toContain('唯讀');
      // 已知的樣子（如實記）：升級工具照樣掛出一張核准卡、核准後回「核准了」——它不知道目標在共用區；
      // 但核准的 grant 沒有任何 backend 認領得到，原樣重試仍被唯讀擋下。承重的是最後這幾條。
      expect(card).toBe(true);
      expect(after.join('\n')).not.toContain('Successfully wrote');
      expect(after[after.length - 1]).toContain('唯讀');
      expect(await readdir(shared)).toEqual(['ref.md']);
      expect(await readFile(join(shared, 'ref.md'), 'utf8')).toBe('參考資料');
      expect(await readdir(priv)).toEqual([]);
    },
    60000,
  );
});
