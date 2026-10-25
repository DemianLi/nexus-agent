#!/usr/bin/env node
/* global console, process, URL, setTimeout, clearTimeout, window, document, requestAnimationFrame, performance */
/**
 * 大面積玻璃的效能門檻（#1468 Q7、Q13、Q17，#1512）：Chrome 關 GPU 加速、CPU 降速 4 倍，量三種情境的 frame time，
 * p95 ≤ 16.7ms 才能合併（判的是 vsync 個數：p95 ≤ 1 個 vsync，見 `summarize`）；不達標就退成不透明（`data-glass="opaque"`／reduced-transparency 那條路），由 PM 與 demian 決定。
 *
 * 三種情境：
 * 1. **串流中捲動**：回覆還在串的時候，在對話區上下捲。
 * 2. **開 composer 選單**：輸入框（一層玻璃）上開模型選擇浮層（又一層玻璃），開、等、關，重複幾次。
 * 3. **開關側欄**：⌘B／Ctrl+B 開關，重複幾次。
 * 4. **工具段展開時串流中捲動**（#1682 驗收 D）：一步 12 顆工具（讀檔、grep 計數、找檔各 4 顆）收成一段，回覆接著慢慢串；
 *    展開那一段與每種各一列（SG 的 `StepList`／`OutputBlock` 都是 `glass-panel`），在對話區上下捲。
 *    `--tool-mix diff`（#1685 B 驗收 12）：12 顆裡寫檔、改檔各 4 顆（SG 的 `DiffView`，`step.patch`；另 4 顆是改之前的讀檔），全部展開。
 *    `--tool-mix big-writes`（同上）：6 顆寫檔、每顆 6,000 行（每張都撞到 `DiffView` 的上限），段展開、卡全部收著：
 *    量的是串流中每一格段跟著重畫時，列與段的 `+N −M`（vendor 的 `patchStats`）的成本。
 *
 * `--suite reasoning`（#1683 驗收 E）換成兩個推理列的情境，上面四個不跑：
 * 5. **長歷史初次載入**：先填 {@link REASONING_TURNS} 輪、每輪一則約 2k 字推理（markdown）加一句回覆，重新整理頁面，從載入到
 *    第一頁的推理列全部畫出後 2 秒。歷史一頁最多 50 則訊息（`@nexus/wire` 的 `HISTORY_PAGE_MESSAGES`），一輪是人一則、AI 一則，
 *    所以初次載入最多 {@link LOAD_ROWS} 列，更早的要往上捲才載。SG 的 `<details>` 收著也掛內文，Base UI 的 collapsible 收著不畫，
 *    差在這裡。
 * 6. **推理收著時串流中捲動**：接著一輪推理慢慢串（收著），在對話區上下捲。
 *
 * `--suite turn-status`（#1684 驗收 E）量狀態列執行中那一列的成本，上面六個不跑。SG 的 `StatusGlyph` 是 JS rAF 每幀改 SVG 屬性，
 * 狀態列在對話區外面、串流中一直看得到，IntersectionObserver 不會讓它停：
 * 7. **串流中捲動**：同情境 1。
 * 8. **串流中不捲動**：回覆慢慢串，什麼都不動，單獨看 glyph 的成本。
 * 兩個情境都自檢：狀態列的 glyph 在畫面內，而且量測期間三個 circle 的 `cx`／`cy`／`r`／`opacity` 要變過（只看 `cx` 不夠，
 * writing 的 wave 三點 x 固定），不然等於沒量到它在動，直接失敗。
 *
 * frame time 用 `requestAnimationFrame` 兩次回呼的間隔算，只取情境進行中的那一段。間隔在 60Hz 下本來就落在 16.67ms 上下
 * 抖動零點幾毫秒，所以同時記三種數字：原始間隔的 p95、換算成 vsync 個數再乘回去的 p95（先量一段沒降速、沒操作的閒置間隔取中位數當
 * vsync）、多於一個 vsync 的幀（掉幀）占幾成。判讀用哪一種見 #1512。
 *
 * rAF 只看得到主執行緒；backdrop-filter 的成本在合成器那一側（關了 GPU 就是軟體合成）。所以同一段期間也錄 Chrome trace：
 * - `PipelineReporter`（`benchmark` 類別）：每一幀最後是整幀畫出（`STATE_PRESENTED_ALL`）、部分畫出（`…_PARTIAL`）還是掉了（`STATE_DROPPED`）。
 * - `Display::DrawAndSwap`（`viz` 類別）：顯示合成器每畫一幀花多久，blur 就在這裡算。
 *
 * 跑法（先 build web；serve 用同一個 worktree 的 `apps/web/dist`）：
 *
 *   env -u NVIDIA_API_KEY node apps/web/scripts/measure-frames.mjs [--runs 3] [--out <json>] [--headed] [--viewport 390x844]
 *
 * `--viewport` 預設 1440x900（桌面）。寬度在 `use-mobile` 的斷點 1024 以下時，側欄是手機的抽屜（sheet，整面遮罩帶 blur），
 * 「開關側欄」量的就是抽屜的開關（#1583 驗收 H）。
 *
 * **不碰真的 key**：模型是腳本裡的假端點（OpenAI 相容、SSE 串流，只聽 127.0.0.1），serve 用 `--patch` 指過去；
 * serve 的 cwd 是沒有 `.env` 的 `apps/harness`；子行程環境裡的 `NVIDIA_API_KEY` **覆寫成假 key** `nvapi-fake-loopback-only`，
 * 原本環境裡的值不會傳過去（外層照樣用 `env -u NVIDIA_API_KEY` 跑）。
 * home 與工作區都是新建的暫存目錄，跑完刪掉。輸出不印 serve 的網址（帶 token）。
 *
 * 自檢（不過就不算數、直接失敗）：GPU 合成真的關了（CDP `SystemInfo.getInfo` 的 `gpu_compositing`），
 * CPU 真的降速了（同一段計算量，降速後要慢 3 倍以上）。
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const { values: options } = parseArgs({
  options: {
    runs: { type: 'string', default: '3' },
    out: { type: 'string' },
    headed: { type: 'boolean', default: false },
    harness: { type: 'string' },
    viewport: { type: 'string', default: '1440x900' },
    'tool-mix': { type: 'string', default: 'mixed' },
    suite: { type: 'string', default: 'glass' },
  },
});
const SUITE = options.suite;
if (SUITE !== 'glass' && SUITE !== 'reasoning' && SUITE !== 'turn-status')
  throw new Error(`--suite 只收 glass、reasoning 或 turn-status：${SUITE}`);
const RUNS = Number(options.runs);
const HARNESS_DIR = options.harness ?? fileURLToPath(new URL('../../harness/', import.meta.url));
const TSX = join(HARNESS_DIR, 'node_modules/.bin/tsx');

/** 門檻（#1468 Q13）。 */
const P95_LIMIT_MS = 16.7;
const CPU_THROTTLE = 4;
const [VIEWPORT_WIDTH, VIEWPORT_HEIGHT] = options.viewport.split('x').map(Number);
const VIEWPORT = { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT };
/** 跟 `src/hooks/use-mobile.ts` 的 `MOBILE_BREAKPOINT` 同一個數。 */
const MOBILE = VIEWPORT.width < 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const redact = (text) =>
  text.replaceAll(/token=[^\s&"']+/g, 'token=***').replaceAll(/nvapi-[\w-]+/g, 'nvapi-***');

// ---------- 假模型端點 ----------

/** 一段會畫出各種元件的回覆：段落、清單、程式碼區塊、表格。 */
function replyText(paragraphs) {
  const parts = [];
  for (let i = 0; i < paragraphs; i++) {
    parts.push(
      `## 第 ${i + 1} 節\n\n這是一段用來量畫面效能的回覆，內容沒有意義，只是要有足夠的字與元件讓對話區可以捲動。` +
        `第 ${i + 1} 節還有 **粗體**、\`行內程式碼\` 與一個[連結](https://example.com)。\n\n` +
        `- 第一項：說明文字 ${i}\n- 第二項：說明文字 ${i}\n- 第三項：說明文字 ${i}\n\n` +
        '```ts\n' +
        `export function step${i}(input: number): number {\n  return input * ${i + 1} + 1;\n}\n` +
        '```\n\n' +
        `| 欄位 | 值 | 說明 |\n| --- | ---: | --- |\n| a | ${i} | 第一列 |\n| b | ${i * 2} | 第二列 |\n\n`,
    );
  }
  return parts.join('');
}

/** 每一輪的回覆怎麼串：前兩輪快速填滿歷史，之後慢慢串（給「串流中捲動」用）。 */
let turn = 0;
function plan() {
  turn += 1;
  return turn <= 2
    ? { text: replyText(12), chunks: 60, delayMs: 5 }
    : { text: replyText(40), chunks: 1500, delayMs: 20 };
}

/** 情境 4 的那一步：12 顆工具（{@link TOOL_TURN} 這句話觸發），結果回來之後慢慢串。 */
const TOOL_TURN = '第四輪：工具段';
const TOOL_FILES = 4;
/**
 * `mixed`：讀檔、grep 計數、找檔各 4 顆，展開每種兩列。`generic`：12 顆都走通用卡（SG 的結果框），全部展開——玻璃面最多的那一端。
 * `diff`：讀檔、寫檔、改檔各 4 顆（見 {@link toolCalls}），全部展開（8 個 `DiffView`）。`big-writes`：6 顆寫檔、每顆 {@link BIG_WRITE_LINES} 行，卡全部收著。
 */
const TOOL_MIX = options['tool-mix'];
const TOOL_MIXES = ['mixed', 'generic', 'diff', 'big-writes'];
if (!TOOL_MIXES.includes(TOOL_MIX))
  throw new Error(`--tool-mix 只收 ${TOOL_MIXES.join('、')}：${TOOL_MIX}`);
/** `big-writes` 每顆寫檔的行數：超過 `MAX_RENDERED_LINES`（5000），展開的話撞到上限。 */
const BIG_WRITE_LINES = 6000;
const BIG_WRITES = 6;
/**
 * 這一步要發的工具呼叫；`done` 是這一輪已經回來幾個工具結果。`diff` 分兩步：「先讀後改」的策略擋著沒讀過就改的 `edit_file`，
 * 所以先讀 4 個檔，回來之後再寫 4 個新檔、改那 4 個檔（一段仍是 12 顆）。其餘一步發完。沒有要發的回 `[]`。
 */
function toolCalls(done) {
  if (TOOL_MIX === 'diff' && done === 0)
    return Array.from({ length: TOOL_FILES }, (_, index) => ({
      index,
      id: `call_r${index}_${randomUUID().slice(0, 8)}`,
      type: 'function',
      function: {
        name: 'read_file',
        arguments: JSON.stringify({ file_path: `/notes-${index}.md` }),
      },
    }));
  if (done > (TOOL_MIX === 'diff' ? TOOL_FILES : 0)) return [];
  if (TOOL_MIX === 'big-writes')
    return Array.from({ length: BIG_WRITES }, (_, index) => ({
      index,
      id: `call_${index}_${randomUUID().slice(0, 8)}`,
      type: 'function',
      function: {
        name: 'write_file',
        arguments: JSON.stringify({
          file_path: `/big-${index}.txt`,
          content: Array.from(
            { length: BIG_WRITE_LINES },
            (_, line) => `第 ${line + 1} 行：寫進大檔的一行，內容沒有意義`,
          ).join('\n'),
        }),
      },
    }));
  if (TOOL_MIX === 'diff') {
    const calls = [];
    for (let i = 0; i < TOOL_FILES; i++) {
      calls.push([
        'write_file',
        {
          file_path: `/new-${i}.md`,
          content: Array.from({ length: 30 }, (_, line) => `新檔 ${i} 的第 ${line + 1} 行`).join(
            '\n',
          ),
        },
      ]);
      // `notes-<i>.md` 是 `replyText(2)`：「## 第 1 節」只出現一次。
      calls.push([
        'edit_file',
        { file_path: `/notes-${i}.md`, old_string: '## 第 1 節', new_string: '## 第 1 節（改過）' },
      ]);
    }
    return calls.map(([name, args], index) => ({
      index,
      id: `call_${index}_${randomUUID().slice(0, 8)}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }));
  }
  if (TOOL_MIX === 'generic')
    return Array.from({ length: TOOL_FILES * 3 }, (_, index) => ({
      index,
      id: `call_${index}_${randomUUID().slice(0, 8)}`,
      type: 'function',
      function: {
        name: 'grep',
        arguments: JSON.stringify({ pattern: `第 ${index + 1}`, path: '/', output_mode: 'count' }),
      },
    }));
  const calls = [];
  for (let i = 0; i < TOOL_FILES; i++) {
    calls.push(['read_file', { file_path: `/notes-${i}.md` }]);
    // count 模式走通用卡（SG 的結果框）；content 模式與 ls 有自己的搜尋卡。
    calls.push(['grep', { pattern: '節', path: '/', output_mode: 'count' }]);
    calls.push(['glob', { pattern: `notes-${i}*` }]);
  }
  return calls.map(([name, args], index) => ({
    index,
    id: `call_${index}_${randomUUID().slice(0, 8)}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }));
}

/** 情境 5、6 的推理：約 2k 字的 markdown（粗體、清單、程式碼、行內 code、連結），第 `i` 則。 */
const REASONING_TURNS = 40;
/** 初次載入的那一頁畫得出幾列推理：50 則訊息的一半（見情境 5）。 */
const LOAD_ROWS = 25;
const REASONING_STREAM = '推理串流';
function reasoningText(i) {
  const parts = [];
  for (let k = 0; parts.join('').length < 2000; k++)
    parts.push(
      `第 ${i + 1} 則推理的第 ${k + 1} 段：先看 **需求** 有沒有講清楚，再對照 \`notes-${k}.md\` 的[說明](https://example.com)。` +
        `\n\n- 方案 A：成本低、風險高\n- 方案 B：成本中、風險中\n\n` +
        '```ts\n' +
        `const cost${k} = ${i} * ${k + 1};\n` +
        '```\n\n',
    );
  return parts.join('');
}

function lastUserText(messages) {
  // time-context 插件（#1625）在第一輪補一則「Time sampled …」的 user 訊息，跳過它才是人說的那句。
  const last = [...messages]
    .reverse()
    .find(
      (m) =>
        m.role === 'user' &&
        !(typeof m.content === 'string' && m.content.startsWith('Time sampled')),
    );
  if (last === undefined) return '';
  return typeof last.content === 'string'
    ? last.content
    : last.content.map((part) => part.text ?? '').join('');
}

async function fakeLlm(req, res) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!req.url?.endsWith('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  const body = JSON.parse(raw);
  const id = `chatcmpl-${randomUUID()}`;
  const base = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: body.model,
  };
  const usage = {
    prompt_tokens: Math.ceil(raw.length / 4),
    completion_tokens: 200,
    total_tokens: Math.ceil(raw.length / 4) + 200,
  };
  if (body.stream !== true) {
    // 標題這類非串流的小請求。
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id,
        object: 'chat.completion',
        created: base.created,
        model: body.model,
        choices: [
          { index: 0, message: { role: 'assistant', content: '效能量測' }, finish_reason: 'stop' },
        ],
        usage,
      }),
    );
    return;
  }
  const messages = body.messages ?? [];
  if (SUITE === 'reasoning') {
    await streamReasoning(res, base, usage, lastUserText(messages).includes(REASONING_STREAM));
    return;
  }
  const toolTurn = lastUserText(messages).includes(TOOL_TURN);
  // 這一輪（最後一則人說的話之後）已經回來的工具結果。
  const lastHuman = messages.findLastIndex(
    (m) => m.role === 'user' && JSON.stringify(m.content).includes(TOOL_TURN),
  );
  const done = messages.slice(lastHuman + 1).filter((m) => m.role === 'tool').length;
  const calls = toolTurn ? toolCalls(done) : [];
  const afterTools = toolTurn && calls.length === 0;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  if (calls.length > 0) {
    send({
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant', tool_calls: calls }, finish_reason: null }],
    });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    send({ ...base, choices: [], usage });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  const { text, chunks, delayMs } = afterTools
    ? { text: replyText(40), chunks: 1500, delayMs: 20 }
    : plan();
  send({
    ...base,
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  });
  const step = Math.ceil(text.length / chunks);
  for (let i = 0; i < text.length; i += step) {
    if (res.destroyed) return;
    await sleep(delayMs);
    send({
      ...base,
      choices: [{ index: 0, delta: { content: text.slice(i, i + step) }, finish_reason: null }],
    });
  }
  send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  send({ ...base, choices: [], usage });
  res.write('data: [DONE]\n\n');
  res.end();
}

