/**
 * **錄請求基準檔**（#2362）：同一批測試共跑四次，把「線上實際送給模型的請求」存成進版控的檔。
 *
 * - 各跑兩次 `shadow`（線上送的是 state 那條）與 `log`（線上送的是日誌推出來的）：兩次 `log`、或兩次 `shadow` 不同，都標 `unstable`。
 * - 逐案比對 `shadow` 與 `log`：相同標 `identical`；不同的（`summary-shape` 除外）必須在 `known-differences.json` 登記原因（存檔裡記成 `note`，狀態 `known-difference`），
 *   沒登記、或只有一邊錄到，就整個失敗，不寫任何檔——不明的差異不能悄悄進黃金檔。只在 `log` 那一輪才跑的案例（測試自己 state 與 log 並排並斷言相同）標
 *   `self-compared`，只比兩次 `log`。不穩的案例只記狀態、不存內容（併發時請求到達的先後會變）。
 * - 不同、而且去掉生摘要的那幾次請求之後逐位元組相同：標 `summary-shape`（log 的摘要請求是重播、state 是模板，#2826）。
 * - 存的是 `log` 那一側，格式見 `request-baseline-format.ts`。
 *
 * 手動跑，不進測試：
 *
 * ```
 * cd harness/apps/harness
 * node_modules/.bin/tsx --tsconfig ../../tsconfig.runtime.json src/request-baseline-refresh.ts
 * ```
 *
 * 故意改了請求的形狀（例如摘要請求的重播）時重跑這支，PR 內文要貼 `git diff --stat` 與每一份差異的原因。
 *
 * @module
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUMMARY_ENTRY_INSTRUCTION, SUMMARY_INSTRUCTION } from '@nexus/core';

import { BASELINE_OUT_ENV } from './request-baseline.js';
import { BASELINE_DIR } from './request-baseline-refresh-paths.js';
import { encodeEndpoint } from './request-baseline-format.js';
import type { EncodedCase, ToolsTable } from './request-baseline-format.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = join(HERE, '..');

/** 預設錄的測試檔：現在靠 state 對 log 並排、或 shadow 持續比對的那些（走假端點、看得到線上 body 的）。 */
const BASELINE_TEST_FILES: readonly string[] = [
  'src/log-derived-history.test.ts',
  'src/log-derived-history.agents.test.ts',
  'src/summarizer-lifetime.test.ts',
  'src/summary-catch-up-resume.test.ts',
];

/** 登記過的已知差異：`<測試檔>/<案例檔名>` → 原因。 */
const KNOWN_FILE = join(BASELINE_DIR, 'known-differences.json');

interface RawCase {
  readonly case: string;
  readonly endpoints: readonly (readonly unknown[])[];
}

