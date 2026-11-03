/**
 * 嵌入版設定檔（[#2367](https://github.com/DemianLi/nexus-agent/issues/2367)），走產品的線：真的 `runServe`、模型換成腳本，嵌入連線打
 * `/embed/threads/…`，跟獨立頁面同一台 serve。
 *
 * 每一條拒絕各一條測試，拿掉就紅；設定檔綁在 thread 上那兩條（嵌入連線不准接手、從獨立頁打開仍照嵌入版組）也量重啟之後。
 * MCP 工具照那一列的 `approval`（D171）的那一條在最後，接 [`mcp-fixture-server.ts`](./mcp-fixture-server.ts)。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { publicToolName } from '@nexus/plugin-mcp';
import type { ConversationState, Event, WireClient } from '@nexus/wire';
import {
  createWireClient,
  EMBED_PATH_PREFIX,
  emptyConversation,
  isApprovalPending,
  reduceConversation,
  THREAD_NOT_EMBEDDED,
} from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { embedApprovalReason } from './embed-profile.js';
import { exchangeServeToken, fetchWithCookie } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';

const SERVER = fileURLToPath(new URL('./mcp-fixture-server.ts', import.meta.url));
const HARNESS = fileURLToPath(new URL('..', import.meta.url));
const RECORD = publicToolName('crm', 'record_order');
const SEARCH = publicToolName('crm', 'orders.search');

const temps: string[] = [];
let served: ScriptedServe | undefined;
/** 模型每一次被叫時綁著的工具名。 */
let bound: string[][];