/** 推理（`reasoning_content`）接一句回覆。`slow`：推理慢慢串（情境 6），否則幾塊就送完（填歷史）。 */
async function streamReasoning(res, base, usage, slow) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  const reasoning = slow
    ? Array.from({ length: 16 }, (_, i) => reasoningText(i)).join('')
    : reasoningText(fills++);
  const chunks = slow ? 1500 : 8;
  const delayMs = slow ? 20 : 2;
  send({
    ...base,
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  });
  const step = Math.ceil(reasoning.length / chunks);
  for (let i = 0; i < reasoning.length; i += step) {
    if (res.destroyed) return;
    await sleep(delayMs);
    send({
      ...base,
      choices: [
        {
          index: 0,
          delta: { reasoning_content: reasoning.slice(i, i + step) },
          finish_reason: null,
        },
      ],
    });
  }
  send({
    ...base,
    choices: [{ index: 0, delta: { content: '好，結論是方案 B。' }, finish_reason: null }],
  });
  send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  send({ ...base, choices: [], usage });
  res.write('data: [DONE]\n\n');
  res.end();
}
let fills = 0;

async function startFakeLlm() {
  const server = createServer((req, res) => {
    fakeLlm(req, res).catch(() => res.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

// ---------- serve ----------

function writePatch(root, port) {
  const path = join(root, 'frames.patch.yml');
  // 照出貨的 live-model 重述（config 是整份替換），只換 baseUrl。
  writeFileSync(
    path,
    `- id: live-model
  config:
    baseUrl: 'http://127.0.0.1:${port}/v1'
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
`,
  );
  return path;
}

async function startServe(root, llmPort) {
  const home = join(root, 'home');
  const workspace = join(root, 'ws');
  mkdirSync(home);
  mkdirSync(workspace);
  for (let i = 0; i < TOOL_FILES; i++)
    writeFileSync(join(workspace, `notes-${i}.md`), replyText(2));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = {
    ...process.env,
    NEXUS_AGENT_HOME: home,
    NVIDIA_API_KEY: 'nvapi-fake-loopback-only',
  };
  delete env.NODE_OPTIONS;
  const args = [
    'src/serve.ts',
    '--live',
    '--patch',
    writePatch(root, llmPort),
    '--workspace',
    workspace,
    '--port',
    String(port),
  ];
  const proc = spawn(TSX, args, { cwd: HARNESS_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`serve 60 秒內沒印網址：\n${redact(out.join(''))}`)),
      60_000,
    );
    const onData = (buffer) => {
      out.push(buffer.toString());
      const match = out.join('').match(/http:\/\/[^\s]+\?token=[^\s]+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) =>
      reject(new Error(`serve 提早結束（${code}）：\n${redact(out.join(''))}`)),
    );
  });
  return { proc, url, out };
}

// ---------- 量測 ----------

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function summarize(deltas, vsync) {
  const { compositor: comp } = deltas;
  const vsyncs = deltas.map((d) => Math.max(1, Math.round(d / vsync)));
  const dropped = vsyncs.filter((n) => n > 1).length;
  return {
    frames: deltas.length,
    p50: percentile(deltas, 50),
    p95: percentile(deltas, 95),
    p99: percentile(deltas, 99),
    max: Math.max(...deltas),
    // 判準看「vsync 個數」本身（p95 ≤ 1 就是 ≥95% 的幀準時）。乘回毫秒只給人讀：時間戳只到 0.1ms，閒置中位數量成 16.8 的那一次，
    // 零掉幀也會乘出 16.8 > 16.7，判準不能被這個精度卡住。
    p95VsyncCount: percentile(vsyncs, 95),
    p95Vsync: percentile(vsyncs, 95) * vsync,
    dropped,
    droppedRatio: dropped / deltas.length,
    deltas: [...deltas].map((d) => Number(d.toFixed(2))),
    compositor: comp,
  };
}

/** 錄一段 trace，回傳事件。 */
async function traced(cdp, action) {
  const events = [];
  const onData = (event) => events.push(...event.value);
  cdp.on('Tracing.dataCollected', onData);
  const complete = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
  await cdp.send('Tracing.start', {
    traceConfig: { includedCategories: ['benchmark', 'viz'] },
    transferMode: 'ReportEvents',
  });
  const result = await action();
  await cdp.send('Tracing.end');
  await complete;
  cdp.off('Tracing.dataCollected', onData);
  return { result, events };
}

function compositor(events) {
  const states = {};
  for (const e of events)
    if (e.name === 'PipelineReporter' && e.ph === 'b') {
      const state = e.args?.frame_reporter?.state ?? 'unknown';
      states[state] = (states[state] ?? 0) + 1;
    }
  const frames = Object.entries(states)
    .filter(([state]) => state !== 'STATE_NO_UPDATE_DESIRED')
    .reduce((sum, [, n]) => sum + n, 0);
  const draws = events
    .filter((e) => e.name === 'Display::DrawAndSwap' && e.ph === 'X')
    .map((e) => e.dur / 1000);
  return {
    states,
    frames,
    droppedRatio: frames === 0 ? 0 : (states.STATE_DROPPED ?? 0) / frames,
    partialRatio: frames === 0 ? 0 : (states.STATE_PRESENTED_PARTIAL ?? 0) / frames,
    drawAndSwapP95: draws.length === 0 ? null : percentile(draws, 95),
    drawAndSwapMax: draws.length === 0 ? null : Math.max(...draws),
    draws: draws.length,
  };
}

/** 在頁面裡掛一個 rAF 記錄器，同時錄 trace；回傳這段期間每兩幀的間隔（ms）與合成器的數字。 */
async function recordFrames(page, action, cdp) {
  if (cdp === undefined) return recordRaf(page, action);
  const { result, events } = await traced(cdp, () => recordRaf(page, action));
  return Object.assign(result, { compositor: compositor(events) });
}

async function recordRaf(page, action) {
  await page.evaluate(() => {
    const state = { deltas: [], last: 0, running: true };
    window.__frames = state;
    const tick = (now) => {
      if (!state.running) return;
      if (state.last !== 0) state.deltas.push(now - state.last);
      state.last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await action();
  return page.evaluate(() => {
    window.__frames.running = false;
    return window.__frames.deltas;
  });
}

async function selfCheck(browser, page, cdp) {
  const info = await (await browser.newBrowserCDPSession()).send('SystemInfo.getInfo');
  const compositing = info.gpu.featureStatus?.gpu_compositing ?? '（沒有這一項）';
  if (!/disabled|software|unavailable/.test(compositing))
    throw new Error(`自檢：GPU 合成沒有關掉（gpu_compositing = ${compositing}）`);
  const work = () =>
    page.evaluate(() => {
      const start = performance.now();
      let x = 0;
      for (let i = 0; i < 2e7; i++) x += Math.sqrt(i);
      return [performance.now() - start, x];
    });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const [before] = await work();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
  const [after] = await work();
  const ratio = after / before;
  if (ratio < 3)
    throw new Error(
      `自檢：CPU 降速沒有生效（同一段計算 ${before.toFixed(0)}ms → ${after.toFixed(0)}ms）`,
    );
  return { gpuCompositing: compositing, cpuSlowdown: Number(ratio.toFixed(2)) };
}

async function send(page, text) {
  await page.locator('#prompt').fill(text);
  await page.keyboard.press('Enter');
}

async function waitTurnDone(page) {
  await page.getByRole('button', { name: '停止' }).waitFor({ state: 'detached', timeout: 120_000 });
}

async function scenarioScroll(page, cdp) {
  await send(page, '第三輪：慢慢串');
  await page.getByRole('button', { name: '停止' }).waitFor({ timeout: 30_000 });
  await sleep(1500);
  const box = await page.locator('[data-slot="message-scroller"]').first().boundingBox();
  if (box === null) throw new Error('找不到對話區');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const deltas = await recordFrames(
    page,
    async () => {
      for (let round = 0; round < 6; round++) {
        for (let i = 0; i < 10; i++) {
          await page.mouse.wheel(0, -120);
          await sleep(50);
        }
        for (let i = 0; i < 10; i++) {
          await page.mouse.wheel(0, 120);
          await sleep(50);
        }
      }
    },
    cdp,
  );
  const stillStreaming = await page.getByRole('button', { name: '停止' }).count();
  if (stillStreaming === 0) throw new Error('量測途中回覆就串完了，不是「串流中」');
  await page.getByRole('button', { name: '停止' }).click();
  await waitTurnDone(page);
  return deltas;
}

async function scenarioMenu(page, cdp) {
  const trigger = page.locator('[aria-label^="模型："], [aria-label^="權限："]').first();
  // 底列的座位 #1591 起是 SG 的 Pick（Base UI 的選單），之前是 popover。
  const menu = page.locator('[data-slot="dropdown-menu-content"]').first();
  await trigger.waitFor();
  return recordFrames(
    page,
    async () => {
      for (let i = 0; i < 6; i++) {
        await trigger.click();
        await menu.waitFor();
        await sleep(600);
        await page.keyboard.press('Escape');
        await menu.waitFor({ state: 'detached' });
        await sleep(400);
      }
    },
    cdp,
  );
}

async function scenarioSidebar(page, cdp) {
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  // 先把焦點移出輸入框。手機寬度的右上角是標頭的右側欄開關，點了會開另一個抽屜，改點畫面中間（對話區）。
  await page.locator('body').click({
    position: MOBILE
      ? { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 }
      : { x: VIEWPORT.width - 20, y: 20 },
  });
  return recordFrames(
    page,
    async () => {
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press(`${modifier}+KeyB`);
        await sleep(600);
      }
    },
    cdp,
  );
}

async function scenarioTools(page, cdp) {
  await send(page, TOOL_TURN);
  const run = page.locator('[data-testid="tool-run"]').last();
  await run.waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: '停止' }).waitFor({ timeout: 30_000 });
  // 等工具都完成、收成一段（段首那顆按鈕是群組的）。
  const group = run.locator('[data-slot="step-group"] > button').first();
  await group.waitFor({ timeout: 60_000 });
  if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click();
  // mixed：每種各展開兩列（讀檔、grep 計數、找檔）；generic、diff：全部展開；big-writes：全部收著。
  const rows = run.locator('[data-slot="step-row"] > button');
  const openCount =
    TOOL_MIX === 'generic' || TOOL_MIX === 'diff'
      ? TOOL_FILES * 3
      : TOOL_MIX === 'big-writes'
        ? 0
        : 6;
  await rows.nth(TOOL_MIX === 'big-writes' ? BIG_WRITES - 1 : openCount - 1).waitFor();
  const opened = [];
  for (let index = 0; index < openCount; index++) {
    const row = rows.nth(index);
    if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
    opened.push(await row.getAttribute('aria-expanded'));
  }
  const panels = await run.locator('.glass-panel').count();
  const outputs = await run.locator('[data-slot="output-block"]').count();
  const diffs = await run.locator('[data-slot="diff-view"]').count();
  const stats = await run.locator('[data-slot="diff-stats"]').count();
  // 展開的列要真的畫出 SG 的結果框或 diff（玻璃），不然量的不是這張卡的面。
  if (TOOL_MIX === 'diff') {
    if (diffs < TOOL_FILES * 2)
      throw new Error(`diff 應該有 ${TOOL_FILES * 2} 個 DiffView，只有 ${diffs} 個`);
  } else if (TOOL_MIX === 'big-writes') {
    // 卡收著：沒有 DiffView；每列一顆 +N −M，加上段那一列的合計。
    if (diffs !== 0) throw new Error(`big-writes 的卡應該全部收著，畫了 ${diffs} 個 DiffView`);
    if (stats !== BIG_WRITES + 1)
      throw new Error(`big-writes 應該有 ${BIG_WRITES + 1} 顆 +N −M，只有 ${stats} 顆`);
  } else if (outputs === 0) throw new Error('展開的列沒有任何 SG 結果框');
  if (TOOL_MIX === 'generic' && outputs < 10)
    throw new Error(`generic 應該每列都有結果框，只有 ${outputs} 個`);
  await sleep(1500);
  const box = await page.locator('[data-slot="message-scroller"]').first().boundingBox();
  if (box === null) throw new Error('找不到對話區');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // 量測期間工具段要在畫面裡（不是被串流帶走了）：前後各看一次它跟對話區的框有沒有交集。
  const visible = async () => {
    const r = await run.boundingBox();
    return r !== null && r.y < box.y + box.height && r.y + r.height > box.y;
  };
  // 先用滾輪捲回工具段（`scrollIntoView` 會被貼底捲動拉回去）。
  for (let i = 0; i < 80 && !(await visible()); i++) {
    await page.mouse.wheel(0, -120);
    await sleep(50);
  }
  const visibleBefore = await visible();
  const deltas = await recordFrames(
    page,
    async () => {
      for (let round = 0; round < 6; round++) {
        for (let i = 0; i < 10; i++) {
          await page.mouse.wheel(0, -120);
          await sleep(50);
        }
        for (let i = 0; i < 10; i++) {
          await page.mouse.wheel(0, 120);
          await sleep(50);
        }
      }
    },
    cdp,
  );
  const stillStreaming = await page.getByRole('button', { name: '停止' }).count();
  if (stillStreaming === 0) throw new Error('量測途中回覆就串完了，不是「串流中」');
  const visibleAfter = await visible();
  if (!visibleBefore || !visibleAfter)
    throw new Error(`量測期間工具段不在畫面裡（前 ${visibleBefore}、後 ${visibleAfter}）`);
  const tools = await run.locator('[data-slot="step-row"]').count();
  await page.getByRole('button', { name: '停止' }).click();
  await waitTurnDone(page);
  return Object.assign(deltas, { setup: { tools, opened, panels, outputs, diffs, stats } });
}

const REASONING_ROW = '[data-testid="reasoning-row"]';

/** 情境 5：重新整理，從載入到第一頁的 {@link LOAD_ROWS} 列推理全部畫出、再過 2 秒。rAF 記錄器用 init script 在文件一開始就掛上。 */
async function scenarioLoad(page, cdp) {
  await page.addInitScript(() => {
    const state = { deltas: [], last: 0, running: true };
    window.__frames = state;
    const tick = (now) => {
      if (!state.running) return;
      if (state.last !== 0) state.deltas.push(now - state.last);
      state.last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const { result, events } = await traced(cdp, async () => {
    await page.reload();
    await page
      .waitForFunction(
        ([selector, n]) => document.querySelectorAll(selector).length >= n,
        [REASONING_ROW, LOAD_ROWS],
        { timeout: 120_000, polling: 100 },
      )
      .catch(async (error) => {
        const seen = await page.evaluate(
          (selector) => ({
            rows: document.querySelectorAll(selector).length,
            ai: document.querySelectorAll('[data-testid="ai-entry"]').length,
            human: document.querySelectorAll('[data-testid="human-entry"]').length,
          }),
          REASONING_ROW,
        );
        throw new Error(`重新整理後推理列不到 ${LOAD_ROWS} 列：${JSON.stringify(seen)}`, {
          cause: error,
        });
      });
    const readyMs = await page.evaluate(() => performance.now());
    await sleep(2000);
    return page.evaluate((readyMs) => {
      window.__frames.running = false;
      return { deltas: window.__frames.deltas, readyMs };
    }, readyMs);
  });
  const setup = await page.evaluate((selector) => {
    const rows = [...document.querySelectorAll(selector)];
    return { rows: rows.length, mounted: rows.filter((r) => r.querySelector('.markdown')).length };
  }, REASONING_ROW);
  return Object.assign(result.deltas, {
    compositor: compositor(events),
    setup: { ...setup, readyMs: Math.round(result.readyMs) },
  });
}

/** 情境 6：一輪推理慢慢串、收著，在對話區上下捲；量完推理要還在串（標題仍是「思考中」）。 */
async function scenarioReasoningStream(page, cdp) {
  await send(page, `${REASONING_STREAM}：慢慢想`);
  await page.getByRole('button', { name: '停止', exact: true }).waitFor({ timeout: 30_000 });
  const row = page.locator(REASONING_ROW).last();
  const thinking = () => row.evaluate((el) => el.textContent?.includes('思考中') ?? false);
  for (let i = 0; i < 300 && !(await thinking()); i++) await sleep(100);
  if (!(await thinking())) throw new Error('沒看到「思考中」的推理列');
  await sleep(1500);
  const box = await page.locator('[data-slot="message-scroller"]').first().boundingBox();
  if (box === null) throw new Error('找不到對話區');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const deltas = await recordFrames(
    page,
    async () => {
      for (let round = 0; round < 6; round++) {
        for (let i = 0; i < 10; i++) {
          await page.mouse.wheel(0, -120);
          await sleep(50);
        }
        for (let i = 0; i < 10; i++) {
          await page.mouse.wheel(0, 120);
          await sleep(50);
        }
      }
    },
    cdp,
  );
  if (!(await thinking())) throw new Error('量測途中推理就串完了，不是「推理串流中」');
  const setup = await row.evaluate((el) => ({
    open: el.querySelector('details')?.open ?? el.querySelector('[data-panel-open]') !== null,
    mounted: el.querySelector('.markdown') !== null,
  }));
  if (setup.open) throw new Error('推理列是打開的，不是「收著」');
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await waitTurnDone(page);
  return Object.assign(deltas, { setup });
}

async function measureReasoning(page, cdp, vsync) {
  // 填歷史不降速，省時間。
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  for (let i = 0; i < REASONING_TURNS; i++) {
    await send(page, `推理歷史 ${i + 1}`);
    await page.getByRole('button', { name: '停止', exact: true }).waitFor({ timeout: 30_000 });
    await waitTurnDone(page);
  }
  const filled = await page.evaluate(
    (selector) => document.querySelectorAll(selector).length,
    REASONING_ROW,
  );
  if (filled < REASONING_TURNS)
    throw new Error(`填完歷史只有 ${filled} 列推理（要 ${REASONING_TURNS}）`);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
  const load = await scenarioLoad(page, cdp);
  const stream = await scenarioReasoningStream(page, cdp);
  return {
    長歷史初次載入: Object.assign(summarize(load, vsync), { setup: load.setup }),
    推理收著時串流中捲動: Object.assign(summarize(stream, vsync), { setup: stream.setup }),
  };
}

// ---------- 狀態列（#1684） ----------

/** 狀態列執行中那一列的 glyph 在不在畫面內，以及它三個 circle 此刻的姿勢。 */
function probeStatus(page) {
  return page.evaluate(() => {
    const glyph = document.querySelector('[role="status"] [data-slot="status-glyph"]');
    if (glyph === null) return { found: false };
    const r = glyph.getBoundingClientRect();
    return {
      found: true,
      inView: r.width > 0 && r.bottom > 0 && r.top < window.innerHeight,
      // 三個 circle 的位置、大小、透明度。只看 cx 不夠：writing 的 wave 三點 x 固定、只上下動。
      pose: [...glyph.querySelectorAll('circle')]
        .map((c) => ['cx', 'cy', 'r', 'opacity'].map((a) => c.getAttribute(a)).join(','))
        .join(' '),
    };
  });
}

/** 量測期間取樣狀態列；量完自檢：glyph 在畫面內，姿勢變過。 */
function statusSampler(page) {
  const samples = [];
  return {
    sample: async () => samples.push(await probeStatus(page)),
    check: () => {
      if (samples.length === 0 || samples.some((s) => !s.found || !s.inView))
        throw new Error(`自檢：狀態列的 glyph 不在畫面內（${JSON.stringify(samples)}）`);
      const distinct = new Set(samples.map((s) => s.pose)).size;
      if (distinct < 2)
        throw new Error(`自檢：量測期間 glyph 沒有動（${JSON.stringify(samples)}）`);
      return { samples: samples.length, distinctPoses: distinct };
    },
  };
}

async function startSlowTurn(page, text) {
  await send(page, text);
  await page.getByRole('button', { name: '停止' }).waitFor({ timeout: 30_000 });
  await sleep(1500);
}

async function stopTurn(page) {
  const stillStreaming = await page.getByRole('button', { name: '停止' }).count();
  if (stillStreaming === 0) throw new Error('量測途中回覆就串完了，不是「串流中」');
  await page.getByRole('button', { name: '停止' }).click();
  await waitTurnDone(page);
}

/** 情境 7：同情境 1，捲動之間取樣狀態列。 */
async function scenarioStatusScroll(page, cdp) {
  await startSlowTurn(page, '第三輪：慢慢串');
  const box = await page.locator('[data-slot="message-scroller"]').first().boundingBox();
  if (box === null) throw new Error('找不到對話區');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const status = statusSampler(page);
  const deltas = await recordFrames(
    page,
    async () => {
      for (let round = 0; round < 6; round++) {
        await status.sample();
        for (let i = 0; i < 10; i++) {
          await page.mouse.wheel(0, -120);
          await sleep(50);
        }
        for (let i = 0; i < 10; i++) {
          await page.mouse.wheel(0, 120);
          await sleep(50);
        }
      }
      await status.sample();
    },
    cdp,
  );
  const setup = status.check();
  await stopTurn(page);
  return Object.assign(deltas, { setup });
}

/** 情境 8：回覆慢慢串，什麼都不動 6 秒，每秒取樣狀態列。 */
async function scenarioStatusIdle(page, cdp) {
  await startSlowTurn(page, '第四輪：慢慢串、不捲');
  const status = statusSampler(page);
  const deltas = await recordFrames(
    page,
    async () => {
      for (let i = 0; i < 6; i++) {
        await status.sample();
        await sleep(1000);
      }
      await status.sample();
    },
    cdp,
  );
  const setup = status.check();
  await stopTurn(page);
  return Object.assign(deltas, { setup });
}

async function measureOnce(run) {
  const root = mkdtempSync(join(tmpdir(), 'nexus-frames-'));
  const llm = await startFakeLlm();
  turn = 0;
  let serve;
  let browser;
  try {
    serve = await startServe(root, llm.address().port);
    browser = await chromium.launch({
      channel: 'chrome',
      headless: !options.headed,
      args: [
        '--disable-gpu',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-background-timer-throttling',
      ],
    });
    const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'light' });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await page.goto(serve.url);
    await page.locator('#prompt').waitFor({ timeout: 60_000 });
    const check = await selfCheck(browser, page, cdp);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const idle = await recordFrames(page, () => sleep(2000));
    const vsync = percentile(idle, 50);

    if (SUITE === 'reasoning') {
      const scenarios = await measureReasoning(page, cdp, vsync);
      return { run, browser: browser.version(), ...check, vsync, scenarios };
    }

    // 先填兩輪歷史（不降速，省時間），再降速量。turn-status 一樣。
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    for (const text of ['第一輪：填歷史', '第二輪：填歷史']) {
      await send(page, text);
      await page.getByRole('button', { name: '停止' }).waitFor({ timeout: 30_000 });
      await waitTurnDone(page);
    }
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });

    if (SUITE === 'turn-status') {
      const scroll = await scenarioStatusScroll(page, cdp);
      const still = await scenarioStatusIdle(page, cdp);
      const scenarios = {
        串流中捲動: Object.assign(summarize(scroll, vsync), { setup: scroll.setup }),
        串流中不捲動: Object.assign(summarize(still, vsync), { setup: still.setup }),
      };
      return { run, browser: browser.version(), ...check, vsync, scenarios };
    }

    const scenarios = {
      串流中捲動: summarize(await scenarioScroll(page, cdp), vsync),
      開composer選單: summarize(await scenarioMenu(page, cdp), vsync),
      開關側欄: summarize(await scenarioSidebar(page, cdp), vsync),
    };
    const tools = await scenarioTools(page, cdp);
    scenarios.工具段展開捲動 = Object.assign(summarize(tools, vsync), { setup: tools.setup });
    return { run, browser: browser.version(), ...check, vsync, scenarios };
  } catch (error) {
    if (serve) process.stderr.write(redact(serve.out.join('')).slice(-4000));
    throw error;
  } finally {
    await browser?.close();
    serve?.proc.kill('SIGINT');
    llm.close();
    await sleep(500);
    rmSync(root, { recursive: true, force: true });
  }
}

