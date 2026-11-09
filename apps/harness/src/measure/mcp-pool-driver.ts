/**
 * MCP 連線池前後測（#2570 PR-A）的量測驅動。以 #1947 第 1 步（#1827 D157）的穩態每輪 CPU 驅動為基底，SSE 收尾判準、
 * /proc 的讀法與 patch 的模型段沿用，數字才能對照；假模型叫的工具、臂與 CPU 的加總範圍是 MCP 池的情境。
 * 分析規則見 `.docs/mcp-pool-baseline-2570-2026-11-10.md`。
 *
 * 兩臂同時活著、逐輪交錯（第 k 輪兩臂的先後依 (k + r) 輪轉）：
 *   single      一個 `node lib/serve.js` 放所有 thread，MCP 連線池整個行程一份。
 *   per-thread  `--process-model per-thread`：監督行程起前台、宿主與每條 thread 一個對話行程，池是每個行程一份。
 * 每回合兩臂都重新起（home 也是新的），開 N 條 thread，暖機 W 輪＋量測 T 輪。每一輪是一道柵欄：N 條同時送出，全部收尾才進下一輪。
 *
 * 每台 serve 掛 M=3 台 MCP server：兩台 stdio（{@link ./mcp-pool-stdio-server.ts}，純 node）、一台 HTTP（{@link ./mcp-pool-http-fixture.ts}，
 * 起在驅動裡、每臂一台）。假模型一輪依序叫三台的 `lookup`，再回一段文字。
 *
 * 每道柵欄的 `cpuMs` 是該臂整棵行程樹（根 pid 的所有後代，加上 cmdline 帶 `--tag <臂>` 的行程）所有 thread 的 schedstat 增量，
 * 只在柵欄上取樣；除以 N 的每輪 CPU 總和在彙總算。
 * 柵欄之間出生的行程從 0 起算；死掉的行程丟了增量，記在 `died`。讀不到的（不是消失的）記在 `readErrors`。
 *
 * 環境變數：OUT、TAG、ARMS（逗號分隔，預設兩臂）、N、R、W、T、HARNESS。
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createWireClient } from '@nexus/wire';
import type { WireClient } from '@nexus/wire';
import { startHttpPoolFixture } from './mcp-pool-http-fixture.js';
import type { HttpPoolCounters, HttpPoolFixture } from './mcp-pool-http-fixture.js';

const E = process.env;
const OUT = E.OUT ?? '/out';
const TAG = E.TAG ?? 'mcp-pool';
const ARMS = (E.ARMS ?? 'single,per-thread').split(',') as Arm[];
const N = Number(E.N ?? 4);
const R = Number(E.R ?? 3);
const T = Number(E.T ?? 40);
const W = Number(E.W ?? 5);
const LLM_PORT = 18080;
for (const [k, v] of Object.entries({ N, R, T, W })) {
  if (!Number.isInteger(v) || v < 0) throw new Error(`${k} 要是非負整數：${String(E[k])}`);
}
for (const a of ARMS) {
  if (a !== 'single' && a !== 'per-thread') throw new Error(`ARMS 只收 single、per-thread：${a}`);
}
const HARNESS = E.HARNESS ?? '/opt/nexus/apps/harness';
const STDIO_SERVER = `${HARNESS}/src/measure/mcp-pool-stdio-server.ts`;
const MCP_LOG_DIR = `${OUT}/mcp-log`;
/** 假模型一輪依序叫的三支工具，跟 patch 裡的 serverName 對上。 */
const POOL_TOOLS = ['mcp__mcpa__lookup', 'mcp__mcpb__lookup', 'mcp__mcph__lookup'] as const;

type Arm = 'single' | 'per-thread';
type Json = Record<string, unknown>;

