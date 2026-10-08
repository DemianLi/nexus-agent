/**
 * 續接之後模型記得之前的對話——[#306](https://github.com/DemianLi/nexus-agent/issues/306)「模型記得」那一半的驗收。
 *
 * **判準是模型真的收到了什麼**，不是日誌、也不是畫面：`runCli` 與 `runServe` 不交出 agent，所以掛一顆記下每一次
 * 模型請求的 middleware（`conversation-restore.fixture.ts`）。續接是**另一個 `runCli`／另一台 server**，
 * 不是同一個行程裡切回去——同一個行程裡 `MemorySaver` 還在，不灌也記得，那樣的驗收有沒有這個功能都綠。
 *
 * 推的規則在 `@nexus/core` 的 `conversation-replay.test.ts`；這裡只問入口有沒有接上、接上之後供應商那側收到的
 * 對不對。
 */

import { appendFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import {
  fromLoggedMessage,
  SessionLog,
  SessionRegistry,
  toLoggedMessage,
  TOOL_OUTCOME_UNKNOWN_TEXT,
} from '@nexus/core';
import type { PluginEntry, SessionEvent } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PrunedMemorySaver } from './pruned-memory-saver.js';
import { createNexusAgent } from './agent-factory.js';
import { runCli } from './cli.js';
import { seenRequests } from './conversation-restore.fixture.js';
import { restoreConversation, toolResultAsSeen } from './conversation-restore.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import { foldTurn, serveClient } from './fixtures.js';

const FIXTURE = fileURLToPath(new URL('./conversation-restore.patch.yml', import.meta.url));

/** 一次請求攤成「類別:文字」。 */
function shape(messages: readonly BaseMessage[]): string[] {
  return messages
    .filter((message) => message.getType() !== 'system')
    .map((message) =>
      ToolMessage.isInstance(message)
        ? `tool:${message.text}`
        : `${message.getType()}:${message.text}`,
    );
}

/** 上一次「記住暗號是藍鯨」那一輪，照 CLI 的假模型腳本走完之後，模型下一次會收到的前六則。 */
const REMEMBERED = [
  'human:記住暗號是藍鯨',
  'ai:先回聲一次，確認工具接得上。',
  'tool:回聲：CLI 接線測試',
  'ai:再寫一個檔，確認檔案系統接得上。',
  "tool:Successfully wrote to '/cli.md'",
  'ai:工具回來了，這條線是通的。',
];

async function readLog(path: string): Promise<SessionEvent[]> {
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
}

/** 接在日誌尾巴上幾顆事件，`seq` 接著排——上一個行程停在那裡的樣子。 */
async function appendTail(
  logPath: string,
  events: readonly Pick<SessionEvent, 'type' | 'data'>[],
): Promise<void> {
  const next = (await readLog(logPath)).length;
  const lines = events.map((event, index) =>
    JSON.stringify({ ...event, seq: next + index, time: 1 }),
  );
  await appendFile(logPath, `${lines.join('\n')}\n`);
}

