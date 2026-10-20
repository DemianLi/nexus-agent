/**
 * `checkpoint-depth-cold.test.ts` 起的子行程（[#1761](https://github.com/DemianLi/nexus-agent/issues/1761)）：**每一格各自一個新行程**。
 *
 * 為什麼要子行程：續接深歷史爆堆疊的邊界看冷熱（見 `checkpoint-serde.ts` 的 `checkpointDepth`）。vitest 的行程跑過很多格之後函式都暖了，
 * 同一個預設 stack 撐得更深，3000、5000 層在那裡是綠的；真正的 serve 重啟之後第一個續接是冷的。所以這支腳本**一個新行程只做一件事**，
 * 而且深的那一件就是這個行程的第一個工作。測試用 `node --import tsx` 起它，**不帶 `--stack-size`**。
 *
 * 三種模式，結果印一行 JSON 到標準輸出：
 *
 * - `generate <dir> <層數…>`：真跑 serve，每個層數一條 thread，各說一句話（工具參數是淺的）；收掉之後把日誌裡那則訊息的參數換成
 *   指定層數（原樣 JSON 文字，不用遞迴的 `JSON.stringify`）。這是造「上限出現之前寫下的舊日誌」的做法，同 `checkpoint-serde.test.ts`。
 * - `resume <dir> <層數>`：開 serve，**第一件事**就是續接 `t<層數>`，印被拒的碼與訊息，或 `opened`。
 * - `write <dir> <層數>`：同台，假端點回一則參數 `<層數>` 層的工具呼叫，印這一輪 `turn/failed` 的碼與訊息、整份日誌有沒有 `RangeError`，
 *   以及下行有沒有一路收到 root 收尾（`downlink`：`closed` 或 `broken`，斷了不算這支腳本失敗——見 `write`）。
 *
 * **零憑證、零外部連線**：假端點在 loopback，key 是假的。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { WireRejectedError } from '@nexus/wire';

import { foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { projectKey } from './jsonl-session-store.js';
import { LIVE_API_KEY_ENV } from './live-model.js';
import { fakeEndpoint, hasTools, liveModelPatch } from './log-derived-history.fixture.js';
import type { Body, Reply, WireMessage } from './log-derived-history.fixture.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const ARGS_MARKER = '@@deep-args@@';
const TEXT_MARKER = '@@deep-args-text@@';

/** `{ v: <交錯巢狀 levels 層> }` 的 JSON 文字，迭代組出來。 */
function mixedJson(levels: number): string {
  let text = '"leaf"';
  for (let level = 0; level < levels; level++) {
    text = level % 2 ? `{"next":${text}}` : `[${text}]`;
  }
  return `{"v":${text}}`;
}

function textOf(message: WireMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return JSON.stringify(message.content);
  return (message.content as { type?: unknown; text?: unknown }[])
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('');
}

/** 主呼叫照最後一則決定：工具結果之後收尾；使用者說「深:<名字>」就叫一個工具，參數是 `argsJson`（有給的話）或淺的。 */
function script(argsJson?: string) {
  return (_index: number, body: Body): Reply => {
    if (!hasTools(body)) return { content: '【輔助呼叫】' };
    const last = body.messages.at(-1)!;
    if (last.role === 'tool') return { content: '收尾' };
    const name = /^深:(\S+)/.exec(textOf(last))?.[1];
    if (name === undefined) return { content: '好' };
    return {
      tools: [
        {
          id: `call-${name}`,
          name: 'no_such_tool',
          args: { v: ['leaf'] },
          ...(argsJson !== undefined && { argsJson }),
        },
      ],
    };
  };
}

/** 日誌裡那則訊息帶這個呼叫參數的每一處都先換成記號；回換了幾處。 */
function swapArgs(message: unknown, callId: string): number {
  let swapped = 0;
  const stack: unknown[] = [message];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== 'object') continue;
    const record = current as Record<string, unknown>;
    if (record['id'] === callId && 'args' in record) {
      record['args'] = ARGS_MARKER;
      swapped++;
      continue;
    }
    const fn = record['function'] as { arguments?: unknown } | undefined;
    if (record['id'] === callId && typeof fn?.arguments === 'string') {
      fn.arguments = TEXT_MARKER;
      swapped++;
      continue;
    }
    stack.push(...Object.values(record));
  }
  return swapped;
}

interface Layout {
  readonly home: string;
  readonly logs: string;
  readonly patch: string;
}

/** `dir` 底下的 home、日誌目錄與指到假端點的 patch（不呼叫模型的模式，端點位址不會被用到）。 */
function layoutAt(dir: string, baseURL: string): Layout {
  const home = join(dir, 'home');
  const logs = join(dir, 'logs');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const patch = join(home, 'patch.yml');
  writeFileSync(patch, liveModelPatch(baseURL, ''), { mode: 0o600 });
  return { home, logs, patch };
}

