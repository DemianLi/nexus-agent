#!/usr/bin/env node
/* global console, process, URL, setTimeout, clearTimeout, window, requestAnimationFrame, performance */
/**
 * 大面積玻璃的效能門檻（#1468 Q7、Q13、Q17，#1512）：Chrome 關 GPU 加速、CPU 降速 4 倍，量三種情境的 frame time，
 * p95 ≤ 16.7ms 才能合併（判的是 vsync 個數：p95 ≤ 1 個 vsync，見 `summarize`）；不達標就退成不透明（`data-glass="opaque"`／reduced-transparency 那條路），由 PM 與 demian 決定。
 *
 * 三種情境：
 * 1. **串流中捲動**：回覆還在串的時候，在對話區上下捲。
 * 2. **開 composer 選單**：輸入框（一層玻璃）上開模型選擇浮層（又一層玻璃），開、等、關，重複幾次。
 * 3. **開關側欄**：⌘B／Ctrl+B 開關，重複幾次。
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
  },
});
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
  const { text, chunks, delayMs } = plan();
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
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

    // 先填兩輪歷史（不降速，省時間），再降速量。
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    for (const text of ['第一輪：填歷史', '第二輪：填歷史']) {
      await send(page, text);
      await page.getByRole('button', { name: '停止' }).waitFor({ timeout: 30_000 });
      await waitTurnDone(page);
    }
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });

    const scenarios = {
      串流中捲動: summarize(await scenarioScroll(page, cdp), vsync),
      開composer選單: summarize(await scenarioMenu(page, cdp), vsync),
      開關側欄: summarize(await scenarioSidebar(page, cdp), vsync),
    };
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
  for (const [name, s] of Object.entries(result.scenarios))
    console.log(
      `第 ${run} 次 ${name}：原始 p95 ${s.p95.toFixed(2)}ms、以 vsync 計 p95 ${s.p95Vsync.toFixed(2)}ms、掉幀 ${s.dropped}／${s.frames}（${(s.droppedRatio * 100).toFixed(1)}%）；p50 ${s.p50.toFixed(2)}、p99 ${s.p99.toFixed(2)}、最長 ${s.max.toFixed(1)}` +
        `｜合成器：${s.compositor.frames} 幀、掉 ${(s.compositor.droppedRatio * 100).toFixed(1)}%、部分 ${(s.compositor.partialRatio * 100).toFixed(1)}%，DrawAndSwap p95 ${s.compositor.drawAndSwapP95?.toFixed(2)}ms（最長 ${s.compositor.drawAndSwapMax?.toFixed(2)}）`,
    );
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