describe('CLI 的 --resume', () => {
  let logs: string;

  beforeEach(async () => {
    logs = await mkdtemp(join(tmpdir(), 'nexus-restore-logs-'));
    seenRequests.length = 0;
  });

  afterEach(async () => {
    await rm(logs, { recursive: true, force: true });
  });

  async function cli(argv: readonly string[], lines: string): Promise<string> {
    const out: string[] = [];
    const input = new PassThrough();
    input.end(lines);
    await runCli({
      argv: [...argv, '--patch', FIXTURE],
      input,
      output: new PassThrough(),
      printer: { log: (line) => void out.push(line), error: (line) => void out.push(line) },
    });
    return out.join('\n');
  }

  /** 第一次跑：說一句話、跑完那一輪，離開。回 run 目錄。 */
  async function firstRun(): Promise<string> {
    await cli(['--session-log', logs], '記住暗號是藍鯨\n/exit\n');
    // 前提：記錄器真的接上了，而且一個新的行程從空的開始。
    expect(shape(seenRequests[0] ?? [])).toEqual(['human:記住暗號是藍鯨']);
    seenRequests.length = 0;
    const [entry] = await readdir(logs);
    return join(logs, entry!);
  }

  it('上一次的人話、回覆、工具結果，都在續接之後第一次請求裡', async () => {
    const runDir = await firstRun();
    const stdout = await cli(['--resume', runDir], '暗號是什麼\n/exit\n');

    expect(shape(seenRequests[0] ?? [])).toEqual([...REMEMBERED, 'human:暗號是什麼']);
    expect(stdout).toContain('對話照日誌推回模型（6 則）');
    expect(stdout).toContain('虛擬檔案系統與會話歷史檔沒有回來');
    expect(stdout).not.toContain('[不變量]');
  });

  it('接第二次：第二段也回來，第一段沒有重複', async () => {
    const runDir = await firstRun();
    await cli(['--resume', runDir], '暗號是什麼\n/exit\n');
    seenRequests.length = 0;
    await cli(['--resume', runDir], '再說一次\n/exit\n');

    expect(shape(seenRequests[0] ?? [])).toEqual([
      ...REMEMBERED,
      'human:暗號是什麼',
      ...REMEMBERED.slice(1),
      'human:再說一次',
    ]);
  });

  /**
   * 續接時另記這一次實際載入的清單（#1138）：header 沿用最初那一份，這一顆才說得出現在跑的是哪些。
   * 連續兩次空轉的續接只留一顆（內容相同不疊），而且第二次沒有多疊 `session/end-seed`。
   */
  it('續接寫一顆 session/resumed，帶這一次的插件清單；空轉的續接不疊', async () => {
    const runDir = await firstRun();
    const log = join(runDir, 'cli.jsonl');
    const count = async (type: string) =>
      (await readLog(log)).filter((event) => event.type === type).length;

    // 兩次什麼都沒說的續接：第一次記一顆，第二次內容相同不疊，也沒有多疊一顆 `session/end-seed`。
    await cli(['--resume', runDir], '/exit\n');
    await cli(['--resume', runDir], '/exit\n');
    expect([await count('session/resumed'), await count('session/end-seed')]).toEqual([1, 1]);
    const resumed = (await readLog(log)).filter((event) => event.type === 'session/resumed');
    expect(resumed[0]?.ignorable).toBe(true);
    const data = resumed[0]?.data as { plugins: readonly { id?: string }[] };
    expect(data.plugins.map((row) => row.id)).toContain('request-recorder');

    // 第三次說了話（清單沒變，緊接在上一顆後面，不另記）；再下一次續接前面隔了一輪，才是新的一段：再記一顆。
    await cli(['--resume', runDir], '暗號是什麼\n/exit\n');
    await cli(['--resume', runDir], '/exit\n');
    expect([await count('session/resumed'), await count('session/end-seed')]).toEqual([2, 2]);
  });

  /**
   * 核准政策跟著日誌走（#437）：上一次切成 `never`，`--resume` 之後仍是 `never`，空轉的續接不重釘一顆。
   * 沒讀日誌的話，控制器照預設 `ask` 起算、日誌尾巴多一顆 `ask`——這條會紅。
   */
  it('核准政策跟著日誌走：記著 never 的日誌，續接之後不被預設的 ask 蓋回去', async () => {
    const runDir = await firstRun();
    const log = join(runDir, 'cli.jsonl');
    const policies = async () =>
      (await readLog(log))
        .filter((event) => event.type === 'approval/policy')
        .map((event) => event.data);
    expect(await policies()).toEqual([{ policy: 'ask' }]);
    await appendTail(log, [{ type: 'approval/policy', data: { policy: 'never' } }]);

    await cli(['--resume', runDir], '/exit\n');
    await cli(['--resume', runDir], '/exit\n');
    expect(await policies()).toEqual([{ policy: 'ask' }, { policy: 'never' }]);
  });

  /**
   * **斷言的是那一則的字**：拿掉補結果這一步，基座的 `patchToolCallsMiddleware` 照樣補一則（實測），那一輪照樣
   * 不會被供應商拒收——只看「沒被拒收」的話這條驗收有沒有這個功能都綠。
   */
  it('上一次停在工具跑到一半：補的是 dsh 那句「結果不明」，不是基座那句', async () => {
    const runDir = await firstRun();
    await appendTail(join(runDir, 'cli.jsonl'), [
      { type: 'turn/start', data: { kind: 'message', text: '再回聲一次' } },
      { type: 'model/start', data: {} },
      {
        type: 'assistant/message',
        data: {
          message: toLoggedMessage(
            new AIMessage({
              content: '跑一下',
              tool_calls: [{ id: 'dead-1', name: 'echo', args: { message: '半路' } }],
            }),
          ),
        },
      },
      { type: 'model/end', data: {} },
      {
        type: 'tool/call',
        data: { callId: 'dead-1', name: 'echo', arguments: '{"message":"半路"}' },
      },
    ]);

    const stdout = await cli(['--resume', runDir], '還在嗎\n/exit\n');

    expect(shape(seenRequests[0] ?? []).slice(-4)).toEqual([
      'human:再回聲一次',
      'ai:跑一下',
      `tool:${TOOL_OUTCOME_UNKNOWN_TEXT}`,
      'human:還在嗎',
    ]);
    expect(stdout).not.toContain('[不變量]');
  });

  /**
   * **#1190**：第一次模型呼叫就沒正常回來（按了停止、或供應商拋錯），整份日誌一則回覆都沒有。這不是舊格式漏記，
   * 線上的圖狀態也留著使用者那句話，所以續接之後的第一次請求要帶它。修之前整份拒推，模型只看到續接後的新話。
   */
  it.each([
    ['按了停止', 'aborted' as const, { kind: 'aborted', cause: { kind: 'user' } }],
    ['供應商拋錯', 'error' as const, undefined],
  ])('第一次呼叫就沒正常回來（%s）：使用者那句話回來了', async (_, outcome, reason) => {
    // 只有 header 的空日誌，再補上沒回覆的那一輪。
    await cli(['--session-log', logs], '/exit\n');
    const [entry] = await readdir(logs);
    const runDir = join(logs, entry!);
    await appendTail(join(runDir, 'cli.jsonl'), [
      { type: 'turn/start', data: { kind: 'message', text: '第一句，沒得到回覆' } },
      { type: 'model/start', data: {} },
      { type: 'model/end', data: { outcome, modelCall: 1 } },
      reason === undefined
        ? { type: 'turn/failed', data: { message: '供應商掛了' } }
        : { type: 'turn/end', data: { reason } },
    ]);
    seenRequests.length = 0;

    const stdout = await cli(['--resume', runDir], '還在嗎\n/exit\n');

    expect(shape(seenRequests[0] ?? [])).toEqual(['human:第一句，沒得到回覆', 'human:還在嗎']);
    expect(stdout).toContain('對話照日誌推回模型（1 則）');
  });

  it('舊格式（一輪叫過模型卻沒有回覆）：不灌半截，模型從空的開始，講原因', async () => {
    const runDir = await firstRun();
    await appendTail(join(runDir, 'cli.jsonl'), [
      { type: 'turn/start', data: { kind: 'message', text: '舊的一輪' } },
      { type: 'model/start', data: {} },
      { type: 'model/end', data: {} },
      { type: 'turn/end', data: {} },
    ]);

    const stdout = await cli(['--resume', runDir], '還在嗎\n/exit\n');

    expect(shape(seenRequests[0] ?? [])).toEqual(['human:還在嗎']);
    expect(stdout).toContain('對話從空的開始：日誌裡有模型正常回來的呼叫，卻沒有記到回覆');
  });
});

