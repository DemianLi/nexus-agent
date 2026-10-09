/**
 * 每晚真模型冒煙回歸（[#436](https://github.com/DemianLi/nexus-agent/issues/436)）：真 `runServe --live`、真 NVIDIA 端點。
 *
 * 照 dsh `docs/testing.md:25` 的四樣——寫檔、多輪、工具呼叫、串流中途取消——加上 serve 的串流（卡上的第五樣）。
 * 驗證**從外面重讀檔案**（dsh `docs/testing.md:35`），不看 agent 自己怎麼說；哨兵檔逐位元組比對。
 *
 * 不進一般測試：檔名是 `.smoke.ts`，一般的 `vitest.config.ts` 只收 `.test.ts`；用 `pnpm --filter @nexus/harness smoke` 跑，
 * 設定在 `vitest.smoke.config.ts`。**缺金鑰直接拋，不跳過**——跳過的真模型測試在金鑰沒設好時會以全綠過關。
 *
 * ## 請求上限
 *
 * `live-model` 的 `baseUrl` 換成 {@link startCountingProxy}，在出口數；上限 {@link REQUEST_CAP}，超過的不轉出去、整組判失敗。
 *
 * ## 過程違反（量測規則 5）
 *
 * 外部檢查判成功的案例，另拿會話日誌對 {@link findViolations} 的清單。**只報數、不判失敗**：這是量測，不是閘門。
 * 結果寫進 `$GITHUB_STEP_SUMMARY`（本機跑就印在終端機）。
 *
 * @module
 */

import { appendFile, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SessionEvent } from '@nexus/core';
import type { Event } from '@nexus/wire';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serveClient } from '../fixtures.js';
import { projectKey } from '../jsonl-session-store.js';
import { DEFAULT_LIVE_BASE_URL, LIVE_API_KEY_ENV } from '../live-model.js';
import { runServe } from '../serve.js';
import type { RunningServe } from '../serve.js';
import { startCountingProxy } from './counting-proxy.js';
import type { CountingProxy } from './counting-proxy.js';
import { FILE_TOOLS, findViolations } from './violations.js';
import type { Violation } from './violations.js';

/** 整組最多轉出幾個請求（PM 2026-10-08：20 以內）。 */
const REQUEST_CAP = 20;

/** 外部檢查的結果與要拿去掃日誌的資料。 */
interface CaseRecord {
  readonly name: string;
  readonly threadId: string;
  readonly modelCallCap: number;
  readonly expectAbort: boolean;
  /** 外部檢查（重讀檔案、看收尾）判成功。 */
  passed: boolean;
  /** 日誌之外看得到的違反（哨兵檔被改）。 */
  extra: Violation[];
}

const records: CaseRecord[] = [];
const nonce = (): string => randomBytes(6).toString('hex');

let proxy: CountingProxy;
let server: RunningServe | undefined;
let workspace: string;
let logRoot: string;
let stopped = false;

const SENTINEL = 'SENTINEL-不要動我\n';

beforeAll(async () => {
  if ((process.env[LIVE_API_KEY_ENV] ?? '') === '') {
    throw new Error(`缺 ${LIVE_API_KEY_ENV}：冒煙回歸要真金鑰，缺了不跳過、直接失敗。`);
  }
  proxy = await startCountingProxy({ upstream: DEFAULT_LIVE_BASE_URL, cap: REQUEST_CAP });
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'nexus-smoke-ws-')));
  logRoot = await realpath(await mkdtemp(join(tmpdir(), 'nexus-smoke-logs-')));
  await writeFile(join(workspace, 'sentinel.txt'), SENTINEL, 'utf8');
  const patch = join(await mkdtemp(join(tmpdir(), 'nexus-smoke-patch-')), 'patch.yml');
  await writeFile(
    patch,
    ['- id: live-model', '  config:', `    baseUrl: '${proxy.baseUrl}'`, ''].join('\n'),
    'utf8',
  );
  server = (await runServe({
    argv: [
      '--port',
      '0',
      '--live',
      '--workspace',
      workspace,
      '--session-log',
      logRoot,
      '--patch',
      patch,
    ],
    log: () => undefined,
    env: process.env,
  })) as RunningServe;
});

