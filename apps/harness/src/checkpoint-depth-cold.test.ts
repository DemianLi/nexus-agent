/**
 * 預設 stack、冷啟動的新行程：續接深歷史回 `thread_history_too_deep`，不是 `unknown_error`（[#1761](https://github.com/DemianLi/nexus-agent/issues/1761)）。
 *
 * `checkpoint-serde.test.ts` 的續接那一組在 vitest 行程裡跑：前面跑過很多格，函式都暖了，同一個預設 stack 撐得更深，3000、5000 層在那裡是綠的。
 * 真正的 serve 重啟之後第一個續接是冷的——2000 層就在 `checkpointDepth` 對 LangChain 訊息呼叫遞迴的 `toJSON` 時爆堆疊
 * （`Maximum call stack size exceeded`，回 `unknown_error`，網頁當成暫時失敗一直重讀）。**只在 vitest 行程內跑的測試證明不了這件事**，
 * 所以這一檔每一格各起一個新的 `node` 行程（**不帶 `--stack-size`**），深的那一條就是那個行程的第一個工作，腳本是
 * `checkpoint-depth-cold.fixture.ts`。
 *
 * - **續接**：一個行程先真跑、再把日誌改成指定層數的舊事件（上限出現之前寫下的）；每個層數另起一個新行程續接。
 * - **同台寫入**（#1761 第 3 點）：新行程裡模型回一則 2000 層以上的工具參數，日誌 600 層那一關先擋，不會走到 `checkpointDepth` 的 `toJSON`。
 *
 * 拿掉 `checkpointDepth` 的預檢，2000、3000、5000 層那幾格紅；1198（剛好低於門檻、仍走 `toJSON`）與 1500 層（以前就好的）不變。
 *
 * **零憑證、零外部連線**：假端點在 loopback，key 是假的。
 */

import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { THREAD_HISTORY_TOO_DEEP } from '@nexus/wire';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CHECKPOINT_DEPTH_EXCEEDED, CHECKPOINT_MAX_DEPTH } from './checkpoint-serde.js';

const fixture = fileURLToPath(new URL('./checkpoint-depth-cold.fixture.ts', import.meta.url));
const harnessDir = fileURLToPath(new URL('../', import.meta.url));

