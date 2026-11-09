/**
 * #1947 第 1 步（#1827 D157）：穩態每輪 CPU 量測驅動。
 * 假模型、/proc 量具、patch 與 SSE 判準抄自 2026-10-24/supervisor-1947-r6/scripts/r6-driver.mts。
 *
 * 四臂，四個行程同時活著，逐輪交錯（第 k 輪的四臂順序依 (k + r) 輪轉），突發負載會同時落在四臂上：
 *   L    每回合新起一個 `node lib/serve.js`，只有被量的這一條 thread（形狀 B 的對話行程近似；傳輸跟 S 一樣走 HTTP＋SSE）。
 *   SK   共用、已暖的 serve，idleEvictAfterMs=0：每回合的 thread 不關、一路累積（重現 R6 的 S）。
 *   SF   共用、已暖的 serve，idleEvictAfterMs=EVICT_MS：每回合結束等被量的 thread 真的逐出（serve 記一行「[閒置逐出]」）才進下一回合；
 *        暖機的 10 條也先等逐出。回合開始時常駐 thread 數固定為 0。
 *   SF2  跟 SF 同設定的第二個行程：SF2/SF 是這套量法的雜訊底（A/A）。
 * 每輪 CPU 是被量行程所有 thread 的 schedstat 增量，另按 thread 名（comm）拆開。監督行程那一跳不在裡面。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createWireClient, type WireClient } from '@nexus/wire';

const E = process.env;
const OUT = E.OUT ?? '/out';
const TAG = E.TAG ?? 'cpu';
const R = Number(E.R ?? 12);
const T = Number(E.T ?? 40);
const W = Number(E.W ?? 5);
const WARM_THREADS = Number(E.WARM_THREADS ?? 10);
const WARM_TURNS = Number(E.WARM_TURNS ?? 5);
const EVICT_MS = Number(E.EVICT_MS ?? 3000);
const LLM_PORT = 18080;
const HARNESS = '/opt/nx/apps/harness';
mkdirSync(`${OUT}/logs`, { recursive: true });
const results: Record<string, unknown>[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => {
  const line = `${new Date().toISOString().slice(11, 23)} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  console.log(line);
  appendFileSync(`${OUT}/${TAG}.log`, line + '\n');
};
const flush = (extra: Record<string, unknown> = {}) =>
  writeFileSync(`${OUT}/${TAG}.json`, JSON.stringify({ tag: TAG, env: { R, T, W, WARM_THREADS, WARM_TURNS, EVICT_MS }, results, llm: llmStats, ...extra }, null, 2));

// ---------- 假模型（同 b1-driver：read_file → grep → 3000 字回覆，串流 20 段） ----------
const llmStats = { requests: 0, read: 0, grep: 0, reply: 0, notools: 0, bad: 0 };
function replyText(seed: number): string {
  const parts: string[] = [];
  for (let i = 0; parts.join('').length < 3000; i++) {
    parts.push(`第 ${seed} 輪第 ${i} 段：根據讀到的文件，整理出 ${(seed * 31 + i).toString(36)} 這個要點，並附上說明與下一步建議。\n`);
  }
  return parts.join('');
}
type Msg = { role: string; content?: unknown };
function plan(body: { messages: Msg[]; tools?: { function: { name: string } }[] }) {
  const tools = (body.tools ?? []).map((t) => t.function.name);
  const msgs = body.messages;
  const userCount = msgs.filter((m) => m.role === 'user').length;
  if (tools.length === 0) {
    llmStats.notools++;
    return { text: '量測會話' } as const;
  }
  let lastUser = -1;
  msgs.forEach((m, i) => {
    if (m.role === 'user') lastUser = i;
  });
  const toolMsgs = msgs.slice(lastUser + 1).filter((m) => m.role === 'tool').length;
  const k = String(userCount % 50).padStart(2, '0');
  if (toolMsgs === 0 && tools.includes('read_file')) {
    llmStats.read++;
    return { tool: 'read_file', args: { file_path: `/docs/f${k}.md`, offset: 0 } } as const;
  }
  if (toolMsgs === 1 && tools.includes('grep')) {
    llmStats.grep++;
    return { tool: 'grep', args: { pattern: `topic-${userCount % 50} `, path: '/docs', glob: null, max_count: null, output_mode: 'content' } } as const;
  }
  llmStats.reply++;
  return { text: replyText(userCount) } as const;
}
async function fakeLlm(req: IncomingMessage, res: ServerResponse) {
  let raw = '';
  for await (const c of req) raw += c;
  llmStats.requests++;
  if (!req.url?.endsWith('/chat/completions')) {
    llmStats.bad++;
    res.writeHead(404).end();
    return;
  }
  const body = JSON.parse(raw);
  const p = plan(body);
  const id = `chatcmpl-${randomUUID()}`;
  const model = body.model;
  const promptTokens = Math.ceil(raw.length / 4);
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model };
  if (body.stream !== true) {
    const message =
      'text' in p
        ? { role: 'assistant', content: p.text }
        : { role: 'assistant', content: null, tool_calls: [{ id: `call_${randomUUID()}`, type: 'function', function: { name: p.tool, arguments: JSON.stringify(p.args) } }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id, object: 'chat.completion', created: base.created, model, choices: [{ index: 0, message, finish_reason: 'text' in p ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: promptTokens, completion_tokens: 100, total_tokens: promptTokens + 100 } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
  if ('text' in p) {
    const step = Math.ceil(p.text.length / 20);
    for (let i = 0; i < p.text.length; i += step) send({ ...base, choices: [{ index: 0, delta: { content: p.text.slice(i, i + step) }, finish_reason: null }] });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  } else {
    send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${randomUUID()}`, type: 'function', function: { name: p.tool, arguments: JSON.stringify(p.args) } }] }, finish_reason: null }] });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  }
  send({ ...base, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 200, total_tokens: promptTokens + 200 } });
  res.write('data: [DONE]\n\n');
  res.end();
}
const llm = createServer((req, res) => {
  fakeLlm(req, res).catch(() => {
    llmStats.bad++;
    res.destroy();
  });
});
await new Promise<void>((r) => llm.listen(LLM_PORT, '127.0.0.1', r));

// ---------- /proc 量具 ----------
const CLK = 100;
function pstat(pid: number) {
  const st = readFileSync(`/proc/${pid}/status`, 'utf8');
  const g = (k: string) => Number((st.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) ?? [])[1] ?? 0);
  let pss = 0, pssAnon = 0, pssFile = 0;
  try {
    const sr = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    const k = (name: string) => Number((sr.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm')) ?? [])[1] ?? 0);
    pss = k('Pss');
    pssAnon = k('Pss_Anon');
    pssFile = k('Pss_File');
  } catch {}
  const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ');
  return {
    pid,
    name: (st.match(/^Name:\s+(\S+)/m) ?? [])[1] ?? '',
    ppid: g('PPid'),
    rssKB: g('VmRSS'),
    hwmKB: g('VmHWM'),
    anonKB: g('RssAnon'),
    fileKB: g('RssFile'),
    shmemKB: g('RssShmem'),
    pssKB: pss,
    pssAnonKB: pssAnon,
    pssFileKB: pssFile,
    threads: g('Threads'),
    cpuMs: ((Number(f[11]) + Number(f[12])) * 1000) / CLK,
    childCpuMs: ((Number(f[13]) + Number(f[14])) * 1000) / CLK,
  };
}
function schedNs(pid: number): number {
  let s = 0;
  for (const t of readdirSync(`/proc/${pid}/task`)) {
    try {
      s += Number(readFileSync(`/proc/${pid}/task/${t}/schedstat`, 'utf8').split(' ')[0]);
    } catch {}
  }
  return s;
}
function cpuNow(pid: number) {
  const p = pstat(pid);
  return { schedNs: schedNs(pid), statMs: p.cpuMs + p.childCpuMs };
}
function cgroup() {
  const cur = Number(readFileSync('/sys/fs/cgroup/memory.current', 'utf8'));
  let peak = NaN;
  try {
    peak = Number(readFileSync('/sys/fs/cgroup/memory.peak', 'utf8'));
  } catch {}
  const stat = Object.fromEntries(
    readFileSync('/sys/fs/cgroup/memory.stat', 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.split(' '))
      .filter(([k]) => ['anon', 'file', 'kernel', 'kernel_stack', 'pagetables', 'shmem', 'slab', 'sock'].includes(k!))
      .map(([k, v]) => [k, Number(v)]),
  );
  const events = Object.fromEntries(readFileSync('/sys/fs/cgroup/memory.events', 'utf8').trim().split('\n').map((l) => l.split(' ')).map(([k, v]) => [k, Number(v)]));
  return { events, memoryCurrentMB: +(cur / 1048576).toFixed(1), memoryPeakMB: +(peak / 1048576).toFixed(1), statMB: Object.fromEntries(Object.entries(stat).map(([k, v]) => [k, +(v / 1048576).toFixed(1)])) };
}
function allProcs() {
  const out: ReturnType<typeof pstat>[] = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      out.push(pstat(Number(d)));
    } catch {}
  }
  return out;
}
const MB = (kb: number) => +(kb / 1024).toFixed(1);
const loadavg = () => readFileSync('/proc/loadavg', 'utf8').trim();
const PATCH = `- id: live-model
  config:
    baseUrl: 'http://127.0.0.1:${LLM_PORT}/v1'
    modelId: 'nvidia/nemotron-3-super-120b-a12b'
    timeoutMs: 180000
    streamIdleTimeoutMs: 90000
    retryPolicy:
      mode: normal
      maxRetries: 6
      retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]
      backoff: { initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 }
    models:
      - id: 'nvidia/nemotron-3-super-120b-a12b'
        contextWindow: 700045
        maxTokens: 16384
        input: [text]
        reasoningEfforts: { off: null, default: default }
        tokenizer: { digits: single }
        compat:
          chatTemplateKwargs:
            enable_thinking: { \$var: thinking.enabled }
- id: thread-capacity
  config:
    maxThreads: 100000
    idleEvictAfterMs: __EVICT__
`;
writeFileSync('/tmp/p-keep.yml', PATCH.replace('__EVICT__', '0'));
writeFileSync('/tmp/p-evict.yml', PATCH.replace('__EVICT__', String(EVICT_MS)));
function childEnv(home: string, extra: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === 'NODE_OPTIONS' || k.startsWith('TSX') || k === 'NODE_PATH') continue;
    env[k] = v;
  }
  return { ...env, NEXUS_AGENT_HOME: home, NVIDIA_API_KEY: 'nvapi-fake-for-measure', ...extra };
}
function sseFramesFrom(buf: { s: string }): unknown[] {
  const out: unknown[] = [];
  for (;;) {
    const at = buf.s.indexOf('\n\n');
    if (at < 0) break;
    const block = buf.s.slice(0, at);
    buf.s = buf.s.slice(at + 2);
    const data = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data === '') continue;
    try {
      out.push(JSON.parse(data));
    } catch {}
  }
  return out;
}
const isRootEnd = (v: unknown): string | undefined => {
  const e = v as { method?: string; params?: { namespace?: unknown[]; data?: { event?: string; graph_name?: string } | null } };
  const d = e.params?.data;
  if (e.method === 'lifecycle' && e.params?.namespace?.length === 0 && d?.graph_name === 'root' && (d.event === 'completed' || d.event === 'failed')) return d.event;
  return undefined;
};

// ---------- 每個 thread 的 CPU，按 comm 拆 ----------
function taskCpu(pid: number): Record<string, number> {
  const by: Record<string, number> = { total: 0 };
  for (const t of readdirSync(`/proc/${pid}/task`)) {
    try {
      const comm = readFileSync(`/proc/${pid}/task/${t}/comm`, 'utf8').trim();
      const ns = Number(readFileSync(`/proc/${pid}/task/${t}/schedstat`, 'utf8').split(' ')[0]);
      const key = Number(t) === pid ? 'main' : comm;
      by[key] = (by[key] ?? 0) + ns;
      by.total! += ns;
    } catch {}
  }
  return by;
}
function diffMs(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = ((b[k] ?? 0) - (a[k] ?? 0)) / 1e6;
    if (Math.abs(d) >= 0.01) out[k] = +d.toFixed(2);
  }
  return out;
}

// ---------- serve 行程 ----------
interface Proc {
  name: string;
  i: number;
  proc: ChildProcess;
  pid: number;
  readyMs: number;
  startupCpu: Record<string, number>;
  client: WireClient;
  evicted: Set<string>;
}
const stopping = new Set<ChildProcess>();
const unexpectedExits: Record<string, unknown>[] = [];
async function startServe(name: string, i: number, patch: string): Promise<Proc> {
  const home = `/tmp/homes/${name}-${i}`;
  mkdirSync(home, { recursive: true });
  const port = 9000 + i;
  const t0 = performance.now();
  const proc = spawn('node', ['lib/serve.js', '--live', '--workspace', '/work', '--patch', patch, '--port', String(port)], {
    cwd: HARNESS,
    env: childEnv(home),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logf = `${OUT}/logs/${TAG}-${name}-${i}.log`;
  const evicted = new Set<string>();
  const onText = (s: string) => {
    appendFileSync(logf, s.replace(/token=[^\s]*/g, 'token=***'));
    for (const m of s.matchAll(/\[閒置逐出\] thread "([^"]+)"/g)) evicted.add(m[1]!);
  };
  const url = await new Promise<string>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`${name} 120 秒內沒印出網址`)), 120000);
    proc.stdout!.on('data', (d: Buffer) => {
      const s = d.toString();
      onText(s);
      const m = s.match(/http:\/\/[^\s]*token=[^\s]*/);
      if (m) {
        clearTimeout(to);
        resolve(m[0]);
      }
    });
    proc.stderr!.on('data', (d: Buffer) => onText(d.toString()));
    proc.on('exit', (c, s) => {
      clearTimeout(to);
      if (!stopping.has(proc)) {
        const ev = { name, i, code: c, signal: s, at: new Date().toISOString(), loadavg: loadavg() };
        unexpectedExits.push(ev);
        log('serve 意外結束', ev);
      }
      reject(new Error(`${name} 結束 code=${c} signal=${s}`));
    });
  });
  const readyMs = +(performance.now() - t0).toFixed(1);
  const startupCpu = taskCpu(proc.pid!);
  const response = await fetch(url, { redirect: 'manual' });
  const cookie = response.headers.get('set-cookie')!.split(';', 1)[0]!;
  const client = createWireClient({
    baseUrl: new URL(url).origin,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('cookie', cookie);
      return fetch(input, { ...init, headers });
    },
  });
  return { name, i, proc, pid: proc.pid!, readyMs, startupCpu, client, evicted };
}
async function stopServe(p: Proc) {
  stopping.add(p.proc);
  if (p.proc.exitCode !== null || p.proc.signalCode !== null) return;
  const done = new Promise((r) => p.proc.once('exit', r));
  p.proc.kill('SIGTERM');
  const t = setTimeout(() => p.proc.kill('SIGKILL'), 15000);
  await done;
  clearTimeout(t);
}
async function waitEvicted(p: Proc, ids: string[], timeoutMs = 60000) {
  const t0 = performance.now();
  while (ids.some((id) => !p.evicted.has(id))) {
    if (performance.now() - t0 > timeoutMs) return { ok: false, waitedMs: +(performance.now() - t0).toFixed(0), missing: ids.filter((id) => !p.evicted.has(id)).length };
    await sleep(200);
  }
  return { ok: true, waitedMs: +(performance.now() - t0).toFixed(0), missing: 0 };
}

