/**
 * 離線掃描——[#268](https://github.com/DemianLi/nexus-agent/issues/268) 的驗收。
 *
 * 前半是手寫的事件，量規則；後半是**真的組裝寫出來的 jsonl**，量規則跟執行期對不對得上。手寫的
 * fixture 只證明掃描照自己的理解數得對，證明不了那個理解就是提醒器的——鏈的邊界若跟執行期分岔，
 * 前半照樣全綠。
 *
 * **零憑證、零外部連線**：模型是 `LoopingChatModel` 與 `ScriptedChatModel`。
 */

import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';
import {
  attachSessionPersistence,
  REPEAT_REMINDER_MARKER,
  SESSION_LOG_FORMAT_VERSION,
} from '@nexus/core';
import type { NexusPlugin, RepeatReminderSettings, SessionEvent } from '@nexus/core';
import { createEchoPlugin, ECHO_TOOL_NAME } from '@nexus/plugin-echo';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createNexusAgent } from '../agent-factory.js';
import { createJsonlSessionStore } from '../jsonl-session-store.js';
import { LoopingChatModel } from '../looping-model.js';
import type { LoopingChatModelOptions } from '../looping-model.js';
import { ScriptedChatModel } from '../scripted-model.js';
import { ThreadPump } from '../thread-pump.js';
import type { PumpAgent } from '../thread-pump.js';
import {
  formatScanReport,
  readSessionLogs,
  scanSessionLog,
  UNCODED_ERROR,
} from './session-scan.js';
import type { SessionScan } from './session-scan.js';

/** 一顆手寫的事件：種類與酬載。種類刻意是 `string`，認不得的那條要寫得出來。 */
type Entry = readonly [type: string, data: Record<string, unknown>];

/** 排好 `seq` 的一份日誌。 */
function events(entries: readonly Entry[]): SessionEvent[] {
  return entries.map(
    ([type, data], seq) => ({ type, seq, time: seq, data }) as unknown as SessionEvent,
  );
}

let nextCall = 0;
/** 一次呼叫，`callId` 每次新的。 */
function call(name: string, args: Record<string, unknown>, callId = `c${nextCall++}`): Entry {
  return ['tool/call', { callId, name, arguments: JSON.stringify(args) }];
}

/** 同一個工具同一份參數，叫 n 次。 */
function same(n: number, name = 'grep'): Entry[] {
  return Array.from({ length: n }, () => call(name, { pattern: 'x' }));
}

const turn = (kind: 'message' | 'goal' | 'resume'): Entry => ['turn/start', { kind }];

function scan(
  entries: readonly Entry[],
  options: { version?: number; override?: Partial<RepeatReminderSettings> } = {},
): SessionScan {
  return scanSessionLog(
    {
      file: 'x.jsonl',
      header: { id: 's', version: options.version ?? SESSION_LOG_FORMAT_VERSION },
      events: events(entries),
    },
    options.override,
  );
}

describe('疑似打轉：同工具同參數連到提醒器的第二道門檻', () => {
  it('連叫 5 次標出來，4 次不標', () => {
    expect(scan([turn('message'), ...same(5)])).toMatchObject({
      looping: true,
      longestRun: { tool: 'grep', count: 5 },
    });
    expect(scan([turn('message'), ...same(4)])).toMatchObject({
      looping: false,
      longestRun: { count: 4 },
    });
  });

  it('同工具不同參數連叫 8 次不標', () => {
    const different = Array.from({ length: 8 }, (_, i) => call('grep', { pattern: `第 ${i} 次` }));
    expect(scan([turn('message'), ...different])).toMatchObject({
      looping: false,
      longestRun: { count: 1 },
      toolCalls: 8,
    });
  });

  it('門檻跟著提醒器的設定走，不是寫死的 5', () => {
    const four = [turn('message'), ...same(4)];
    expect(scan(four, { override: { thresholds: [3, 4, 8] } }).looping).toBe(true);
    const five = [turn('message'), ...same(5)];
    expect(scan(five, { override: { thresholds: [3, 6, 8] } }).looping).toBe(false);
  });

  it('只設一道門檻的設定讀不出「收過一次提醒還繼續」，當場拋', () => {
    expect(() => scan(same(5), { override: { thresholds: [3] } })).toThrow(/只設了一道門檻/);
  });

  it('屬性順序不同算同一次——日誌上的是序列化字串，要解開再規範化', () => {
    const run = [
      turn('message'),
      call('read', { path: 'a', limit: 1 }),
      call('read', { limit: 1, path: 'a' }),
    ];
    expect(scan(run).longestRun).toMatchObject({ count: 2 });
  });

  it('射程外的工具穿插進來，鏈不斷也不算它，但工具呼叫照數', () => {
    const interleaved = same(5).flatMap((entry) => [entry, call('todo_write', { todos: [] })]);
    const result = scan([turn('message'), ...interleaved], {
      override: { exclude: ['todo_*'] },
    });
    expect(result).toMatchObject({ looping: true, longestRun: { count: 5 }, toolCalls: 10 });
    // 對照：不排除的話每一次都被打斷。
    expect(scan([turn('message'), ...interleaved]).longestRun).toMatchObject({ count: 1 });
  });
});

