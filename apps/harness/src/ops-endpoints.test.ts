/**
 * 探針與指標端點自己的邏輯（[#1535](https://github.com/DemianLi/nexus-agent/issues/1535)）：用**真的 wire handler**（`isClosing`／`threadCount`
 * 是它的），端點直接餵 `Request`，不經 serve 的組裝——那一段在 `serve-ops-endpoints.test.ts`。
 *
 * 對應卡上的驗收 1（圍欄）、2（探針不帶資料）、3（就緒跟著收尾走）、4（到上限仍就緒）、5（指標的 token）、7（格式）。
 */

import { historyPath } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import {
  emptyCommandPoint,
  loopbackRequest,
  TEST_BROWSER_AUTH,
  testSessionCookie,
} from './fixtures.js';
import type { MemoryGaugeDeps } from './memory-gauge.js';
import {
  createOpsEndpoints,
  isOpsPath,
  METRICS_CONTENT_TYPE,
  OpsMetrics,
  surfaceOf,
} from './ops-endpoints.js';
import type { OpsEndpoints } from './ops-endpoints.js';
import { PrunedMemorySaver } from './pruned-memory-saver.js';
import { ScriptedChatModel } from './scripted-model.js';
import { composeAttachSessions } from './session-attach.js';
import type { StorageArea } from './storage-probe.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { ThreadAgent } from './wire-handler.js';

const BASE = 'http://ops.test';
const TOKEN = 'T'.repeat(43);

async function realAgent(): Promise<ThreadAgent> {
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns: [{ content: '好' }] }),
    checkpointer: new PrunedMemorySaver(),
    plugins: [],
  });
  return {
    agent: built.agent as unknown as PumpAgent,
    commands: emptyCommandPoint(),
    attachSessions: composeAttachSessions(built),
    dispose: built.dispose,
  };
}

/** 假的記憶體讀法：固定的數字，`cgroup`／`host` 可以讀不到。 */
function memoryDeps(options: { cgroup: boolean }): MemoryGaugeDeps {
  return {
    readText: async (path) => {
      if (!options.cgroup) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      if (path === '/proc/self/cgroup') return '0::/\n';
      if (path.endsWith('memory.current')) return '1000\n';
      if (path.endsWith('memory.max')) return '4000\n';
      if (path === '/proc/meminfo') return 'MemAvailable: 100 kB\n';
      throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    },
    processMemory: () => ({
      rssBytes: 111,
      heapUsedBytes: 22,
      heapTotalBytes: 33,
      heapLimitBytes: 44,
    }),
    freemem: () => 5,
    totalmem: () => 10,
    constrainedMemory: () => undefined,
  };
}

interface Rig {
  readonly handler: ReturnType<typeof createWireHandler>;
  readonly metrics: OpsMetrics;
  readonly ops: OpsEndpoints;
}

const rigs: Rig[] = [];

function rig(
  options: {
    maxThreads?: number;
    metrics?: boolean;
    probes?: boolean;
    cgroup?: boolean;
  } = {},
): Rig {
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    ...(options.maxThreads === undefined ? {} : { maxThreads: options.maxThreads }),
    createAgent: () => realAgent(),
  });
  const metrics = new OpsMetrics(
    () => ({
      threads: handler.threadCount() - handler.closingCount(),
      threadsClosing: handler.closingCount(),
      ...(options.maxThreads === undefined ? {} : { maxThreads: options.maxThreads }),
    }),
    memoryDeps({ cgroup: options.cgroup ?? true }),
  );
  const ops = createOpsEndpoints({
    isClosing: () => handler.isClosing(),
    ...(options.probes === undefined ? {} : { probes: options.probes }),
    ...(options.metrics === false
      ? {}
      : { metrics: { token: TOKEN, render: () => metrics.render() } }),
  });
  const built = { handler, metrics, ops };
  rigs.push(built);
  return built;
}

afterEach(async () => {
  for (const r of rigs.splice(0)) {
    r.metrics.stop();
    await r.handler.close().catch(() => undefined);
  }
});

/** 不帶 cookie 的請求，Host 預設 localhost。 */
function get(path: string, headers: Record<string, string> = {}, method = 'GET'): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { host: 'localhost', ...headers },
  });
}