describe('serve 重開之後', () => {
  let running: RunningServe | undefined;

  beforeEach(() => {
    seenRequests.length = 0;
  });

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  async function start(root: string, lines: string[] = []): Promise<RunningServe> {
    running = await runServe({
      argv: ['--port', '0', '--session-log', root, '--patch', FIXTURE],
      log: (line) => void lines.push(line),
      env: {},
    });
    return running as RunningServe;
  }

  async function stop(server: RunningServe): Promise<void> {
    await server.close();
    running = undefined;
  }

  /** 說一句話，等這一輪收掉。 */
  async function say(server: RunningServe, threadId: string, prompt: string): Promise<void> {
    const client = await serveClient(server);
    const events = await client.openEvents(threadId);
    await client.runStart(threadId, prompt);
    await foldTurn(events);
    await events.return?.(undefined);
  }

  it('同一條 thread：重開之後第一次請求帶著上一次的對話，伺服器日誌講得出來', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-restore-serve-'));
    const first = await start(root);
    await say(first, 'alpha', '記住暗號是藍鯨');
    await stop(first);
    seenRequests.length = 0;

    const lines: string[] = [];
    const second = await start(root, lines);
    await say(second, 'alpha', '暗號是什麼');

    expect(shape(seenRequests[0] ?? [])).toEqual([...REMEMBERED, 'human:暗號是什麼']);
    expect(lines.join('\n')).toContain(
      '[會話日誌] thread "alpha" 接回來了：對話照日誌推回模型（6 則）',
    );
  });

  it('對照：沒寫過的 thread 從空的開始', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-restore-serve-'));
    const server = await start(root);
    await say(server, 'beta', '第一句');

    expect(shape(seenRequests[0] ?? [])).toEqual(['human:第一句']);
  });
});