describe('鏈的邊界對到提醒器的哪一條', () => {
  it('人講話清零：跨過 message 的重複不算', () => {
    expect(
      scan([turn('message'), ...same(3), turn('message'), ...same(3)]).longestRun,
    ).toMatchObject({ count: 3 });
  });

  it('續行輪次的頭也清零，同提醒器', () => {
    expect(scan([turn('message'), ...same(3), turn('goal'), ...same(3)]).longestRun).toMatchObject({
      count: 3,
    });
  });

  it('resume 不清零：回覆核准沒有新的人話', () => {
    expect(scan([turn('message'), ...same(3), turn('resume'), ...same(2)])).toMatchObject({
      looping: true,
      longestRun: { count: 5 },
    });
  });

  it('session/end-seed 清零：重開之後對話是空的', () => {
    const across = [turn('message'), ...same(3), ['session/end-seed', {}] as const, ...same(3)];
    expect(scan(across).longestRun).toMatchObject({ count: 3 });
  });

  it('同一個 callId 第二次出現不推進鏈，也不多算一次呼叫', () => {
    // 核准閘門中斷的那次：暫停那一輪留一顆，resume 那一輪以同一個 callId 再一顆。
    const gated = [
      turn('message'),
      ...same(3),
      call('grep', { pattern: 'x' }, 'gated'),
      ['interrupt/raised', { interruptId: 'i' }] as const,
      ['turn/end', {}] as const,
      turn('resume'),
      call('grep', { pattern: 'x' }, 'gated'),
      ['tool/result', { callId: 'gated', isError: false }] as const,
    ];
    expect(scan(gated)).toMatchObject({ looping: false, longestRun: { count: 4 }, toolCalls: 4 });
  });

  it('subagent 那份沒有 turn/start，鏈跨整份', () => {
    expect(scan(same(5)).looping).toBe(true);
  });
});

