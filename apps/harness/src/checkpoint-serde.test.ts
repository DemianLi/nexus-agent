/**
 * 存檔點寫得進去就讀得回來、寫不進去就大聲拋（[#1658](https://github.com/DemianLi/nexus-agent/issues/1658)）。
 *
 * 深的東西進 graph state 有兩條路，兩條都走真的 `serve`（`--live` 對假端點）：
 *
 * - **同台**：模型回一個參數很深的工具呼叫。日誌那一關最多收 {@link SESSION_EVENT_MAX_DEPTH} 層，但 state 不經過那一關，
 *   比上限深的照樣進 state，這一輪結束寫存檔點時才碰到序列化。
 * - **續接**：日誌裡的舊事件（上限出現之前寫下的）灌回 state（`conversation-restore.ts`）。這裡用改檔造：第一台真跑一輪，
 *   把那一行的工具參數換成深的，`additional_kwargs` 裡的原始字串一起換。
 *
 * 層數兩種單位：「參數 N 層」是工具參數 `{v: ...}` 裡 `v` 那一串交錯巢狀有幾層（#1658 探針用的單位，44 讀得回、46 撞上
 * `load` 預設的 50 層）；「事件 N 層」是日誌那一關量的（`data` 算第 1 層）。
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AIMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { SESSION_EVENT_MAX_DEPTH } from '@nexus/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CHECKPOINT_DEPTH_EXCEEDED,
  CHECKPOINT_MAX_DEPTH,
  CHECKPOINT_UNSERIALIZABLE,
  CHECKPOINT_WRAPPER_DEPTH,
  DepthCheckedSerializer,
  checkpointDepth,
} from './checkpoint-serde.js';
import { foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { projectKey } from './jsonl-session-store.js';
import { fakeEndpoint, hasTools, liveModelPatch } from './log-derived-history.fixture.js';
import type { Body, FakeEndpoint, Reply, WireMessage } from './log-derived-history.fixture.js';
import { PrunedMemorySaver } from './pruned-memory-saver.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

vi.stubEnv('NVIDIA_API_KEY', 'nvapi-fake-for-checkpoint-serde');

/** `levels` 層物件與陣列交錯的巢狀。 */
function mixed(levels: number): unknown {
  let value: unknown = 'leaf';
  for (let level = 0; level < levels; level++) value = level % 2 ? { next: value } : [value];
  return value;
}

/**
 * 事件剛好 {@link SESSION_EVENT_MAX_DEPTH} 層時參數有幾層：`assistant/message` 的 `data` → `message` → `data` →
 * `tool_calls` → `[0]` → `args` 是 6 層，`v` 從第 7 層開始。下面每一格都量真的那一行核對。
 */
const AT_LOG_CAP = SESSION_EVENT_MAX_DEPTH - 6;

/** 純 JSON 的層數，同日誌那一關的算法。 */
function jsonDepth(value: unknown): number {
  let max = 0;
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length > 0) {
    const [current, depth] = stack.pop()!;
    if (current === null || typeof current !== 'object') continue;
    max = Math.max(max, depth);
    for (const item of Object.values(current)) stack.push([item, depth + 1]);
  }
  return max;
}