async function start(where: Layout): Promise<RunningServe> {
  return (await runServe({
    argv: ['--port', '0', '--live', '--session-log', where.logs, '--patch', where.patch],
    log: () => undefined,
    env: { [HARNESS_HOME_ENV]: where.home },
  })) as RunningServe;
}

const logFile = (where: Layout, thread: string) =>
  join(where.logs, projectKey(process.cwd()), `${thread}.jsonl`);

async function say(server: RunningServe, thread: string, prompt: string): Promise<void> {
  const client = await serveClient(server);
  const events = await client.openEvents(thread);
  await client.runStart(thread, prompt);
  await foldTurn(events);
  await events.return?.(undefined);
}

function emit(result: unknown): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function generate(dir: string, levels: readonly number[]): Promise<void> {
  const upstream = await fakeEndpoint(script(), true);
  const where = layoutAt(dir, upstream.baseURL);
  const server = await start(where);
  for (const level of levels) await say(server, `t${level}`, `深:${level}`);
  await server.close();
  await upstream.close();
  for (const level of levels) {
    const file = logFile(where, `t${level}`);
    const lines = (await readFile(file, 'utf8')).split('\n').filter((line) => line.length > 0);
    const at = lines.findIndex(
      (line) => line.includes('"assistant/message"') && line.includes(`call-${level}`),
    );
    if (at < 0) throw new Error(`${level}：日誌裡沒有那一則`);
    const event = JSON.parse(lines[at]!) as { data: { message: { data: unknown } } };
    if (swapArgs(event.data.message.data, `call-${level}`) === 0) {
      throw new Error(`${level}：那一則裡沒有參數可換`);
    }
    const argsJson = mixedJson(level);
    lines[at] = JSON.stringify(event)
      .replaceAll(JSON.stringify(ARGS_MARKER), () => argsJson)
      .replaceAll(JSON.stringify(TEXT_MARKER), () => JSON.stringify(argsJson));
    await writeFile(file, `${lines.join('\n')}\n`);
  }
}

async function resume(dir: string, level: number): Promise<void> {
  const where = layoutAt(dir, 'http://127.0.0.1:9/v1');
  const server = await start(where);
  const client = await serveClient(server);
  // 這個行程的第一件工作：續接那一條深的。
  const outcome = await client.openEvents(`t${level}`).then(
    () => ({ outcome: 'opened' }),
    (error: unknown) =>
      error instanceof WireRejectedError
        ? { outcome: 'rejected', code: error.code, message: String(error.message) }
        : { outcome: 'threw', message: String(error) },
  );
  emit(outcome);
  await server.close();
}

async function write(dir: string, level: number): Promise<void> {
  const upstream = await fakeEndpoint(script(mixedJson(level)), true);
  const where = layoutAt(dir, upstream.baseURL);
  const server = await start(where);
  // 下行有沒有斷要如實報，不能讓它扳倒腳本：深參數的 `messages` 事件在下行 `JSON.stringify` 時會不會爆堆疊看平台
  //（Linux 上 5000 層會，serve 記 `[下行] … 無法序列化，已斷開`，歸 #1560；macOS 上不會）。這一格要量的是日誌那一關。
  let downlink: 'closed' | 'broken' = 'closed';
  try {
    await say(server, 'w', '深:w');
  } catch {
    downlink = 'broken';
  }
  await server.close();
  await upstream.close();
  const logText = await readFile(logFile(where, 'w'), 'utf8');
  const events = logText
    .split('\n')
    .filter((line) => line.length > 0)
    .map(
      (line) =>
        JSON.parse(line) as { type: string; data: { message?: string; error?: { code?: string } } },
    );
  const failed = events.filter((event) => event.type === 'turn/failed');
  emit({
    downlink,
    // 整份日誌（不只 turn/failed）有沒有留下堆疊爆掉的痕跡。
    rangeError: logText.includes('RangeError') || logText.includes('Maximum call stack'),
    failed: failed.map((event) => ({ code: event.data.error?.code, message: event.data.message })),
  });
}

async function main(): Promise<void> {
  process.env[LIVE_API_KEY_ENV] = 'fake-key-for-loopback';
  const [mode, dir, ...rest] = process.argv.slice(2);
  if (dir === undefined) throw new Error('用法：<generate|resume|write> <dir> <層數…>');
  const levels = rest.map(Number);
  if (mode === 'generate') await generate(dir, levels);
  else if (mode === 'resume') await resume(dir, levels[0]!);
  else if (mode === 'write') await write(dir, levels[0]!);
  else throw new Error(`不認得的模式：${String(mode)}`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  },
);