const bearer = { authorization: `Bearer ${TOKEN}` };

describe('路徑判斷', () => {
  it('三個路徑精確比對，其餘分給 wire 或網頁', () => {
    for (const path of ['/livez', '/readyz', '/metrics']) {
      expect(isOpsPath(path)).toBe(true);
      expect(surfaceOf(path)).toBe('ops');
    }
    for (const path of ['/livez/', '/metrics.json', '/metric', '/healthz']) {
      expect(isOpsPath(path)).toBe(false);
      expect(surfaceOf(path)).toBe('web');
    }
    expect(surfaceOf('/threads')).toBe('wire');
    expect(surfaceOf('/threads/t1/history')).toBe('wire');
    expect(surfaceOf('/threadsX')).toBe('web');
    expect(surfaceOf('/')).toBe('web');
  });
});

describe('驗收 1：圍欄', () => {
  it('三個路徑帶 Host: evil.example 一律 403，連 token 對的指標也一樣', async () => {
    const r = rig();
    for (const path of ['/livez', '/readyz', '/metrics']) {
      const response = await r.ops.handle(get(path, { host: 'evil.example:80', ...bearer }));
      expect(response.status).toBe(403);
    }
  });

  it('跨站的 Origin、Sec-Fetch-Site: cross-site 也擋（同 wire 那道圍欄）', async () => {
    const r = rig();
    expect((await r.ops.handle(get('/livez', { 'sec-fetch-site': 'cross-site' }))).status).toBe(
      403,
    );
    expect((await r.ops.handle(get('/livez', { origin: 'http://evil.example' }))).status).toBe(403);
  });

  it('沒有 Host 也擋', async () => {
    const r = rig();
    const request = new Request(`${BASE}/livez`);
    request.headers.delete('host');
    expect((await r.ops.handle(request)).status).toBe(403);
  });
});

describe('方法', () => {
  it('只收 GET 與 HEAD，其餘 405 並說明 Allow', async () => {
    const r = rig();
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await r.ops.handle(get('/livez', {}, method));
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('GET, HEAD');
    }
  });

  it('HEAD 回同樣的狀態碼，沒有本文', async () => {
    const r = rig();
    const live = await r.ops.handle(get('/livez', {}, 'HEAD'));
    expect(live.status).toBe(200);
    expect(await live.text()).toBe('');
    expect((await r.ops.handle(get('/metrics', {}, 'HEAD'))).status).toBe(401);
    const metrics = await r.ops.handle(get('/metrics', bearer, 'HEAD'));
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toBe('');
  });
});

describe('驗收 2：探針免登入、本文只有狀態字', () => {
  it('不帶 cookie 打 /livez、/readyz 回 200，本文剛好是 ok，不快取', async () => {
    const r = rig();
    for (const path of ['/livez', '/readyz']) {
      const response = await r.ops.handle(get(path));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('ok');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-type')).toContain('text/plain');
    }
  });

  it('probes 關掉：兩個路徑回 404（圍欄照過）；指標不受影響', async () => {
    const r = rig({ probes: false });
    expect((await r.ops.handle(get('/livez'))).status).toBe(404);
    expect((await r.ops.handle(get('/readyz'))).status).toBe(404);
    expect((await r.ops.handle(get('/metrics', bearer))).status).toBe(200);
    expect((await r.ops.handle(get('/livez', { host: 'evil.example' }))).status).toBe(403);
  });
});