afterAll(async () => {
  if (!stopped) await server?.close();
  await proxy?.close();
});

/** 一條下行，收到 root 那顆收尾的 `lifecycle` 為止；`onFrame` 每個 frame 先看一眼。 */
async function drain(
  events: AsyncIterator<Event>,
  onFrame?: (frame: Event) => void,
): Promise<{ frames: Event[]; aborted: boolean }> {
  const frames: Event[] = [];
  for (;;) {
    const next = await events.next();
    if (next.done === true) throw new Error('下行在 root 收尾之前就斷了');
    frames.push(next.value);
    onFrame?.(next.value);
    const data = next.value.params.data as {
      event?: unknown;
      graph_name?: unknown;
      aborted?: unknown;
    } | null;
    if (
      next.value.method === 'lifecycle' &&
      next.value.params.namespace.length === 0 &&
      data?.graph_name === 'root' &&
      (data.event === 'completed' || data.event === 'failed')
    ) {
      return { frames, aborted: data.aborted === true };
    }
  }
}

const isDelta = (frame: Event): boolean =>
  frame.method === 'messages' &&
  (frame.params.data as { event?: unknown } | null)?.event === 'content-block-delta';

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function sentinelViolations(): Promise<Violation[]> {
  const now = await readIfExists(join(workspace, 'sentinel.txt'));
  return now === SENTINEL ? [] : [{ kind: 'sentinel-changed', detail: 'sentinel.txt' }];
}

function record(entry: Omit<CaseRecord, 'passed' | 'extra'>): CaseRecord {
  const created: CaseRecord = { ...entry, passed: false, extra: [] };
  records.push(created);
  return created;
}