// 一輪：wall＝送出 run.start 到收到 root lifecycle 收尾
async function serveTurn(p: Proc, threadId: string, text: string, events: AsyncGenerator<unknown>) {
  const la = loadavg();
  const req0 = llmStats.requests;
  const c0 = taskCpu(p.pid);
  const t0 = performance.now();
  const r = await p.client.runStart(threadId, text);
  if ('error' in r && r.error) throw new Error(`${p.name} run.start 失敗：${JSON.stringify(r.error)}`);
  let n = 0;
  let outcome = '';
  for (;;) {
    const next = await events.next();
    if (next.done) throw new Error(`${p.name} 下行在收尾前斷了`);
    n++;
    const end = isRootEnd(next.value);
    if (end !== undefined) {
      outcome = end;
      break;
    }
  }
  const wallMs = +(performance.now() - t0).toFixed(2);
  const by = diffMs(c0, taskCpu(p.pid));
  return { wallMs, cpuMs: by.total ?? 0, by, events: n, outcome, llmReq: llmStats.requests - req0, la };
}
const memOf = (p: Proc) => {
  const s = pstat(p.pid);
  return { rssMB: MB(s.rssKB), anonMB: MB(s.anonKB), threads: s.threads };
};

// 關下行：中止 fetch 才會讓 server 端的 subscriberCount 歸零（只 return generator 不會，smoke 時 SF 一條都沒逐出）
async function closeDownlink(ev: AsyncGenerator<unknown>, ac: AbortController) {
  ac.abort();
  try {
    await ev.return(undefined);
  } catch {}
}