const results = [];
for (let run = 1; run <= RUNS; run++) {
  const result = await measureOnce(run);
  results.push(result);
  for (const [name, s] of Object.entries(result.scenarios)) {
    if (s.setup !== undefined && SUITE !== 'glass')
      console.log(`第 ${run} 次 ${name} 的場面：${JSON.stringify(s.setup)}`);
    else if (s.setup !== undefined)
      console.log(
        `第 ${run} 次 ${name} 的場面：段內 ${s.setup.tools} 列、展開 ${s.setup.opened.join('／')}、glass-panel ${s.setup.panels} 個、結果框 ${s.setup.outputs} 個、DiffView ${s.setup.diffs} 個、+N −M ${s.setup.stats} 顆`,
      );
    console.log(
      `第 ${run} 次 ${name}：原始 p95 ${s.p95.toFixed(2)}ms、以 vsync 計 p95 ${s.p95Vsync.toFixed(2)}ms、掉幀 ${s.dropped}／${s.frames}（${(s.droppedRatio * 100).toFixed(1)}%）；p50 ${s.p50.toFixed(2)}、p99 ${s.p99.toFixed(2)}、最長 ${s.max.toFixed(1)}` +
        `｜合成器：${s.compositor.frames} 幀、掉 ${(s.compositor.droppedRatio * 100).toFixed(1)}%、部分 ${(s.compositor.partialRatio * 100).toFixed(1)}%，DrawAndSwap p95 ${s.compositor.drawAndSwapP95?.toFixed(2)}ms（最長 ${s.compositor.drawAndSwapMax?.toFixed(2)}）`,
    );
  }
}
const verdict = Object.fromEntries(
  Object.keys(results[0].scenarios).map((name) => {
    const pick = (key) => results.map((r) => r.scenarios[name][key]);
    const raw = percentile(pick('p95'), 50);
    const byVsync = percentile(pick('p95Vsync'), 50);
    const byVsyncCount = percentile(pick('p95VsyncCount'), 50);
    return [
      name,
      {
        rawP95s: pick('p95'),
        vsyncP95s: pick('p95Vsync'),
        droppedRatios: pick('droppedRatio'),
        rawMedian: raw,
        vsyncMedian: byVsync,
        rawPass: raw <= P95_LIMIT_MS,
        vsyncCountMedian: byVsyncCount,
        vsyncPass: byVsyncCount <= 1,
        compositorDropped: results.map((r) => r.scenarios[name].compositor.droppedRatio),
        compositorPartial: results.map((r) => r.scenarios[name].compositor.partialRatio),
        drawAndSwapP95: results.map((r) => r.scenarios[name].compositor.drawAndSwapP95),
      },
    ];
  }),
);
console.log(
  `\n自檢：GPU 合成 ${results[0].gpuCompositing}；CPU 降速實測 ${results.map((r) => r.cpuSlowdown).join('／')} 倍；vsync ${results.map((r) => r.vsync.toFixed(2)).join('／')}ms；${results[0].browser}`,
);
for (const [name, v] of Object.entries(verdict))
  console.log(
    `${name}：原始 p95 中位數 ${v.rawMedian.toFixed(2)}ms（${v.rawPass ? '≤' : '>'} ${P95_LIMIT_MS}）；以 vsync 計 ${v.vsyncMedian.toFixed(2)}ms、vsync 個數 p95 ${v.vsyncCountMedian}（${v.vsyncPass ? '≤' : '>'} 1）；rAF 掉幀 ${v.droppedRatios.map((x) => `${(x * 100).toFixed(1)}%`).join('／')}` +
      `；合成器掉幀 ${v.compositorDropped.map((x) => `${(x * 100).toFixed(1)}%`).join('／')}、部分 ${v.compositorPartial.map((x) => `${(x * 100).toFixed(1)}%`).join('／')}；DrawAndSwap p95 ${v.drawAndSwapP95.map((x) => x?.toFixed(2)).join('／')}ms`,
  );
if (options.out)
  writeFileSync(
    options.out,
    JSON.stringify({ limitMs: P95_LIMIT_MS, cpuThrottle: CPU_THROTTLE, results, verdict }, null, 2),
  );
process.exitCode = Object.values(verdict).every((v) => v.vsyncPass) ? 0 : 1;