mkdirSync(`${OUT}/logs`, { recursive: true });
mkdirSync(MCP_LOG_DIR, { recursive: true });
const results: Json[] = [];
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
function log(...parts: unknown[]): void {
  const line = `${new Date().toISOString().slice(11, 23)} ${parts.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  console.log(line);
  appendFileSync(`${OUT}/${TAG}.log`, `${line}\n`);
}
function flush(extra: Json = {}): void {
  writeFileSync(
    `${OUT}/${TAG}.json`,
    JSON.stringify(
      { tag: TAG, env: { ARMS, N, R, T, W }, results, llm: llmStats, ...extra },
      null,
      2,
    ),
  );
}

const llmStats = { requests: 0, tool: 0, reply: 0, notools: 0, missingTool: 0, bad: 0 };
function replyText(seed: number): string {
  const parts: string[] = [];
  for (let i = 0; parts.join('').length < 3000; i++) {
    parts.push(
      `第 ${seed} 輪第 ${i} 段：根據查到的資料，整理出 ${(seed * 31 + i).toString(36)} 這個要點，並附上說明與下一步建議。\n`,
    );
  }
  return parts.join('');
}
interface Msg {
  readonly role: string;
}
interface ChatBody {
  readonly messages: readonly Msg[];
  readonly tools?: readonly { readonly function: { readonly name: string } }[];
  readonly model?: string;
  readonly stream?: boolean;
}
type Plan =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tool'; readonly tool: string; readonly args: Json };
function plan(body: ChatBody): Plan {
  const tools = (body.tools ?? []).map((t) => t.function.name);
  const msgs = body.messages;
  const userCount = msgs.filter((m) => m.role === 'user').length;
  if (tools.length === 0) {
    llmStats.notools++;
    return { kind: 'text', text: '量測會話' };
  }
  let lastUser = -1;
  msgs.forEach((m, i) => {
    if (m.role === 'user') lastUser = i;
  });
  const toolMsgs = msgs.slice(lastUser + 1).filter((m) => m.role === 'tool').length;
  const next = POOL_TOOLS[toolMsgs];
  if (next !== undefined) {
    if (tools.includes(next)) {
      llmStats.tool++;
      return { kind: 'tool', tool: next, args: { q: `item-${userCount % 50}` } };
    }
    llmStats.missingTool++;
  }
  llmStats.reply++;
  return { kind: 'text', text: replyText(userCount) };
}
async function fakeLlm(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let raw = '';
  for await (const chunk of req) raw += String(chunk);
  llmStats.requests++;
  if (req.url?.endsWith('/chat/completions') !== true) {
    llmStats.bad++;
    res.writeHead(404).end();
    return;
  }
  const body = JSON.parse(raw) as ChatBody;
  const p = plan(body);
  const id = `chatcmpl-${randomUUID()}`;
  const model = body.model;
  const promptTokens = Math.ceil(raw.length / 4);
  const base = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
  };
  const toolCall = (q: Plan & { kind: 'tool' }): Json => ({
    id: `call_${randomUUID()}`,
    type: 'function',
    function: { name: q.tool, arguments: JSON.stringify(q.args) },
  });
  if (body.stream !== true) {
    const message =
      p.kind === 'text'
        ? { role: 'assistant', content: p.text }
        : { role: 'assistant', content: null, tool_calls: [toolCall(p)] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id,
        object: 'chat.completion',
        created: base.created,
        model,
        choices: [{ index: 0, message, finish_reason: p.kind === 'text' ? 'stop' : 'tool_calls' }],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: 100,
          total_tokens: promptTokens + 100,
        },
      }),
    );
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (o: unknown): void => {
    res.write(`data: ${JSON.stringify(o)}\n\n`);
  };
  send({
    ...base,
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  });
  if (p.kind === 'text') {
    const step = Math.ceil(p.text.length / 20);
    for (let i = 0; i < p.text.length; i += step) {
      send({
        ...base,
        choices: [{ index: 0, delta: { content: p.text.slice(i, i + step) }, finish_reason: null }],
      });
    }
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  } else {
    send({
      ...base,
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, ...toolCall(p) }] },
          finish_reason: null,
        },
      ],
    });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  }
  send({
    ...base,
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: 200,
      total_tokens: promptTokens + 200,
    },
  });
  res.write('data: [DONE]\n\n');
  res.end();
}
const llm = createServer((req, res) => {
  fakeLlm(req, res).catch(() => {
    llmStats.bad++;
    res.destroy();
  });
});
await new Promise<void>((resolve) => llm.listen(LLM_PORT, '127.0.0.1', resolve));

const CLK = 100;
const loadavg = (): string => readFileSync('/proc/loadavg', 'utf8').trim();

/** 行程在這個時刻的樣子；`statMs` 是 `/proc/<pid>/stat` 的 utime＋stime（含已結束的 thread，解析度 10 ms），拿來跟 schedstat 對帳。 */
interface ProcSample {
  readonly pid: number;
  readonly ppid: number;
  readonly cmd: string;
  readonly schedNs: number;
  readonly statMs: number;
  readonly rssKB: number;
  readonly pssKB: number;
  readonly threads: number;
}
interface Scan {
  readonly procs: Map<number, ProcSample>;
  /** 讀的時候已經消失的（不算錯）。 */
  readonly vanished: number;
  /** 讀不到、但還在的（權限之類）：量測輪的每道柵欄都要是 0，彙總照這條標記回合。 */
  readonly readErrors: number;
}
const isGone = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  ['ENOENT', 'ESRCH'].includes(String((error as { code?: unknown }).code));

function num(text: string, key: string): number {
  return Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0);
}

interface ProcBasic {
  readonly pid: number;
  readonly ppid: number;
  readonly cmd: string;
  readonly statMs: number;
}

/** 認行程用的：`stat` 與 `cmdline`，誰都讀得到。 */
function readBasic(pid: number): ProcBasic {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
  const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
  return {
    pid,
    ppid: Number(fields[1]),
    cmd,
    statMs: ((Number(fields[11]) + Number(fields[12])) * 1000) / CLK,
  };
}

/** 被量的行程才讀的：所有 thread 的 schedstat，與（要的話）記憶體。 */
function readDetail(b: ProcBasic, withMem: boolean): ProcSample {
  const { pid } = b;
  let schedNs = 0;
  for (const tid of readdirSync(`/proc/${pid}/task`)) {
    try {
      schedNs += Number(readFileSync(`/proc/${pid}/task/${tid}/schedstat`, 'utf8').split(' ')[0]);
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }
  let rssKB = 0;
  let pssKB = 0;
  let threads = 0;
  if (withMem) {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    rssKB = num(status, 'VmRSS');
    threads = num(status, 'Threads');
    pssKB = num(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'), 'Pss');
  }
  return { ...b, schedNs, rssKB, pssKB, threads };
}

/**
 * 這一臂的行程樹：根的所有後代，加上 cmdline 帶 `--tag <臂>` 的（被 reparent 的 MCP 子行程只能這樣撈到）。
 * `readErrors` 只算認得出、卻讀不到細節的被量行程，加上連 `stat` 都讀不到（認不出是誰）的；後者在容器裡也必須是 0：量測輪的柵欄上不是 0，彙總就標記整回合。
 */
function scanArm(root: number, arm: Arm, withMem = false): Scan {
  const all = new Map<number, ProcBasic>();
  let vanished = 0;
  let readErrors = 0;
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const p = readBasic(Number(entry));
      all.set(p.pid, p);
    } catch (error) {
      if (isGone(error)) vanished++;
      else readErrors++;
    }
  }
  const children = new Map<number, number[]>();
  for (const p of all.values()) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);
  const mine = new Set<number>();
  const stack = all.has(root) ? [root] : [];
  for (let pid = stack.pop(); pid !== undefined; pid = stack.pop()) {
    if (mine.has(pid)) continue;
    mine.add(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  const tag = `--tag ${arm}`;
  for (const p of all.values()) if (p.cmd.includes(tag)) mine.add(p.pid);
  const procs = new Map<number, ProcSample>();
  for (const pid of mine) {
    const b = all.get(pid);
    if (b === undefined) continue;
    try {
      procs.set(pid, readDetail(b, withMem));
    } catch (error) {
      if (isGone(error)) vanished++;
      else readErrors++;
    }
  }
  return { procs, vanished, readErrors };
}

function roleOf(cmd: string): string {
  if (cmd.includes('mcp-pool-stdio-server')) return 'mcp-stdio';
  if (cmd.includes('nexus-supervisor')) return 'supervisor';
  if (cmd.includes('nexus-host')) return 'host';
  if (cmd.includes('nexus-sandbox-spawner')) return 'spawner';
  if (cmd.includes('front-process')) return 'front';
  if (cmd.includes('conversation-process')) return 'conversation';
  if (cmd.includes('lib/serve.js')) return 'serve';
  return 'other';
}

const ms2 = (ns: number): number => +(ns / 1e6).toFixed(2);

/** 兩次掃描之間的 CPU：總和、按角色、對話行程逐個；出生從 0 起算，死掉的記數。 */
function cpuBetween(a: Scan, b: Scan): Json {
  const byRole: Record<string, number> = {};
  const conversations: number[] = [];
  let total = 0;
  let statTotal = 0;
  for (const p of b.procs.values()) {
    const before = a.procs.get(p.pid);
    const d = p.schedNs - (before?.schedNs ?? 0);
    const role = roleOf(p.cmd);
    total += d;
    statTotal += p.statMs - (before?.statMs ?? 0);
    byRole[role] = (byRole[role] ?? 0) + d;
    if (role === 'conversation') conversations.push(ms2(d));
  }
  const died = [...a.procs.keys()].filter((pid) => !b.procs.has(pid)).length;
  const born = [...b.procs.keys()].filter((pid) => !a.procs.has(pid)).length;
  return {
    cpuMs: ms2(total),
    statMs: +statTotal.toFixed(0),
    byRole: Object.fromEntries(Object.entries(byRole).map(([k, v]) => [k, ms2(v)])),
    conversations,
    born,
    died,
    readErrors: a.readErrors + b.readErrors,
  };
}

function census(s: Scan): Json {
  const roles: Record<string, { count: number; rssMB: number; pssMB: number; threads: number }> =
    {};
  for (const p of s.procs.values()) {
    const r = (roles[roleOf(p.cmd)] ??= { count: 0, rssMB: 0, pssMB: 0, threads: 0 });
    r.count++;
    r.rssMB = +(r.rssMB + p.rssKB / 1024).toFixed(1);
    r.pssMB = +(r.pssMB + p.pssKB / 1024).toFixed(1);
    r.threads += p.threads;
  }
  return { roles, readErrors: s.readErrors };
}

const stdioCount = (s: Scan): number =>
  [...s.procs.values()].filter((p) => roleOf(p.cmd) === 'mcp-stdio').length;

function patchFor(arm: Arm, http: HttpPoolFixture, logFile: string): string {
  const stdio = (id: string, server: string): string => `  - id: mcp-pool-${id}
    name: '@nexus/plugin-mcp'
    config:
      serverName: ${server}
      connection:
        transport: stdio
        command: node
        args: ['${STDIO_SERVER}', '--tag', '${arm}']
        env:
          MCP_POOL_LOG: '${logFile}'
          MCP_POOL_SERVER: '${arm}-${server}'
      approval:
        exempt: [lookup]
`;
  return `- id: live-model
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
            enable_thinking: { $var: thinking.enabled }
- id: thread-capacity
  config:
    maxThreads: 100000
    idleEvictAfterMs: 0
- insert:
${stdio('a', 'mcpa')}${stdio('b', 'mcpb')}  - id: mcp-pool-h
    name: '@nexus/plugin-mcp'
    config:
      serverName: mcph
      connection:
        transport: http
        url: '${http.url}'
      approval:
        exempt: [lookup]
`;
}

// 驅動自己跑在 tsx 底下；拿掉它的 loader 設定，被量的 serve 與子行程才是純 node，RSS 與 CPU 不含轉譯器。
function childEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === 'NODE_OPTIONS' || k.startsWith('TSX') || k === 'NODE_PATH') continue;
    env[k] = v;
  }
  return { ...env, NEXUS_AGENT_HOME: home, NVIDIA_API_KEY: 'nvapi-fake-for-measure' };
}

function isRootEnd(v: unknown): string | undefined {
  const e = v as {
    method?: string;
    params?: {
      namespace?: unknown[];
      data?: { event?: string; graph_name?: string } | null;
    };
  };
  const d = e.params?.data;
  if (
    e.method === 'lifecycle' &&
    e.params?.namespace?.length === 0 &&
    d?.graph_name === 'root' &&
    (d.event === 'completed' || d.event === 'failed')
  )
    return d.event;
  return undefined;
}

interface ArmProc {
  readonly arm: Arm;
  readonly proc: ChildProcess;
  readonly pid: number;
  readonly readyMs: number;
  readonly startup: Json;
  readonly client: WireClient;
  readonly http: HttpPoolFixture;
  readonly logFile: string;
  /** spawn 前一刻（`Date.now()`）：池的指標從這裡起算，含起動時的握手。 */
  readonly startedAt: number;
}
const stopping = new Set<ChildProcess>();
const unexpectedExits: Json[] = [];

async function startArm(arm: Arm, round: number): Promise<ArmProc> {
  const home = `/tmp/homes/${arm}-${round}`;
  mkdirSync(home, { recursive: true });
  const http = await startHttpPoolFixture(`${arm}-mcph`);
  const logFile = `${MCP_LOG_DIR}/${arm}-${round}.jsonl`;
  writeFileSync(logFile, '');
  const patch = `/tmp/patch-${arm}-${round}.yml`;
  writeFileSync(patch, patchFor(arm, http, logFile));
  const port = arm === 'single' ? 9001 : 9002;
  const args = [
    'lib/serve.js',
    '--live',
    '--workspace',
    '/work',
    '--patch',
    patch,
    '--port',
    String(port),
  ];
  if (arm === 'per-thread') args.push('--process-model', 'per-thread');
  const startedAt = Date.now();
  const t0 = performance.now();
  const proc = spawn('node', args, {
    cwd: HARNESS,
    env: childEnv(home),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logf = `${OUT}/logs/${TAG}-${arm}-${round}.log`;
  const onText = (s: string): void => {
    appendFileSync(logf, s.replace(/token=\S*/gu, 'token=***'));
  };
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${arm} 120 秒內沒印出網址`));
    }, 120000);
    // per-thread 的前台把 stdout 留給跟監督行程的控制框，自己的輸出改寫到 stderr；兩條都看。
    const onData = (d: Buffer): void => {
      const s = d.toString();
      onText(s);
      const m = /http:\/\/\S*token=\S*/u.exec(s);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (!stopping.has(proc)) {
        const ev = { arm, round, code, signal, at: new Date().toISOString(), loadavg: loadavg() };
        unexpectedExits.push(ev);
        log('serve 意外結束', ev);
      }
      reject(new Error(`${arm} 結束 code=${String(code)} signal=${String(signal)}`));
    });
  });
  const readyMs = +(performance.now() - t0).toFixed(1);
  const pid = proc.pid ?? -1;
  const startup = {
    ...cpuBetween(emptyScan, scanArm(pid, arm)),
    census: census(scanArm(pid, arm, true)),
  };
  const response = await fetch(url, { redirect: 'manual' });
  const cookie = (response.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
  const client = createWireClient({
    baseUrl: new URL(url).origin,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('cookie', cookie);
      return fetch(input, { ...init, headers });
    },
  });
  return { arm, proc, pid, readyMs, startup, client, http, logFile, startedAt };
}
const emptyScan: Scan = { procs: new Map(), vanished: 0, readErrors: 0 };