/**
 * **過大的工具結果推回去的是模型當時看到的那則**：日誌記的是全文，基座在模型那一格換成預覽。重算的程式碼抄自
 * 基座（它沒匯出），所以拿真的基座換出來的那則逐字比對——升級基座時字變了，紅在這裡。
 */
describe('過大的工具結果', () => {
  async function evicted(body: string): Promise<{ seen: ToolMessage; logged: ToolMessage }> {
    const big: PluginEntry = {
      plugin: {
        name: 'big',
        apply(registry) {
          registry.tools.register(
            tool(async () => body, { name: 'big', description: '回一大段', schema: z.object({}) }),
          );
        },
      },
    };
    const { agent, attachSession, dispose } = await createNexusAgent({
      model: new ScriptedChatModel({
        turns: [{ content: '拿', toolCalls: [{ name: 'big', args: {} }] }, { content: '好' }],
      }),
      checkpointer: new PrunedMemorySaver(),
      plugins: [big],
    });
    const sessions = new SessionRegistry('big');
    const detach = attachSession(sessions);
    const config = { configurable: { thread_id: 'big' } };
    try {
      await agent.invoke(toAgentInvocation('拿大的'), config);
      const state = (await agent.getState(config)) as { values: { messages: BaseMessage[] } };
      const seen = state.values.messages.find((message) => ToolMessage.isInstance(message));
      const result = sessions.root.events.find((event) => event.type === 'tool/result');
      const logged = result?.type === 'tool/result' ? result.data.message : undefined;
      if (seen === undefined || logged === undefined) throw new Error('那一輪沒有工具結果');
      return { seen: seen as ToolMessage, logged: fromLoggedMessage(logged) as ToolMessage };
    } finally {
      detach();
      await dispose();
    }
  }

  const manyLines = Array.from(
    { length: 3_000 },
    (_, index) => `第 ${index} 行：${'x'.repeat(30)}`,
  );

  it.each([
    ['很多行（頭尾預覽）', manyLines.join('\n')],
    ['一整行、結尾有換行（不滿十行那一支）', `${'y'.repeat(90_000)}\n`],
  ])('%s：重算出來的與基座換上的逐字相同', async (_, body) => {
    const { seen, logged } = await evicted(body);

    // 前提：日誌記的是全文，基座真的換了。
    expect(logged.text).toBe(body);
    expect(seen.text).not.toBe(body);
    expect(toolResultAsSeen(logged).text).toBe(seen.text);
  });

  it('灌回去的就是重算過的那則', async () => {
    const log = new SessionLog('big');
    log.append('turn/start', { kind: 'message', text: '拿大的' });
    log.append('assistant/message', {
      message: toLoggedMessage(
        new AIMessage({ content: '拿', tool_calls: [{ id: 'c1', name: 'big', args: {} }] }),
      ),
    });
    log.append('tool/call', { callId: 'c1', name: 'big', arguments: '{}' });
    const body = manyLines.join('\n');
    log.append('tool/result', {
      callId: 'c1',
      isError: false,
      message: toLoggedMessage(new ToolMessage({ content: body, tool_call_id: 'c1', name: 'big' })),
    });
    log.append('assistant/message', { message: toLoggedMessage(new AIMessage('拿到了')) });
    log.append('turn/end', {});
    const written: Record<string, unknown>[] = [];

    await restoreConversation(
      {
        updateState: async (_config, values) => {
          written.push(values);
          return {};
        },
      },
      'big',
      log.events,
    );

    const [, , result] = written[0]?.messages as BaseMessage[];
    expect(result?.text).not.toBe(body);
    expect(result?.text).toBe(
      toolResultAsSeen(new ToolMessage({ content: body, tool_call_id: 'c1', name: 'big' })).text,
    );
  });

  it('沒過門檻、或是基座不搬的那幾顆：原樣', () => {
    const small = new ToolMessage({ content: '小', tool_call_id: 'c1', name: 'big' });
    const excluded = new ToolMessage({
      content: 'z'.repeat(90_000),
      tool_call_id: 'c2',
      name: 'grep',
    });

    expect(toolResultAsSeen(small)).toBe(small);
    expect(toolResultAsSeen(excluded)).toBe(excluded);
  });
});