const temporary: string[] = [];
afterAll(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 起一個新的 node 行程跑腳本，回它印的最後一行 JSON。不帶 `--stack-size`；失敗帶 stderr 一起丟。 */
async function child(mode: string, dir: string, ...levels: number[]): Promise<unknown> {
  const spawned = spawn(
    process.execPath,
    ['--import', 'tsx', fixture, mode, dir, ...levels.map(String)],
    {
      cwd: harnessDir,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  spawned.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  spawned.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve) => spawned.once('exit', resolve));
  if (code !== 0) throw new Error(`${mode} 子行程以 ${String(code)} 結束：\n${stderr}`);
  const last = stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .at(-1);
  return last === undefined ? undefined : (JSON.parse(last) as unknown);
}

interface Rejected {
  readonly outcome: string;
  readonly code?: string;
  readonly message?: string;
}

describe('續接：新行程、預設 stack，第一個工作就是深的那一條', () => {
  // 1198 是「剛好低於預檢門檻」那一格：原始結構量到的層數是參數層數加 5（實測 1198 → 1203），門檻是 `CHECKPOINT_PRECHECK_DEPTH`（1204），
  // 所以這一格**不**被預檢擋下，仍然走遞迴的 `toJSON`——它在冷行程裡撐得住，門檻才算選得安全。哪個平台在這一格爆，就代表門檻要再降。
  const levels = [1198, 1500, 2000, 3000, 5000];
  const results = new Map<number, Rejected>();

  beforeAll(async () => {
    const base = mkdtempSync(join(tmpdir(), 'nexus-depth-cold-'));
    temporary.push(base);
    const source = join(base, 'source');
    // 一個行程造所有層數的舊日誌；每個層數各複製一份（同一個 home 只能起一個 serve），各起一個新行程續接。
    await child('generate', source, ...levels);
    const resumed = await Promise.all(
      levels.map(async (level) => {
        const copy = join(base, `resume-${String(level)}`);
        cpSync(source, copy, { recursive: true });
        return [level, (await child('resume', copy, level)) as Rejected] as const;
      }),
    );
    for (const [level, result] of resumed) results.set(level, result);
  }, 240_000);

  it.each(levels)(
    '參數 %i 層：thread 建不起來，wire 碼是 thread_history_too_deep，訊息帶 checkpoint_depth_exceeded 與日誌第幾顆',
    (level) => {
      const result = results.get(level)!;
      expect(result.outcome).toBe('rejected');
      // 以前 2000 層以上在這裡是 `unknown_error`（Maximum call stack size exceeded）。
      expect(result.code).toBe(THREAD_HISTORY_TOO_DEEP);
      expect(result.message).toContain(CHECKPOINT_DEPTH_EXCEEDED);
      expect(result.message).toMatch(/日誌第 \d+ 顆事件/u);
      expect(result.message).toContain(`上限 ${String(CHECKPOINT_MAX_DEPTH)} 層`);
      expect(result.message).not.toContain('Maximum call stack');
    },
  );
});

describe('同台寫入：新行程裡模型回極深的工具參數，日誌那一關先擋', () => {
  interface Written {
    readonly downlink: 'finished' | 'broken';
    readonly seen?: {
      readonly status: string;
      readonly error?: string;
      readonly sawTruncation: boolean;
    };
    readonly rangeError: boolean;
    readonly failed: { code?: string; message?: string }[];
  }
  const written = async (level: number): Promise<Written> => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-depth-cold-write-'));
    temporary.push(dir);
    return (await child('write', dir, level)) as Written;
  };

  it('參數 2000 層：這一輪失敗，碼是 NESTING_TOO_DEEP，不是 RangeError；下行也一路收到尾', async () => {
    const result = await written(2000);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.code).toBe('NESTING_TOO_DEEP');
    expect(result.failed[0]!.message).toContain('日誌收不下');
    expect(result.failed[0]!.message).not.toContain('Maximum call stack');
    expect(result.rangeError).toBe(false);
    expect(result.downlink).toBe('finished');
    expect(result.seen?.status).toBe('failed');
    // 2000 層超過下行門檻（1200），客戶端收到的是截斷過的副本。
    expect(result.seen?.sawTruncation).toBe(true);
    // 錯誤文字帶的是兩個門檻本身：下行副本 1200（`PRECHECK_DEPTH`）與日誌上限 600，兩個數字都對得上才是日誌那一關的訊息。
    expect(result.seen?.error).toContain('1200');
    expect(result.seen?.error).toContain('600');
  }, 120_000);

  /**
   * 5000 層（#1560 N1384）：同一則深參數的 `messages` 事件要走下行 `JSON.stringify`，Linux 的預設 stack 在這個層數會爆
   * （Node 22.23.3 實測；macOS Node 25 不會）。以前是下行斷線，客戶端只看到串流斷了；現在那顆事件的下行副本在序列化之前被截斷
   * （`bounded-event-queue.ts` 偏離 D），下行不斷，一路收到 root 的 `lifecycle failed`。
   *
   * 斷言**客戶端這一側**：下行走完（`finished`）、折疊出來的狀態是 `failed`、`error` 文字是日誌那一關的訊息。**碼不在下行上**——
   * `lifecycle failed` 只帶文字（實測，`packages/nexus-wire/src/conversation.ts` 的 failed 路徑只收 `data.error` 字串），
   * `NESTING_TOO_DEEP` 在日誌的 `turn/failed` 與歷史裡；下行帶碼另開 #1844。日誌那一關不看平台，整份日誌沒有 `RangeError`。
   *
   * 拿掉截斷：Linux 上下行 `broken`；macOS 上下行不會爆，但客戶端收不到截斷佔位，`sawTruncation` 那條斷言照樣紅。
   */
  it('參數 5000 層：下行不斷，客戶端收到這一輪失敗；日誌裡這一輪的 turn/failed 是 NESTING_TOO_DEEP，整份日誌沒有 RangeError', async () => {
    const result = await written(5000);
    expect(result.downlink).toBe('finished');
    expect(result.seen?.status).toBe('failed');
    // 客戶端真的收到截斷過的那顆（不是「事件沒送」也不是「本來就沒超」）；拿掉截斷，這一條在 macOS 也紅。
    expect(result.seen?.sawTruncation).toBe(true);
    expect(result.seen?.error).toContain('日誌收不下');
    expect(result.seen?.error).toContain('1200');
    expect(result.seen?.error).toContain('600');
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.code).toBe('NESTING_TOO_DEEP');
    expect(result.failed[0]!.message).toContain('日誌收不下');
    expect(result.rangeError).toBe(false);
  }, 120_000);
});