describe('真模型冒煙（serve --live）', () => {
  it('讀檔、寫檔：工具呼叫走通，檔案內容從外面重讀對得上，下行有逐字串流，哨兵檔沒被動', async () => {
    const token = `NEXUS-${nonce()}`;
    await writeFile(join(workspace, 'input.txt'), token, 'utf8');
    const entry = record({
      name: '讀檔、寫檔、串流',
      threadId: 'smoke-write',
      modelCallCap: 6,
      expectAbort: false,
    });
    const client = await serveClient(server!);
    const events = await client.openEvents(entry.threadId);
    await client.runStart(
      entry.threadId,
      '請用工具讀 input.txt，然後用工具把它的內容一個字都不差地寫進 output.txt。不要動其他任何檔案。做完只回答「完成」。',
    );
    const { frames, aborted } = await drain(events);
    await events.return?.(undefined);

    const written = await readIfExists(join(workspace, 'output.txt'));
    entry.extra = await sentinelViolations();
    entry.passed = !aborted && written?.trim() === token;
    expect(aborted).toBe(false);
    expect(written?.trim()).toBe(token);
    // 串流的正向證據：收尾之前下行就收到逐字片段，不是最後一次倒出來。
    expect(frames.filter(isDelta).length).toBeGreaterThanOrEqual(2);
    expect(entry.extra).toEqual([]);
  });

  it('多輪：第二輪的指令靠第一輪給的暗號，寫出的檔案從外面重讀對得上', async () => {
    const secret = `MEMO-${nonce()}`;
    const entry = record({
      name: '多輪',
      threadId: 'smoke-multiturn',
      modelCallCap: 6,
      expectAbort: false,
    });
    const client = await serveClient(server!);
    const events = await client.openEvents(entry.threadId);
    await client.runStart(
      entry.threadId,
      `請記住這組暗號：${secret}。不要用任何工具，只回答「記住了」。`,
    );
    const first = await drain(events);
    await client.runStart(
      entry.threadId,
      '請用工具把我剛才給你的暗號寫進 code.txt，檔案裡只放暗號、不要別的字。做完只回答「完成」。',
    );
    const second = await drain(events);
    await events.return?.(undefined);

    const written = await readIfExists(join(workspace, 'code.txt'));
    entry.extra = await sentinelViolations();
    entry.passed = !first.aborted && !second.aborted && written?.trim() === secret;
    expect(written?.trim()).toBe(secret);
  });

  it('串流中途取消：收到逐字片段之後取消，這一輪以中止收尾，取消之後不再有新請求', async () => {
    const entry = record({
      name: '串流中途取消',
      threadId: 'smoke-cancel',
      modelCallCap: 3,
      expectAbort: true,
    });
    const client = await serveClient(server!);
    const events = await client.openEvents(entry.threadId);
    await client.runStart(
      entry.threadId,
      '請從 1 數到 3000，每個數字獨佔一行，不要省略任何數字，不要使用任何工具。',
    );
    let cancelled = false;
    let deltasBeforeCancel = 0;
    const { aborted } = await drain(events, (frame) => {
      if (cancelled) return;
      if (isDelta(frame)) deltasBeforeCancel += 1;
      if (deltasBeforeCancel >= 1) {
        cancelled = true;
        void client.runCancel(entry.threadId);
      }
    });
    await events.return?.(undefined);
    // 收尾之後再等一下：取消之後不該有新的請求（含重試）發出去。
    const afterSettle = proxy.forwardedPosts();
    await new Promise((resolve) => setTimeout(resolve, 3000));

    entry.passed = cancelled && aborted && proxy.forwardedPosts() === afterSettle;
    expect(cancelled).toBe(true);
    expect(aborted).toBe(true);
    expect(proxy.forwardedPosts()).toBe(afterSettle);
  });

  it('請求數：整組沒超過上限；過程違反量測（只報數）', async () => {
    await server!.close();
    stopped = true;

    const rows: string[] = [];
    // 對帳：代理在出口數到的，要等於日誌上的 `model/start`＋標題請求＋重試。對不上就是量具壞了（數漏、或多出日誌不知道的請求）。
    let logged = 0;
    let passedCount = 0;
    let violatedCount = 0;
    for (const entry of records) {
      const raw = await readIfExists(
        join(logRoot, projectKey(process.cwd()), `${entry.threadId}.jsonl`),
      );
      const events =
        raw === undefined
          ? []
          : raw
              .split('\n')
              .filter((line) => line.length > 0)
              .map((line) => JSON.parse(line) as SessionEvent);
      logged += events.filter(
        (event) =>
          event.type === 'model/start' ||
          event.type === 'session/title-llm-request' ||
          event.type === 'llm/retry',
      ).length;
      const violations = [
        ...findViolations(events, {
          allowedTools: FILE_TOOLS,
          maxModelCalls: entry.modelCallCap,
          expectAbort: entry.expectAbort,
        }),
        ...entry.extra,
      ];
      if (entry.passed) {
        passedCount += 1;
        if (violations.length > 0) violatedCount += 1;
      }
      rows.push(
        `| ${entry.name} | ${entry.passed ? '成功' : '失敗'} | ${
          violations.length === 0
            ? '—'
            : violations.map((v) => `${v.kind}（${v.detail}）`).join('、')
        } |`,
      );
    }
    const summary = [
      '## 真模型冒煙回歸',
      '',
      `- 轉出的請求：${String(proxy.forwardedPosts())} / ${String(REQUEST_CAP)}${proxy.overflowed() ? '（**有請求被上限擋下**）' : ''}`,
      `- 對帳：日誌上的 model/start＋標題請求＋重試 ${String(logged)} 筆`,
      `- 外部檢查判成功 ${String(passedCount)} 件，其中過程違反 ${String(violatedCount)} 件`,
      '',
      '| 案例 | 外部檢查 | 過程違反 |',
      '| --- | --- | --- |',
      ...rows,
      '',
    ].join('\n');
    console.log(summary);
    const target = process.env['GITHUB_STEP_SUMMARY'];
    if (target !== undefined && target !== '') await appendFile(target, `${summary}\n`);

    expect(proxy.forwardedPosts()).toBe(logged);
    expect(proxy.overflowed()).toBe(false);
    expect(proxy.forwardedPosts()).toBeLessThanOrEqual(REQUEST_CAP);
  });
});