describe('工具錯誤依種類', () => {
  it('超時、拋錯、schema 違規各一顆：三個種類各 1，成功的不算', () => {
    const result = scan([
      turn('message'),
      call('slow', {}, 'a'),
      [
        'tool/result',
        { callId: 'a', isError: true, error: { name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' } },
      ],
      call('boom', {}, 'b'),
      ['tool/result', { callId: 'b', isError: true }],
      call('shape', {}, 'c'),
      [
        'tool/result',
        {
          callId: 'c',
          isError: true,
          error: { name: 'ToolOutputError', code: 'INVALID_TOOL_OUTPUT' },
        },
      ],
      call('fine', {}, 'd'),
      ['tool/result', { callId: 'd', isError: false }],
    ]);
    expect(result.errors).toEqual({
      TOOL_TIMEOUT: 1,
      [UNCODED_ERROR]: 1,
      INVALID_TOOL_OUTPUT: 1,
    });
    // 卡上的原話是「報表的三個種類各 1」，所以印出來的那一行也看一次。
    expect(formatScanReport([result], [], { threshold: 5 })).toContain(
      `  工具錯誤 INVALID_TOOL_OUTPUT×1 TOOL_TIMEOUT×1 ${UNCODED_ERROR}×1`,
    );
  });

  it('碼是從檔上讀的：叫 constructor 的碼照樣數成 1，不會讀到繼承來的東西', () => {
    const result = scan([
      call('odd', {}, 'x'),
      ['tool/result', { callId: 'x', isError: true, error: { name: 'E', code: 'constructor' } }],
    ]);
    expect(result.errors?.['constructor']).toBe(1);
  });
});

describe('中止的輪數（#276）', () => {
  const ABORTED: Entry = ['turn/end', { reason: { kind: 'aborted', cause: { kind: 'user' } } }];

  it('數 `turn/end` 帶 aborted 的那幾輪，正常結束的不算', () => {
    const result = scan([
      turn('message'),
      ABORTED,
      turn('message'),
      ['turn/end', {}],
      turn('message'),
      ABORTED,
    ]);
    expect(result.aborted).toBe(2);
    expect(formatScanReport([result], [], { threshold: 5 })).toContain('  中止 2 輪');
  });

  it('v6 以前沒有中止這條路：那一格是 null，報表印「—」並講明', () => {
    const old = scan([turn('message'), ['turn/end', {}]], { version: 6 });
    expect(old.aborted).toBeNull();
    const text = formatScanReport([old], [], { threshold: 5 }).join('\n');
    expect(text).toContain('  中止 — 輪');
    expect(text).toContain('格式版本 6：第 7 版才記中止');
  });
});

describe('照格式版本表態', () => {
  it('認不得的事件種類不崩：略過、報數，認得的照算', () => {
    const result = scan([turn('message'), ['future/thing', { anything: 1 }], ...same(5)]);
    expect(result).toMatchObject({ unknownEvents: 1, looping: true, toolCalls: 5 });
  });

  it('v4 沒有工具事件、v5 沒有模型起訖：那幾格是 null 不是 0', () => {
    expect(scan([turn('message')], { version: 4 })).toMatchObject({
      steps: null,
      toolCalls: null,
      longestRun: null,
      errors: null,
      looping: null,
    });
    expect(scan([turn('message'), ...same(2)], { version: 5 })).toMatchObject({
      steps: null,
      toolCalls: 2,
    });
    expect(scan([turn('message'), ['model/start', {}], ['model/end', {}]])).toMatchObject({
      steps: 1,
    });
  });

  it('報表把版本講出來：比這一版新、比這一版舊，各一句', () => {
    const newer = scan([turn('message'), ['future/thing', {}]], {
      version: SESSION_LOG_FORMAT_VERSION + 1,
    });
    const older = scan([turn('message')], { version: 4 });
    const text = formatScanReport([newer, older], [], { threshold: 5 }).join('\n');
    expect(text).toContain(`比這一版（${SESSION_LOG_FORMAT_VERSION}）新：1 顆認不得的事件略過了`);
    expect(text).toContain('格式版本 4：第 5 版才記工具事件、第 6 版才記模型起訖');
    expect(text).toContain('步數 — ｜工具呼叫 — ｜最長重複 —');
  });

  it('#273 之前的拒絕記成成功這件事，每次都印在報表底下', () => {
    expect(formatScanReport([], [], { threshold: 5 }).join('\n')).toContain('#273');
  });

  it('base 底下的印相對路徑，外面的照印絕對路徑', () => {
    const inside = { ...scan(same(1)), file: '/logs/run/cli.jsonl' };
    const outside = { ...scan(same(1)), file: '/elsewhere/cli.jsonl' };
    const text = formatScanReport([inside, outside], [], { threshold: 5, base: '/logs' }).join(
      '\n',
    );
    expect(text).toContain('  run/cli.jsonl');
    expect(text).toContain('  /elsewhere/cli.jsonl');
    expect(text).not.toContain('../');
  });

  it('疑似打轉的排在前面', () => {
    const quiet = { ...scan(same(1)), file: 'a.jsonl' };
    const loud = { ...scan(same(5)), file: 'b.jsonl' };
    const text = formatScanReport([quiet, loud], [], { threshold: 5 }).join('\n');
    expect(text.indexOf('b.jsonl')).toBeLessThan(text.indexOf('a.jsonl'));
    expect(text).toContain('疑似打轉 1 份');
  });
});

/** 在 `directory` 裡寫一份會話，照 JSONL 後端的寫法。 */
async function writeSession(
  root: string,
  id: string,
  entries: readonly Entry[],
  extra: { parentSession?: string } = {},
): Promise<string> {
  const store = createJsonlSessionStore({ rootDir: root });
  const stored = store.create({
    version: SESSION_LOG_FORMAT_VERSION,
    id,
    createdAt: 0,
    ...extra,
  });
  await stored.append(events(entries));
  await stored.close();
  return store.directory;
}

describe('讀磁碟：唯讀，壞一份不擋其餘', () => {
  it('往下找到每一份；壞檔報成讀不懂，撕裂的尾巴照 JSONL 後端的規則不算', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-scan-'));
    const runA = await writeSession(root, 'cli', [turn('message'), ...same(5)]);
    await writeSession(root, 'cli/sub-1', same(2), { parentSession: 'cli' });
    const runB = await writeSession(root, 'broken', [turn('message')]);
    // 中段一行壞掉：不是當掉，是壞檔。
    await writeFile(join(runB, 'broken.jsonl'), 'not json\n{"type":"turn/end"}\n');
    // 尾巴寫到一半：當掉的常態。
    const torn = join(runA, 'cli.jsonl');
    const before = await readFile(torn, 'utf8');
    await writeFile(torn, `${before}{"type":"tool/ca`);
    // 寫的那一方自己會留鎖檔（租約），所以比的是掃描前後，不是「沒有鎖檔」。
    const listing = async () => [...(await readdir(runA)), ...(await readdir(runB))].sort();
    const namesBefore = await listing();

    const { logs, unreadable } = await readSessionLogs([root]);
    expect(logs.map((log) => log.header.id).sort()).toEqual(['cli', 'cli/sub-1']);
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]?.reason).toContain('第 1 行不是 JSON');

    const cli = logs.find((log) => log.header.id === 'cli');
    expect(cli === undefined ? undefined : scanSessionLog(cli).looping).toBe(true);
    const sub = logs.find((log) => log.header.id === 'cli/sub-1');
    expect(sub === undefined ? undefined : scanSessionLog(sub).parentSession).toBe('cli');

    // 唯讀：目錄裡沒多出任何東西（續接那條會留鎖、會截尾巴），撕裂的尾巴也還在。
    expect(await listing()).toEqual(namesBefore);
    expect(await readFile(torn, 'utf8')).toBe(`${before}{"type":"tool/ca`);
  });

  /**
   * **這條才分得出唯讀與否**：上面那條的鎖檔名跟寫的那一方同名，走續接的讀法也不會多出檔案。
   * 一個還開著的寫入把手握著租約，續接那條會拋 `SessionAlreadyOwnedError`；掃描照讀。
   */
  it('一個還在寫的行程握著租約，照樣讀得到，也不擋它繼續寫', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-scan-live-writer-'));
    const store = createJsonlSessionStore({ rootDir: root });
    const stored = store.create({ version: SESSION_LOG_FORMAT_VERSION, id: 'cli', createdAt: 0 });
    const written = events([turn('message'), ...same(5)]);
    try {
      await stored.append(written);
      const { logs } = await readSessionLogs([root]);
      expect(logs.map((log) => scanSessionLog(log).looping)).toEqual([true]);
      await stored.append([
        { type: 'turn/end', seq: written.length, time: 0, data: {} } as SessionEvent,
      ]);
    } finally {
      await stored.close();
    }
  });

  it('根目錄不存在就拋——打錯路徑不是一份空報表', async () => {
    await expect(readSessionLogs([join(tmpdir(), 'nexus-scan-不存在')])).rejects.toThrow();
  });
});