describe('DepthCheckedSerializer', () => {
  it('釘住基座版本：@langchain/langgraph-checkpoint 是 1.1.5（升版就重新核對 checkpoint-serde.ts 複製的那幾段）', async () => {
    const require = createRequire(import.meta.url);
    const own = require.resolve('@langchain/langgraph-checkpoint/package.json');
    // LangGraph 自己解析到的那一份——`MemorySaver` 與它預設的 serializer 來自這裡。
    const graph = createRequire(fileURLToPath(import.meta.resolve('@langchain/langgraph'))).resolve(
      '@langchain/langgraph-checkpoint/package.json',
    );
    for (const path of [own, graph]) {
      const manifest = JSON.parse(await readFile(path, 'utf8')) as { version: string };
      expect(manifest.version, path).toBe('1.1.5');
    }
    expect(dirname(own)).toBe(dirname(graph));
  });

  it('`{lc: 2}` 的紀錄、LangChain 物件與普通值，讀回來跟基座那一顆一模一樣', async () => {
    const value = {
      set: new Set([1, 'a']),
      map: new Map([['k', { v: 1 }]]),
      regexp: /a+b/gi,
      error: new Error('壞了'),
      bytes: new Uint8Array([1, 2, 255]),
      missing: undefined,
      list: [undefined, null, 1],
      message: new AIMessage({
        content: '嗨',
        tool_calls: [{ id: 'c1', name: 'probe', args: { v: mixed(10) } }],
      }),
    };
    const ours = new DepthCheckedSerializer(new MemorySaver().serde);
    const base = new MemorySaver().serde;
    const [type, bytes] = await ours.dumpsTyped(value);
    const [baseType, baseBytes] = await base.dumpsTyped(value);
    expect(type).toBe(baseType);
    expect(Buffer.from(bytes).equals(Buffer.from(baseBytes))).toBe(true);
    expect(await ours.loadsTyped(type, bytes)).toEqual(await base.loadsTyped(type, bytes));
  });

  it('層數照交給 JSON.stringify 之後的樣子算：先 toJSON、`undefined` 換成紀錄多 1 層', () => {
    expect(checkpointDepth('純量')).toBe(0);
    expect(checkpointDepth({ a: [1] })).toBe(2);
    expect(checkpointDepth({ a: undefined })).toBe(2);
    expect(checkpointDepth({ toJSON: () => ({ a: { b: 1 } }) })).toBe(2);
    expect(checkpointDepth(mixed(5_000))).toBe(5_000);
    const loop: Record<string, unknown> = {};
    loop['self'] = loop;
    expect(checkpointDepth(loop)).toBe(1);
  });

  it('超過上限在交給基座之前就拋，5000 層也不是 Maximum call stack size exceeded', async () => {
    const ours = new DepthCheckedSerializer(new MemorySaver().serde);
    await expect(ours.dumpsTyped({ v: mixed(5_000) })).rejects.toMatchObject({
      code: CHECKPOINT_DEPTH_EXCEEDED,
      depth: 5_001,
      limit: CHECKPOINT_MAX_DEPTH,
    });
    // 剛好在上限上的寫得進去，也讀得回來。
    const atCap = { v: mixed(CHECKPOINT_MAX_DEPTH - 1) };
    const [type, bytes] = await ours.dumpsTyped(atCap);
    expect(await ours.loadsTyped(type, bytes)).toEqual(atCap);
  });

  it('基座吞錯換成那一句的（例如 BigInt），大聲拋 checkpoint_unserializable', async () => {
    const base = new MemorySaver().serde;
    const [, swallowed] = await base.dumpsTyped({ n: 1n });
    // 前提：基座真的吞了，不是拋。
    expect(new TextDecoder().decode(swallowed)).toContain('unable to serialize');
    await expect(
      new DepthCheckedSerializer(new MemorySaver().serde).dumpsTyped({ n: 1n }),
    ).rejects.toMatchObject({
      code: CHECKPOINT_UNSERIALIZABLE,
    });
  });

  it('寫不進去的那一次不留空的鏈：之後 getTuple 回 undefined，不是 undefined is not iterable', async () => {
    const saver = new PrunedMemorySaver();
    const config = { configurable: { thread_id: 't', checkpoint_ns: '' } };
    const checkpoint = {
      v: 4,
      id: '1',
      ts: '',
      channel_values: { messages: [mixed(5_000)] },
      channel_versions: {},
      versions_seen: {},
    };
    await expect(saver.put(config, checkpoint, {} as never)).rejects.toMatchObject({
      code: CHECKPOINT_DEPTH_EXCEEDED,
    });
    expect(await saver.getTuple({ configurable: { thread_id: 't' } })).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* 真的 serve                                                                   */
/* -------------------------------------------------------------------------- */

/** 每一格自己的收尾；續接那一組共用一台，見那一組的 `afterAll`。 */
const perTest: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of perTest.splice(0).reverse()) await cleanup();
});

/** 每一次寫入（存檔點、metadata、每一筆 write）量到的層數。 */
const dumpedDepths: number[] = [];
beforeEach(() => {
  dumpedDepths.length = 0;
  const original = DepthCheckedSerializer.prototype.dumpsTyped;
  vi.spyOn(DepthCheckedSerializer.prototype, 'dumpsTyped').mockImplementation(function (
    this: DepthCheckedSerializer,
    data: unknown,
  ) {
    dumpedDepths.push(checkpointDepth(data));
    return original.call(this, data);
  });
  return () => vi.restoreAllMocks();
});

/** 一則請求訊息的文字：字串，或文字塊接起來。 */
function textOf(message: WireMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return JSON.stringify(message.content);
  return (message.content as { type?: unknown; text?: unknown }[])
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('');
}

/** 主呼叫照這一串最後一則決定：工具結果之後收尾；使用者說「深:<名字>」就叫一個參數是 `deep[名字]` 的工具。 */
function scriptFor(deep: Record<string, unknown>) {
  return (_index: number, body: Body): Reply => {
    if (!hasTools(body)) return { content: '【輔助呼叫】' };
    const last = body.messages.at(-1)!;
    if (last.role === 'tool') return { content: '收尾' };
    const name = /^深:(\S+)/.exec(textOf(last))?.[1];
    return name === undefined
      ? { content: '好' }
      : { tools: [{ id: `call-${name}`, name: 'no_such_tool', args: deep[name] }] };
  };
}

interface Rig {
  readonly upstream: FakeEndpoint;
  readonly logs: string;
  start(): Promise<RunningServe>;
  logFile(thread: string): string;
}

async function rig(
  deep: Record<string, unknown>,
  cleanups: (() => Promise<void>)[] = perTest,
): Promise<Rig> {
  const upstream = await fakeEndpoint(scriptFor(deep), true);
  cleanups.push(() => upstream.close());
  const home = await mkdtemp(join(tmpdir(), 'nexus-checkpoint-home-'));
  const logs = await mkdtemp(join(tmpdir(), 'nexus-checkpoint-logs-'));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  cleanups.push(() => rm(logs, { recursive: true, force: true }));
  const patch = join(home, 'patch.yml');
  writeFileSync(patch, liveModelPatch(upstream.baseURL, ''), { mode: 0o600 });
  return {
    upstream,
    logs,
    async start() {
      const running = (await runServe({
        argv: ['--port', '0', '--live', '--session-log', logs, '--patch', patch],
        log: () => undefined,
        env: { [HARNESS_HOME_ENV]: home },
      })) as RunningServe;
      cleanups.push(() => running.close());
      return running;
    },
    logFile: (thread) => join(logs, projectKey(process.cwd()), `${thread}.jsonl`),
  };
}

/** 說一句話，等 root 收尾（完成或失敗都算）。 */
async function say(server: RunningServe, thread: string, prompt: string): Promise<void> {
  const client = await serveClient(server);
  const events = await client.openEvents(thread);
  await client.runStart(thread, prompt);
  await foldTurn(events);
  await events.return?.(undefined);
}

/** 送給模型的主呼叫裡，最後一則使用者說 `prompt` 的那一個。 */
function requestFor(upstream: FakeEndpoint, prompt: string): WireMessage[] {
  const body = upstream.bodies.findLast(
    (candidate) => hasTools(candidate) && textOf(candidate.messages.at(-1)!) === prompt,
  );
  if (body === undefined) throw new Error(`模型沒收到「${prompt}」那一次`);
  return body.messages;
}

/** 那一次請求裡，那個工具呼叫帶的參數。 */
function argsIn(messages: readonly WireMessage[], callId: string): unknown {
  for (const message of messages) {
    const calls = message['tool_calls'] as
      { id: string; function: { arguments: string } }[] | undefined;
    const call = calls?.find((candidate) => candidate.id === callId);
    if (call !== undefined) return JSON.parse(call.function.arguments) as unknown;
  }
  return undefined;
}

/**
 * 日誌裡那則訊息帶這個呼叫參數的每一處都換掉：`tool_calls`、`content` 與 `content_blocks` 裡的工具呼叫塊（`args`），
 * 以及 `additional_kwargs.tool_calls` 的原始字串（有的話）。回換了幾處。
 */
function swapArgs(message: unknown, callId: string, args: unknown): number {
  let swapped = 0;
  const stack: unknown[] = [message];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== 'object') continue;
    const record = current as Record<string, unknown>;
    if (record['id'] === callId && 'args' in record) {
      record['args'] = args;
      swapped++;
      continue;
    }
    const fn = record['function'] as { arguments?: unknown } | undefined;
    if (record['id'] === callId && typeof fn?.arguments === 'string') {
      fn.arguments = JSON.stringify(args);
      swapped++;
      continue;
    }
    stack.push(...Object.values(record));
  }
  return swapped;
}

