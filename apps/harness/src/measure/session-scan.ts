/**
 * 每次模型呼叫裡，讀方對整份會話日誌的全掃佔多少時間（[#1567](https://github.com/DemianLi/nexus-agent/issues/1567) N0778）。
 *
 * 卡上列了 6 處逐次呼叫就複製並掃一次整份日誌的讀方（圖片額度、剪刀、參數截斷、核准政策、換模型通知、每輪收尾）。
 * 出口門檻（Q2 (b)）：它們加起來佔每次呼叫非網路時間的 10% 以上才改成增量折疊。這一檔不改產品碼，用三種量法：
 *
 * - **分母**：走出貨的 `runServe --live`，模型是立即回應的假端點（`log-derived-history.fixture.ts`），量一輪從
 *   `run.start` 到 root 收尾的牆鐘時間，除以這一輪打到端點的請求數。端點在同一個行程裡，SSE 各幀同步寫完、不等待。
 *   這段時間除了 harness（中介層、圖、工具、落盤、下行）之外，還含端點解析請求 body 與客戶端解碼下行，兩者都隨日誌
 *   變長；所以另外量端點解析一次最後那份 body 的時間，讓呼叫端扣掉。下行只排空、不折疊。
 * - **複製次數**：替換 `SessionLog.prototype` 上 `events` 的 getter，計次並計時（只改這個行程裡的物件）。
 * - **歸因**：同一個規模再跑一個窗口，開 `node:inspector` 的取樣剖析，數堆疊上有那幾支函式的樣本佔非閒置樣本多少。
 *   V8 會把小函式 inline 進呼叫者，所以另做微基準互相核對：對同一份日誌各呼叫 `imageOffloadData` 以外的那幾支（它要一顆 `image/offload`，夾具不帶圖片），取單次的中位數。
 *
 * @module
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  offloadedImagesOf,
  pendingNotice,
  recordedApprovalPolicy,
  recordedRoute,
  SessionLog,
  turnReachedMaxTokens,
} from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import { recordedArgTruncationsOf } from '@nexus/core/src/tool-arg-truncation-log.js';
import { recordedPrunesOf } from '@nexus/core/src/tool-result-prune-log.js';
import type { Event as WireEvent } from '@nexus/wire';

import { serveClient } from '../fixtures.js';
import { HARNESS_HOME_ENV } from '../harness-home.js';
import { fakeEndpoint, hasTools, liveModelPatch } from '../log-derived-history.fixture.js';
import type { Reply } from '../log-derived-history.fixture.js';
import { runServe } from '../serve.js';
import type { RunningServe } from '../serve.js';

/** 堆疊上出現就算進「全掃」的函式名。`get events` 是那顆複製。 */
export const SCAN_FUNCTIONS = [
  'get events',
  'offloadedImagesOf',
  'recordedPrunesOf',
  'recordedArgTruncationsOf',
  'recordedApprovalPolicy',
  'recordedRoute',
  'pendingNotice',
  'turnReachedMaxTokens',
  'imageOffloadData',
] as const;

export interface ScanOptions {
  /** 在日誌長到這幾個筆數時各量一次，由小到大。 */
  readonly checkpoints: readonly number[];
  /** 每個量測點跑幾輪（不剖析與剖析各這麼多）。 */
  readonly window: number;
  /** 疊在 `live-model` 之後的 patch 列，例如關掉剪刀那一列。 */
  readonly patchExtra?: string;
  /** 取樣間隔，微秒。 */
  readonly samplingMicros?: number;
}

export interface WindowStats {
  /** 量測開始時 root 日誌的筆數。 */
  readonly events: number;
  /** 計時窗口（不含剖析窗口）跑了幾輪、打了幾次端點。 */
  readonly turns: number;
  readonly requests: number;
  /** 每次請求的 harness 時間（毫秒）：一輪的牆鐘時間除以那一輪的請求數，取各輪的中位數與 p95。 */
  readonly perRequestMs: { readonly median: number; readonly p95: number };
  /** 每次請求複製 `events` 幾次、花幾毫秒。 */
  readonly copiesPerRequest: number;
  readonly copyMsPerRequest: number;
  /** 剖析窗口裡，堆疊上有 {@link SCAN_FUNCTIONS} 任一支的樣本佔非閒置樣本的比例。 */
  readonly profiledShare: number;
  /** 同上，逐支。 */
  readonly profiledShareBy: Readonly<Record<string, number>>;
  /** 剖析窗口跑完後的 root 日誌上，單次呼叫的中位數，微秒。 */
  readonly microMicros: Readonly<Record<string, number>>;
  /** 端點對最後那份請求 body 做一次 `JSON.parse` 的中位數，微秒。分母裡含這一份，不是 harness 的。 */
  readonly endpointParseMicros: number;
}