async function stopArm(p: ArmProc): Promise<Json> {
  stopping.add(p.proc);
  if (p.proc.exitCode === null && p.proc.signalCode === null) {
    const done = new Promise((resolve) => p.proc.once('exit', resolve));
    p.proc.kill('SIGTERM');
    const timer = setTimeout(() => p.proc.kill('SIGKILL'), 15000);
    await done;
    clearTimeout(timer);
  }
  // 收完之後還留著、cmdline 帶 --tag <臂> 的（孤兒）：記下來再清掉，不讓它吃下一回合的 CPU。
  await sleep(500);
  const left = [...scanArm(-1, p.arm).procs.values()].map((x) => ({
    pid: x.pid,
    cmd: x.cmd.slice(0, 120),
  }));
  for (const x of left) {
    try {
      process.kill(x.pid, 'SIGKILL');
    } catch {
      // 已經不在了
    }
  }
  await p.http.close();
  return { leftovers: left };
}

interface StdioEvent {
  readonly server: string;
  readonly pid: number;
  readonly ev: string;
  readonly at: number;
}
function stdioEvents(file: string): StdioEvent[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as StdioEvent);
}

/** 池的指標：stdio 起了幾個行程、完成幾次握手、收到幾次呼叫（server 自己記的）；HTTP 的方法次數、initialize、呼叫與連線數（fixture 記的）。 */
function poolMetrics(p: ArmProc, sinceAt: number): Json {
  const evs = stdioEvents(p.logFile);
  const per = (ev: string): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const e of evs)
      if (e.ev === ev && e.at >= sinceAt) out[e.server] = (out[e.server] ?? 0) + 1;
    return out;
  };
  const h: HttpPoolCounters = p.http.counters();
  return {
    stdioStarted: per('start'),
    stdioInitialized: per('initialized'),
    stdioCalls: per('call'),
    http: {
      initialize: h.initializeAt.filter((t) => t >= sinceAt).length,
      calls: h.callAt.filter((t) => t >= sinceAt).length,
      methods: h.methods,
      openConnections: h.openConnections,
      peakConnections: h.peakConnections,
      acceptedConnections: h.acceptedConnections,
    },
  };
}