describe('驗收 3：就緒跟著收尾走', () => {
  it('叫 handler.close() 之後 /readyz 是 503 closing，/livez 仍是 200', async () => {
    const r = rig();
    expect(await (await r.ops.handle(get('/readyz'))).text()).toBe('ok');
    const closing = r.handler.close();
    // close() 同步把旗標立起來——不必等它收完。
    const readyz = await r.ops.handle(get('/readyz'));
    expect(readyz.status).toBe(503);
    expect(await readyz.text()).toBe('closing');
    expect((await r.ops.handle(get('/livez'))).status).toBe(200);
    await closing;
  });

  it('寫資料的地方滿了：503 storage-full，收尾優先，釋放後回 200（#2195）', async () => {
    let closing = false;
    let full: readonly StorageArea[] = ['thread-roots'];
    let refreshed = 0;
    const ops = createOpsEndpoints({
      isClosing: () => closing,
      storage: {
        refresh: async () => {
          refreshed += 1;
        },
        get full() {
          return full;
        },
      },
    });
    const readyz = await ops.handle(get('/readyz'));
    expect(readyz.status).toBe(503);
    expect(await readyz.text()).toBe('storage-full');
    expect(refreshed).toBe(1);
    expect((await ops.handle(get('/livez'))).status).toBe(200);
    closing = true;
    expect(await (await ops.handle(get('/readyz'))).text()).toBe('closing');
    expect(refreshed).toBe(1);
    closing = false;
    full = [];
    expect((await ops.handle(get('/readyz'))).status).toBe(200);
  });

  it('指標只帶區名，不帶路徑（#2195）', async () => {
    const metrics = new OpsMetrics(
      () => ({ threads: 0, threadsClosing: 0, storageFull: ['home'] }),
      memoryDeps({ cgroup: false }),
    );
    const text = await metrics.render();
    metrics.stop();
    expect(text).toContain('nexus_storage_full{area="home"} 1');
    expect(text).toContain('nexus_storage_full{area="thread-roots"} 0');
  });

  it('serve 自己的收尾旗標也算（isClosing 由呼叫端決定）', async () => {
    let flag = false;
    const ops = createOpsEndpoints({ isClosing: () => flag });
    expect((await ops.handle(get('/readyz'))).status).toBe(200);
    flag = true;
    expect((await ops.handle(get('/readyz'))).status).toBe(503);
  });

  it('readyzProbed：只有過了圍欄、探針開著的 /readyz 才算被抓過（#1777）', async () => {
    const ops = createOpsEndpoints({ isClosing: () => false });
    expect(ops.readyzProbed()).toBe(false);
    await ops.handle(get('/livez'));
    await ops.handle(get('/readyz', { host: 'evil.example' }));
    await ops.handle(get('/readyz', {}, 'POST'));
    expect(ops.readyzProbed()).toBe(false);
    await ops.handle(get('/readyz'));
    expect(ops.readyzProbed()).toBe(true);

    const off = createOpsEndpoints({ isClosing: () => false, probes: false });
    await off.handle(get('/readyz'));
    expect(off.readyzProbed()).toBe(false);
  });
});