interface CopyCounter {
  count: number;
  ms: number;
}

/** 換掉 `events` 的 getter，回傳計數器、呼叫過 getter 的日誌、拿原 getter 的函式與還原函式。 */
function instrumentEvents(): {
  readonly counter: CopyCounter;
  readonly logs: Set<SessionLog>;
  readonly original: (log: SessionLog) => readonly SessionEvent[];
  restore(): void;
} {
  const descriptor = Object.getOwnPropertyDescriptor(SessionLog.prototype, 'events');
  const get = descriptor?.get;
  if (descriptor === undefined || get === undefined)
    throw new Error('SessionLog 沒有 events getter');
  const counter: CopyCounter = { count: 0, ms: 0 };
  const logs = new Set<SessionLog>();
  Object.defineProperty(SessionLog.prototype, 'events', {
    ...descriptor,
    get(this: SessionLog) {
      logs.add(this);
      const start = performance.now();
      const events = get.call(this) as readonly SessionEvent[];
      counter.ms += performance.now() - start;
      counter.count += 1;
      return events;
    },
  });
  return {
    counter,
    logs,
    original: (log) => get.call(log) as readonly SessionEvent[],
    restore: () => Object.defineProperty(SessionLog.prototype, 'events', descriptor),
  };
}

/**
 * 每一輪的腳本：第一次主呼叫回工具呼叫，第二次收尾。每 10 輪一顆 10,000 字的工具結果（剪刀的對象），每 7 輪一顆長參數的
 * 寫檔（參數截斷的對象），其餘是短的 echo，讓日誌裡有剪法與截斷的紀錄可掃。
 */
function replyFor(turn: number, step: number): Reply {
  if (step > 0) return { content: `第 ${turn} 輪好了。` };
  const tools: NonNullable<Reply['tools']> = [
    {
      id: `call_e${turn}`,
      name: 'echo',
      args: { message: turn % 10 === 0 ? '中'.repeat(10_000) : `短句 ${turn}` },
    },
  ];
  if (turn % 7 === 0) {
    tools.push({
      id: `call_w${turn}`,
      name: 'write_file',
      args: { file_path: `/scan${turn}.txt`, content: 'abc'.repeat(2_000) },
    });
  }
  return { tools };
}

const isRootDone = (event: WireEvent): boolean => {
  if (event.method !== 'lifecycle' || event.params.namespace.length > 0) return false;
  const data = event.params.data as { event?: unknown; graph_name?: unknown } | null;
  return data?.graph_name === 'root' && (data.event === 'completed' || data.event === 'failed');
};

const quantile = (values: readonly number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
};

/** 重複呼叫一支函式：至少 20 次，之後到 200 毫秒或 400 次為止，回單次的中位數（微秒）。 */
function micro(run: () => unknown): number {
  const samples: number[] = [];
  const deadline = performance.now() + 200;
  while (samples.length < 400 && (samples.length < 20 || performance.now() < deadline)) {
    const start = performance.now();
    run();
    samples.push((performance.now() - start) * 1000);
  }
  return quantile(samples, 0.5);
}

interface ProfileNode {
  readonly id: number;
  readonly callFrame: { readonly functionName: string };
  readonly children?: readonly number[];
}

/** 取樣剖析的結果 → 堆疊上有某支函式的樣本比例（分母不含 `(idle)`）。 */
function attribute(profile: {
  readonly nodes: readonly ProfileNode[];
  readonly samples?: readonly number[];
}): { readonly share: number; readonly by: Record<string, number> } {
  const parent = new Map<number, number>();
  const byId = new Map<number, ProfileNode>();
  for (const node of profile.nodes) {
    byId.set(node.id, node);
    for (const child of node.children ?? []) parent.set(child, node.id);
  }
  const targets = new Set<string>(SCAN_FUNCTIONS);
  const hits: Record<string, number> = Object.fromEntries(SCAN_FUNCTIONS.map((name) => [name, 0]));
  let busy = 0;
  let any = 0;
  for (const leaf of profile.samples ?? []) {
    if (byId.get(leaf)?.callFrame.functionName === '(idle)') continue;
    busy += 1;
    const seen = new Set<string>();
    for (let at: number | undefined = leaf; at !== undefined; at = parent.get(at)) {
      const name = byId.get(at)?.callFrame.functionName ?? '';
      if (targets.has(name)) seen.add(name);
    }
    if (seen.size > 0) any += 1;
    for (const name of seen) hits[name]! += 1;
  }
  const by = Object.fromEntries(
    Object.entries(hits).map(([name, count]) => [name, busy === 0 ? 0 : count / busy]),
  );
  return { share: busy === 0 ? 0 : any / busy, by };
}