/** 每台 server 在 `at0` 之後第一次收到 `tools/call` 的時間差（ms）。 */
function firstCallMs(p: ArmProc, at0: number): Json {
  const out: Record<string, number | null> = {};
  for (const server of ['mcpa', 'mcpb']) {
    const first = stdioEvents(p.logFile).find(
      (e) => e.ev === 'call' && e.server === `${p.arm}-${server}` && e.at >= at0,
    );
    out[server] = first === undefined ? null : first.at - at0;
  }
  const h = p.http.counters().callAt.find((t) => t >= at0);
  out.mcph = h === undefined ? null : h - at0;
  return out;
}

interface Downlink {
  readonly id: string;
  readonly events: AsyncGenerator<unknown, void, undefined>;
  readonly abort: AbortController;
}

async function runOne(p: ArmProc, d: Downlink, text: string): Promise<Json> {
  const t0 = performance.now();
  const r = await p.client.runStart(d.id, text);
  if ('error' in r && r.error !== undefined && r.error !== null)
    throw new Error(`${p.arm} run.start 失敗：${JSON.stringify(r.error)}`);
  let n = 0;
  for (;;) {
    const next = await d.events.next();
    if (next.done === true) throw new Error(`${p.arm} 下行在收尾前斷了`);
    n++;
    const end = isRootEnd(next.value);
    if (end !== undefined)
      return { wallMs: +(performance.now() - t0).toFixed(1), events: n, outcome: end };
  }
}