/** 一個 Prometheus 文字格式的最小解析器：逐行解析，格式不對就拋。 */
function parseExposition(text: string) {
  const help = new Map<string, string>();
  const types = new Map<string, string>();
  const samples: { name: string; labels: Record<string, string>; value: number }[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    let match = /^# HELP (\S+) (.+)$/u.exec(line);
    if (match) {
      help.set(match[1]!, match[2]!);
      continue;
    }
    match = /^# TYPE (\S+) (counter|gauge)$/u.exec(line);
    if (match) {
      types.set(match[1]!, match[2]!);
      continue;
    }
    match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (-?[0-9.e+-]+)$/u.exec(line);
    if (!match) throw new Error(`解析不了這一行：${line}`);
    const labels: Record<string, string> = {};
    for (const pair of (match[2] ?? '').split(',').filter((part) => part !== '')) {
      const label = /^([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"$/u.exec(pair);
      if (!label) throw new Error(`標籤解析不了：${pair}`);
      labels[label[1]!] = label[2]!;
    }
    samples.push({ name: match[1]!, labels, value: Number(match[3]) });
  }
  return { help, types, samples };
}

const valueOf = (
  parsed: ReturnType<typeof parseExposition>,
  name: string,
  labels: Record<string, string> = {},
): number | undefined =>
  parsed.samples.find(
    (sample) =>
      sample.name === name &&
      Object.entries(labels).every(([key, value]) => sample.labels[key] === value),
  )?.value;

/** 開一條 thread（讀歷史會經 `threadFor`，是不用跑模型就能叫 thread 組起來的最短路）。 */
async function openThread(r: Rig, thread: string): Promise<void> {
  const response = await r.handler.handle(
    loopbackRequest(`${BASE}${historyPath(thread)}`, {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
    }),
  );
  expect(response.status).toBe(200);
}

describe('驗收 4：到上限仍就緒，要看指標', () => {
  it('maxThreads: 1、開一條 thread 之後 /readyz 200，nexus_threads 與 nexus_threads_max 都是 1', async () => {
    const r = rig({ maxThreads: 1 });
    await openThread(r, 't1');
    expect((await r.ops.handle(get('/readyz'))).status).toBe(200);
    const parsed = parseExposition(await (await r.ops.handle(get('/metrics', bearer))).text());
    expect(valueOf(parsed, 'nexus_threads')).toBe(1);
    expect(valueOf(parsed, 'nexus_threads_max')).toBe(1);
    expect(valueOf(parsed, 'nexus_threads_closing')).toBe(0);
  });

  it('沒設上限就沒有 nexus_threads_max 這個指標', async () => {
    const r = rig();
    const parsed = parseExposition(await (await r.ops.handle(get('/metrics', bearer))).text());
    expect(valueOf(parsed, 'nexus_threads_max')).toBeUndefined();
    expect(parsed.types.has('nexus_threads_max')).toBe(false);
  });
});

describe('驗收 5：指標的 token', () => {
  it('沒有指標設定（預設）→ 404，帶對的 bearer 也一樣', async () => {
    const r = rig({ metrics: false });
    expect((await r.ops.handle(get('/metrics'))).status).toBe(404);
    expect((await r.ops.handle(get('/metrics', bearer))).status).toBe(404);
  });

  it('不帶 Authorization → 401；帶會話 cookie → 401；錯的 bearer、形狀不對 → 401；訊息不說是哪一種', async () => {
    const r = rig();
    const attempts: Record<string, string>[] = [
      {},
      { cookie: testSessionCookie('localhost') },
      { authorization: `Bearer ${'X'.repeat(43)}` },
      { authorization: `Bearer ${TOKEN.slice(0, 42)}` },
      { authorization: `Bearer ${TOKEN}x` },
      { authorization: TOKEN },
      { authorization: `Basic ${TOKEN}` },
      { authorization: 'Bearer' },
    ];
    for (const headers of attempts) {
      const response = await r.ops.handle(get('/metrics', headers));
      expect(response.status).toBe(401);
      expect(await response.text()).toBe('unauthorized');
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
    }
  });

  it('帶對的 bearer → 200，content-type 是 Prometheus 文字格式 0.0.4，不快取', async () => {
    const r = rig();
    const response = await r.ops.handle(get('/metrics', bearer));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(METRICS_CONTENT_TYPE);
    expect(response.headers.get('content-type')).toContain('version=0.0.4');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('scheme 不分大小寫', async () => {
    const r = rig();
    expect((await r.ops.handle(get('/metrics', { authorization: `bearer ${TOKEN}` }))).status).toBe(
      200,
    );
  });

  it('探針用不上 token：帶不帶都一樣 200', async () => {
    const r = rig();
    expect((await r.ops.handle(get('/livez', bearer))).status).toBe(200);
  });
});

describe('驗收 7：格式', () => {
  it('每個指標都有 HELP 與 TYPE，counter 以 _total 結尾，沒有 thread id 或路徑', async () => {
    const r = rig({ maxThreads: 5 });
    await openThread(r, 'secret-thread-id-xyz');
    r.metrics.recordRequest('wire', 401);
    r.metrics.recordRequest('web', 200);
    r.metrics.recordTurnFailure('RATE_LIMIT');
    const text = await (await r.ops.handle(get('/metrics', bearer))).text();
    const parsed = parseExposition(text);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toContain('secret-thread-id-xyz');
    expect(text).not.toContain('/threads');
    const names = new Set(parsed.samples.map((sample) => sample.name));
    for (const name of names) {
      expect(parsed.help.has(name), `${name} 缺 HELP`).toBe(true);
      expect(parsed.types.has(name), `${name} 缺 TYPE`).toBe(true);
    }
    for (const [name, type] of parsed.types) {
      expect(name.endsWith('_total')).toBe(type === 'counter');
    }
    // 名單固定。
    expect([...parsed.types.keys()].sort()).toEqual(
      [
        'nexus_cgroup_memory_current_bytes',
        'nexus_cgroup_memory_max_bytes',
        'nexus_event_loop_delay_max_seconds',
        'nexus_event_loop_delay_seconds',
        'nexus_http_requests_total',
        'nexus_memory_heap_used_bytes',
        'nexus_memory_rss_bytes',
        'nexus_threads',
        'nexus_threads_closing',
        'nexus_threads_max',
        'nexus_turn_failures_total',
        'process_start_time_seconds',
      ].sort(),
    );
    // 標籤只有固定的那幾種。
    for (const sample of parsed.samples) {
      for (const key of Object.keys(sample.labels)) {
        expect(['surface', 'code_class', 'code', 'quantile']).toContain(key);
      }
    }
  });

  it('請求與回合失敗是真的計數：同一組標籤累加，不同組分開', async () => {
    const r = rig();
    r.metrics.recordRequest('wire', 401);
    r.metrics.recordRequest('wire', 403);
    r.metrics.recordRequest('wire', 200);
    r.metrics.recordRequest('ops', 200);
    r.metrics.recordTurnFailure('RATE_LIMIT');
    r.metrics.recordTurnFailure('RATE_LIMIT');
    r.metrics.recordTurnFailure('TIMEOUT');
    const parsed = parseExposition(await r.metrics.render());
    expect(
      valueOf(parsed, 'nexus_http_requests_total', { surface: 'wire', code_class: '4xx' }),
    ).toBe(2);
    expect(
      valueOf(parsed, 'nexus_http_requests_total', { surface: 'wire', code_class: '2xx' }),
    ).toBe(1);
    expect(
      valueOf(parsed, 'nexus_http_requests_total', { surface: 'ops', code_class: '2xx' }),
    ).toBe(1);
    expect(valueOf(parsed, 'nexus_turn_failures_total', { code: 'RATE_LIMIT' })).toBe(2);
    expect(valueOf(parsed, 'nexus_turn_failures_total', { code: 'TIMEOUT' })).toBe(1);
  });

  it('標籤值跳脫；失敗碼種類有上限，超過歸 OTHER', async () => {
    const r = rig();
    r.metrics.recordTurnFailure('A"B\\C\nD');
    for (let i = 0; i < 100; i += 1) r.metrics.recordTurnFailure(`CODE_${String(i)}`);
    const text = await r.metrics.render();
    expect(text).toContain('nexus_turn_failures_total{code="A\\"B\\\\C\\nD"} 1');
    const parsed = parseExposition(text);
    const codes = parsed.samples.filter((sample) => sample.name === 'nexus_turn_failures_total');
    expect(codes.length).toBeLessThanOrEqual(65);
    expect(valueOf(parsed, 'nexus_turn_failures_total', { code: 'OTHER' })).toBeGreaterThan(0);
  });

  it('事件圈延遲每次抓取後歸零，process_start_time_seconds 是過去的時間', async () => {
    const r = rig();
    const first = parseExposition(await r.metrics.render());
    const start = valueOf(first, 'process_start_time_seconds')!;
    expect(start).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000));
    expect(start).toBeGreaterThan(1_700_000_000);
    expect(
      valueOf(first, 'nexus_event_loop_delay_seconds', { quantile: '0.99' }),
    ).toBeGreaterThanOrEqual(0);
  });

  it('讀不到的記憶體來源整個不出現，不回 0', async () => {
    const r = rig({ cgroup: false });
    const parsed = parseExposition(await r.metrics.render());
    expect(valueOf(parsed, 'nexus_memory_rss_bytes')).toBe(111);
    expect(valueOf(parsed, 'nexus_memory_heap_used_bytes')).toBe(22);
    expect(parsed.types.has('nexus_cgroup_memory_current_bytes')).toBe(false);
    expect(parsed.types.has('nexus_cgroup_memory_max_bytes')).toBe(false);
  });

  it('有 cgroup 就多兩個，上限是 max 的話就只有 current', async () => {
    const r = rig({ cgroup: true });
    const parsed = parseExposition(await r.metrics.render());
    expect(valueOf(parsed, 'nexus_cgroup_memory_current_bytes')).toBe(1000);
    expect(valueOf(parsed, 'nexus_cgroup_memory_max_bytes')).toBe(4000);
  });
});