/** 一輪 prompt 裡提醒器的提醒全文。 */
function reminderTexts(prompts: readonly (readonly BaseMessage[])[]): string[] {
  return prompts
    .flat()
    .filter(
      (message) =>
        HumanMessage.isInstance(message) &&
        message.additional_kwargs[REPEAT_REMINDER_MARKER] != null,
    )
    .map((message) => message.text);
}

/**
 * 真的組裝接上 pump 與 JSONL 後端（serve 那條路的形狀），跑完之後掃那個目錄。
 *
 * @returns 掃出來的每一份，與 root 那一份原樣的事件。
 */
async function runAndScan(
  model: ScriptedChatModel | LoopingChatModel,
  plugins: readonly NexusPlugin[],
  drive: (pump: ThreadPump) => Promise<void>,
  options: { recursionLimit?: number } = {},
): Promise<{ scans: SessionScan[]; root: readonly SessionEvent[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-scan-live-'));
  const store = createJsonlSessionStore({ rootDir: dir });
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    plugins: [...plugins],
    summarization: false,
    ...(options.recursionLimit !== undefined && { recursionLimit: options.recursionLimit }),
  });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'scan-root');
  const detach = built.attachSession(pump.sessions);
  const persistence = attachSessionPersistence(pump.sessions, store);
  try {
    await drive(pump);
  } finally {
    await persistence.dispose();
    detach();
    await built.dispose();
  }
  const { logs, unreadable } = await readSessionLogs([store.directory]);
  expect(unreadable).toEqual([]);
  const root = logs.find((log) => log.header.id === 'scan-root');
  return { scans: logs.map((log) => scanSessionLog(log)), root: root?.events ?? [] };
}