async function logLines(file: string): Promise<string[]> {
  return (await readFile(file, 'utf8')).split('\n').filter((line) => line.length > 0);
}

describe('同台：模型帶進 state 的深參數（#1658）', () => {
  it.each([
    ['參數 44 層', 'p44', { v: mixed(44) }],
    ['參數 46 層', 'p46', { v: mixed(46) }],
    ['事件剛好 600 層', 'e600', { v: mixed(AT_LOG_CAP) }],
  ])(
    '%s：這一輪寫得進存檔點，下一輪模型收到的參數一模一樣',
    async (_label, name, args) => {
      const { upstream, start, logFile } = await rig({ [name]: args });
      const server = await start();
      await say(server, 'same', `深:${name}`);
      await say(server, 'same', '然後');
      expect(argsIn(requestFor(upstream, '然後'), `call-${name}`)).toEqual(args);
      const lines = await logLines(logFile('same'));
      expect(lines.some((line) => line.includes('"turn/failed"'))).toBe(false);
      if (name === 'e600') {
        // 前提：日誌那一關收下的那一行剛好在上限上。
        const logged = lines.find(
          (line) => line.includes('"assistant/message"') && line.includes('call-e600'),
        );
        expect(jsonDepth((JSON.parse(logged!) as { data: unknown }).data)).toBe(
          SESSION_EVENT_MAX_DEPTH,
        );
        // 實測：存檔點那一次寫入剛好比日誌多 CHECKPOINT_WRAPPER_DEPTH 層，就在上限上。
        expect(Math.max(...dumpedDepths)).toBe(SESSION_EVENT_MAX_DEPTH + CHECKPOINT_WRAPPER_DEPTH);
      }
    },
    60_000,
  );

  // 剛好超過上限一層，跟上面「剛好 600」那一格湊成一對邊界。日誌那一關拒收這一則（601 層），state 照樣收下。
  // 更深的（約 2000 層起）輪不到存檔點：LangGraph 在圖裡走節點回傳值的 `_deserializeCommandSendObjectGraph`
  // （`@langchain/langgraph` 的 `dist/constants.js`，遞迴）先爆 `Maximum call stack size exceeded`，碼是 UNKNOWN，
  // 見 [#1668](https://github.com/DemianLi/nexus-agent/issues/1668)。
  // 這一格的期望值依賴日誌那一關被拒時錯被吞掉；#1665 改成大聲失敗之後要重定。
  it('事件 601 層（存檔點剛好超過上限一層）：那一輪拋 checkpoint_depth_exceeded，下一輪照常跑，模型收到的是被拒之前的歷史', async () => {
    const { upstream, start, logFile } = await rig({ deep: { v: mixed(AT_LOG_CAP + 1) } });
    const server = await start();
    await say(server, 'same-deep', '第一句');
    await say(server, 'same-deep', '深:deep');
    // 下行的 failed 先發，日誌的 `turn/failed` 隨後才寫（`thread-pump.ts`），等它落盤。
    const failed = await vi.waitFor(async () => {
      const line = (await logLines(logFile('same-deep'))).find((candidate) =>
        candidate.includes('"turn/failed"'),
      );
      if (line === undefined) throw new Error('還沒寫 turn/failed');
      return line;
    });
    expect(failed).toContain(CHECKPOINT_DEPTH_EXCEEDED);
    expect(failed).toContain(
      `有 ${CHECKPOINT_MAX_DEPTH + 1} 層，超過上限 ${CHECKPOINT_MAX_DEPTH} 層`,
    );

    await say(server, 'same-deep', '再一句');
    expect(
      requestFor(upstream, '再一句').map(
        (m) => `${m.role}:${m.role === 'system' ? '' : textOf(m)}`,
      ),
    ).toEqual(['system:', 'user:第一句', 'assistant:好', 'user:再一句']);
  }, 60_000);
});