/**
 * 跑一條會話，在每個量測點各量一個計時窗口加一個剖析窗口。
 *
 * @param options - 量測點、窗口大小與設定。
 * @returns 每個量測點一筆。
 */
export async function measureSessionScans(options: ScanOptions): Promise<WindowStats[]> {
  const instrument = instrumentEvents();
  let turn = 0;
  let step = 0;
  let requests = 0;
  const upstream = await fakeEndpoint((_index, body) => {
    requests += 1;
    if (!hasTools(body)) return { content: '【輔助呼叫】' };
    const reply = replyFor(turn, step);
    step += 1;
    return reply;
  }, true);
  const home = await mkdtemp(join(tmpdir(), 'nexus-scan-home-'));
  const logs = await mkdtemp(join(tmpdir(), 'nexus-scan-logs-'));
  const patch = join(home, 'patch.yml');
  await writeFile(patch, liveModelPatch(upstream.baseURL, options.patchExtra ?? ''), {
    mode: 0o600,
  });
  const out: WindowStats[] = [];
  let running: RunningServe | undefined;
  try {
    running = (await runServe({
      argv: ['--port', '0', '--live', '--session-log', logs, '--patch', patch],
      log: () => undefined,
      env: { [HARNESS_HOME_ENV]: home },
    })) as RunningServe;
    const client = await serveClient(running);
    const events = await client.openEvents('alpha');
    const rootLength = (): number =>
      Math.max(0, ...[...instrument.logs].map((log) => instrument.original(log).length));

    /** 說一句、等 root 收尾，回這一輪的牆鐘時間、請求數與複製。 */
    const oneTurn = async () => {
      turn += 1;
      step = 0;
      const before = { requests, count: instrument.counter.count, ms: instrument.counter.ms };
      const start = performance.now();
      await client.runStart('alpha', `第 ${turn} 句`);
      for (;;) {
        const next = await events.next();
        if (next.done === true) throw new Error('下行在 root 收尾之前斷了');
        if (isRootDone(next.value)) break;
      }
      return {
        ms: performance.now() - start,
        requests: requests - before.requests,
        copies: instrument.counter.count - before.count,
        copyMs: instrument.counter.ms - before.ms,
      };
    };

    for (const checkpoint of options.checkpoints) {
      while (rootLength() < checkpoint) await oneTurn();
      const size = rootLength();
      const timed = [];
      for (let k = 0; k < options.window; k += 1) timed.push(await oneTurn());

      const session = new Session();
      session.connect();
      await session.post('Profiler.enable');
      await session.post('Profiler.setSamplingInterval', {
        interval: options.samplingMicros ?? 100,
      });
      await session.post('Profiler.start');
      for (let k = 0; k < options.window; k += 1) await oneTurn();
      const { profile } = await session.post('Profiler.stop');
      session.disconnect();
      const attributed = attribute(profile as Parameters<typeof attribute>[0]);

      const root = [...instrument.logs].reduce((a, b) =>
        instrument.original(a).length >= instrument.original(b).length ? a : b,
      );
      const snapshot = instrument.original(root);
      const route = recordedRoute(snapshot);
      const microMicros = {
        'get events': micro(() => instrument.original(root)),
        offloadedImagesOf: micro(() => offloadedImagesOf(snapshot)),
        recordedPrunesOf: micro(() => recordedPrunesOf(snapshot)),
        recordedArgTruncationsOf: micro(() => recordedArgTruncationsOf(snapshot)),
        recordedApprovalPolicy: micro(() => recordedApprovalPolicy(snapshot)),
        recordedRoute: micro(() => recordedRoute(snapshot)),
        pendingNotice: micro(() => pendingNotice(snapshot, route?.model ?? 'none')),
        turnReachedMaxTokens: micro(() => turnReachedMaxTokens(snapshot)),
      };
      const lastBody = JSON.stringify(upstream.bodies.at(-1));
      const endpointParseMicros = micro(() => JSON.parse(lastBody));

      const totalRequests = timed.reduce((sum, t) => sum + t.requests, 0);
      const perRequest = timed.map((t) => t.ms / Math.max(1, t.requests));
      out.push({
        events: size,
        turns: timed.length,
        requests: totalRequests,
        perRequestMs: { median: quantile(perRequest, 0.5), p95: quantile(perRequest, 0.95) },
        copiesPerRequest: timed.reduce((sum, t) => sum + t.copies, 0) / totalRequests,
        copyMsPerRequest: timed.reduce((sum, t) => sum + t.copyMs, 0) / totalRequests,
        profiledShare: attributed.share,
        profiledShareBy: attributed.by,
        microMicros,
        endpointParseMicros,
      });
    }
    await events.return?.(undefined);
  } finally {
    await running?.close();
    await upstream.close();
    instrument.restore();
  }
  return out;
}