describe('跟真的組裝對得上', () => {
  /**
   * **判準是兩邊一起**：提醒器真的送出了第 5 次那條詳細提醒，掃描也標了這一份。只斷言掃描的話，
   * 規則跟執行期分岔時兩邊各自綠。`recursionLimit: 20` 在預設組裝上是 6 輪（每輪三格），
   * 夠到第二道門檻。
   */
  async function loop(options: LoopingChatModelOptions = {}) {
    const model = new LoopingChatModel({ toolName: ECHO_TOOL_NAME, ...options });
    const run = await runAndScan(
      model,
      [createEchoPlugin()],
      async (pump) => {
        await expect(pump.submit({ kind: 'message', text: '一直跑' })).rejects.toThrow(
          /Recursion limit/,
        );
      },
      { recursionLimit: 20 },
    );
    return { ...run, reminders: reminderTexts(model.seen) };
  }

  it('同參數迴圈：提醒器發到第二道門檻，掃描也標了', async () => {
    const { scans, reminders } = await loop();
    expect(reminders.some((text) => text.includes('- consecutive_calls: 5'))).toBe(true);
    expect(scans).toHaveLength(1);
    expect(scans[0]).toMatchObject({ looping: true, longestRun: { tool: ECHO_TOOL_NAME } });
    expect(scans[0]?.longestRun?.count).toBeGreaterThanOrEqual(5);
  });

  it('對照：每次參數不同，提醒器一條都沒發，掃描也不標', async () => {
    const { scans, reminders } = await loop({ argsFor: (n) => ({ message: `第 ${n} 次` }) });
    expect(reminders).toEqual([]);
    expect(scans[0]).toMatchObject({ looping: false, longestRun: { count: 1 } });
  });

  /**
   * **核准那次在真的日誌上同一個 `callId` 記了兩顆**——先斷言這個前提，不然「去重」量的是一件
   * 沒發生的事。
   */
  it('停在核准點再 resume：日誌上兩顆同 callId，掃描只算一次', async () => {
    const tools: NexusPlugin = {
      name: 'scan-tools',
      apply(registry) {
        registry.tools.register(
          tool(() => '做完了', { name: 'danger', description: '要核准。', schema: z.object({}) }),
        );
        registry.approvals.gate((exec, next) =>
          exec.name === 'danger' ? { kind: 'ask', reason: '危險' } : next(),
        );
      },
    };
    const model = new ScriptedChatModel({
      turns: [
        { content: '動手。', toolCalls: [{ name: 'danger', args: {} }] },
        { content: '好了。' },
      ],
    });
    const { scans, root } = await runAndScan(model, [tools], async (pump) => {
      await pump.submit({ kind: 'message', text: '做危險的事' });
      await pump.submit({
        kind: 'resume',
        interruptId: pump.pendings[0]?.interruptId ?? '',
        response: { decisions: [{ type: 'approve' }] },
      });
    });
    const calls = root.filter((event) => event.type === 'tool/call');
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((event) => event.data.callId)).size).toBe(1);
    expect(scans[0]).toMatchObject({ toolCalls: 1, longestRun: { count: 1 }, errors: {} });
  });
});