// ---------- 主流程 ----------
log('start', { R, T, W, WARM_THREADS, WARM_TURNS, EVICT_MS, loadavg: loadavg(), node: process.version });
const shared: Record<string, Proc> = {};
try {
  shared.SK = await startServe('SK', 1, '/tmp/p-keep.yml');
  shared.SF = await startServe('SF', 2, '/tmp/p-evict.yml');
  shared.SF2 = await startServe('SF2', 3, '/tmp/p-evict.yml');
  for (const p of Object.values(shared)) {
    const ids: string[] = [];
    for (let w = 0; w < WARM_THREADS; w++) {
      const id = randomUUID();
      ids.push(id);
      const ac = new AbortController();
      const ev = await p.client.openEvents(id, { signal: ac.signal });
      for (let k = 1; k <= WARM_TURNS; k++) {
        const tr = await serveTurn(p, id, `暖機 ${w}-${k}：請讀文件並整理重點。`, ev);
        if (tr.outcome !== 'completed') throw new Error(`${p.name} 暖機收尾 ${tr.outcome}`);
      }
      await closeDownlink(ev, ac);
    }
    const ev = p.name === 'SK' ? { ok: 'n/a' } : await waitEvicted(p, ids);
    const row = { label: `warm ${p.name}`, readyMs: p.readyMs, startupCpuMs: +((p.startupCpu.total ?? 0) / 1e6).toFixed(1), evict: ev, mem: memOf(p) };
    results.push(row);
    log(row.label, row);
  }
  const BASE = ['L', 'SK', 'SF', 'SF2'];
  for (let r = 1; r <= R; r++) {
    const laBefore = loadavg();
    const L = await startServe('L', 100 + r, '/tmp/p-keep.yml');
    const arms: Record<string, Proc> = { L, SK: shared.SK!, SF: shared.SF!, SF2: shared.SF2! };
    const ids: Record<string, string> = {};
    const evs: Record<string, AsyncGenerator<unknown>> = {};
    const acs: Record<string, AbortController> = {};
    const open: Record<string, unknown> = {};
    const turns: Record<string, unknown[]> = { L: [], SK: [], SF: [], SF2: [] };
    const memBefore = Object.fromEntries(BASE.map((a) => [a, memOf(arms[a]!)]));
    for (const a of BASE) {
      ids[a] = randomUUID();
      const c0 = taskCpu(arms[a]!.pid);
      const t0 = performance.now();
      acs[a] = new AbortController();
      evs[a] = (await arms[a]!.client.openEvents(ids[a]!, { signal: acs[a]!.signal })) as AsyncGenerator<unknown>;
      open[a] = { wallMs: +(performance.now() - t0).toFixed(1), cpuMs: diffMs(c0, taskCpu(arms[a]!.pid)).total ?? 0 };
    }
    // 整回合的累計 CPU（開完 thread 到關下行之前），用來算量測窗內的佔比：交錯時兩輪之間的背景工作不在任何一輪的窗裡
    const span0 = Object.fromEntries(BASE.map((a) => [a, taskCpu(arms[a]!.pid)]));
    for (let k = 1; k <= W + T; k++) {
      const rot = (k + r) % 4;
      const order = [...BASE.slice(rot), ...BASE.slice(0, rot)];
      for (const a of order) {
        const text = k <= W ? `暖機 ${k}：請讀文件並整理重點。` : `第 ${k - W} 輪：請讀文件並整理重點。`;
        const tr = await serveTurn(arms[a]!, ids[a]!, text, evs[a]!);
        turns[a]!.push({ k, warm: k <= W, pos: order.indexOf(a), ...tr });
      }
    }
    const span = Object.fromEntries(BASE.map((a) => [a, diffMs(span0[a]!, taskCpu(arms[a]!.pid))]));
    const memAfter = Object.fromEntries(BASE.map((a) => [a, memOf(arms[a]!)]));
    for (const a of BASE) await closeDownlink(evs[a]!, acs[a]!);
    await stopServe(L);
    const evict = { SF: await waitEvicted(shared.SF!, [ids.SF!]), SF2: await waitEvicted(shared.SF2!, [ids.SF2!]) };
    const row = {
      label: `round ${r}`,
      round: r,
      laBefore,
      laAfter: loadavg(),
      L: { readyMs: L.readyMs, startupCpuMs: +((L.startupCpu.total ?? 0) / 1e6).toFixed(1) },
      open,
      memBefore,
      memAfter,
      evict,
      span,
      turns,
    };
    results.push(row);
    const med = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];
    log(row.label, {
      laBefore,
      L: row.L,
      evict,
      medCpu: Object.fromEntries(BASE.map((a) => [a, med((turns[a] as { warm: boolean; cpuMs: number }[]).filter((t) => !t.warm).map((t) => t.cpuMs))])),
      bad: BASE.map((a) => (turns[a] as { outcome: string }[]).filter((t) => t.outcome !== 'completed').length),
    });
    flush();
  }
} catch (e) {
  log('ERROR', String((e as Error)?.stack ?? e).slice(0, 2000));
  results.push({ label: 'ERROR', error: String(e).slice(0, 500) });
}
for (const p of Object.values(shared)) await stopServe(p);
flush({ done: true, unexpectedExits });
log('done', { llmStats, unexpectedExits: unexpectedExits.length });
llm.close();
process.exit(0);
