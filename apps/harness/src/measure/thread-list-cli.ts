/**
 * 量會話列表的延遲——[#742](https://github.com/DemianLi/nexus-agent/issues/742)。
 *
 * 列表每次都把專案下每一份日誌整個讀進來（`listStoredThreads`，#665），成本正比於「份數 × 每份大小」。
 * 這支腳本造一批假日誌，量 serve 的 `GET /threads` 與直接呼叫 `listStoredThreads` 各要多久。
 * **只量、不改產品程式**；不進 vitest、不進 CI（要寫幾 GB 的檔）。
 *
 * ```bash
 * pnpm --filter @nexus/harness exec tsx src/measure/thread-list-cli.ts \
 *   --root /var/tmp/nexus-742 --counts 50,200,1000 --sizes 102400,1048576 --runs 9 \
 *   --filler /var/tmp/nexus-742-filler --filler-gb 40
 * ```
 *
 * 造資料的規矩（量得準的前提，每一條都有人因為沒做而量到假的東西）：
 * - **內容每份都不同**：填的是隨機位元組，不用 APFS clone——否則共用區塊的快取會讓第二份以後的讀取白送。
 * - **大部分是長行**（工具輸出那種），夾著少數 `turn/start` 與 `session/title`；每份至少一則人打的 `turn/start`。
 * - 一份至少一次經 `openJsonlSessionStore` 寫出來，其餘用同一格式直接寫；`.header.json` 與 `.jsonl` 同前綴成對。
 * - 每格量完驗 `items` 數、`unreadable`、每列 `blank === false` 且有標題，不成立那格作廢。
 * - 沖快取：這台不能 `purge`，用一個超過記憶體的墊檔讀過去把頁面快取擠掉，第一次標「沖過快取」，其餘標「熱」。
 */

import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { SESSION_LOG_FORMAT_VERSION } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import { createWireClient } from '@nexus/wire';
import { openJsonlSessionStore, projectKey } from '../jsonl-session-store.js';
import { runServe } from '../serve.js';
import { listStoredThreads } from '../session-list.js';

const LIMITS = { maxWords: 5, maxBytes: 40 };
/** 一行工具輸出的大小。#812 之後單則工具結果進日誌最多約 56 KB，這裡取 32 KB 上下的長行。 */
const LINE_BYTES = 32 * 1024;

interface Cell {
  readonly count: number;
  readonly fileBytes: number;
}

interface CellResult {
  readonly cell: Cell;
  readonly totalBytes: number;
  readonly http: readonly number[];
  readonly direct: readonly number[];
  readonly valid: boolean;
  readonly problems: readonly string[];
}

function ms(value: number): string {
  return value.toFixed(0);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** 一份日誌的內容：`turn/start` 與 `session/title` 夾在長行之間，總大小約 `fileBytes`。 */
function buildBody(index: number, fileBytes: number, cwd: string): { body: string; id: string } {
  void cwd;
  const lines: string[] = [];
  const base = 1_700_000_000_000 + index * 60_000;
  let seq = 0;
  const push = (type: string, data: unknown, time: number): void => {
    lines.push(JSON.stringify({ type, seq, time, data }));
    seq += 1;
  };
  push(
    'turn/start',
    { kind: 'message', text: `第 ${index} 份的第一句話 ${randomBytes(4).toString('hex')}` },
    base,
  );
  push('session/title', { title: `會話 ${index}` }, base + 1);
  let bytes = lines.join('\n').length;
  let t = base + 2;
  let round = 0;
  while (bytes < fileBytes) {
    const room = fileBytes - bytes;
    const size = Math.min(LINE_BYTES, Math.max(64, room - 200));
    // base64 每 3 位元組變 4 字元，先取 3/4 再轉；每行都是新的隨機位元組。
    const payload = randomBytes(Math.ceil((size * 3) / 4))
      .toString('base64')
      .slice(0, size);
    round += 1;
    // 每十行工具輸出夾一則人打的話與一顆 turn/end，其餘是 tool 事件。
    if (round % 10 === 0) {
      push('turn/end', {}, t);
      t += 1;
      push('turn/start', { kind: 'message', text: `第 ${round} 輪的問題` }, t);
    } else {
      push('message', { role: 'tool', content: payload }, t);
    }
    t += 1;
    bytes += size + 80;
  }
  return { body: `${lines.join('\n')}\n`, id: `m742-${String(index).padStart(5, '0')}` };
}

/** 造一格的資料。第 0 份走 `openJsonlSessionStore`，其餘直接寫同格式。 */
async function generate(dir: string, cell: Cell, cwd: string): Promise<number> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const store = openJsonlSessionStore({ directory: dir });
  let total = 0;
  for (let index = 0; index < cell.count; index += 1) {
    const { body, id } = buildBody(index, cell.fileBytes, cwd);
    if (index === 0) {
      const session = store.create({
        version: SESSION_LOG_FORMAT_VERSION,
        id,
        createdAt: 1_700_000_000_000,
        cwd,
      });
      const events = body
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as SessionEvent);
      await session.append(events);
      await session.close();
    } else {
      const header = {
        version: SESSION_LOG_FORMAT_VERSION,
        id,
        createdAt: 1_700_000_000_000 + index * 60_000,
        cwd,
      };
      await writeFile(join(dir, `${id}.header.json`), JSON.stringify(header));
      await writeFile(join(dir, `${id}.jsonl`), body);
    }
    total += body.length;
  }
  return total;
}

/** 讀一遍墊檔，把頁面快取擠掉。 */
async function flush(filler: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filler, { highWaterMark: 16 * 1024 * 1024 });
    stream.on('data', () => undefined);
    stream.on('end', resolve);
    stream.on('error', reject);
  });
}