/** 一道柵欄：N 條同時送出、全部收尾；CPU 只在柵欄兩端取樣。 */
async function barrier(p: ArmProc, links: readonly Downlink[], text: string): Promise<Json> {
  const la = loadavg();
  const req0 = llmStats.requests;
  const s0 = scanArm(p.pid, p.arm);
  const at0 = Date.now();
  const t0 = performance.now();
  const per = await Promise.all(links.map((d) => runOne(p, d, text)));
  const wallMs = +(performance.now() - t0).toFixed(1);
  const s1 = scanArm(p.pid, p.arm);
  return {
    at0,
    wallMs,
    ...cpuBetween(s0, s1),
    stdioBefore: stdioCount(s0),
    stdioAfter: stdioCount(s1),
    procsBefore: s0.procs.size,
    procsAfter: s1.procs.size,
    threadWallMs: per.map((x) => x.wallMs),
    outcomes: per.map((x) => x.outcome),
    llmReq: llmStats.requests - req0,
    la,
  };
}

async function closeDownlink(d: Downlink): Promise<void> {
  d.abort.abort();
  try {
    await d.events.return(undefined);
  } catch {
    // 中止之後 return 可能拋，收線本身已經完成
  }
}

log('start', { ARMS, N, R, T, W, loadavg: loadavg(), node: process.version });
try {
  for (let r = 1; r <= R; r++) {
    const laBefore = loadavg();
    const order = r % 2 === 0 ? [...ARMS].reverse() : [...ARMS];
    const arms: Partial<Record<Arm, ArmProc>> = {};
    for (const a of order) arms[a] = await startArm(a, r);
    const get = (a: Arm): ArmProc => {
      const p = arms[a];
      if (p === undefined) throw new Error(`第 ${r} 回合沒有 ${a}`);
      return p;
    };
    const links: Partial<Record<Arm, Downlink[]>> = {};
    const open: Json = {};
    for (const a of ARMS) {
      const p = get(a);
      const s0 = scanArm(p.pid, a);
      const t0 = performance.now();
      links[a] = await Promise.all(
        Array.from({ length: N }, async () => {
          const id = randomUUID();
          const abort = new AbortController();
          const events = await p.client.openEvents(id, { signal: abort.signal });
          return { id, events, abort };
        }),
      );
      open[a] = {
        wallMs: +(performance.now() - t0).toFixed(1),
        ...cpuBetween(s0, scanArm(p.pid, a)),
      };
    }
    const turns: Record<string, Json[]> = Object.fromEntries(ARMS.map((a) => [a, []]));
    const firstCall: Json = {};
    for (let k = 1; k <= W + T; k++) {
      const rot = (k + r) % ARMS.length;
      const turnOrder = [...ARMS.slice(rot), ...ARMS.slice(0, rot)];
      for (const a of turnOrder) {
        const text =
          k <= W
            ? `暖機 ${k}：請查三個系統並整理重點。`
            : `第 ${k - W} 輪：請查三個系統並整理重點。`;
        const p = get(a);
        const tr = await barrier(p, links[a] ?? [], text);
        if (k === 1) firstCall[a] = firstCallMs(p, Number(tr.at0));
        turns[a]?.push({ k, warm: k <= W, pos: turnOrder.indexOf(a), ...tr });
      }
    }
    const pool = Object.fromEntries(ARMS.map((a) => [a, poolMetrics(get(a), get(a).startedAt)]));
    const memAfter = Object.fromEntries(ARMS.map((a) => [a, census(scanArm(get(a).pid, a, true))]));
    for (const a of ARMS) for (const d of links[a] ?? []) await closeDownlink(d);
    const stopped: Json = {};
    for (const a of ARMS) stopped[a] = await stopArm(get(a));
    const row = {
      label: `round ${String(r)}`,
      round: r,
      order,
      laBefore,
      laAfter: loadavg(),
      startup: Object.fromEntries(
        ARMS.map((a) => [a, { readyMs: get(a).readyMs, ...get(a).startup }]),
      ),
      open,
      firstCall,
      pool,
      memAfter,
      stopped,
      turns,
    };
    results.push(row);
    const med = (xs: number[]): number | undefined =>
      [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];
    log(row.label, {
      laBefore,
      firstCall,
      medCpuPerTurn: Object.fromEntries(
        ARMS.map((a) => [
          a,
          med((turns[a] ?? []).filter((t) => t.warm !== true).map((t) => Number(t.cpuMs) / N)),
        ]),
      ),
      bad: ARMS.map(
        (a) =>
          (turns[a] ?? []).flatMap((t) => t.outcomes as string[]).filter((o) => o !== 'completed')
            .length,
      ),
    });
    flush();
  }
} catch (error) {
  log('ERROR', String((error as Error).stack ?? error).slice(0, 2000));
  results.push({ label: 'ERROR', error: String(error).slice(0, 500) });
}
flush({ done: true, unexpectedExits });
log('done', { llmStats, unexpectedExits: unexpectedExits.length });
llm.close();
process.exit(0);