beforeEach(() => {
  bound = [];
  const stream = ScriptedChatModel.prototype._streamResponseChunks;
  vi.spyOn(ScriptedChatModel.prototype, '_streamResponseChunks').mockImplementation(function (
    this: ScriptedChatModel,
    ...args
  ) {
    bound.push(this.boundTools.map((tool) => (tool as { name: string }).name));
    return stream.apply(this, args);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await served?.close();
  served = undefined;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

interface Clients {
  readonly full: WireClient;
  readonly embed: WireClient;
}

/** 起一台 serve（落盤開著，`--session-log`），交回獨立頁面與嵌入版兩個客戶端。同一個 `logs` 再起就是重啟。 */
async function start(
  turns: readonly ScriptedTurn[],
  options: { readonly logs?: string; readonly extraRows?: string } = {},
): Promise<Clients & { readonly logs: string }> {
  await served?.close();
  const logs = options.logs ?? temp('nexus-embed-logs-');
  served = await startScriptedServe(turns, {
    argv: ['--session-log', logs],
    ...(options.extraRows !== undefined && { extraRows: options.extraRows }),
  });
  const cookie = await exchangeServeToken(served.running.authenticatedUrl);
  const fetch = fetchWithCookie(cookie);
  return {
    logs,
    full: createWireClient({ baseUrl: served.running.url, fetch }),
    embed: createWireClient({ baseUrl: `${served.running.url}${EMBED_PATH_PREFIX}`, fetch }),
  };
}

async function until(
  events: AsyncGenerator<Event, void, undefined>,
  done: (state: ConversationState) => boolean,
): Promise<ConversationState> {
  let state = emptyConversation();
  while (!done(state)) {
    const next = await events.next();
    if (next.done === true) throw new Error('下行斷了，還沒走到');
    state = reduceConversation(state, next.value);
  }
  return state;
}

const awaitingApproval = (state: ConversationState): boolean =>
  state.status === 'awaiting-input' && state.pendings.some(isApprovalPending);

const settledAfter =
  (turns: number) =>
  (state: ConversationState): boolean =>
    state.status === 'idle' &&
    state.entries.filter((entry) => entry.kind === 'ai' && !entry.streaming).length >= turns;

/** 停在核准卡，或跑完 n 輪：走錯路時不必等到逾時，由後面的斷言講出是哪一條。 */
const askedOrSettled =
  (turns: number) =>
  (state: ConversationState): boolean =>
    awaitingApproval(state) || settledAfter(turns)(state);

/** 說一句話，等這一輪跑完（或停在核准卡）。 */
async function say(
  client: WireClient,
  thread: string,
  turns = 1,
  text = '你好',
): Promise<ConversationState> {
  const events = await client.openEvents(thread);
  const sent = await client.runStart(thread, text);
  expect(sent).not.toHaveProperty('error');
  const state = await until(events, askedOrSettled(turns));
  await events.return(undefined);
  return state;
}

const hello: ScriptedTurn = { content: '你好。' };

describe('嵌入版沒有 / 與 @（#2365 第 2 點）', () => {
  it('slash.list 回空清單；同一台的獨立頁面照常有命令', async () => {
    const { full, embed } = await start([hello]);
    const embedded = await embed.slashList('e1');
    expect(embedded).toEqual({ kind: 'ok', commands: [] });
    const standalone = await full.slashList('f1');
    expect(standalone.kind === 'ok' && standalone.commands.length).toBeGreaterThan(0);
  }, 30_000);

  it('slash.run 回 not_supported，不跑命令', async () => {
    const { embed } = await start([hello]);
    const outcome = await embed.slashRun('e1', '/plan 寫一份計劃');
    expect(outcome).toMatchObject({ kind: 'rejected', code: 'not_supported' });
  }, 30_000);

  it('run.start 帶 mention 回 not_supported', async () => {
    const { embed } = await start([hello]);
    const sent = await embed.runStart('e1', '交給它', {
      mention: { kind: 'subagent', name: 'general-purpose' },
    });
    expect(sent).toMatchObject({ error: 'not_supported' });
  }, 30_000);

  it('白名單外的命令回 not_supported，列表與搜尋這類全域路由 404', async () => {
    const { embed } = await start([hello]);
    expect(await embed.modelCatalog('e1')).toMatchObject({
      kind: 'rejected',
      code: 'not_supported',
    });
    await expect(embed.listThreads()).rejects.toThrow(/404/u);
  }, 30_000);
});

describe('嵌入版不掛子代理（#2365 第 3 點）', () => {
  it('模型看不到 task 與背景的 subagent；獨立頁面看得到 subagent（serve 出廠是背景續行）', async () => {
    const { full, embed } = await start([hello, hello]);
    await say(embed, 'e1');
    expect(bound.at(-1)).toContain('read_file');
    expect(bound.at(-1)).not.toContain('task');
    expect(bound.at(-1)).not.toContain('subagent');
    await say(full, 'f1');
    expect(bound.at(-1)).toContain('subagent');
  }, 30_000);
});

describe('嵌入版沒標唯讀的工具要核准（#2365 第 10 點）', () => {
  const write: ScriptedTurn = {
    content: '寫。',
    toolCalls: [{ name: 'write_file', args: { file_path: '/a.md', content: 'x' } }],
  };
  const read: ScriptedTurn = {
    content: '讀。',
    toolCalls: [{ name: 'read_file', args: { file_path: '/a.md' } }],
  };

  it('write_file 停在核准卡，理由講是嵌入版；獨立頁面不問', async () => {
    const { full, embed } = await start([write, hello]);
    const embedded = await say(embed, 'e1', 2);
    const approval = embedded.pendings.find(isApprovalPending);
    expect(approval?.actions).toEqual([
      expect.objectContaining({ name: 'write_file', description: embedApprovalReason('write_file') }),
    ]);
    const standalone = await say(full, 'f1', 2);
    expect(standalone.pendings.some(isApprovalPending)).toBe(false);
  }, 30_000);

  it('read_file 不問', async () => {
    const { embed } = await start([read, hello]);
    const state = await say(embed, 'e1', 2);
    expect(state.pendings.some(isApprovalPending)).toBe(false);
  }, 30_000);
});

describe('設定檔綁在 thread 上', () => {
  it('嵌入連線碰獨立頁面開的 thread：在記憶體裡、重啟之後都回 thread_not_embedded', async () => {
    const first = await start([hello]);
    await say(first.full, 'f1');
    expect(await first.embed.runStart('f1', '接手')).toMatchObject({
      error: THREAD_NOT_EMBEDDED,
    });
    expect(await first.embed.threadHistory('f1')).toMatchObject({ kind: 'rejected' });

    const again = await start([hello], { logs: first.logs });
    expect(await again.embed.runStart('f1', '接手')).toMatchObject({
      error: THREAD_NOT_EMBEDDED,
    });
  }, 60_000);

  it('嵌入版開的 thread 重啟之後從獨立頁面打開，照樣不掛 task、沒有斜線命令', async () => {
    const first = await start([hello, hello]);
    await say(first.embed, 'e1');

    const again = await start([hello, hello, hello, hello], { logs: first.logs });
    await say(again.full, 'e1');
    expect(bound.at(-1)).not.toContain('task');
    expect(bound.at(-1)).not.toContain('subagent');
    expect(await again.full.slashList('e1')).toEqual({ kind: 'ok', commands: [] });
    // 嵌入連線照樣接得回來。
    await say(again.embed, 'e1');
  }, 60_000);
});

describe('MCP 工具照那一列的 approval（#1622，D171）', () => {
  /** 一列 MCP：`exempt` 免問的是 `orders.search`，其餘照 `default: ask`。 */
  function mcpRow(callLog: string): string {
    return `- insert:
    - id: mcp-crm
      name: '@nexus/plugin-mcp'
      config:
        serverName: crm
        connection:
          transport: stdio
          command: ${JSON.stringify(process.execPath)}
          args: ['--import', 'tsx', ${JSON.stringify(SERVER)}]
          cwd: ${JSON.stringify(HARNESS)}
          env: { FIXTURE_CALL_LOG: ${JSON.stringify(callLog)} }
        approval:
          exempt: ['orders.search']
`;
  }
  const calls = (callLog: string): string[] =>
    existsSync(callLog) ? readFileSync(callLog, 'utf8').split('\n').filter(Boolean) : [];

  it('要問的照樣問（嵌入版不放寬），server 一次都沒收到', async () => {
    const callLog = join(temp('nexus-embed-mcp-'), 'calls.log');
    const { embed } = await start(
      [{ content: '登記。', toolCalls: [{ name: RECORD, args: { item: '螺絲' } }] }, hello],
      { extraRows: mcpRow(callLog) },
    );
    const state = await say(embed, 'e1', 2);
    expect(state.pendings.find(isApprovalPending)?.actions).toEqual([
      expect.objectContaining({ name: RECORD }),
    ]);
    expect(calls(callLog)).toEqual([]);
  }, 60_000);

  it('那一列標了免問的不問（嵌入版不另外加問），server 收到一次', async () => {
    const callLog = join(temp('nexus-embed-mcp-'), 'calls.log');
    const { embed } = await start(
      [{ content: '查。', toolCalls: [{ name: SEARCH, args: { query: '螺絲' } }] }, hello],
      { extraRows: mcpRow(callLog) },
    );
    const state = await say(embed, 'e1', 2);
    expect(state.pendings.some(isApprovalPending)).toBe(false);
    expect(calls(callLog)).toEqual(['orders.search']);
  }, 60_000);
});