describe('續接：日誌裡的舊事件比上限深（#1658）', () => {
  const shallow = { v: mixed(10) };
  const deep: Record<string, unknown> = {
    p44: { v: mixed(44) },
    p46: { v: mixed(46) },
    e600: { v: mixed(AT_LOG_CAP) },
    p3000: { v: mixed(3_000) },
    p5000: { v: mixed(5_000) },
  };
  const shared: (() => Promise<void>)[] = [];
  let resumed: {
    readonly rig: Rig;
    readonly server: RunningServe;
    readonly seqOf: Record<string, number>;
  };

  // 每條 thread 第一台各真跑一輪（參數淺），收掉；把那一行換成深的；開第二台。下面每一格各開一條 thread。
  beforeAll(async () => {
    const sharedRig = await rig(
      Object.fromEntries(Object.keys(deep).map((name) => [name, shallow])),
      shared,
    );
    const first = await sharedRig.start();
    for (const name of Object.keys(deep)) await say(first, `resume-${name}`, `深:${name}`);
    await first.close();

    const seqOf: Record<string, number> = {};
    for (const [name, args] of Object.entries(deep)) {
      const file = sharedRig.logFile(`resume-${name}`);
      const lines = await logLines(file);
      const at = lines.findIndex(
        (line) => line.includes('"assistant/message"') && line.includes(`call-${name}`),
      );
      if (at < 0) throw new Error(`${name}：日誌裡沒有那一則`);
      const event = JSON.parse(lines[at]!) as { seq: number; data: { message: { data: unknown } } };
      if (swapArgs(event.data.message.data, `call-${name}`, args) === 0) {
        throw new Error(`${name}：那一則裡沒有參數可換`);
      }
      // 前提：剛好 600 那一行換完之後就在日誌的上限上。
      if (name === 'e600' && jsonDepth(event.data) !== SESSION_EVENT_MAX_DEPTH) {
        throw new Error(`e600：換完是 ${jsonDepth(event.data)} 層`);
      }
      lines[at] = JSON.stringify(event);
      await writeFile(file, `${lines.join('\n')}\n`);
      seqOf[name] = event.seq;
    }
    resumed = { rig: sharedRig, server: await sharedRig.start(), seqOf };
  }, 120_000);
  afterAll(async () => {
    for (const cleanup of shared.splice(0).reverse()) await cleanup();
  });

  it.each([
    ['參數 44 層', 'p44'],
    ['參數 46 層', 'p46'],
    ['事件剛好 600 層', 'e600'],
  ])(
    '%s：灌回 state 寫得進、讀得回，下一輪模型收到的參數一模一樣',
    async (_label, name) => {
      await say(resumed.server, `resume-${name}`, `然後-${name}`);
      expect(argsIn(requestFor(resumed.rig.upstream, `然後-${name}`), `call-${name}`)).toEqual(
        deep[name],
      );
      if (name === 'e600')
        expect(Math.max(...dumpedDepths)).toBe(SESSION_EVENT_MAX_DEPTH + CHECKPOINT_WRAPPER_DEPTH);
    },
    60_000,
  );

  it.each([
    ['參數 3000 層（原本的無聲區）', 'p3000'],
    ['參數 5000 層（原本 decirc 先爆）', 'p5000'],
  ])(
    '%s：thread 建不起來，checkpoint_depth_exceeded，帶 seq 與層數',
    async (_label, name) => {
      const client = await serveClient(resumed.server);
      const rejected = await client.openEvents(`resume-${name}`).then(
        () => '（沒有被拒）',
        (error: unknown) => String(error),
      );
      expect(rejected).toContain(CHECKPOINT_DEPTH_EXCEEDED);
      expect(rejected).toContain(`日誌第 ${resumed.seqOf[name]} 顆事件`);
      expect(rejected).toContain(`上限 ${CHECKPOINT_MAX_DEPTH} 層`);
      expect(rejected).not.toContain('Maximum call stack size exceeded');
    },
    60_000,
  );
});