function record(files: readonly string[], logSource: boolean, out: string): void {
  const result = spawnSync('pnpm', ['exec', 'vitest', 'run', ...files], {
    cwd: HARNESS,
    stdio: 'inherit',
    env: {
      ...process.env,
      [BASELINE_OUT_ENV]: out,
      ...(logSource ? { NEXUS_LDH_HISTORY_SOURCE: 'log' } : {}),
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `錄製失敗（${logSource ? 'log' : 'shadow'}）：vitest 退出碼 ${String(result.status)}`,
    );
  }
}

function readAll(dir: string): Map<string, RawCase> {
  const found = new Map<string, RawCase>();
  for (const sub of readdirSync(dir, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    for (const file of readdirSync(join(dir, sub.name))) {
      const path = join(dir, sub.name, file);
      found.set(relative(dir, path), JSON.parse(readFileSync(path, 'utf8')) as RawCase);
    }
  }
  return found;
}

const same = (left: RawCase, right: RawCase): boolean =>
  JSON.stringify(left.endpoints) === JSON.stringify(right.endpoints);

interface WireBody {
  readonly messages?: readonly { readonly content?: unknown }[];
}

/** 生摘要的那一次請求：log 是重播（最後一則是摘要指令），state 是模板（#2826）。 */
function isSummaryRequest(body: unknown): boolean {
  const content = (body as WireBody).messages?.at(-1)?.content;
  return (
    content === SUMMARY_INSTRUCTION ||
    content === SUMMARY_ENTRY_INSTRUCTION ||
    (typeof content === 'string' && content.startsWith('Conversation to condense:'))
  );
}

/** 去掉摘要請求之後是否逐位元組相同：摘要請求的形狀本來就不同（#2826），其餘不該不同。 */
function sameExceptSummaryRequests(left: RawCase, right: RawCase): boolean {
  const strip = (value: RawCase) =>
    JSON.stringify(
      value.endpoints.map((bodies) => bodies.filter((body) => !isSummaryRequest(body))),
    );
  return strip(left) === strip(right);
}

// 不收測試檔參數：只錄一部分的話，寫檔前清掉整個目錄，其他測試檔的基準檔就整批消失。
const tests = BASELINE_TEST_FILES;
const scratch = mkdtempSync(join(tmpdir(), 'nexus-baseline-'));
try {
  record(tests, false, join(scratch, 'shadow-a'));
  record(tests, false, join(scratch, 'shadow-b'));
  record(tests, true, join(scratch, 'log'));
  record(tests, true, join(scratch, 'log-b'));
  const shadowA = readAll(join(scratch, 'shadow-a'));
  const shadowB = readAll(join(scratch, 'shadow-b'));
  const logRun = readAll(join(scratch, 'log'));
  const logAgain = readAll(join(scratch, 'log-b'));
  let known: Record<string, string> = {};
  try {
    known = JSON.parse(readFileSync(KNOWN_FILE, 'utf8')) as Record<string, string>;
  } catch (error) {
    // 沒有登記檔時從空表開始；檔在但壞了要報錯，不然重寫時登記過的原因會消失。
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const table: ToolsTable = {};
  const output = new Map<string, EncodedCase & { status: string; note?: string }>();
  const unexplained: string[] = [];
  const missing: string[] = [];
  const counts = {
    identical: 0,
    'summary-shape': 0,
    'known-difference': 0,
    unstable: 0,
    'self-compared': 0,
  };
  for (const [key, logCase] of logRun) {
    const stateCase = shadowA.get(key);
    const again = shadowB.get(key);
    let status: 'identical' | 'summary-shape' | 'known-difference' | 'unstable' | 'self-compared';
    if (stateCase === undefined && again === undefined) {
      // 只在 log 那一輪才會跑的案例（測試自己 state 與 log 並排、自己斷言相同）：用兩次 log 檢查穩不穩。
      const second = logAgain.get(key);
      status = second !== undefined && same(logCase, second) ? 'self-compared' : 'unstable';
    } else if (stateCase === undefined || again === undefined) {
      missing.push(key);
      continue;
    } else if (!same(stateCase, again)) status = 'unstable';
    else if (logAgain.get(key) === undefined || !same(logCase, logAgain.get(key)!))
      status = 'unstable';
    else if (same(stateCase, logCase)) status = 'identical';
    else if (sameExceptSummaryRequests(stateCase, logCase)) status = 'summary-shape';
    else if (known[key] !== undefined) status = 'known-difference';
    else {
      unexplained.push(key);
      continue;
    }
    counts[status] += 1;
    output.set(key, {
      version: 1,
      case: logCase.case,
      status,
      ...(known[key] !== undefined && status === 'known-difference' && { note: known[key] }),
      // 不穩的案例不存內容：每次重錄都會變，存了只會讓版控的差異全是雜訊。
      endpoints:
        status === 'unstable'
          ? []
          : logCase.endpoints.map((bodies) => encodeEndpoint(bodies, table)),
    });
  }
  for (const key of shadowA.keys()) if (!logRun.has(key)) missing.push(key);

  if (unexplained.length > 0 || missing.length > 0) {
    console.error(
      `\n沒寫任何檔。\n不明的差異（要先查清楚、到 known-differences.json 登記原因）：\n${unexplained.map((k) => `  ${k}`).join('\n') || '  （無）'}\n只有一邊錄到的案例：\n${missing.map((k) => `  ${k}`).join('\n') || '  （無）'}`,
    );
    process.exitCode = 1;
  } else {
    const readme = readFileSync(join(BASELINE_DIR, 'README.md'), 'utf8');
    rmSync(BASELINE_DIR, { recursive: true, force: true });
    mkdirSync(BASELINE_DIR, { recursive: true });
    for (const [key, value] of output) {
      const target = join(BASELINE_DIR, key);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify(value)}\n`);
    }
    writeFileSync(join(BASELINE_DIR, 'README.md'), readme);
    writeFileSync(join(BASELINE_DIR, '_tools.json'), `${JSON.stringify(table)}\n`);
    writeFileSync(KNOWN_FILE, `${JSON.stringify(known, null, 1)}\n`);
    console.log(`\n寫了 ${String(output.size)} 個案例：`, counts);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