async function makeFiller(path: string, gb: number): Promise<void> {
  try {
    if ((await stat(path)).size >= gb * 1024 ** 3) return;
  } catch {
    // 不存在就造。
  }
  const chunk = randomBytes(64 * 1024 * 1024);
  const { createWriteStream } = await import('node:fs');
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(path);
    let written = 0;
    const target = gb * 1024 ** 3;
    const pump = (): void => {
      while (written < target) {
        written += chunk.length;
        if (!out.write(chunk)) {
          out.once('drain', pump);
          return;
        }
      }
      out.end(resolve);
    };
    out.on('error', reject);
    pump();
  });
}

async function exchangeToken(authenticatedUrl: string): Promise<string> {
  const response = await fetch(authenticatedUrl, { redirect: 'manual' });
  const setCookie = response.headers.get('set-cookie');
  if (response.status !== 303 || setCookie === null) {
    throw new Error(`token 交換失敗：${response.status}`);
  }
  return setCookie.split(';', 1)[0]!;
}

async function measureCell(
  root: string,
  cwd: string,
  cell: Cell,
  runs: number,
  filler: string | undefined,
): Promise<CellResult> {
  const dir = join(root, projectKey(cwd));
  const totalBytes = await generate(dir, cell, cwd);
  const problems: string[] = [];

  const running = await runServe({
    argv: ['--port', '0', '--session-log', root],
    cwd,
    log: () => undefined,
    env: {},
  });
  if (running === undefined) throw new Error('serve 沒起來');
  try {
    const cookie = await exchangeToken(running.authenticatedUrl);
    const client = createWireClient({
      baseUrl: running.url,
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set('cookie', cookie);
        return fetch(input, { ...init, headers });
      },
    });

    const http: number[] = [];
    if (filler !== undefined) await flush(filler);
    for (let run = 0; run < runs; run += 1) {
      const start = performance.now();
      const outcome = await client.listThreads();
      http.push(performance.now() - start);
      if (outcome.kind !== 'ok') {
        problems.push(`第 ${run} 次 rejected：${outcome.message}`);
        continue;
      }
      const { items, unreadable } = outcome.result;
      if (items.length !== cell.count) problems.push(`items ${items.length} ≠ ${cell.count}`);
      if (unreadable !== 0) problems.push(`unreadable ${unreadable}`);
      if (items.some((item) => item.blank || item.title === undefined)) {
        problems.push('有 blank 或沒標題的列');
      }
    }

    const direct: number[] = [];
    const store = openJsonlSessionStore({ directory: dir });
    if (filler !== undefined) await flush(filler);
    for (let run = 0; run < runs; run += 1) {
      const start = performance.now();
      const listed = await listStoredThreads(store, { cwd, title: LIMITS });
      direct.push(performance.now() - start);
      if (listed.items.length !== cell.count) problems.push(`direct items ${listed.items.length}`);
    }
    return {
      cell,
      totalBytes,
      http,
      direct,
      valid: problems.length === 0,
      problems: [...new Set(problems)],
    };
  } finally {
    await running.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function report(result: CellResult): string {
  const { cell, http, direct } = result;
  const fmt = (series: readonly number[]): string =>
    `冷 ${ms(series[0]!)}｜熱 中位 ${ms(median(series.slice(1)))} 最小 ${ms(Math.min(...series.slice(1)))} 最慢 ${ms(Math.max(...series.slice(1)))}｜全 ${series.length} 次中位 ${ms(median(series))} 最慢 ${ms(Math.max(...series))}`;
  return [
    `${cell.count} 份 × ${(cell.fileBytes / 1024).toFixed(0)} KB（實寫 ${(result.totalBytes / 1024 ** 2).toFixed(0)} MB）${result.valid ? '' : ' ⚠ 作廢：' + result.problems.join('；')}`,
    `  GET /threads      ${fmt(http)}`,
    `  listStoredThreads ${fmt(direct)}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      root: { type: 'string' },
      counts: { type: 'string', default: '50,200,1000,3000' },
      sizes: { type: 'string', default: '102400,1048576,10485760' },
      runs: { type: 'string', default: '9' },
      filler: { type: 'string' },
      'filler-gb': { type: 'string', default: '40' },
      skip: { type: 'string', default: '' },
    },
  });
  if (values.root === undefined) throw new Error('--root 必填（放在 /var/tmp 之類，不要 tmpdir）');
  const counts = values.counts!.split(',').map(Number);
  const sizes = values.sizes!.split(',').map(Number);
  const skip = new Set(values.skip!.split(',').filter(Boolean));
  const runs = Number(values.runs);
  const cwd = join(values.root, 'cwd');
  await mkdir(cwd, { recursive: true });
  if (values.filler !== undefined) await makeFiller(values.filler, Number(values['filler-gb']));

  console.log(
    `機器：${platform()} ${release()} ${arch()}｜${cpus()[0]?.model}｜${(totalmem() / 1024 ** 3).toFixed(0)} GB｜Node ${process.version}｜N=${runs}`,
  );
  for (const fileBytes of sizes) {
    for (const count of counts) {
      const key = `${count}x${fileBytes}`;
      if (skip.has(key)) {
        console.log(`${count} 份 × ${fileBytes / 1024} KB：沒跑（--skip）`);
        continue;
      }
      const result = await measureCell(
        join(values.root, 'sessions'),
        cwd,
        { count, fileBytes },
        runs,
        values.filler,
      );
      console.log(report(result));
    }
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
